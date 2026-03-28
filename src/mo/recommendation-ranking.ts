import type {
	RecommendationCandidate,
	RecommendationCandidateLoadResult,
} from "./recommendation-candidate-loader.js";

export type RecommendationRankedCandidate = {
	symbol: string;
	name: string;
	market: "TW";
	rationale: string;
	score: number;
	rank: number;
	scoringSource: "real_loader" | "stub_engine";
	scoringNotes: string[];
};

export type RecommendationRankingResult = {
	source: "real_loader" | "stub_engine";
	ready: boolean;
	candidateCount: number;
	rankedCandidates: readonly RecommendationRankedCandidate[];
	notes: readonly string[];
};

function compareStableDescendingScore(a: RecommendationCandidate, b: RecommendationCandidate): number {
	if (b.score !== a.score) {
		return b.score - a.score;
	}
	return a.symbol.localeCompare(b.symbol);
}

export function rankRecommendationCandidates(
	load: RecommendationCandidateLoadResult
): RecommendationRankingResult {
	const sorted = [...load.candidates].sort(compareStableDescendingScore);
	const scoringSource = load.source;
	const perCandidateScoringNotes: readonly string[] =
		scoringSource === "real_loader"
			? ["ranked from real candidate loader"]
			: ["ranked from stub engine"];

	const rankingTailNote =
		scoringSource === "real_loader" ? "real candidate ranking ready" : "stub candidate ranking ready";

	const rankedCandidates: RecommendationRankedCandidate[] = sorted.map((c, idx) => ({
		symbol: c.symbol,
		name: c.name,
		market: c.market,
		rationale: c.rationale,
		score: c.score,
		rank: idx + 1,
		scoringSource,
		scoringNotes: [...perCandidateScoringNotes],
	}));

	return {
		source: load.source,
		ready: load.ready,
		candidateCount: rankedCandidates.length,
		rankedCandidates,
		notes: [...load.notes, rankingTailNote],
	};
}
