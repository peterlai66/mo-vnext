import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "./index.js";

describe("mo-web Worker fetch（proxy / assets 責任邊界）", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("/api/report-preview?userId=p 先命中 proxy，rewrite 為 /admin/report-preview 並保留 query", async () => {
		const upstream = vi.fn(async () =>
			new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);
		globalThis.fetch = upstream as unknown as typeof fetch;

		const env = {
			MO_BACKEND_ORIGIN: "https://backend.example.com",
			ASSETS: { fetch: vi.fn() },
		};

		const req = new Request(
			"https://mo-web.test/api/report-preview?userId=p&x=1"
		);
		const res = await worker.fetch(req, env as never);

		expect(env.ASSETS.fetch).not.toHaveBeenCalled();
		expect(upstream).toHaveBeenCalledTimes(1);
		const first = upstream.mock.calls[0];
		const calledUrl = first?.[0] as string;
		const init = first?.[1] as RequestInit | undefined;
		expect(calledUrl).toBe(
			"https://backend.example.com/admin/report-preview?userId=p&x=1"
		);
		expect(init.method).toBe("GET");
		const outH = init?.headers as Headers | undefined;
		expect(outH?.get("host")).toBeNull();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	it("/api/today、/api/candidates pathname 直通 backend", async () => {
		const upstream = vi.fn(async () =>
			new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
		);
		globalThis.fetch = upstream as unknown as typeof fetch;

		const env = {
			MO_BACKEND_ORIGIN: "https://be.test",
			ASSETS: { fetch: vi.fn() },
		};

		await worker.fetch(new Request("https://h/api/today"), env as never);
		expect(upstream.mock.calls[0]?.[0] as string).toBe(
			"https://be.test/api/today"
		);

		upstream.mockClear();
		await worker.fetch(
			new Request("https://h/api/candidates?q=1"),
			env as never
		);
		expect(upstream.mock.calls[0]?.[0] as string).toBe(
			"https://be.test/api/candidates?q=1"
		);
	});

	it("非 /api/* 走 env.ASSETS.fetch，不呼叫 upstream fetch", async () => {
		const upstream = vi.fn();
		globalThis.fetch = upstream as unknown as typeof fetch;

		const assetsFetch = vi.fn(async () => new Response("<html></html>", { status: 200 }));
		const env = {
			MO_BACKEND_ORIGIN: "https://be.test",
			ASSETS: { fetch: assetsFetch },
		};

		const req = new Request("https://mo-web.test/");
		const res = await worker.fetch(req, env as never);

		expect(assetsFetch).toHaveBeenCalledWith(req);
		expect(upstream).not.toHaveBeenCalled();
		expect(res.status).toBe(200);
	});

	it("未設定 MO_BACKEND_ORIGIN 時 /api/* 回 503 JSON，不呼叫 ASSETS", async () => {
		const upstream = vi.fn();
		globalThis.fetch = upstream as unknown as typeof fetch;

		const assetsFetch = vi.fn();
		const env = { ASSETS: { fetch: assetsFetch } };

		const res = await worker.fetch(
			new Request("https://h/api/today"),
			env as never
		);

		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			ok: false,
			error: "mo_backend_origin_not_configured",
		});
		expect(assetsFetch).not.toHaveBeenCalled();
		expect(upstream).not.toHaveBeenCalled();
	});
});
