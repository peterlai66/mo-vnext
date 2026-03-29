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
	/** Web 顯示用：整段人話摘要（不重算） */
	narrativeZh: string;
	/** 第一名與該名次之排序分差 */
	scoreDiff: number;
};

export type CandidatesApiDisplay = {
	/** 決策語氣（人話，非 raw enum） */
	decisionLabelZh: string;
	/** 信心敘述（與 etfConfidenceLineZh 同源） */
	confidenceNarrativeZh: string;
	/** 與 `generatedAt` 對應之台灣時間顯示字串（Web 不重算） */
	generatedAtTaipei: string;
};

export type CandidatesApiData = {
	recommendationMode: string;
	/** 與 `deriveEtfConfidenceLevel` / `EtfConfidenceLevel` 一致之字串值（內部／除錯） */
	confidence: string;
	leader: CandidatesApiRankedEntry;
	rankedCandidates: CandidatesApiRankedEntry[];
	deltaExplain: {
		pairs: CandidatesApiDeltaPair[];
	};
	/** Web 專用顯示欄位 */
	display: CandidatesApiDisplay;
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
