import { deriveMoLiveDataGovernance } from "./governance-core.cjs";

export type MoLiveSnapshotRow = {
	id?: number;
	trade_date: string;
	source: string;
	payload_summary: string;
	created_at: string;
};

/** 與 dev-check deriveMoLiveDataGovernance 對齊（單一推導來源） */
export type MoLiveDataUsability = "display_only" | "decision_ok" | "push_ok" | "unusable";
export type MoLiveStalenessLevel = "fresh" | "aging" | "stale" | "too_old";

export type MoLiveDataGovernance = {
	tradeDate: string;
	source: string;
	sourceLevel: string;
	fetchStatus: string;
	confidence: string;
	rawAvailabilityNote: string;
	legacySummary: string;
	dataUsability: MoLiveDataUsability;
	stalenessLevel: MoLiveStalenessLevel;
	freshnessMinutes: number | null;
	sourcePriority: number;
	decisionEligible: boolean;
	pushEligible: boolean;
	displayFetchStatus: string;
	liveFreshness: string;
};

export function deriveMoLiveDataGovernanceTyped(
	row: MoLiveSnapshotRow | null,
	nowMs: number,
	todayYyyymmdd: string
): MoLiveDataGovernance {
	const g = deriveMoLiveDataGovernance({
		row,
		nowMs,
		todayYyyymmdd,
	}) as MoLiveDataGovernance;
	return g;
}
