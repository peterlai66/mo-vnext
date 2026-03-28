import type { RecommendationRankingResult } from "./recommendation-ranking.js";

export type RecommendationAllocationPlanItem = {
	symbol: string;
	name: string;
	rank: number;
	targetRatio: number;
	rationale: string;
};

export type RecommendationAllocationPlanMethod =
	| "blocked"
	| "stub_equal_weight"
	| "stub_single_candidate";

export type RecommendationAllocationPlanResult = {
	ready: boolean;
	method: RecommendationAllocationPlanMethod;
	profile: string;
	itemCount: number;
	items: readonly RecommendationAllocationPlanItem[];
	cashRatio: number | null;
	positionRatio: number | null;
	notes: readonly string[];
};

type PlanInput =
	| { blocked: true; profile: string }
	| { blocked: false; rank: RecommendationRankingResult; profile: string };

export function buildRecommendationAllocationPlan(input: PlanInput): RecommendationAllocationPlanResult {
	if (input.blocked) {
		return {
			ready: false,
			method: "blocked",
			profile: input.profile,
			itemCount: 0,
			items: [],
			cashRatio: null,
			positionRatio: null,
			notes: ["allocation blocked"],
		};
	}

	const { rank, profile } = input;
	const ranked = rank.rankedCandidates;
	const n = ranked.length;

	if (n === 0) {
		return {
			ready: false,
			method: "stub_equal_weight",
			profile,
			itemCount: 0,
			items: [],
			cashRatio: null,
			positionRatio: null,
			notes: ["no ranked candidates for allocation"],
		};
	}

	if (n === 1) {
		const c = ranked[0];
		return {
			ready: true,
			method: "stub_single_candidate",
			profile,
			itemCount: 1,
			items: [
				{
					symbol: c.symbol,
					name: c.name,
					rank: c.rank,
					targetRatio: 1,
					rationale: "single ranked candidate allocation",
				},
			],
			cashRatio: 0,
			positionRatio: 1,
			notes: ["allocation derived from ranked candidates"],
		};
	}

	const top = ranked.slice(0, 2);
	return {
		ready: true,
		method: "stub_equal_weight",
		profile,
		itemCount: 2,
		items: top.map((c) => ({
			symbol: c.symbol,
			name: c.name,
			rank: c.rank,
			targetRatio: 0.5,
			rationale: "equal-weight allocation from top ranked candidates",
		})),
		cashRatio: 0,
		positionRatio: 1,
		notes: ["allocation derived from top ranked candidates"],
	};
}
