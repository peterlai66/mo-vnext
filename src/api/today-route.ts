import { buildTodayApiStubResponse } from "./today-stub-builder.js";
import type { TodayApiErrorBody } from "./today-types.js";

const JSON_UTF8 = "application/json; charset=utf-8";

/**
 * GET `/api/today`：組裝層入口。非 GET 回 405；路徑不符回 null 交由既有 fetch 鏈處理。
 */
export function tryHandleTodayApiRequest(request: Request): Response | null {
	const url = new URL(request.url);
	if (url.pathname !== "/api/today") {
		return null;
	}

	if (request.method === "GET") {
		try {
			const body = buildTodayApiStubResponse();
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: {
					"Content-Type": JSON_UTF8,
					"Cache-Control": "no-store",
				},
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const errBody: TodayApiErrorBody = {
				ok: false,
				error: "today_internal_error",
				message,
				generatedAt: new Date().toISOString(),
			};
			return new Response(JSON.stringify(errBody), {
				status: 500,
				headers: { "Content-Type": JSON_UTF8 },
			});
		}
	}

	const errBody: TodayApiErrorBody = {
		ok: false,
		error: "method_not_allowed",
		allowedMethods: ["GET"],
	};
	return new Response(JSON.stringify(errBody), {
		status: 405,
		headers: {
			"Content-Type": JSON_UTF8,
			Allow: "GET",
		},
	});
}
