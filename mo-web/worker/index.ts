/**
 * 本輪 Today：`/api/today` 可轉發至 mo-backend（`wrangler vars` 或 dashboard 設定 MO_BACKEND_ORIGIN）。
 * 未設定時回 503 JSON，供前端 error 態驗證；`vite dev` 則由 vite.config proxy 直連本機 backend。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const backendOrigin = (env as Env & { MO_BACKEND_ORIGIN?: string }).MO_BACKEND_ORIGIN?.trim();
    const base = backendOrigin?.endsWith("/") ? backendOrigin.slice(0, -1) : backendOrigin;

    function moBackendTargetPath(pathname: string): string | null {
      if (pathname === "/api/today" || pathname === "/api/candidates") return pathname;
      if (pathname === "/api/report-preview") return "/admin/report-preview";
      return null;
    }

    const mappedPath = moBackendTargetPath(url.pathname);
    if (mappedPath !== null && base) {
      const target = `${base}${mappedPath}${url.search}`;
      const upstream = await fetch(target, {
        method: request.method,
        headers: request.headers,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    }
    if (mappedPath !== null && !backendOrigin) {
      return Response.json(
        {
          ok: false,
          error: "mo_backend_origin_not_configured",
          message: "請設定 MO_BACKEND_ORIGIN 指向 mo-backend，或使用 vite dev 的 proxy。",
        },
        {
          status: 503,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({
        name: "Cloudflare",
      });
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
