import { describe, it, expect } from "vitest";
import { sanitizeReportPlainForWeb } from "../../src/api/report-view-sanitize.js";

describe("sanitizeReportPlainForWeb", () => {
	it("移除 MO Report 重複標題行、stalenessLevel 行", () => {
		const raw = `MO Report\nstalenessLevel: fresh\n\n段落一。\n`;
		const v = sanitizeReportPlainForWeb(raw, "2026-03-29T10:00:00.000Z");
		expect(v.titleZh).toBe("今日報告");
		expect(v.paragraphs.join(" ")).toContain("段落一");
		expect(v.paragraphs.join(" ")).not.toMatch(/MO Report/);
		expect(v.paragraphs.join(" ")).not.toMatch(/stalenessLevel/i);
		expect(v.display.generatedAtTaipei.length).toBeGreaterThan(5);
	});

	it("單行長文：移除行情語氣段、staleness 括號、語意摘要段與 key=value", () => {
		const raw =
			"日期：2026/03/27 【資料品質】 OK。 【行情資料語氣】資料略舊。 【建議】先觀察。" +
			"（快照時效偏弱，請以 staleness 為準。） 【語意摘要】recommendationMode=observe_only decisionEligible=true x=y。";
		const v = sanitizeReportPlainForWeb(raw, "2026-03-29T10:00:00.000Z");
		const joined = v.paragraphs.join("\n");
		expect(joined).not.toContain("【行情資料語氣】");
		expect(joined).not.toContain("staleness");
		expect(joined).not.toContain("【語意摘要】");
		expect(joined).not.toMatch(/recommendationMode/i);
		expect(joined).not.toMatch(/decisionEligible/i);
		expect(joined).toContain("【建議】");
	});
});
