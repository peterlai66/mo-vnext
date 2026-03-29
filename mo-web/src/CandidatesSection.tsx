import { useEffect, useState } from "react";

type CandidatesRanked = {
  symbol: string;
  name: string;
  score: number;
  rank: number;
};

type CandidatesPair = {
  from: string;
  to: string;
  summaryZh: string;
  scoreDiff: number;
};

type CandidatesApiSuccessBody = {
  ok: true;
  generatedAt: string;
  data: {
    recommendationMode: string;
    confidence: string;
    leader: CandidatesRanked;
    rankedCandidates: CandidatesRanked[];
    deltaExplain: { pairs: CandidatesPair[] };
  };
};

type CandidatesViewState =
  | { phase: "loading" }
  | { phase: "success"; body: CandidatesApiSuccessBody }
  | { phase: "error"; message: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isCandidatesRanked(x: unknown): x is CandidatesRanked {
  if (!isRecord(x)) return false;
  return (
    typeof x.symbol === "string" &&
    typeof x.name === "string" &&
    typeof x.score === "number" &&
    typeof x.rank === "number"
  );
}

function isCandidatesPair(x: unknown): x is CandidatesPair {
  if (!isRecord(x)) return false;
  return (
    typeof x.from === "string" &&
    typeof x.to === "string" &&
    typeof x.summaryZh === "string" &&
    typeof x.scoreDiff === "number"
  );
}

/** 後端 schema 通過才視為 success；不做排序或欄位改寫。 */
function isCandidatesApiSuccessBody(x: unknown): x is CandidatesApiSuccessBody {
  if (!isRecord(x) || x.ok !== true) return false;
  if (typeof x.generatedAt !== "string") return false;
  const data = x.data;
  if (!isRecord(data)) return false;
  if (typeof data.recommendationMode !== "string") return false;
  if (typeof data.confidence !== "string") return false;
  if (!isCandidatesRanked(data.leader)) return false;
  if (!Array.isArray(data.rankedCandidates)) return false;
  if (data.rankedCandidates.length === 0) return false;
  for (const row of data.rankedCandidates) {
    if (!isCandidatesRanked(row)) return false;
  }
  const de = data.deltaExplain;
  if (!isRecord(de) || !Array.isArray(de.pairs)) return false;
  for (const p of de.pairs) {
    if (!isCandidatesPair(p)) return false;
  }
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

export default function CandidatesSection() {
  const [state, setState] = useState<CandidatesViewState>({ phase: "loading" });

  useEffect(() => {
    const ac = new AbortController();

    (async () => {
      setState({ phase: "loading" });
      try {
        const res = await fetch("/api/candidates", {
          signal: ac.signal,
          headers: { Accept: "application/json" },
        });
        const json: unknown = await res.json().catch(() => null);

        if (ac.signal.aborted) return;

        if (!res.ok) {
          const msg = isRecord(json) ? errorMessageFromJson(json) : `HTTP ${String(res.status)}`;
          setState({ phase: "error", message: msg });
          return;
        }

        if (isRecord(json) && json.ok === false) {
          setState({ phase: "error", message: errorMessageFromJson(json) });
          return;
        }

        if (!isCandidatesApiSuccessBody(json)) {
          setState({ phase: "error", message: "Candidates API 回應欄位不完整" });
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
              : "無法連線至 Candidates API";
        setState({ phase: "error", message });
      }
    })();

    return () => ac.abort();
  }, []);

  const topThree =
    state.phase === "success" ? state.body.data.rankedCandidates.slice(0, 3) : [];

  return (
    <section
      style={{
        marginTop: "2.5rem",
        paddingTop: "2rem",
        borderTop: "1px solid rgba(128, 128, 128, 0.35)",
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
      }}
    >
      <h2 style={{ margin: 0, fontSize: "1.35rem" }}>Candidates</h2>

      {state.phase === "loading" && (
        <div
          role="status"
          aria-live="polite"
          aria-label="載入 Candidates 資料中"
          style={{
            padding: "1rem",
            borderRadius: 12,
            background: "rgba(100, 108, 255, 0.08)",
            border: "1px solid rgba(100, 108, 255, 0.3)",
          }}
        >
          載入中…
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
          <strong>無法載入 Candidates</strong>
          <p style={{ margin: "0.5rem 0 0", whiteSpace: "pre-wrap" }}>{state.message}</p>
        </div>
      )}

      {state.phase === "success" && (
        <>
          <div>
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>Leader</h3>
            <p style={{ margin: 0 }} data-testid="candidates-leader-line">
              <span data-testid="candidates-leader-symbol">{state.body.data.leader.symbol}</span>
              {" · "}
              <span data-testid="candidates-leader-name">{state.body.data.leader.name}</span>
              {" — score "}
              <span data-testid="candidates-leader-score">{state.body.data.leader.score}</span>
              {", rank "}
              <span data-testid="candidates-leader-rank">{state.body.data.leader.rank}</span>
            </p>
          </div>

          <div>
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>Top 3</h3>
            <ul
              style={{ margin: 0, paddingLeft: "1.25rem" }}
              data-testid="candidates-top3-list"
            >
              {topThree.map((row) => (
                <li key={`${row.symbol}-${String(row.rank)}`} data-testid={`candidates-row-${String(row.rank)}`}>
                  #{row.rank} {row.symbol} — {String(row.score)}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>Delta Explain</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {state.body.data.deltaExplain.pairs.map((pair, i) => (
                <div
                  key={`${pair.from}-${pair.to}-${String(i)}`}
                  data-testid={`candidates-pair-${String(i)}`}
                >
                  <p style={{ margin: "0 0 0.35rem", fontWeight: 600 }}>
                    {pair.from} vs {pair.to}
                  </p>
                  <pre
                    style={{
                      margin: 0,
                      fontFamily: "inherit",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                    data-testid={`candidates-pair-summary-${String(i)}`}
                  >
                    {pair.summaryZh}
                  </pre>
                  {pair.scoreDiff === 0 && (
                    <p
                      style={{ margin: "0.35rem 0 0", opacity: 0.85 }}
                      data-testid={`candidates-insignificant-${String(i)}`}
                    >
                      （差異不顯著）
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>Decision</h3>
            <dl
              style={{
                margin: 0,
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "0.35rem 1rem",
                fontSize: "0.95rem",
              }}
            >
              <dt style={{ margin: 0, opacity: 0.8 }}>recommendationMode</dt>
              <dd style={{ margin: 0 }} data-testid="candidates-decision-mode">
                {state.body.data.recommendationMode}
              </dd>
              <dt style={{ margin: 0, opacity: 0.8 }}>confidence</dt>
              <dd style={{ margin: 0 }} data-testid="candidates-decision-confidence">
                {state.body.data.confidence}
              </dd>
            </dl>
          </div>
        </>
      )}
    </section>
  );
}
