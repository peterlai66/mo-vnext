import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import CandidatesSection from "./CandidatesSection.tsx";

const candidatesSuccess = {
  ok: true,
  generatedAt: "2026-03-29T12:00:00.000Z",
  data: {
    recommendationMode: "observe_only",
    confidence: "observe",
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
          scoreDiff: 11,
        },
        {
          from: "0056",
          to: "00878",
          summaryZh: "優勢：A\n劣勢：B",
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

  it("success：leader、Top 3、pairs 與 Decision", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(candidatesSuccess));

    render(<CandidatesSection />);

    await waitFor(() => {
      expect(screen.getByTestId("candidates-leader-symbol")).toHaveTextContent("0056.TW");
    });

    expect(screen.getByTestId("candidates-leader-name")).toHaveTextContent("元大高股息");
    expect(screen.getByTestId("candidates-leader-score")).toHaveTextContent("82");
    expect(screen.getByTestId("candidates-leader-rank")).toHaveTextContent("1");

    expect(screen.getByTestId("candidates-top3-list").querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByTestId("candidates-row-1")).toHaveTextContent("0056.TW");
    expect(screen.getByTestId("candidates-pair-summary-0")).toHaveTextContent("資料完整度較高");

    expect(screen.getByTestId("candidates-decision-mode")).toHaveTextContent("observe_only");
    expect(screen.getByTestId("candidates-decision-confidence")).toHaveTextContent("observe");
  });

  it("scoreDiff===0 顯示（差異不顯著）", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(candidatesSuccess));

    render(<CandidatesSection />);

    await waitFor(() => {
      expect(screen.getByTestId("candidates-pair-1")).toBeInTheDocument();
    });

    const pair1 = screen.getByTestId("candidates-pair-1");
    expect(within(pair1).getByTestId("candidates-insignificant-1")).toHaveTextContent("差異不顯著");
  });

  it("ok===false → error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ ok: false, error: "etf_gate_not_ready", message: "gate=x" }, 200)
    );

    render(<CandidatesSection />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText("etf_gate_not_ready")).toBeInTheDocument();
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
