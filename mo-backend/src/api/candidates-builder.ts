import type { Env } from "../index.js";
import type { MoEtfPipelineResult } from "../mo/recommendation/etf-pipeline.js";
import type { EtfRankedRow } from "../mo/recommendation/etf-types.js";
import type { EtfDeltaComparisonZh } from "../mo/recommendation/etf-public-facts.js";
import {
	deriveEtfConfidenceLevel,
	etfConfidenceLineZh,
	etfConfidenceDerivationFromStatusEtf,
	etfDeltaNoClearWeaknessZh,
	etfDeltaOverallNarrowMarginZh,
	stripEtfTickerForDisplay,
	type EtfConfidenceLevel,
	type MoRecommendationModePublic,
} from "../mo/recommendation/etf-public-facts.js";
import type {
	CandidatesApiData,
	CandidatesApiErrorBody,
	CandidatesApiRankedEntry,
	CandidatesApiSuccessBody,
} from "./candidates-types.js";
import { deltaPairNarrativeZh, recommendationModeDecisionLabelZh } from "./candidates-display-zh.js";
import { formatIsoToTaipeiDateTime } from "./taipei-time.js";

const JSON_UTF8 = "application/json; charset=utf-8";

/** 與 `formatEtfDeltaExplainBodyZh` 單一「相較 X」區塊同源，不拼全局優勢段。 */
function pairwiseSummaryZh(c: EtfDeltaComparisonZh): string {
	const adv =
		c.advantages.length > 0 ?
			`優勢：${c.advantages.join("；")}`
		:	`優勢：${etfDeltaOverallNarrowMarginZh()}`;
	const dis =
		c.disadvantages.length > 0 ?
			`劣勢：${c.disadvantages.join("；")}`
		:	`劣勢：${etfDeltaNoClearWeaknessZh()}`;
	return `${adv}\n${dis}`;
}

function rankedRowToApiEntry(r: EtfRankedRow): CandidatesApiRankedEntry {
	return {
		symbol: r.symbol.trim(),
		name: r.name.trim(),
		score: r.score,
		rank: r.rank,
	};
}

export type MapCandidatesFailure = { ok: false; error: string; message: string };

/**
 * 將與 `/status` 同源之 `MoEtfPipelineResult` + `recommendationMode` 組成 Web schema（僅映射，不重算分數／gate）。
 */
export function mapEtfContextToCandidatesApiSuccess(args: {
	recommendationMode: MoRecommendationModePublic;
	etf: MoEtfPipelineResult;
}): { ok: true; body: CandidatesApiSuccessBody } | { ok: false; error: string; message: string } {
	const { recommendationMode, etf } = args;
	if (etf.gate !== "ranked_candidate_ready") {
		return { ok: false, error: "etf_gate_not_ready", message: `gate=${etf.gate}` };
	}
	const ranked = etf.ranked;
	if (ranked.length < 3) {
		return {
			ok: false,
			error: "insufficient_ranked_candidates",
			message: `rankedCount=${String(ranked.length)}`,
		};
	}
	const top3 = ranked.slice(0, 3);
	const rankedCandidates = top3.map(rankedRowToApiEntry);
	const leader = rankedCandidates[0];
	if (leader.rank !== 1) {
		return { ok: false, error: "invalid_rank_invariant", message: "leader.rank!==1" };
	}
	for (let i = 0; i < top3.length - 1; i++) {
		if (top3[i].score < top3[i + 1].score) {
			return { ok: false, error: "rank_sort_invariant_failed", message: "scores not descending" };
		}
	}
	const delta = etf.deltaExplain;
	if (delta === null || delta.comparisons.length < 2) {
		return { ok: false, error: "delta_explain_missing", message: "compareTopCandidates unavailable" };
	}
	if (delta.leader !== stripEtfTickerForDisplay(top3[0].symbol)) {
		return {
			ok: false,
			error: "delta_leader_mismatch",
			message: `${delta.leader} vs ${stripEtfTickerForDisplay(top3[0].symbol)}`,
		};
	}
	const pairs = delta.comparisons.slice(0, 2).map((comp, idx) => {
		const otherRow = top3[idx + 1] as EtfRankedRow;
		const scoreDiff = top3[0].score - otherRow.score;
		const summaryZh = pairwiseSummaryZh(comp);
		const from = stripEtfTickerForDisplay(top3[0].symbol);
		return {
			from,
			to: comp.against,
			summaryZh,
			narrativeZh: deltaPairNarrativeZh(from, comp.against, summaryZh),
			scoreDiff,
		};
	});
	const toSecond = stripEtfTickerForDisplay(top3[1].symbol);
	const toThird = stripEtfTickerForDisplay(top3[2].symbol);
	if (pairs[0].to !== toSecond || pairs[1].to !== toThird) {
		return {
			ok: false,
			error: "delta_pair_ticker_mismatch",
			message: `${pairs[0].to}/${pairs[1].to} vs ${toSecond}/${toThird}`,
		};
	}
	const confInput = etfConfidenceDerivationFromStatusEtf({
		recommendationMode,
		etfGate: etf.gate,
		etfListsNamedCandidates: etf.listsNamedEtfCandidates,
		ranked: etf.ranked,
	});
	const confidenceLevel: EtfConfidenceLevel = deriveEtfConfidenceLevel(confInput);
	const generatedAt = new Date().toISOString();
	const data: CandidatesApiData = {
		recommendationMode,
		confidence: confidenceLevel,
		leader,
		rankedCandidates,
		deltaExplain: { pairs },
		display: {
			decisionLabelZh: recommendationModeDecisionLabelZh(recommendationMode),
			confidenceNarrativeZh: etfConfidenceLineZh(confidenceLevel),
			generatedAtTaipei: formatIsoToTaipeiDateTime(generatedAt),
		},
	};
	return {
		ok: true,
		body: {
			ok: true,
			generatedAt,
			data,
		},
	};
}

export type CandidatesPushContext = {
	etfPipelineResult: MoEtfPipelineResult | null;
	recommendationExplainablePack: { recommendationMode: MoRecommendationModePublic };
};

export async function buildCandidatesApiResponse(
	env: Env,
	loadPushContext: (e: Env) => Promise<CandidatesPushContext>
): Promise<Response> {
	try {
		const ctx = await loadPushContext(env);
		const etf = ctx.etfPipelineResult;
		if (etf === null) {
			const err: CandidatesApiErrorBody = {
				ok: false,
				generatedAt: new Date().toISOString(),
				error: "etf_pipeline_skipped",
				message:
					"資料治理或 precheck 略過 ETF pipeline（與 /status ETF 區塊略過條件一致）。",
			};
			return new Response(JSON.stringify(err), {
				status: 200,
				headers: { "Content-Type": JSON_UTF8, "Cache-Control": "no-store" },
			});
		}
		const mode = ctx.recommendationExplainablePack.recommendationMode;
		const mapped = mapEtfContextToCandidatesApiSuccess({ recommendationMode: mode, etf });
		if (mapped.ok === false) {
			const err: CandidatesApiErrorBody = {
				ok: false,
				generatedAt: new Date().toISOString(),
				error: mapped.error,
				message: mapped.message,
			};
			return new Response(JSON.stringify(err), {
				status: 200,
				headers: { "Content-Type": JSON_UTF8, "Cache-Control": "no-store" },
			});
		}
		return new Response(JSON.stringify(mapped.body), {
			status: 200,
			headers: { "Content-Type": JSON_UTF8, "Cache-Control": "no-store" },
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const errBody: CandidatesApiErrorBody = {
			ok: false,
			generatedAt: new Date().toISOString(),
			error: "candidates_internal_error",
			message,
		};
		return new Response(JSON.stringify(errBody), {
			status: 500,
			headers: { "Content-Type": JSON_UTF8 },
		});
	}
}
