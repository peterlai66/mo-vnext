/**
 * mo_live payload_summary（v2）內 legacySummary 之 indexDailyPct 解析。
 * 不觸及 governance／仲裁；僅從已儲存字串安全抽出數值。
 */

export type IndexDailyPctParseResult = {
	/** 小數日報酬（例如 0.012 = +1.2%）；無法取得則 null */
	value: number | null;
	kind: "parsed" | "absent" | "invalid";
};

/** 合理日報酬範圍（超出視為異常，避免髒資料進 ranking） */
const INDEX_DAILY_PCT_ABS_MAX = 0.5;

export function parseIndexDailyPctFromMoLivePayloadSummary(
	payloadSummary: string
): IndexDailyPctParseResult {
	const t = payloadSummary.trim();
	if (t === "" || !t.startsWith("{")) {
		return { value: null, kind: "absent" };
	}
	let j: unknown;
	try {
		j = JSON.parse(t) as unknown;
	} catch {
		return { value: null, kind: "invalid" };
	}
	if (typeof j !== "object" || j === null) {
		return { value: null, kind: "invalid" };
	}
	const leg = (j as Record<string, unknown>).legacySummary;
	if (typeof leg !== "string") {
		return { value: null, kind: "absent" };
	}
	const m =
		/(?:^|[;])indexDailyPct=([-+]?(?:\d+\.?\d*|\d*\.\d+)(?:[eE][-+]?\d+)?)(?:;|$)/u.exec(
			leg
		);
	if (m === null) {
		return { value: null, kind: "absent" };
	}
	const n = Number(m[1]);
	if (!Number.isFinite(n)) {
		return { value: null, kind: "invalid" };
	}
	if (n < -INDEX_DAILY_PCT_ABS_MAX || n > INDEX_DAILY_PCT_ABS_MAX) {
		return { value: null, kind: "invalid" };
	}
	return { value: n, kind: "parsed" };
}

/**
 * 寫入快照前：將大盤日報酬（小數）附在 legacySummary（不重複 key）。
 */
export function appendIndexDailyPctToLegacySummary(
	legacySummary: string,
	pct: number | null
): string {
	const without = legacySummary
		.replace(/;indexDailyPct=[^;]*/gu, "")
		.replace(/^indexDailyPct=[^;]*;/u, "");
	if (pct === null || !Number.isFinite(pct)) {
		return without;
	}
	if (pct < -INDEX_DAILY_PCT_ABS_MAX || pct > INDEX_DAILY_PCT_ABS_MAX) {
		return without;
	}
	return `${without};indexDailyPct=${String(pct)}`;
}

export type FinMindTaiexPoint = { yyyymmdd: string; close: number };

/**
 * 自 FinMind TaiwanStockPrice TAIEX JSON 抽出可排序收盤序列（僅解析，不呼叫網路）。
 */
export function extractFinMindTaiexCloseSeries(parsed: unknown): FinMindTaiexPoint[] {
	if (typeof parsed !== "object" || parsed === null) {
		return [];
	}
	const o = parsed as Record<string, unknown>;
	if (o.msg === "error") {
		return [];
	}
	const data = o.data;
	if (!Array.isArray(data)) {
		return [];
	}
	const byDate = new Map<string, number>();
	for (const item of data) {
		if (typeof item !== "object" || item === null) {
			continue;
		}
		const row = item as Record<string, unknown>;
		const dateRaw = row.date;
		if (typeof dateRaw !== "string") {
			continue;
		}
		const ymd = dateRaw.replace(/-/gu, "");
		if (!/^\d{8}$/u.test(ymd)) {
			continue;
		}
		const close = row.close;
		const cnum =
			typeof close === "number" && Number.isFinite(close) ? close
			: typeof close === "string" && close.trim() !== "" ? Number(close)
			: NaN;
		if (!Number.isFinite(cnum)) {
			continue;
		}
		byDate.set(ymd, cnum);
	}
	return [...byDate.entries()]
		.map(([yyyymmdd, close]) => ({ yyyymmdd, close }))
		.sort((a, b) => a.yyyymmdd.localeCompare(b.yyyymmdd));
}

/**
 * 以排序後序列計算 target 交易日相對前一筆之日報酬（小數）；單點或缺前一日則 null。
 */
export function computeIndexDailyPctFromFinMindSeries(
	series: readonly FinMindTaiexPoint[],
	targetYyyymmdd: string
): number | null {
	const idx = series.findIndex((p) => p.yyyymmdd === targetYyyymmdd);
	if (idx <= 0) {
		return null;
	}
	const prev = series[idx - 1];
	const cur = series[idx];
	if (prev === undefined || cur === undefined) {
		return null;
	}
	if (prev.close <= 0) {
		return null;
	}
	const raw = (cur.close - prev.close) / prev.close;
	if (!Number.isFinite(raw) || raw < -INDEX_DAILY_PCT_ABS_MAX || raw > INDEX_DAILY_PCT_ABS_MAX) {
		return null;
	}
	return raw;
}

export function buildFinMindTaiexLegacySummaryForTradeDate(
	series: readonly FinMindTaiexPoint[],
	targetYyyymmdd: string
): { legacySummary: string; indexDailyPct: number | null } | null {
	const pt = series.find((p) => p.yyyymmdd === targetYyyymmdd);
	if (pt === undefined) {
		return null;
	}
	const pct = computeIndexDailyPctFromFinMindSeries(series, targetYyyymmdd);
	const base = `finmind=TaiwanStockPrice;data_id=TAIEX;date=${targetYyyymmdd};close=${String(pt.close)}`;
	return {
		legacySummary: appendIndexDailyPctToLegacySummary(base, pct),
		indexDailyPct: pct,
	};
}
