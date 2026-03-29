import { buildNotificationsApiResponse } from "./notifications-builder.js";
import type { NotificationsApiErrorBody } from "./notifications-types.js";

const JSON_UTF8 = "application/json; charset=utf-8";

/**
 * GET `/api/notifications`：最小通知 feed。非 GET 回 405。
 */
export function tryHandleNotificationsApiRequest(request: Request): Response | null {
	const url = new URL(request.url);
	if (url.pathname !== "/api/notifications") {
		return null;
	}

	if (request.method === "GET") {
		try {
			const body = buildNotificationsApiResponse();
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: {
					"Content-Type": JSON_UTF8,
					"Cache-Control": "no-store",
				},
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const errBody: NotificationsApiErrorBody = {
				ok: false,
				error: "notifications_internal_error",
				message,
				generatedAt: new Date().toISOString(),
			};
			return new Response(JSON.stringify(errBody), {
				status: 500,
				headers: { "Content-Type": JSON_UTF8 },
			});
		}
	}

	const errBody: NotificationsApiErrorBody = {
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
