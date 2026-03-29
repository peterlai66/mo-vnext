/**
 * Cloudflare Workers 執行環境 binding（從 index.ts 抽出，避免 circular import）。
 */
export interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	LINE_CHANNEL_SECRET: string;
	MO_NOTES: KVNamespace;
	MO_DB: D1Database;
	OPENAI_API_KEY: string;
	LINE_MODE?: "normal" | "reply_only" | "push_enabled";
	DEBUG_LOG?: string;
	/** 僅測試用：非空時覆寫 /report 與 push 決策用的 actionLine（未設定則維持 buildActionText(score)） */
	MO_FORCE_REPORT_ACTION_LINE?: string;
	/** FinMind API token（TWSE 失敗時 fallback 使用） */
	FINMIND_TOKEN?: string;
	/** 僅驗證用：設為 "1" 時不呼叫 TWSE，直接走 FinMind fallback（正式請勿啟用） */
	MO_FORCE_TWSE_FAIL_FOR_TEST?: string;
	/** OpenAI chat 模型（intent 解析）；未設定時預設 gpt-4o-mini */
	OPENAI_MODEL?: string;
}
