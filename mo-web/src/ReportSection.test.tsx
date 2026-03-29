import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import ReportSection from "./ReportSection.tsx";

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

describe("ReportSection /api/report-preview", () => {
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

  it("success 顯示完整文字（不拆分）", async () => {
    const full = "MO Report\n\n第二行\t保留\n第三行";
    vi.mocked(fetch).mockResolvedValue(textResponse(full));

    render(<ReportSection />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "MO Report" })).toBeInTheDocument();
    });

    expect(screen.getByTestId("report-full-text").textContent).toBe(full);
  });

  it("空內容 → error", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("   "));

    render(<ReportSection />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText("回應內容為空")).toBeInTheDocument();
  });

  it("HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 502 }));

    render(<ReportSection />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText(/HTTP 502/)).toBeInTheDocument();
  });

  it("非 2xx 且有 body 時顯示原文", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("report preview error: boom", 500));

    render(<ReportSection />);

    await waitFor(() => {
      expect(screen.getByText(/report preview error/)).toBeInTheDocument();
    });
  });
});
