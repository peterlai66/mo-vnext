import { describe, it, expect } from "vitest";
import {
	parseIndexDailyPctFromMoLivePayloadSummary,
	appendIndexDailyPctToLegacySummary,
	extractFinMindTaiexCloseSeries,
	computeIndexDailyPctFromFinMindSeries,
} from "../../src/mo/live-index-daily-pct.js";
import { scoreEtfCandidate } from "../../src/mo/recommendation/etf-rank.js";
import type { EtfNormalizedCandidate } from "../../src/mo/recommendation/etf-types.js";
import { formatMoStatusEtfIntegrationBlockZh } from "../../src/mo/recommendation/etf-public-facts.js";
import { composeAskTimingFollowUpReplyZh } from "../../src/mo/recommendation-follow-up-timing.js";

const usableEtf = (pct: number): EtfNormalizedCandidate => ({
	symbol: "0050.TW",
	name: "T",
	market: "TW",
	tradeDate: "20250327",
	close: 100,
	pctChange: pct,
	volume: 2_000_000,
	source: "t",
	usableForRanking: true,
	normalizationNote: "ok",
});

describe("ETF Integration v1.1 — indexDailyPct 解析（白盒）", () => {
	it("case A：legacySummary 含 indexDailyPct → parsed", () => {
		const ps = JSON.stringify({
			v: 2,
			source: "x",
			sourceLevel: "primary",
			fetchStatus: "success",
			confidence: "high",
			rawAvailabilityNote: "n",
			legacySummary: "finmind=TAIEX;date=20250327;close=100;indexDailyPct=0.01",
		});
		const r = parseIndexDailyPctFromMoLivePayloadSummary(ps);
		expect(r.kind).toBe("parsed");
		expect(r.value).toBe(0.01);
	});

	it("case B：缺 indexDailyPct → absent", () => {
		const ps = JSON.stringify({
			v: 2,
			source: "x",
			sourceLevel: "primary",
			fetchStatus: "success",
			confidence: "high",
			rawAvailabilityNote: "n",
			legacySummary: "date=20250327;close=100",
		});
		const r = parseIndexDailyPctFromMoLivePayloadSummary(ps);
		expect(r.kind).toBe("absent");
		expect(r.value).toBeNull();
	});

	it("case C：JSON 形狀錯誤 → invalid", () => {
		const r = parseIndexDailyPctFromMoLivePayloadSummary("{not valid json");
		expect(r.kind).toBe("invalid");
		expect(r.value).toBeNull();
	});

	it("appendIndexDailyPctToLegacySummary 可附加並避免重複 key 語意", () => {
		const a = appendIndexDailyPctToLegacySummary("a=1", 0.02);
		expect(a).toContain("indexDailyPct=0.02");
		const b = appendIndexDailyPctToLegacySummary(a, null);
		expect(b).not.toMatch(/indexDailyPct=0\.02/u);
	});
});

describe("ETF Integration v1.1 — FinMind 序列與日報酬（白盒）", () => {
	it("兩日收盤可算 indexDailyPct", () => {
		const parsed = {
			data: [
				{ date: "2025-03-26", close: 100 },
				{ date: "2025-03-27", close: 101 },
			],
		};
		const s = extractFinMindTaiexCloseSeries(parsed);
		const pct = computeIndexDailyPctFromFinMindSeries(s, "20250327");
		expect(pct).toBeCloseTo(0.01, 5);
	});
});

describe("ETF Integration v1.1 — ranking 大盤相容分（白盒）", () => {
	it("indexDailyPct 有值且同號：大盤相容 +6", () => {
		const c = usableEtf(0.01);
		const withIdx = scoreEtfCandidate(c, 0.01);
		const noIdx = scoreEtfCandidate(c, null);
		expect(withIdx.score - noIdx.score).toBe(6);
		expect(withIdx.breakdownZh).toContain("大盤相容+6");
	});

	it("indexDailyPct 無值：大盤相容 +0", () => {
		const c = usableEtf(0.01);
		const r = scoreEtfCandidate(c, null);
		expect(r.breakdownZh).toContain("大盤相容+0");
	});
});

describe("ETF Integration v1.1 — status ETF 摘要 mapping（白盒）", () => {
	it("ranked_candidate_ready + observe_only：不宣稱正式推薦", () => {
		const text = formatMoStatusEtfIntegrationBlockZh({
			govDataUnusable: false,
			precheckBlocked: false,
			precheckBlockNoteZh: "",
			etfGate: "ranked_candidate_ready",
			etfHumanSummaryZh: "【ETF】測試摘要",
			packMode: "observe_only",
			semanticCandidateOnly: true,
			indexMeta: { value: 0.01, kind: "parsed" },
		});
		expect(text).toContain("已產出可排名");
		expect(text).toContain("先觀察");
		expect(text).toContain("大盤當日報酬已納入");
	});

	it("insufficient_data：語意正確", () => {
		const text = formatMoStatusEtfIntegrationBlockZh({
			govDataUnusable: false,
			precheckBlocked: false,
			precheckBlockNoteZh: "",
			etfGate: "insufficient_data",
			etfHumanSummaryZh: "【ETF】不足",
			packMode: "observe_only",
			semanticCandidateOnly: true,
			indexMeta: { value: null, kind: "absent" },
		});
		expect(text).toContain("資料不足");
	});
});

describe("ETF Integration v1.1 — follow-up 不退回整份 status（白盒）", () => {
	it("timing fallback 仍為進場語意", () => {
		const t = composeAskTimingFollowUpReplyZh(
			{
				recommendationMode: "observe_only",
				blockedBy: "score",
				primaryReason: "分數未達門檻",
				candidateSummary: "候選概況",
				riskNote: "風險",
			},
			{ gate: "ranked_candidate_ready", humanSummaryZh: "ETF 摘要" }
		);
		expect(t).toContain("【進場時機】");
		expect(t).not.toMatch(/MO Status/iu);
	});
});
