export type IntentKind = "report" | "recommendation" | "status";

/** Recommendation follow-up（僅 intent=recommendation 時有意義；其餘一律 none） */
export type RecommendationFollowUpIntent =
	| "none"
	| "ask_more_candidates"
	| "ask_why"
	| "ask_ticker"
	| "ask_risk"
	| "ask_action"
	| "ask_timing";

export type IntentParseResult = {
	intent: IntentKind;
	userId: string;
	context: {
		hasPortfolio: boolean;
		riskPreference: "normal";
	};
	options: {
		mode: "latest";
	};
	followUpIntent: RecommendationFollowUpIntent;
};

/** MO Input Schema（與 IntentParseResult 對齊；僅由 buildMoInputFromIntent 產出） */
export type MoInput = {
	intent: IntentKind;
	userId: string;
	context: {
		hasPortfolio: boolean;
		riskPreference: "normal";
	};
	options: {
		mode: "latest";
	};
	followUpIntent: RecommendationFollowUpIntent;
};

export function buildMoInputFromIntent(intentResult: IntentParseResult): MoInput {
	return {
		intent: intentResult.intent,
		userId: intentResult.userId,
		context: {
			hasPortfolio: intentResult.context.hasPortfolio,
			riskPreference: intentResult.context.riskPreference,
		},
		options: {
			mode: intentResult.options.mode,
		},
		followUpIntent:
			intentResult.intent === "recommendation" ? intentResult.followUpIntent : "none",
	};
}

export function intentFallbackResult(userId: string): IntentParseResult {
	return {
		intent: "status",
		userId,
		context: {
			hasPortfolio: true,
			riskPreference: "normal",
		},
		options: {
			mode: "latest",
		},
		followUpIntent: "none",
	};
}

export function isIntentKind(s: string): s is IntentKind {
	return s === "report" || s === "recommendation" || s === "status";
}

export function normalizeIntentPayload(
	raw: unknown,
	userId: string
): IntentParseResult | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const o = raw as Record<string, unknown>;
	const irRaw = o.intent;
	if (typeof irRaw !== "string") {
		return null;
	}
	const ir = irRaw.trim().toLowerCase();
	if (!isIntentKind(ir)) {
		return null;
	}
	let hasPortfolio = true;
	const ctx = o.context;
	if (typeof ctx === "object" && ctx !== null) {
		const c = ctx as Record<string, unknown>;
		if (typeof c.hasPortfolio === "boolean") {
			hasPortfolio = c.hasPortfolio;
		}
	}
	let followUpIntent: RecommendationFollowUpIntent = "none";
	const fuRaw = o.followUpIntent;
	if (typeof fuRaw === "string") {
		const f = fuRaw.trim();
		if (
			f === "none" ||
			f === "ask_more_candidates" ||
			f === "ask_why" ||
			f === "ask_ticker" ||
			f === "ask_risk" ||
			f === "ask_action" ||
			f === "ask_timing"
		) {
			followUpIntent = f;
		}
	}
	if (ir !== "recommendation") {
		followUpIntent = "none";
	}

	return {
		intent: ir,
		userId,
		context: {
			hasPortfolio,
			riskPreference: "normal",
		},
		options: {
			mode: "latest",
		},
		followUpIntent,
	};
}
