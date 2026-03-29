/**
 * mo-web Worker ↔ mo-backend 路徑對照（與 vite.config `server.proxy` 一致）。
 * key：瀏覽器請求路徑；value：轉發至 MO_BACKEND_ORIGIN 時使用的 pathname。
 */
export const MO_BACKEND_API_PATH_BY_INCOMING: Readonly<Record<string, string>> = {
	"/api/today": "/api/today",
	"/api/candidates": "/api/candidates",
	"/api/notifications": "/api/notifications",
	"/api/report-preview": "/admin/report-preview",
} as const;

export function resolveMoBackendPathname(incomingPathname: string): string | null {
	const mapped = MO_BACKEND_API_PATH_BY_INCOMING[incomingPathname];
	return mapped !== undefined ? mapped : null;
}

/**
 * 所有 `/api/*` 轉發至 mo-backend 時使用的 pathname：
 * - 有對照表則 rewrite（如 report-preview）
 * - 否則與請求路徑相同
 */
export function resolveBackendPathForMoProxy(incomingPathname: string): string {
	const mapped = MO_BACKEND_API_PATH_BY_INCOMING[incomingPathname];
	return mapped !== undefined ? mapped : incomingPathname;
}
