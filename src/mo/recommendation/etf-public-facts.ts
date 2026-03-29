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

/** observe_only 且已有可排名 ETF 時，與候選摘要並列之進場語意（與 gate 對齊） */
export function etfObserveOnlyRankedCandidatesFootnoteZh(): string {
	return "雖已有可排名候選，但整體策略分數仍未達進場門檻。";
}

// --- Recommendation Confidence v3：決策語氣層（不改 ranking／gate，僅附一句） ---

export type EtfConfidenceLevel =
	| "weak_observe"
	| "observe"
	| "neutral"
	| "cautious_entry"
	| "ready";

/** actionable 且前兩名排序分差距小於此值時，語氣偏中性（與 ready 區隔） */
const ETF_CONFIDENCE_ACTIONABLE_NEUTRAL_GAP_BELOW = 3;

export function etfConfidenceLineZh(level: EtfConfidenceLevel): string {
	switch (level) {
		case "weak_observe":
			return "目前市場條件仍偏不明朗，建議持續觀察。";
		case "observe":
			return "已有相對較佳標的，但整體仍建議觀察為主。";
		case "neutral":
			return "排序上有領先標的，但領先幅度有限，建議審慎評估後再決定是否調整部位。";
		case "cautious_entry":
			return "條件逐步成熟，可考慮小幅布局。";
		case "ready":
			return "整體條件已具備，可考慮進場。";
		default: {
			const _e: never = level;
			return _e;
		}
	}
}

export type EtfConfidenceDerivationInput = {
	recommendationMode: MoRecommendationModePublic;
	etfGate: EtfCandidateGateState | null;
	/** 已產出具名可排名 ETF 列（gate 與 loader 一致） */
	hasNamedRankedEtf: boolean;
	/** 第一名與第二名排序分差；不足兩檔則 null */
	leaderVsSecondScoreGap: number | null;
};

export function deriveEtfConfidenceLevel(input: EtfConfidenceDerivationInput): EtfConfidenceLevel {
	const { recommendationMode, etfGate, hasNamedRankedEtf, leaderVsSecondScoreGap } = input;
	const rankedReady = etfGate === "ranked_candidate_ready";

	if (recommendationMode === "blocked") {
		return "weak_observe";
	}
	if (recommendationMode === "observe_only") {
		return hasNamedRankedEtf && rankedReady ? "observe" : "weak_observe";
	}
	if (recommendationMode === "actionable_with_caution") {
		return hasNamedRankedEtf && rankedReady ? "cautious_entry" : "weak_observe";
	}
	if (recommendationMode === "actionable") {
		if (!hasNamedRankedEtf || !rankedReady) {
			return "weak_observe";
		}
		if (
			leaderVsSecondScoreGap !== null &&
			leaderVsSecondScoreGap < ETF_CONFIDENCE_ACTIONABLE_NEUTRAL_GAP_BELOW
		) {
			return "neutral";
		}
		return "ready";
	}
	return "weak_observe";
}

export function etfConfidenceAppendZh(input: EtfConfidenceDerivationInput): string {
	return etfConfidenceLineZh(deriveEtfConfidenceLevel(input));
}

export function etfConfidenceDerivationFromStatusEtf(args: {
	recommendationMode: MoRecommendationModePublic;
	etfGate: EtfCandidateGateState | null;
	etfListsNamedCandidates: boolean;
	ranked: readonly { score: number }[];
}): EtfConfidenceDerivationInput {
	const gap =
		args.ranked.length >= 2 ?
			args.ranked[0].score - args.ranked[1].score
		:	null;
	return {
		recommendationMode: args.recommendationMode,
		etfGate: args.etfGate,
		hasNamedRankedEtf: args.etfGate === "ranked_candidate_ready" && args.etfListsNamedCandidates,
		leaderVsSecondScoreGap: gap,
	};
}

export function etfConfidenceDerivationFromRecommendationCandidates(args: {
	recommendationMode: MoRecommendationModePublic;
	blocked: boolean;
	etfGate: EtfCandidateGateState | undefined;
	candidates: readonly { score: number }[];
}): EtfConfidenceDerivationInput {
	const gate = args.etfGate ?? null;
	const gap =
		args.candidates.length >= 2 ?
			args.candidates[0].score - args.candidates[1].score
		:	null;
	const hasNamed =
		!args.blocked && gate === "ranked_candidate_ready" && args.candidates.length > 0;
	return {
		recommendationMode: args.recommendationMode,
		etfGate: gate,
		hasNamedRankedEtf: hasNamed,
		leaderVsSecondScoreGap: gap,
	};
}

// --- Delta explain（與 etf-rank 分項語意對齊，集中於此檔供 pipeline／status／follow-up 共用） ---

export function etfDeltaCompletenessAdvantageZh(): string {
	return "資料完整度較高";
}

export function etfDeltaCompletenessDisadvantageZh(): string {
	return "資料完整度相對較低";
}

export function etfDeltaTrendAdvantageZh(): string {
	return "當日報酬動能較強";
}

export function etfDeltaTrendDisadvantageZh(): string {
	return "當日報酬動能相對較弱";
}

export function etfDeltaVolumeAdvantageZh(): string {
	return "成交活絡度較高";
}

export function etfDeltaVolumeDisadvantageZh(): string {
	return "成交活絡度相對較低";
}

export function etfDeltaAlignAdvantageZh(): string {
	return "與大盤同日走向較一致（大盤相容分較佳）";
}

export function etfDeltaAlignDisadvantageZh(): string {
	return "與大盤同日走向較分歧（大盤相容分較低）";
}

/** 總分相同、依代號決定第一名時 */
export function etfDeltaTieScoreSortZh(): string {
	return "總分相同，依代號排序居前";
}

/** 各維度差距在門檻內、但排序總分仍略高時（強調「整體差距不大」） */
export function etfDeltaOverallNarrowMarginZh(): string {
	return "整體差距不大，但排序總分略高";
}

/** pairwise 劣勢列為空時之固定補句（不含矛盾語意） */
export function etfDeltaNoClearWeaknessZh(): string {
	return "相較之下無明顯弱項";
}

export type EtfDeltaComparisonZh = {
	against: string;
	advantages: string[];
	disadvantages: string[];
};

export type EtfDeltaExplainBlockZh = {
	leader: string;
	comparisons: EtfDeltaComparisonZh[];
};

/**
 * 將 compareTopCandidates 結果排版為 humanSummaryZh 內文（不含層級／大盤列）。
 * 僅以 pairwise 區塊呈現，避免「全局優勢」與「相較某檔」語意打架。
 */
export function formatEtfDeltaExplainBodyZh(block: EtfDeltaExplainBlockZh): string {
	const { leader, comparisons } = block;
	if (comparisons.length === 0) {
		return `目前候選中，${leader} 排名第一；僅一檔可比，尚無其他候選可供差異對照。`;
	}

	const compareBlocks = comparisons.map((c) => {
		const adv =
			c.advantages.length > 0 ?
				`優勢：${c.advantages.join("；")}`
			:	`優勢：${etfDeltaOverallNarrowMarginZh()}`;
		const dis =
			c.disadvantages.length > 0 ?
				`劣勢：${c.disadvantages.join("；")}`
			:	`劣勢：${etfDeltaNoClearWeaknessZh()}`;
		return `相較 ${c.against}：\n- ${adv}\n- ${dis}`;
	});

	return [`目前候選中，${leader} 排名第一。`, "", ...compareBlocks].join("\n");
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
	/** 供信心層：與 pipeline 之 listsNamedEtfCandidates 對齊；未載入時省略 */
	etfListsNamedCandidates?: boolean;
	/** 供信心層：排序分列表（取前段 gap）；未載入時省略 */
	etfRankedScores?: readonly { score: number }[] | null;
}): string {
	const lists = args.etfListsNamedCandidates ?? false;
	const ranked = args.etfRankedScores ?? [];
	const pushConfidenceClosing = (lines: string[]): void => {
		lines.push(
			etfConfidenceAppendZh(
				etfConfidenceDerivationFromStatusEtf({
					recommendationMode: args.packMode,
					etfGate: args.etfGate,
					etfListsNamedCandidates: lists,
					ranked,
				})
			)
		);
	};

	const lines: string[] = [];
	lines.push("【台股 ETF 候選（與建議層級對齊）】");
	if (args.govDataUnusable) {
		lines.push("行情資料不可用（治理判定），不載入候選摘要。");
		lines.push(indexDailyPctObservabilityZh(args.indexMeta));
		pushConfidenceClosing(lines);
		return lines.join("\n");
	}
	if (args.precheckBlocked) {
		lines.push(`建議前置未啟用：${args.precheckBlockNoteZh}`);
		lines.push(indexDailyPctObservabilityZh(args.indexMeta));
		lines.push(packOverallAlignmentLineZh(args.packMode, args.semanticCandidateOnly));
		pushConfidenceClosing(lines);
		return lines.join("\n");
	}
	if (args.etfGate === null || args.etfHumanSummaryZh === null) {
		lines.push("候選資料暫未載入。");
		lines.push(indexDailyPctObservabilityZh(args.indexMeta));
		lines.push(packOverallAlignmentLineZh(args.packMode, args.semanticCandidateOnly));
		pushConfidenceClosing(lines);
		return lines.join("\n");
	}
	lines.push(etfGateStatusLineZh(args.etfGate));
	let etfBody = truncateEtfHumanSummaryForStatus(args.etfHumanSummaryZh, 420);
	if (
		args.packMode === "observe_only" &&
		args.etfGate === "ranked_candidate_ready" &&
		args.etfHumanSummaryZh.trim() !== ""
	) {
		etfBody = `${etfBody}\n${etfObserveOnlyRankedCandidatesFootnoteZh()}`;
	}
	lines.push(etfBody);
	lines.push(indexDailyPctObservabilityZh(args.indexMeta));
	lines.push(packOverallAlignmentLineZh(args.packMode, args.semanticCandidateOnly));
	pushConfidenceClosing(lines);
	return lines.join("\n");
}
