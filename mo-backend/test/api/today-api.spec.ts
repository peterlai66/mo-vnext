import { describe, it, expect } from "vitest";
import { tryHandleTodayApiRequest } from "../../src/api/today-route.js";
import { buildTodayApiStubResponse } from "../../src/api/today-stub-builder.js";
import type { TodayApiResponse } from "../../src/api/today-types.js";

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

describe("Today API `/api/today`（白盒，Node pool）", () => {
	it("buildTodayApiStubResponse：欄位 mapping 與治理／recommendation 語彙一致", () => {
		const fixed = buildTodayApiStubResponse(1_717_000_000_000);
		expect(fixed.ok).toBe(true);
		expect(fixed.generatedAt).toBe("2024-05-29T16:26:40.000Z");
		expect(fixed.data.tradeDate).toBe("20260328");
		expect(fixed.data.governance.dataUsability).toBe("decision_ok");
		expect(fixed.data.governance.decisionEligible).toBe(true);
		expect(fixed.data.governance.pushEligible).toBe(false);
		expect(fixed.data.recommendation.mode).toBe("observe_only");
		expect(fixed.data.recommendation.confidence).toBe("medium");
		expect(fixed.data.recommendation.display.headlineZh.length).toBeGreaterThan(0);
		expect(fixed.data.display.tradeDateLabelZh).toMatch(/\d{4}\/\d{2}\/\d{2}/);
		expect(fixed.data.market.stalenessLevel).toBe("fresh");
		assertTodaySuccessShape(fixed);
	});

	it("tryHandleTodayApiRequest：GET 成功、Content-Type 為 JSON", async () => {
		const res = tryHandleTodayApiRequest(new Request("https://example.com/api/today", { method: "GET" }));
		expect(res).not.toBeNull();
		const ct = res!.headers.get("Content-Type") ?? "";
		expect(ct).toMatch(/^application\/json/i);
		expect(ct.toLowerCase()).toContain("charset=utf-8");
		const json: unknown = JSON.parse(await res!.text());
		assertTodaySuccessShape(json);
	});

	it("tryHandleTodayApiRequest：POST 回 405 與 Allow: GET", async () => {
		const res = tryHandleTodayApiRequest(
			new Request("https://example.com/api/today", { method: "POST", body: "{}" })
		);
		expect(res!.status).toBe(405);
		expect(res!.headers.get("Allow")).toBe("GET");
		const ct = res!.headers.get("Content-Type") ?? "";
		expect(ct).toMatch(/^application\/json/i);
		const j = JSON.parse(await res!.text()) as { ok: boolean; error: string };
		expect(j.ok).toBe(false);
		expect(j.error).toBe("method_not_allowed");
	});

	it("tryHandleTodayApiRequest：其他路徑回 null（不攔截）", () => {
		expect(tryHandleTodayApiRequest(new Request("https://example.com/api/today/extra"))).toBeNull();
		expect(tryHandleTodayApiRequest(new Request("https://example.com/status"))).toBeNull();
	});
});
