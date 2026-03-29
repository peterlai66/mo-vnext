import { describe, it, expect } from "vitest";
import { normalizeEtfRawRow, normalizeEtfRawRows } from "../../src/mo/recommendation/etf-normalize.js";
import { resolveEtfCandidateGate } from "../../src/mo/recommendation/etf-gate.js";
import { rankEtfCandidates, scoreEtfCandidate } from "../../src/mo/recommendation/etf-rank.js";
import type { EtfRawLoaderRow } from "../../src/mo/recommendation/etf-types.js";

function rawRow(
	p: Partial<EtfRawLoaderRow> & Pick<EtfRawLoaderRow, "universeId">
): EtfRawLoaderRow {
	return {
		displayName: "",
		tradeDate: null,
		close: null,
		previousClose: null,
		volume: null,
		source: "finmind_test",
		fetchOk: true,
		fetchNote: "",
		...p,
	};
}

describe("ETF Candidate Universe v1 — normalization (loader row → 統一結構)", () => {
	it("完整列：可排名、欄位落位", () => {
		const r = rawRow({
			universeId: "0050",
			displayName: "元大台灣50",
			tradeDate: "20250327",
			close: 100,
			previousClose: 99,
			volume: 1_000_000,
		});
		const n = normalizeEtfRawRow(r);
		expect(n.usableForRanking).toBe(true);
		expect(n.symbol).toBe("0050.TW");
		expect(n.name).toBe("元大台灣50");
		expect(n.close).toBe(100);
		expect(n.tradeDate).toBe("20250327");
		expect(n.normalizationNote).toBe("ok");
	});

	it("缺 name（displayName 空）：以 symbol 代稱，仍可排名", () => {
		const n = normalizeEtfRawRow(
			rawRow({
				universeId: "0050",
				displayName: "",
				tradeDate: "20250327",
				close: 10,
				previousClose: 9,
			})
		);
		expect(n.name).toBe("0050.TW");
		expect(n.usableForRanking).toBe(true);
	});

	it("缺 close：不可排名", () => {
		const n = normalizeEtfRawRow(
			rawRow({
				universeId: "0050",
				tradeDate: "20250327",
				close: null,
				previousClose: 10,
			})
		);
		expect(n.usableForRanking).toBe(false);
		expect(n.normalizationNote).toMatch(/close/iu);
	});

	it("universeId 空字串：視為缺有效代號語意，close/tradeDate 仍決定可用性", () => {
		const n = normalizeEtfRawRow(
			rawRow({
				universeId: "",
				tradeDate: "20250327",
				close: 10,
				previousClose: 9,
			})
		);
		expect(n.symbol).toBe(".TW");
		expect(n.usableForRanking).toBe(true);
	});

	it("fetch 失敗：不可排名", () => {
		const n = normalizeEtfRawRow(
			rawRow({
				universeId: "0050",
				fetchOk: false,
				fetchNote: "http_error",
				tradeDate: "20250327",
				close: 10,
			})
		);
		expect(n.usableForRanking).toBe(false);
		expect(n.normalizationNote).toMatch(/fetch failed/iu);
	});

	it("多列 normalizeEtfRawRows 結構一致", () => {
		const rows = [
			rawRow({
				universeId: "0050",
				displayName: "A",
				tradeDate: "20250327",
				close: 1,
				previousClose: 1,
			}),
			rawRow({ universeId: "0056", fetchOk: false, fetchNote: "x" }),
		];
		const out = normalizeEtfRawRows(rows);
		expect(out).toHaveLength(2);
		expect(out[0]?.usableForRanking).toBe(true);
		expect(out[1]?.usableForRanking).toBe(false);
	});
});

describe("ETF Candidate Universe v1 — gate", () => {
	it("無任何 raw → no_candidate", () => {
		expect(resolveEtfCandidateGate([], [])).toBe("no_candidate");
	});

	it("有列但皆不可排名 → insufficient_data", () => {
		const r = [rawRow({ universeId: "0050", fetchOk: false, fetchNote: "fail" })];
		const n = normalizeEtfRawRows(r);
		expect(resolveEtfCandidateGate(r, n)).toBe("insufficient_data");
	});

	it("至少一檔可排名 → ranked_candidate_ready", () => {
		const r = [
			rawRow({
				universeId: "0050",
				displayName: "OK",
				tradeDate: "20250327",
				close: 100,
				previousClose: 99,
			}),
			rawRow({ universeId: "0056", fetchOk: false, fetchNote: "fail" }),
		];
		const n = normalizeEtfRawRows(r);
		expect(resolveEtfCandidateGate(r, n)).toBe("ranked_candidate_ready");
	});
});

describe("ETF Candidate Universe v1 — ranking", () => {
	it("不完整候選：scoreEtfCandidate 為 0", () => {
		const bad = normalizeEtfRawRow(rawRow({ universeId: "X", fetchOk: false, fetchNote: "x" }));
		expect(scoreEtfCandidate(bad, null).score).toBe(0);
	});

	it("2～3 檔可排名：分數有高低、排序穩定（僅送 usable 進 rank）", () => {
		const hi = normalizeEtfRawRow(
			rawRow({
				universeId: "AAA",
				displayName: "高報酬",
				tradeDate: "20250327",
				close: 110,
				previousClose: 100,
				volume: 3_000_000,
			})
		);
		const mid = normalizeEtfRawRow(
			rawRow({
				universeId: "BBB",
				displayName: "中報酬",
				tradeDate: "20250327",
				close: 105,
				previousClose: 100,
				volume: 3_000_000,
			})
		);
		const lo = normalizeEtfRawRow(
			rawRow({
				universeId: "CCC",
				displayName: "低報酬",
				tradeDate: "20250327",
				close: 101,
				previousClose: 100,
				volume: 100_000,
			})
		);
		const ranked = rankEtfCandidates([hi, mid, lo], 0.01);
		expect(ranked).toHaveLength(3);
		expect(ranked[0]?.symbol).toBe("AAA.TW");
		expect(ranked[0]?.score).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0);
		expect(ranked[1]?.score).toBeGreaterThanOrEqual(ranked[2]?.score ?? 0);
		const scores = new Set(ranked.map((x) => x.score));
		expect(scores.size).toBeGreaterThanOrEqual(2);
	});

	it("重跑同輸入：順序可重現", () => {
		const u = normalizeEtfRawRow(
			rawRow({
				universeId: "0050",
				tradeDate: "20250327",
				close: 100,
				previousClose: 99,
				volume: 1_000_000,
			})
		);
		const v = normalizeEtfRawRow(
			rawRow({
				universeId: "0056",
				tradeDate: "20250327",
				close: 100,
				previousClose: 99,
				volume: 1_000_000,
			})
		);
		const a = rankEtfCandidates([u, v], null).map((r) => r.symbol);
		const b = rankEtfCandidates([u, v], null).map((r) => r.symbol);
		expect(a).toEqual(b);
	});
});
