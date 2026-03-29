import { DEFAULT_TW_ETF_UNIVERSE_V1 } from "./etf-universe.js";
import type { EtfRawLoaderRow, MoEtfFetchEnv } from "./etf-types.js";

function yyyymmddToFinMindDate(yyyymmdd: string): string | null {
	if (!/^\d{8}$/u.test(yyyymmdd)) return null;
	return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function shiftYyyymmdd(yyyymmdd: string, deltaDays: number): string | null {
	if (!/^\d{8}$/u.test(yyyymmdd)) return null;
	const y = Number(yyyymmdd.slice(0, 4));
	const m = Number(yyyymmdd.slice(4, 6)) - 1;
	const d = Number(yyyymmdd.slice(6, 8));
	const t = Date.UTC(y, m, d) + deltaDays * 24 * 60 * 60 * 1000;
	const dt = new Date(t);
	const yy = String(dt.getUTCFullYear());
	const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(dt.getUTCDate()).padStart(2, "0");
	return `${yy}${mm}${dd}`;
}

function parseNumberish(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function extractFinMindDataRows(parsed: unknown): Record<string, unknown>[] | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const o = parsed as Record<string, unknown>;
	if (o.msg === "error") return null;
	const data = o.data;
	if (!Array.isArray(data)) return null;
	return data.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
}

/**
 * 自 FinMind TaiwanStockPrice 取一段日線（含 endYyyymmdd），用於 close 與前一日收盤。
 */
export async function fetchFinMindEtfDailyRange(
	env: MoEtfFetchEnv,
	universeId: string,
	displayName: string,
	endYyyymmdd: string
): Promise<EtfRawLoaderRow> {
	const token = env.FINMIND_TOKEN?.trim();
	if (token === undefined || token === "") {
		return {
			universeId,
			displayName,
			tradeDate: null,
			close: null,
			previousClose: null,
			volume: null,
			source: "finmind_unavailable",
			fetchOk: false,
			fetchNote: "FINMIND_TOKEN unset",
		};
	}

	const endD = yyyymmddToFinMindDate(endYyyymmdd);
	const startRaw = shiftYyyymmdd(endYyyymmdd, -14);
	const startD = startRaw === null ? null : yyyymmddToFinMindDate(startRaw);
	if (endD === null || startD === null) {
		return {
			universeId,
			displayName,
			tradeDate: null,
			close: null,
			previousClose: null,
			volume: null,
			source: "finmind",
			fetchOk: false,
			fetchNote: "invalid date range",
		};
	}

	const params = new URLSearchParams({
		dataset: "TaiwanStockPrice",
		data_id: universeId,
		start_date: startD,
		end_date: endD,
		token,
	});
	const url = `https://api.finmindtrade.com/api/v4/data?${params.toString()}`;
	try {
		const res = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; MO-vNext/1.0; ETF-universe-v1)",
			},
			signal: AbortSignal.timeout(12_000),
		});
		const text = await res.text();
		if (!res.ok) {
			return {
				universeId,
				displayName,
				tradeDate: null,
				close: null,
				previousClose: null,
				volume: null,
				source: "finmind",
				fetchOk: false,
				fetchNote: `http ${String(res.status)}`,
			};
		}
		let j: unknown;
		try {
			j = JSON.parse(text) as unknown;
		} catch {
			return {
				universeId,
				displayName,
				tradeDate: null,
				close: null,
				previousClose: null,
				volume: null,
				source: "finmind",
				fetchOk: false,
				fetchNote: "json parse error",
			};
		}
		const rows = extractFinMindDataRows(j);
		if (rows === null || rows.length === 0) {
			return {
				universeId,
				displayName,
				tradeDate: null,
				close: null,
				previousClose: null,
				volume: null,
				source: "finmind",
				fetchOk: false,
				fetchNote: "empty data",
			};
		}

		const dated = rows
			.map((r) => {
				const dr = r.date;
				const ds =
					typeof dr === "string" ? dr.replace(/-/gu, "") : "";
				return { ds, r };
			})
			.filter((x) => /^\d{8}$/u.test(x.ds))
			.sort((a, b) => a.ds.localeCompare(b.ds));

		if (dated.length === 0) {
			return {
				universeId,
				displayName,
				tradeDate: null,
				close: null,
				previousClose: null,
				volume: null,
				source: "finmind",
				fetchOk: false,
				fetchNote: "no dated rows",
			};
		}

		const last = dated[dated.length - 1];
		const prev = dated.length >= 2 ? dated[dated.length - 2] : null;

		const close = parseNumberish(last.r.close);
		const prevClose = prev !== null ? parseNumberish(prev.r.close) : null;
		const vol =
			parseNumberish(last.r.Trading_Volume) ??
			parseNumberish(last.r.trading_money) ??
			parseNumberish(last.r.volume);

		return {
			universeId,
			displayName,
			tradeDate: last.ds,
			close,
			previousClose: prevClose,
			volume: vol,
			source: "finmind",
			fetchOk: true,
			fetchNote: "ok",
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			universeId,
			displayName,
			tradeDate: null,
			close: null,
			previousClose: null,
			volume: null,
			source: "finmind",
			fetchOk: false,
			fetchNote: msg,
		};
	}
}

/** 並行載入內建 universe 於指定交易日（曆日 endYyyymmdd；FinMind 無資料時該檔 fetchOk=false） */
export async function loadTwEtfUniverseFromFinMind(
	env: MoEtfFetchEnv,
	endYyyymmdd: string
): Promise<readonly EtfRawLoaderRow[]> {
	const tasks = DEFAULT_TW_ETF_UNIVERSE_V1.map((e) =>
		fetchFinMindEtfDailyRange(env, e.id, e.name, endYyyymmdd)
	);
	return Promise.all(tasks);
}
