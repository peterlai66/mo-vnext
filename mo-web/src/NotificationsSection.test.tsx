import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import NotificationsSection from "./NotificationsSection.tsx";

const okBody = {
  ok: true,
  generatedAt: "2026-03-29T12:00:00.000Z",
  data: {
    feedNoteZh: "摘要說明（測試）",
    items: [
      {
        id: "a1",
        timestamp: "2026-03-29T12:00:00.000Z",
        timestampTaipei: "2026/03/29 20:00",
        type: "recommendation" as const,
        title: "T1",
        summary: "S1",
        severity: "info" as const,
        changeType: "snapshot" as const,
        isNew: false,
        isSummaryDigest: true,
      },
      {
        id: "a2",
        timestamp: "2026-03-29T12:00:00.000Z",
        timestampTaipei: "2026/03/29 20:00",
        type: "governance" as const,
        title: "T2",
        summary: "S2",
        severity: "warning" as const,
        changeType: "summary" as const,
        isNew: false,
        isSummaryDigest: true,
      },
    ],
  },
};

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("NotificationsSection /api/notifications", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loading state", () => {
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    render(<NotificationsSection />);
    expect(screen.getByRole("status", { name: "載入通知中" })).toHaveTextContent("載入通知中");
  });

  it("success 時列出多筆", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(okBody));

    render(<NotificationsSection />);

    await waitFor(() => {
      expect(screen.getByTestId("notifications-list")).toBeInTheDocument();
    });

    const rows = screen.getAllByTestId("notifications-item");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("T1")).toBeInTheDocument();
    expect(screen.getByText("T2")).toBeInTheDocument();
  });

  it("空陣列時 empty state", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        ok: true,
        generatedAt: "2026-03-29T00:00:00.000Z",
        data: { feedNoteZh: "摘要", items: [] },
      })
    );

    render(<NotificationsSection />);

    await waitFor(() => {
      expect(screen.getByTestId("notifications-empty")).toBeInTheDocument();
    });
  });

  it("fetch 失敗時 error state", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: false, error: "x" }, 500));

    render(<NotificationsSection />);

    await waitFor(() => {
      expect(screen.getByTestId("notifications-error")).toBeInTheDocument();
    });

    expect(screen.getByText("無法載入通知")).toBeInTheDocument();
  });
});
