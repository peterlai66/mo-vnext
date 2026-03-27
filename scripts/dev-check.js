/**
 * MO Strategy 共用核心（與 src/index.ts runStrategyReview compare 層一致）。
 * LINE Worker 與本腳本共用，避免兩套 strategy 判斷。
 *
 * @typedef {"promote_candidate" | "keep_active" | "hold_review"} Decision
 * @typedef {"high" | "medium"} Confidence
 */

/**
 * @typedef {{
 *  balancedMinScore: number;
 *  freshnessWeight: number;
 *  volumeWeight: number;
 *  simulationWeight?: number;
 *  aggressiveMinScore?: number;
 *  freshnessIdleThresholdMs?: number;
 *  configVersion?: string;
 *  updatedAt?: string;
 * }} StrategyShape
 */

/**
 * @typedef {{
 *  lastDecision?: Decision;
 *  confirmCount: number;
 *  lastPromoteAt?: number;
 * }} PromoteGuardState
 */

const STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED = 2;
const STRATEGY_AUTO_PROMOTE_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * @param {Record<string, unknown>} raw
 * @returns {{
 *  freshnessWeight: number;
 *  volumeWeight: number;
 *  simulationWeight: number;
 *  aggressiveMinScore: number;
 *  balancedMinScore: number;
 *  freshnessIdleThresholdMs: number;
 *  configVersion: string;
 *  updatedAt: string;
 * }}
 */
function normalizeStrategyConfigForCore(raw) {
	const w = typeof raw.freshnessWeight === "number" ? raw.freshnessWeight : 0.5;
	const v = typeof raw.volumeWeight === "number" ? raw.volumeWeight : 0.35;
	const sim = typeof raw.simulationWeight === "number" ? raw.simulationWeight : 0.15;
	const ag = typeof raw.aggressiveMinScore === "number" ? raw.aggressiveMinScore : 80;
	const bal = typeof raw.balancedMinScore === "number" ? raw.balancedMinScore : 60;
	const idle =
		typeof raw.freshnessIdleThresholdMs === "number" ?
			raw.freshnessIdleThresholdMs
		:	24 * 60 * 60 * 1000;
	return {
		freshnessWeight: w,
		volumeWeight: v,
		simulationWeight: sim,
		aggressiveMinScore: ag,
		balancedMinScore: bal,
		freshnessIdleThresholdMs: idle,
		configVersion: typeof raw.configVersion === "string" ? raw.configVersion : "v",
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
	};
}

/**
 * Compare / evaluate 核心（對齊 Worker runStrategyReview 內 compare 規則）。
 *
 * @param {Record<string, unknown>} activeRaw
 * @param {Record<string, unknown>} candidateRaw
 * @param {"demo" | "real"} source
 * @param {{
 *   demoOverride: null | {
 *     status: string;
 *     dataFreshnessScore: number;
 *     dataVolumeScore: number;
 *     simulationReadyScore: number;
 *     note?: string;
 *   };
 *   snapshot: null | {
 *     status: string;
 *     dataFreshnessScore: number;
 *     dataVolumeScore: number;
 *     simulationReadyScore: number;
 *     score?: number;
 *   };
 * }} options
 * @returns {{
 *   compareDecision: Decision;
 *   compareReason: string;
 *   compareSummary: string;
 *   activeScore: number;
 *   candidateScore: number;
 *   scoreDelta: number;
 *   changedFields: string[];
 *   diffs: string[];
 *   reviewConfidence: Confidence;
 * }}
 */
function computeStrategyComparePure(activeRaw, candidateRaw, source, options) {
	const a = normalizeStrategyConfigForCore(activeRaw);
	const c = normalizeStrategyConfigForCore(candidateRaw);
	const demoOverride = options.demoOverride;
	const snapshot = options.snapshot;

	const diffs = [];
	if (a.freshnessWeight !== c.freshnessWeight) diffs.push("freshnessWeight");
	if (a.volumeWeight !== c.volumeWeight) diffs.push("volumeWeight");
	if (a.simulationWeight !== c.simulationWeight) diffs.push("simulationWeight");
	if (a.aggressiveMinScore !== c.aggressiveMinScore) diffs.push("aggressiveMinScore");
	if (a.balancedMinScore !== c.balancedMinScore) diffs.push("balancedMinScore");
	if (a.freshnessIdleThresholdMs !== c.freshnessIdleThresholdMs) {
		diffs.push("freshnessIdleThresholdMs");
	}

	const changedFields = [];
	if (a.balancedMinScore !== c.balancedMinScore) changedFields.push("balancedMinScore");
	if (a.freshnessWeight !== c.freshnessWeight) changedFields.push("freshnessWeight");
	if (a.volumeWeight !== c.volumeWeight) changedFields.push("volumeWeight");

	const calcCompareScore = (s) => s.balancedMinScore * 1 + s.freshnessWeight * 10 + s.volumeWeight * 10;
	const activeScore = calcCompareScore(a);
	const candidateScore = calcCompareScore(c);
	const scoreDelta = candidateScore - activeScore;

	const isStrongDemo =
		demoOverride !== null &&
		demoOverride.status === "active" &&
		demoOverride.dataFreshnessScore >= 80 &&
		demoOverride.dataVolumeScore >= 80 &&
		demoOverride.simulationReadyScore >= 80;
	const isStrongReal =
		snapshot !== null &&
		snapshot.status === "active" &&
		snapshot.dataFreshnessScore >= 80 &&
		snapshot.dataVolumeScore >= 80 &&
		snapshot.simulationReadyScore >= 80;

	const isBalancedMinScoreOnlyDiff = diffs.length === 1 && diffs[0] === "balancedMinScore";
	const balancedMinScoreDelta = c.balancedMinScore - a.balancedMinScore;
	const isSafeRealPromoteBalancedMinScoreOnly =
		source === "real" &&
		demoOverride === null &&
		isBalancedMinScoreOnlyDiff &&
		balancedMinScoreDelta >= 10;
	const isSafeBalancedMinScoreOnlyReal =
		source === "real" &&
		isBalancedMinScoreOnlyDiff &&
		balancedMinScoreDelta >= 5 &&
		snapshot !== null &&
		snapshot.status === "active" &&
		snapshot.dataFreshnessScore >= 80 &&
		snapshot.dataVolumeScore >= 80 &&
		snapshot.simulationReadyScore >= 60;

	/** @type {Decision} */
	let compareDecision;
	let compareReason;
	let compareSummary;

	if (diffs.length === 0) {
		compareDecision = "keep_active";
		const balancedDelta = c.balancedMinScore - a.balancedMinScore;
		compareReason =
			source === "real" && balancedDelta === 0 ?
				`no_material_diff (balancedMinScore delta=0; active=${a.balancedMinScore}, candidate=${c.balancedMinScore})`
			:	"no_material_diff";
		compareSummary = "active vs candidate same";
	} else if (isSafeRealPromoteBalancedMinScoreOnly) {
		compareDecision = "promote_candidate";
		compareReason = `real promote condition matched: balancedMinScore delta>=10 (${balancedMinScoreDelta})`;
		compareSummary = "real safe promotion baseline";
	} else if (
		(source === "demo" && isStrongDemo) ||
		(source === "real" && (isStrongReal || isSafeBalancedMinScoreOnlyReal))
	) {
		compareDecision = "promote_candidate";
		compareReason =
			source === "demo" ?
				`candidate changes validated under demo review conditions: ${diffs.join(", ")}`
			:	isSafeBalancedMinScoreOnlyReal && !isStrongReal ?
				`candidate balancedMinScore change validated under safe real review conditions: ${diffs.join(", ")}`
			:	`candidate changes validated under real review conditions: ${diffs.join(", ")}`;
		compareSummary = "candidate validated for promotion";
	} else {
		compareDecision = "hold_review";
		compareReason =
			source === "real" && isBalancedMinScoreOnlyDiff ?
				balancedMinScoreDelta < 10 ?
					`balancedMinScore delta is below threshold (delta=${balancedMinScoreDelta}, active=${a.balancedMinScore}, candidate=${c.balancedMinScore}); auto promote requires delta >= 10`
				:	`candidate balancedMinScore change but real review conditions not strong enough (delta=${balancedMinScoreDelta}, active=${a.balancedMinScore}, candidate=${c.balancedMinScore})`
			:	`candidate changes but review conditions not strong enough: ${diffs.join(", ")}`;
		compareSummary = "active vs candidate differ";
	}

	const reviewConfidence =
		(compareDecision === "promote_candidate" && scoreDelta >= 10) ||
		(compareDecision === "keep_active" && scoreDelta === 0) ?
			"high"
		:	"medium";

	return {
		compareDecision,
		compareReason,
		compareSummary,
		activeScore,
		candidateScore,
		scoreDelta,
		changedFields,
		diffs,
		reviewConfidence,
	};
}

/**
 * @param {PromoteGuardState} state
 * @param {Decision} decision
 * @param {number} nowMs
 * @returns {{ result: "promoted" | "blocked" | "no_action" | "guarded"; confirmCount: number; cooldownRemainingMs: number; nextState: PromoteGuardState; }}
 */
function evaluateAutoPromoteCore(state, decision, nowMs) {
	const confirmCount = state.lastDecision === decision ? state.confirmCount + 1 : 1;
	const baseState = {
		lastDecision: decision,
		confirmCount,
		...(typeof state.lastPromoteAt === "number" ? { lastPromoteAt: state.lastPromoteAt } : {}),
	};

	if (decision === "keep_active") {
		return { result: "no_action", confirmCount, cooldownRemainingMs: 0, nextState: baseState };
	}
	if (decision !== "promote_candidate") {
		return { result: "blocked", confirmCount, cooldownRemainingMs: 0, nextState: baseState };
	}
	if (confirmCount < STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED) {
		return { result: "guarded", confirmCount, cooldownRemainingMs: 0, nextState: baseState };
	}

	const remaining =
		typeof state.lastPromoteAt === "number" ?
			Math.max(0, STRATEGY_AUTO_PROMOTE_COOLDOWN_MS - (nowMs - state.lastPromoteAt))
		:	0;
	if (remaining > 0) {
		return {
			result: "guarded",
			confirmCount,
			cooldownRemainingMs: remaining,
			nextState: baseState,
		};
	}
	return {
		result: "promoted",
		confirmCount,
		cooldownRemainingMs: 0,
		nextState: {
			lastDecision: decision,
			confirmCount,
			lastPromoteAt: nowMs,
		},
	};
}

/**
 * @param {{
 *   compareDecision?: Decision;
 * } | null} reviewResult
 * @param {{
 *   decision?: string;
 * } | null} reviewDecision
 * @returns {Decision}
 */
function deriveCompareDecisionForAutoPromote(reviewResult, reviewDecision) {
	const fromReview =
		reviewResult && reviewResult.compareDecision ? reviewResult.compareDecision : null;
	let fromRd = null;
	if (reviewDecision && reviewDecision.decision === "auto_promote_candidate") {
		fromRd = "promote_candidate";
	} else if (
		reviewDecision &&
		(reviewDecision.decision === "promote_candidate" ||
			reviewDecision.decision === "hold_review" ||
			reviewDecision.decision === "keep_active")
	) {
		fromRd = /** @type {Decision} */ (reviewDecision.decision);
	}
	return fromReview ?? fromRd ?? "hold_review";
}

/**
 * @param {{
 *   comparedAt: string;
 *   compareReason: string;
 *   compareDecision: Decision;
 *   activeConfigVersion: string;
 *   candidateConfigVersion: string;
 * } | null} existingResult
 * @param {string} activeVersion
 * @param {string} candidateVersion
 * @param {ReturnType<typeof computeStrategyComparePure>} computed
 * @returns {boolean}
 */
function shouldRefreshStrategyReviewKv(existingResult, activeVersion, candidateVersion, computed) {
	if (existingResult === null) return true;
	if (String(existingResult.comparedAt).trim() === "") return true;
	if (existingResult.compareReason === "review result not ready") return true;
	if (existingResult.activeConfigVersion !== activeVersion) return true;
	if (existingResult.candidateConfigVersion !== candidateVersion) return true;
	if (
		computed.changedFields.length === 0 &&
		computed.scoreDelta === 0 &&
		existingResult.compareDecision !== "keep_active"
	) {
		return true;
	}
	if (existingResult.compareDecision !== computed.compareDecision) return true;
	return false;
}

/** TWSE 大盤 MI_INDEX（與 Worker /admin/run 一致） */
const MO_LIVE_SOURCE_TWSE_MI_INDEX = "TWSE_MI_INDEX";

/**
 * 台北日曆往回推 daysAgo 天，回傳 YYYYMMDD（與 /admin/run 相同算法）。
 * @param {number} daysAgo
 * @returns {string}
 */
function getTaipeiYYYYMMDDMinusDaysFromToday(daysAgo) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Taipei",
		year: "numeric",
		month: "numeric",
		day: "numeric",
	}).formatToParts(new Date());
	const y = Number(parts.find((p) => p.type === "year")?.value ?? "1970");
	const m = Number(parts.find((p) => p.type === "month")?.value ?? "1");
	const d = Number(parts.find((p) => p.type === "day")?.value ?? "1");
	const dt = new Date(Date.UTC(y, m - 1, d));
	dt.setUTCDate(dt.getUTCDate() - daysAgo);
	const yy = dt.getUTCFullYear();
	const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(dt.getUTCDate()).padStart(2, "0");
	return `${yy}${mm}${dd}`;
}

/**
 * @param {unknown} parsed
 * @returns {boolean}
 */
function isTwseMiIndexPayloadOk(parsed) {
	if (typeof parsed !== "object" || parsed === null) return false;
	const obj = /** @type {Record<string, unknown>} */ (parsed);
	if (!("stat" in obj)) return false;
	if (String(obj.stat).toUpperCase() !== "OK") return false;
	const tables = obj.tables;
	if (!Array.isArray(tables)) return false;
	for (let i = 0; i < tables.length; i++) {
		const t = tables[i];
		if (typeof t === "object" && t !== null) {
			const row = /** @type {Record<string, unknown>} */ (t);
			if ("data" in row && Array.isArray(row.data) && row.data.length > 0) return true;
		}
	}
	return false;
}

/**
 * @param {unknown} parsed
 * @returns {string}
 */
function summarizeTwseMiIndexPayload(parsed) {
	if (typeof parsed !== "object" || parsed === null) return "invalid";
	const obj = /** @type {Record<string, unknown>} */ (parsed);
	const stat = "stat" in obj ? String(obj.stat) : "";
	const date = "date" in obj ? String(obj.date) : "";
	let tableRows = 0;
	if ("tables" in obj && Array.isArray(obj.tables)) {
		for (const t of obj.tables) {
			if (
				typeof t === "object" &&
				t !== null &&
				"data" in t &&
				Array.isArray(/** @type {Record<string, unknown>} */ (t).data)
			) {
				tableRows += /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (t).data).length;
			}
		}
	}
	return `stat=${stat};date=${date};tableDataRows=${tableRows}`;
}

/**
 * @param {boolean} fetched
 * @param {boolean} dbWrite
 * @param {{ noTradingDataInWindow?: boolean }} [options]
 * @returns {"success" | "partial" | "fetch_failed" | "waiting_data"}
 */
function deriveMoLiveCycleStatus(fetched, dbWrite, options) {
	if (!fetched) {
		if (options && options.noTradingDataInWindow) return "waiting_data";
		return "fetch_failed";
	}
	if (!dbWrite) return "partial";
	return "success";
}

/**
 * LINE /status 與 Worker 共用：依 D1 最新快照組出 Live market 區塊（多行純文字，不含 section 標題）。
 *
 * @param {{
 *   trade_date: string;
 *   source: string;
 *   payload_summary: string;
 *   created_at: string;
 * } | null} row
 * @param {{ d1ReadError?: string }} [options]
 * @returns {string}
 */
function formatMoLiveMarketStatusBlock(row, options) {
	if (options && options.d1ReadError) {
		return `d1 read failed: ${options.d1ReadError}\ncycle: fetch_failed`;
	}
	if (row === null) {
		return "snapshot: none（尚無 mo_live 資料；可先觸發一次資料寫入）\ncycle: waiting_data";
	}
	const cycle = deriveMoLiveCycleStatus(true, true);
	return [
		`tradeDate: ${row.trade_date}`,
		`source: ${row.source}`,
		`summary: ${row.payload_summary}`,
		`storedAt: ${row.created_at}`,
		`cycle: ${cycle}`,
	].join("\n");
}

/**
 * 與 Worker readLatestMoLiveMarketSnapshot 結果對齊，取得 cycle（僅能從 D1 推導 success / waiting_data / fetch_failed）。
 *
 * @param {{ kind: "ok"; row: { trade_date?: string } | null } | { kind: "error"; message: string }} read
 * @returns {"success" | "waiting_data" | "fetch_failed"}
 */
function getMoLiveCycleStatusFromSnapshotRead(read) {
	if (read.kind === "error") return "fetch_failed";
	if (read.row === null) return "waiting_data";
	return "success";
}

/**
 * @param {"success" | "waiting_data" | "partial" | "fetch_failed"} cycle
 * @returns {string}
 */
function mapMoLiveMarketStatusHuman(cycle) {
	switch (cycle) {
		case "success":
			return "資料已更新，市場正常，可供參考。";
		case "waiting_data":
			return "尚未取得最新資料（可能非交易時段或尚未寫入）。";
		case "partial":
			return "資料不完整（僅部分更新）。";
		case "fetch_failed":
			return "資料取得失敗，請稍後再試。";
		default:
			return "市場狀態無法判定。";
	}
}

/**
 * @param {"success" | "waiting_data" | "partial" | "fetch_failed"} cycle
 * @returns {string}
 */
function buildMarketStatusText(cycle) {
	return mapMoLiveMarketStatusHuman(cycle);
}

/**
 * @param {string} yyyymmdd
 * @returns {string}
 */
function formatDisplayDateFromYyyymmdd(yyyymmdd) {
	if (typeof yyyymmdd !== "string" || !/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
	return `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

/**
 * @param {number} score
 * @returns {string}
 */
function mapScoreToActionLine(score) {
	const s = Number(score);
	if (!Number.isFinite(s)) return "維持觀察";
	if (s >= 90) return "可提高部位";
	if (s >= 70) return "維持配置";
	return "建議保守";
}

/**
 * @param {"aggressive" | "balanced" | "conservative"} strategy
 * @param {number} score
 * @param {boolean} hasAdequateData
 * @param {string} recReason
 * @returns {string}
 */
function buildSystemDecisionText(strategy, score, hasAdequateData, recReason) {
	const zh =
		strategy === "aggressive" ? "積極型" : strategy === "conservative" ? "保守型" : "平衡型";
	const stance =
		strategy === "aggressive" ? "偏積極" : strategy === "conservative" ? "偏保守" : "中性平衡";
	let judgment;
	if (!hasAdequateData) {
		judgment = `資料不足（${recReason}），以下判斷僅供參考。`;
	} else if (strategy === "aggressive") {
		judgment = "目前訊號可承擔較高風險，但仍須留意波動。";
	} else if (strategy === "conservative") {
		judgment = "建議保守因應，優先控管下行風險。";
	} else {
		judgment = "中性平衡，可依自身風險承受度調整。";
	}
	return `當前策略：${zh}（${stance}）\n綜合評分：${score} 分。\n${judgment}`;
}

/**
 * @param {number} score
 * @returns {string}
 */
function buildActionText(score) {
	return mapScoreToActionLine(score);
}

/**
 * @param {{
 *   displayDate: string;
 *   dataSource: string;
 *   marketStatusLine: string;
 *   systemDecisionLine: string;
 *   actionLine: string;
 *   notesLine?: string;
 * }} p
 * @returns {string}
 */
function buildMoReportText(p) {
	const parts = [
		"MO Report",
		"",
		`日期：${p.displayDate}`,
		`資料來源：${p.dataSource}`,
		"",
		"【市場狀態】",
		p.marketStatusLine,
		"",
		"【系統判斷】",
		p.systemDecisionLine,
		"",
		"【建議】",
		p.actionLine,
	];
	if (p.notesLine !== undefined && String(p.notesLine).trim() !== "") {
		parts.push("", "【備註】", String(p.notesLine).trim());
	}
	return parts.join("\n");
}

/**
 * @typedef {"market_status_changed" | "report_action_changed" | "strategy_promoted"} MoPushEventType
 */

/** P 數字愈小愈高優先（strategy 1、report 2、market 3） */
const MO_PUSH_PRIORITY = {
	strategy_promoted: 1,
	report_action_changed: 2,
	market_status_changed: 3,
};

const MO_PUSH_COOLDOWN_MS_DEFAULT = 10 * 60 * 1000;
/** 僅低優先級（市場）事件時可套用較嚴格視窗 */
const MO_PUSH_COOLDOWN_MS_P3_ONLY = 30 * 60 * 1000;

/**
 * @param {string} t
 * @returns {number}
 */
function moPushPriorityValue(t) {
	if (t === "strategy_promoted") return MO_PUSH_PRIORITY.strategy_promoted;
	if (t === "report_action_changed") return MO_PUSH_PRIORITY.report_action_changed;
	if (t === "market_status_changed") return MO_PUSH_PRIORITY.market_status_changed;
	return 99;
}

/**
 * 預留：風險層級變化（未來 report_risk_changed）請掛在此，不要塞進單一巨大 if。
 *
 * @param {{ prevRiskLabel: string; nextRiskLabel: string }} _p
 * @returns {Array<{ type: MoPushEventType; summary: string }>}
 */
function detectReportRiskChangedForMoPush(_p) {
	return [];
}

/**
 * @param {{
 *   lastEvaluatedMarketLine: string | null;
 *   lastEvaluatedActionLine: string | null;
 *   lastEvaluatedPromoteKey: string | null;
 *   marketLine: string;
 *   actionLine: string;
 *   currentPromoteKey: string;
 *   promotedFrom?: string;
 *   promotedTo?: string;
 * }} p
 * @returns {Array<{ type: MoPushEventType; summary: string }>}
 */
function detectMoPushTriggeredEvents(p) {
	const prevM = p.lastEvaluatedMarketLine ?? "";
	const prevA = p.lastEvaluatedActionLine ?? "";
	const prevPr = p.lastEvaluatedPromoteKey ?? "";
	const events = [];
	if (p.marketLine !== prevM) {
		events.push({
			type: "market_status_changed",
			summary: "市場狀態文字已變更",
		});
	}
	if (p.actionLine !== prevA) {
		events.push({
			type: "report_action_changed",
			summary: "建議文字已變更",
		});
	}
	if (p.currentPromoteKey !== "" && p.currentPromoteKey !== prevPr) {
		const from = p.promotedFrom ?? "";
		const to = p.promotedTo ?? "";
		events.push({
			type: "strategy_promoted",
			summary: `策略已自動升級（${from}→${to}）`,
		});
	}
	return events;
}

/**
 * @param {Array<{ type: MoPushEventType; summary: string }>} events
 * @returns {MoPushEventType | null}
 */
function primaryMoPushTypeFromEvents(events) {
	if (events.length === 0) return null;
	let best = events[0].type;
	let bestPv = moPushPriorityValue(best);
	for (let i = 1; i < events.length; i += 1) {
		const t = events[i].type;
		const pv = moPushPriorityValue(t);
		if (pv < bestPv) {
			best = t;
			bestPv = pv;
		}
	}
	return best;
}

/**
 * @param {{
 *   displayDate: string;
 *   marketLine: string;
 *   actionLine: string;
 *   events: Array<{ type: MoPushEventType; summary: string }>;
 *   promotedFrom?: string;
 *   promotedTo?: string;
 * }} p
 * @returns {string}
 */
function buildMoPushMessage(p) {
	const sorted = [...p.events].sort((a, b) => moPushPriorityValue(a.type) - moPushPriorityValue(b.type));
	const lines = ["MO Update", ""];
	if (p.displayDate.trim() !== "") {
		lines.push(`日期：${p.displayDate}`, "");
	}
	const has = (/** @type {MoPushEventType} */ t) => sorted.some((e) => e.type === t);
	if (has("strategy_promoted")) {
		const from = p.promotedFrom ?? "（前版）";
		const to = p.promotedTo ?? "（新版）";
		lines.push("【策略更新】", `已自動套用新策略：${from} → ${to}。`, "");
	}
	if (has("report_action_changed")) {
		lines.push("【建議】", p.actionLine, "");
	}
	if (has("market_status_changed")) {
		lines.push("【市場狀態】", p.marketLine, "");
	}
	return lines.join("\n").replace(/\n+$/u, "").trimEnd();
}

/**
 * @param {{
 *   triggeredEvents: Array<{ type: MoPushEventType; summary: string }>;
 *   marketLine: string;
 *   actionLine: string;
 *   currentPromoteKey: string;
 * }} p
 * @returns {string}
 */
function fingerprintMoPushPayload(p) {
	const types = [...new Set(p.triggeredEvents.map((e) => e.type))].sort().join(",");
	return `v2|${types}|${p.marketLine}|${p.actionLine}|${p.currentPromoteKey}`;
}

/**
 * 與 Worker STRATEGY_NOTIFY_COOLDOWN_MS 對齊的純決策（不含 LINE、不含鎖）。
 *
 * @param {{
 *   displayDate: string;
 *   marketLine: string;
 *   actionLine: string;
 *   currentPromoteKey: string;
 *   promotedFrom?: string;
 *   promotedTo?: string;
 *   lastEvaluatedMarketLine: string | null;
 *   lastEvaluatedActionLine: string | null;
 *   lastEvaluatedPromoteKey: string | null;
 *   lastPushedFingerprint: string | null;
 *   gateMessage: string | null;
 *   gateAtMs: number | null;
 *   gatePriority: number;
 *   nowMs: number;
 *   cooldownMsDefault: number;
 *   cooldownMsP3Only: number;
 * }} p
 * @returns {{
 *   shouldNotify: boolean;
 *   triggeredEvents: Array<{ type: MoPushEventType; summary: string }>;
 *   primaryPushType: MoPushEventType | null;
 *   pushPriority: number | null;
 *   pushReason: string;
 *   pushResult: string;
 *   pushMessage: string;
 *   mergedMessage: string;
 *   cooldownRemainingMs: number | null;
 *   fingerprint: string;
 *   comparedState: { fingerprint: string; marketLine: string; actionLine: string; currentPromoteKey: string };
 * }}
 */
function evaluateMoPushEventDecision(p) {
	const riskExtra = detectReportRiskChangedForMoPush({
		prevRiskLabel: "",
		nextRiskLabel: "",
	});
	const triggeredEvents = detectMoPushTriggeredEvents({
		lastEvaluatedMarketLine: p.lastEvaluatedMarketLine,
		lastEvaluatedActionLine: p.lastEvaluatedActionLine,
		lastEvaluatedPromoteKey: p.lastEvaluatedPromoteKey,
		marketLine: p.marketLine,
		actionLine: p.actionLine,
		currentPromoteKey: p.currentPromoteKey,
		promotedFrom: p.promotedFrom,
		promotedTo: p.promotedTo,
	}).concat(riskExtra);

	const primaryPushType = primaryMoPushTypeFromEvents(triggeredEvents);
	const pushPriority =
		primaryPushType === null ? null : moPushPriorityValue(primaryPushType);

	const mergedMessage = buildMoPushMessage({
		displayDate: p.displayDate,
		marketLine: p.marketLine,
		actionLine: p.actionLine,
		events: triggeredEvents,
		promotedFrom: p.promotedFrom,
		promotedTo: p.promotedTo,
	});

	const fingerprint = fingerprintMoPushPayload({
		triggeredEvents,
		marketLine: p.marketLine,
		actionLine: p.actionLine,
		currentPromoteKey: p.currentPromoteKey,
	});

	const comparedState = {
		fingerprint,
		marketLine: p.marketLine,
		actionLine: p.actionLine,
		currentPromoteKey: p.currentPromoteKey,
	};

	if (triggeredEvents.length === 0) {
		return {
			shouldNotify: false,
			triggeredEvents,
			primaryPushType: null,
			pushPriority: null,
			pushReason: "no_events_vs_last_evaluated_snapshot",
			pushResult: "skipped_no_change",
			pushMessage: mergedMessage,
			mergedMessage,
			cooldownRemainingMs: null,
			fingerprint,
			comparedState,
		};
	}

	if (p.lastPushedFingerprint !== null && fingerprint === p.lastPushedFingerprint) {
		return {
			shouldNotify: false,
			triggeredEvents,
			primaryPushType,
			pushPriority,
			pushReason: "content_unchanged_since_last_successful_push",
			pushResult: "skipped_same_content",
			pushMessage: mergedMessage,
			mergedMessage,
			cooldownRemainingMs: null,
			fingerprint,
			comparedState,
		};
	}

	const onlyLowPriority =
		triggeredEvents.length > 0 &&
		triggeredEvents.every((e) => e.type === "market_status_changed");
	const effectiveCooldownMs = onlyLowPriority ? p.cooldownMsP3Only : p.cooldownMsDefault;

	const gatePri = Number.isFinite(p.gatePriority) ? p.gatePriority : MO_PUSH_PRIORITY.market_status_changed;

	if (p.gateAtMs !== null) {
		const elapsed = p.nowMs - p.gateAtMs;
		if (elapsed < effectiveCooldownMs) {
			if (pushPriority !== null && pushPriority < gatePri) {
				return {
					shouldNotify: true,
					triggeredEvents,
					primaryPushType,
					pushPriority,
					pushReason: "higher_priority_overrides_low_priority_cooldown",
					pushResult: "would_push",
					pushMessage: mergedMessage,
					mergedMessage,
					cooldownRemainingMs: null,
					fingerprint,
					comparedState,
				};
			}
			if (p.gateMessage !== null && p.gateMessage === mergedMessage) {
				return {
					shouldNotify: false,
					triggeredEvents,
					primaryPushType,
					pushPriority,
					pushReason: "same_message_within_cooldown",
					pushResult: "skipped_cooldown",
					pushMessage: mergedMessage,
					mergedMessage,
					cooldownRemainingMs: Math.max(0, effectiveCooldownMs - elapsed),
					fingerprint,
					comparedState,
				};
			}
		} else if (p.gateMessage !== null && p.gateMessage === mergedMessage) {
			return {
				shouldNotify: false,
				triggeredEvents,
				primaryPushType,
				pushPriority,
				pushReason: "duplicate_push_body_after_cooldown",
				pushResult: "skipped_same_content",
				pushMessage: mergedMessage,
				mergedMessage,
				cooldownRemainingMs: null,
				fingerprint,
				comparedState,
			};
		}
	}

	return {
		shouldNotify: true,
		triggeredEvents,
		primaryPushType,
		pushPriority,
		pushReason: "events_merged",
		pushResult: "would_push",
		pushMessage: mergedMessage,
		mergedMessage,
		cooldownRemainingMs: null,
		fingerprint,
		comparedState,
	};
}

/**
 * @param {string} marketLine
 * @param {string} actionLine
 * @param {string} displayDate
 * @returns {string}
 */
function buildMoUpdatePushMessage(marketLine, actionLine, displayDate) {
	return buildMoPushMessage({
		displayDate,
		marketLine,
		actionLine,
		events: [
			{ type: "market_status_changed", summary: "" },
			{ type: "report_action_changed", summary: "" },
		],
	});
}

/**
 * @param {string} marketLine
 * @param {string} actionLine
 * @returns {string}
 */
function fingerprintMoPushContent(marketLine, actionLine) {
	return fingerprintMoPushPayload({
		triggeredEvents: [
			{ type: "market_status_changed", summary: "" },
			{ type: "report_action_changed", summary: "" },
		],
		marketLine,
		actionLine,
		currentPromoteKey: "",
	});
}

/**
 * @typedef {{
 *  active: StrategyShape;
 *  candidate: StrategyShape;
 *  expectedDecision: Decision;
 *  expectedChangedFields: Array<keyof StrategyShape>;
 *  expectedCompareReason: string;
 *  expectedConfidence: Confidence;
 *  snapshot: null | {
 *    status: string;
 *    dataFreshnessScore: number;
 *    dataVolumeScore: number;
 *    simulationReadyScore: number;
 *  };
 * }} TestCase
 */

/** @type {TestCase[]} */
const testCases = [
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 50, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "hold_review",
		expectedChangedFields: ["balancedMinScore"],
		expectedCompareReason:
			"balancedMinScore delta is below threshold (delta=-10, active=60, candidate=50); auto promote requires delta >= 10",
		expectedConfidence: "medium",
		snapshot: null,
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "keep_active",
		expectedChangedFields: [],
		expectedCompareReason:
			"no_material_diff (balancedMinScore delta=0; active=60, candidate=60)",
		expectedConfidence: "high",
		snapshot: null,
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 65, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "hold_review",
		expectedChangedFields: ["balancedMinScore"],
		expectedCompareReason:
			"balancedMinScore delta is below threshold (delta=5, active=60, candidate=65); auto promote requires delta >= 10",
		expectedConfidence: "medium",
		snapshot: null,
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 70, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "promote_candidate",
		expectedChangedFields: ["balancedMinScore"],
		expectedCompareReason: "real promote condition matched: balancedMinScore delta>=10 (10)",
		expectedConfidence: "high",
		snapshot: null,
	},
];

function runDevCheckMain() {
	const results = testCases.map(
		({
			active,
			candidate,
			expectedDecision,
			expectedChangedFields,
			expectedCompareReason,
			expectedConfidence,
			snapshot,
		}) => {
			const reviewResult = computeStrategyComparePure(active, candidate, "real", {
				demoOverride: null,
				snapshot,
			});
			const ap0 = evaluateAutoPromoteCore({ confirmCount: 0 }, reviewResult.compareDecision, Date.now());
			return {
				active,
				candidate,
				reviewResult,
				autoPromoteFirst: ap0.result,
				expectedDecision,
				expectedChangedFields,
				expectedCompareReason,
				expectedConfidence,
			};
		}
	);

	for (const item of results) {
		console.log(item);
	}

	let passCount = 0;
	let failCount = 0;
	for (const item of results) {
		const rr = item.reviewResult;
		const fieldsMatch =
			rr.changedFields.length === item.expectedChangedFields.length &&
			rr.changedFields.every((field, index) => field === item.expectedChangedFields[index]);
		const reasonMatch = rr.compareReason === item.expectedCompareReason;
		const decisionMatch = rr.compareDecision === item.expectedDecision;
		const confidenceMatch = rr.reviewConfidence === item.expectedConfidence;

		if (!decisionMatch || !fieldsMatch || !reasonMatch || !confidenceMatch) {
			console.error("❌ mismatch", item);
			failCount += 1;
		} else {
			passCount += 1;
		}
	}

	const summary = results.reduce(
		(acc, item) => {
			if (item.reviewResult.compareDecision === "promote_candidate") acc.promote += 1;
			if (item.reviewResult.compareDecision === "hold_review") acc.hold += 1;
			if (item.reviewResult.compareDecision === "keep_active") acc.keep += 1;
			return acc;
		},
		{ total: results.length, promote: 0, hold: 0, keep: 0 }
	);

	console.log(summary);

	function runMoLiveCycleDevChecks() {
		console.log("[mo-live] dev-check helpers");
		const td0 = getTaipeiYYYYMMDDMinusDaysFromToday(0);
		if (!/^\d{8}$/.test(td0)) {
			throw new Error(`[mo-live] invalid YYYYMMDD: ${td0}`);
		}
		if (deriveMoLiveCycleStatus(true, true) !== "success") {
			throw new Error("[mo-live] derive success");
		}
		if (deriveMoLiveCycleStatus(true, false) !== "partial") {
			throw new Error("[mo-live] derive partial");
		}
		if (deriveMoLiveCycleStatus(false, false) !== "fetch_failed") {
			throw new Error("[mo-live] derive fetch_failed");
		}
		if (deriveMoLiveCycleStatus(false, false, { noTradingDataInWindow: true }) !== "waiting_data") {
			throw new Error("[mo-live] derive waiting_data");
		}
		const sample = { stat: "OK", tables: [{ data: [["row"]] }] };
		if (!isTwseMiIndexPayloadOk(sample)) {
			throw new Error("[mo-live] isTwseMiIndexPayloadOk");
		}
		const sum = summarizeTwseMiIndexPayload(sample);
		if (!sum.includes("stat=OK")) {
			throw new Error(`[mo-live] summarize: ${sum}`);
		}
		console.log("[mo-live] dev-check ok", { tradeDate: td0, cycleStatus: "success" });
	}

	runMoLiveCycleDevChecks();
	passCount += 1;

	function runMoLiveStatusSummaryDevChecks() {
		console.log("[mo-live] status summary builder");
		const none = formatMoLiveMarketStatusBlock(null, {});
		if (!none.includes("waiting_data") || !none.includes("snapshot:")) {
			throw new Error(`[mo-live status] expected waiting snapshot: ${none}`);
		}
		const err = formatMoLiveMarketStatusBlock(null, { d1ReadError: "unit" });
		if (!err.includes("fetch_failed") || !err.includes("d1 read failed")) {
			throw new Error(`[mo-live status] expected d1 error: ${err}`);
		}
		const row = {
			trade_date: "20260101",
			source: MO_LIVE_SOURCE_TWSE_MI_INDEX,
			payload_summary: "stat=OK;date=20260101;tableDataRows=1",
			created_at: "2026-01-01T00:00:00.000Z",
		};
		const ok = formatMoLiveMarketStatusBlock(row, {});
		if (!ok.includes("success") || !ok.includes("20260101") || !ok.includes("TWSE_MI_INDEX")) {
			throw new Error(`[mo-live status] expected success block: ${ok}`);
		}
		console.log("[mo-live] status summary ok");
	}

	runMoLiveStatusSummaryDevChecks();
	passCount += 1;

	function runMoReportDevChecks() {
		console.log("[mo-report] dev-check");
		const hOk = mapMoLiveMarketStatusHuman("success");
		if (!hOk.includes("資料已更新") || !hOk.includes("市場正常")) {
			throw new Error(`[mo-report] market success: ${hOk}`);
		}
		const hWait = mapMoLiveMarketStatusHuman("waiting_data");
		if (!hWait.includes("尚未取得")) {
			throw new Error(`[mo-report] market waiting: ${hWait}`);
		}
		const hFail = mapMoLiveMarketStatusHuman("fetch_failed");
		if (!hFail.includes("失敗")) {
			throw new Error(`[mo-report] market fetch_failed: ${hFail}`);
		}
		if (getMoLiveCycleStatusFromSnapshotRead({ kind: "ok", row: { trade_date: "20260101" } }) !== "success") {
			throw new Error("[mo-report] snapshot read success");
		}
		if (getMoLiveCycleStatusFromSnapshotRead({ kind: "ok", row: null }) !== "waiting_data") {
			throw new Error("[mo-report] snapshot read waiting");
		}
		if (getMoLiveCycleStatusFromSnapshotRead({ kind: "error", message: "x" }) !== "fetch_failed") {
			throw new Error("[mo-report] snapshot read error");
		}
		if (mapScoreToActionLine(95) !== "可提高部位") throw new Error("[mo-report] action 95");
		if (mapScoreToActionLine(80) !== "維持配置") throw new Error("[mo-report] action 80");
		if (mapScoreToActionLine(50) !== "建議保守") throw new Error("[mo-report] action 50");
		const full = buildMoReportText({
			displayDate: "2026/01/01",
			dataSource: "TEST",
			marketStatusLine: buildMarketStatusText("success"),
			systemDecisionLine: buildSystemDecisionText("balanced", 75, true, "x"),
			actionLine: buildActionText(75),
			notesLine: "模擬顯示：測試",
		});
		if (full.trim().length === 0) throw new Error("[mo-report] empty");
		if (!full.includes("MO Report")) throw new Error("[mo-report] title");
		if (!full.includes("市場狀態")) throw new Error("[mo-report] 市場狀態");
		if (!full.includes("建議")) throw new Error("[mo-report] 建議");
		console.log("[mo-report] dev-check ok");
	}

	runMoReportDevChecks();
	passCount += 1;

	function runMoPushDryRunDevChecks() {
		console.log("[mo-push] dry-run dev-check");
		const cd = MO_PUSH_COOLDOWN_MS_DEFAULT;
		const m0 = "資料已更新，市場正常，可供參考。";
		const m1 = "尚未取得最新資料（可能非交易時段或尚未寫入）。";
		const a0 = "建議保守";
		const a2 = "可提高部位";
		const d0 = "2026/03/27";
		const base = {
			displayDate: d0,
			cooldownMsDefault: MO_PUSH_COOLDOWN_MS_DEFAULT,
			cooldownMsP3Only: MO_PUSH_COOLDOWN_MS_P3_ONLY,
			gatePriority: MO_PUSH_PRIORITY.market_status_changed,
			nowMs: 1_000_000,
		};

		const msgFull = buildMoUpdatePushMessage(m0, a0, d0);
		if (
			!msgFull.includes("MO Update") ||
			!msgFull.includes("市場狀態") ||
			!msgFull.includes("建議")
		) {
			throw new Error("[mo-push] message shape");
		}

		const msgPromo = buildMoPushMessage({
			displayDate: d0,
			marketLine: m0,
			actionLine: a0,
			events: [{ type: "strategy_promoted", summary: "" }],
			promotedFrom: "a",
			promotedTo: "b",
		});
		if (!msgPromo.includes("策略更新")) {
			throw new Error("[mo-push] strategy section");
		}

		// 1) market status changed
		const marketEv = evaluateMoPushEventDecision({
			...base,
			marketLine: m1,
			actionLine: a0,
			currentPromoteKey: "",
			lastEvaluatedMarketLine: m0,
			lastEvaluatedActionLine: a0,
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: null,
			gateMessage: null,
			gateAtMs: null,
			promotedFrom: undefined,
			promotedTo: undefined,
		});
		if (!marketEv.shouldNotify || marketEv.primaryPushType !== "market_status_changed") {
			throw new Error(`[mo-push] market status changed: ${JSON.stringify(marketEv)}`);
		}

		// 2) report action changed
		const actionEv = evaluateMoPushEventDecision({
			...base,
			marketLine: m0,
			actionLine: a2,
			currentPromoteKey: "",
			lastEvaluatedMarketLine: m0,
			lastEvaluatedActionLine: a0,
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: null,
			gateMessage: null,
			gateAtMs: null,
		});
		if (!actionEv.shouldNotify || actionEv.primaryPushType !== "report_action_changed") {
			throw new Error(`[mo-push] report action changed: ${JSON.stringify(actionEv)}`);
		}

		// 3) strategy promoted — priority 高於 market / report
		const stratEv = evaluateMoPushEventDecision({
			...base,
			marketLine: m0,
			actionLine: a0,
			currentPromoteKey: "demo-v1|demo-v2",
			lastEvaluatedMarketLine: m0,
			lastEvaluatedActionLine: a0,
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: null,
			gateMessage: null,
			gateAtMs: null,
			promotedFrom: "demo-v1",
			promotedTo: "demo-v2",
		});
		if (!stratEv.shouldNotify || stratEv.primaryPushType !== "strategy_promoted") {
			throw new Error(`[mo-push] strategy promoted: ${JSON.stringify(stratEv)}`);
		}
		if (
			stratEv.pushPriority === null ||
			marketEv.pushPriority === null ||
			actionEv.pushPriority === null ||
			stratEv.pushPriority >= marketEv.pushPriority ||
			stratEv.pushPriority >= actionEv.pushPriority
		) {
			throw new Error("[mo-push] priority ordering");
		}

		// 4) 完全沒變化（與上次評估快照相同）
		const noEv = evaluateMoPushEventDecision({
			...base,
			marketLine: m0,
			actionLine: a0,
			currentPromoteKey: "",
			lastEvaluatedMarketLine: m0,
			lastEvaluatedActionLine: a0,
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: null,
			gateMessage: null,
			gateAtMs: null,
		});
		if (noEv.shouldNotify || noEv.pushResult !== "skipped_no_change") {
			throw new Error(`[mo-push] no change: ${JSON.stringify(noEv)}`);
		}

		// 5) 相同內容（fingerprint）已推過
		const refActionFp = evaluateMoPushEventDecision({
			...base,
			marketLine: m0,
			actionLine: a2,
			currentPromoteKey: "",
			lastEvaluatedMarketLine: m0,
			lastEvaluatedActionLine: a0,
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: null,
			gateMessage: null,
			gateAtMs: null,
		});
		const fpDup = evaluateMoPushEventDecision({
			...base,
			marketLine: m0,
			actionLine: a2,
			currentPromoteKey: "",
			lastEvaluatedMarketLine: m0,
			lastEvaluatedActionLine: a0,
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: refActionFp.fingerprint,
			gateMessage: null,
			gateAtMs: null,
		});
		if (fpDup.shouldNotify || fpDup.pushResult !== "skipped_same_content") {
			throw new Error(`[mo-push] duplicate fp: ${JSON.stringify(fpDup)}`);
		}

		// 5b) cooldown（同文、同優先級窗口內）
		const mergedGate = buildMoPushMessage({
			displayDate: d0,
			marketLine: m0,
			actionLine: a2,
			events: [{ type: "report_action_changed", summary: "" }],
		});
		const tGate = 1_000_000;
		const cool = evaluateMoPushEventDecision({
			...base,
			marketLine: m0,
			actionLine: a2,
			currentPromoteKey: "",
			lastEvaluatedMarketLine: m0,
			lastEvaluatedActionLine: a0,
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: null,
			gateMessage: mergedGate,
			gateAtMs: tGate,
			nowMs: tGate + 60_000,
			gatePriority: MO_PUSH_PRIORITY.report_action_changed,
		});
		if (cool.shouldNotify || cool.pushResult !== "skipped_cooldown") {
			throw new Error(`[mo-push] cooldown: ${JSON.stringify(cool)}`);
		}

		// 6) 高優先級覆蓋低優先級 gate 時間窗（同一段文案、gate 為較低優先級）
		const highPri = evaluateMoPushEventDecision({
			...base,
			marketLine: m0,
			actionLine: a0,
			currentPromoteKey: "a|b",
			lastEvaluatedMarketLine: m0,
			lastEvaluatedActionLine: a0,
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: null,
			gateMessage: msgPromo,
			gateAtMs: tGate,
			nowMs: tGate + 60_000,
			gatePriority: MO_PUSH_PRIORITY.market_status_changed,
			promotedFrom: "a",
			promotedTo: "b",
		});
		if (!highPri.shouldNotify || highPri.pushReason !== "higher_priority_overrides_low_priority_cooldown") {
			throw new Error(`[mo-push] priority bypass: ${JSON.stringify(highPri)}`);
		}

		// 7) buildMoPushMessage 非空且含區塊標題
		const built = buildMoPushMessage({
			displayDate: d0,
			marketLine: m0,
			actionLine: a0,
			events: [
				{ type: "market_status_changed", summary: "" },
				{ type: "report_action_changed", summary: "" },
			],
		});
		if (built.trim().length === 0) throw new Error("[mo-push] empty message");
		if (!built.includes("MO Update")) throw new Error("[mo-push] title");
		if (!built.includes("市場狀態") && !built.includes("建議") && !built.includes("策略更新")) {
			throw new Error("[mo-push] section keyword");
		}
		console.log("[mo-push] dry-run ok");
	}

	runMoPushDryRunDevChecks();
	passCount += 1;

	let guardState = /** @type {PromoteGuardState} */ ({ confirmCount: 0 });
	const t0 = 1_700_000_000_000;
	const stabilityCases = [
		{
			name: "first promote_candidate",
			decision: /** @type {Decision} */ ("promote_candidate"),
			at: t0,
			expectedResult: "guarded",
		},
		{
			name: "second promote_candidate",
			decision: /** @type {Decision} */ ("promote_candidate"),
			at: t0 + 60_000,
			expectedResult: "promoted",
		},
		{
			name: "post-promote immediate",
			decision: /** @type {Decision} */ ("promote_candidate"),
			at: t0 + 120_000,
			expectedResult: "guarded",
		},
	];

	for (const c of stabilityCases) {
		const checked = evaluateAutoPromoteCore(guardState, c.decision, c.at);
		console.log({
			stabilityCase: c.name,
			decision: c.decision,
			result: checked.result,
			expectedResult: c.expectedResult,
			confirmCount: checked.confirmCount,
			cooldownRemainingMs: checked.cooldownRemainingMs,
		});
		if (checked.result !== c.expectedResult) {
			console.error("❌ mismatch", {
				stabilityCase: c.name,
				result: checked.result,
				expectedResult: c.expectedResult,
			});
			failCount += 1;
		} else {
			passCount += 1;
		}
		guardState = checked.nextState;
	}

	/**
	 * MO Strategy E2E：共用 computeStrategyComparePure + evaluateAutoPromoteCore
	 */
	function runStrategyE2E() {
		const baseActive = { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 };
		/** @type {StrategyShape} */
		let active = { ...baseActive };
		/** @type {StrategyShape} */
		let candidate = { ...active };

		/**
		 * @param {boolean} cond
		 * @param {string} step
		 * @param {string} detail
		 */
		function assertE2e(cond, step, detail) {
			if (!cond) {
				throw new Error(`[E2E ${step}] ${detail}`);
			}
		}

		const strongSnapshot = {
			status: "active",
			dataFreshnessScore: 85,
			dataVolumeScore: 85,
			simulationReadyScore: 85,
		};

		console.log("[E2E Step 1] clone active → candidate");
		candidate = { ...active };
		assertE2e(
			candidate.balancedMinScore === active.balancedMinScore,
			"Step 1",
			"candidate should match active after clone"
		);

		console.log("[E2E Step 2] patch candidate balancedMinScore=25 + review (real)");
		candidate = { ...candidate, balancedMinScore: 25 };
		let rr = computeStrategyComparePure(active, candidate, "real", {
			demoOverride: null,
			snapshot: null,
		});
		assertE2e(rr.compareDecision === "hold_review", "Step 2", `expected hold_review, got ${rr.compareDecision}`);
		assertE2e(rr.scoreDelta < 0, "Step 2", `expected delta < 0, got ${rr.scoreDelta}`);

		console.log("[E2E Step 3] clone active → candidate (reset)");
		candidate = { ...active };

		console.log("[E2E Step 4] patch candidate balancedMinScore=90 + review (real)");
		candidate = { ...candidate, balancedMinScore: 90 };
		rr = computeStrategyComparePure(active, candidate, "real", { demoOverride: null, snapshot: null });
		assertE2e(
			rr.compareDecision === "promote_candidate",
			"Step 4",
			`expected promote_candidate, got ${rr.compareDecision}`
		);
		assertE2e(rr.scoreDelta >= 10, "Step 4", `expected scoreDelta >= 10, got ${rr.scoreDelta}`);

		console.log("[E2E Step 5] auto-promote (1st)");
		let guard = /** @type {PromoteGuardState} */ ({ confirmCount: 0 });
		const tStart = Date.now();
		let ap = evaluateAutoPromoteCore(guard, rr.compareDecision, tStart);
		assertE2e(ap.result !== "promoted", "Step 5", `expected not promoted first, got ${ap.result}`);
		assertE2e(ap.confirmCount === 1, "Step 5", `expected confirmCount 1, got ${ap.confirmCount}`);
		assertE2e(ap.result === "guarded", "Step 5", `expected guarded, got ${ap.result}`);
		guard = ap.nextState;

		console.log("[E2E Step 6] auto-promote (2nd)");
		ap = evaluateAutoPromoteCore(guard, rr.compareDecision, tStart + 60_000);
		assertE2e(ap.result === "promoted", "Step 6", `expected promoted, got ${ap.result}`);
		assertE2e(ap.confirmCount === 2, "Step 6", `expected confirmCount 2, got ${ap.confirmCount}`);
		guard = ap.nextState;

		console.log("[E2E Step 7] review after promote (active synced to candidate)");
		active = { ...candidate };
		rr = computeStrategyComparePure(active, candidate, "real", { demoOverride: null, snapshot: strongSnapshot });
		assertE2e(rr.scoreDelta === 0, "Step 7", `expected scoreDelta 0, got ${rr.scoreDelta}`);
		assertE2e(
			rr.changedFields.length === 0,
			"Step 7",
			`expected no changed fields, got ${rr.changedFields.join(",")}`
		);
		assertE2e(
			rr.compareDecision === "keep_active",
			"Step 7",
			`expected keep_active, got ${rr.compareDecision}`
		);

		console.log("[E2E Step 8] auto-promote when compare is keep_active");
		ap = evaluateAutoPromoteCore(guard, rr.compareDecision, tStart + 120_000);
		assertE2e(ap.result === "no_action", "Step 8", `expected no_action, got ${ap.result}`);
		assertE2e(
			rr.compareDecision === "keep_active",
			"Step 8",
			`expected keep_active, got ${rr.compareDecision}`
		);
	}

	try {
		runStrategyE2E();
		passCount += 1;
		console.log("✅ E2E strategy flow passed (8 steps)");
	} catch (e) {
		failCount += 1;
		console.error("❌ E2E strategy flow failed:", e);
	}

	console.log({ passCount, failCount });

	if (failCount > 0) {
		process.exit(1);
	}

	console.log("✅ all tests passed");
}

module.exports = {
	computeStrategyComparePure,
	evaluateAutoPromoteCore,
	evaluateAutoPromoteStable: evaluateAutoPromoteCore,
	deriveCompareDecisionForAutoPromote,
	shouldRefreshStrategyReviewKv,
	STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED,
	STRATEGY_AUTO_PROMOTE_COOLDOWN_MS,
	normalizeStrategyConfigForCore,
	MO_LIVE_SOURCE_TWSE_MI_INDEX,
	getTaipeiYYYYMMDDMinusDaysFromToday,
	deriveMoLiveCycleStatus,
	summarizeTwseMiIndexPayload,
	isTwseMiIndexPayloadOk,
	formatMoLiveMarketStatusBlock,
	getMoLiveCycleStatusFromSnapshotRead,
	mapMoLiveMarketStatusHuman,
	buildMarketStatusText,
	formatDisplayDateFromYyyymmdd,
	mapScoreToActionLine,
	buildSystemDecisionText,
	buildActionText,
	buildMoReportText,
	buildMoPushMessage,
	buildMoUpdatePushMessage,
	fingerprintMoPushPayload,
	fingerprintMoPushContent,
	evaluateMoPushEventDecision,
	MO_PUSH_PRIORITY,
	MO_PUSH_COOLDOWN_MS_DEFAULT,
	MO_PUSH_COOLDOWN_MS_P3_ONLY,
	detectMoPushTriggeredEvents,
	detectReportRiskChangedForMoPush,
};

if (
	typeof process !== "undefined" &&
	typeof process.argv !== "undefined" &&
	process.argv[1] &&
	/dev-check\.js$/.test(String(process.argv[1]))
) {
	runDevCheckMain();
}
