import { describe, it, expect } from "vitest";
import {
	compareTopCandidates,
	dedupeDeltaPhrasesZh,
} from "../../src/mo/recommendation/etf-delta-explain.js";
import { rankEtfCandidates } from "../../src/mo/recommendation/etf-rank.js";
import type { EtfNormalizedCandidate, EtfRankedRow } from "../../src/mo/recommendation/etf-types.js";
import {
	etfDeltaNoClearWeaknessZh,
	etfDeltaOverallNarrowMarginZh,
	etfDeltaTrendAdvantageZh,
	etfDeltaTrendDisadvantageZh,
	formatEtfDeltaExplainBodyZh,
} from "../../src/mo/recommendation/etf-public-facts.js";

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


/** 同一 pairwise 區塊內不可同時宣稱動能較強與動能較弱 */
function assertNoMomentumContradictionInFormattedBody(body: string): void {
	const chunks = body.split(/\n相較 /u);
	for (const ch of chunks) {
		const hasStrong = ch.includes("動能較強");
		const hasWeak = ch.includes("動能相對較弱");
		expect(hasStrong && hasWeak).toBe(false);
	}
}

function assertPairwiseConsistency(c: { advantages: string[]; disadvantages: string[] }): void {
	const adv = new Set(c.advantages);
	const dis = new Set(c.disadvantages);
	for (const x of adv) {
		expect(dis.has(x), `phrase in both sides: ${x}`).toBe(false);
	}
	expect(new Set(c.advantages).size).toBe(c.advantages.length);
	expect(new Set(c.disadvantages).size).toBe(c.disadvantages.length);
}

describe("ETF delta explain — compareTopCandidates（白盒）", () => {
	it("dedupeDeltaPhrasesZh：重複中文句只保留一次", () => {
		expect(dedupeDeltaPhrasesZh(["成交活絡度較高", "成交活絡度較高", "資料完整度較高"])).toEqual([
			"成交活絡度較高",
			"資料完整度較高",
		]);
	});

	it("動能維度：同一 pair 不可同時出現較強與較弱句", () => {
		const ranked = rankEtfCandidates(
			[
				cand("0056", 0.02, 2_500_000),
				cand("00713", 0.01, 800_000),
				cand("00878", -0.005, 400_000),
			],
			0.01
		);
		const d = compareTopCandidates(ranked, 3, 0.01);
		const ta = etfDeltaTrendAdvantageZh();
		const td = etfDeltaTrendDisadvantageZh();
		for (const comp of d?.comparisons ?? []) {
			expect(comp.advantages.includes(ta) && comp.disadvantages.includes(td)).toBe(false);
		}
		const body = formatEtfDeltaExplainBodyZh(d!);
		assertNoMomentumContradictionInFormattedBody(body);
	});

	it("第一名總分較高但動能輸對手：僅劣勢列動能弱，優勢不出現動能較強", () => {
		const leader: EtfRankedRow = {
			symbol: "0056.TW",
			name: "L",
			tradeDate: "20250327",
			close: 100,
			pctChange: 0.001,
			volume: 2_000_000,
			source: "t",
			usableForRanking: true,
			normalizationNote: "ok",
			score: 80,
			rank: 1,
			scoreBreakdownZh: "",
			scoreParts: { completeness: 15, trend: 0.08, volPts: 8, align: 0 },
		};
		const other: EtfRankedRow = {
			symbol: "00878.TW",
			name: "O",
			tradeDate: "20250327",
			close: 100,
			pctChange: 0.02,
			volume: 100_000,
			source: "t",
			usableForRanking: true,
			normalizationNote: "ok",
			score: 68,
			rank: 2,
			scoreBreakdownZh: "",
			scoreParts: { completeness: 15, trend: 1.6, volPts: 1, align: 0 },
		};
		const d = compareTopCandidates([leader, other], 3, null);
		const comp = d?.comparisons[0];
		expect(comp).toBeDefined();
		expect(comp?.disadvantages).toContain(etfDeltaTrendDisadvantageZh());
		expect(comp?.advantages.includes(etfDeltaTrendAdvantageZh())).toBe(false);
		assertPairwiseConsistency(comp!);
	});

	it("細項在門檻內視為相同、總分略高：優勢為「整體差距不大…」且劣勢為無明顯弱項", () => {
		const parts = { completeness: 15, trend: 0.8, volPts: 8, align: 0 };
		const leader: EtfRankedRow = {
			symbol: "AAA.TW",
			name: "A",
			tradeDate: "20250327",
			close: 100,
			pctChange: 0.01,
			volume: 2_000_000,
			source: "t",
			usableForRanking: true,
			normalizationNote: "ok",
			score: 81,
			rank: 1,
			scoreBreakdownZh: "",
			scoreParts: parts,
		};
		const other: EtfRankedRow = {
			symbol: "ZZZ.TW",
			name: "Z",
			tradeDate: "20250327",
			close: 100,
			pctChange: 0.01,
			volume: 2_000_000,
			source: "t",
			usableForRanking: true,
			normalizationNote: "ok",
			score: 80,
			rank: 2,
			scoreBreakdownZh: "",
			scoreParts: parts,
		};
		const d = compareTopCandidates([leader, other], 3, null);
		const comp = d?.comparisons[0];
		expect(comp?.advantages).toEqual([etfDeltaOverallNarrowMarginZh()]);
		expect(comp?.disadvantages).toEqual([]);
		const body = formatEtfDeltaExplainBodyZh(d!);
		expect(body).toContain(etfDeltaOverallNarrowMarginZh());
		expect(body).toContain(etfDeltaNoClearWeaknessZh());
	});

	it("單一 comparison：優／劣集合無交集、語句不重複", () => {
		const ranked = rankEtfCandidates(
			[
				cand("0056", 0.02, 2_500_000),
				cand("00713", 0.01, 800_000),
				cand("00878", -0.005, 400_000),
			],
			0.01
		);
		const d = compareTopCandidates(ranked, 3, 0.01);
		for (const comp of d?.comparisons ?? []) {
			assertPairwiseConsistency(comp);
		}
	});

	it("僅一檔：comparisons 為空", () => {
		const ranked = rankEtfCandidates([cand("0056", 0.01, 2_000_000)], null);
		const d = compareTopCandidates(ranked, 3, null);
		expect(d?.leader).toBe("0056");
		expect(d?.comparisons).toEqual([]);
	});

	it("分數極接近且細項相同：同分排序句", () => {
		const a = cand("ZZZ", 0.01, 2_000_000);
		const b = cand("AAA", 0.01, 2_000_000);
		const ranked = rankEtfCandidates([a, b], null);
		expect(ranked[0]?.score).toBe(ranked[1]?.score);
		const d = compareTopCandidates(ranked, 3, null);
		expect(d?.comparisons[0]?.advantages.length).toBeGreaterThan(0);
	});
});

describe("ETF delta explain — humanSummaryZh 節錄（黑盒／報告用）", () => {
	it("三檔實際排版：相較第2／第3 名區塊皆無動能矛盾句", () => {
		const ranked = rankEtfCandidates(
			[
				cand("0056", 0.02, 2_500_000),
				cand("00713", 0.01, 800_000),
				cand("00878", -0.005, 400_000),
			],
			0.01
		);
		const delta = compareTopCandidates(ranked, 3, 0.01);
		const body = formatEtfDeltaExplainBodyZh(delta!);
		expect(body).toMatch(/^目前候選中，0056 排名第一。\n\n相較 00713：/u);
		expect(body).toContain("相較 00878：");
		assertNoMomentumContradictionInFormattedBody(body);
	});
});
