import { describe, it, expect } from "vitest";
import {
	applyRecommendationAskTimingIntentOverride,
	composeAskTimingFollowUpReplyZh,
	isRecommendationAskTimingZhMessage,
} from "../../src/mo/recommendation-follow-up-timing.js";
import type { IntentParseResult } from "../../src/mo/input.js";

function baseIntent(overrides: Partial<IntentParseResult> = {}): IntentParseResult {
	return {
		intent: "status",
		userId: "u1",
		context: { hasPortfolio: true, riskPreference: "normal" },
		options: { mode: "latest" },
		followUpIntent: "none",
		...overrides,
	};
}

describe("recommendation follow-up ask_timing (zh)", () => {
	describe("isRecommendationAskTimingZhMessage（白盒）", () => {
		const timingCases = [
			"現在適合進場嗎？",
			"現在適合買嗎",
			"現在可以進場嗎？",
			"這時候適合佈局嗎？",
			"目前適合進場嗎",
		];
		it.each(timingCases)("timing: %s → true", (q) => {
			expect(isRecommendationAskTimingZhMessage(q)).toBe(true);
		});

		const nonTiming = [
			"為什麼推薦這些 ETF？",
			"風險是什麼？",
			"現在狀態如何",
			"市場狀態",
			"給我完整報告",
		];
		it.each(nonTiming)("non-timing: %s → false", (q) => {
			expect(isRecommendationAskTimingZhMessage(q)).toBe(false);
		});
	});

	describe("applyRecommendationAskTimingIntentOverride（白盒／灰盒分支）", () => {
		it("上一則 recommendation + 進場問句：status 覆寫為 recommendation + ask_timing", () => {
			const out = applyRecommendationAskTimingIntentOverride(
				"recommendation",
				"現在適合進場嗎？",
				baseIntent({ intent: "status", followUpIntent: "none" })
			);
			expect(out.intent).toBe("recommendation");
			expect(out.followUpIntent).toBe("ask_timing");
		});

		it("上一則非 recommendation：不覆寫", () => {
			const in_ = baseIntent({ intent: "status" });
			expect(
				applyRecommendationAskTimingIntentOverride("none", "現在適合進場嗎？", in_)
			).toEqual(in_);
			expect(
				applyRecommendationAskTimingIntentOverride("status", "現在適合進場嗎？", in_)
			).toEqual(in_);
		});

		it("已正確 ask_timing 時不重複變更語意", () => {
			const in_ = baseIntent({ intent: "recommendation", followUpIntent: "ask_timing" });
			const out = applyRecommendationAskTimingIntentOverride(
				"recommendation",
				"現在適合進場嗎？",
				in_
			);
			expect(out).toEqual(in_);
		});
	});

	describe("composeAskTimingFollowUpReplyZh（黑盒／對話輸出形狀）", () => {
		it("observe_only + score：含進場結論、門檻主因、ETF 行、非市場 status 標題", () => {
			const text = composeAskTimingFollowUpReplyZh(
				{
					recommendationMode: "observe_only",
					blockedBy: "score",
					primaryReason: "目前先觀察：綜合分數 3 未達門檻 7；主因為分數／門檻不足。",
					candidateSummary: "可辨識候選：測試 ETF（0050.TW）；共 1 檔列入排序。",
					riskNote: "資料品質層級：ok。模擬驗證尚未完成，僅為風險提示。",
				},
				{ gate: "ranked_candidate_ready", humanSummaryZh: "有候選但未達放行，供觀察。" }
			);
			expect(text).toContain("【進場時機】");
			expect(text).toContain("現在不適合積極進場");
			expect(text).toContain("分數尚未達放行門檻");
			expect(text).toContain("台股 ETF 候選");
			expect(text).not.toMatch(/MO Status|\/status|市場狀態摘要/iu);
		});
	});
});
