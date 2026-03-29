import type { EtfNormalizedCandidate, EtfRankedRow } from "./etf-types.js";

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/**
 * ETF v1 可解釋評分（最小可行）：
 * - 資料完整度：pctChange 可得 +10，volume 可得 +5
 * - 報酬方向：pctChange × 80，範圍約 [-20, 20]（以小數報酬率代入，例如 0.01 = 1%）
 * - 成交量：≥200 萬 +8；≥50 萬 +4；其餘 +1
 * - 大盤相容（可選）：若提供 indexDailyPct，與 ETF 同日報酬同號 +6，反號 -4；未提供則 0
 */
export function scoreEtfCandidate(
	c: EtfNormalizedCandidate,
	indexDailyPct: number | null
): { score: number; breakdownZh: string } {
	if (!c.usableForRanking) {
		return { score: 0, breakdownZh: "不可排名（資料不足）" };
	}

	let completeness = 0;
	if (c.pctChange !== null) completeness += 10;
	if (c.volume !== null && c.volume > 0) completeness += 5;

	let trend = 0;
	if (c.pctChange !== null) {
		trend = clamp(c.pctChange * 80, -20, 20);
	}

	let volPts = 1;
	if (c.volume !== null) {
		if (c.volume >= 2_000_000) volPts = 8;
		else if (c.volume >= 500_000) volPts = 4;
	}

	let align = 0;
	if (indexDailyPct !== null && c.pctChange !== null) {
		const same = c.pctChange * indexDailyPct >= 0;
		align = same ? 6 : -4;
	}

	const score = Math.round(50 + completeness + trend + volPts + align);
	const breakdownZh = `完整度+${String(completeness)}、報酬趨勢+${String(
		Math.round(trend * 10) / 10
	)}、量能+${String(volPts)}、大盤相容+${String(align)}；基準50 → 合計${String(score)}`;
	return { score, breakdownZh };
}

export function rankEtfCandidates(
	usable: readonly EtfNormalizedCandidate[],
	indexDailyPct: number | null
): EtfRankedRow[] {
	const scored = usable.map((c) => {
		const { score, breakdownZh } = scoreEtfCandidate(c, indexDailyPct);
		return { c, score, breakdownZh };
	});
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.c.symbol.localeCompare(b.c.symbol);
	});
	return scored.map((s, idx) => ({
		...s.c,
		score: s.score,
		rank: idx + 1,
		scoreBreakdownZh: s.breakdownZh,
	}));
}
