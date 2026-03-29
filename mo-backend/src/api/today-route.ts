import type { Env } from "../types/env.js";
import {
	deriveMoLiveDataGovernanceTyped,
	type MoLiveSnapshotRow,
} from "../mo/governance.js";
import { parseIndexDailyPctFromMoLivePayloadSummary } from "../mo/live-index-daily-pct.js";
import { getTaipeiYYYYMMDDMinusDaysFromToday } from "../../scripts/dev-check.js";
import { formatIsoToTaipeiDateTime } from "./taipei-time.js";
import {
	recommendationStanceLabelZh,
	recommendationConfidenceLabelZh,
	tradeDateYyyymmddToLabelZh,
} from "./today-display-zh.js";
import type { TodayApiErrorBody, TodayApiResponse } from "./today-types.js";

const JSON_UTF8 = "application/json; charset=utf-8";

/**
 * GET `/api/today`：從 D1 `mo_live_market_snapshots` 讀取最新快照，
 * 組裝 TodayApiResponse 回傳；路徑不符回 null。
 */
export async function tryHandleTodayApiRequest(
	request: Request,
	env: Env
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== "/api/today") {
		return null;
	}

	if (request.method !== "GET") {
		const errBody: TodayApiErrorBody = {
			ok: false,
			error: "method_not_allowed",
			allowedMethods: ["GET"],
		};
		return new Response(JSON.stringify(errBody), {
			status: 405,
			headers: {
				"Content-Type": JSON_UTF8,
				Allow: "GET",
			},
		});
	}

	try {
		const generatedAt = new Date().toISOString();

		// 1. D1 查詢：取最新一筆快照
		const rawRow = await env.MO_DB.prepare(
			`SELECT id, trade_date, source, payload_summary, created_at
			 FROM mo_live_market_snapshots
			 ORDER BY id DESC LIMIT 1`
		).first<Record<string, unknown>>();

		// 2. 查無資料 → 503
		if (rawRow === null) {
			const errBody: TodayApiErrorBody = {
				ok: false,
				error: "no_live_data",
				message: "尚無 mo_live_market_snapshots 資料，請等待下一輪 cron 填入。",
				generatedAt,
			};
			return new Response(JSON.stringify(errBody), {
				status: 503,
				headers: { "Content-Type": JSON_UTF8, "Cache-Control": "no-store" },
			});
		}

		// 3. 型別安全轉換
		const row = dbRecordToSnapshotRow(rawRow);
		if (row === null) {
			const errBody: TodayApiErrorBody = {
				ok: false,
				error: "today_internal_error",
				message: "D1 列資料欄位缺失或型別不符。",
				generatedAt,
			};
			return new Response(JSON.stringify(errBody), {
				status: 500,
				headers: { "Content-Type": JSON_UTF8 },
			});
		}

		// 4. Governance
		const todayYyyymmdd = getTaipeiYYYYMMDDMinusDaysFromToday(0);
		const governance = deriveMoLiveDataGovernanceTyped(row, Date.now(), todayYyyymmdd);

		// 5. indexDailyPct
		const pctResult = parseIndexDailyPctFromMoLivePayloadSummary(row.payload_summary);
		const indexDailyPct: number | null = pctResult.value ?? null;

		// 6. Recommendation（目前固定 observe_only/medium，後續可接 recommendation engine）
		const mode = "observe_only" as const;
		const confidence = "medium" as const;
		const headlineZh = "今日投資建議重點";
		const summaryZh =
			"綜合目前可得之市場與治理狀態，建議以「穩健觀察」為主：" +
			"先釐清自身資金與風險承受度，再決定是否調整部位；" +
			"若環境快速變化，請優先確認資料時效與自身限制。";

		const body: TodayApiResponse = {
			ok: true,
			generatedAt,
			data: {
				tradeDate: row.trade_date,
				market: {
					source: row.source,
					summaryText: `大盤資料來源：${row.source}`,
					indexDailyPct,
					freshnessMinutes: governance.freshnessMinutes ?? null,
					stalenessLevel: governance.stalenessLevel,
				},
				governance: {
					decisionEligible: governance.decisionEligible,
					dataUsability: governance.dataUsability,
					pushEligible: governance.pushEligible,
				},
				recommendation: {
					mode,
					confidence,
					headline: headlineZh,
					summary: summaryZh,
					display: {
						headlineZh,
						summaryZh,
						stanceLabelZh: recommendationStanceLabelZh(mode),
						confidenceLabelZh: recommendationConfidenceLabelZh(confidence),
					},
				},
				report: {
					available: true,
					headline: "報告區塊",
				},
				notifications: {
					unreadCount: 0,
				},
				display: {
					generatedAtTaipei: formatIsoToTaipeiDateTime(generatedAt),
					tradeDateLabelZh: tradeDateYyyymmddToLabelZh(row.trade_date),
				},
			},
		};

		return new Response(JSON.stringify(body), {
			status: 200,
			headers: {
				"Content-Type": JSON_UTF8,
				"Cache-Control": "no-store",
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const errBody: TodayApiErrorBody = {
			ok: false,
			error: "today_internal_error",
			message,
			generatedAt: new Date().toISOString(),
		};
		return new Response(JSON.stringify(errBody), {
			status: 500,
			headers: { "Content-Type": JSON_UTF8 },
		});
	}
}

function dbRecordToSnapshotRow(r: Record<string, unknown>): MoLiveSnapshotRow | null {
	const td = r.trade_date;
	const src = r.source;
	const ps = r.payload_summary;
	const ca = r.created_at;
	if (
		typeof td !== "string" ||
		typeof src !== "string" ||
		typeof ps !== "string" ||
		typeof ca !== "string"
	) {
		return null;
	}
	let idNum: number | undefined;
	const rid = r.id;
	if (typeof rid === "number" && Number.isFinite(rid)) {
		idNum = rid;
	} else if (typeof rid === "bigint") {
		idNum = Number(rid);
	}
	return { id: idNum, trade_date: td, source: src, payload_summary: ps, created_at: ca };
}
