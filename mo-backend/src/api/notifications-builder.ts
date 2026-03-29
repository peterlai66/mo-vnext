import { buildTodayApiStubResponse } from "./today-stub-builder.js";
import type { TodayApiResponse } from "./today-types.js";
import type { NotificationItem, NotificationsApiSuccessBody } from "./notifications-types.js";

const ALLOWED_TYPES = new Set<NotificationItem["type"]>([
	"recommendation",
	"governance",
	"report",
	"system",
]);
const ALLOWED_SEVERITY = new Set<NotificationItem["severity"]>(["info", "warning", "critical"]);

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
 * 由 Today stub 資料組裝 feed（單一 `buildTodayApiStubResponse` 來源，避免重複計算）。
 */
export function buildNotificationItemsFromTodayData(today: TodayApiResponse): NotificationItem[] {
	const { tradeDate, governance, recommendation, report, notifications } = today.data;
	const baseIso = today.generatedAt;

	const items: NotificationItem[] = [
		{
			id: `feed-${tradeDate}-recommendation`,
			timestamp: baseIso,
			type: "recommendation",
			title: recommendation.headline,
			summary: recommendation.summary,
			severity: severityFromRecommendationMode(recommendation.mode),
		},
		{
			id: `feed-${tradeDate}-governance`,
			timestamp: baseIso,
			type: "governance",
			title: "治理與資料可用性",
			summary: `dataUsability=${governance.dataUsability}；decisionEligible=${String(governance.decisionEligible)}；pushEligible=${String(governance.pushEligible)}`,
			severity: severityFromGovernance(governance.dataUsability),
		},
		{
			id: `feed-${tradeDate}-report`,
			timestamp: baseIso,
			type: "report",
			title: report.headline,
			summary: report.available ? "報告區塊可用（後端狀態）。" : "報告區塊目前不可用（後端狀態）。",
			severity: report.available ? "info" : "warning",
		},
		{
			id: `feed-${tradeDate}-system`,
			timestamp: baseIso,
			type: "system",
			title: "通知摘要（系統）",
			summary: `未讀計數（Today stub）：${notifications.unreadCount}`,
			severity: "info",
		},
	];

	for (const it of items) {
		if (!ALLOWED_TYPES.has(it.type)) throw new Error(`invalid notification type: ${it.type}`);
		if (!ALLOWED_SEVERITY.has(it.severity)) throw new Error(`invalid severity: ${it.severity}`);
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
		data: { items },
	};
}
