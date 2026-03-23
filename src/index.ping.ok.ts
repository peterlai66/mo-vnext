export interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	LINE_CHANNEL_SECRET: string;
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
					text:
					  event.message.text === "/ping"
						? "pong"
						: `你剛剛說：${event.message.text ?? ""}`,
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