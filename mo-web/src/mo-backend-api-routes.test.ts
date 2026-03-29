import { describe, it, expect } from "vitest";
import {
	MO_BACKEND_API_PATH_BY_INCOMING,
	resolveBackendPathForMoProxy,
	resolveMoBackendPathname,
} from "../worker/mo-backend-api-routes.ts";

describe("mo-backend API route map（與 Worker / Vite proxy 一致）", () => {
	it("/api/report-preview rewrite 為 /admin/report-preview", () => {
		expect(resolveMoBackendPathname("/api/report-preview")).toBe("/admin/report-preview");
		expect(MO_BACKEND_API_PATH_BY_INCOMING["/api/report-preview"]).toBe("/admin/report-preview");
	});

	it("/api/today、/api/candidates、/api/notifications 不 rewrite", () => {
		expect(resolveMoBackendPathname("/api/today")).toBe("/api/today");
		expect(resolveMoBackendPathname("/api/candidates")).toBe("/api/candidates");
		expect(resolveMoBackendPathname("/api/notifications")).toBe("/api/notifications");
	});

	it("未列管 path 回 null", () => {
		expect(resolveMoBackendPathname("/api/unknown")).toBeNull();
		expect(resolveMoBackendPathname("/api/report-preview/extra")).toBeNull();
	});

	it("search 由呼叫端拼接 URL（此函式僅 pathname）", () => {
		expect(resolveMoBackendPathname("/api/report-preview")).toBe("/admin/report-preview");
	});

	it("resolveBackendPathForMoProxy：未列管 /api/* 維持原 path", () => {
		expect(resolveBackendPathForMoProxy("/api/future-endpoint")).toBe("/api/future-endpoint");
	});
});
