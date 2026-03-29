import type { EtfNormalizedCandidate, EtfRawLoaderRow } from "./etf-types.js";

function toTwSymbol(universeId: string): string {
	const t = universeId.trim();
	return t.endsWith(".TW") ? t : `${t}.TW`;
}

/**
 * 將 loader 原始列正規化；缺關鍵欄位者 usableForRanking=false。
 */
export function normalizeEtfRawRow(row: EtfRawLoaderRow): EtfNormalizedCandidate {
	const symbol = toTwSymbol(row.universeId);
	const name = row.displayName.trim() === "" ? symbol : row.displayName.trim();
	const tradeDate = row.tradeDate;
	const close = row.close;
	const reasons: string[] = [];

	if (!row.fetchOk) {
		return {
			symbol,
			name,
			tradeDate: tradeDate ?? "",
			close: close ?? 0,
			pctChange: null,
			volume: row.volume,
			source: row.source,
			usableForRanking: false,
			normalizationNote: `fetch failed: ${row.fetchNote}`,
		};
	}

	if (tradeDate === null || !/^\d{8}$/u.test(tradeDate)) {
		reasons.push("tradeDate missing or invalid");
	}
	if (close === null || !Number.isFinite(close) || close <= 0) {
		reasons.push("close missing or invalid");
	}

	let pctChange: number | null = null;
	if (
		close !== null &&
		row.previousClose !== null &&
		Number.isFinite(close) &&
		Number.isFinite(row.previousClose) &&
		row.previousClose > 0
	) {
		pctChange = (close - row.previousClose) / row.previousClose;
	}

	const usable = reasons.length === 0 && tradeDate !== null && close !== null;

	return {
		symbol,
		name,
		tradeDate: tradeDate ?? "",
		close: close ?? 0,
		pctChange,
		volume: row.volume,
		source: row.source,
		usableForRanking: usable,
		normalizationNote: usable ? "ok" : reasons.join("; "),
	};
}

export function normalizeEtfRawRows(rows: readonly EtfRawLoaderRow[]): EtfNormalizedCandidate[] {
	return rows.map((r) => normalizeEtfRawRow(r));
}
