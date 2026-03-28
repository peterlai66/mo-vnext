/**
 * Minimal stub recommendation engine (deterministic, no I/O).
 * Replace `buildRecommendationStubResult` with a real engine adapter later.
 */

export type RecommendationStubMarket = "TW";

export type RecommendationStubCandidate = {
	symbol: string;
	name: string;
	market: RecommendationStubMarket;
	rationale: string;
	score: number;
};

export type RecommendationStubResult = {
	source: "stub_engine";
	ready: boolean;
	candidateCount: number;
	candidates: readonly RecommendationStubCandidate[];
	notes: readonly string[];
};

const STUB_CANDIDATES: readonly RecommendationStubCandidate[] = [
	{
		symbol: "0050.TW",
		name: "元大台灣50",
		market: "TW",
		rationale: "stub large-cap benchmark candidate",
		score: 70,
	},
	{
		symbol: "00878.TW",
		name: "國泰永續高股息",
		market: "TW",
		rationale: "stub dividend candidate",
		score: 64,
	},
];

const STUB_NOTES: readonly string[] = ["stub engine active", "not based on live ranking"];

export function buildRecommendationStubResult(): RecommendationStubResult {
	const candidates = STUB_CANDIDATES;
	return {
		source: "stub_engine",
		ready: true,
		candidateCount: candidates.length,
		candidates,
		notes: STUB_NOTES,
	};
}
