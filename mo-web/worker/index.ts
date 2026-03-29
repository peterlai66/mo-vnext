import {
	resolveBackendPathForMoProxy,
} from "./mo-backend-api-routes.js";

type EnvWithProxy = Env & {
	MO_BACKEND_ORIGIN?: string;
	ASSETS?: { fetch: typeof fetch };
};

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
 * 1) 所有 `/api/*` 優先 proxy（在 ASSETS 之前），避免被 static / SPA 吃掉。
 * 2) 其餘請求交給 `env.ASSETS.fetch`（需 wrangler `run_worker_first` + `binding`）。
 */
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const pathname = url.pathname;

		if (pathname.startsWith("/api/")) {
			const backendOrigin = (env as EnvWithProxy).MO_BACKEND_ORIGIN?.trim();
			const base =
				backendOrigin && backendOrigin.length > 0 ?
					backendOrigin.endsWith("/") ?
						backendOrigin.slice(0, -1)
					:	backendOrigin
				:	undefined;

			if (!base) {
				return backendNotConfiguredResponse();
			}

			const backendPath = resolveBackendPathForMoProxy(pathname);
			const originBase = base.replace(/\/+$/u, "");
			const targetUrl = new URL(`${backendPath}${url.search}`, `${originBase}/`);

			console.log("[proxy] hit", pathname);
			console.log("[proxy] target", targetUrl.href);

			const upstream = await fetch(targetUrl.href, {
				method: request.method,
				headers: request.headers,
			});
			return new Response(upstream.body, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers: upstream.headers,
			});
		}

		const assets = (env as EnvWithProxy).ASSETS;
		if (assets) {
			return assets.fetch(request);
		}
		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
