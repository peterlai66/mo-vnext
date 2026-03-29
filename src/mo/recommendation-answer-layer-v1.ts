/**
 * Answer Layer v1：依既有 delta explain／候選列／confidence／recommendationMode 組裝繁中追問回覆，
 * 避免把整段 humanSummaryZh／candidateSummary 當作「回答」重複貼上。
 */

import type { RecommendationFollowUpIntent } from "./input.js";
import type { RecommendationOutput } from "./recommendation-output.js";
import {
	etfConfidenceAppendZh,
	etfConfidenceDerivationFromRecommendationCandidates,
	stripEtfTickerForDisplay,
	type EtfDeltaComparisonZh,
	type EtfDeltaExplainBlockZh,
} from "./recommendation/etf-public-facts.js";

export type AnswerLayerPackSlice = {
	recommendationMode: "actionable" | "actionable_with_caution" | "observe_only" | "blocked";
	blockedBy: "none" | "score" | "governance" | "readiness" | "no_candidate";
	semanticCandidateOnly: boolean;
};

/** 供文案語氣：依第一名與第二名排序分差（與 confidence 閾值無關，僅敘事） */
export function gapMagnitudeNarrativeZh(gap: number | null, hasSecond: boolean): string {
	if (!hasSecond) {
		return "目前僅單檔排在前列，無法與其他名次並列比較分差。";
	}
	if (gap === null) {
		return "";
	}
	if (gap >= 8) {
		return "就排序分來看，第一名與第二名的差距相對明顯。";
	}
	if (gap >= 3) {
		return "排序分上仍看得出領先，但幅度屬中等。";
	}
	return "排序分差距不大，領先幅度有限。";
}

function formatPairwiseClauseZh(c: EtfDeltaComparisonZh): string {
	const adv =
		c.advantages.length > 0 ? `主要差異面向：${c.advantages.join("；")}。` : "";
	const dis =
		c.disadvantages.length > 0 ? `相對較弱：${c.disadvantages.join("；")}。` : "";
	return `${adv}${dis}`.trim();
}

function extractTickerFromUserMessageZh(text: string): string | null {
	const t = text.trim();
	const m = t.match(/(?:^|[^\d])(0\d{3,5})(?:\.TW)?(?:[^\d]|$)/u);
	return m?.[1] ?? null;
}

function extractAllTickersFromUserMessageZh(text: string): string[] {
	const ms = text.matchAll(/0\d{3,5}/gu);
	return [...new Set([...ms].map((m) => m[0]))];
}

function isWhyNotTickerQuestionZh(text: string): boolean {
	return /(?:不是|為何不是|怎麼不是|為什麼不是)/u.test(text);
}

function findCandidateRow(
	candidates: RecommendationOutput["recommendation"]["candidates"],
	ticker: string
): { symbol: string; name: string; score: number; rank: number } | undefined {
	const needle = ticker.trim();
	return candidates.find((c) => stripEtfTickerForDisplay(c.symbol) === needle);
}

function confidenceLineFrom(
	recOut: RecommendationOutput,
	pack: AnswerLayerPackSlice
): string {
	return etfConfidenceAppendZh(
		etfConfidenceDerivationFromRecommendationCandidates({
			recommendationMode: pack.recommendationMode,
			blocked: recOut.blocked,
			etfGate: recOut.etfCandidateContext?.gate,
			candidates: recOut.recommendation.candidates,
		})
	);
}

function composeAskWhyZh(args: {
	delta: EtfDeltaExplainBlockZh;
	candidates: RecommendationOutput["recommendation"]["candidates"];
	confLine: string;
	whyNotTicker: string | null;
	compareTicker: string | null;
}): string {
	const { delta, candidates, confLine, whyNotTicker, compareTicker } = args;
	const leader = delta.leader;
	const hasSecond = candidates.length >= 2;
	const gap =
		hasSecond && candidates[0] !== undefined && candidates[1] !== undefined ?
			candidates[0].score - candidates[1].score
		:	null;
	const gapLine = gapMagnitudeNarrativeZh(gap, hasSecond);

	if (whyNotTicker !== null) {
		const comp = delta.comparisons.find((x) => x.against === whyNotTicker);
		if (comp !== undefined) {
			const clause = formatPairwiseClauseZh(comp);
			return [
				`結論先說：目前排序第一是 ${leader}，不是 ${whyNotTicker}。${gapLine}`,
				`就「${leader} 相較 ${whyNotTicker}」的排序差異來看：${clause}`,
				`整體判斷：${confLine}（候選排序分僅供參考，與整體是否放行不同層級。）`,
			].join("\n");
		}
	}

	if (compareTicker !== null && compareTicker !== leader) {
		const comp = delta.comparisons.find((x) => x.against === compareTicker);
		if (comp !== undefined) {
			return [
				`結論先說：${leader} 目前排在第一。${gapLine}`,
				`你問的「${leader} 與 ${compareTicker} 差在哪」：${formatPairwiseClauseZh(comp)}`,
				`整體判斷：${confLine}（不宜把排序分直接等同進場訊號。）`,
			].join("\n");
		}
	}

	const first = delta.comparisons[0];
	const mid =
		first !== undefined ?
			`與其他名次對照（例：相較 ${first.against}）：${formatPairwiseClauseZh(first)}`
		:	"目前僅能對單檔排序，尚無與其他標的的 pairwise 對照。";

	return [
		`結論先說：${leader} 目前排序第一。${gapLine}`,
		mid,
		`整體判斷：${confLine}（候選排序分僅供參考，與整體是否放行不同層級。）`,
	].join("\n");
}

function composeAskTickerZh(args: {
	ticker: string;
	delta: EtfDeltaExplainBlockZh | null;
	candidates: RecommendationOutput["recommendation"]["candidates"];
	confLine: string;
}): string | null {
	const row = findCandidateRow(args.candidates, args.ticker);
	if (row === undefined) {
		return `這輪候選清單裡沒有看到你問的「${args.ticker}」；若代號不同請再確認。`;
	}
	const leaderSym = args.candidates[0] !== undefined ?
		stripEtfTickerForDisplay(args.candidates[0].symbol)
	:	null;
	const leaderName =
		args.candidates[0] !== undefined ? args.candidates[0].name : "";
	const gapToLeader =
		args.candidates[0] !== undefined ?
			args.candidates[0].score - row.score
		:	0;
	const rankLine = `「${args.ticker}」目前在候選裡排第 ${String(row.rank)} 名。`;

	if (leaderSym !== null && args.ticker === leaderSym) {
		return [
			`${args.ticker} 就是目前排序第一的標的。`,
			`整體判斷：${args.confLine}（排序分與整體放行門檻仍不同層級。）`,
		].join("\n");
	}

	let vsLeader = "";
	if (args.delta !== null && leaderSym !== null) {
		const comp = args.delta.comparisons.find((c) => c.against === args.ticker);
		if (comp !== undefined) {
			vsLeader = `和第一名（${leaderSym}${leaderName !== "" ? `／${leaderName}` : ""}）相比：${formatPairwiseClauseZh(comp)}`;
		}
	}
	if (vsLeader === "") {
		vsLeader =
			leaderSym !== null ?
				`與第一名（${leaderSym}）相比，排序分約差 ${String(Math.round(gapToLeader))} 分（僅代表當下排序尺度）。`
			:	"與第一名的差異請以上方排序分為準。";
	}

	const watch =
		row.rank <= 3 ?
			"仍值得放在觀察名單，但是否加碼／進場請回到整體建議模式與自身風險。"
		:	"優先度相對靠後，適合先觀察，不急著當成首要選項。";

	return [rankLine, vsLeader, watch, `整體判斷：${args.confLine}`].join("\n");
}

function composeAskTimingZh(args: {
	pack: AnswerLayerPackSlice;
	confLine: string;
	candidates: RecommendationOutput["recommendation"]["candidates"];
}): string {
	const mode = args.pack.recommendationMode;
	const leader =
		args.candidates[0] !== undefined ?
			stripEtfTickerForDisplay(args.candidates[0].symbol)
		:	null;

	if (mode === "observe_only") {
		const leadHint =
			leader !== null ?
				`目前候選中，${leader}排序較前，但這是「排序參考」，不代表已達整體放行或適合直接進場。`
			:	"目前整體仍偏先觀察，不宜把候選排序直接當成進場訊號。";
		return [`若問的是「現在要不要進場」：建議先保守看待。${args.confLine}`, leadHint].join(
			"\n"
		);
	}
	if (mode === "blocked") {
		return `以目前條件，系統不建議把此輪輸出當成可積極進場的依據。${args.confLine}`;
	}
	if (mode === "actionable_with_caution") {
		const l =
			leader !== null ?
				`若你關注的是候選排序，${leader}目前在前段，但仍建議小步、控管部位。`
			:	"可留意，但仍宜保守配置與部位。";
		return [`進場與否仍取決於你的資金與風險承受度；系統面向上偏「可留意但保守」。${args.confLine}`, l].join(
			"\n"
		);
	}
	const l2 =
		leader !== null ?
			`候選上${leader}排序較前，但仍請自行控管風險與部位，本訊息非交易指令。`
		:	"條件相對可留意，但仍非下單建議。";
	return [`以目前判定，相對可留意配置節奏，但仍請自行承擔風險。${args.confLine}`, l2].join("\n");
}

/**
 * 若可組出「分析師式」繁中回覆則回傳字串；否則回 null（交由既有 AI／fallback）。
 */
export function tryComposeRecommendationAnswerLayerV1(args: {
	followUpIntent: RecommendationFollowUpIntent;
	userMessage: string;
	recOut: RecommendationOutput;
	pack: AnswerLayerPackSlice;
}): string | null {
	const { followUpIntent, userMessage, recOut, pack } = args;
	if (recOut.blocked) {
		return null;
	}
	const ctx = recOut.etfCandidateContext;
	if (ctx === undefined) {
		return null;
	}

	const confLine = confidenceLineFrom(recOut, pack);
	const cands = recOut.recommendation.candidates;
	const delta = ctx.deltaExplain;

	const tickerFromMsg = extractTickerFromUserMessageZh(userMessage);
	const whyNot = isWhyNotTickerQuestionZh(userMessage);
	const compareHint = /差在哪|差異|相比|跟.+比/u.test(userMessage);

	if (followUpIntent === "ask_timing") {
		return composeAskTimingZh({ pack, confLine, candidates: cands });
	}

	if (followUpIntent === "ask_ticker") {
		if (tickerFromMsg === null) {
			return null;
		}
		return composeAskTickerZh({
			ticker: tickerFromMsg,
			delta,
			candidates: cands,
			confLine,
		});
	}

	if (followUpIntent === "ask_why") {
		if (ctx.gate !== "ranked_candidate_ready" || delta === null) {
			return null;
		}
		let whyNotTicker: string | null = null;
		let compareTicker: string | null = null;
		const tickersAll = extractAllTickersFromUserMessageZh(userMessage);
		if (whyNot && tickerFromMsg !== null) {
			whyNotTicker = tickerFromMsg;
		}
		if (compareHint && tickersAll.length >= 2 && whyNotTicker === null) {
			compareTicker = tickersAll.find((t) => t !== delta.leader) ?? null;
		}
		return composeAskWhyZh({
			delta,
			candidates: cands,
			confLine,
			whyNotTicker,
			compareTicker,
		});
	}

	return null;
}
