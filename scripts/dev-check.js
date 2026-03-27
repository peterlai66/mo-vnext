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

/** ---- MO live 資料可信度（與 Worker 單一推導；規則集中於此） ---- */

const MO_LIVE_GOV_FRESH_MS = 30 * 60 * 1000;
const MO_LIVE_GOV_AGING_MS = 2 * 60 * 60 * 1000;
const MO_LIVE_GOV_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * @param {string} yyyymmdd
 * @returns {number}
 */
function moLiveParseYyyymmddUtcMs(yyyymmdd) {
	const y = Number(yyyymmdd.slice(0, 4));
	const m = Number(yyyymmdd.slice(4, 6)) - 1;
	const d = Number(yyyymmdd.slice(6, 8));
	return Date.UTC(y, m, d);
}

/**
 * 交易日相對「今日」落後天數（非負表示 trade 在過去或未來；僅供分級）
 * @param {string} tradeYyyymmdd
 * @param {string} todayYyyymmdd
 */
function moLiveTradeDateLagDays(tradeYyyymmdd, todayYyyymmdd) {
	if (typeof tradeYyyymmdd !== "string" || !/^\d{8}$/.test(tradeYyyymmdd)) return 999;
	if (typeof todayYyyymmdd !== "string" || !/^\d{8}$/.test(todayYyyymmdd)) return 999;
	const tt = moLiveParseYyyymmddUtcMs(tradeYyyymmdd);
	const tn = moLiveParseYyyymmddUtcMs(todayYyyymmdd);
	return Math.round((tn - tt) / (24 * 60 * 60 * 1000));
}

/**
 * @param {number} ageMs
 * @returns {"fresh" | "aging" | "stale" | "too_old"}
 */
function moLiveStalenessFromAgeMs(ageMs) {
	if (!Number.isFinite(ageMs)) return "too_old";
	if (ageMs <= MO_LIVE_GOV_FRESH_MS) return "fresh";
	if (ageMs <= MO_LIVE_GOV_AGING_MS) return "aging";
	if (ageMs <= MO_LIVE_GOV_STALE_MS) return "stale";
	return "too_old";
}

/**
 * @param {number} lagDays
 */
function moLiveStalenessFromTradeLagDays(lagDays) {
	if (lagDays <= 0) return "fresh";
	if (lagDays <= 1) return "aging";
	if (lagDays <= 2) return "stale";
	return "too_old";
}

/**
 * @param {"fresh" | "aging" | "stale" | "too_old"} a
 * @param {"fresh" | "aging" | "stale" | "too_old"} b
 */
function moLiveMergeStalenessTier(a, b) {
	const order = ["fresh", "aging", "stale", "too_old"];
	const ia = order.indexOf(a);
	const ib = order.indexOf(b);
	return order[Math.max(ia, ib)];
}

/**
 * @param {string} raw
 * @returns {null | {
 *   v: number;
 *   source: string;
 *   sourceLevel: string;
 *   fetchStatus: string;
 *   confidence: string;
 *   rawAvailabilityNote: string;
 *   legacySummary: string;
 * }}
 */
function parseMoLiveV2PayloadSummaryForGov(raw) {
	if (typeof raw !== "string") return null;
	const t = raw.trim();
	if (!t.startsWith("{")) return null;
	try {
		const o = JSON.parse(t);
		if (typeof o !== "object" || o === null) return null;
		if (o.v !== 2) return null;
		if (typeof o.source !== "string") return null;
		if (
			o.sourceLevel !== "primary" &&
			o.sourceLevel !== "fallback1" &&
			o.sourceLevel !== "fallback2"
		) {
			return null;
		}
		if (
			o.fetchStatus !== "success" &&
			o.fetchStatus !== "fallback_used" &&
			o.fetchStatus !== "unavailable"
		) {
			return null;
		}
		if (
			o.confidence !== "high" &&
			o.confidence !== "medium" &&
			o.confidence !== "low"
		) {
			return null;
		}
		if (typeof o.rawAvailabilityNote !== "string") return null;
		if (typeof o.legacySummary !== "string") return null;
		return o;
	} catch {
		return null;
	}
}

/**
 * 單一入口：由 D1 列 + 現在時間推導可信度（不讀其他列；最新一筆 unavailable 仍明示不可用）。
 *
 * @param {{
 *   row: { trade_date: string; created_at: string; payload_summary: string } | null;
 *   nowMs: number;
 *   todayYyyymmdd: string;
 * }} p
 */
function deriveMoLiveDataGovernance(p) {
	const today = p.todayYyyymmdd;
	if (p.row === null) {
		return {
			tradeDate: "",
			source: "—",
			sourceLevel: "primary",
			fetchStatus: "unavailable",
			confidence: "low",
			rawAvailabilityNote: "無快照",
			legacySummary: "",
			dataUsability: "unusable",
			stalenessLevel: "too_old",
			freshnessMinutes: null,
			sourcePriority: 99,
			decisionEligible: false,
			pushEligible: false,
			displayFetchStatus: "unavailable",
			liveFreshness: "stale",
			v2: null,
		};
	}
	const row = p.row;
	const createdMs = Date.parse(row.created_at);
	const ageMs = Number.isFinite(createdMs) ? p.nowMs - createdMs : Number.POSITIVE_INFINITY;
	const freshnessMinutes = Number.isFinite(createdMs) ? Math.floor(ageMs / 60000) : null;
	const v2 = parseMoLiveV2PayloadSummaryForGov(row.payload_summary);
	const lagDays = moLiveTradeDateLagDays(row.trade_date, today);

	if (v2 === null) {
		const stalenessLevel = moLiveStalenessFromAgeMs(ageMs);
		const unusable = stalenessLevel === "too_old";
		return {
			tradeDate: row.trade_date,
			source: row.source,
			sourceLevel: "primary",
			fetchStatus: "success",
			confidence: "low",
			rawAvailabilityNote: "legacy payload_summary（非 v2 JSON）",
			legacySummary: row.payload_summary.slice(0, 200),
			dataUsability: unusable ? "unusable" : "display_only",
			stalenessLevel,
			freshnessMinutes,
			sourcePriority: 9,
			decisionEligible: false,
			pushEligible: false,
			displayFetchStatus: unusable ? "stale" : "success",
			liveFreshness: stalenessLevel === "fresh" ? "ok" : "stale",
			v2: null,
		};
	}

	const ageTier = moLiveStalenessFromAgeMs(ageMs);
	const lagTier = moLiveStalenessFromTradeLagDays(lagDays);
	let merged = moLiveMergeStalenessTier(ageTier, lagTier);
	if (v2.fetchStatus === "unavailable") {
		merged = "too_old";
	}
	const stalenessLevel = merged;

	const sourcePriority =
		v2.sourceLevel === "primary" ? 1
		: v2.sourceLevel === "fallback1" ? 2
		: v2.sourceLevel === "fallback2" ? 3
		: 9;

	let decisionEligible = false;
	if (stalenessLevel !== "too_old" && v2.fetchStatus !== "unavailable") {
		if (
			v2.sourceLevel === "primary" &&
			v2.fetchStatus === "success" &&
			lagDays <= 2
		) {
			decisionEligible = true;
		} else if (
			v2.sourceLevel === "fallback1" &&
			v2.fetchStatus === "fallback_used" &&
			(stalenessLevel === "fresh" || stalenessLevel === "aging") &&
			lagDays <= 1
		) {
			decisionEligible = true;
		}
		// fallback2：預設不提供 decision（僅顯示）；避免 OpenAPI 欄位少／日期落後誤判
	}

	let pushEligible = false;
	if (
		v2.sourceLevel === "primary" &&
		v2.fetchStatus === "success" &&
		stalenessLevel === "fresh" &&
		lagDays <= 0 &&
		ageMs <= MO_LIVE_GOV_FRESH_MS
	) {
		pushEligible = true;
	}

	let dataUsability = "display_only";
	if (v2.fetchStatus === "unavailable" || stalenessLevel === "too_old") {
		dataUsability = "unusable";
	} else if (pushEligible) {
		dataUsability = "push_ok";
	} else if (decisionEligible) {
		dataUsability = "decision_ok";
	} else {
		dataUsability = "display_only";
	}

	let displayFetchStatus = v2.fetchStatus;
	if (v2.fetchStatus === "unavailable") {
		displayFetchStatus = "unavailable";
	} else if (stalenessLevel === "stale" || stalenessLevel === "too_old") {
		displayFetchStatus = "stale";
	}

	let liveFreshness = "ok";
	if (stalenessLevel === "aging") {
		liveFreshness = "aging";
	}
	if (stalenessLevel === "stale" || stalenessLevel === "too_old") {
		liveFreshness = "stale";
	}

	return {
		tradeDate: row.trade_date,
		source: v2.source,
		sourceLevel: v2.sourceLevel,
		fetchStatus: v2.fetchStatus,
		confidence: v2.confidence,
		rawAvailabilityNote: v2.rawAvailabilityNote,
		legacySummary: v2.legacySummary,
		dataUsability,
		stalenessLevel,
		freshnessMinutes,
		sourcePriority,
		decisionEligible,
		pushEligible,
		displayFetchStatus,
		liveFreshness,
		v2,
	};
}

/**
 * @param {ReturnType<typeof deriveMoLiveDataGovernance>} g
 */
function buildMoReportDataQualityNote(g) {
	if (g.dataUsability === "push_ok") {
		return "資料新鮮可用（行情層級符合推播門檻）。";
	}
	if (g.dataUsability === "decision_ok") {
		return "行情資料可用於分析；若為 fallback，欄位較少，僅供參考。";
	}
	if (g.dataUsability === "display_only") {
		return "資料僅供參考（來源或時效不足以作為自動判斷／推播依據）。";
	}
	return "無可用行情快照或資料不足／過舊，不適合判斷。";
}

/**
 * @param {ReturnType<typeof deriveMoLiveDataGovernance>} g
 */
function getMoLiveReportCycleFromGovernance(g) {
	if (g.dataUsability === "unusable") return "fetch_failed";
	if (g.stalenessLevel === "too_old") return "partial";
	return "success";
}

/**
 * @param {"success" | "waiting_data" | "partial" | "fetch_failed"} cycle
 * @param {ReturnType<typeof deriveMoLiveDataGovernance>} g
 */
function buildMarketStatusLineWithGovernance(cycle, g) {
	const base = mapMoLiveMarketStatusHuman(cycle);
	return `${base}\n\n【資料品質】${buildMoReportDataQualityNote(g)}`;
}

/**
 * 從 legacySummary 抽出指數／收盤數值（最小可用；取不到則 null）
 * @param {string} legacySummary
 * @returns {string | null}
 */
function moLiveExtractMarketValue(legacySummary) {
	if (typeof legacySummary !== "string" || legacySummary.trim() === "") return null;
	const m = /close=([\d.]+)/u.exec(legacySummary);
	if (m !== null) return m[1];
	const m2 = /date=\d{8};close=([\d.]+)/u.exec(legacySummary);
	if (m2 !== null) return m2[1];
	return null;
}

/**
 * Live Market Intelligence v1（只吃 governance 推導結果 + 筆記數）
 *
 * @param {ReturnType<typeof deriveMoLiveDataGovernance>} gov
 * @param {{ rowIsNull: boolean; noteCountForRec: number; todayYyyymmdd: string }} ctx
 */
function deriveLiveMarketIntelligenceV1(gov, ctx) {
	const rowIsNull = ctx.rowIsNull;
	const noteCount = ctx.noteCountForRec;
	const today = ctx.todayYyyymmdd;
	const lagDays =
		rowIsNull || typeof gov.tradeDate !== "string" || gov.tradeDate === "" ?
			999
		:	moLiveTradeDateLagDays(gov.tradeDate, today);

	const marketDataAvailable =
		!rowIsNull && gov.dataUsability !== "unusable";
	const marketValue = marketDataAvailable ? moLiveExtractMarketValue(gov.legacySummary) : null;

	/** @type {"trusted" | "limited" | "weak" | "unusable"} */
	let marketDataQuality = "unusable";
	if (!marketDataAvailable || gov.dataUsability === "unusable" || gov.stalenessLevel === "too_old") {
		marketDataQuality = "unusable";
	} else if (
		gov.dataUsability === "push_ok" ||
		(gov.dataUsability === "decision_ok" &&
			gov.sourceLevel === "primary" &&
			gov.stalenessLevel === "fresh" &&
			lagDays <= 0)
	) {
		marketDataQuality = "trusted";
	} else if (
		gov.dataUsability === "decision_ok" ||
		(gov.dataUsability === "display_only" &&
			(gov.stalenessLevel === "fresh" || gov.stalenessLevel === "aging"))
	) {
		marketDataQuality = "limited";
	} else {
		marketDataQuality = "weak";
	}

	/** @type {"same_day" | "previous_day" | "stale" | "unavailable"} */
	let marketRecencyLabel = "unavailable";
	if (!marketDataAvailable || gov.dataUsability === "unusable") {
		marketRecencyLabel = "unavailable";
	} else if (lagDays <= 0) {
		marketRecencyLabel = "same_day";
	} else if (lagDays === 1) {
		marketRecencyLabel = "previous_day";
	} else {
		marketRecencyLabel = "stale";
	}

	let marketInterpretation = "無可用行情解讀。";
	if (!marketDataAvailable) {
		marketInterpretation = "尚無有效行情快照，或資料標記為不可用。";
	} else if (marketDataQuality === "trusted") {
		marketInterpretation = "資料可作為即時決策參考（仍非投資建議）。";
	} else if (marketDataQuality === "limited") {
		marketInterpretation = "可作方向參考，不宜作即時推播或重部位依據。";
	} else if (marketDataQuality === "weak") {
		marketInterpretation = "來源或欄位受限，僅供概略參考。";
	} else {
		marketInterpretation = "不適合做市場判斷。";
	}

	/** @type {"ready" | "limited" | "blocked"} */
	let recommendationReadiness = "blocked";
	let recommendationGateReason = "行情不可用或過舊，已阻擋建議輸出。";
	if (marketDataQuality === "unusable") {
		recommendationReadiness = "blocked";
		recommendationGateReason = "資料標記為 unusable 或過舊。";
	} else if (gov.decisionEligible && marketDataQuality !== "weak") {
		recommendationReadiness = "ready";
		recommendationGateReason = "治理允許：decisionEligible 且資料品質非 weak。";
	} else if (marketDataAvailable && gov.sourceLevel === "fallback2") {
		recommendationReadiness = "limited";
		recommendationGateReason = "OpenAPI fallback 僅顯示層級，建議保守。";
	} else if (marketDataAvailable) {
		recommendationReadiness = "limited";
		recommendationGateReason = "資料僅供參考，不給出積極建議。";
	}

	/** @type {"ready" | "limited" | "blocked"} */
	let simulationReadiness = "blocked";
	let simulationGateReason = "無筆記或行情不可用，無法模擬。";
	if (noteCount <= 0) {
		simulationReadiness = "blocked";
		simulationGateReason = "尚無筆記資料，無法進行策略模擬。";
	} else if (marketDataQuality === "unusable") {
		simulationReadiness = "blocked";
		simulationGateReason = "行情不可用，模擬結果可信度不足。";
	} else if (recommendationReadiness === "ready" && marketDataQuality !== "weak") {
		simulationReadiness = "ready";
		simulationGateReason = "筆記與行情條件足夠，可做模擬參考。";
	} else {
		simulationReadiness = "limited";
		simulationGateReason = "可做低信心模擬；行情或資料層級受限。";
	}

	return {
		marketDataAvailable,
		marketDataQuality,
		marketRecencyLabel,
		marketValue,
		marketValueChange: null,
		marketInterpretation,
		recommendationReadiness,
		simulationReadiness,
		recommendationGateReason,
		simulationGateReason,
	};
}

/**
 * @param {"aggressive" | "balanced" | "conservative"} strategy
 * @param {number} score
 * @param {boolean} hasAdequateData
 * @param {string} recReason
 * @param {ReturnType<typeof deriveLiveMarketIntelligenceV1>} li
 */
function buildSystemDecisionLineLiveIntelligence(strategy, score, hasAdequateData, recReason, li) {
	if (li.recommendationReadiness === "blocked") {
		return `建議輸出已依資料條件阻擋（${li.recommendationGateReason}）\n請保守觀望，不以此作為進出依據。\n\n【行情判讀】${li.marketInterpretation}`;
	}
	const base =
		!hasAdequateData && li.marketDataQuality !== "unusable" ?
			buildSystemDecisionTextNotesInadequate(strategy, score, recReason)
		:	buildSystemDecisionText(strategy, score, hasAdequateData, recReason);
	let body = base;
	if (li.recommendationReadiness === "limited") {
		body = `【建議層級】有限／低信心（以下判斷僅供參考，不宜重部位）\n${base}`;
	}
	if (li.marketDataQuality === "unusable") {
		return `${body}\n\n【行情判讀】資料不足或過舊，不適合判斷。`;
	}
	if (li.marketDataQuality === "trusted" || li.recommendationReadiness === "ready") {
		return `${body}\n\n【行情判讀】${li.marketInterpretation}`;
	}
	if (li.marketDataQuality === "limited") {
		return `${body}\n\n【行情判讀】資料僅供參考：${li.marketInterpretation}`;
	}
	return `${body}\n\n【行情判讀】${li.marketInterpretation}`;
}

/**
 * @param {number} score
 * @param {ReturnType<typeof deriveLiveMarketIntelligenceV1>} li
 */
function buildActionLineLiveIntelligence(score, li) {
	const s = mapScoreToActionLine(score);
	if (li.recommendationReadiness === "blocked") {
		return `不給出具體部位建議（${li.recommendationGateReason}）建議保守觀望並待資料更新。`;
	}
	if (li.recommendationReadiness === "limited") {
		return `${s}（資料受限：${li.recommendationGateReason}；請保守／觀望）`;
	}
	if (li.marketDataQuality !== "trusted") {
		return `${s}（可提供有限建議，請保守參考，不宜重部位；仍非投資顧問意見）`;
	}
	return `${s}（行情層級允許一般建議；仍非投資顧問意見）`;
}

/**
 * @param {string} simResult
 * @param {number} noteCountForRec
 * @param {ReturnType<typeof deriveLiveMarketIntelligenceV1>} li
 */
function buildSimulationStatusLineLiveIntelligence(simResult, noteCountForRec, li) {
	if (li.simulationReadiness === "blocked") {
		return `狀態：不可模擬\n原因：${li.simulationGateReason}`;
	}
	if (li.simulationReadiness === "limited") {
		return `狀態：低信心可模擬（策略敘述僅供參考，不宜重部位）\n原因：${li.simulationGateReason}\n參考：${simResult}`;
	}
	return `狀態：可模擬（正常參考）\n筆記：${String(noteCountForRec)} 則\n參考：${simResult}`;
}

/**
 * 對齊 recommendation 摘要欄位與 recommendationReadiness（供 KV／status 與報告語意一致）
 * @param {ReturnType<typeof deriveLiveMarketIntelligenceV1>} li
 * @param {{ recStatus: "active" | "idle"; recReason: string; recAction: string }} base
 */
function applyLiveIntelligenceToRecommendationFields(li, base) {
	if (li.recommendationReadiness === "blocked") {
		return {
			recStatus: /** @type {"idle"} */ ("idle"),
			recReason: li.recommendationGateReason,
			recAction: `不給出具體部位或策略建議（${li.recommendationGateReason}）請保守觀望並待資料更新。`,
		};
	}
	if (li.recommendationReadiness === "limited") {
		return {
			recStatus: /** @type {"active"} */ ("active"),
			recReason: li.recommendationGateReason,
			recAction: `有限建議／低信心參考（${li.recommendationGateReason}）請保守因應，不宜重部位。`,
		};
	}
	if (base.recStatus === "idle" && base.recReason === "尚無資料") {
		return {
			recStatus: /** @type {"active"} */ ("active"),
			recReason: "行情條件允許建議輸出；筆記仍不足，策略依據有限",
			recAction: "可參考目前建議與評分語氣；仍建議補齊筆記以強化依據。",
		};
	}
	return {
		recStatus: base.recStatus,
		recReason: base.recReason,
		recAction: base.recAction,
	};
}

/**
 * 對齊 simulation 摘要欄位與 simulationReadiness
 * @param {ReturnType<typeof deriveLiveMarketIntelligenceV1>} li
 * @param {{ simResult: string; simReady: string; noteCountForRec: number }} base
 */
function applyLiveIntelligenceToSimulationFields(li, base) {
	if (li.simulationReadiness === "blocked") {
		return {
			simResult: `無法模擬（${li.simulationGateReason}）`,
			simReady: "no",
		};
	}
	if (li.simulationReadiness === "limited") {
		return {
			simResult: base.simResult,
			simReady: "no",
		};
	}
	return {
		simResult: base.simResult,
		simReady: base.noteCountForRec > 0 ? "yes" : "no",
	};
}

/**
 * /status [Report] 區塊：有 Live Intelligence v1 欄位時不再輸出易與新結論衝突的舊欄位。
 * @param {{
 *   currentStrategy: string;
 *   previousStrategy: string;
 *   changed: boolean;
 *   shouldNotify: boolean;
 *   recommendationStatus: string;
 *   recommendationReason?: string;
 *   simulationReady: boolean;
 *   simulationResult?: string;
 *   timestamp: string;
 *   reportDataQuality?: string;
 *   recommendationReadiness?: string;
 *   simulationReadiness?: string;
 *   recommendationGateReason?: string;
 *   simulationGateReason?: string;
 * }} r
 * @returns {string}
 */
function buildMoReportSummaryStatusBlockLines(r) {
	const lines = [
		`reportStrategy: ${r.currentStrategy}`,
		`reportPrev: ${r.previousStrategy}`,
		`reportChanged: ${r.changed}`,
		`reportShouldNotify: ${r.shouldNotify}`,
	];
	const hasV1Intel =
		r.reportDataQuality !== undefined ||
		r.recommendationReadiness !== undefined ||
		r.simulationReadiness !== undefined;
	if (!hasV1Intel) {
		lines.push(`reportRec: ${r.recommendationStatus}`);
		if (r.recommendationReason !== undefined) {
			lines.push(`reportReason: ${r.recommendationReason}`);
		}
		lines.push(`reportSimReady: ${r.simulationReady ? "yes" : "no"}`);
		if (r.simulationResult !== undefined) {
			lines.push(`reportSimResult: ${r.simulationResult}`);
		}
	}
	if (r.reportDataQuality !== undefined) {
		lines.push(`reportDataQuality: ${r.reportDataQuality}`);
	}
	if (r.recommendationReadiness !== undefined) {
		lines.push(`recommendationReadiness: ${r.recommendationReadiness}`);
	}
	if (r.simulationReadiness !== undefined) {
		lines.push(`simulationReadiness: ${r.simulationReadiness}`);
	}
	if (r.recommendationGateReason !== undefined) {
		lines.push(`recommendationGateReason: ${r.recommendationGateReason}`);
	}
	if (r.simulationGateReason !== undefined) {
		lines.push(`simulationGateReason: ${r.simulationGateReason}`);
	}
	lines.push(`reportAt: ${r.timestamp}`);
	return lines.join("\n");
}

/**
 * @param {ReturnType<typeof deriveLiveMarketIntelligenceV1>} li
 * @param {ReturnType<typeof deriveMoLiveDataGovernance>} gov
 * @param {string} displayDate
 * @param {string} dataSource
 */
function buildMoReportMarketSummarySection(li, gov, displayDate, dataSource) {
	const val =
		li.marketValue !== null ? `指數／收盤參考值：${li.marketValue}` : "指數／收盤參考值：—（未能自摘要解析）";
	const recency =
		li.marketRecencyLabel === "same_day" ? "交易日：與今日同日（曆日對齊）"
		: li.marketRecencyLabel === "previous_day" ? "交易日：前一曆日／接近最近交易日"
		: li.marketRecencyLabel === "stale" ? "交易日：偏舊或非最近交易日"
		: "交易日：不可用";
	return [
		`資料來源欄位：${dataSource}`,
		`交易日（快照）：${gov.tradeDate || "—"}`,
		`報告日期：${displayDate}`,
		recency,
		val,
		`可信度層級：${li.marketDataQuality}`,
		`摘要：${li.marketInterpretation}`,
	].join("\n");
}

/**
 * @param {{
 *   displayDate: string;
 *   dataSource: string;
 *   dataQualityLine: string;
 *   marketSummaryLine: string;
 *   systemDecisionLine: string;
 *   actionLine: string;
 *   simulationLine: string;
 * }} p
 * @returns {string}
 */
function buildMoReportTextV1(p) {
	const parts = [
		"MO Report",
		"",
		`日期：${p.displayDate}`,
		"",
		"【資料品質】",
		p.dataQualityLine,
		"",
		"【行情摘要】",
		p.marketSummaryLine,
		"",
		"【系統判斷】",
		p.systemDecisionLine,
		"",
		"【建議】",
		p.actionLine,
		"",
		"【模擬狀態】",
		p.simulationLine,
	];
	return parts.join("\n");
}

/**
 * @param {{ liveMarketPushEligible?: boolean }} p
 * @param {Record<string, unknown>} result
 */
function applyMoPushLiveDataGate(p, result) {
	if (p.liveMarketPushEligible !== false) return result;
	if (!result.shouldNotify) return result;
	return {
		...result,
		shouldNotify: false,
		pushReason: "blocked_by_data_usability",
		pushResult: "skipped_live_data_not_push_eligible",
		moPushDataGate: "push_ineligible_snapshot",
	};
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
/**
 * 筆記不足時的系統判斷（行情仍可用時避免寫成「整體尚無資料」）
 * @param {"aggressive" | "balanced" | "conservative"} strategy
 * @param {number} score
 * @param {string} recReason
 */
function buildSystemDecisionTextNotesInadequate(strategy, score, recReason) {
	const zh =
		strategy === "aggressive" ? "積極型" : strategy === "conservative" ? "保守型" : "平衡型";
	const stance =
		strategy === "aggressive" ? "偏積極" : strategy === "conservative" ? "偏保守" : "中性平衡";
	const detail =
		recReason === "尚無資料" || recReason === "無資料可模擬" ? "尚無筆記" : recReason;
	const judgment = `筆記不足（${detail}），策略依據有限，以下判斷僅供參考。`;
	return `當前策略：${zh}（${stance}）\n綜合評分：${score} 分。\n${judgment}`;
}

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
 *   liveMarketPushEligible?: boolean;
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
 *   moPushDataGate?: string;
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
		return applyMoPushLiveDataGate(p, {
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
		});
	}

	if (p.lastPushedFingerprint !== null && fingerprint === p.lastPushedFingerprint) {
		return applyMoPushLiveDataGate(p, {
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
		});
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
				return applyMoPushLiveDataGate(p, {
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
				});
			}
			if (p.gateMessage !== null && p.gateMessage === mergedMessage) {
				return applyMoPushLiveDataGate(p, {
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
				});
			}
		} else if (p.gateMessage !== null && p.gateMessage === mergedMessage) {
			return applyMoPushLiveDataGate(p, {
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
			});
		}
	}

	return applyMoPushLiveDataGate(p, {
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
	});
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

	function runMoLiveGovernanceDevChecks() {
		console.log("[mo-live] governance");
		const today = getTaipeiYYYYMMDDMinusDaysFromToday(0);
		const now = Date.now();
		const isoFresh = new Date(now - 10 * 60 * 1000).toISOString();
		const v2Primary = {
			v: 2,
			source: MO_LIVE_SOURCE_TWSE_MI_INDEX,
			sourceLevel: "primary",
			fetchStatus: "success",
			confidence: "high",
			rawAvailabilityNote: "x",
			legacySummary: "y",
		};
		const gPrimaryFresh = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: isoFresh,
				payload_summary: JSON.stringify(v2Primary),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		if (!gPrimaryFresh.pushEligible || !gPrimaryFresh.decisionEligible) {
			throw new Error("[mo-live gov] primary fresh push+decision");
		}
		if (gPrimaryFresh.dataUsability !== "push_ok") {
			throw new Error("[mo-live gov] primary push_ok");
		}

		const v2F1 = {
			...v2Primary,
			source: "FINMIND_TaiwanStockPrice",
			sourceLevel: "fallback1",
			fetchStatus: "fallback_used",
			confidence: "medium",
		};
		const gF1 = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: isoFresh,
				payload_summary: JSON.stringify(v2F1),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		if (!gF1.decisionEligible || gF1.pushEligible) {
			throw new Error("[mo-live gov] fallback1 decision no push");
		}
		if (gF1.dataUsability !== "decision_ok") {
			throw new Error("[mo-live gov] fallback1 decision_ok");
		}

		const v2F2 = {
			...v2Primary,
			source: "TWSE_OpenAPI_MI_INDEX",
			sourceLevel: "fallback2",
			fetchStatus: "fallback_used",
			confidence: "low",
		};
		const gF2 = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: isoFresh,
				payload_summary: JSON.stringify(v2F2),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		if (gF2.decisionEligible || gF2.pushEligible) {
			throw new Error("[mo-live gov] fallback2 display_only");
		}
		if (gF2.dataUsability !== "display_only") {
			throw new Error("[mo-live gov] fallback2 display_only usability");
		}

		const staleIso = new Date(now - 3 * 60 * 60 * 1000).toISOString();
		const gStale = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: staleIso,
				payload_summary: JSON.stringify(v2Primary),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		if (gStale.pushEligible || gStale.stalenessLevel !== "stale") {
			throw new Error(`[mo-live gov] stale no push: ${gStale.stalenessLevel}`);
		}

		const v2Un = {
			...v2Primary,
			source: MO_LIVE_SOURCE_TWSE_MI_INDEX,
			sourceLevel: "fallback2",
			fetchStatus: "unavailable",
			confidence: "low",
		};
		const gUn = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: isoFresh,
				payload_summary: JSON.stringify(v2Un),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		if (gUn.dataUsability !== "unusable" || gUn.decisionEligible) {
			throw new Error("[mo-live gov] unavailable unusable");
		}

		const evWould = evaluateMoPushEventDecision({
			displayDate: "x",
			marketLine: "a",
			actionLine: "b",
			currentPromoteKey: "",
			lastEvaluatedMarketLine: "",
			lastEvaluatedActionLine: "",
			lastEvaluatedPromoteKey: "",
			lastPushedFingerprint: null,
			gateMessage: null,
			gateAtMs: null,
			gatePriority: 3,
			nowMs: now,
			cooldownMsDefault: MO_PUSH_COOLDOWN_MS_DEFAULT,
			cooldownMsP3Only: MO_PUSH_COOLDOWN_MS_P3_ONLY,
			liveMarketPushEligible: false,
		});
		if (evWould.shouldNotify || evWould.pushReason !== "blocked_by_data_usability") {
			throw new Error("[mo-live gov] push gate");
		}

		console.log("[mo-live] governance ok");
	}

	runMoLiveGovernanceDevChecks();
	passCount += 1;

	function runMoLiveIntelligenceV1DevChecks() {
		console.log("[mo-live] intelligence v1");
		const today = getTaipeiYYYYMMDDMinusDaysFromToday(0);
		const now = Date.now();
		const isoFresh = new Date(now - 10 * 60 * 1000).toISOString();
		const v2Primary = {
			v: 2,
			source: MO_LIVE_SOURCE_TWSE_MI_INDEX,
			sourceLevel: "primary",
			fetchStatus: "success",
			confidence: "high",
			rawAvailabilityNote: "x",
			legacySummary: "stat=OK;close=12345.67",
		};
		const gP = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: isoFresh,
				payload_summary: JSON.stringify(v2Primary),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		const liP = deriveLiveMarketIntelligenceV1(gP, {
			rowIsNull: false,
			noteCountForRec: 3,
			todayYyyymmdd: today,
		});
		if (
			liP.recommendationReadiness !== "ready" ||
			liP.simulationReadiness !== "ready" ||
			liP.marketDataQuality !== "trusted"
		) {
			throw new Error("[mo-live] li primary ready");
		}

		const v2F1 = {
			...v2Primary,
			source: "FINMIND_TaiwanStockPrice",
			sourceLevel: "fallback1",
			fetchStatus: "fallback_used",
			confidence: "medium",
			legacySummary: "close=20000",
		};
		const gF1 = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: isoFresh,
				payload_summary: JSON.stringify(v2F1),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		if (!gF1.pushEligible) {
			/* expected */
		}
		const liF1 = deriveLiveMarketIntelligenceV1(gF1, {
			rowIsNull: false,
			noteCountForRec: 2,
			todayYyyymmdd: today,
		});
		if (liF1.recommendationReadiness !== "ready") {
			throw new Error("[mo-live] li f1 rec");
		}

		const v2F2 = {
			...v2Primary,
			source: "TWSE_OpenAPI_MI_INDEX",
			sourceLevel: "fallback2",
			fetchStatus: "fallback_used",
			confidence: "low",
			legacySummary: "close=1",
		};
		const gF2 = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: isoFresh,
				payload_summary: JSON.stringify(v2F2),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		const liF2 = deriveLiveMarketIntelligenceV1(gF2, {
			rowIsNull: false,
			noteCountForRec: 1,
			todayYyyymmdd: today,
		});
		if (liF2.recommendationReadiness !== "limited") {
			throw new Error("[mo-live] li f2 limited");
		}

		const v2Un = {
			...v2Primary,
			source: MO_LIVE_SOURCE_TWSE_MI_INDEX,
			sourceLevel: "fallback2",
			fetchStatus: "unavailable",
			confidence: "low",
		};
		const gUn = deriveMoLiveDataGovernance({
			row: {
				trade_date: today,
				created_at: isoFresh,
				payload_summary: JSON.stringify(v2Un),
			},
			nowMs: now,
			todayYyyymmdd: today,
		});
		const liUn = deriveLiveMarketIntelligenceV1(gUn, {
			rowIsNull: false,
			noteCountForRec: 5,
			todayYyyymmdd: today,
		});
		if (liUn.recommendationReadiness !== "blocked" || liUn.simulationReadiness !== "blocked") {
			throw new Error("[mo-live] li unavailable blocked");
		}

		const txt = buildMoReportTextV1({
			displayDate: "d",
			dataSource: "ds",
			dataQualityLine: "q",
			marketSummaryLine: "m",
			systemDecisionLine: "s",
			actionLine: "a",
			simulationLine: "sim",
		});
		if (!txt.includes("【行情摘要】") || !txt.includes("【模擬狀態】") || !txt.includes("【建議】")) {
			throw new Error("[mo-live] report v1 shape");
		}

		const liF1n0 = deriveLiveMarketIntelligenceV1(gF1, {
			rowIsNull: false,
			noteCountForRec: 0,
			todayYyyymmdd: today,
		});
		if (liF1n0.marketDataQuality !== "limited" || liF1n0.recommendationReadiness !== "ready") {
			throw new Error("[mo-live] li f1n0 limited ready");
		}
		if (liF1n0.simulationReadiness !== "blocked") {
			throw new Error("[mo-live] li f1n0 sim blocked");
		}
		const sysN0 = buildSystemDecisionLineLiveIntelligence(
			"balanced",
			75,
			false,
			"尚無資料",
			liF1n0
		);
		if (sysN0.includes("尚無資料")) {
			throw new Error("[mo-live] system line must not say 尚無資料 when market usable");
		}
		const actN0 = buildActionLineLiveIntelligence(75, liF1n0);
		if (actN0.includes("行情層級允許一般建議")) {
			throw new Error("[mo-live] action limited+ready must stay conservative");
		}
		if (!actN0.includes("有限建議")) {
			throw new Error("[mo-live] action limited+ready wording");
		}

		const sysBlocked = buildSystemDecisionLineLiveIntelligence(
			"balanced",
			80,
			true,
			"近期有活動",
			liUn
		);
		if (sysBlocked.includes("綜合評分")) {
			throw new Error("[mo-live] blocked system must not show score");
		}
		if (!sysBlocked.includes("阻擋")) {
			throw new Error("[mo-live] blocked system gate");
		}
		const actBlocked = buildActionLineLiveIntelligence(80, liUn);
		if (!actBlocked.includes("不給出")) {
			throw new Error("[mo-live] blocked action");
		}

		const sysLimRec = buildSystemDecisionLineLiveIntelligence(
			"balanced",
			70,
			true,
			"近期有活動",
			liF2
		);
		if (!sysLimRec.includes("建議層級") || !sysLimRec.includes("有限")) {
			throw new Error("[mo-live] limited recommendation system line");
		}
		const actLim = buildActionLineLiveIntelligence(70, liF2);
		if (!actLim.includes("資料受限")) {
			throw new Error("[mo-live] limited action");
		}

		const sysReadyP = buildSystemDecisionLineLiveIntelligence(
			"balanced",
			80,
			true,
			"近期有活動",
			liP
		);
		if (!sysReadyP.includes("綜合評分")) {
			throw new Error("[mo-live] ready system keeps score");
		}
		if (sysReadyP.includes("建議層級")) {
			throw new Error("[mo-live] ready system no limited banner");
		}
		const actReadyP = buildActionLineLiveIntelligence(80, liP);
		if (!actReadyP.includes("行情層級允許一般建議")) {
			throw new Error("[mo-live] ready trusted action tone");
		}

		const simLiUn = buildSimulationStatusLineLiveIntelligence("模擬測試", 5, liUn);
		if (!simLiUn.includes("不可模擬") || simLiUn.includes("參考：模擬")) {
			throw new Error("[mo-live] sim blocked line");
		}
		const liF2n2 = deriveLiveMarketIntelligenceV1(gF2, {
			rowIsNull: false,
			noteCountForRec: 2,
			todayYyyymmdd: today,
		});
		if (liF2n2.simulationReadiness !== "limited") {
			throw new Error("[mo-live] f2n2 sim limited");
		}
		const simLiLim = buildSimulationStatusLineLiveIntelligence("模擬偏平衡", 2, liF2n2);
		if (!simLiLim.includes("低信心") || !simLiLim.includes("參考：模擬偏平衡")) {
			throw new Error("[mo-live] sim limited line");
		}
		const simLiReady = buildSimulationStatusLineLiveIntelligence("模擬偏積極", 3, liP);
		if (!simLiReady.includes("可模擬（正常參考）") || !simLiReady.includes("參考：模擬偏積極")) {
			throw new Error("[mo-live] sim ready line");
		}

		const recApply = applyLiveIntelligenceToRecommendationFields(liUn, {
			recStatus: "active",
			recReason: "近期有活動",
			recAction: "x",
		});
		if (recApply.recStatus !== "idle" || recApply.recReason !== liUn.recommendationGateReason) {
			throw new Error("[mo-live] apply rec blocked");
		}
		const simApply = applyLiveIntelligenceToSimulationFields(liUn, {
			simResult: "模擬偏積極",
			simReady: "yes",
			noteCountForRec: 5,
		});
		if (simApply.simReady !== "no" || !simApply.simResult.includes("無法模擬")) {
			throw new Error("[mo-live] apply sim blocked");
		}

		const statusV1 = buildMoReportSummaryStatusBlockLines({
			currentStrategy: "balanced",
			previousStrategy: "conservative",
			changed: false,
			shouldNotify: false,
			recommendationStatus: "none",
			recommendationReason: "尚無資料",
			simulationReady: false,
			simulationResult: "無法模擬",
			timestamp: "t0",
			reportDataQuality: "limited",
			recommendationReadiness: "ready",
			simulationReadiness: "blocked",
			recommendationGateReason: "g",
			simulationGateReason: "s",
		});
		if (statusV1.includes("reportRec:") || statusV1.includes("reportReason:")) {
			throw new Error("[mo-live] status v1 must omit legacy reportRec/reportReason");
		}
		if (!statusV1.includes("recommendationReadiness: ready")) {
			throw new Error("[mo-live] status v1 readiness");
		}
		const statusLegacy = buildMoReportSummaryStatusBlockLines({
			currentStrategy: "balanced",
			previousStrategy: "conservative",
			changed: false,
			shouldNotify: false,
			recommendationStatus: "active",
			simulationReady: true,
			timestamp: "t1",
		});
		if (!statusLegacy.includes("reportRec: active")) {
			throw new Error("[mo-live] status legacy keeps reportRec");
		}

		console.log("[mo-live] intelligence v1 ok");
	}

	runMoLiveIntelligenceV1DevChecks();
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
	deriveMoLiveDataGovernance,
	buildMoReportDataQualityNote,
	buildMarketStatusLineWithGovernance,
	getMoLiveReportCycleFromGovernance,
	MO_LIVE_GOV_FRESH_MS,
	MO_LIVE_GOV_AGING_MS,
	MO_LIVE_GOV_STALE_MS,
	deriveLiveMarketIntelligenceV1,
	buildMoReportTextV1,
	buildMoReportMarketSummarySection,
	buildSystemDecisionLineLiveIntelligence,
	buildActionLineLiveIntelligence,
	buildSimulationStatusLineLiveIntelligence,
	buildMoReportSummaryStatusBlockLines,
	applyLiveIntelligenceToRecommendationFields,
	applyLiveIntelligenceToSimulationFields,
};

if (
	typeof process !== "undefined" &&
	typeof process.argv !== "undefined" &&
	process.argv[1] &&
	/dev-check\.js$/.test(String(process.argv[1]))
) {
	runDevCheckMain();
}
