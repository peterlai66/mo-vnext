interface KVListKey {
	name: string;
}

interface KVListResult {
	keys: KVListKey[];
}

interface KVNamespace {
	put(key: string, value: string): Promise<void>;
	get(key: string, type: "text"): Promise<string | null>;
	delete(key: string): Promise<void>;
	list(options: { prefix?: string; limit?: number }): Promise<KVListResult>;
}

interface NoteRecord {
	id: string;
	userId: string;
	content: string;
	createdAt: string;
}

interface ListedNote {
	key: string;
	content: string;
	sortTimestamp: number;
}

export interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	LINE_CHANNEL_SECRET: string;
	MO_NOTES: KVNamespace;
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

function parseListedNote(keyName: string, storedValue: string): ListedNote {
	const fallbackTimestamp = parseTimestampFromKey(keyName);

	try {
		const parsed: unknown = JSON.parse(storedValue);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"content" in parsed &&
			typeof parsed.content === "string"
		) {
			let sortTimestamp = fallbackTimestamp;
			if ("createdAt" in parsed && typeof parsed.createdAt === "string") {
				const createdAtTs = Date.parse(parsed.createdAt);
				if (Number.isFinite(createdAtTs)) {
					sortTimestamp = createdAtTs;
				}
			}
			return { key: keyName, content: parsed.content, sortTimestamp };
		}
	} catch {
		// Fallback to legacy plain-text value
	}

	return { key: keyName, content: storedValue, sortTimestamp: fallbackTimestamp };
}

async function listUserNotes(
	env: Env,
	userId: string,
	limit: number
): Promise<ListedNote[]> {
	const prefix = `note:${userId}:`;
	const listResult = await env.MO_NOTES.list({ prefix, limit });
	const noteEntries = await Promise.all(
		listResult.keys.map(async (key) => {
			const value = await env.MO_NOTES.get(key.name, "text");
			if (value === null) return null;
			return parseListedNote(key.name, value);
		})
	);

	return noteEntries
		.filter((entry): entry is ListedNote => entry !== null)
		.sort((a, b) => b.sortTimestamp - a.sortTimestamp)
		.slice(0, limit);
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
		return "pong";
	  case "/help":
		return `可用指令：
/ping - 測試
/help - 指令列表`;
	  case "/note": {
		if (messageText.startsWith("/note search")) {
			const match = messageText.match(/^\/note\s+search\s+(.+)$/);
			const keyword = match?.[1]?.trim() ?? "";
			if (!keyword) return "請輸入關鍵字，例如 /note search 牛奶";

			const matchedNotes = (await listUserNotes(env, userId, 1000)).filter(
				(note) => note.content.includes(keyword)
			);

			if (matchedNotes.length === 0) return "找不到相關筆記";

			return `搜尋結果：
${matchedNotes.map((note, index) => `${index + 1}. ${note.content}`).join("\n")}`;
		}

		if (messageText.startsWith("/note del")) {
			const match = messageText.match(/^\/note\s+del\s+(\d+)$/);
			if (!match) return "請提供正確的編號，例如 /note del 1";

			const index = Number(match[1]);
			if (!Number.isInteger(index) || index < 1) {
				return "請提供正確的編號，例如 /note del 1";
			}

			const notes = await listUserNotes(env, userId, 1000);
			const targetNote = notes[index - 1];
			if (!targetNote) return "找不到該筆記";

			await env.MO_NOTES.delete(targetNote.key);
			return `已刪除：${targetNote.content}`;
		}

		const noteContent = messageText.slice("/note".length).trim();
		if (!noteContent) return "請輸入內容，例如：/note 今天買牛奶";
	  
		const timestamp = Date.now();
		const key = `note:${userId}:${timestamp}`;
		const noteRecord: NoteRecord = {
			id: String(timestamp),
			userId,
			content: noteContent,
			createdAt: new Date(timestamp).toISOString(),
		};
		await env.MO_NOTES.put(key, JSON.stringify(noteRecord));
	  
		return `已記錄：${noteContent}`;
	  }
	  case "/notes": {
		const notes = (await listUserNotes(env, userId, 10)).map(
			(entry) => entry.content
		);

		if (notes.length === 0) return "目前沒有已記錄的筆記";

		return `你的最近筆記：
${notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`;
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
		const url = new URL(request.url);
  
	  if (url.pathname === "/api/line/webhook" && request.method === "POST") {
		const body = (await request.json()) as LineWebhookBody;
		const events = body.events ?? [];
  
		for (const event of events) {
		  if (
			event.type === "message" &&
			event.message?.type === "text" &&
			event.replyToken
		  ) {
			const userId = event.source?.userId ?? "unknown-user";
			const replyText = await getReplyText(event.message.text, env, userId);
			await fetch("https://api.line.me/v2/bot/message/reply", {
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