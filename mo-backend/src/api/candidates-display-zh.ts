import type { MoRecommendationModePublic } from "../mo/recommendation/etf-public-facts.js";

/** 決策語氣（僅標籤句，不重算 gate／分數） */
export function recommendationModeDecisionLabelZh(mode: MoRecommendationModePublic): string {
	switch (mode) {
		case "observe_only":
			return "目前以觀察為主：先掌握環境與標的差異，避免過度積極進場。";
		case "actionable":
			return "條件允許時可考慮布局：請仍留意自身風險承受度與資金配置。";
		case "actionable_with_caution":
			return "可考慮小幅調整，但建議保守進場並保留彈性。";
		case "blocked":
			return "現階段不建議積極進場：請先處理資料或策略門檻相關限制。";
		default: {
			const _x: never = mode;
			return _x;
		}
	}
}

/** 將 pairwise 優劣勢整理成單段人話（不重算分數） */
export function deltaPairNarrativeZh(from: string, to: string, summaryZh: string): string {
	const oneLine = summaryZh.replace(/\s+/g, " ").trim();
	return `比較「${from}」與「${to}」：${oneLine}`;
}
