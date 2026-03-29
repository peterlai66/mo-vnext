/**
 * FinMind TAIEX 日線：僅供補齊大盤日報酬（indexDailyPct），與 mo_live 寫入同源邏輯。
 * 不參與 governance 判定。
 */

import {
	extractFinMindTaiexCloseSeries,
	type FinMindTaiexPoint,
	buildFinMindTaiexLegacySummaryForTradeDate,
	appendIndexDailyPctToLegacySummary,
	computeIndexDailyPctFromFinMindSeries,
} from "./live-index-daily-pct.js";
import type { MoEtfFetchEnv } from "./recommendation/etf-types.js";

/** FinMind v4 要求 YYYY-MM-DD */
function yyyymmddToFinMindDate(yyyymmdd: string): string | null {
	if (!/^\d{8}$/u.test(yyyymmdd)) {
		return null;
	}
	return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function finMindDateMinusCalendarDays(yyyymmdd: string, days: number): string | null {
	if (!/^\d{8}$/u.test(yyyymmdd)) {
		return null;
	}
	const y = Number(yyyymmdd.slice(0, 4));
	const m = Number(yyyymmdd.slice(4, 6)) - 1;
	const d = Number(yyyymmdd.slice(6, 8));
	const dt = new Date(Date.UTC(y, m, d));
	dt.setUTCDate(dt.getUTCDate() - days);
	const yy = String(dt.getUTCFullYear());
	const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(dt.getUTCDate()).padStart(2, "0");
	return `${yy}${mm}${dd}`;
}

function maskFinMindTokenInRequestUrl(fullUrl: string): string {
	try {
		const u = new URL(fullUrl);
		if (u.searchParams.has("token")) {
			u.searchParams.set("token", "***");
		}
		return u.toString();
	} catch {
		return "<invalid url>";
	}
}

/**
 * 抓取 [startYyyymmdd, endYyyymmdd] 區間 TAIEX 日線並解析收盤序列。
 */
export async function fetchFinMindTaiexSeriesForRange(
	env: MoEtfFetchEnv,
	startYyyymmdd: string,
	endYyyymmdd: string
): Promise<{ ok: true; series: FinMindTaiexPoint[]; rawText: string } | { ok: false; note: string }> {
	const token = env.FINMIND_TOKEN?.trim();
	if (token === undefined || token === "") {
		return { ok: false, note: "FINMIND_TOKEN unset" };
	}
	const startD = yyyymmddToFinMindDate(startYyyymmdd);
	const endD = yyyymmddToFinMindDate(endYyyymmdd);
	if (startD === null || endD === null) {
		return { ok: false, note: "bad date range" };
	}
	const params = new URLSearchParams({
		dataset: "TaiwanStockPrice",
		data_id: "TAIEX",
		start_date: startD,
		end_date: endD,
		token,
	});
	const url = `https://api.finmindtrade.com/api/v4/data?${params.toString()}`;
	try {
		const res = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; MO-vNext/1.0; FinMind-indexDailyPct)",
			},
		});
		const text = await res.text();
		if (!res.ok) {
			console.log("[finmind] taiex range http error", {
				requestUrl: maskFinMindTokenInRequestUrl(url),
				status: res.status,
				bodyPreview: text.slice(0, 200),
			});
			return { ok: false, note: `http ${String(res.status)}` };
		}
		let j: unknown;
		try {
			j = JSON.parse(text) as unknown;
		} catch {
			return { ok: false, note: "json parse failed" };
		}
		const series = extractFinMindTaiexCloseSeries(j);
		return { ok: true, series, rawText: text };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, note: message };
	}
}

/**
 * 為已存在之 legacySummary（例如 TWSE 主路徑）附加 indexDailyPct：向 FinMind 取含前一交易日之區間。
 */
export async function supplementLegacySummaryWithFinMindIndexDailyPct(
	env: MoEtfFetchEnv,
	tradeDateYyyymmdd: string,
	legacySummary: string
): Promise<string> {
	const start = finMindDateMinusCalendarDays(tradeDateYyyymmdd, 45);
	if (start === null) {
		return legacySummary;
	}
	const got = await fetchFinMindTaiexSeriesForRange(env, start, tradeDateYyyymmdd);
	if (!got.ok) {
		return legacySummary;
	}
	const pct = computeIndexDailyPctFromFinMindSeries(got.series, tradeDateYyyymmdd);
	return appendIndexDailyPctToLegacySummary(legacySummary, pct);
}

/**
 * FinMind fallback 寫入用：對候選交易日取得 legacySummary（含 close 與可選 indexDailyPct）。
 */
export async function tryFinMindTaiexDailyWithIndexPct(
	env: MoEtfFetchEnv,
	lookbackDays: number,
	getTaipeiYYYYMMDDMinusDaysFromToday: (offset: number) => string
): Promise<
	| { ok: true; tradeDateYyyymmdd: string; rawText: string; legacySummary: string }
	| { ok: false; note: string }
> {
	let lastNote = "";
	for (let i = 0; i < lookbackDays; i++) {
		const td = getTaipeiYYYYMMDDMinusDaysFromToday(i);
		const start = finMindDateMinusCalendarDays(td, 45);
		if (start === null) {
			lastNote = `bad td ${td}`;
			continue;
		}
		const got = await fetchFinMindTaiexSeriesForRange(env, start, td);
		if (!got.ok) {
			lastNote = got.note;
			continue;
		}
		const built = buildFinMindTaiexLegacySummaryForTradeDate(got.series, td);
		if (built === null) {
			lastNote = `no TAIEX row for ${td}`;
			continue;
		}
		return {
			ok: true,
			tradeDateYyyymmdd: td,
			rawText: got.rawText,
			legacySummary: built.legacySummary,
		};
	}
	return { ok: false, note: lastNote || "FinMind TAIEX range empty" };
}
