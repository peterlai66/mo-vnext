/**
 * @typedef {"promote_candidate" | "keep_active" | "hold_review"} Decision
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

/** @type {TestCase[]} */
const testCases = [
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 50, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "hold_review",
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "keep_active",
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 65, freshnessWeight: 1, volumeWeight: 1 },
		expectedDecision: "hold_review",
	},
	{
		active: { balancedMinScore: 60, freshnessWeight: 1, volumeWeight: 1 },
		candidate: { balancedMinScore: 60, freshnessWeight: 2, volumeWeight: 1 },
		expectedDecision: "promote_candidate",
	},
];

const results = testCases.map(({ active, candidate, expectedDecision }) => {
	const activeScore = calcScore(active);
	const candidateScore = calcScore(candidate);
	const delta = candidateScore - activeScore;
	let decision;

	if (delta >= 10) {
		decision = "promote_candidate";
	} else if (delta === 0) {
		decision = "keep_active";
	} else {
		decision = "hold_review";
	}

	return {
		active,
		candidate,
		activeScore,
		candidateScore,
		delta,
		decision,
		expectedDecision,
	};
});

for (const item of results) {
	console.log(item);
}

let passCount = 0;
let failCount = 0;
for (const item of results) {
	if (item.decision !== item.expectedDecision) {
		console.error("❌ mismatch", item);
		failCount += 1;
	} else {
		passCount += 1;
	}
}

const summary = results.reduce(
	(acc, item) => {
		if (item.decision === "promote_candidate") acc.promote += 1;
		if (item.decision === "hold_review") acc.hold += 1;
		if (item.decision === "keep_active") acc.keep += 1;
		return acc;
	},
	{ total: results.length, promote: 0, hold: 0, keep: 0 }
);

console.log(summary);
console.log({ passCount, failCount });

if (failCount > 0) {
	process.exit(1);
}

console.log("✅ all tests passed");
