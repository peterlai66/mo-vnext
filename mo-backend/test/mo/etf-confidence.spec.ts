import { describe, it, expect } from "vitest";
import {
	deriveEtfConfidenceLevel,
	etfConfidenceAppendZh,
	etfConfidenceLineZh,
} from "../../src/mo/recommendation/etf-public-facts.js";

describe("ETF Recommendation Confidence v3（白盒）", () => {
	it("observe_only + 有排名 → observe", () => {
		expect(
			deriveEtfConfidenceLevel({
				recommendationMode: "observe_only",
				etfGate: "ranked_candidate_ready",
				hasNamedRankedEtf: true,
				leaderVsSecondScoreGap: 5,
			})
		).toBe("observe");
		expect(etfConfidenceLineZh("observe")).toContain("觀察為主");
	});

	it("observe_only + 無候選／未就緒 → weak_observe", () => {
		expect(
			deriveEtfConfidenceLevel({
				recommendationMode: "observe_only",
				etfGate: "insufficient_data",
				hasNamedRankedEtf: false,
				leaderVsSecondScoreGap: null,
			})
		).toBe("weak_observe");
	});

	it("actionable + 有排名 + 分差夠大 → ready", () => {
		expect(
			deriveEtfConfidenceLevel({
				recommendationMode: "actionable",
				etfGate: "ranked_candidate_ready",
				hasNamedRankedEtf: true,
				leaderVsSecondScoreGap: 5,
			})
		).toBe("ready");
		expect(etfConfidenceLineZh("ready")).toContain("進場");
	});

	it("actionable + 有排名 + 分差小 → neutral", () => {
		expect(
			deriveEtfConfidenceLevel({
				recommendationMode: "actionable",
				etfGate: "ranked_candidate_ready",
				hasNamedRankedEtf: true,
				leaderVsSecondScoreGap: 1,
			})
		).toBe("neutral");
	});

	it("append 僅一句且不為空", () => {
		const line = etfConfidenceAppendZh({
			recommendationMode: "observe_only",
			etfGate: "ranked_candidate_ready",
			hasNamedRankedEtf: true,
			leaderVsSecondScoreGap: 2,
		});
		expect(line.length).toBeGreaterThan(10);
		expect(line).not.toContain("\n");
	});
});
