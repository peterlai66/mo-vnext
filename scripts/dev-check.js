const active = 60;
const candidates = [50, 60, 65, 70];

const results = candidates.map((candidate) => {
	const delta = candidate - active;
	let decision;

	if (delta >= 10) {
		decision = "promote_candidate";
	} else if (delta === 0) {
		decision = "keep_active";
	} else {
		decision = "hold_review";
	}

	return { active, candidate, delta, decision };
});

for (const item of results) {
	console.log(item);
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
