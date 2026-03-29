import type { MoLiveDataGovernance } from "./governance.js";

export type RecommendationPrecheckDataUsability = "decision_ok" | "display_only" | "unusable";

export type RecommendationPrecheckResult = {
	ok: boolean;
	decisionEligible: boolean;
	dataUsability: RecommendationPrecheckDataUsability;
	shouldBlock: boolean;
	blockReason: string | null;
};

export function buildRecommendationPrecheckResult(gov: MoLiveDataGovernance): RecommendationPrecheckResult {
	const du = gov.dataUsability;
	const de = gov.decisionEligible;

	if (du === "unusable") {
		return {
			ok: false,
			decisionEligible: de,
			dataUsability: "unusable",
			shouldBlock: true,
			blockReason: "market_data_unusable",
		};
	}

	if (de === true && du === "decision_ok") {
		return {
			ok: true,
			decisionEligible: true,
			dataUsability: "decision_ok",
			shouldBlock: false,
			blockReason: null,
		};
	}

	if (de === false && du === "display_only") {
		return {
			ok: true,
			decisionEligible: false,
			dataUsability: "display_only",
			shouldBlock: true,
			blockReason: "decision_not_eligible",
		};
	}

	if (de === true && du === "push_ok") {
		return {
			ok: true,
			decisionEligible: true,
			dataUsability: "decision_ok",
			shouldBlock: false,
			blockReason: null,
		};
	}

	const outDu: RecommendationPrecheckDataUsability =
		du === "display_only" ? "display_only" : "decision_ok";
	return {
		ok: true,
		decisionEligible: de,
		dataUsability: outDu,
		shouldBlock: true,
		blockReason: "decision_not_eligible",
	};
}
