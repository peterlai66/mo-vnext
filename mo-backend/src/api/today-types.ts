import type { MoLiveDataUsability, MoLiveStalenessLevel } from "../mo/governance.js";

/**
 * Today API v1 成功回應之穩定 shape（mo-web Today 頁直接 consume；後端為唯一真相來源）。
 * recommendation.mode 語意與既有 recommendationMode 對齊。
 */
export type TodayApiRecommendationMode =
	| "actionable"
	| "actionable_with_caution"
	| "observe_only"
	| "blocked";

/** 與治理／仲裁語彙常見取值對齊（字串標籤，非前端自行推導） */
export type TodayApiConfidenceLabel = "high" | "medium" | "low";

export interface TodayApiMarketBlock {
	source: string;
	summaryText: string;
	indexDailyPct: number | null;
	freshnessMinutes: number | null;
	stalenessLevel: MoLiveStalenessLevel;
}

export interface TodayApiGovernanceBlock {
	decisionEligible: boolean;
	dataUsability: MoLiveDataUsability;
	pushEligible: boolean;
}

/** Web 顯示用（人話標籤；內部 mode／confidence 仍保留於同層供除錯） */
export interface TodayApiRecommendationDisplay {
	headlineZh: string;
	summaryZh: string;
	/** 投資立場／策略語氣（取代直接顯示 mode enum） */
	stanceLabelZh: string;
	/** 信心／不確定性說明（取代直接顯示 confidence enum） */
	confidenceLabelZh: string;
}

export interface TodayApiRecommendationBlock {
	mode: TodayApiRecommendationMode;
	confidence: TodayApiConfidenceLabel;
	headline: string;
	summary: string;
	display: TodayApiRecommendationDisplay;
}

export interface TodayApiReportBlock {
	available: boolean;
	headline: string;
}

export interface TodayApiNotificationsBlock {
	unreadCount: number;
}

export interface TodayApiDisplay {
	/** 資料產出時間（台灣時區可讀字串） */
	generatedAtTaipei: string;
	/** 交易日人話標示 */
	tradeDateLabelZh: string;
}

export interface TodayApiData {
	tradeDate: string;
	market: TodayApiMarketBlock;
	governance: TodayApiGovernanceBlock;
	recommendation: TodayApiRecommendationBlock;
	report: TodayApiReportBlock;
	notifications: TodayApiNotificationsBlock;
	/** Web 專用：時間與日期顯示 */
	display: TodayApiDisplay;
}

export interface TodayApiResponse {
	ok: boolean;
	generatedAt: string;
	data: TodayApiData;
}

export interface TodayApiErrorBody {
	ok: false;
	error: string;
	/** 方法不允許時列出允許的 HTTP 方法 */
	allowedMethods?: readonly string[];
	/** 內部錯誤時可選說明（不暴露 stack） */
	message?: string;
	generatedAt?: string;
}
