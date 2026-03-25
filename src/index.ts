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

interface SystemStatus {
	app: string;
	command: string;
	kv: string;
	d1: string;
	user: string;
	/** 歷史筆記 key 數；無 user 為 0；KV list 失敗為 "error"（與 /status 顯示一致） */
	noteCount: number | "error";
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

const LINE_MESSAGE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

type LinePushResult =
	| "success"
	| "failed"
	| "blocked_by_monthly_limit"
	| "network_error";

/** push 結果 + 呼叫端判讀用 HTTP 資訊（network_error 時無 http*） */
type LinePushOutcome = {
	result: LinePushResult;
	httpStatus?: number;
	httpStatusText?: string;
	httpBody?: string;
};

function isLinePushMonthlyLimitDenied(status: number, body: string): boolean {
	if (status !== 429) return false;
	if (body.includes("You have reached your monthly limit")) return true;
	return body.toLowerCase().includes("monthly limit");
}

/** LINE push；失敗不 throw，僅 log（不影響 caller） */
async function lineBotPushTextMessage(
	env: Env,
	userId: string,
	text: string
): Promise<LinePushOutcome> {
	try {
		console.log("[push] start", { userId, message: text });
		const response = await fetch(LINE_MESSAGE_PUSH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
			},
			body: JSON.stringify({
				to: userId,
				messages: [{ type: "text", text }],
			}),
		});
		const body = await response.text();
		const status = response.status;
		const statusText = response.statusText;
		console.log("[push] response", {
			status,
			statusText,
			body,
		});
		const http = { httpStatus: status, httpStatusText: statusText, httpBody: body };
		if (response.ok) {
			console.log("[push] success");
			return { result: "success", ...http };
		}
		if (isLinePushMonthlyLimitDenied(status, body)) {
			console.log("[push] blocked by monthly limit", {
				userId,
				status,
				statusText,
				body,
			});
			return { result: "blocked_by_monthly_limit", ...http };
		}
		console.log("[push] failed", {
			status,
			statusText,
			body,
		});
		return { result: "failed", ...http };
	} catch (error: unknown) {
		console.log("[push] error", error);
		return { result: "network_error" };
	}
}

/** /status 顯示用；與 LinePushResult 對應（blocked 用 snake 以符合簡潔標籤） */
type LastPushDisplayKind =
	| "success"
	| "failed"
	| "blocked_monthly_limit"
	| "network_error";

type LastPushNotifyRecord = {
	kind: LastPushDisplayKind;
	pushAt: string;
	pushStatus?: number;
	pushBodySummary?: string;
};

function linePushResultToDisplayKind(result: LinePushResult): LastPushDisplayKind {
	switch (result) {
		case "success":
			return "success";
		case "failed":
			return "failed";
		case "blocked_by_monthly_limit":
			return "blocked_monthly_limit";
		case "network_error":
			return "network_error";
	}
}

function formatStatusPushAtTaipei(d: Date): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Taipei",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(d);
	const pick = (type: Intl.DateTimeFormatPart["type"]) =>
		parts.find((p) => p.type === type)?.value ?? "";
	const y = pick("year");
	const mo = pick("month");
	const day = pick("day");
	const h = pick("hour");
	const min = pick("minute");
	const sec = pick("second");
	if (y === "" || mo === "" || day === "" || h === "" || min === "" || sec === "") {
		return d.toISOString();
	}
	return `${y}-${mo}-${day}T${h}:${min}:${sec}+08:00`;
}

function summarizePushBodyForStatus(body: string | undefined, maxLen: number): string | undefined {
	if (body === undefined) return undefined;
	const one = body.replace(/\s+/gu, " ").trim();
	if (one === "") return undefined;
	if (one.length <= maxLen) return one;
	return `${one.slice(0, maxLen)}…`;
}

const MO_USER_KV_PREFIX = {
	lastPushNotify: "last_push_notify",
	lastStrategyDecision: "last_strategy_decision",
	lastReportSummary: "last_report_summary",
	lastStrategyNotifyGate: "last_strategy_notify_gate",
} as const;

/** 正式 strategy notify：兩次推播嘗試最短間隔（毫秒） */
const STRATEGY_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;

type StrategyNotifyGateRecord = {
	lastNotifyMessage: string;
	lastNotifyAt: number;
};

function getStrategyNotifyGateKey(userId: string): string {
	return buildMoUserKvKey(MO_USER_KV_PREFIX.lastStrategyNotifyGate, userId);
}

function parseStrategyNotifyGateRecord(raw: string): StrategyNotifyGateRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (
			!("lastNotifyMessage" in parsed) ||
			typeof parsed.lastNotifyMessage !== "string"
		) {
			return null;
		}
		if (
			!("lastNotifyAt" in parsed) ||
			typeof parsed.lastNotifyAt !== "number" ||
			!Number.isFinite(parsed.lastNotifyAt)
		) {
			return null;
		}
		return {
			lastNotifyMessage: parsed.lastNotifyMessage,
			lastNotifyAt: parsed.lastNotifyAt,
		};
	} catch {
		return null;
	}
}

async function recordStrategyNotifyGateAttempt(
	env: Env,
	userId: string,
	message: string,
	atMs: number
): Promise<void> {
	try {
		const rec: StrategyNotifyGateRecord = {
			lastNotifyMessage: message,
			lastNotifyAt: atMs,
		};
		await env.MO_NOTES.put(
			getStrategyNotifyGateKey(userId),
			JSON.stringify(rec)
		);
	} catch {
		// gate 寫入失敗不阻擋 notify 主流程
	}
}

const MO_STATUS_DEFAULT_BLOCK = {
	lastPush: "lastPush: none",
	decision: "decision: none",
	report: "report: none",
} as const;

function hasMoStatusUserId(userId: string): boolean {
	return userId.trim() !== "" && userId !== "unknown-user";
}

function buildMoUserKvKey(prefix: string, userId: string): string {
	return `${prefix}:${userId}`;
}

async function readMoUserKvJson<T>(
	env: Env,
	userId: string,
	key: string,
	parse: (raw: string) => T | null
): Promise<T | null> {
	try {
		const raw = await env.MO_NOTES.get(key, "text");
		if (raw === null || raw.trim() === "") return null;
		return parse(raw);
	} catch {
		return null;
	}
}

function getLastPushNotifyKey(userId: string): string {
	return buildMoUserKvKey(MO_USER_KV_PREFIX.lastPushNotify, userId);
}

function isLastPushDisplayKind(value: string): value is LastPushDisplayKind {
	return (
		value === "success" ||
		value === "failed" ||
		value === "blocked_monthly_limit" ||
		value === "network_error"
	);
}

function parseLastPushNotifyRecord(raw: string): LastPushNotifyRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (!("kind" in parsed) || typeof parsed.kind !== "string") return null;
		if (!isLastPushDisplayKind(parsed.kind)) return null;
		if (!("pushAt" in parsed) || typeof parsed.pushAt !== "string") return null;
		const rec: LastPushNotifyRecord = {
			kind: parsed.kind,
			pushAt: parsed.pushAt,
		};
		if (
			"pushStatus" in parsed &&
			typeof parsed.pushStatus === "number" &&
			Number.isFinite(parsed.pushStatus)
		) {
			rec.pushStatus = parsed.pushStatus;
		}
		if (
			"pushBodySummary" in parsed &&
			typeof parsed.pushBodySummary === "string" &&
			parsed.pushBodySummary !== ""
		) {
			rec.pushBodySummary = parsed.pushBodySummary;
		}
		return rec;
	} catch {
		return null;
	}
}

/** 將 push 結果寫入 KV（與 decision 相同命名空間），供 /status 跨 isolate 讀取 */
async function recordLinePushOutcomeForStatus(
	env: Env,
	userId: string,
	outcome: LinePushOutcome
): Promise<void> {
	const kind = linePushResultToDisplayKind(outcome.result);
	const pushAt = formatStatusPushAtTaipei(new Date());
	const pushStatus = outcome.httpStatus;
	const pushBodySummary =
		outcome.result === "network_error" ?
			"network_error"
		:	summarizePushBodyForStatus(outcome.httpBody, 160);
	const record: LastPushNotifyRecord = {
		kind,
		pushAt,
		...(pushStatus !== undefined ? { pushStatus } : {}),
		...(pushBodySummary !== undefined ? { pushBodySummary } : {}),
	};
	try {
		await env.MO_NOTES.put(getLastPushNotifyKey(userId), JSON.stringify(record));
	} catch {
		// 記錄失敗不影響 push / reply 主流程
	}
}

async function formatLastPushStatusBlock(
	env: Env,
	userId: string
): Promise<string> {
	if (!hasMoStatusUserId(userId)) return MO_STATUS_DEFAULT_BLOCK.lastPush;
	const r = await readMoUserKvJson(
		env,
		userId,
		getLastPushNotifyKey(userId),
		parseLastPushNotifyRecord
	);
	if (r === null) return MO_STATUS_DEFAULT_BLOCK.lastPush;
	const lines: string[] = [`lastPush: ${r.kind}`];
	if (r.pushStatus !== undefined) {
		lines.push(`pushStatus: ${r.pushStatus}`);
	}
	lines.push(`pushAt: ${r.pushAt}`);
	if (r.pushBodySummary !== undefined && r.pushBodySummary !== "") {
		lines.push(`pushBody: ${r.pushBodySummary}`);
	}
	return lines.join("\n");
}

type StrategyDecisionRecord = {
	changed: boolean;
	shouldNotify: boolean;
	hasMessage: boolean;
	timestamp: string;
};

function getLastStrategyDecisionKey(userId: string): string {
	return buildMoUserKvKey(MO_USER_KV_PREFIX.lastStrategyDecision, userId);
}

async function recordStrategyDecision(
	env: Env,
	userId: string,
	decision: StrategyDecisionRecord
): Promise<void> {
	try {
		await env.MO_NOTES.put(getLastStrategyDecisionKey(userId), JSON.stringify(decision));
	} catch {
		// decision 記錄失敗不影響 /report 主流程
	}
}

function parseStrategyDecisionRecord(raw: string): StrategyDecisionRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (!("changed" in parsed) || typeof parsed.changed !== "boolean") return null;
		if (!("shouldNotify" in parsed) || typeof parsed.shouldNotify !== "boolean") return null;
		if (!("hasMessage" in parsed) || typeof parsed.hasMessage !== "boolean") return null;
		if (!("timestamp" in parsed) || typeof parsed.timestamp !== "string") return null;
		return {
			changed: parsed.changed,
			shouldNotify: parsed.shouldNotify,
			hasMessage: parsed.hasMessage,
			timestamp: parsed.timestamp,
		};
	} catch {
		return null;
	}
}

async function formatLastStrategyDecisionStatusBlock(
	env: Env,
	userId: string
): Promise<string> {
	if (!hasMoStatusUserId(userId)) return MO_STATUS_DEFAULT_BLOCK.decision;
	const decision = await readMoUserKvJson(
		env,
		userId,
		getLastStrategyDecisionKey(userId),
		parseStrategyDecisionRecord
	);
	if (decision === null) return MO_STATUS_DEFAULT_BLOCK.decision;
	return `decisionChanged: ${decision.changed}
shouldNotify: ${decision.shouldNotify}
hasMessage: ${decision.hasMessage}
decisionAt: ${decision.timestamp}`;
}

type ReportSummaryRecord = {
	currentStrategy: "aggressive" | "balanced" | "conservative";
	previousStrategy: string;
	changed: boolean;
	shouldNotify: boolean;
	recommendationStatus: "active" | "none";
	recommendationReason?: string;
	simulationReady: boolean;
	simulationResult?: string;
	timestamp: string;
};

function getLastReportSummaryKey(userId: string): string {
	return buildMoUserKvKey(MO_USER_KV_PREFIX.lastReportSummary, userId);
}

async function recordLastReportSummary(
	env: Env,
	userId: string,
	summary: ReportSummaryRecord
): Promise<void> {
	try {
		await env.MO_NOTES.put(getLastReportSummaryKey(userId), JSON.stringify(summary));
	} catch {
		// report summary 記錄失敗不影響 /report 主流程
	}
}

function parseReportSummaryRecord(raw: string): ReportSummaryRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;

		if (!("currentStrategy" in parsed) || typeof parsed.currentStrategy !== "string") {
			return null;
		}
		if (
			parsed.currentStrategy !== "aggressive" &&
			parsed.currentStrategy !== "balanced" &&
			parsed.currentStrategy !== "conservative"
		) {
			return null;
		}
		if (!("previousStrategy" in parsed) || typeof parsed.previousStrategy !== "string") {
			return null;
		}
		if (!("changed" in parsed) || typeof parsed.changed !== "boolean") return null;
		if (!("shouldNotify" in parsed) || typeof parsed.shouldNotify !== "boolean") return null;
		if (
			!("recommendationStatus" in parsed) ||
			typeof parsed.recommendationStatus !== "string" ||
			(parsed.recommendationStatus !== "active" && parsed.recommendationStatus !== "none")
		) {
			return null;
		}
		if (!("simulationReady" in parsed) || typeof parsed.simulationReady !== "boolean") {
			return null;
		}
		if (!("timestamp" in parsed) || typeof parsed.timestamp !== "string") return null;

		const rec: ReportSummaryRecord = {
			currentStrategy: parsed.currentStrategy,
			previousStrategy: parsed.previousStrategy,
			changed: parsed.changed,
			shouldNotify: parsed.shouldNotify,
			recommendationStatus: parsed.recommendationStatus,
			simulationReady: parsed.simulationReady,
			timestamp: parsed.timestamp,
		};
		if (
			"recommendationReason" in parsed &&
			typeof parsed.recommendationReason === "string" &&
			parsed.recommendationReason.trim() !== ""
		) {
			rec.recommendationReason = parsed.recommendationReason;
		}
		if (
			"simulationResult" in parsed &&
			typeof parsed.simulationResult === "string" &&
			parsed.simulationResult.trim() !== ""
		) {
			rec.simulationResult = parsed.simulationResult;
		}
		return rec;
	} catch {
		return null;
	}
}

async function formatLastReportSummaryStatusBlock(env: Env, userId: string): Promise<string> {
	if (!hasMoStatusUserId(userId)) return MO_STATUS_DEFAULT_BLOCK.report;
	const r = await readMoUserKvJson(
		env,
		userId,
		getLastReportSummaryKey(userId),
		parseReportSummaryRecord
	);
	if (r === null) return MO_STATUS_DEFAULT_BLOCK.report;
	const lines: string[] = [
		`reportStrategy: ${r.currentStrategy}`,
		`reportPrev: ${r.previousStrategy}`,
		`reportChanged: ${r.changed}`,
		`reportShouldNotify: ${r.shouldNotify}`,
		`reportRec: ${r.recommendationStatus}`,
	];
	if (r.recommendationReason !== undefined) {
		lines.push(`reportReason: ${r.recommendationReason}`);
	}
	lines.push(`reportSimReady: ${r.simulationReady ? "yes" : "no"}`);
	if (r.simulationResult !== undefined) {
		lines.push(`reportSimResult: ${r.simulationResult}`);
	}
	lines.push(`reportAt: ${r.timestamp}`);
	return lines.join("\n");
}

type MoStatusState = {
	lastPushBlock: string;
	decisionBlock: string;
	reportBlock: string;
};

async function buildMoStatusState(env: Env, userId: string): Promise<MoStatusState> {
	const [lastPushBlock, decisionBlock, reportBlock] = await Promise.all([
		formatLastPushStatusBlock(env, userId),
		formatLastStrategyDecisionStatusBlock(env, userId),
		formatLastReportSummaryStatusBlock(env, userId),
	]);
	return { lastPushBlock, decisionBlock, reportBlock };
}

function renderMoStatusText(params: {
	app: string;
	version: string;
	command: string;
	kv: string;
	d1: string;
	userLine: string;
	noteCount: number | "error";
	state: MoStatusState;
}): string {
	const formatSection = (title: string, block: string): string => {
		const lines = block
			.split(/\r?\n/u)
			.map((l) => l.trim())
			.filter((l) => l !== "");
		if (lines.length === 0) return `[${title}]\n- none`;
		return `[${title}]\n${lines.map((l) => `- ${l}`).join("\n")}`;
	};
	const statusText = `MO Status
app: ${params.app}
version: ${params.version}
command: ${params.command}
kv: ${params.kv}
d1: ${params.d1}
user: ${params.userLine}
noteCount: ${params.noteCount}

${formatSection("Push", params.state.lastPushBlock)}

${formatSection("Decision", params.state.decisionBlock)}

${formatSection("Report", params.state.reportBlock)}`;
	// safeguard: 避免標題被意外多出字元（例如 eMO Status）
	return statusText.replace(/^eMO Status/u, "MO Status");
}

function renderMoReportText(params: {
	app: string;
	command: string;
	kv: string;
	d1: string;
	userLine: string;
	notesValue: number;
	debugNotePrefix: string;
	debugKvListCount: number;
	debugKvKeysSection: string;
	strategyChangeBlock: string;
	summaryBlock: string;
	recommendationBlock: string;
	simulationBlock: string;
}): string {
	return `MO Report

[System]

* app: ${params.app}
* command: ${params.command}
* storage: kv+d1
* kv: ${params.kv}
* d1: ${params.d1}
* user: ${params.userLine}
* notes: ${params.notesValue}
* debugNotePrefix: ${params.debugNotePrefix}
* debugKvListCount: ${params.debugKvListCount}
${params.debugKvKeysSection}

[Strategy]

${params.strategyChangeBlock}

[Summary]

${params.summaryBlock}

[Recommendation]

${params.recommendationBlock}

[Simulation]

${params.simulationBlock}`;
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

/** 將 key 尾段 timestamp（毫秒）轉為台北本地時間 YYYY-MM-DD HH:mm；失敗則回傳原字串 */
function formatNoteKeyTimestampForReport(tail: string): string {
	const n = Number(tail);
	if (!Number.isFinite(n)) return tail;
	const d = new Date(n);
	const ms = d.getTime();
	if (!Number.isFinite(ms)) return tail;
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Taipei",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(d);
	const pick = (type: Intl.DateTimeFormatPart["type"]) =>
		parts.find((p) => p.type === type)?.value ?? "";
	const y = pick("year");
	const mo = pick("month");
	const day = pick("day");
	const h = pick("hour");
	const min = pick("minute");
	if (y === "" || mo === "" || day === "" || h === "" || min === "") return tail;
	return `${y}-${mo}-${day} ${h}:${min}`;
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
	if (messageText === "/push-test") return "/push-test";
	if (messageText === "/report-test-change") return "/report-test-change";
	if (messageText === "/debug-strategy-change") return "/debug-strategy-change";
	if (/^\/note(?:\s+|$)/.test(messageText)) return "/note";
	return /^\/[A-Za-z0-9_]+$/.test(messageText) ? messageText : null;
}

/** 暫時測試：/report-test-change 用，使 current 與 KV previous 不同以驗證 notify */
function pickForcedStrategyForReportTest(
	prevTrim: string,
	computed: "aggressive" | "balanced" | "conservative"
): "aggressive" | "balanced" | "conservative" {
	if (prevTrim === "aggressive") return "conservative";
	if (prevTrim === "balanced") return "conservative";
	if (prevTrim === "conservative") return "aggressive";
	if (computed === "aggressive") return "conservative";
	if (computed === "balanced") return "aggressive";
	return "balanced";
}

async function getSystemStatus(env: Env, userId: string): Promise<SystemStatus> {
	let d1Label: "ok" | "error" = "error";
	try {
		await env.MO_DB.prepare("SELECT 1 as ok").first();
		d1Label = "ok";
	} catch {
		d1Label = "error";
	}
	const hasUserId = userId.trim() !== "";
	const userLabel = hasUserId ? "ok" : "none";
	let noteCount: number | "error" = 0;
	if (hasUserId) {
		try {
			const list = await env.MO_NOTES.list({
				prefix: `note:${userId}:`,
				limit: 20,
			});
			noteCount = list.keys.length;
		} catch {
			noteCount = "error";
		}
	}
	return {
		app: "mo-vnext",
		command: "ok",
		kv: "ok",
		d1: d1Label,
		user: userLabel,
		noteCount,
	};
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
	  case "/debug-strategy-change": {
		const hasLineUser =
			userId.trim() !== "" && userId !== "unknown-user";
		if (!hasLineUser) {
			return "debug strategy change failed: no user";
		}

		const strategyKey = `strategy:${userId}`;
		const prevRaw = await env.MO_NOTES.get(strategyKey, "text");
		const previous =
			prevRaw !== null && prevRaw.trim() !== "" ? prevRaw.trim() : "balanced";
		const current = previous === "aggressive" ? "balanced" : "aggressive";
		const notifyMessage = `MO Strategy Update (DEBUG)
previous: ${previous}
current: ${current}
reason: forced debug strategy change`;

		const strategyDecision: StrategyDecisionRecord = {
			changed: true,
			shouldNotify: true,
			hasMessage: true,
			timestamp: formatStatusPushAtTaipei(new Date()),
		};
		await recordStrategyDecision(env, userId, strategyDecision);

		const pushOutcome = await lineBotPushTextMessage(env, userId, notifyMessage);
		await recordLinePushOutcomeForStatus(env, userId, pushOutcome);

		switch (pushOutcome.result) {
			case "success":
				console.log("[debug-strategy-change] success", { userId });
				break;
			case "blocked_by_monthly_limit":
				console.log("[debug-strategy-change] blocked by monthly limit", {
					userId,
					status: pushOutcome.httpStatus,
					body: pushOutcome.httpBody,
				});
				break;
			case "failed":
				console.log("[debug-strategy-change] failed", {
					userId,
					status: pushOutcome.httpStatus,
					body: pushOutcome.httpBody,
				});
				break;
			case "network_error":
				console.log("[debug-strategy-change] failed", {
					userId,
					reason: "network_error",
				});
				break;
		}

		return "DEBUG STRATEGY CHANGE EXECUTED";
	  }
	  case "/push-test": {
		const hasLineUser =
			userId.trim() !== "" && userId !== "unknown-user";
		if (!hasLineUser) {
			return "push test failed: no user";
		}
		return "PUSH TEST START";
	  }
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
		const s = await getSystemStatus(env, userId);
		const statusUserLine = s.user === "ok" ? `ok (${userId})` : "none";
		const state = await buildMoStatusState(env, userId);
		return renderMoStatusText({
			app: s.app,
			version: "dev",
			command: s.command,
			kv: s.kv,
			d1: s.d1,
			userLine: statusUserLine,
			noteCount: s.noteCount,
			state,
		});
	  }
	  case "/report-test-change":
	  case "/report": {
		const isReportTestChange = command === "/report-test-change";
		const s = await getSystemStatus(env, userId);
		const notesValue = s.noteCount === "error" ? 0 : s.noteCount;

		const hasUserId = userId.trim() !== "";
		const totalNotesNum = s.noteCount === "error" ? 0 : s.noteCount;
		let latestNoteMs: number | null = null;
		let summaryBlock: string;
		if (!hasUserId) {
			summaryBlock = `* latestNote: none
* totalNotes: 0`;
		} else {
			try {
				const list = await env.MO_NOTES.list({
					prefix: `note:${userId}:`,
					limit: 20,
				});
				const keyNames = list.keys.map((k) => k.name);
				if (keyNames.length === 0) {
					summaryBlock = `* latestNote: none
* totalNotes: 0`;
				} else {
					const sorted = [...keyNames].sort(
						(a, b) => parseTimestampFromKey(b) - parseTimestampFromKey(a)
					);
					const latestName = sorted[0];
					const tail =
						latestName.startsWith(`note:${userId}:`) ?
							latestName.slice(`note:${userId}:`.length)
						:	latestName.split(":").pop() ?? latestName;
					const ts = Number(tail);
					if (Number.isFinite(ts)) {
						const t = new Date(ts).getTime();
						if (Number.isFinite(t)) {
							latestNoteMs = ts;
						}
					}
					const latestReadable = formatNoteKeyTimestampForReport(tail);
					summaryBlock = `* latestNote: ${latestReadable}
* totalNotes: ${totalNotesNum}`;
				}
			} catch {
				summaryBlock = `* latestNote: none
* totalNotes: 0`;
			}
		}

		const twentyFourHoursMs = 24 * 60 * 60 * 1000;
		let recStatus: "active" | "idle";
		let recReason: string;
		if (latestNoteMs === null) {
			recStatus = "idle";
			recReason = "尚無資料";
		} else {
			const deltaMs = Date.now() - latestNoteMs;
			if (deltaMs <= twentyFourHoursMs) {
				recStatus = "active";
				recReason = "近期有活動";
			} else {
				recStatus = "idle";
				recReason = "長時間未更新";
			}
		}
		let recAction: string;
		if (totalNotesNum >= 10) {
			recAction = "建議進行策略分析（資料充足）";
		} else if (totalNotesNum >= 1) {
			recAction = "建議持續累積資料";
		} else {
			recAction = "建議新增第一筆資料";
		}
		const baseScore = Math.min(50, totalNotesNum * 5);
		const timeBonus =
			latestNoteMs !== null && Date.now() - latestNoteMs <= twentyFourHoursMs ?
				30
			:	0;
		const activityBonus = totalNotesNum >= 10 ? 20 : 0;
		const score = Math.min(100, baseScore + timeBonus + activityBonus);
		let strategy: "aggressive" | "balanced" | "conservative";
		if (score >= 80) {
			strategy = "aggressive";
		} else if (score >= 50) {
			strategy = "balanced";
		} else {
			strategy = "conservative";
		}
		const strategyFromScore = strategy;
		let prevTrimForReport = "";
		let strategyFinal: "aggressive" | "balanced" | "conservative" = strategyFromScore;
		if (hasUserId) {
			const strategyKeyRead = `strategy:${userId}`;
			const prevRawRead = await env.MO_NOTES.get(strategyKeyRead, "text");
			prevTrimForReport = prevRawRead !== null ? prevRawRead.trim() : "";
			if (isReportTestChange && userId !== "unknown-user") {
				strategyFinal = pickForcedStrategyForReportTest(
					prevTrimForReport,
					strategyFromScore
				);
				console.log("[test] force strategy change", {
					userId,
					previous: prevTrimForReport === "" ? "(empty)" : prevTrimForReport,
					fromScore: strategyFromScore,
					forced: strategyFinal,
				});
			}
		}
		console.log("[report] final strategy selected", {
			userId,
			fromScore: strategyFromScore,
			final: strategyFinal,
			reportTestChange: isReportTestChange,
		});
		console.log("[report] recommendation strategy synced", {
			strategy: strategyFinal,
		});

		const recommendationBlock = `* score: ${score}
* strategy: ${strategyFinal}
* status: ${recStatus}
* reason: ${recReason}
* action: ${recAction}`;
		const noteCountForRec = s.noteCount === "error" ? 0 : s.noteCount;
		const simReady = noteCountForRec > 0 ? "yes" : "no";
		const simReason =
			noteCountForRec > 0 ? "可進行模擬" : "無資料可模擬";
		let simResult: string;
		if (noteCountForRec === 0) {
			simResult = "無法模擬";
		} else if (strategyFinal === "aggressive") {
			simResult = "模擬偏積極策略，可提高部位配置";
		} else if (strategyFinal === "balanced") {
			simResult = "模擬偏平衡策略，建議分批配置";
		} else {
			simResult = "模擬偏保守策略，建議先觀察";
		}
		const simulationBlock = `* ready: ${simReady}
* reason: ${simReason}
* result: ${simResult}`;

		let strategyChangeBlock: string;
		let strategyNotifyPushBody: string | null = null;
		let reportPreviousStrategy = "none";
		let reportChanged = false;
		let reportShouldNotify = false;
		if (!hasUserId) {
			strategyChangeBlock = `* current: ${strategyFinal}
* previous: none
* changed: no
* shouldNotify: no
* notifyMessage: none`;
		} else {
			const strategyKey = `strategy:${userId}`;
			const prevTrim = prevTrimForReport;
			const previousDisplay = prevTrim === "" ? "none" : prevTrim;
			const changed: "yes" | "no" =
				isReportTestChange && userId !== "unknown-user" && prevTrim === "" ?
					"yes"
				:	prevTrim !== "" && prevTrim !== strategyFinal ?
					"yes"
				:	"no";
			const shouldNotify: "yes" | "no" = changed === "yes" ? "yes" : "no";
			reportPreviousStrategy = previousDisplay;
			reportChanged = changed === "yes";
			reportShouldNotify = shouldNotify === "yes";
			await env.MO_NOTES.put(strategyKey, strategyFinal);
			const notifyMessageLine =
				shouldNotify === "yes" ?
					`* notifyMessage:

MO Strategy Update
previous: ${previousDisplay}
current: ${strategyFinal}
score: ${score}
action: ${recAction}`
				:	`* notifyMessage: none`;
			if (shouldNotify === "yes") {
				strategyNotifyPushBody = `MO Strategy Update
previous: ${previousDisplay}
current: ${strategyFinal}
score: ${score}
action: ${recAction}`;
			}
			const strategyDecision: StrategyDecisionRecord = {
				changed: changed === "yes",
				shouldNotify: shouldNotify === "yes",
				hasMessage: strategyNotifyPushBody !== null,
				timestamp: formatStatusPushAtTaipei(new Date()),
			};
			await recordStrategyDecision(env, userId, strategyDecision);
			strategyChangeBlock = `* current: ${strategyFinal}
* previous: ${previousDisplay}
* changed: ${changed}
* shouldNotify: ${shouldNotify}
${notifyMessageLine}`;
		}

		if (hasUserId && userId !== "unknown-user") {
			if (!reportChanged) {
				console.log("[notify] skipped: decisionChanged=false", { userId });
			} else if (!reportShouldNotify) {
				console.log("[notify] skipped: shouldNotify=false", { userId });
			} else if (strategyNotifyPushBody === null) {
				console.log("[notify] skipped: hasMessage=false", { userId });
			} else {
				const notifyBody = strategyNotifyPushBody;
				const gateKey = getStrategyNotifyGateKey(userId);
				const gate = await readMoUserKvJson(
					env,
					userId,
					gateKey,
					parseStrategyNotifyGateRecord
				);
				const nowMs = Date.now();
				if (gate !== null && gate.lastNotifyMessage === notifyBody) {
					console.log("[notify] skipped: duplicate_message", { userId });
				} else if (
					gate !== null &&
					nowMs - gate.lastNotifyAt < STRATEGY_NOTIFY_COOLDOWN_MS
				) {
					console.log("[notify] skipped: cooldown", {
						userId,
						elapsedMs: nowMs - gate.lastNotifyAt,
						cooldownMs: STRATEGY_NOTIFY_COOLDOWN_MS,
					});
				} else {
					console.log("[notify] start", { userId });
					const notifyPush = await lineBotPushTextMessage(
						env,
						userId,
						notifyBody
					);
					await recordStrategyNotifyGateAttempt(
						env,
						userId,
						notifyBody,
						Date.now()
					);
					await recordLinePushOutcomeForStatus(env, userId, notifyPush);
					switch (notifyPush.result) {
						case "success":
							console.log("[notify] done", { userId });
							break;
						case "blocked_by_monthly_limit":
							console.log("[notify] blocked_monthly_limit", {
								userId,
								status: notifyPush.httpStatus,
								body: notifyPush.httpBody,
							});
							break;
						case "failed":
							console.log("[notify] failed", {
								userId,
								status: notifyPush.httpStatus,
								body: notifyPush.httpBody,
							});
							break;
						case "network_error":
							console.log("[notify] failed", {
								userId,
								reason: "network_error",
							});
							break;
					}
				}
			}
		}

		if (hasUserId && userId !== "unknown-user") {
			const summary: ReportSummaryRecord = {
				currentStrategy: strategyFinal,
				previousStrategy: reportPreviousStrategy,
				changed: reportChanged,
				shouldNotify: reportShouldNotify,
				recommendationStatus: recStatus === "active" ? "active" : "none",
				recommendationReason: recReason,
				simulationReady: simReady === "yes",
				simulationResult: simResult,
				timestamp: formatStatusPushAtTaipei(new Date()),
			};
			await recordLastReportSummary(env, userId, summary);
		}

		const reportUserLine = s.user === "ok" ? `ok (${userId})` : "none";

		const debugNotePrefixStr = `note:${userId}:`;
		let debugKvListCountForSystem = 0;
		let debugKvKeysSection = "* debugKvKeys: none";
		if (hasUserId) {
			try {
				const debugKvList = await env.MO_NOTES.list({
					prefix: debugNotePrefixStr,
					limit: 20,
				});
				debugKvListCountForSystem = debugKvList.keys.length;
				if (debugKvList.keys.length > 0) {
					const dkLines = debugKvList.keys
						.map((k, i) => `  ${i + 1}. ${k.name}`)
						.join("\n");
					debugKvKeysSection = `* debugKvKeys:\n${dkLines}`;
				}
			} catch {
				debugKvListCountForSystem = 0;
				debugKvKeysSection = "* debugKvKeys: none";
			}
		}

		return renderMoReportText({
			app: s.app,
			command: s.command,
			kv: s.kv,
			d1: s.d1,
			userLine: reportUserLine,
			notesValue,
			debugNotePrefix: debugNotePrefixStr,
			debugKvListCount: debugKvListCountForSystem,
			debugKvKeysSection,
			strategyChangeBlock,
			summaryBlock,
			recommendationBlock,
			simulationBlock,
		});
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
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
				// 重要：盡快回 200，避免 webhook request 因耗時而被取消（Canceled）
				ctx.waitUntil(
					(async () => {
						debugLog(env, "[line webhook] text message:", event.message?.text ?? "");
						const userId = event.source?.userId ?? "unknown-user";
						const replyText = await getReplyText(event.message?.text, env, userId);
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

						const pushTestCmd = extractCommand(event.message?.text ?? "");
						if (
							pushTestCmd === "/push-test" &&
							userId.trim() !== "" &&
							userId !== "unknown-user"
						) {
							const pushTestOutcome = await lineBotPushTextMessage(
								env,
								userId,
								"PUSH TEST OK"
							);
							await recordLinePushOutcomeForStatus(env, userId, pushTestOutcome);
							switch (pushTestOutcome.result) {
								case "success":
									console.log("[push-test] success");
									break;
								case "blocked_by_monthly_limit":
									console.log("[push-test] blocked by monthly limit", {
										userId,
										status: pushTestOutcome.httpStatus,
										body: pushTestOutcome.httpBody,
									});
									break;
								case "failed":
									console.log("[push-test] failed", {
										userId,
										status: pushTestOutcome.httpStatus,
										body: pushTestOutcome.httpBody,
									});
									break;
								case "network_error":
									console.log("[push-test] failed", { userId, reason: "network_error" });
									break;
							}
						}
					})()
				);
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