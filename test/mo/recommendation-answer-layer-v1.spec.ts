import { describe, it, expect } from "vitest";
import {
	gapMagnitudeNarrativeZh,
	tryComposeRecommendationAnswerLayerV1,
} from "../../src/mo/recommendation-answer-layer-v1.js";
import type { RecommendationOutput } from "../../src/mo/recommendation-output.js";
import type { RecommendationExplainableSummary } from "../../src/mo/recommendation-output.js";

function minimalRecOut(overrides: Partial<RecommendationOutput>): RecommendationOutput {
	const explainable: RecommendationExplainableSummary = {
		headline: "h",
		reasoning: "r",
		action: "a",
		risk: "k",
		renderedText: "x",
	};
	const base: RecommendationOutput = {
		ok: true,
		blocked: false,
		blockReason: null,
		decisionEligible: true,
		dataUsability: "decision_ok",
		mode: "latest",
		summary: "s",
		decision: {
			stage: "skeleton_ready",
			readiness: "ready_for_engine",
			source: "governance_precheck",
			candidateCount: 0,
			notes: [],
		},
		candidate: {
			stage: "placeholder_ready",
			source: "recommendation_loader",
			count: 0,
			items: [],
			notes: [],
		},
		allocation: {
			stage: "not_allocated",
			method: "none",
			profile: "p",
			ready: false,
			itemCount: 0,
			items: [],
			cashRatio: null,
			positionRatio: null,
			notes: [],
		},
		simulation: {
			readiness: "not_ready",
			source: "none",
			executable: false,
			notes: [],
		},
		recommendation: {
			source: "etf_universe",
			ready: true,
			candidateCount: 0,
			candidates: [],
			notes: [],
		},
		explainableSummary: explainable,
		generatedAt: "2025-01-01T00:00:00.000Z",
	};
	return { ...base, ...overrides };
}

describe("Answer Layer v1（白盒）", () => {
	it("ask_why：含第一名與相較句，且不含整段 candidateSummary 式貼上", () => {
		const recOut = minimalRecOut({
			recommendation: {
				source: "etf_universe",
				ready: true,
				candidateCount: 3,
				candidates: [
					{ symbol: "0056.TW", name: "元大高股息", market: "TW", rationale: "x", score: 90, rank: 1, scoringSource: "etf_universe", scoringNotes: [] },
					{ symbol: "00713.TW", name: "元大台灣高息低波", market: "TW", rationale: "x", score: 70, rank: 2, scoringSource: "etf_universe", scoringNotes: [] },
					{ symbol: "00878.TW", name: "國泰台灣5G+", market: "TW", rationale: "x", score: 60, rank: 3, scoringSource: "etf_universe", scoringNotes: [] },
				],
				notes: [],
			},
			etfCandidateContext: {
				gate: "ranked_candidate_ready",
				humanSummaryZh: "【很長的摘要若整段出現在此測試應失敗】",
				deltaExplain: {
					leader: "0056",
					comparisons: [
						{
							against: "00713",
							advantages: ["當日報酬動能較強"],
							disadvantages: [],
						},
					],
				},
			},
		});
		const zh = tryComposeRecommendationAnswerLayerV1({
			followUpIntent: "ask_why",
			userMessage: "為什麼是0056",
			recOut,
			pack: {
				recommendationMode: "observe_only",
				blockedBy: "score",
				semanticCandidateOnly: false,
			},
		});
		expect(zh).not.toBeNull();
		expect(zh).toContain("0056");
		expect(zh).toContain("相較");
		expect(zh).toContain("00713");
		expect(zh?.includes("【很長的摘要若整段出現在此測試應失敗】")).toBe(false);
	});

	it("ask_ticker：提到排名與和第一名的比較", () => {
		const recOut = minimalRecOut({
			recommendation: {
				source: "etf_universe",
				ready: true,
				candidateCount: 2,
				candidates: [
					{ symbol: "0056.TW", name: "A", market: "TW", rationale: "x", score: 90, rank: 1, scoringSource: "etf_universe", scoringNotes: [] },
					{ symbol: "00713.TW", name: "B", market: "TW", rationale: "x", score: 70, rank: 2, scoringSource: "etf_universe", scoringNotes: [] },
				],
				notes: [],
			},
			etfCandidateContext: {
				gate: "ranked_candidate_ready",
				humanSummaryZh: "x",
				deltaExplain: {
					leader: "0056",
					comparisons: [
						{
							against: "00713",
							advantages: ["成交活絡度較高"],
							disadvantages: ["當日報酬動能相對較弱"],
						},
					],
				},
			},
		});
		const zh = tryComposeRecommendationAnswerLayerV1({
			followUpIntent: "ask_ticker",
			userMessage: "00713呢",
			recOut,
			pack: {
				recommendationMode: "observe_only",
				blockedBy: "score",
				semanticCandidateOnly: false,
			},
		});
		expect(zh).not.toBeNull();
		expect(zh).toContain("第 2");
		expect(zh).toContain("0056");
		expect(zh).toMatch(/第一名|與第一名/u);
	});

	it("ask_timing：observe_only 含信心語句，且不貼 primaryReason 數字句", () => {
		const recOut = minimalRecOut({
			recommendation: {
				source: "etf_universe",
				ready: true,
				candidateCount: 1,
				candidates: [
					{ symbol: "0056.TW", name: "A", market: "TW", rationale: "x", score: 80, rank: 1, scoringSource: "etf_universe", scoringNotes: [] },
				],
				notes: [],
			},
			etfCandidateContext: {
				gate: "ranked_candidate_ready",
				humanSummaryZh: "x",
				deltaExplain: null,
			},
		});
		const zh = tryComposeRecommendationAnswerLayerV1({
			followUpIntent: "ask_timing",
			userMessage: "現在適合進場嗎",
			recOut,
			pack: {
				recommendationMode: "observe_only",
				blockedBy: "score",
				semanticCandidateOnly: false,
			},
		});
		expect(zh).not.toBeNull();
		expect(zh).toContain("觀察");
		expect(zh).toContain("已有相對較佳標的");
		expect(zh?.includes("未達門檻")).toBe(false);
	});

	it("分差大：敘事為差距相對明顯", () => {
		expect(gapMagnitudeNarrativeZh(12, true)).toContain("明顯");
	});
});
