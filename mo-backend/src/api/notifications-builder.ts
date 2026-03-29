import { buildTodayApiStubResponse } from "./today-stub-builder.js";
import type { TodayApiResponse } from "./today-types.js";
import type { NotificationItem, NotificationsApiSuccessBody } from "./notifications-types.js";
import { formatIsoToTaipeiDateTime } from "./taipei-time.js";

const ALLOWED_TYPES = new Set<NotificationItem["type"]>([
	"recommendation",
	"governance",
	"report",
	"system",
]);
const ALLOWED_SEVERITY = new Set<NotificationItem["severity"]>(["info", "warning", "critical"]);
const ALLOWED_CHANGE = new Set<NotificationItem["changeType"]>(["snapshot", "shift", "alert", "summary"]);

const FEED_NOTE_ZH =
	"以下為系統摘要整理（非即時事件通知），協助你快速掌握目前狀態；若需即時推播，將於後續版本接上事件來源。";

function severityFromRecommendationMode(mode: string): NotificationItem["severity"] {
	if (mode === "blocked") return "critical";
	if (mode === "observe_only") return "info";
	return "warning";
}

function severityFromGovernance(dataUsability: string): NotificationItem["severity"] {
	if (dataUsability === "decision_ok") return "info";
	return "warning";
}

/**
 * v2：由 Today 資料組裝摘要型通知（deterministic）；每筆含 changeType／isNew／isSummaryDigest。
 */
export function buildNotificationItemsFromTodayData(today: TodayApiResponse): NotificationItem[] {
	const { tradeDate, governance, recommendation, report, notifications } = today.data;
	const baseIso = today.generatedAt;
	const tsTaipei = formatIsoToTaipeiDateTime(baseIso);

	const govSummary =
		governance.decisionEligible && governance.dataUsability === "decision_ok" ?
			"治理判定：資料可用於決策參考；推播條件未滿足時不會發送推播。"
		:	"治理判定：請留意資料可用性與決策門檻，必要時降低操作頻率。";

	const items: NotificationItem[] = [
		{
			id: `feed-${tradeDate}-recommendation`,
			timestamp: baseIso,
			timestampTaipei: tsTaipei,
			type: "recommendation",
			title: recommendation.display.headlineZh,
			summary: `${recommendation.display.summaryZh} ${recommendation.display.stanceLabelZh}`,
			severity: severityFromRecommendationMode(recommendation.mode),
			changeType: "snapshot",
			isNew: false,
			isSummaryDigest: true,
		},
		{
			id: `feed-${tradeDate}-governance`,
			timestamp: baseIso,
			timestampTaipei: tsTaipei,
			type: "governance",
			title: "資料與治理狀態",
			summary: govSummary,
			severity: severityFromGovernance(governance.dataUsability),
			changeType: "summary",
			isNew: false,
			isSummaryDigest: true,
		},
		{
			id: `feed-${tradeDate}-report`,
			timestamp: baseIso,
			timestampTaipei: tsTaipei,
			type: "report",
			title: "報告可用性",
			summary:
				report.available ?
					`「${report.headline}」已可產出；建議搭配今日立場一併閱讀。`
				:	"報告尚不可用，請稍後再試或檢查資料完整性。",
			severity: report.available ? "info" : "warning",
			changeType: "snapshot",
			isNew: false,
			isSummaryDigest: true,
		},
		{
			id: `feed-${tradeDate}-system`,
			timestamp: baseIso,
			timestampTaipei: tsTaipei,
			type: "system",
			title: "通知匣狀態",
			summary:
				notifications.unreadCount > 0 ?
					`目前有 ${String(notifications.unreadCount)} 則未讀提醒（摘要計數）。`
				:	"目前沒有未讀摘要提醒。",
			severity: "info",
			changeType: "summary",
			isNew: false,
			isSummaryDigest: true,
		},
	];

	for (const it of items) {
		if (!ALLOWED_TYPES.has(it.type)) throw new Error(`invalid notification type: ${it.type}`);
		if (!ALLOWED_SEVERITY.has(it.severity)) throw new Error(`invalid severity: ${it.severity}`);
		if (!ALLOWED_CHANGE.has(it.changeType)) throw new Error(`invalid changeType: ${it.changeType}`);
	}
	return items;
}

export function buildNotificationItemsFromTodayStub(nowMs: number = Date.now()): NotificationItem[] {
	return buildNotificationItemsFromTodayData(buildTodayApiStubResponse(nowMs));
}

export function buildNotificationsApiResponse(nowMs: number = Date.now()): NotificationsApiSuccessBody {
	const today = buildTodayApiStubResponse(nowMs);
	const items = buildNotificationItemsFromTodayData(today);
	return {
		ok: true,
		generatedAt: today.generatedAt,
		data: {
			feedNoteZh: FEED_NOTE_ZH,
			items,
		},
	};
}
