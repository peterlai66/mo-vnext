import type { EtfRankedRow } from "./etf-types.js";
import {
	etfDeltaAlignAdvantageZh,
	etfDeltaAlignDisadvantageZh,
	etfDeltaCompletenessAdvantageZh,
	etfDeltaCompletenessDisadvantageZh,
	etfDeltaOverallNarrowMarginZh,
	etfDeltaTieScoreSortZh,
	etfDeltaTrendAdvantageZh,
	etfDeltaTrendDisadvantageZh,
	etfDeltaVolumeAdvantageZh,
	etfDeltaVolumeDisadvantageZh,
	type EtfDeltaComparisonZh,
	type EtfDeltaExplainBlockZh,
} from "./etf-public-facts.js";

const TREND_EPS = 0.05;

/** 內部比較維度（對應 scoreParts／gate 公式，不含未建模之 yield／volatility 欄位） */
type EtfDeltaDimension = "completeness" | "momentum" | "liquidity" | "indexAlignment";

function tickerFromRow(r: EtfRankedRow): string {
	const s = r.symbol.trim();
	return s.endsWith(".TW") ? s.slice(0, -3) : s;
}

export function dedupeDeltaPhrasesZh(phrases: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const p of phrases) {
		if (!seen.has(p)) {
			seen.add(p);
			out.push(p);
		}
	}
	return out;
}

function phraseForDimension(
	dim: EtfDeltaDimension,
	side: "leader" | "other"
): string {
	if (dim === "completeness") {
		return side === "leader" ?
				etfDeltaCompletenessAdvantageZh()
			:	etfDeltaCompletenessDisadvantageZh();
	}
	if (dim === "momentum") {
		return side === "leader" ?
				etfDeltaTrendAdvantageZh()
			:	etfDeltaTrendDisadvantageZh();
	}
	if (dim === "liquidity") {
		return side === "leader" ?
				etfDeltaVolumeAdvantageZh()
			:	etfDeltaVolumeDisadvantageZh();
	}
	return side === "leader" ? etfDeltaAlignAdvantageZh() : etfDeltaAlignDisadvantageZh();
}

function winnerForDimension(
	dim: EtfDeltaDimension,
	leader: EtfRankedRow,
	other: EtfRankedRow,
	indexDailyPct: number | null
): "leader" | "other" | "neutral" {
	const a = leader.scoreParts;
	const b = other.scoreParts;
	if (dim === "completeness") {
		if (a.completeness > b.completeness) return "leader";
		if (b.completeness > a.completeness) return "other";
		return "neutral";
	}
	if (dim === "momentum") {
		const d = a.trend - b.trend;
		if (d > TREND_EPS) return "leader";
		if (d < -TREND_EPS) return "other";
		return "neutral";
	}
	if (dim === "liquidity") {
		if (a.volPts > b.volPts) return "leader";
		if (b.volPts > a.volPts) return "other";
		return "neutral";
	}
	if (indexDailyPct === null || leader.pctChange === null || other.pctChange === null) {
		return "neutral";
	}
	if (a.align > b.align) return "leader";
	if (b.align > a.align) return "other";
	return "neutral";
}

function compareLeaderToOther(
	leader: EtfRankedRow,
	other: EtfRankedRow,
	indexDailyPct: number | null
): { advantages: string[]; disadvantages: string[] } {
	const dims: EtfDeltaDimension[] = ["completeness", "momentum", "liquidity", "indexAlignment"];
	const advRaw: string[] = [];
	const disRaw: string[] = [];

	for (const dim of dims) {
		const w = winnerForDimension(dim, leader, other, indexDailyPct);
		if (w === "leader") advRaw.push(phraseForDimension(dim, "leader"));
		else if (w === "other") disRaw.push(phraseForDimension(dim, "other"));
	}

	let advantages = dedupeDeltaPhrasesZh(advRaw);
	let disadvantages = dedupeDeltaPhrasesZh(disRaw);

	advantages = advantages.filter((x) => x.length > 0);
	disadvantages = disadvantages.filter((x) => !advantages.includes(x));

	if (advantages.length === 0 && disadvantages.length === 0) {
		if (leader.score === other.score) {
			advantages.push(etfDeltaTieScoreSortZh());
		} else {
			advantages.push(etfDeltaOverallNarrowMarginZh());
		}
	} else if (advantages.length === 0 && disadvantages.length > 0 && leader.score > other.score) {
		advantages.push(etfDeltaOverallNarrowMarginZh());
	}

	return { advantages, disadvantages };
}

/**
 * 以既有排名列與分項（scoreParts）產出第一名與其餘前 N 名之差異說明；不改變分數與排序。
 */
export function compareTopCandidates(
	ranked: readonly EtfRankedRow[],
	topN: number,
	indexDailyPct: number | null
): EtfDeltaExplainBlockZh | null {
	if (ranked.length === 0) {
		return null;
	}
	const leaderRow = ranked[0];
	const leader = tickerFromRow(leaderRow);
	const comparisons: EtfDeltaComparisonZh[] = [];
	const cap = Math.min(Math.max(1, topN), ranked.length);
	for (let i = 1; i < cap; i++) {
		const otherRow = ranked[i];
		const { advantages, disadvantages } = compareLeaderToOther(
			leaderRow,
			otherRow,
			indexDailyPct
		);
		comparisons.push({
			against: tickerFromRow(otherRow),
			advantages,
			disadvantages,
		});
	}
	return { leader, comparisons };
}
