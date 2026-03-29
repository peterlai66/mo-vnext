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
  narrativeZh: string;
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
    display: {
      decisionLabelZh: string;
      confidenceNarrativeZh: string;
      generatedAtTaipei: string;
    };
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
    typeof x.narrativeZh === "string" &&
    typeof x.scoreDiff === "number"
  );
}

function isCandidatesApiSuccessBody(x: unknown): x is CandidatesApiSuccessBody {
  if (!isRecord(x) || x.ok !== true) return false;
  if (typeof x.generatedAt !== "string") return false;
  const data = x.data;
  if (!isRecord(data)) return false;
  if (typeof data.recommendationMode !== "string") return false;
  if (typeof data.confidence !== "string") return false;
  const disp = data.display;
  if (!isRecord(disp)) return false;
  if (
    typeof disp.decisionLabelZh !== "string" ||
    typeof disp.confidenceNarrativeZh !== "string" ||
    typeof disp.generatedAtTaipei !== "string"
  ) {
    return false;
  }
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

/** 後端 error code → 人話；不自行翻譯成功 payload 內 enum，僅處理錯誤情境 */
function humanCandidatesErrorBody(json: unknown): string {
  if (!isRecord(json)) return "無法解析伺服器回應，請稍後再試。";
  const code = typeof json.error === "string" ? json.error : "";
  const detail = typeof json.message === "string" && json.message.length > 0 ? json.message : "";
  if (code === "etf_gate_not_ready") {
    return [
      "目前無法顯示 ETF 候選排名與標的差異說明：後端判定資料尚未通過內部檢查（gate），可能與行情欄位完整度或候選池狀態有關。",
      detail ? `（詳情：${detail}）` : "",
      "請稍後再試；可先參考頁面上方「今日」與「報告」的整體說明。",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (code.length > 0) {
    return detail ? `${code}（${detail}）` : code;
  }
  const msg = json.message;
  if (typeof msg === "string" && msg.length > 0) return msg;
  return "伺服器回傳錯誤，請稍後再試。";
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
          const msg = isRecord(json)
            ? humanCandidatesErrorBody(json)
            : `無法連線至 Candidates（HTTP ${String(res.status)}），請稍後再試。`;
          setState({ phase: "error", message: msg });
          return;
        }

        if (isRecord(json) && json.ok === false) {
          setState({ phase: "error", message: humanCandidatesErrorBody(json) });
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
          <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.75 }} data-testid="candidates-updated">
            資料時間（台灣）：{state.body.data.display.generatedAtTaipei}
          </p>

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
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>標的差異說明</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {state.body.data.deltaExplain.pairs.map((pair, i) => (
                <div
                  key={`${pair.from}-${pair.to}-${String(i)}`}
                  data-testid={`candidates-pair-${String(i)}`}
                >
                  <p style={{ margin: "0 0 0.35rem", fontWeight: 600 }}>
                    {pair.from} 與 {pair.to}
                  </p>
                  <p
                    style={{
                      margin: 0,
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                    data-testid={`candidates-pair-narrative-${String(i)}`}
                  >
                    {pair.narrativeZh}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem" }}>決策與信心</h3>
            <p style={{ margin: "0 0 0.5rem" }} data-testid="candidates-decision-human">
              {state.body.data.display.decisionLabelZh}
            </p>
            <p style={{ margin: 0 }} data-testid="candidates-confidence-human">
              {state.body.data.display.confidenceNarrativeZh}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
