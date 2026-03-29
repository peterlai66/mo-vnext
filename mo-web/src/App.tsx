import { useEffect, useState } from "react";
import CandidatesSection from "./CandidatesSection.tsx";
import NotificationsSection from "./NotificationsSection.tsx";
import ReportSection from "./ReportSection.tsx";

/** 與 mo-backend Today API `display` 對齊；Web 只 render，不翻譯 enum */
type TodayApiSuccessBody = {
  ok: true;
  generatedAt: string;
  data: {
    tradeDate: string;
    market: { summaryText: string };
    recommendation: {
      display: {
        headlineZh: string;
        summaryZh: string;
        stanceLabelZh: string;
        confidenceLabelZh: string;
      };
    };
    display: {
      generatedAtTaipei: string;
      tradeDateLabelZh: string;
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
  const disp = rec.display;
  if (!isRecord(disp)) return false;
  if (
    typeof disp.headlineZh !== "string" ||
    typeof disp.summaryZh !== "string" ||
    typeof disp.stanceLabelZh !== "string" ||
    typeof disp.confidenceLabelZh !== "string"
  ) {
    return false;
  }
  const top = data.display;
  if (!isRecord(top)) return false;
  if (typeof top.generatedAtTaipei !== "string" || typeof top.tradeDateLabelZh !== "string") return false;
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
            交易日：{" "}
            <span data-testid="tradeDateLabel">{state.body.data.display.tradeDateLabelZh}</span>
            <br />
            <span style={{ fontSize: "0.85rem" }} data-testid="generated-at-taipei">
              更新時間（台灣）：{state.body.data.display.generatedAtTaipei}
            </span>
          </p>

          <section>
            <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>市場摘要</h2>
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }} data-testid="market-summary">
              {state.body.data.market.summaryText}
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>投資建議</h2>
            <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }} data-testid="rec-headline">
              {state.body.data.recommendation.display.headlineZh}
            </p>
            <p style={{ margin: "0 0 0.75rem", whiteSpace: "pre-wrap" }} data-testid="rec-summary">
              {state.body.data.recommendation.display.summaryZh}
            </p>
            <p style={{ margin: 0, fontSize: "0.95rem" }} data-testid="rec-stance">
              <strong>立場：</strong>
              {state.body.data.recommendation.display.stanceLabelZh}
            </p>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.95rem" }} data-testid="rec-confidence">
              <strong>信心與不確定性：</strong>
              {state.body.data.recommendation.display.confidenceLabelZh}
            </p>
          </section>
        </div>
      )}

      <ReportSection />

      <CandidatesSection />

      <NotificationsSection />
    </div>
  );
}
