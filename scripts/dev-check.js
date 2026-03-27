const active = 60;
const testCases = [
	{ candidate: 50, expectedDecision: "hold_review" },
	{ candidate: 60, expectedDecision: "keep_active" },
	{ candidate: 65, expectedDecision: "hold_review" },
	{ candidate: 70, expectedDecision: "promote_candidate" },
];

const results = testCases.map(({ candidate, expectedDecision }) => {
	const delta = candidate - active;
	let decision;

	if (delta >= 10) {
		decision = "promote_candidate";
	} else if (delta === 0) {
		decision = "keep_active";
	} else {
		decision = "hold_review";
	}

	return { active, candidate, delta, decision, expectedDecision };
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
