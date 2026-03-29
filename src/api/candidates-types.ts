/**
 * GET `/api/candidates` 穩定 JSON shape（資料來自 computeMoPushEvaluationForUser + ETF pipeline，非第二套邏輯）。
 */

export type CandidatesApiRankedEntry = {
	symbol: string;
	name: string;
	score: number;
	rank: number;
};

export type CandidatesApiDeltaPair = {
	/** 第一名代號（與 delta explain leader 一致之顯示格式） */
	from: string;
	/** 對照之其他名次代號 */
	to: string;
	/** 與 `formatEtfDeltaExplainBodyZh` 單一 pairwise 區塊同源之優／劣勢句（不含全局「主要優勢」敘述） */
	summaryZh: string;
	/** 第一名與該名次之排序分差 */
	scoreDiff: number;
};

export type CandidatesApiData = {
	recommendationMode: string;
	/** 與 `deriveEtfConfidenceLevel` / `EtfConfidenceLevel` 一致之字串值 */
	confidence: string;
	leader: CandidatesApiRankedEntry;
	rankedCandidates: CandidatesApiRankedEntry[];
	deltaExplain: {
		pairs: CandidatesApiDeltaPair[];
	};
};

export type CandidatesApiSuccessBody = {
	ok: true;
	generatedAt: string;
	data: CandidatesApiData;
};

export type CandidatesApiErrorBody = {
	ok: false;
	generatedAt: string;
	error: string;
	message?: string;
	allowedMethods?: readonly string[];
};
