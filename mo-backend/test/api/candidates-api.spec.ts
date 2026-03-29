import { describe, it, expect } from "vitest";
import { compareTopCandidates } from "../../src/mo/recommendation/etf-delta-explain.js";
import { rankEtfCandidates } from "../../src/mo/recommendation/etf-rank.js";
import type { EtfNormalizedCandidate } from "../../src/mo/recommendation/etf-types.js";
import type { MoEtfPipelineResult } from "../../src/mo/recommendation/etf-pipeline.js";
import { mapEtfContextToCandidatesApiSuccess } from "../../src/api/candidates-builder.js";
import { tryHandleCandidatesApiRequest } from "../../src/api/candidates-route.js";

function cand(
	symbol: string,
	pctChange: number,
	volume: number,
	close = 100,
	prev = 99
): EtfNormalizedCandidate {
	return {
		symbol: `${symbol}.TW`,
		name: symbol,
		tradeDate: "20250327",
		close,
		pctChange,
		volume,
		source: "t",
		usableForRanking: true,
		normalizationNote: "ok",
	};
}

function makePipelineResult(): MoEtfPipelineResult {
	const ranked = rankEtfCandidates(
		[
			cand("0056", 0.02, 2_500_000),
			cand("00713", 0.01, 800_000),
			cand("00878", -0.005, 400_000),
		],
		0.01
	);
	const deltaExplain = compareTopCandidates(ranked, 3, 0.01);
	if (deltaExplain === null) {
		throw new Error("deltaExplain expected");
	}
	return {
		gate: "ranked_candidate_ready",
		loadResult: {
			source: "etf_universe",
			ready: true,
			candidateCount: 3,
			candidates: [],
			notes: [],
		},
		ranked,
		humanSummaryZh: "",
		deltaExplain,
		listsNamedEtfCandidates: true,
	};
}

describe("/api/candidates 映射（白盒）", () => {
	it("schema：ok、generatedAt、data 與 ranked≥3、leader 為第一名", () => {
		const etf = makePipelineResult();
		const out = mapEtfContextToCandidatesApiSuccess({
			recommendationMode: "observe_only",
			etf,
		});
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.body.ok).toBe(true);
		expect(typeof out.body.generatedAt).toBe("string");
		const { data } = out.body;
		expect(data.rankedCandidates.length).toBeGreaterThanOrEqual(3);
		expect(data.leader.symbol).toBe(data.rankedCandidates[0].symbol);
		expect(data.leader.rank).toBe(1);
		expect(data.recommendationMode).toBe("observe_only");
		expect(typeof data.confidence).toBe("string");
		expect(typeof data.display.decisionLabelZh).toBe("string");
		expect(data.display.decisionLabelZh.length).toBeGreaterThan(0);
		expect(typeof data.display.confidenceNarrativeZh).toBe("string");
		expect(data.display.confidenceNarrativeZh.length).toBeGreaterThan(0);
		expect(typeof data.display.generatedAtTaipei).toBe("string");
		expect(data.display.generatedAtTaipei.length).toBeGreaterThan(5);
	});

	it("score 由高到低", () => {
		const etf = makePipelineResult();
		const out = mapEtfContextToCandidatesApiSuccess({ recommendationMode: "observe_only", etf });
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		const { rankedCandidates } = out.body.data;
		for (let i = 0; i < rankedCandidates.length - 1; i++) {
			expect(rankedCandidates[i].score).toBeGreaterThanOrEqual(rankedCandidates[i + 1].score);
		}
	});

	it("deltaExplain pairs≥2，且優劣句不重複", () => {
		const etf = makePipelineResult();
		const out = mapEtfContextToCandidatesApiSuccess({ recommendationMode: "observe_only", etf });
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		const pairs = out.body.data.deltaExplain.pairs;
		expect(pairs.length).toBeGreaterThanOrEqual(2);
		expect(pairs[0].from).toBe(pairs[1].from);
		expect(pairs[0].to).not.toBe(pairs[1].to);
		for (const p of pairs) {
			const lines = p.summaryZh.split("\n");
			expect(lines.length).toBeGreaterThanOrEqual(2);
			expect(typeof p.narrativeZh).toBe("string");
			expect(p.narrativeZh.length).toBeGreaterThan(10);
		}
		const comps = etf.deltaExplain!.comparisons.slice(0, 2);
		for (const c of comps) {
			const adv = new Set(c.advantages);
			for (const d of c.disadvantages) {
				expect(adv.has(d)).toBe(false);
			}
		}
	});

	it("tryHandleCandidatesApiRequest：POST 405；其他路徑 null", async () => {
		const env = {} as import("../../src/index.js").Env;
		const noopDeps = {
			loadPushContext: async () => ({
				etfPipelineResult: null,
				recommendationExplainablePack: { recommendationMode: "observe_only" as const },
			}),
		};

		const postRes = await tryHandleCandidatesApiRequest(
			new Request("https://example.com/api/candidates", { method: "POST" }),
			env,
			noopDeps
		);
		expect(postRes?.status).toBe(405);

		const miss = await tryHandleCandidatesApiRequest(
			new Request("https://example.com/api/other", { method: "GET" }),
			env,
			noopDeps
		);
		expect(miss).toBeNull();
	});
});
