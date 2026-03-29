import type { IntentParseResult } from "./input.js";
import { etfCandidateGateLabelZh } from "./recommendation/etf-gate.js";
import type { RecommendationOutput } from "./recommendation-output.js";

/** 上一則 LINE 助理分支（與 index 之 LineAssistantReplyKind 對齊，避免循環依賴） */
export type LastAssistantReplyKindForTiming =
	| "recommendation"
	| "report"
	| "status"
	| "none";

/**
 * 辨識「進場／買入／佈局時機」類短問（繁中常見說法）。
 * 僅應在 lastAssistantReplyKind === recommendation 時與覆寫邏輯併用，避免誤判獨立首輪對話。
 */
export function isRecommendationAskTimingZhMessage(text: string): boolean {
	const t = text.trim();
	if (t === "") return false;
	const patterns: RegExp[] = [
		/現在\s*適合\s*進場/u,
		/目前\s*適合\s*進場/u,
		/現在\s*適合\s*買/u,
		/目前\s*適合\s*買/u,
		/現在\s*可以\s*進場/u,
		/現在\s*可以\s*買/u,
		/這\s*時\s*候\s*適合\s*佈局/u,
		/這時候\s*適合\s*佈局/u,
		/現在\s*適合\s*佈局/u,
		/目前\s*適合\s*佈局/u,
		/該不該\s*現在\s*進/u,
		/要不要\s*現在\s*進/u,
	];
	return patterns.some((p) => p.test(t));
}

/**
 * 當上一則為 recommendation 且使用者為進場時機短問時，強制 intent=recommendation、followUpIntent=ask_timing，
 * 避免模型誤判為 status（整份 MO Status）。
 */
export function applyRecommendationAskTimingIntentOverride(
	lastAssistantReplyKind: LastAssistantReplyKindForTiming,
	userText: string,
	intent: IntentParseResult
): IntentParseResult {
	if (lastAssistantReplyKind !== "recommendation") return intent;
	if (!isRecommendationAskTimingZhMessage(userText)) return intent;
	if (intent.intent === "recommendation" && intent.followUpIntent === "ask_timing") {
		return intent;
	}
	return {
		...intent,
		intent: "recommendation",
		followUpIntent: "ask_timing",
	};
}

/** 與 index 內 RecommendationExplainableSummaryPack 對齊之最小欄位（供 fallback 組字） */
export type AskTimingReplyPack = {
	recommendationMode: "actionable" | "actionable_with_caution" | "observe_only" | "blocked";
	blockedBy: "none" | "score" | "governance" | "readiness" | "no_candidate";
	primaryReason: string;
	candidateSummary: string;
	riskNote: string;
};

function buildShortDiagnosticAlignmentZhForTiming(pack: AskTimingReplyPack): string {
	if (pack.recommendationMode === "observe_only" && pack.blockedBy === "score") {
		return "與系統判定一致：未達放行主因為綜合分數未達門檻；模擬驗證為額外風險提醒，非本次阻擋理由。";
	}
	if (pack.recommendationMode === "actionable_with_caution") {
		return "與系統判定一致：分數與資料條件已達可留意範圍；模擬未完成僅作保守提醒，不作為主要阻擋理由。";
	}
	return "";
}

/**
 * ask_timing：AI 渲染失敗時的繁中 fallback，語意對齊 gate／候選／ETF 摘要，避免被誤解為整份市場狀態。
 */
export function composeAskTimingFollowUpReplyZh(
	pack: AskTimingReplyPack,
	etfCandidateContext: RecommendationOutput["etfCandidateContext"]
): string {
	const modeLine =
		pack.recommendationMode === "observe_only"
			? "【進場時機】目前模式為先觀察。"
			: pack.recommendationMode === "blocked"
				? "【進場時機】目前尚不具備對外建議條件。"
				: pack.recommendationMode === "actionable_with_caution"
					? "【進場時機】條件偏向可留意但仍偏保守。"
					: "【進場時機】條件上可留意配置節奏（仍非下單指令）。";

	const conclusion =
		pack.recommendationMode === "observe_only" && pack.blockedBy === "score"
			? "結論：現在不適合積極進場；主因是綜合分數尚未達放行門檻，候選僅供觀察。"
			: pack.recommendationMode === "observe_only"
				? "結論：現階段偏先觀察，不宜視為進場信號；主因請以下方說明為準。"
				: pack.recommendationMode === "blocked"
					? "結論：不宜依此進場；請待條件改善。"
					: pack.recommendationMode === "actionable_with_caution"
						? "結論：若仍要進場，請保守、控管部位；模擬提醒僅作參考，非唯一主因。"
						: "結論：若考慮進場，請自行控管風險；本訊息非交易指令。";

	const etfLine =
		etfCandidateContext !== undefined
			? `台股 ETF 候選：${etfCandidateGateLabelZh(etfCandidateContext.gate)}。${etfCandidateContext.humanSummaryZh}`
			: "本輪未附帶台股 ETF 候選摘要。";

	const align = buildShortDiagnosticAlignmentZhForTiming(pack);

	return [
		modeLine,
		conclusion,
		`說明：${pack.primaryReason}`,
		`候選／標的脈絡：${pack.candidateSummary}`,
		etfLine,
		`風險與其他提醒：${pack.riskNote}`,
		...(align === "" ? [] : [align]),
	].join("\n");
}
