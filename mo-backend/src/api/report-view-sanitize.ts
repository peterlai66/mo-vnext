import { formatIsoToTaipeiDateTime } from "./taipei-time.js";

export type ReportViewData = {
	titleZh: string;
	paragraphs: string[];
	display: {
		generatedAtTaipei: string;
	};
};

/**
 * 將 /report 純文字整理為 Web 可讀段落：移除工程 dump、staleness、行情語氣列、重複標題。
 * 報告本體可能是單行長字串，需在合併後再做字串級清理。
 */
export function sanitizeReportPlainForWeb(raw: string, generatedAtIso: string): ReportViewData {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const kept: string[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (t === "") continue;
		if (t === "MO Report") continue;
		if (/stalenessLevel\s*:/i.test(t)) continue;
		/** 勿因內嵌「行情語氣」整行丟棄：長文常為單行，改由 stripReportNoise 處理 */
		if (/^note:\s*/i.test(t)) continue;
		kept.push(line.trimEnd());
	}
	let merged = kept.map((l) => l.trim()).join(" ");
	merged = stripReportNoise(merged);
	let paragraphs = splitReadableParagraphs(merged);
	if (paragraphs.length === 0) {
		paragraphs = ["目前無法產出可讀報告段落，請稍後再試。"];
	}
	return {
		titleZh: "今日報告",
		paragraphs,
		display: {
			generatedAtTaipei: formatIsoToTaipeiDateTime(generatedAtIso),
		},
	};
}

/** 內嵌於敘述中的 staleness 提示、行情語氣段、語意／工程摘要段、key=value 參數列 */
function stripReportNoise(s: string): string {
	let t = s.trim();
	// 行情語氣整段（單行內嵌）
	t = t.replace(/【行情資料語氣】[^【]*/g, "");
	// staleness 口語括號
	t = t.replace(/（[^）]*staleness[^）]*）/gi, "");
	t = t.replace(/請以\s*staleness\s*為準/gi, "");
	// 語意摘要與模擬放行段常為 enum／gate dump
	t = t.replace(/【語意摘要】[^【]*/g, "");
	t = t.replace(/【模擬與建議放行】[^【]*/g, "");
	// 殘留的 ASCII key=value（decisionEligible=true、recommendationMode=observe_only 等）
	t = t.replace(
		/\b[a-z][a-zA-Z0-9_]*=(?:true|false|null|[^\s\u3000，。；、：]+)/g,
		""
	);
	// 殘留之 scoreEligible 括號（只刪此窄模式，避免誤刪整句）
	t = t.replace(/（balanced\s*門檻\s*\d+\s*，/g, "");
	t = t.replace(/\s{2,}/g, " ");
	t = t.replace(/\s+([，。；])/g, "$1");
	return t.trim();
}

/** 依【章節標題】拆成多段，避免單一超長段落；並略過僅剩標點或過短的碎片 */
function splitReadableParagraphs(merged: string): string[] {
	const parts = merged.split(/(?=【)/).map((p) => p.trim()).filter(Boolean);
	if (parts.length <= 1) {
		const one = parts[0] ?? merged;
		return one.length > 0 ? [one] : [];
	}
	const out: string[] = [];
	for (const p of parts) {
		if (p.length < 4) continue;
		out.push(p);
	}
	return out;
}
