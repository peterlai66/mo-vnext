import type { MoLiveSnapshotRow } from "./governance.js";
import {
	buildRecommendationStubResult,
	type RecommendationStubCandidate,
} from "./recommendation-engine-stub.js";

/** Unified row shape for recommendation pipeline (stub + loader). */
export type RecommendationCandidate = RecommendationStubCandidate;

export type RecommendationCandidateLoadSource = "real_loader" | "stub_engine";

export type RecommendationCandidateLoadResult = {
	source: RecommendationCandidateLoadSource;
	ready: boolean;
	candidateCount: number;
	candidates: readonly RecommendationCandidate[];
	notes: readonly string[];
};

/** Aligns with mo_live payload_summary v2 (same contract as Worker parse). */
type MoLiveSummaryV2 = {
	v: 2;
	source: string;
	sourceLevel: "primary" | "fallback1" | "fallback2";
	fetchStatus: "success" | "fallback_used" | "unavailable";
	confidence: "high" | "medium" | "low";
	rawAvailabilityNote: string;
	legacySummary: string;
};

function isMoLiveSummaryV2(x: unknown): x is MoLiveSummaryV2 {
	if (typeof x !== "object" || x === null) return false;
	const o = x as Record<string, unknown>;
	if (o.v !== 2) return false;
	if (typeof o.source !== "string") return false;
	if (
		o.sourceLevel !== "primary" &&
		o.sourceLevel !== "fallback1" &&
		o.sourceLevel !== "fallback2"
	) {
		return false;
	}
	if (
		o.fetchStatus !== "success" &&
		o.fetchStatus !== "fallback_used" &&
		o.fetchStatus !== "unavailable"
	) {
		return false;
	}
	if (o.confidence !== "high" && o.confidence !== "medium" && o.confidence !== "low") {
		return false;
	}
	if (typeof o.rawAvailabilityNote !== "string") return false;
	if (typeof o.legacySummary !== "string") return false;
	return true;
}

function parseMoLivePayloadSummaryV2(raw: string): MoLiveSummaryV2 | null {
	const t = raw.trim();
	if (!t.startsWith("{")) return null;
	try {
		const parsed: unknown = JSON.parse(t);
		return isMoLiveSummaryV2(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function parseCloseFromLegacy(legacy: string): string | null {
	const m = /close=([\d.]+)/u.exec(legacy);
	return m !== null ? m[1] : null;
}

function tryCandidatesFromMoLiveRow(row: MoLiveSnapshotRow): RecommendationCandidate[] | null {
	const v2 = parseMoLivePayloadSummaryV2(row.payload_summary);
	if (v2 === null) return null;
	if (v2.fetchStatus === "unavailable") return null;
	const closeStr = parseCloseFromLegacy(v2.legacySummary);
	if (closeStr === null) return null;
	const closeNum = Number(closeStr);
	if (!Number.isFinite(closeNum)) return null;

	const leg = v2.legacySummary;
	const isTaiex =
		/data_id=TAIEX/u.test(leg) ||
		/finmind=TaiwanStockPrice/u.test(leg) ||
		/TAIEX/u.test(leg);
	const isTwseOpenApi = /twse_openapi/u.test(leg);

	const symbol = isTaiex ? "TAIEX" : isTwseOpenApi ? "MI_INDEX" : "INDEX";
	const name = isTaiex
		? "TAIEX index (mo_live)"
		: isTwseOpenApi
			? "TWSE MI_INDEX (mo_live)"
			: "Market snapshot (mo_live)";

	const candidate: RecommendationCandidate = {
		symbol,
		name,
		market: "TW",
		rationale: `mo_live_market_snapshots v2; trade_date=${row.trade_date}; close=${closeStr}; index reference only, not a stock pick or ranking`,
		score: 55,
	};

	return [candidate];
}

function withStubFallbackNotes(stub: ReturnType<typeof buildRecommendationStubResult>): string[] {
	return [...stub.notes, "fallback to stub engine"];
}

export type RecommendationLoaderContext = {
	snapshotRow: MoLiveSnapshotRow | null;
	snapshotReadOk: boolean;
};

export function loadRecommendationCandidates(ctx: RecommendationLoaderContext): RecommendationCandidateLoadResult {
	if (!ctx.snapshotReadOk || ctx.snapshotRow === null) {
		const stub = buildRecommendationStubResult();
		return {
			source: "stub_engine",
			ready: stub.ready,
			candidateCount: stub.candidateCount,
			candidates: stub.candidates,
			notes: withStubFallbackNotes(stub),
		};
	}

	const real = tryCandidatesFromMoLiveRow(ctx.snapshotRow);
	if (real === null || real.length === 0) {
		const stub = buildRecommendationStubResult();
		return {
			source: "stub_engine",
			ready: stub.ready,
			candidateCount: stub.candidateCount,
			candidates: stub.candidates,
			notes: withStubFallbackNotes(stub),
		};
	}

	return {
		source: "real_loader",
		ready: true,
		candidateCount: real.length,
		candidates: real,
		notes: ["real candidate loader enabled (mo_live snapshot)"],
	};
}
