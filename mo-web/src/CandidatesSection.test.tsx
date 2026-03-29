import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import CandidatesSection from "./CandidatesSection.tsx";

const candidatesSuccess = {
  ok: true,
  generatedAt: "2026-03-29T12:00:00.000Z",
  data: {
    recommendationMode: "observe_only",
    confidence: "observe",
    display: {
      decisionLabelZh: "目前以觀察為主（測試）",
      confidenceNarrativeZh: "已有相對較佳標的，但整體仍建議觀察為主。",
      generatedAtTaipei: "2026/03/29 20:00",
    },
    leader: {
      symbol: "0056.TW",
      name: "元大高股息",
      score: 82,
      rank: 1,
    },
    rankedCandidates: [
      { symbol: "0056.TW", name: "元大高股息", score: 82, rank: 1 },
      { symbol: "00713.TW", name: "元大台灣高息低波", score: 71, rank: 2 },
      { symbol: "00878.TW", name: "國泰台灣5G+", score: 65, rank: 3 },
    ],
    deltaExplain: {
      pairs: [
        {
          from: "0056",
          to: "00713",
          summaryZh: "優勢：資料完整度較高\n劣勢：成交活絡度相對較低",
          narrativeZh: "比較「0056」與「00713」：優勢：資料完整度較高 劣勢：成交活絡度相對較低",
          scoreDiff: 11,
        },
        {
          from: "0056",
          to: "00878",
          summaryZh: "優勢：A\n劣勢：B",
          narrativeZh: "比較「0056」與「00878」：優勢：A 劣勢：B",
          scoreDiff: 0,
        },
      ],
    },
  },
};

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CandidatesSection /api/candidates", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loading state", () => {
    render(<CandidatesSection />);
    expect(screen.getByRole("status", { name: "載入 Candidates 資料中" })).toHaveTextContent("載入中");
  });

  it("success：leader、差異敘述、決策人話", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(candidatesSuccess));

    render(<CandidatesSection />);

    await waitFor(() => {
      expect(screen.getByTestId("candidates-leader-symbol")).toHaveTextContent("0056.TW");
    });

    expect(screen.getByTestId("candidates-pair-narrative-0")).toHaveTextContent("比較「0056」與「00713」");
    expect(screen.getByTestId("candidates-decision-human")).toHaveTextContent("目前以觀察為主（測試）");
    expect(screen.getByTestId("candidates-confidence-human")).toHaveTextContent("已有相對較佳標的");
  });

  it("ok===false → error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ ok: false, error: "etf_gate_not_ready", message: "gate=x" }, 200)
    );

    render(<CandidatesSection />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText(/ETF 候選排名/i)).toBeInTheDocument();
    expect(screen.getByText(/gate/i)).toBeInTheDocument();
  });

  it("HTTP error → error", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 502 }));

    render(<CandidatesSection />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText(/HTTP 502/)).toBeInTheDocument();
  });
});
