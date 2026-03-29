import { useEffect, useState } from "react";

type ReportViewState =
  | { phase: "loading" }
  | { phase: "success"; text: string }
  | { phase: "error"; message: string };

export default function ReportSection() {
  const [state, setState] = useState<ReportViewState>({ phase: "loading" });

  useEffect(() => {
    const ac = new AbortController();

    (async () => {
      setState({ phase: "loading" });
      try {
        const res = await fetch("/api/report-preview", {
          signal: ac.signal,
          headers: { Accept: "text/plain, */*" },
        });
        const text = await res.text();

        if (ac.signal.aborted) return;

        if (!res.ok) {
          setState({
            phase: "error",
            message: text.trim() !== "" ? text : `HTTP ${String(res.status)}`,
          });
          return;
        }

        if (text.trim() === "") {
          setState({ phase: "error", message: "回應內容為空" });
          return;
        }

        setState({ phase: "success", text });
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
          <h2 style={{ margin: 0, fontSize: "1.35rem" }}>MO Report</h2>
          <pre
            data-testid="report-full-text"
            style={{
              margin: 0,
              fontFamily: "inherit",
              fontSize: "0.95rem",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {state.text}
          </pre>
        </>
      )}
    </section>
  );
}
