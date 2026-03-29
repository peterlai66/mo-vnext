import { formatIsoToTaipeiDateTime } from "./taipei-time.js";
import type { TodayApiResponse } from "./today-types.js";
import {
	recommendationConfidenceLabelZh,
	recommendationStanceLabelZh,
	tradeDateYyyymmddToLabelZh,
} from "./today-display-zh.js";

/**
 * Web 整合用 Today 回應：內部數值欄位可銜接 mo_live；**display** 供正式 UI 只顯示人話欄位。
 */
export function buildTodayApiStubResponse(nowMs: number = Date.now()): TodayApiResponse {
	const generatedAt = new Date(nowMs).toISOString();
	const tradeDate = "20260328";
	const headlineZh = "今日投資建議重點";
	const summaryZh =
		"綜合目前可得之市場與治理狀態，建議以「穩健觀察」為主：先釐清自身資金與風險承受度，再決定是否調整部位；若環境快速變化，請優先確認資料時效與自身限制。";
	return {
		ok: true,
		generatedAt,
		data: {
			tradeDate,
			market: {
				source: "stub_twse_mi_index",
				summaryText:
					"大盤與相關指標顯示近期走勢仍可追蹤；實際操作請依自身資金與風險承受度，並留意盤中變化。",
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
				headline: headlineZh,
				summary: summaryZh,
				display: {
					headlineZh,
					summaryZh,
					stanceLabelZh: recommendationStanceLabelZh("observe_only"),
					confidenceLabelZh: recommendationConfidenceLabelZh("medium"),
				},
			},
			report: {
				available: true,
				headline: "報告區塊",
			},
			notifications: {
				unreadCount: 0,
			},
			display: {
				generatedAtTaipei: formatIsoToTaipeiDateTime(generatedAt),
				tradeDateLabelZh: tradeDateYyyymmddToLabelZh(tradeDate),
			},
		},
	};
}
