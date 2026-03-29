/**
 * 台股 ETF 最小候選池 v1（內建 watchlist）。
 * 未來可改為 D1／KV 或 TWSE 清單同步；目前為 code 內建以利可重現與離線測試。
 */
export type TwEtfUniverseEntry = {
	/** FinMind TaiwanStockPrice data_id（不含 .TW） */
	id: string;
	name: string;
};

export const DEFAULT_TW_ETF_UNIVERSE_V1: readonly TwEtfUniverseEntry[] = [
	{ id: "0050", name: "元大台灣50" },
	{ id: "0056", name: "元大高股息" },
	{ id: "00878", name: "國泰永續高股息" },
	{ id: "006208", name: "富邦台50" },
	{ id: "00713", name: "元大台灣高息低波" },
] as const;
