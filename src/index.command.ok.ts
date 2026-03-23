export interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	LINE_CHANNEL_SECRET: string;
  }

function extractCommand(messageText: string): string | null {
	// 目前只把「整句就是指令」當作 command（避免改變既有行為，如 `/ping ` 仍會走 echo）
	// 後續若要支援 `/command arg`，可在這裡擴充解析。
	return /^\/[A-Za-z0-9_]+$/.test(messageText) ? messageText : null;
}

function handleCommand(command: string | null, messageText: string): string {
	switch (command) {
	  case "/ping":
		return "pong";
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

function getReplyText(messageText: string | undefined): string {
	const text = messageText ?? "";
	const command = extractCommand(text);
	return handleCommand(command, text);
}
  
  type LineWebhookBody = {
	events?: Array<{
	  type: string;
	  replyToken?: string;
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
			const replyText = getReplyText(event.message.text);
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