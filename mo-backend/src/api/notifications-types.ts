/**
 * GET `/api/notifications` 回應 schema（Web 僅顯示，不重算）。
 */
export type NotificationType = "recommendation" | "governance" | "report" | "system";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationItem {
	id: string;
	timestamp: string;
	type: NotificationType;
	title: string;
	summary: string;
	severity: NotificationSeverity;
}

export interface NotificationsApiSuccessBody {
	ok: true;
	generatedAt: string;
	data: {
		items: NotificationItem[];
	};
}

export interface NotificationsApiErrorBody {
	ok: false;
	error: string;
	message?: string;
	allowedMethods?: string[];
	generatedAt?: string;
}
