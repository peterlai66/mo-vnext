/** Types for `governance-core.cjs` (single runtime implementation; dev-check + Worker). */

export type MoLiveGovStalenessLevel = "fresh" | "aging" | "stale" | "too_old";

export type MoLiveGovDataUsability =
	| "display_only"
	| "decision_ok"
	| "push_ok"
	| "unusable";

export type MoLiveGovV2Parsed = {
	v: number;
	source: string;
	sourceLevel: string;
	fetchStatus: string;
	confidence: string;
	rawAvailabilityNote: string;
	legacySummary: string;
};

export type DeriveMoLiveDataGovernanceResult = {
	tradeDate: string;
	source: string;
	sourceLevel: string;
	fetchStatus: string;
	confidence: string;
	rawAvailabilityNote: string;
	legacySummary: string;
	dataUsability: MoLiveGovDataUsability;
	stalenessLevel: MoLiveGovStalenessLevel;
	freshnessMinutes: number | null;
	sourcePriority: number;
	decisionEligible: boolean;
	pushEligible: boolean;
	displayFetchStatus: string;
	liveFreshness: string;
	v2: MoLiveGovV2Parsed | null;
};

export type DeriveMoLiveDataGovernanceInput = {
	row: {
		trade_date: string;
		created_at: string;
		payload_summary: string;
		source?: string;
	} | null;
	nowMs: number;
	todayYyyymmdd: string;
};

export const MO_LIVE_GOV_FRESH_MS: number;
export const MO_LIVE_GOV_AGING_MS: number;
export const MO_LIVE_GOV_STALE_MS: number;

export function moLiveTradeDateLagDays(
	tradeYyyymmdd: string,
	todayYyyymmdd: string
): number;

export function deriveMoLiveDataGovernance(
	p: DeriveMoLiveDataGovernanceInput
): DeriveMoLiveDataGovernanceResult;
