import type { TodayApiResponse } from "./today-types.js";

/**
 * Web Integration v1 stub：固定欄位與型別，下一輪可改為組裝 mo_live / governance / recommendation / report。
 */
export function buildTodayApiStubResponse(nowMs: number = Date.now()): TodayApiResponse {
	const generatedAt = new Date(nowMs).toISOString();
	return {
		ok: true,
		generatedAt,
		data: {
			tradeDate: "20260328",
			market: {
				source: "stub_twse_mi_index",
				summaryText:
					"（Stub）Today API：市場摘要欄位已預留；下一輪改接 mo_live／治理推導之摘要，Web 不自行重算。",
				indexDailyPct: 0.12,
				freshnessMinutes: 15,
				stalenessLevel: "fresh",
			},
			governance: {
				decisionEligible: true,
				dataUsability: "decision_ok",
				pushEligible: false,
			},
			recommendation: {
				mode: "observe_only",
				confidence: "medium",
				headline: "（Stub）建議標題",
				summary:
					"（Stub）說明：實際 recommendationMode／confidence 由後端 pipeline 與治理輸出；此處僅供 Today 頁版位與型別驗證。",
			},
			report: {
				available: true,
				headline: "（Stub）報告區塊",
			},
			notifications: {
				unreadCount: 0,
			},
		},
	};
}
