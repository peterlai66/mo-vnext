import { describe, it, expect } from "vitest";
import { tryHandleTodayApiRequest } from "../../src/api/today-route.js";
import { buildTodayApiStubResponse } from "../../src/api/today-stub-builder.js";
import type { TodayApiResponse } from "../../src/api/today-types.js";
import type { Env } from "../../src/types/env.js";

const USABILITY = new Set(["display_only", "decision_ok", "push_ok", "unusable"]);
const STALENESS = new Set(["fresh", "aging", "stale", "too_old"]);
const MODES = new Set(["actionable", "actionable_with_caution", "observe_only", "blocked"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

function assertTodaySuccessShape(body: unknown): asserts body is TodayApiResponse {
	expect(body).toEqual(expect.objectContaining({ ok: true }));
	if (typeof body !== "object" || body === null) throw new Error("not object");
	const o = body as Record<string, unknown>;
	expect(typeof o.generatedAt).toBe("string");
	expect(o.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	expect(o.data).toEqual(expect.any(Object));
	const d = o.data as Record<string, unknown>;
	expect(typeof d.tradeDate).toBe("string");
	expect(d.market).toEqual(expect.any(Object));
	expect(d.governance).toEqual(expect.any(Object));
	expect(d.recommendation).toEqual(expect.any(Object));
	expect(d.report).toEqual(expect.any(Object));
	expect(d.notifications).toEqual(expect.any(Object));

	const m = d.market as Record<string, unknown>;
	expect(typeof m.source).toBe("string");
	expect(typeof m.summaryText).toBe("string");
	expect(m.indexDailyPct === null || typeof m.indexDailyPct === "number").toBe(true);
	expect(m.freshnessMinutes === null || typeof m.freshnessMinutes === "number").toBe(true);
	expect(STALENESS.has(String(m.stalenessLevel))).toBe(true);

	const g = d.governance as Record<string, unknown>;
	expect(typeof g.decisionEligible).toBe("boolean");
	expect(USABILITY.has(String(g.dataUsability))).toBe(true);
	expect(typeof g.pushEligible).toBe("boolean");

	const r = d.recommendation as Record<string, unknown>;
	expect(MODES.has(String(r.mode))).toBe(true);
	expect(CONFIDENCE.has(String(r.confidence))).toBe(true);
	expect(typeof r.headline).toBe("string");
	expect(typeof r.summary).toBe("string");
	const rd = r.display as Record<string, unknown>;
	expect(typeof rd.headlineZh).toBe("string");
	expect(typeof rd.summaryZh).toBe("string");
	expect(typeof rd.stanceLabelZh).toBe("string");
	expect(typeof rd.confidenceLabelZh).toBe("string");

	const disp = d.display as Record<string, unknown>;
	expect(typeof disp.generatedAtTaipei).toBe("string");
	expect(typeof disp.tradeDateLabelZh).toBe("string");

	const rep = d.report as Record<string, unknown>;
	expect(typeof rep.available).toBe("boolean");
	expect(typeof rep.headline).toBe("string");

	const n = d.notifications as Record<string, unknown>;
	expect(typeof n.unreadCount).toBe("number");
}

/** D1 stub：回傳一列或 null（模擬 first() 行為） */
function makeD1Stub(row: Record<string, unknown> | null): D1Database {
	return {
		prepare: () => ({
			first: () => Promise.resolve(row),
			bind: function () {
				return this;
			},
		}),
	} as unknown as D1Database;
}

function makeEnv(d1Row: Record<string, unknown> | null): Env {
	return { MO_DB: makeD1Stub(d1Row) } as unknown as Env;
}

const VALID_ROW = {
	id: 1,
	trade_date: "20260328",
	source: "twse_mi_index",
	payload_summary: "indexDailyPct:0.34",
	created_at: "2026-03-29T10:00:00.000Z",
};

describe("Today API `/api/today`（白盒，Node pool）", () => {
	it("buildTodayApiStubResponse：欄位 mapping 正確（stub 保留供緊急參考）", () => {
		const fixed = buildTodayApiStubResponse(1_717_000_000_000);
		expect(fixed.ok).toBe(true);
		expect(fixed.generatedAt).toBe("2024-05-29T16:26:40.000Z");
		expect(fixed.data.tradeDate).toBe("20260328");
		expect(fixed.data.governance.dataUsability).toBe("decision_ok");
		expect(fixed.data.recommendation.display.headlineZh.length).toBeGreaterThan(0);
		expect(fixed.data.display.tradeDateLabelZh).toMatch(/\d{4}\/\d{2}\/\d{2}/);
		assertTodaySuccessShape(fixed);
	});

	it("tryHandleTodayApiRequest：是 async function", () => {
		const fn = tryHandleTodayApiRequest;
		const result = fn(new Request("https://x.com/api/today"), makeEnv(VALID_ROW));
		expect(result instanceof Promise).toBe(true);
		return result;
	});

	it("tryHandleTodayApiRequest：GET + D1 有資料 → 200 + success shape（market.source 無 stub）", async () => {
		const env = makeEnv(VALID_ROW);
		const res = await tryHandleTodayApiRequest(
			new Request("https://example.com/api/today", { method: "GET" }),
			env
		);
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
		const ct = res!.headers.get("Content-Type") ?? "";
		expect(ct).toMatch(/^application\/json/i);
		const json: unknown = JSON.parse(await res!.text());
		assertTodaySuccessShape(json);
		const data = (json as TodayApiResponse).data;
		expect(data.market.source).toBe("twse_mi_index");
		expect(data.market.source).not.toContain("stub");
		expect(data.tradeDate).toBe("20260328");
	});

	it("tryHandleTodayApiRequest：D1 查無資料 → 503 + ok:false + error:no_live_data", async () => {
		const env = makeEnv(null);
		const res = await tryHandleTodayApiRequest(
			new Request("https://example.com/api/today", { method: "GET" }),
			env
		);
		expect(res!.status).toBe(503);
		const j = JSON.parse(await res!.text()) as { ok: boolean; error: string };
		expect(j.ok).toBe(false);
		expect(j.error).toBe("no_live_data");
	});

	it("tryHandleTodayApiRequest：POST → 405 + Allow: GET", async () => {
		const env = makeEnv(null);
		const res = await tryHandleTodayApiRequest(
			new Request("https://example.com/api/today", { method: "POST", body: "{}" }),
			env
		);
		expect(res!.status).toBe(405);
		expect(res!.headers.get("Allow")).toBe("GET");
		const j = JSON.parse(await res!.text()) as { ok: boolean; error: string };
		expect(j.ok).toBe(false);
		expect(j.error).toBe("method_not_allowed");
	});

	it("tryHandleTodayApiRequest：其他路徑回 null", async () => {
		const env = makeEnv(null);
		expect(
			await tryHandleTodayApiRequest(new Request("https://example.com/api/today/extra"), env)
		).toBeNull();
		expect(
			await tryHandleTodayApiRequest(new Request("https://example.com/status"), env)
		).toBeNull();
	});
});
