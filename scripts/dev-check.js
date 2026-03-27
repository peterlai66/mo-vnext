/**
 * @typedef {"promote_candidate" | "keep_active" | "hold_review"} Decision
 */
/**
 * @typedef {"high" | "medium"} Confidence
 */

/**
 * @typedef {{
 *  balancedMinScore: number;
 *  freshnessWeight: number;
 *  volumeWeight: number;
 * }} StrategyShape
 */

/**
 * @typedef {{
 *  active: StrategyShape;
 *  candidate: StrategyShape;
 *  expectedDecision: Decision;
 *  expectedChangedFields: Array<keyof StrategyShape>;
 *  expectedReason: string;
 *  expectedConfidence: Confidence;
 *  expectedAutoPromoteAllowed: boolean;
 *  expectedAutoPromoteResult: "promoted" | "blocked" | "no_action";
 * }} TestCase
 */

/**
 * @param {StrategyShape} strategy
 * @returns {number}
 */
function calcScore(strategy) {
	return (
		strategy.balancedMinScore * 1 +
		strategy.freshnessWeight * 10 +
		strategy.volumeWeight * 10
	);
}

/**
 * @param {StrategyShape} active
 * @param {StrategyShape} candidate
 * @returns {Array<keyof StrategyShape>}
 */
function compareStrategyFields(active, candidate) {
	/** @type {Array<keyof StrategyShape>} */
	const changed = [];
	if (active.balancedMinScore !== candidate.balancedMinScore) {
		changed.push("balancedMinScore");
	}
	if (active.freshnessWeight !== candidate.freshnessWeight) {
		changed.push("freshnessWeight");
	}
	if (active.volumeWeight !== candidate.volumeWeight) {
		changed.push("volumeWeight");
	}
	return changed;
}

/**
 * @param {Array<keyof StrategyShape>} changedFields
 * @returns {string}
 */
function buildReviewReason(changedFields) {
	if (changedFields.length === 0) {
		return "no strategy changes";
	}
	return `candidate changes: ${changedFields.join(", ")}`;
}

/**
 * @param {Decision} decision
 * @param {number} delta
 * @returns {Confidence}
 */
function buildReviewConfidence(decision, delta) {
	if (decision === "promote_candidate" && delta >= 10) return "high";
	if (decision === "keep_active" && delta === 0) return "high";
	return "medium";
}

/**
 * @param {StrategyShape} active
 * @param {StrategyShape} candidate
 * @returns {{
 *  activeScore: number;
 *  candidateScore: number;
 *  delta: number;
 *  changedFields: Array<keyof StrategyShape>;
 *  reason: string;
 *  decision: Decision;
 *  confidence: Confidence;
 * }}
 */
function buildReviewResult(active, candidate) {
	const activeScore = calcScore(active);
	const candidateScore = calcScore(candidate);
	const delta = candidateScore - activeScore;
	const changedFields = compareStrategyFields(active, candidate);
	const reason = buildReviewReason(changedFields);
	/** @type {Decision} */
	let decision;
	if (delta >= 10) {
		decision = "promote_candidate";
	} else if (delta === 0) {
		decision = "keep_active";
	} else {
		decision = "hold_review";
	}
	const confidence = buildReviewConfidence(decision, delta);
	return {
		activeScore,
		candidateScore,
		delta,
		changedFields,
		reason,
		decision,
		confidence,
	};
}

const CONFIRM_REQUIRED = 2;
const COOLDOWN_MS = 30 * 60 * 1000;

/**
 * @typedef {{
 *  lastDecision?: Decision;
 *  confirmCount: number;
 *  lastPromoteAt?: number;
 * }} PromoteGuardState
 */

/**
 * @param {PromoteGuardState} state
 * @param {Decision} decision
 * @param {number} nowMs
 * @returns {{ result: "promoted" | "blocked" | "no_action" | "guarded"; confirmCount: number; cooldownRemainingMs: number; nextState: PromoteGuardState; }}
 */
function evaluateAutoPromoteStable(state, decision, nowMs) {
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
	if (confirmCount < CONFIRM_REQUIRED) {
		return { result: "guarded", confirmCount, cooldownRemainingMs: 0, nextState: baseState };
	}

	const remaining =
		typeof state.lastPromoteAt === "number" ?
			Math.max(0, COOLDOWN_MS - (nowMs - state.lastPromoteAt))
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

/** @type {TestCase[]} */
const testCases = [
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 50, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "hold_review",
		expectedChangedFields: ["balancedMinScore"],
		expectedReason: "candidate changes: balancedMinScore",
		expectedConfidence: "medium",
		expectedAutoPromoteAllowed: false,
		expectedAutoPromoteResult: "blocked",
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "keep_active",
		expectedChangedFields: [],
		expectedReason: "no strategy changes",
		expectedConfidence: "high",
		expectedAutoPromoteAllowed: false,
		expectedAutoPromoteResult: "no_action",
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 65, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "hold_review",
		expectedChangedFields: ["balancedMinScore"],
		expectedReason: "candidate changes: balancedMinScore",
		expectedConfidence: "medium",
		expectedAutoPromoteAllowed: false,
		expectedAutoPromoteResult: "blocked",
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 60, freshnessWeight: 2, volumeWeight: 1 },
		expectedDecision: "promote_candidate",
		expectedChangedFields: ["freshnessWeight"],
		expectedReason: "candidate changes: freshnessWeight",
		expectedConfidence: "high",
		expectedAutoPromoteAllowed: true,
		expectedAutoPromoteResult: "promoted",
	},
];

const results = testCases.map(
	({
		active,
		candidate,
		expectedDecision,
		expectedChangedFields,
		expectedReason,
		expectedConfidence,
		expectedAutoPromoteAllowed,
		expectedAutoPromoteResult,
	}) => {
	const reviewResult = buildReviewResult(active, candidate);
	const autoPromoteAllowed = reviewResult.decision === "promote_candidate";
	const autoPromoteResult =
		reviewResult.decision === "promote_candidate" ? "promoted"
		: reviewResult.decision === "keep_active" ? "no_action"
		: "blocked";

	return {
		active,
		candidate,
		reviewResult,
		autoPromoteAllowed,
		autoPromoteResult,
		expectedDecision,
		expectedChangedFields,
		expectedReason,
		expectedConfidence,
		expectedAutoPromoteAllowed,
		expectedAutoPromoteResult,
	};
	}
);

for (const item of results) {
	console.log(item);
}

let passCount = 0;
let failCount = 0;
for (const item of results) {
	const fieldsMatch =
		item.reviewResult.changedFields.length === item.expectedChangedFields.length &&
		item.reviewResult.changedFields.every(
			(field, index) => field === item.expectedChangedFields[index]
		);
	const reasonMatch = item.reviewResult.reason === item.expectedReason;
	const decisionMatch = item.reviewResult.decision === item.expectedDecision;
	const confidenceMatch = item.reviewResult.confidence === item.expectedConfidence;
	const autoPromoteAllowedMatch =
		item.autoPromoteAllowed === item.expectedAutoPromoteAllowed;
	const autoPromoteResultMatch =
		item.autoPromoteResult === item.expectedAutoPromoteResult;

	if (
		!decisionMatch ||
		!fieldsMatch ||
		!reasonMatch ||
		!confidenceMatch ||
		!autoPromoteAllowedMatch ||
		!autoPromoteResultMatch
	) {
		console.error("❌ mismatch", item);
		failCount += 1;
	} else {
		passCount += 1;
	}
}

const summary = results.reduce(
	(acc, item) => {
		if (item.reviewResult.decision === "promote_candidate") acc.promote += 1;
		if (item.reviewResult.decision === "hold_review") acc.hold += 1;
		if (item.reviewResult.decision === "keep_active") acc.keep += 1;
		return acc;
	},
	{ total: results.length, promote: 0, hold: 0, keep: 0 }
);

console.log(summary);

// 穩定機制驗證：confirm_count + cooldown
/** @type {PromoteGuardState} */
let guardState = { confirmCount: 0 };
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
	const checked = evaluateAutoPromoteStable(guardState, c.decision, c.at);
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

console.log({ passCount, failCount });

if (failCount > 0) {
	process.exit(1);
}

console.log("✅ all tests passed");
