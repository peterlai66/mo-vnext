/**
 * ETF 對外摘要與 gate 語意：status／report／recommendation 共用映射，避免各處各寫一套。
 */

import type { EtfCandidateGateState } from "./etf-types.js";
import type { IndexDailyPctParseResult } from "../live-index-daily-pct.js";

export type MoRecommendationModePublic =
	| "actionable"
	| "actionable_with_caution"
	| "observe_only"
	| "blocked";

export function indexDailyPctObservabilityZh(meta: IndexDailyPctParseResult): string {
	if (meta.kind === "parsed" && meta.value !== null) {
		return "大盤當日報酬已納入候選排序的「大盤相容」加減分。";
	}
	if (meta.kind === "invalid") {
		return "大盤當日報酬欄位異常，已略過「大盤相容」加減分（其餘排序照常）。";
	}
	return "未取得大盤當日報酬，「大盤相容」加減分為 0（其餘排序照常）。";
}

export function etfGateStatusLineZh(gate: EtfCandidateGateState): string {
	switch (gate) {
		case "ranked_candidate_ready":
			return "候選池狀態：已產出可排名 ETF（供觀察與排序，不代表整體建議已放行）。";
		case "insufficient_data":
			return "候選池狀態：資料不足，尚未形成可排名 ETF。";
		case "no_candidate":
			return "候選池狀態：無有效候選列。";
	}
}

function packOverallAlignmentLineZh(
	mode: MoRecommendationModePublic,
	semanticCandidateOnly: boolean
): string {
	if (mode === "observe_only") {
		return semanticCandidateOnly
			? "整體建議層級：先觀察。候選僅供研究排序，非正式推薦標的。"
			: "整體建議層級：先觀察。候選分數僅反映排序，與整體綜合分／放行門檻不同層級。";
	}
	if (mode === "blocked") {
		return "整體建議層級：尚不具備對外建議條件；候選列表僅供背景參考。";
	}
	if (mode === "actionable_with_caution") {
		return "整體建議層級：可留意但保守；候選排序與是否進場仍須對齊 gate 與自身風險控管。";
	}
	return "整體建議層級：條件上可留意；候選排序分與整體綜合分不同層級，請一併參考放行說明。";
}

/** status 用：簡短截取候選內文（保留首段標題與一行） */
export function truncateEtfHumanSummaryForStatus(zh: string, maxChars: number): string {
	const t = zh.trim();
	if (t.length <= maxChars) {
		return t;
	}
	const cut = t.slice(0, maxChars);
	const lastNl = cut.lastIndexOf("\n");
	if (lastNl > 40) {
		return `${cut.slice(0, lastNl).trim()}…`;
	}
	return `${cut.trim()}…`;
}

export function etfScoreLayerDisclaimerZh(): string {
	return "【層級說明】候選 ETF 分數僅供排序；整體是否放行依系統綜合分與建議 gate，兩者不同層級。";
}

export function formatMoStatusEtfIntegrationBlockZh(args: {
	govDataUnusable: boolean;
	precheckBlocked: boolean;
	precheckBlockNoteZh: string;
	etfGate: EtfCandidateGateState | null;
	etfHumanSummaryZh: string | null;
	packMode: MoRecommendationModePublic;
	semanticCandidateOnly: boolean;
	indexMeta: IndexDailyPctParseResult;
}): string {
	const lines: string[] = [];
	lines.push("【台股 ETF 候選（與建議層級對齊）】");
	if (args.govDataUnusable) {
		lines.push("行情資料不可用（治理判定），不載入候選摘要。");
		lines.push(indexDailyPctObservabilityZh(args.indexMeta));
		return lines.join("\n");
	}
	if (args.precheckBlocked) {
		lines.push(`建議前置未啟用：${args.precheckBlockNoteZh}`);
		lines.push(indexDailyPctObservabilityZh(args.indexMeta));
		lines.push(packOverallAlignmentLineZh(args.packMode, args.semanticCandidateOnly));
		return lines.join("\n");
	}
	if (args.etfGate === null || args.etfHumanSummaryZh === null) {
		lines.push("候選資料暫未載入。");
		lines.push(indexDailyPctObservabilityZh(args.indexMeta));
		lines.push(packOverallAlignmentLineZh(args.packMode, args.semanticCandidateOnly));
		return lines.join("\n");
	}
	lines.push(etfGateStatusLineZh(args.etfGate));
	lines.push(truncateEtfHumanSummaryForStatus(args.etfHumanSummaryZh, 420));
	lines.push(indexDailyPctObservabilityZh(args.indexMeta));
	lines.push(packOverallAlignmentLineZh(args.packMode, args.semanticCandidateOnly));
	return lines.join("\n");
}
