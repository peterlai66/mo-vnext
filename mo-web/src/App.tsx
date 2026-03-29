import { useEffect, useState } from "react";
import CandidatesSection from "./CandidatesSection.tsx";
import NotificationsSection from "./NotificationsSection.tsx";
import ReportSection from "./ReportSection.tsx";

/** 與 mo-backend `TodayApiResponse` 對齊；Web 僅顯示，不重算。 */
type TodayApiRecommendationMode =
  | "actionable"
  | "actionable_with_caution"
  | "observe_only"
  | "blocked";

type TodayApiConfidenceLabel = "high" | "medium" | "low";

type TodayApiSuccessBody = {
  ok: true;
  generatedAt: string;
  data: {
    tradeDate: string;
    market: { summaryText: string };
    recommendation: {
      mode: TodayApiRecommendationMode;
      confidence: TodayApiConfidenceLabel;
      headline: string;
      summary: string;
    };
  };
};

type ViewState =
  | { phase: "loading" }
  | { phase: "success"; body: TodayApiSuccessBody }
  | { phase: "error"; message: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isTodayApiSuccessBody(x: unknown): x is TodayApiSuccessBody {
  if (!isRecord(x) || x.ok !== true) return false;
  if (typeof x.generatedAt !== "string") return false;
  const data = x.data;
  if (!isRecord(data)) return false;
  if (typeof data.tradeDate !== "string") return false;
  const market = data.market;
  if (!isRecord(market) || typeof market.summaryText !== "string") return false;
  const rec = data.recommendation;
  if (!isRecord(rec)) return false;
  if (typeof rec.headline !== "string" || typeof rec.summary !== "string") return false;
  if (typeof rec.mode !== "string" || typeof rec.confidence !== "string") return false;
  return true;
}

function errorMessageFromJson(json: unknown): string {
  if (!isRecord(json)) return "回應格式異常";
  const err = json.error;
  if (typeof err === "string" && err.length > 0) return err;
  const msg = json.message;
  if (typeof msg === "string" && msg.length > 0) return msg;
  return "伺服器回傳錯誤";
}

export default function App() {
  const [state, setState] = useState<ViewState>({ phase: "loading" });

  useEffect(() => {
    const ac = new AbortController();

    (async () => {
      setState({ phase: "loading" });
      try {
        const res = await fetch("/api/today", {
          signal: ac.signal,
          headers: { Accept: "application/json" },
        });
        const json: unknown = await res.json().catch(() => null);

        if (ac.signal.aborted) return;

        if (!res.ok) {
          const msg = isRecord(json) ? errorMessageFromJson(json) : `HTTP ${res.status}`;
          setState({ phase: "error", message: msg });
          return;
        }

        if (isRecord(json) && json.ok === false) {
          setState({ phase: "error", message: errorMessageFromJson(json) });
          return;
        }

        if (!isTodayApiSuccessBody(json)) {
          setState({ phase: "error", message: "Today API 回應欄位不完整" });
          return;
        }

        setState({ phase: "success", body: json });
      } catch (e: unknown) {
        if (ac.signal.aborted) return;
        const message =
          e instanceof Error && e.name === "AbortError"
            ? "請求已取消"
            : e instanceof Error
              ? e.message
              : "無法連線至 Today API";
        setState({ phase: "error", message });
      }
    })();

    return () => ac.abort();
  }, []);

  return (
    <div style={{ padding: 24, maxWidth: 640, margin: "0 auto", textAlign: "left" }}>
      <h1 style={{ marginTop: 0 }}>MO Today</h1>

      {state.phase === "loading" && (
        <div
          role="status"
          aria-live="polite"
          aria-label="載入 Today 資料中"
          style={{
            padding: "1.25rem",
            borderRadius: 12,
            background: "rgba(100, 108, 255, 0.12)",
            border: "1px solid rgba(100, 108, 255, 0.35)",
          }}
        >
          載入中…
        </div>
      )}

      {state.phase === "error" && (
        <div
          role="alert"
          style={{
            padding: "1.25rem",
            borderRadius: 12,
            background: "rgba(220, 53, 69, 0.12)",
            border: "1px solid rgba(220, 53, 69, 0.45)",
          }}
        >
          <strong>無法載入 Today</strong>
          <p style={{ margin: "0.75rem 0 0", whiteSpace: "pre-wrap" }}>{state.message}</p>
        </div>
      )}

      {state.phase === "success" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <p style={{ margin: 0, opacity: 0.75, fontSize: "0.9rem" }}>
            交易日（tradeDate）：{" "}
            <span data-testid="tradeDate">{state.body.data.tradeDate}</span>
            <br />
            <span style={{ fontSize: "0.8rem" }}>generatedAt: {state.body.generatedAt}</span>
          </p>

          <section>
            <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>市場摘要</h2>
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }} data-testid="market-summary">
              {state.body.data.market.summaryText}
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>建議（後端原文）</h2>
            <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }} data-testid="rec-headline">
              {state.body.data.recommendation.headline}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }} data-testid="rec-summary">
              {state.body.data.recommendation.summary}
            </p>
            <dl
              style={{
                margin: "1rem 0 0",
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "0.35rem 1rem",
                fontSize: "0.95rem",
              }}
            >
              <dt style={{ margin: 0, opacity: 0.8 }}>recommendation.mode</dt>
              <dd style={{ margin: 0 }} data-testid="rec-mode">
                {state.body.data.recommendation.mode}
              </dd>
              <dt style={{ margin: 0, opacity: 0.8 }}>recommendation.confidence</dt>
              <dd style={{ margin: 0 }} data-testid="rec-confidence">
                {state.body.data.recommendation.confidence}
              </dd>
            </dl>
          </section>
        </div>
      )}

      <ReportSection />

      <CandidatesSection />

      <NotificationsSection />
    </div>
  );
}
