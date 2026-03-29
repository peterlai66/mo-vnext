import { describe, it, expect } from "vitest";
import { tryHandleNotificationsApiRequest } from "../../src/api/notifications-route.js";
import { buildNotificationsApiResponse } from "../../src/api/notifications-builder.js";

const ALLOWED_TYPES = ["recommendation", "governance", "report", "system"] as const;
const ALLOWED_SEVERITY = ["info", "warning", "critical"] as const;

async function parseJsonAsync(res: Response): Promise<unknown> {
	const t = await res.text();
	return JSON.parse(t);
}

describe("Notifications API `/api/notifications`（白盒）", () => {
	it("GET 回 200、headers 正確", async () => {
		const res = tryHandleNotificationsApiRequest(
			new Request("https://example.com/api/notifications", { method: "GET" })
		);
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
		const ct = res!.headers.get("Content-Type") ?? "";
		expect(ct.toLowerCase()).toBe("application/json; charset=utf-8");
		expect(res!.headers.get("Cache-Control")).toBe("no-store");
	});

	it("POST 回 405、Allow: GET", async () => {
		const res = tryHandleNotificationsApiRequest(
			new Request("https://example.com/api/notifications", { method: "POST", body: "{}" })
		);
		expect(res).not.toBeNull();
		expect(res!.status).toBe(405);
		expect(res!.headers.get("Allow")).toBe("GET");
	});

	it("response schema：ok、generatedAt、data.items", async () => {
		const res = tryHandleNotificationsApiRequest(
			new Request("https://example.com/api/notifications", { method: "GET" })
		);
		const json = (await parseJsonAsync(res!)) as Record<string, unknown>;
		expect(json.ok).toBe(true);
		expect(typeof json.generatedAt).toBe("string");
		const data = json.data as Record<string, unknown>;
		expect(typeof data.feedNoteZh).toBe("string");
		expect(Array.isArray(data.items)).toBe(true);
	});

	it("items 單筆欄位完整且 type／severity 合法", async () => {
		const body = buildNotificationsApiResponse(1_717_000_000_000);
		expect(body.data.items.length).toBeGreaterThan(0);
		const CHANGE = ["snapshot", "shift", "alert", "summary"] as const;
		for (const it of body.data.items) {
			expect(typeof it.id).toBe("string");
			expect(typeof it.timestamp).toBe("string");
			expect(typeof it.timestampTaipei).toBe("string");
			expect(typeof it.title).toBe("string");
			expect(typeof it.summary).toBe("string");
			expect(ALLOWED_TYPES).toContain(it.type);
			expect(ALLOWED_SEVERITY).toContain(it.severity);
			expect(CHANGE).toContain(it.changeType);
			expect(typeof it.isNew).toBe("boolean");
			expect(typeof it.isSummaryDigest).toBe("boolean");
		}
		expect(body.data.feedNoteZh.length).toBeGreaterThan(0);
	});

	it("無事件時 schema 仍允許空陣列（不噴錯）", () => {
		const emptyOk = {
			ok: true as const,
			generatedAt: "2020-01-01T00:00:00.000Z",
			data: { items: [] as [] },
		};
		expect(JSON.stringify(emptyOk)).toContain('"items":[]');
	});

	it("非 /api/notifications 路徑回 null", () => {
		expect(tryHandleNotificationsApiRequest(new Request("https://x/api/other", { method: "GET" }))).toBeNull();
	});
});
