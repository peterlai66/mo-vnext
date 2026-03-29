import { resolveMoBackendPathname } from "./mo-backend-api-routes.js";

type EnvWithBackend = Env & { MO_BACKEND_ORIGIN?: string };

const JSON_UTF8 = "application/json; charset=utf-8";

function backendNotConfiguredResponse(): Response {
	return Response.json(
		{
			ok: false,
			error: "mo_backend_origin_not_configured",
			message: "請設定 MO_BACKEND_ORIGIN 指向 mo-backend，或使用 vite dev 的 proxy。",
		},
		{ status: 503, headers: { "Content-Type": JSON_UTF8 } }
	);
}

/**
 * 統一 API proxy：僅處理 `MO_BACKEND_API_PATH_BY_INCOMING` 內路徑，其餘 /api/* 維持舊行為。
 */
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const backendOrigin = (env as EnvWithBackend).MO_BACKEND_ORIGIN?.trim();
		const base =
			backendOrigin && backendOrigin.length > 0 ?
				backendOrigin.endsWith("/") ?
					backendOrigin.slice(0, -1)
				:	backendOrigin
			:	undefined;

		const mappedPath = resolveMoBackendPathname(url.pathname);

		if (mappedPath !== null) {
			if (!base) {
				return backendNotConfiguredResponse();
			}
			const originBase = base.replace(/\/+$/u, "");
			const target = new URL(`${mappedPath}${url.search}`, `${originBase}/`);
			const upstream = await fetch(target.href, {
				method: request.method,
				headers: request.headers,
			});
			return new Response(upstream.body, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers: upstream.headers,
			});
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ name: "Cloudflare" });
		}
		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
