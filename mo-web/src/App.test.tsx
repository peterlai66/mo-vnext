import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "./App.tsx";

/** 供 Today 成功時並行載入 Candidates，避免 Candidates 區塊出現第二個 alert */
const candidatesOkForApp = {
  ok: true,
  generatedAt: "2026-03-29T00:00:00.000Z",
  data: {
    recommendationMode: "observe_only",
    confidence: "observe",
    leader: { symbol: "0056.TW", name: "L", score: 1, rank: 1 },
    rankedCandidates: [
      { symbol: "0056.TW", name: "L", score: 1, rank: 1 },
      { symbol: "00713.TW", name: "a", score: 1, rank: 2 },
      { symbol: "00878.TW", name: "b", score: 1, rank: 3 },
    ],
    deltaExplain: {
      pairs: [
        { from: "0056", to: "00713", summaryZh: "x", scoreDiff: 1 },
        { from: "0056", to: "00878", summaryZh: "y", scoreDiff: 1 },
      ],
    },
  },
};

const successPayload = {
  ok: true,
  generatedAt: "2026-03-29T00:00:00.000Z",
  data: {
    tradeDate: "20260328",
    market: {
      source: "stub",
      summaryText: "MARKET_SUMMARY_FROM_API",
      indexDailyPct: null as number | null,
      freshnessMinutes: null as number | null,
      stalenessLevel: "fresh",
    },
    governance: {
      decisionEligible: true,
      dataUsability: "decision_ok",
      pushEligible: false,
    },
    recommendation: {
      mode: "observe_only" as const,
      confidence: "medium" as const,
      headline: "HEADLINE_FROM_API",
      summary: "SUMMARY_FROM_API",
    },
    report: { available: true, headline: "r" },
    notifications: { unreadCount: 0 },
  },
};

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const defaultReportText = "MO Report\nstub";

function mockFetchForApp(
  todayResponse: Response,
  candidatesResponse: Response = jsonResponse(candidatesOkForApp),
  reportResponse: Response = new Response(defaultReportText, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/candidates")) {
      return Promise.resolve(candidatesResponse);
    }
    if (url.includes("/api/report-preview")) {
      return Promise.resolve(reportResponse);
    }
    return Promise.resolve(todayResponse);
  });
}

describe("Today 頁 /api/today", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("初始為 loading", () => {
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>(() => {})
    );
    render(<App />);
    expect(screen.getByRole("status", { name: "載入 Today 資料中" })).toHaveTextContent("載入中");
  });

  it("ok===true 且 shape 正確時轉 success，mode/confidence 原樣顯示", async () => {
    mockFetchForApp(jsonResponse(successPayload));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("tradeDate")).toHaveTextContent("20260328");
    });

    expect(screen.getByTestId("market-summary")).toHaveTextContent("MARKET_SUMMARY_FROM_API");
    expect(screen.getByTestId("rec-headline")).toHaveTextContent("HEADLINE_FROM_API");
    expect(screen.getByTestId("rec-summary")).toHaveTextContent("SUMMARY_FROM_API");
    expect(screen.getByTestId("rec-mode")).toHaveTextContent("observe_only");
    expect(screen.getByTestId("rec-confidence")).toHaveTextContent("medium");
  });

  it("ok===false 時轉 error", async () => {
    mockFetchForApp(jsonResponse({ ok: false, error: "method_not_allowed" }, 200));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("無法載入 Today")).toBeInTheDocument();
    });

    expect(screen.getByText("method_not_allowed")).toBeInTheDocument();
  });

  it("HTTP 非 2xx 時轉 error", async () => {
    mockFetchForApp(jsonResponse({ ok: false, error: "x" }, 500));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("無法載入 Today")).toBeInTheDocument();
    });
  });

  it("欄位缺失時 error，不崩潰", async () => {
    mockFetchForApp(
      jsonResponse({
        ok: true,
        generatedAt: "x",
        data: { tradeDate: "1", market: {}, recommendation: {} },
      })
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Today API 回應欄位不完整/)).toBeInTheDocument();
    });
  });
});
