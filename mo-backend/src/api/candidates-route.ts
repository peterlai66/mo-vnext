import type { Env } from "../index.js";
import { buildCandidatesApiResponse, type CandidatesPushContext } from "./candidates-builder.js";
import type { CandidatesApiErrorBody } from "./candidates-types.js";

const JSON_UTF8 = "application/json; charset=utf-8";

export type CandidatesApiDeps = {
	/** 與 `/status` ETF 區塊同源：由 index 注入 `computeMoPushEvaluationForUser` 結果 */
	loadPushContext: (e: Env) => Promise<CandidatesPushContext>;
};

/**
 * GET `/api/candidates`：與 `/status` 同源之 push 評估上下文 + ETF pipeline 組裝。
 */
export async function tryHandleCandidatesApiRequest(
	request: Request,
	env: Env,
	deps: CandidatesApiDeps
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== "/api/candidates") {
		return null;
	}

	if (request.method === "GET") {
		return buildCandidatesApiResponse(env, deps.loadPushContext);
	}

	const errBody: CandidatesApiErrorBody = {
		ok: false,
		error: "method_not_allowed",
		allowedMethods: ["GET"],
		generatedAt: new Date().toISOString(),
	};
	return new Response(JSON.stringify(errBody), {
		status: 405,
		headers: {
			"Content-Type": JSON_UTF8,
			Allow: "GET",
		},
	});
}
