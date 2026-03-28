export type IntentKind = "report" | "recommendation" | "status";

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
	};
}
