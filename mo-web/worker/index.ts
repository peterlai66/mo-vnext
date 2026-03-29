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
 * 轉發至 mo-backend：白名單標頭（不帶入 mo-web 的 Host／cf-*／x-forwarded-*）。
 * 不可手動設 `Host`：在 Workers subrequest 上可能觸發錯誤 1042。
 */
function headersForUpstream(request: Request): Headers {
	const h = new Headers();
	const pass = [
		"accept",
		"accept-encoding",
		"accept-language",
		"content-type",
		"authorization",
		"cookie",
	] as const;
	for (const name of pass) {
		const v = request.headers.get(name);
		if (v !== null && v.length > 0) {
			h.set(name, v);
		}
	}
	if (!h.has("accept")) {
		h.set("accept", "*/*");
	}
	return h;
}

/**
 * 1) 所有 `/api/*` 優先 proxy（在 ASSETS 之前），避免被 static / SPA 吃掉。
 * 2) 其餘請求交給 `env.ASSETS.fetch`（需 wrangler `run_worker_first` + `binding`）。
 */
export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/")) {
			// 明確標記：此請求不走 ASSETS／SPA，由 User Worker 轉發（wrangler tail 可辨識）
			console.log("[proxy] bypass-assets", url.pathname);
			const backendOrigin = (env as EnvWithProxy).MO_BACKEND_ORIGIN?.trim();
			const base =
				backendOrigin && backendOrigin.length > 0 ?
					backendOrigin.endsWith("/") ?
						backendOrigin.slice(0, -1)
					:	backendOrigin
				:	undefined;

			if (!base) {
				console.log("[proxy] response", 503, JSON_UTF8, "mo_backend_origin_not_configured");
				return backendNotConfiguredResponse();
			}

			const backendPath = resolveBackendPathForMoProxy(url.pathname);
			const originBase = base.replace(/\/+$/u, "");
			const targetUrl = new URL(`${backendPath}${url.search}`, `${originBase}/`);

			console.log("[proxy] hit", url.pathname);
			console.log("[proxy] target", targetUrl.href);

			const upstreamInit: RequestInit & { duplex?: "half" } = {
				method: request.method,
				headers: headersForUpstream(request),
			};
			if (request.method !== "GET" && request.method !== "HEAD") {
				upstreamInit.body = request.body;
				upstreamInit.duplex = "half";
			}
			const upstream = await fetch(targetUrl.href, upstreamInit);
			const responseCt = upstream.headers.get("content-type") ?? "";
			console.log("[proxy] response", upstream.status, responseCt);
			return new Response(upstream.body, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers: upstream.headers,
			});
		}

		const assets = (env as EnvWithProxy).ASSETS;
		if (assets) {
			console.log("[proxy] assets-fetch", url.pathname);
			return assets.fetch(request);
		}
		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
