import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as etfPipeline from "../../src/mo/recommendation/etf-pipeline.js";
import { buildMoStatusEtfIntegrationBlockZh } from "../../src/mo/status-etf-integration.js";
import type { MoLiveDataGovernance } from "../../src/mo/governance.js";

function baseGov(overrides: Partial<MoLiveDataGovernance> = {}): MoLiveDataGovernance {
	return {
		tradeDate: "20250327",
		source: "TWSE_MI_INDEX",
		sourceLevel: "primary",
		fetchStatus: "success",
		confidence: "high",
		rawAvailabilityNote: "n",
		legacySummary: "x",
		dataUsability: "decision_ok",
		stalenessLevel: "fresh",
		freshnessMinutes: 2,
		sourcePriority: 1,
		decisionEligible: true,
		pushEligible: true,
		displayFetchStatus: "success",
		liveFreshness: "ok",
		...overrides,
	};
}

const mockEtfResult: etfPipeline.MoEtfPipelineResult = {
	gate: "insufficient_data",
	loadResult: {
		source: "etf_universe",
		ready: false,
		candidateCount: 0,
		candidates: [],
		notes: ["t"],
	},
	ranked: [],
	humanSummaryZh: "【層級】\n【idx】\n【ETF 候選 v1】測試重用摘要",
	deltaExplain: null,
	listsNamedEtfCandidates: false,
};

describe("status ETF reuse (v1.2)", () => {
	beforeEach(() => {
		vi.spyOn(etfPipeline, "runMoEtfCandidatePipelineV1").mockResolvedValue(mockEtfResult);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuse：已有 pipeline 結果時不再次呼叫 runMoEtfCandidatePipelineV1", async () => {
		const spy = vi.mocked(etfPipeline.runMoEtfCandidatePipelineV1);
		const indexMeta = { value: 0.01, kind: "parsed" as const };
		await buildMoStatusEtfIntegrationBlockZh(
			{},
			{
				liveDataGovernance: baseGov(),
				livePayloadSummary: "{}",
				decisionTradeDateYyyymmdd: "20250327",
				recommendationExplainablePack: {
					recommendationMode: "observe_only",
					semanticCandidateOnly: true,
				},
			},
			{ indexMeta, etfPipelineResult: mockEtfResult }
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("fallback：未傳 reuse 時會呼叫 pipeline", async () => {
		const spy = vi.mocked(etfPipeline.runMoEtfCandidatePipelineV1);
		spy.mockClear();
		await buildMoStatusEtfIntegrationBlockZh(
			{},
			{
				liveDataGovernance: baseGov(),
				livePayloadSummary: JSON.stringify({
					v: 2,
					source: "s",
					sourceLevel: "primary",
					fetchStatus: "success",
					confidence: "high",
					rawAvailabilityNote: "n",
					legacySummary: "close=1",
				}),
				decisionTradeDateYyyymmdd: "20250327",
				recommendationExplainablePack: {
					recommendationMode: "observe_only",
					semanticCandidateOnly: true,
				},
			}
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("reuse 為 null（略過 pipeline）且 precheck 擋：不呼叫 pipeline", async () => {
		const spy = vi.mocked(etfPipeline.runMoEtfCandidatePipelineV1);
		await buildMoStatusEtfIntegrationBlockZh(
			{},
			{
				liveDataGovernance: baseGov({
					dataUsability: "display_only",
					decisionEligible: false,
				}),
				livePayloadSummary: null,
				decisionTradeDateYyyymmdd: "20250327",
				recommendationExplainablePack: {
					recommendationMode: "blocked",
					semanticCandidateOnly: true,
				},
			},
			{ indexMeta: { value: null, kind: "absent" }, etfPipelineResult: null }
		);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("etf indexDailyPct log 格式（白盒）", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parsed / absent / invalid 皆輸出固定欄位", async () => {
		const payloads: unknown[] = [];
		vi.spyOn(console, "log").mockImplementation((msg: unknown, payload?: unknown) => {
			if (msg === "[mo] etf indexDailyPct" && payload !== undefined) {
				payloads.push(payload);
			}
		});
		const { logMoEtfIndexDailyPctFromSnapshot, logMoEtfIndexDailyPctBeforeRanking } =
			await import("../../src/mo/etf-index-daily-pct-log.js");
		logMoEtfIndexDailyPctFromSnapshot({ value: 0.01, kind: "parsed" });
		logMoEtfIndexDailyPctFromSnapshot({ value: null, kind: "absent" });
		logMoEtfIndexDailyPctBeforeRanking({ value: null, kind: "invalid" });
		expect(payloads.length).toBe(3);
		for (const p of payloads) {
			expect(p).toEqual(
				expect.objectContaining({
					parsedKind: expect.any(String),
					source: expect.any(String),
				})
			);
			expect(p).toHaveProperty("value");
		}
		expect(payloads[0]).toEqual({
			value: 0.01,
			parsedKind: "parsed",
			source: "legacy",
		});
		expect(payloads[1]).toEqual({
			value: null,
			parsedKind: "absent",
			source: "fallback",
		});
		expect(payloads[2]).toEqual({
			value: null,
			parsedKind: "invalid",
			source: "ranking",
		});
	});
});
