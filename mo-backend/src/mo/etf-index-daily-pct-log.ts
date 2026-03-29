import type { IndexDailyPctParseResult } from "./live-index-daily-pct.js";

/**
 * 快照 payload_summary 解析後（與 mo_live legacySummary 內嵌欄位對齊）。
 */
export function logMoEtfIndexDailyPctFromSnapshot(parse: IndexDailyPctParseResult): void {
	const source =
		parse.kind === "parsed" && parse.value !== null ? "legacy" : "fallback";
	console.log("[mo] etf indexDailyPct", {
		value: parse.value,
		parsedKind: parse.kind,
		source,
	});
}

/**
 * 進入 ETF ranking 前（與傳入 rankEtfCandidates 之值一致）。
 */
export function logMoEtfIndexDailyPctBeforeRanking(parse: IndexDailyPctParseResult): void {
	console.log("[mo] etf indexDailyPct", {
		value: parse.value,
		parsedKind: parse.kind,
		source: "ranking",
	});
}
