import type { EtfCandidateGateState, EtfNormalizedCandidate, EtfRawLoaderRow } from "./etf-types.js";

/** 供追問事實句使用（避免英文 gate 常值直接進使用者可見層）。 */
export function etfCandidateGateLabelZh(gate: EtfCandidateGateState): string {
	switch (gate) {
		case "no_candidate":
			return "無候選列";
		case "insufficient_data":
			return "候選資料不足";
		case "ranked_candidate_ready":
			return "已產出可排名候選";
	}
}

/**
 * - no_candidate：未嘗試到任何有效列（例如全數網路失敗且無結構化列）
 * - insufficient_data：有列但無任何 usableForRanking
 * - ranked_candidate_ready：至少一檔可進排名
 */
export function resolveEtfCandidateGate(
	rawRows: readonly EtfRawLoaderRow[],
	normalized: readonly EtfNormalizedCandidate[]
): EtfCandidateGateState {
	if (rawRows.length === 0) {
		return "no_candidate";
	}
	const usable = normalized.filter((n) => n.usableForRanking);
	if (usable.length === 0) {
		return "insufficient_data";
	}
	return "ranked_candidate_ready";
}
