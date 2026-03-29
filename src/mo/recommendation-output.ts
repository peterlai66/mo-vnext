import type { MoInput } from "./input.js";
import type { RecommendationPrecheckResult } from "./recommendation-precheck.js";
import {
	buildRecommendationAllocationPlan,
	type RecommendationAllocationPlanItem,
	type RecommendationAllocationPlanResult,
} from "./recommendation-allocation.js";
import type {
	RecommendationCandidate,
	RecommendationCandidateLoadResult,
	RecommendationLoaderContext,
} from "./recommendation-candidate-loader.js";
import {
	rankRecommendationCandidates,
	type RecommendationRankedCandidate,
	type RecommendationRankingResult,
} from "./recommendation-ranking.js";
import { runMoEtfCandidatePipelineV1 } from "./recommendation/etf-pipeline.js";
import type { EtfCandidateGateState, MoEtfFetchEnv } from "./recommendation/etf-types.js";

/** Narrow usability aligned with precheck output (engine may extend later). */
export type RecommendationOutputDataUsability = "decision_ok" | "display_only" | "unusable";

export type RecommendationDecisionStage = "blocked" | "skeleton_ready";

export type RecommendationDecisionReadiness = "blocked" | "ready_for_engine";

export const RECOMMENDATION_DECISION_SOURCE_GOVERNANCE_PRECHECK =
	"governance_precheck" as const;

export type RecommendationDecisionSource =
	typeof RECOMMENDATION_DECISION_SOURCE_GOVERNANCE_PRECHECK;

/** Hook for engine / allocation / simulation; extend fields in one place. */
export type RecommendationDecisionEnvelope = {
	stage: RecommendationDecisionStage;
	readiness: RecommendationDecisionReadiness;
	source: RecommendationDecisionSource;
	candidateCount: number;
	notes: string[];
};

export type RecommendationCandidateStage = "not_loaded" | "placeholder_ready";

export type RecommendationCandidateSource =
	| "none"
	| "recommendation_stub"
	| "recommendation_loader";

export type RecommendationCandidatePlaceholder = {
	stage: RecommendationCandidateStage;
	source: RecommendationCandidateSource;
	count: number;
	items: readonly RecommendationRankedCandidate[];
	notes: string[];
};

export type RecommendationAllocationStage = "not_allocated" | "placeholder_ready";

export type RecommendationAllocationMethodKind =
	| "none"
	| "stub"
	| "blocked"
	| "stub_equal_weight"
	| "stub_single_candidate";

/** Allocation planning slice (stub engine; replace with live allocator later). */
export type RecommendationAllocationPlaceholder = {
	stage: RecommendationAllocationStage;
	method: RecommendationAllocationMethodKind;
	profile: string;
	ready: boolean;
	itemCount: number;
	items: readonly RecommendationAllocationPlanItem[];
	cashRatio: number | null;
	positionRatio: number | null;
	notes: string[];
};

export type RecommendationSimulationReadiness = "not_ready" | "placeholder_ready";

export type RecommendationSimulationSource = "none" | "recommendation_stub";

export type RecommendationSimulationPlaceholder = {
	readiness: RecommendationSimulationReadiness;
	source: RecommendationSimulationSource;
	executable: boolean;
	notes: string[];
};

export type RecommendationPayloadSource = "none" | "stub_engine" | "real_loader" | "etf_universe";

/** Engine-facing slice; ranked candidates for downstream allocation / simulation. */
export type RecommendationPayload = {
	source: RecommendationPayloadSource;
	ready: boolean;
	candidateCount: number;
	candidates: readonly RecommendationRankedCandidate[];
	notes: string[];
};

/** Explainable response pack for LINE / humans; structured fields + one rendered block. */
export type RecommendationExplainableSummary = {
	headline: string;
	reasoning: string;
	action: string;
	risk: string;
	/** Single message body for LINE reply */
	renderedText: string;
};

/**
 * Full recommendation pipeline output (loader + ranking + allocation planning).
 */
export type RecommendationOutput = {
	ok: boolean;
	blocked: boolean;
	blockReason: string | null;
	decisionEligible: boolean;
	dataUsability: RecommendationOutputDataUsability;
	/** e.g. MoInput.options.mode; extend when modes multiply */
	mode: string;
	/** Legacy one-line status (compatibility) */
	summary: string;
	decision: RecommendationDecisionEnvelope;
	candidate: RecommendationCandidatePlaceholder;
	allocation: RecommendationAllocationPlaceholder;
	simulation: RecommendationSimulationPlaceholder;
	recommendation: RecommendationPayload;
	explainableSummary: RecommendationExplainableSummary;
	generatedAt: string;
	/** ETF Candidate Universe v1（與 FinMind 載入／gate 對齊；供 report／follow-up 引用） */
	etfCandidateContext?: {
		gate: EtfCandidateGateState;
		humanSummaryZh: string;
	};
};

export type { RecommendationCandidate, RecommendationRankedCandidate };
export type { RecommendationAllocationPlanItem };

function renderExplainableBlock(
	headline: string,
	reasoning: string,
	action: string,
	risk: string
): string {
	return [headline, "", reasoning, "", `Action: ${action}`, `Risk: ${risk}`].join("\n");
}

function buildExplainableSummary(
	o: Pick<
		RecommendationOutput,
		"blocked" | "blockReason" | "recommendation" | "allocation" | "simulation"
	>
): RecommendationExplainableSummary {
	const rec = o.recommendation;
	const alloc = o.allocation;
	const sim = o.simulation;

	if (o.blocked) {
		const br = o.blockReason ?? "unknown";
		const headline = "Recommendation blocked";
		const reasoning = `Governance precheck blocked this path (reason: ${br}).`;
		const action = "No suggestion issued; try again when eligibility improves.";
		const risk = "Not investment advice; pipeline blocked.";
		return {
			headline,
			reasoning,
			action,
			risk,
			renderedText: renderExplainableBlock(headline, reasoning, action, risk),
		};
	}

	const n = rec.candidateCount;
	const src = rec.source;

	if (n === 0) {
		const headline = "No ranked candidates";
		const reasoning = `Source ${src}: zero candidates after ranking; allocation cannot start.`;
		const action = "Retry when loader data is available.";
		const risk = "Stub pipeline only; no positions.";
		return {
			headline,
			reasoning,
			action,
			risk,
			renderedText: renderExplainableBlock(headline, reasoning, action, risk),
		};
	}

	if (alloc.ready && sim.executable) {
		const headline = "Suggestion outline ready";
		const reasoning = `Source ${src}; ${n} ranked candidate(s); allocation ${alloc.method}; profile ${alloc.profile}; simulation executable.`;
		const action = "Review stub weights; simulation may run next (still not a trade).";
		const risk = "Educational stub only; not an order.";
		return {
			headline,
			reasoning,
			action,
			risk,
			renderedText: renderExplainableBlock(headline, reasoning, action, risk),
		};
	}

	if (alloc.ready && !sim.executable) {
		const headline = "Allocation without runnable simulation";
		const reasoning = `Allocation method ${alloc.method}; simulation not executable yet.`;
		const action = "Resolve simulation prerequisites before backtesting.";
		const risk = "Stub outputs; no execution.";
		return {
			headline,
			reasoning,
			action,
			risk,
			renderedText: renderExplainableBlock(headline, reasoning, action, risk),
		};
	}

	const headline = "Candidates ranked; allocation pending";
	const reasoning = `Source ${src}; ${n} candidate(s); allocation.ready=${String(alloc.ready)}; method ${alloc.method}.`;
	const action = "Wait for allocation step to finish.";
	const risk = "No weights to act on yet.";
	return {
		headline,
		reasoning,
		action,
		risk,
		renderedText: renderExplainableBlock(headline, reasoning, action, risk),
	};
}

function attachExplainable(
	base: Omit<RecommendationOutput, "explainableSummary" | "etfCandidateContext"> & {
		etfCandidateContext?: RecommendationOutput["etfCandidateContext"];
	}
): RecommendationOutput {
	return {
		...base,
		explainableSummary: buildExplainableSummary(base),
	};
}

function summaryWhenBlocked(precheck: RecommendationPrecheckResult): string {
	switch (precheck.blockReason) {
		case "market_data_unusable":
			return "market data unusable";
		case "decision_not_eligible":
			return "blocked by governance";
		default:
			return "blocked by governance";
	}
}

function decisionNotesWhenBlocked(precheck: RecommendationPrecheckResult): string[] {
	switch (precheck.blockReason) {
		case "market_data_unusable":
			return ["market data unusable"];
		case "decision_not_eligible":
			return ["decision not eligible"];
		default:
			return ["decision not eligible"];
	}
}

function decisionWhenBlocked(
	precheck: RecommendationPrecheckResult
): RecommendationDecisionEnvelope {
	return {
		stage: "blocked",
		readiness: "blocked",
		source: RECOMMENDATION_DECISION_SOURCE_GOVERNANCE_PRECHECK,
		candidateCount: 0,
		notes: decisionNotesWhenBlocked(precheck),
	};
}

function decisionFromRankingAndAllocation(
	rank: RecommendationRankingResult
): RecommendationDecisionEnvelope {
	const base =
		rank.source === "etf_universe"
			? ["etf universe v1 candidate ranking ready"]
			: rank.source === "real_loader"
				? ["real candidate ranking ready"]
				: ["stub candidate ranking ready"];
	return {
		stage: "skeleton_ready",
		readiness: "ready_for_engine",
		source: RECOMMENDATION_DECISION_SOURCE_GOVERNANCE_PRECHECK,
		candidateCount: rank.candidateCount,
		notes: [...base, "allocation planning attached"],
	};
}

function candidateWhenBlocked(): RecommendationCandidatePlaceholder {
	return {
		stage: "not_loaded",
		source: "none",
		count: 0,
		items: [],
		notes: ["blocked before candidate loading"],
	};
}

function candidateFromRankingResult(
	rank: RecommendationRankingResult,
	load: RecommendationCandidateLoadResult
): RecommendationCandidatePlaceholder {
	const source: RecommendationCandidateSource =
		load.source === "real_loader" || load.source === "etf_universe"
			? "recommendation_loader"
			: "recommendation_stub";
	return {
		stage: "placeholder_ready",
		source,
		count: rank.candidateCount,
		items: rank.rankedCandidates,
		notes: ["candidate ranking ready", ...rank.notes],
	};
}

function allocationProfile(moInput: MoInput): string {
	return moInput.context.riskPreference;
}

function allocationFromPlan(plan: RecommendationAllocationPlanResult): RecommendationAllocationPlaceholder {
	const stage: RecommendationAllocationStage =
		plan.ready && plan.itemCount > 0 ? "placeholder_ready" : "not_allocated";
	return {
		stage,
		method: plan.method,
		profile: plan.profile,
		ready: plan.ready,
		itemCount: plan.itemCount,
		items: plan.items,
		cashRatio: plan.cashRatio,
		positionRatio: plan.positionRatio,
		notes: [...plan.notes],
	};
}

function simulationFromPlan(plan: RecommendationAllocationPlanResult): RecommendationSimulationPlaceholder {
	if (plan.ready && plan.itemCount > 0) {
		return {
			readiness: "placeholder_ready",
			source: "recommendation_stub",
			executable: true,
			notes: ["simulation ready from allocation plan"],
		};
	}
	return {
		readiness: "not_ready",
		source: "none",
		executable: false,
		notes: ["simulation not ready without allocation plan"],
	};
}

function simulationWhenBlocked(): RecommendationSimulationPlaceholder {
	return {
		readiness: "not_ready",
		source: "none",
		executable: false,
		notes: ["blocked before simulation"],
	};
}

function recommendationWhenBlocked(): RecommendationPayload {
	return {
		source: "none",
		ready: false,
		candidateCount: 0,
		candidates: [],
		notes: ["recommendation blocked before engine"],
	};
}

function recommendationFromRankingResult(rank: RecommendationRankingResult): RecommendationPayload {
	const source: RecommendationPayloadSource =
		rank.source === "etf_universe"
			? "etf_universe"
			: rank.source === "real_loader"
				? "real_loader"
				: "stub_engine";
	return {
		source,
		ready: rank.ready,
		candidateCount: rank.candidateCount,
		candidates: rank.rankedCandidates,
		notes: [...rank.notes],
	};
}

function summaryFromRankAndPlan(
	rank: RecommendationRankingResult,
	plan: RecommendationAllocationPlanResult
): string {
	if (!plan.ready) {
		return rank.source === "real_loader"
			? "real recommendation ranking ready"
			: "stub recommendation ranking ready";
	}
	return rank.source === "etf_universe"
		? "etf universe v1 recommendation allocation pipeline"
		: rank.source === "real_loader"
			? "real recommendation allocation ready"
			: "stub recommendation allocation ready";
}

export async function buildRecommendationOutput(
	moInput: MoInput,
	precheck: RecommendationPrecheckResult,
	loaderCtx: RecommendationLoaderContext,
	fetchEnv: MoEtfFetchEnv
): Promise<RecommendationOutput> {
	const generatedAt = new Date().toISOString();
	const mode = moInput.options.mode;
	const profile = allocationProfile(moInput);

	if (precheck.shouldBlock) {
		const plan = buildRecommendationAllocationPlan({ blocked: true, profile });
		return attachExplainable({
			ok: precheck.ok,
			blocked: true,
			blockReason: precheck.blockReason,
			decisionEligible: precheck.decisionEligible,
			dataUsability: precheck.dataUsability,
			mode,
			summary: summaryWhenBlocked(precheck),
			decision: decisionWhenBlocked(precheck),
			candidate: candidateWhenBlocked(),
			allocation: allocationFromPlan(plan),
			simulation: simulationWhenBlocked(),
			recommendation: recommendationWhenBlocked(),
			generatedAt,
		});
	}

	const etf = await runMoEtfCandidatePipelineV1(
		fetchEnv,
		loaderCtx.etfTradeDateYyyymmdd,
		loaderCtx.indexDailyPct
	);
	const load = etf.loadResult;
	const rank = rankRecommendationCandidates(load);
	const plan = buildRecommendationAllocationPlan({ blocked: false, rank, profile });

	return attachExplainable({
		ok: true,
		blocked: false,
		blockReason: null,
		decisionEligible: precheck.decisionEligible,
		dataUsability: precheck.dataUsability,
		mode,
		summary: summaryFromRankAndPlan(rank, plan),
		decision: decisionFromRankingAndAllocation(rank),
		candidate: candidateFromRankingResult(rank, load),
		allocation: allocationFromPlan(plan),
		simulation: simulationFromPlan(plan),
		recommendation: recommendationFromRankingResult(rank),
		generatedAt,
		etfCandidateContext: {
			gate: etf.gate,
			humanSummaryZh: etf.humanSummaryZh,
		},
	});
}
