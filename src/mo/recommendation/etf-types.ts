/** ETF Candidate Universe v1 — 共用型別（與 FinMind／正規化／gate 對齊） */

export type EtfCandidateGateState =
	| "no_candidate"
	| "insufficient_data"
	| "ranked_candidate_ready";

/** FinMind TaiwanStockPrice 單檔擷取後之原始列（尚未正規化） */
export type EtfRawLoaderRow = {
	universeId: string;
	displayName: string;
	tradeDate: string | null;
	close: number | null;
	previousClose: number | null;
	volume: number | null;
	source: string;
	fetchOk: boolean;
	fetchNote: string;
};

/** 統一候選結構（ranking 前） */
export type EtfNormalizedCandidate = {
	symbol: string;
	name: string;
	tradeDate: string;
	close: number;
	pctChange: number | null;
	volume: number | null;
	source: string;
	usableForRanking: boolean;
	normalizationNote: string;
};

/** 單檔排名結果（可解釋） */
export type EtfRankedRow = EtfNormalizedCandidate & {
	score: number;
	rank: number;
	scoreBreakdownZh: string;
};

export type MoEtfFetchEnv = {
	FINMIND_TOKEN?: string;
};
