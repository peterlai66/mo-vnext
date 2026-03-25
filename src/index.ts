interface KVListKey {
	name: string;
}

interface KVListResult {
	keys: KVListKey[];
	list_complete?: boolean;
	cursor?: string;
}

interface KVNamespace {
	put(key: string, value: string): Promise<void>;
	get(key: string, type: "text"): Promise<string | null>;
	delete(key: string): Promise<void>;
	list(options: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<KVListResult>;
}

interface D1PreparedStatement {
	bind(...values: Array<string | number>): D1PreparedStatement;
	run(): Promise<unknown>;
	first(): Promise<unknown>;
}

interface D1Database {
	prepare(query: string): D1PreparedStatement;
}

interface NoteRecord {
	id: string;
	userId: string;
	content: string;
	createdAt: string;
}

interface UserNote {
	key: string;
	content: string;
	createdAt: number;
}

export interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	LINE_CHANNEL_SECRET: string;
	MO_NOTES: KVNamespace;
	MO_DB: D1Database;
	OPENAI_API_KEY: string;
	DEBUG_LOG?: string;
}

function isDebugLogEnabled(env: Env): boolean {
	return env.DEBUG_LOG === "true";
}

function debugLog(env: Env, ...args: unknown[]): void {
	if (!isDebugLogEnabled(env)) return;
	Reflect.apply(console.log, console, args);
}

function extractNoteContent(storedValue: string): string {
	try {
		const parsed: unknown = JSON.parse(storedValue);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"content" in parsed &&
			typeof parsed.content === "string"
		) {
			return parsed.content;
		}
		return storedValue;
	} catch {
		return storedValue;
	}
}

function parseTimestampFromKey(keyName: string): number {
	const parts = keyName.split(":");
	const tail = parts[parts.length - 1];
	const timestamp = Number(tail);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseUserNote(keyName: string, storedValue: string): UserNote {
	const fallbackTimestamp = parseTimestampFromKey(keyName);

	try {
		const parsed: unknown = JSON.parse(storedValue);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"content" in parsed &&
			typeof parsed.content === "string"
		) {
			let createdAt = fallbackTimestamp;
			if ("createdAt" in parsed && typeof parsed.createdAt === "string") {
				const createdAtTs = Date.parse(parsed.createdAt);
				if (Number.isFinite(createdAtTs)) {
					createdAt = createdAtTs;
				}
			}
			return { key: keyName, content: parsed.content, createdAt };
		}
	} catch {
		// Fallback to legacy plain-text value
	}

	return { key: keyName, content: storedValue, createdAt: fallbackTimestamp };
}

function buildEditedNoteValue(
	key: string,
	existingValue: string,
	newContent: string,
	userId: string,
	createdAt: number
): string {
	try {
		const parsed: unknown = JSON.parse(existingValue);
		if (typeof parsed === "object" && parsed !== null) {
			const updatedRecord = {
				...(parsed as Record<string, unknown>),
				content: newContent,
			};
			return JSON.stringify(updatedRecord);
		}
	} catch {
		// Fallback to creating normalized JSON record
	}

	const fallbackTimestamp = parseTimestampFromKey(key) || Date.now();
	const normalizedCreatedAt =
		createdAt > 0 ? new Date(createdAt).toISOString() : new Date(fallbackTimestamp).toISOString();
	const normalizedRecord: NoteRecord = {
		id: String(fallbackTimestamp),
		userId,
		content: newContent,
		createdAt: normalizedCreatedAt,
	};
	return JSON.stringify(normalizedRecord);
}

async function getUserNotes(env: Env, userId: string) {
	try {
	  const { results } = await env.MO_DB
		.prepare(
		  `SELECT id, content, created_at
		   FROM notes
		   WHERE user_id = ?
		   ORDER BY created_at DESC
		   LIMIT 50`
		)
		.bind(userId)
		.all();
  
	  if (results && results.length > 0) {
		return results.map((row: any) => ({
		  key: row.id,
		  content: row.content,
		  createdAt: row.created_at,
		}));
	  }
	} catch (err) {
	  console.error("D1 read error:", err);
	}
  
	// fallback KV
	const prefix = `note:${userId}:`;
	const list = await env.MO_NOTES.list({ prefix });
  
	const notes = await Promise.all(
	  list.keys.map(async (k) => {
		const v = await env.MO_NOTES.get(k.name);
		if (!v) return null;
  
		try {
		  const parsed = JSON.parse(v);
		  return {
			key: k.name,
			content: parsed.content ?? v,
			createdAt: Number(parsed.createdAt ?? k.name.split(":").pop()),
		  };
		} catch {
		  return {
			key: k.name,
			content: v,
			createdAt: Number(k.name.split(":").pop()),
		  };
		}
	  })
	);
  
	return notes
	  .filter((n) => n !== null)
	  .sort((a, b) => b!.createdAt - a!.createdAt);
  }

function extractTopKeywords(contents: string[], topN: number): string[] {
	const wordCount = new Map<string, number>();

	for (const content of contents) {
		const words = content
			.toLowerCase()
			.split(/[\s,，。！？!?.、;；:：()（）\[\]{}"']/)
			.map((word) => word.trim())
			.filter((word) => word.length > 0);

		for (const word of words) {
			wordCount.set(word, (wordCount.get(word) ?? 0) + 1);
		}
	}

	return [...wordCount.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, topN)
		.map(([word]) => word);
}

function extractAiSummaryText(responseJson: unknown): string | null {
	if (
		typeof responseJson !== "object" ||
		responseJson === null ||
		!("choices" in responseJson) ||
		!Array.isArray(responseJson.choices) ||
		responseJson.choices.length === 0
	) {
		return null;
	}

	const firstChoice = responseJson.choices[0];
	if (
		typeof firstChoice !== "object" ||
		firstChoice === null ||
		!("message" in firstChoice)
	) {
		return null;
	}

	const message = firstChoice.message;
	if (
		typeof message !== "object" ||
		message === null ||
		!("content" in message) ||
		typeof message.content !== "string"
	) {
		return null;
	}

	return message.content.trim() || null;
}

async function generateAiSummary(notesText: string, env: Env): Promise<string | null> {
	try {
		const systemPrompt =
			"你是筆記整理助手。請用繁體中文回覆，精簡整理且最多 5 行，聚焦：1) 最近在做的事 2) 主要主題 3) 若有明顯待辦可順帶列出。";
		const userPrompt = `請幫我摘要以下使用者筆記，重點整理使用者近期在做的事情與主題：

${notesText}`;

		const response = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model: "gpt-4o-mini",
				temperature: 0.2,
				max_completion_tokens: 220,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
			}),
		});

		if (!response.ok) return null;
		const responseJson = (await response.json()) as unknown;
		return extractAiSummaryText(responseJson);
	} catch {
		return null;
	}
}

function extractCommand(messageText: string): string | null {
	// 目前只把「整句就是指令」當作 command（避免改變既有行為，如 `/ping ` 仍會走 echo）
	// 後續若要支援 `/command arg`，可在這裡擴充解析。
	if (messageText === "/notes") return "/notes";
	if (/^\/note(?:\s+|$)/.test(messageText)) return "/note";
	return /^\/[A-Za-z0-9_]+$/.test(messageText) ? messageText : null;
}

async function handleCommand(
	command: string | null,
	messageText: string,
	env: Env,
	userId: string
): Promise<string> {
	switch (command) {
	  case "/ping":
		debugLog(env, "/ping hit");
		return "pong";
	  case "/help":
		return `可用指令：

【筆記功能】
/note 內容 → 新增筆記
/note del 編號 → 刪除筆記
/note search 關鍵字 → 搜尋筆記
/note clear → 清空所有筆記

【查看】
/notes → 查看最近筆記

【分析】
/note summary → 簡易摘要
/note ai-summary → AI 智慧摘要

【其他】
/ping → 測試系統狀態`;
	  case "/note": {
		const noteContent = messageText.slice("/note".length).trim();
		const latestKey = `note:${userId}`;

		if (noteContent === "del") {
			const stored = await env.MO_NOTES.get(latestKey, "text");
			if (stored === null || stored === "") {
				return "目前沒有可刪除的筆記";
			}
			await env.MO_NOTES.delete(latestKey);
			return "已刪除最新筆記";
		}

		if (!noteContent) {
			const stored = await env.MO_NOTES.get(latestKey, "text");
			if (stored !== null && stored !== "") {
				return stored;
			}
			return "你目前還沒有筆記";
		}

		await env.MO_NOTES.put(latestKey, noteContent);

		const timestamp = Date.now();
		const historyKey = `note:${userId}:${timestamp}`;
		const noteRecord: NoteRecord = {
			id: String(timestamp),
			userId,
			content: noteContent,
			createdAt: new Date(timestamp).toISOString(),
		};
		await env.MO_NOTES.put(historyKey, JSON.stringify(noteRecord));

		return "已儲存你的筆記";
	  }
	  case "/notes": {
		const prefix = `note:${userId}:`;
		const list = await env.MO_NOTES.list({ prefix });
		const sortedKeyNames = [...list.keys]
			.map((k) => k.name)
			.sort((a, b) => parseTimestampFromKey(b) - parseTimestampFromKey(a));

		const lines: string[] = [];
		for (const keyName of sortedKeyNames) {
			if (lines.length >= 5) break;
			const raw = await env.MO_NOTES.get(keyName, "text");
			if (raw === null || raw === "") continue;
			const content = extractNoteContent(raw).trim();
			if (content === "") continue;
			lines.push(content);
		}

		if (lines.length === 0) return "你目前還沒有歷史筆記";

		return `你的最近筆記：
${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
	  }
	  case "/status": {
		let d1Label: "ok" | "error" = "error";
		try {
			await env.MO_DB.prepare("SELECT 1 as ok").first();
			d1Label = "ok";
		} catch {
			d1Label = "error";
		}
		const hasUserId = userId.trim() !== "";
		const userLabel = hasUserId ? "ok" : "none";
		let noteCountDisplay: number | "error" = 0;
		if (hasUserId) {
			try {
				const list = await env.MO_NOTES.list({
					prefix: `note:${userId}:`,
					limit: 20,
				});
				noteCountDisplay = list.keys.length;
			} catch {
				noteCountDisplay = "error";
			}
		}
		return `MO Status
app: mo-vnext
version: dev
command: ok
kv: ok
d1: ${d1Label}
user: ${userLabel}
noteCount: ${noteCountDisplay}`;
	  }
	  case "/report": {
		const hasUserId = userId.trim() !== "";
		const userLabel = hasUserId ? "ok" : "none";
		let notesCount = 0;
		if (hasUserId) {
			try {
				const list = await env.MO_NOTES.list({
					prefix: `note:${userId}:`,
					limit: 20,
				});
				notesCount = list.keys.length;
			} catch {
				notesCount = 0;
			}
		}
		return `MO Report
system: online
command: ready
storage: kv+d1
user: ${userLabel}
notes: ${notesCount}`;
	  }
	  // TODO: later commands
	  // case "/help":
	  //  return "...";
	  // case "/stock":
	  //  return "...";
	  // case "/note":
	  //  return "...";
	  default:
		// 保持原本 echo 行為
		return `你剛剛說：${messageText ?? ""}`;
	}
}

async function getReplyText(
	messageText: string | undefined,
	env: Env,
	userId: string
): Promise<string> {
	const text = messageText ?? "";
	const command = extractCommand(text);
	debugLog(env, "[line webhook] command before handleCommand:", command, "text:", text);
	return await handleCommand(command, text, env, userId);
}
  
  type LineWebhookBody = {
	events?: Array<{
	  type: string;
	  replyToken?: string;
	  source?: {
		userId?: string;
	  };
	  message?: {
		type?: string;
		text?: string;
	  };
	}>;
  };
  
  export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		debugLog(env, "[fetch] hit");
		debugLog(env, "[fetch] path", new URL(request.url).pathname);
		const url = new URL(request.url);
  
	  if (
		(url.pathname === "/api/line/webhook" || url.pathname === "/line/webhook") &&
		request.method === "POST"
	  ) {
		if (url.pathname === "/line/webhook") {
			debugLog(env, "[line] route hit");
		}
		const body = (await request.json()) as LineWebhookBody;
		debugLog(env, "[line] body", JSON.stringify(body));
		const events = body.events ?? [];
		debugLog(env, "[line webhook] eventCount:", events.length);

		for (const event of events) {
		  if (event.type === "message") {
			debugLog(env, "[line webhook] message event, event.type:", event.type);
		  }
		  if (
			event.type === "message" &&
			event.message?.type === "text" &&
			event.replyToken
		  ) {
			debugLog(env, "[line webhook] text message:", event.message.text ?? "");
			const userId = event.source?.userId ?? "unknown-user";
			const replyText = await getReplyText(event.message.text, env, userId);
			const response = await fetch("https://api.line.me/v2/bot/message/reply", {
			  method: "POST",
			  headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
			  },
			  body: JSON.stringify({
				replyToken: event.replyToken,
				messages: [
				  {
					type: "text",
					text: replyText,
				  },
				],
			  }),
			});
			debugLog(env, "[line reply] status", response.status);
			debugLog(env, "[line reply] ok", response.ok);
			debugLog(env, "[line reply] body", await response.text());
		  }
		}
  
		return new Response(
		  JSON.stringify({ ok: true, eventCount: events.length }),
		  {
			headers: { "Content-Type": "application/json" },
		  }
		);
	  }
  
	  return new Response("Hello World!");
	},
  };
  // test commit