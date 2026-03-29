/**
 * 將 ISO 時間轉為台灣時區之可讀字串（供 API display 欄位；Web 不重算時區）。
 */
export function formatIsoToTaipeiDateTime(iso: string): string {
	const d = Date.parse(iso);
	if (!Number.isFinite(d)) {
		return iso;
	}
	return new Intl.DateTimeFormat("zh-TW", {
		timeZone: "Asia/Taipei",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(d));
}
