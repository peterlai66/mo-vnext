import { useEffect, useState } from "react";

type ReportViewSuccess = {
  ok: true;
  generatedAt: string;
  data: {
    titleZh: string;
    paragraphs: string[];
    display: { generatedAtTaipei: string };
  };
};

type ReportViewState =
  | { phase: "loading" }
  | { phase: "success"; body: ReportViewSuccess }
  | { phase: "error"; message: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isReportViewSuccess(x: unknown): x is ReportViewSuccess {
  if (!isRecord(x) || x.ok !== true) return false;
  if (typeof x.generatedAt !== "string") return false;
  const data = x.data;
  if (!isRecord(data)) return false;
  if (typeof data.titleZh !== "string") return false;
  if (!Array.isArray(data.paragraphs)) return false;
  for (const p of data.paragraphs) {
    if (typeof p !== "string") return false;
  }
  const disp = data.display;
  if (!isRecord(disp) || typeof disp.generatedAtTaipei !== "string") return false;
  return true;
}

export default function ReportSection() {
  const [state, setState] = useState<ReportViewState>({ phase: "loading" });

  useEffect(() => {
    const ac = new AbortController();

    (async () => {
      setState({ phase: "loading" });
      try {
        const res = await fetch("/api/report-view", {
          signal: ac.signal,
          headers: { Accept: "application/json" },
        });
        const json: unknown = await res.json().catch(() => null);

        if (ac.signal.aborted) return;

        if (!res.ok) {
          const msg =
            isRecord(json) && typeof json.message === "string" ? json.message : `HTTP ${String(res.status)}`;
          setState({ phase: "error", message: msg });
          return;
        }

        if (!isReportViewSuccess(json)) {
          setState({ phase: "error", message: "Report API 回應欄位不完整" });
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
              : "無法連線至 Report API";
        setState({ phase: "error", message });
      }
    })();

    return () => ac.abort();
  }, []);

  return (
    <section
      style={{
        marginTop: "2.5rem",
        paddingTop: "2rem",
        borderTop: "1px solid rgba(128, 128, 128, 0.35)",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      {state.phase === "loading" && (
        <div
          role="status"
          aria-live="polite"
          aria-label="載入 Report 中…"
          style={{
            padding: "1rem",
            borderRadius: 12,
            background: "rgba(100, 108, 255, 0.08)",
            border: "1px solid rgba(100, 108, 255, 0.3)",
          }}
        >
          載入 Report 中…
        </div>
      )}

      {state.phase === "error" && (
        <div
          role="alert"
          style={{
            padding: "1rem",
            borderRadius: 12,
            background: "rgba(220, 53, 69, 0.1)",
            border: "1px solid rgba(220, 53, 69, 0.4)",
          }}
        >
          <strong>無法載入 Report</strong>
          <p style={{ margin: "0.5rem 0 0", whiteSpace: "pre-wrap" }}>{state.message}</p>
        </div>
      )}

      {state.phase === "success" && (
        <>
          <h2 style={{ margin: 0, fontSize: "1.35rem" }} data-testid="report-title">
            {state.body.data.titleZh}
          </h2>
          <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.75 }} data-testid="report-time-taipei">
            更新（台灣）：{state.body.data.display.generatedAtTaipei}
          </p>
          <div data-testid="report-paragraphs">
            {state.body.data.paragraphs.map((para, i) => (
              <p
                key={`p-${String(i)}`}
                style={{
                  margin: i === 0 ? 0 : "0.85rem 0 0",
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {para}
              </p>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
