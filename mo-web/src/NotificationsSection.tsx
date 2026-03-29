import { useEffect, useState } from "react";

type NotificationType = "recommendation" | "governance" | "report" | "system";
type NotificationSeverity = "info" | "warning" | "critical";

type NotificationItem = {
  id: string;
  timestamp: string;
  type: NotificationType;
  title: string;
  summary: string;
  severity: NotificationSeverity;
};

type NotificationsApiSuccessBody = {
  ok: true;
  generatedAt: string;
  data: { items: NotificationItem[] };
};

type NotificationsViewState =
  | { phase: "loading" }
  | { phase: "success"; body: NotificationsApiSuccessBody }
  | { phase: "empty"; generatedAt: string }
  | { phase: "error"; message: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isNotificationItem(x: unknown): x is NotificationItem {
  if (!isRecord(x)) return false;
  return (
    typeof x.id === "string" &&
    typeof x.timestamp === "string" &&
    typeof x.title === "string" &&
    typeof x.summary === "string" &&
    typeof x.type === "string" &&
    typeof x.severity === "string"
  );
}

function isNotificationsApiSuccessBody(x: unknown): x is NotificationsApiSuccessBody {
  if (!isRecord(x) || x.ok !== true) return false;
  if (typeof x.generatedAt !== "string") return false;
  const data = x.data;
  if (!isRecord(data) || !Array.isArray(data.items)) return false;
  for (const it of data.items) {
    if (!isNotificationItem(it)) return false;
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

export default function NotificationsSection() {
  const [state, setState] = useState<NotificationsViewState>({ phase: "loading" });

  useEffect(() => {
    const ac = new AbortController();

    (async () => {
      setState({ phase: "loading" });
      try {
        const res = await fetch("/api/notifications", {
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

        if (!isNotificationsApiSuccessBody(json)) {
          setState({ phase: "error", message: "Notifications API 回應欄位不完整" });
          return;
        }

        if (json.data.items.length === 0) {
          setState({ phase: "empty", generatedAt: json.generatedAt });
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
              : "無法連線至 Notifications API";
        setState({ phase: "error", message });
      }
    })();

    return () => ac.abort();
  }, []);

  return (
    <section style={{ marginTop: "1.5rem" }} aria-labelledby="notifications-heading">
      <h2 id="notifications-heading" style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>
        通知
      </h2>

      {state.phase === "loading" && (
        <div
          role="status"
          aria-live="polite"
          aria-label="載入通知中"
          data-testid="notifications-loading"
          style={{
            padding: "1rem",
            borderRadius: 12,
            background: "rgba(100, 108, 255, 0.08)",
            border: "1px solid rgba(100, 108, 255, 0.25)",
          }}
        >
          載入通知中…
        </div>
      )}

      {state.phase === "error" && (
        <div
          role="alert"
          data-testid="notifications-error"
          style={{
            padding: "1rem",
            borderRadius: 12,
            background: "rgba(220, 53, 69, 0.1)",
            border: "1px solid rgba(220, 53, 69, 0.4)",
          }}
        >
          <strong>無法載入通知</strong>
          <p style={{ margin: "0.5rem 0 0", whiteSpace: "pre-wrap" }}>{state.message}</p>
        </div>
      )}

      {state.phase === "empty" && (
        <p data-testid="notifications-empty" style={{ margin: 0, opacity: 0.85 }}>
          目前沒有通知（generatedAt: {state.generatedAt}）
        </p>
      )}

      {state.phase === "success" && (
        <ul
          data-testid="notifications-list"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          {state.body.data.items.map((it) => (
            <li
              key={it.id}
              data-testid="notifications-item"
              style={{
                padding: "0.85rem 1rem",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.12)",
                background: "rgba(255,255,255,0.04)",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>{it.title}</div>
              <div style={{ fontSize: "0.9rem", opacity: 0.9, whiteSpace: "pre-wrap" }}>{it.summary}</div>
              <div style={{ fontSize: "0.75rem", opacity: 0.65, marginTop: "0.5rem" }}>
                <span data-testid="notif-time">{it.timestamp}</span>
                {" · "}
                <span data-testid="notif-type">{it.type}</span>
                {" · "}
                <span data-testid="notif-severity">{it.severity}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
