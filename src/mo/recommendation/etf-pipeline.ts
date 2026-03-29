import type { RecommendationCandidate, RecommendationCandidateLoadResult } from "../recommendation-candidate-loader.js";
import { loadTwEtfUniverseFromFinMind } from "./etf-finmind-loader.js";
import { resolveEtfCandidateGate } from "./etf-gate.js";
import { normalizeEtfRawRows } from "./etf-normalize.js";
import { rankEtfCandidates } from "./etf-rank.js";
import type { EtfCandidateGateState, EtfRankedRow, MoEtfFetchEnv } from "./etf-types.js";
import {
	etfScoreLayerDisclaimerZh,
	indexDailyPctObservabilityZh,
} from "./etf-public-facts.js";
import type { IndexDailyPctParseResult } from "../live-index-daily-pct.js";

const TOP_N = 3;

function toRecommendationCandidates(rows: readonly EtfRankedRow[]): RecommendationCandidate[] {
	return rows.slice(0, TOP_N).map((r) => ({
		symbol: r.symbol,
		name: r.name,
		market: "TW" as const,
		rationale: `ETF v1 排名第${String(r.rank)}名；${r.scoreBreakdownZh}；資料來源：${r.source}；非下單建議。`,
		score: Math.max(0, Math.min(100, r.score)),
	}));
}

function indexMetaFromNullablePct(indexDailyPct: number | null): IndexDailyPctParseResult {
	if (indexDailyPct === null) {
		return { value: null, kind: "absent" };
	}
	return { value: indexDailyPct, kind: "parsed" };
}

function buildHumanSummaryZh(
	gate: EtfCandidateGateState,
	ranked: readonly EtfRankedRow[],
	indexDailyPct: number | null
): string {
	const layer = etfScoreLayerDisclaimerZh();
	const idxLine = indexDailyPctObservabilityZh(indexMetaFromNullablePct(indexDailyPct));
	if (gate === "ranked_candidate_ready") {
		const lines = ranked.slice(0, TOP_N).map(
			(r) => `${r.name}（${r.symbol}）排序分${String(r.score)}：${r.scoreBreakdownZh}`
		);
		return `${layer}\n${idxLine}\n【ETF 候選 v1】已產出可排名標的（最多${String(TOP_N)}檔）：\n${lines.join("\n")}`;
	}
	if (gate === "insufficient_data") {
		return `${layer}\n${idxLine}\n【ETF 候選 v1】已取得候選池資料，但缺少收盤價／交易日等關鍵欄位，尚無法形成可排名 ETF。`;
	}
	return `${layer}\n${idxLine}\n【ETF 候選 v1】未取得任何候選列（候選池為空或未執行載入）。`;
}

export type MoEtfPipelineResult = {
	gate: EtfCandidateGateState;
	loadResult: RecommendationCandidateLoadResult;
	ranked: readonly EtfRankedRow[];
	humanSummaryZh: string;
	/** 已產出具名 ETF 候選列（與「僅指數參考」語意區隔） */
	listsNamedEtfCandidates: boolean;
};

/**
 * ETF Candidate Universe v1：FinMind 載入 → 正規化 → gate → 排名 → 轉成 recommendation 候選列。
 * indexDailyPct：大盤同日報酬率（小數）；無則傳 null，相容項為 0。
 */
export async function runMoEtfCandidatePipelineV1(
	env: MoEtfFetchEnv,
	tradeDateYyyymmdd: string,
	indexDailyPct: number | null
): Promise<MoEtfPipelineResult> {
	const raw = await loadTwEtfUniverseFromFinMind(env, tradeDateYyyymmdd);
	const normalized = normalizeEtfRawRows(raw);
	const gate = resolveEtfCandidateGate(raw, normalized);
	const usable = normalized.filter((n) => n.usableForRanking);
	const ranked = rankEtfCandidates(usable, indexDailyPct);

	const notes: string[] = [
		`etf_universe_v1 gate=${gate}`,
		`tradeDate=${tradeDateYyyymmdd}`,
		`rawRows=${String(raw.length)} usable=${String(usable.length)}`,
	];

	if (gate === "ranked_candidate_ready") {
		const cands = toRecommendationCandidates(ranked);
		return {
			gate,
			loadResult: {
				source: "etf_universe",
				ready: true,
				candidateCount: cands.length,
				candidates: cands,
				notes,
			},
			ranked,
			humanSummaryZh: buildHumanSummaryZh(gate, ranked, indexDailyPct),
			listsNamedEtfCandidates: cands.length > 0,
		};
	}

	return {
		gate,
		loadResult: {
			source: "etf_universe",
			ready: gate === "insufficient_data",
			candidateCount: 0,
			candidates: [],
			notes: [...notes, "no ranked ETF candidates for recommendation payload"],
		},
		ranked,
		humanSummaryZh: buildHumanSummaryZh(gate, ranked, indexDailyPct),
		listsNamedEtfCandidates: false,
	};
}
