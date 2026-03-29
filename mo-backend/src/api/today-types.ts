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

export interface TodayApiRecommendationBlock {
	mode: TodayApiRecommendationMode;
	confidence: TodayApiConfidenceLabel;
	headline: string;
	summary: string;
}

export interface TodayApiReportBlock {
	available: boolean;
	headline: string;
}

export interface TodayApiNotificationsBlock {
	unreadCount: number;
}

export interface TodayApiData {
	tradeDate: string;
	market: TodayApiMarketBlock;
	governance: TodayApiGovernanceBlock;
	recommendation: TodayApiRecommendationBlock;
	report: TodayApiReportBlock;
	notifications: TodayApiNotificationsBlock;
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
