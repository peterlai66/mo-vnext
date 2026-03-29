/**
 * /status 的 ETF 摘要：與 recommendation 相同 pipeline 與 indexDailyPct 解析，並對齊 explainable pack 之建議層級。
 */

import type { MoLiveDataGovernance } from "./governance.js";
import { buildRecommendationPrecheckResult } from "./recommendation-precheck.js";
import { runMoEtfCandidatePipelineV1 } from "./recommendation/etf-pipeline.js";
import type { MoEtfFetchEnv } from "./recommendation/etf-types.js";
import { parseIndexDailyPctFromMoLivePayloadSummary } from "./live-index-daily-pct.js";
import {
	formatMoStatusEtfIntegrationBlockZh,
	type MoRecommendationModePublic,
} from "./recommendation/etf-public-facts.js";

export type MoStatusEtfIntegrationPushView = {
	liveDataGovernance: MoLiveDataGovernance;
	livePayloadSummary: string | null;
	decisionTradeDateYyyymmdd: string;
	recommendationExplainablePack: {
		recommendationMode: MoRecommendationModePublic;
		semanticCandidateOnly: boolean;
	};
};

function precheckBlockNoteZh(blockReason: string | null): string {
	if (blockReason === null) {
		return "治理前置檢查未通過。";
	}
	if (blockReason === "market_data_unusable") {
		return "行情資料未達決策可用。";
	}
	if (blockReason === "decision_not_eligible") {
		return "決策資格未開放。";
	}
	return "治理前置檢查未通過。";
}

export async function buildMoStatusEtfIntegrationBlockZh(
	env: MoEtfFetchEnv,
	view: MoStatusEtfIntegrationPushView
): Promise<string> {
	const gov = view.liveDataGovernance;
	const indexMeta =
		view.livePayloadSummary !== null ?
			parseIndexDailyPctFromMoLivePayloadSummary(view.livePayloadSummary)
		:	{ value: null, kind: "absent" as const };

	if (gov.dataUsability === "unusable") {
		return formatMoStatusEtfIntegrationBlockZh({
			govDataUnusable: true,
			precheckBlocked: false,
			precheckBlockNoteZh: "",
			etfGate: null,
			etfHumanSummaryZh: null,
			packMode: view.recommendationExplainablePack.recommendationMode,
			semanticCandidateOnly: view.recommendationExplainablePack.semanticCandidateOnly,
			indexMeta,
		});
	}

	const precheck = buildRecommendationPrecheckResult(gov);
	if (precheck.shouldBlock) {
		const br = precheck.blockReason ?? "decision_not_eligible";
		return formatMoStatusEtfIntegrationBlockZh({
			govDataUnusable: false,
			precheckBlocked: true,
			precheckBlockNoteZh: precheckBlockNoteZh(br),
			etfGate: null,
			etfHumanSummaryZh: null,
			packMode: view.recommendationExplainablePack.recommendationMode,
			semanticCandidateOnly: view.recommendationExplainablePack.semanticCandidateOnly,
			indexMeta,
		});
	}

	const etf = await runMoEtfCandidatePipelineV1(
		env,
		view.decisionTradeDateYyyymmdd,
		indexMeta.value
	);
	const semanticForLine = etf.listsNamedEtfCandidates
		? false
		: view.recommendationExplainablePack.semanticCandidateOnly;
	return formatMoStatusEtfIntegrationBlockZh({
		govDataUnusable: false,
		precheckBlocked: false,
		precheckBlockNoteZh: "",
		etfGate: etf.gate,
		etfHumanSummaryZh: etf.humanSummaryZh,
		packMode: view.recommendationExplainablePack.recommendationMode,
		semanticCandidateOnly: semanticForLine,
		indexMeta,
	});
}
