/**
 * GET `/api/notifications` 回應 schema（Web 僅顯示，不重算）。
 */
export type NotificationType = "recommendation" | "governance" | "report" | "system";

export type NotificationSeverity = "info" | "warning" | "critical";

/** 變化類型（摘要型通知固定為 summary，避免誤判為即時事件） */
export type NotificationChangeType = "snapshot" | "shift" | "alert" | "summary";

export interface NotificationItem {
	id: string;
	timestamp: string;
	/** 台灣時區可讀時間（與 timestamp ISO 對應） */
	timestampTaipei: string;
	type: NotificationType;
	title: string;
	summary: string;
	severity: NotificationSeverity;
	changeType: NotificationChangeType;
	/** 是否為本次摘要中新出現之重點（fallback 下可全為 false） */
	isNew: boolean;
	/** 若為 true，表示此筆為摘要整理，非即時事件流 */
	isSummaryDigest: boolean;
}

export interface NotificationsApiSuccessBody {
	ok: true;
	generatedAt: string;
	data: {
		/** 給使用者理解 feed 性質（摘要型／非事件流） */
		feedNoteZh: string;
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
