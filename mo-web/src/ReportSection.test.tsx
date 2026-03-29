import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import ReportSection from "./ReportSection.tsx";

const reportViewOk = {
  ok: true,
  generatedAt: "2026-03-29T12:00:00.000Z",
  data: {
    titleZh: "今日報告",
    paragraphs: ["第一段說明。", "第二段說明。"],
    display: { generatedAtTaipei: "2026/03/29 20:00" },
  },
};

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("ReportSection /api/report-view", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loading 顯示", () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    render(<ReportSection />);
    expect(screen.getByRole("status", { name: "載入 Report 中…" })).toHaveTextContent("載入 Report 中…");
  });

  it("success 顯示標題與段落（JSON）", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(reportViewOk));

    render(<ReportSection />);

    await waitFor(() => {
      expect(screen.getByTestId("report-title")).toHaveTextContent("今日報告");
    });

    expect(screen.getByTestId("report-time-taipei")).toHaveTextContent("2026/03/29 20:00");
    expect(screen.getByTestId("report-paragraphs").textContent).toContain("第一段說明");
  });

  it("HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 502 }));

    render(<ReportSection />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText(/HTTP 502/)).toBeInTheDocument();
  });
});
