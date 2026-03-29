import type { TodayApiConfidenceLabel, TodayApiRecommendationMode } from "./today-types.js";

export function recommendationStanceLabelZh(mode: TodayApiRecommendationMode): string {
	switch (mode) {
		case "observe_only":
			return "目前建議以觀察為主，避免過度積極進場。";
		case "actionable":
			return "條件相對允許時，可評估是否小幅調整部位。";
		case "actionable_with_caution":
			return "可考慮布局，但建議保守進場並保留彈性。";
		case "blocked":
			return "現階段不建議積極進場，請先留意限制條件。";
		default: {
			const _e: never = mode;
			return _e;
		}
	}
}

export function recommendationConfidenceLabelZh(confidence: TodayApiConfidenceLabel): string {
	switch (confidence) {
		case "high":
			return "整體判讀相對明朗。";
		case "medium":
			return "判讀中性，宜保留彈性並留意變化。";
		case "low":
			return "不確定性偏高，建議保守因應。";
		default: {
			const _e: never = confidence;
			return _e;
		}
	}
}

/** yyyymmdd → YYYY/MM/DD（台北日曆概念之標示用） */
export function tradeDateYyyymmddToLabelZh(yyyymmdd: string): string {
	if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
	const y = yyyymmdd.slice(0, 4);
	const m = yyyymmdd.slice(4, 6);
	const d = yyyymmdd.slice(6, 8);
	return `${y}/${m}/${d}`;
}
