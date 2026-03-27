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
};

if (
	typeof process !== "undefined" &&
	typeof process.argv !== "undefined" &&
	process.argv[1] &&
	/dev-check\.js$/.test(String(process.argv[1]))
) {
	runDevCheckMain();
}
