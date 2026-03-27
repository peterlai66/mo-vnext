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
	LINE_MODE?: "normal" | "reply_only";
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
	| "network_error"
	| "skipped";

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
		if (env.LINE_MODE === "reply_only") {
			console.log("[push] skipped: reply_only_mode");
			await recordStrategyNotifyOutcomeForStatus(
				env,
				userId,
				"skipped",
				"reply_only_mode_enabled"
			);
			return { result: "skipped" };
		}
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
	| "network_error"
	| "skipped";

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
		case "skipped":
			return "skipped";
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
	lastStrategyNotifyStatus: "last_strategy_notify_status",
	lastStrategyDecision: "last_strategy_decision",
	lastReportSummary: "last_report_summary",
	lastStrategyNotifyGate: "last_strategy_notify_gate",
	strategyNotifyLock: "strategy_notify_lock",
} as const;

/** 正式 strategy notify：兩次推播嘗試最短間隔（毫秒） */
const STRATEGY_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;

/** notify 併發鎖租約（毫秒）；應涵蓋 push 往返時間，逾時由 KV expiration 回收 */
const STRATEGY_NOTIFY_LOCK_LEASE_MS = 3 * 60 * 1000;

type StrategyNotifyGateRecord = {
	lastNotifyMessage: string;
	lastNotifyAt: number;
};

function getStrategyNotifyGateKey(userId: string): string {
	return buildMoUserKvKey(MO_USER_KV_PREFIX.lastStrategyNotifyGate, userId);
}

function getStrategyNotifyLockKey(userId: string): string {
	return buildMoUserKvKey(MO_USER_KV_PREFIX.strategyNotifyLock, userId);
}

type StrategyNotifyLockRecord = {
	token: string;
	until: number;
};

function parseStrategyNotifyLockRecord(raw: string): StrategyNotifyLockRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (!("token" in parsed) || typeof parsed.token !== "string") return null;
		if (
			!("until" in parsed) ||
			typeof parsed.until !== "number" ||
			!Number.isFinite(parsed.until)
		) {
			return null;
		}
		return { token: parsed.token, until: parsed.until };
	} catch {
		return null;
	}
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

type MoNotesKvPutExpiry = {
	put(
		key: string,
		value: string,
		options: { expirationTtl: number }
	): Promise<void>;
	delete(key: string): Promise<void>;
};

/** 讀取 strategy notify gate（duplicate / cooldown）；使用預設 KV get，避免非法 cacheTtl。 */
async function readStrategyNotifyGateFromKv(
	env: Env,
	userId: string
): Promise<StrategyNotifyGateRecord | null> {
	try {
		const gateKey = getStrategyNotifyGateKey(userId);
		const raw = await env.MO_NOTES.get(gateKey, "text");
		if (raw === null || raw.trim() === "") return null;
		return parseStrategyNotifyGateRecord(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log("[notify] kv get failed: notify_gate", { userId, message });
		return null;
	}
}

/**
 * 以 KV 租約 + token 驗證取得同一 user 的 notify 互斥；失敗表示已有流程進行中或競態落敗。
 */
async function acquireStrategyNotifyLock(
	env: Env,
	userId: string
): Promise<{ release: () => Promise<void> } | null> {
	const lockKey = getStrategyNotifyLockKey(userId);
	const kvRw = env.MO_NOTES as unknown as MoNotesKvPutExpiry;
	const now = Date.now();
	let existingRaw: string | null;
	try {
		existingRaw = await env.MO_NOTES.get(lockKey, "text");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log("[notify] kv get failed: notify_lock_check", { userId, message });
		return null;
	}
	if (existingRaw !== null && existingRaw.trim() !== "") {
		const existing = parseStrategyNotifyLockRecord(existingRaw);
		if (existing !== null && existing.until > now) {
			return null;
		}
	}
	const token = crypto.randomUUID();
	const until = now + STRATEGY_NOTIFY_LOCK_LEASE_MS;
	const payload = JSON.stringify({ token, until });
	const expSec = Math.ceil(STRATEGY_NOTIFY_LOCK_LEASE_MS / 1000) + 120;
	try {
		await kvRw.put(lockKey, payload, { expirationTtl: expSec });
	} catch {
		return null;
	}
	let verifyRaw: string | null;
	try {
		verifyRaw = await env.MO_NOTES.get(lockKey, "text");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log("[notify] kv get failed: notify_lock_verify", { userId, message });
		return null;
	}
	const verified =
		verifyRaw !== null && verifyRaw.trim() !== "" ?
			parseStrategyNotifyLockRecord(verifyRaw)
		:	null;
	if (verified === null || verified.token !== token) {
		return null;
	}
	const release = async (): Promise<void> => {
		try {
			let curRaw: string | null;
			try {
				curRaw = await env.MO_NOTES.get(lockKey, "text");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.log("[notify] kv get failed: notify_lock_release", {
					userId,
					message,
				});
				curRaw = null;
			}
			const cur =
				curRaw !== null && curRaw.trim() !== "" ?
					parseStrategyNotifyLockRecord(curRaw)
				:	null;
			if (cur !== null && cur.token === token) {
				await kvRw.delete(lockKey);
			}
		} catch {
			// 釋放失敗不阻擋；租約仍會由 expirationTtl 回收
		}
		console.log("[notify] lock released", { userId });
	};
	return { release };
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
		console.log("[notify] cache updated", { userId });
	} catch {
		// gate 寫入失敗不阻擋 notify 主流程
	}
}

const MO_STATUS_DEFAULT_BLOCK = {
	lastPush: `lastNotifyResult: none
lastNotifyReason: none
lastNotifyAt: none
lastPush: none`,
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

function getLastStrategyNotifyStatusKey(userId: string): string {
	return buildMoUserKvKey(MO_USER_KV_PREFIX.lastStrategyNotifyStatus, userId);
}

/** /status：最近一次 strategy notify 決策（含略過與 LINE 結果） */
type StrategyNotifyResultLabel =
	| "duplicate_message"
	| "cooldown"
	| "in_progress"
	| "blocked_monthly_limit"
	| "skipped"
	| "success"
	| "failed";

type StrategyNotifyStatusRecord = {
	lastNotifyResult: StrategyNotifyResultLabel;
	lastNotifyReason: string;
	lastNotifyAt: string;
};

function isStrategyNotifyResultLabel(value: string): value is StrategyNotifyResultLabel {
	return (
		value === "duplicate_message" ||
		value === "cooldown" ||
		value === "in_progress" ||
		value === "blocked_monthly_limit" ||
		value === "skipped" ||
		value === "success" ||
		value === "failed"
	);
}

function parseStrategyNotifyStatusRecord(raw: string): StrategyNotifyStatusRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (
			!("lastNotifyResult" in parsed) ||
			typeof parsed.lastNotifyResult !== "string" ||
			!isStrategyNotifyResultLabel(parsed.lastNotifyResult)
		) {
			return null;
		}
		if (!("lastNotifyAt" in parsed) || typeof parsed.lastNotifyAt !== "string") {
			return null;
		}
		let lastNotifyReason = "";
		if (
			"lastNotifyReason" in parsed &&
			typeof parsed.lastNotifyReason === "string"
		) {
			lastNotifyReason = parsed.lastNotifyReason;
		}
		return {
			lastNotifyResult: parsed.lastNotifyResult,
			lastNotifyReason,
			lastNotifyAt: parsed.lastNotifyAt,
		};
	} catch {
		return null;
	}
}

/** detail 為空時依 result 補上可讀說明，與 lastNotifyResult 對齊 */
function normalizeStrategyNotifyReason(
	result: StrategyNotifyResultLabel,
	detail: string
): string {
	const t = detail.replace(/\s+/gu, " ").trim();
	if (t !== "") return t;
	switch (result) {
		case "duplicate_message":
			return "notify_body_matches_recorded_gate";
		case "cooldown":
			return "within_notify_cooldown_window";
		case "in_progress":
			return "parallel_notify_lock_active";
		case "blocked_monthly_limit":
			return "line_monthly_push_quota_exceeded";
		case "skipped":
			return "reply_only_mode_enabled";
		case "success":
			return "line_push_accepted";
		case "failed":
			return "line_push_request_failed";
	}
}

function linePushOutcomeToStrategyNotifyStatus(
	outcome: LinePushOutcome
): Pick<StrategyNotifyStatusRecord, "lastNotifyResult" | "lastNotifyReason"> {
	switch (outcome.result) {
		case "skipped":
			return {
				lastNotifyResult: "skipped",
				lastNotifyReason: normalizeStrategyNotifyReason(
					"skipped",
					"reply_only_mode_enabled"
				),
			};
		case "success":
			return {
				lastNotifyResult: "success",
				lastNotifyReason: normalizeStrategyNotifyReason("success", ""),
			};
		case "blocked_by_monthly_limit": {
			const st =
				outcome.httpStatus !== undefined ?
					`status=${String(outcome.httpStatus)}`
				:	"";
			return {
				lastNotifyResult: "blocked_monthly_limit",
				lastNotifyReason: normalizeStrategyNotifyReason(
					"blocked_monthly_limit",
					st
				),
			};
		}
		case "failed": {
			const st =
				outcome.httpStatus !== undefined ?
					`status=${String(outcome.httpStatus)}`
				:	"";
			const body = summarizePushBodyForStatus(outcome.httpBody, 80);
			const parts = [st, body !== undefined ? `body=${body}` : ""].filter(
				(s) => s !== ""
			);
			return {
				lastNotifyResult: "failed",
				lastNotifyReason: normalizeStrategyNotifyReason("failed", parts.join(" ")),
			};
		}
		case "network_error":
			return {
				lastNotifyResult: "failed",
				lastNotifyReason: normalizeStrategyNotifyReason("failed", "network_error"),
			};
	}
}

async function recordStrategyNotifyOutcomeForStatus(
	env: Env,
	userId: string,
	result: StrategyNotifyResultLabel,
	reason: string
): Promise<void> {
	const lastNotifyReason = normalizeStrategyNotifyReason(result, reason);
	const rec: StrategyNotifyStatusRecord = {
		lastNotifyResult: result,
		lastNotifyReason,
		lastNotifyAt: formatStatusPushAtTaipei(new Date()),
	};
	try {
		await env.MO_NOTES.put(
			getLastStrategyNotifyStatusKey(userId),
			JSON.stringify(rec)
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.log("[notify] status kv write failed", { userId, message });
	}
}

function isLastPushDisplayKind(value: string): value is LastPushDisplayKind {
	return (
		value === "success" ||
		value === "failed" ||
		value === "blocked_monthly_limit" ||
		value === "network_error" ||
		value === "skipped"
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
	if (outcome.result === "skipped") return; // reply_only mode 不更新 lastPush
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
	const lineMode = env.LINE_MODE === "reply_only" ? "reply_only" : "normal";
	if (!hasMoStatusUserId(userId)) {
		return [
			`lineMode: ${lineMode}`,
			"lastNotifyResult: none",
			"lastNotifyReason: none",
			"lastNotifyAt: none",
			"lastPush: none",
		].join("\n");
	}
	const [n, r] = await Promise.all([
		readMoUserKvJson(
			env,
			userId,
			getLastStrategyNotifyStatusKey(userId),
			parseStrategyNotifyStatusRecord
		),
		readMoUserKvJson(
			env,
			userId,
			getLastPushNotifyKey(userId),
			parseLastPushNotifyRecord
		),
	]);
	const lines: string[] = [`lineMode: ${lineMode}`];
	if (n === null) {
		lines.push(
			"lastNotifyResult: none",
			"lastNotifyReason: none",
			"lastNotifyAt: none"
		);
	} else {
		const reasonForDisplay = normalizeStrategyNotifyReason(
			n.lastNotifyResult,
			n.lastNotifyReason
		);
		lines.push(`lastNotifyResult: ${n.lastNotifyResult}`);
		lines.push(`lastNotifyReason: ${reasonForDisplay}`);
		lines.push(`lastNotifyAt: ${n.lastNotifyAt}`);
	}
	if (r === null) {
		lines.push("lastPush: none");
		return lines.join("\n");
	}
	lines.push(`lastPush: ${r.kind}`);
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
	if (messageText === "/strategy-config-debug") return "/strategy-config-debug";
	if (messageText === "/strategy-config-set-demo") return "/strategy-config-set-demo";
	if (messageText === "/strategy-config-promote-demo-candidate") {
		return "/strategy-config-promote-demo-candidate";
	}
	if (messageText === "/strategy-review-run-demo") return "/strategy-review-run-demo";
	if (messageText === "/strategy-review-run") return "/strategy-review-run";
	if (messageText === "/strategy-review-explain") return "/strategy-review-explain";
	if (messageText === "/strategy-review-debug") return "/strategy-review-debug";
	if (messageText === "/strategy-review-decision") return "/strategy-review-decision";
	if (messageText === "/strategy-review-reset") return "/strategy-review-reset";
	if (messageText === "/strategy-review-demo-promote") return "/strategy-review-demo-promote";
	if (messageText === "/strategy-review-demo-clear") return "/strategy-review-demo-clear";
	if (messageText === "/strategy-promote-candidate") return "/strategy-promote-candidate";
	if (messageText === "/strategy-auto-promote-run") return "/strategy-auto-promote-run";
	if (messageText === "/strategy-candidate-clone-active") return "/strategy-candidate-clone-active";
	if (messageText === "/strategy-candidate-set-balanced30") return "/strategy-candidate-set-balanced30";
	if (messageText === "/strategy-candidate-set-balanced20") return "/strategy-candidate-set-balanced20";
	if (/^\/strategy-candidate-patch(?:\s+|$)/u.test(messageText)) {
		return "/strategy-candidate-patch";
	}
	if (messageText === "/strategy-candidate-show") return "/strategy-candidate-show";
	if (messageText === "/strategy-candidate-discard") return "/strategy-candidate-discard";
	if (messageText === "/strategy-status") return "/strategy-status";
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

type StrategyActiveConfig = {
	freshnessWeight: number;
	volumeWeight: number;
	simulationWeight: number;
	aggressiveMinScore: number;
	balancedMinScore: number;
	freshnessIdleThresholdMs: number;
	configVersion: string;
	updatedAt: string;
};

const MO_ACTIVE_STRATEGY_CONFIG_KEY = "active_strategy_config";
const MO_CANDIDATE_STRATEGY_CONFIG_KEY = "candidate_strategy_config";
const MO_STRATEGY_REVIEW_STATE_KEY = "strategy_review_state";
const MO_STRATEGY_REVIEW_RESULT_KEY = "strategy_review_result";
const MO_STRATEGY_REVIEW_DECISION_KEY = "strategy_review_decision";
const MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY = "strategy_review_demo_override";
const MO_STRATEGY_AUTO_PROMOTE_GUARD_KEY = "strategy_auto_promote_guard";
const STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED = 2;
const STRATEGY_AUTO_PROMOTE_COOLDOWN_MS = 30 * 60 * 1000;

type StrategyReviewStatus =
	| "none"
	| "idle"
	| "reviewing"
	| "ready"
	| "reviewed"
	| "promoted";

type StrategyReviewState = {
	activeConfigVersion: string;
	candidateConfigVersion: string;
	reviewStatus: StrategyReviewStatus;
	reviewStartedAt: string;
	lastReviewedAt: string;
	note: string;
	promotedAt?: string;
	promotedFrom?: string;
	promotedTo?: string;
};

type StrategyCompareDecision = "keep_active" | "hold_review" | "promote_candidate";

type StrategyReviewResult = {
	activeConfigVersion: string;
	candidateConfigVersion: string;
	source?: "demo" | "real";
	comparedAt: string;
	compareSummary: string;
	compareDecision: StrategyCompareDecision;
	compareReason: string;
	note: string;
};

type StrategyReviewDecisionLabel =
	| "keep_active"
	| "hold_review"
	| "candidate_watch"
	| "candidate_promising"
	| "candidate_reject"
	| "promote_candidate"
	| "auto_promote_candidate"
	| "promoted";

type StrategyReviewDecisionRecord = {
	decision: StrategyReviewDecisionLabel;
	decisionSource?: "demo" | "real" | "manual" | "auto";
	reason: string;
	evaluatedAt: string;
};

type StrategyReviewDemoOverride = {
	dataFreshnessScore: number;
	dataVolumeScore: number;
	simulationReadyScore: number;
	status: "active" | "idle";
	note: string;
	updatedAt: string;
};

type StrategyAutoPromoteGuardRecord = {
	lastDecision: StrategyCompareDecision;
	confirmCount: number;
	lastPromoteAt?: number;
};

function getDefaultStrategyActiveConfig(): StrategyActiveConfig {
	return {
		freshnessWeight: 0.5,
		volumeWeight: 0.35,
		simulationWeight: 0.15,
		aggressiveMinScore: 80,
		balancedMinScore: 60,
		freshnessIdleThresholdMs: 24 * 60 * 60 * 1000,
		configVersion: "default-v1",
		updatedAt: "",
	};
}

function parseStrategyActiveConfigRecord(
	raw: string
): StrategyActiveConfig | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;

		const getNum = (k: string): number | null => {
			if (!(k in parsed)) return null;
			const v = (parsed as Record<string, unknown>)[k];
			return typeof v === "number" && Number.isFinite(v) ? v : null;
		};
		const getStr = (k: string): string | null => {
			if (!(k in parsed)) return null;
			const v = (parsed as Record<string, unknown>)[k];
			return typeof v === "string" ? v : null;
		};

		const freshnessWeight = getNum("freshnessWeight");
		const volumeWeight = getNum("volumeWeight");
		const simulationWeight = getNum("simulationWeight");
		const aggressiveMinScore = getNum("aggressiveMinScore");
		const balancedMinScore = getNum("balancedMinScore");
		const freshnessIdleThresholdMs = getNum("freshnessIdleThresholdMs");
		const configVersion = getStr("configVersion");
		const updatedAt = getStr("updatedAt");

		if (
			freshnessWeight === null ||
			volumeWeight === null ||
			simulationWeight === null ||
			aggressiveMinScore === null ||
			balancedMinScore === null ||
			freshnessIdleThresholdMs === null ||
			configVersion === null ||
			updatedAt === null
		) {
			return null;
		}
		if (freshnessIdleThresholdMs <= 0) return null;
		if (balancedMinScore < 0 || aggressiveMinScore < 0) return null;
		if (balancedMinScore > aggressiveMinScore) return null;
		if (
			freshnessWeight < 0 ||
			volumeWeight < 0 ||
			simulationWeight < 0
		) {
			return null;
		}
		return {
			freshnessWeight,
			volumeWeight,
			simulationWeight,
			aggressiveMinScore,
			balancedMinScore,
			freshnessIdleThresholdMs,
			configVersion,
			updatedAt,
		};
	} catch {
		return null;
	}
}

async function readActiveStrategyConfig(
	env: Env
): Promise<{ config: StrategyActiveConfig; source: "kv" | "default" }> {
	const defaultConfig = getDefaultStrategyActiveConfig();
	try {
		const raw = await env.MO_NOTES.get(MO_ACTIVE_STRATEGY_CONFIG_KEY, "text");
		if (raw === null || raw.trim() === "") {
			console.log("[strategy] config source", {
				source: "default",
				key: MO_ACTIVE_STRATEGY_CONFIG_KEY,
			});
			console.log("[strategy] config loaded", {
				configVersion: defaultConfig.configVersion,
			});
			console.log("[strategy] active config loaded", {
				source: "default",
				configVersion: defaultConfig.configVersion,
			});
			return { config: defaultConfig, source: "default" };
		}
		const parsed = parseStrategyActiveConfigRecord(raw);
		if (parsed === null) {
			console.log("[strategy] config source", {
				source: "default_invalid",
				key: MO_ACTIVE_STRATEGY_CONFIG_KEY,
			});
			console.log("[strategy] config loaded", {
				configVersion: defaultConfig.configVersion,
			});
			console.log("[strategy] active config loaded", {
				source: "default_invalid",
				configVersion: defaultConfig.configVersion,
			});
			return { config: defaultConfig, source: "default" };
		}
		console.log("[strategy] config source", {
			source: "kv",
			key: MO_ACTIVE_STRATEGY_CONFIG_KEY,
		});
		console.log("[strategy] config loaded", {
			configVersion: parsed.configVersion,
			updatedAt: parsed.updatedAt,
		});
		console.log("[strategy] active config loaded", {
			source: "kv",
			configVersion: parsed.configVersion,
		});
		return { config: parsed, source: "kv" };
	} catch {
		console.log("[strategy] config source", {
			source: "default",
			key: MO_ACTIVE_STRATEGY_CONFIG_KEY,
		});
		console.log("[strategy] config loaded", {
			configVersion: defaultConfig.configVersion,
		});
		console.log("[strategy] active config loaded", {
			source: "default",
			configVersion: defaultConfig.configVersion,
		});
		return { config: defaultConfig, source: "default" };
	}
}

async function readCandidateStrategyConfig(
	env: Env
): Promise<StrategyActiveConfig | null> {
	try {
		const raw = await env.MO_NOTES.get(MO_CANDIDATE_STRATEGY_CONFIG_KEY, "text");
		if (raw === null || raw.trim() === "") return null;
		return parseStrategyActiveConfigRecord(raw);
	} catch {
		return null;
	}
}

function isStrategyReviewStatus(v: string): v is StrategyReviewStatus {
	return (
		v === "none" ||
		v === "idle" ||
		v === "reviewing" ||
		v === "ready" ||
		v === "reviewed" ||
		v === "promoted"
	);
}

function parseStrategyReviewStateRecord(raw: string): StrategyReviewState | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.activeConfigVersion !== "string") return null;
		if (typeof obj.candidateConfigVersion !== "string") return null;
		if (typeof obj.reviewStatus !== "string" || !isStrategyReviewStatus(obj.reviewStatus)) {
			return null;
		}
		if (typeof obj.reviewStartedAt !== "string") return null;
		if (typeof obj.lastReviewedAt !== "string") return null;
		if (typeof obj.note !== "string") return null;
		const promotedAt =
			typeof obj.promotedAt === "string" ? obj.promotedAt : undefined;
		const promotedFrom =
			typeof obj.promotedFrom === "string" ? obj.promotedFrom : undefined;
		const promotedTo =
			typeof obj.promotedTo === "string" ? obj.promotedTo : undefined;
		return {
			activeConfigVersion: obj.activeConfigVersion,
			candidateConfigVersion: obj.candidateConfigVersion,
			reviewStatus: obj.reviewStatus,
			reviewStartedAt: obj.reviewStartedAt,
			lastReviewedAt: obj.lastReviewedAt,
			note: obj.note,
			...(promotedAt !== undefined ? { promotedAt } : {}),
			...(promotedFrom !== undefined ? { promotedFrom } : {}),
			...(promotedTo !== undefined ? { promotedTo } : {}),
		};
	} catch {
		return null;
	}
}

async function readStrategyReviewState(env: Env): Promise<StrategyReviewState | null> {
	try {
		const raw = await env.MO_NOTES.get(MO_STRATEGY_REVIEW_STATE_KEY, "text");
		if (raw === null || raw.trim() === "") return null;
		return parseStrategyReviewStateRecord(raw);
	} catch {
		return null;
	}
}

async function writeStrategyReviewState(env: Env, state: StrategyReviewState): Promise<void> {
	try {
		await env.MO_NOTES.put(MO_STRATEGY_REVIEW_STATE_KEY, JSON.stringify(state));
		console.log("[strategy] review state saved", {
			activeConfigVersion: state.activeConfigVersion,
			candidateConfigVersion: state.candidateConfigVersion,
			reviewStatus: state.reviewStatus,
		});
	} catch {
		// scaffold：寫入失敗不影響主流程
	}
}

function isStrategyCompareDecision(v: string): v is StrategyCompareDecision {
	return v === "keep_active" || v === "hold_review" || v === "promote_candidate";
}

function parseStrategyReviewResultRecord(raw: string): StrategyReviewResult | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.activeConfigVersion !== "string") return null;
		if (typeof obj.candidateConfigVersion !== "string") return null;
		if (typeof obj.comparedAt !== "string") return null;
		if (typeof obj.compareSummary !== "string") return null;
		if (
			typeof obj.compareDecision !== "string" ||
			!isStrategyCompareDecision(obj.compareDecision)
		) {
			return null;
		}
		if (typeof obj.compareReason !== "string") return null;
		if (typeof obj.note !== "string") return null;
		const source =
			typeof obj.source === "string" && (obj.source === "demo" || obj.source === "real") ?
				obj.source
			:	undefined;
		return {
			activeConfigVersion: obj.activeConfigVersion,
			candidateConfigVersion: obj.candidateConfigVersion,
			...(source !== undefined ? { source } : {}),
			comparedAt: obj.comparedAt,
			compareSummary: obj.compareSummary,
			compareDecision: obj.compareDecision,
			compareReason: obj.compareReason,
			note: obj.note,
		};
	} catch {
		return null;
	}
}

async function readStrategyReviewResult(env: Env): Promise<StrategyReviewResult | null> {
	try {
		const raw = await env.MO_NOTES.get(MO_STRATEGY_REVIEW_RESULT_KEY, "text");
		if (raw === null || raw.trim() === "") return null;
		return parseStrategyReviewResultRecord(raw);
	} catch {
		return null;
	}
}

async function writeStrategyReviewResult(env: Env, result: StrategyReviewResult): Promise<void> {
	try {
		await env.MO_NOTES.put(MO_STRATEGY_REVIEW_RESULT_KEY, JSON.stringify(result));
		console.log("[strategy] review result saved", {
			activeConfigVersion: result.activeConfigVersion,
			candidateConfigVersion: result.candidateConfigVersion,
			compareDecision: result.compareDecision,
		});
	} catch {
		// scaffold：寫入失敗不影響主流程
	}
}

function parseStrategyReviewDecisionRecord(raw: string): StrategyReviewDecisionRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.decision !== "string") return null;
		const decision = obj.decision;
		if (
			decision !== "keep_active" &&
			decision !== "hold_review" &&
			decision !== "candidate_watch" &&
			decision !== "candidate_promising" &&
			decision !== "candidate_reject" &&
			decision !== "promote_candidate" &&
			decision !== "auto_promote_candidate" &&
			decision !== "promoted"
		) {
			return null;
		}
		const decisionSource =
			typeof obj.decisionSource === "string" &&
			(obj.decisionSource === "demo" ||
				obj.decisionSource === "real" ||
				obj.decisionSource === "manual" ||
				obj.decisionSource === "auto") ?
				obj.decisionSource
			:	undefined;
		if (typeof obj.reason !== "string") return null;
		if (typeof obj.evaluatedAt !== "string") return null;
		return {
			decision,
			...(decisionSource !== undefined ? { decisionSource } : {}),
			reason: obj.reason,
			evaluatedAt: obj.evaluatedAt,
		};
	} catch {
		return null;
	}
}

async function readStrategyReviewDecision(
	env: Env
): Promise<StrategyReviewDecisionRecord | null> {
	try {
		const raw = await env.MO_NOTES.get(MO_STRATEGY_REVIEW_DECISION_KEY, "text");
		if (raw === null || raw.trim() === "") return null;
		return parseStrategyReviewDecisionRecord(raw);
	} catch {
		return null;
	}
}

async function writeStrategyReviewDecision(
	env: Env,
	record: StrategyReviewDecisionRecord
): Promise<void> {
	try {
		await env.MO_NOTES.put(
			MO_STRATEGY_REVIEW_DECISION_KEY,
			JSON.stringify(record)
		);
	} catch {
		// scaffold：寫入失敗不影響主流程
	}
}

async function clearStrategyReviewResult(env: Env): Promise<void> {
	try {
		await env.MO_NOTES.delete(MO_STRATEGY_REVIEW_RESULT_KEY);
	} catch {
		// scaffold：清除失敗不影響主流程
	}
}

async function clearStrategyReviewDecision(env: Env): Promise<void> {
	try {
		await env.MO_NOTES.delete(MO_STRATEGY_REVIEW_DECISION_KEY);
	} catch {
		// scaffold：清除失敗不影響主流程
	}
}

async function writeStrategyReviewStateNewCycle(params: {
	env: Env;
	activeConfigVersion: string;
	candidateConfigVersion: string;
	note: string;
}): Promise<void> {
	const nowIso = new Date().toISOString();
	const s: StrategyReviewState = {
		activeConfigVersion: params.activeConfigVersion,
		candidateConfigVersion: params.candidateConfigVersion,
		reviewStatus: "reviewing",
		reviewStartedAt: nowIso,
		lastReviewedAt: nowIso,
		note: params.note,
	};
	await writeStrategyReviewState(params.env, s);
}

function parseStrategyReviewDemoOverrideRecord(
	raw: string
): StrategyReviewDemoOverride | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj.dataFreshnessScore !== "number" ||
			!Number.isFinite(obj.dataFreshnessScore)
		) {
			return null;
		}
		if (
			typeof obj.dataVolumeScore !== "number" ||
			!Number.isFinite(obj.dataVolumeScore)
		) {
			return null;
		}
		if (
			typeof obj.simulationReadyScore !== "number" ||
			!Number.isFinite(obj.simulationReadyScore)
		) {
			return null;
		}
		if (typeof obj.status !== "string") return null;
		if (obj.status !== "active" && obj.status !== "idle") return null;
		if (typeof obj.note !== "string") return null;
		if (typeof obj.updatedAt !== "string") return null;
		const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
		return {
			dataFreshnessScore: clamp(obj.dataFreshnessScore),
			dataVolumeScore: clamp(obj.dataVolumeScore),
			simulationReadyScore: clamp(obj.simulationReadyScore),
			status: obj.status,
			note: obj.note,
			updatedAt: obj.updatedAt,
		};
	} catch {
		return null;
	}
}

async function readStrategyReviewDemoOverride(
	env: Env
): Promise<StrategyReviewDemoOverride | null> {
	try {
		const raw = await env.MO_NOTES.get(MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY, "text");
		if (raw === null || raw.trim() === "") return null;
		return parseStrategyReviewDemoOverrideRecord(raw);
	} catch {
		return null;
	}
}

async function writeStrategyReviewDemoOverride(
	env: Env,
	override: StrategyReviewDemoOverride
): Promise<void> {
	try {
		await env.MO_NOTES.put(
			MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY,
			JSON.stringify(override)
		);
	} catch {
		// demo only
	}
}

async function clearStrategyReviewDemoOverride(
	env: Env,
	context: "promotion" | "reset" | "discard" | "manual_clear" | "real_review" | "new_cycle"
): Promise<void> {
	try {
		await env.MO_NOTES.delete(MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY);
		const suffix =
			context === "promotion" ? "after promotion"
			: context === "reset" ? "after review reset"
			: context === "discard" ? "after candidate discard"
			: context === "real_review" ? "after real review"
			: context === "new_cycle" ? "after new cycle"
			: "manually";
		console.log(`[strategy] review demo override cleared: ${suffix}`, {
			key: MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.log("[strategy] review demo override clear failed", {
			key: MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY,
			context,
			message,
		});
	}
}

function parseStrategyAutoPromoteGuardRecord(raw: string): StrategyAutoPromoteGuardRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj.lastDecision !== "string" ||
			(obj.lastDecision !== "keep_active" &&
				obj.lastDecision !== "hold_review" &&
				obj.lastDecision !== "promote_candidate")
		) {
			return null;
		}
		if (typeof obj.confirmCount !== "number" || !Number.isFinite(obj.confirmCount)) {
			return null;
		}
		if (
			"lastPromoteAt" in obj &&
			obj.lastPromoteAt !== undefined &&
			(typeof obj.lastPromoteAt !== "number" || !Number.isFinite(obj.lastPromoteAt))
		) {
			return null;
		}
		return {
			lastDecision: obj.lastDecision,
			confirmCount: Math.max(0, Math.floor(obj.confirmCount)),
			...(typeof obj.lastPromoteAt === "number" ? { lastPromoteAt: obj.lastPromoteAt } : {}),
		};
	} catch {
		return null;
	}
}

async function readStrategyAutoPromoteGuard(
	env: Env
): Promise<StrategyAutoPromoteGuardRecord | null> {
	try {
		const raw = await env.MO_NOTES.get(MO_STRATEGY_AUTO_PROMOTE_GUARD_KEY, "text");
		if (!raw) return null;
		return parseStrategyAutoPromoteGuardRecord(raw);
	} catch {
		return null;
	}
}

async function writeStrategyAutoPromoteGuard(
	env: Env,
	record: StrategyAutoPromoteGuardRecord
): Promise<void> {
	try {
		await env.MO_NOTES.put(MO_STRATEGY_AUTO_PROMOTE_GUARD_KEY, JSON.stringify(record));
	} catch {
		// guard only
	}
}

type StrategyCurrentSnapshot = {
	dataFreshnessScore: number;
	dataVolumeScore: number;
	simulationReadyScore: number;
	score: number;
	strategy: "aggressive" | "balanced" | "conservative";
	status: "active" | "idle";
	reason: string;
};

async function computeStrategyCurrentSnapshotFromRealData(params: {
	env: Env;
	userId: string;
	activeConfig: StrategyActiveConfig;
}): Promise<StrategyCurrentSnapshot | null> {
	try {
		const s = await getSystemStatus(params.env, params.userId);
		const totalNotesNum = s.noteCount === "error" ? 0 : s.noteCount;
		let latestNoteMs: number | null = null;
		if (params.userId.trim() !== "" && params.userId !== "unknown-user") {
			const list = await params.env.MO_NOTES.list({
				prefix: `note:${params.userId}:`,
				limit: 20,
			});
			const keyNames = list.keys.map((k) => k.name);
			if (keyNames.length > 0) {
				const sorted = [...keyNames].sort(
					(a, b) => parseTimestampFromKey(b) - parseTimestampFromKey(a)
				);
				const latestName = sorted[0];
				const tail =
					latestName.startsWith(`note:${params.userId}:`) ?
						latestName.slice(`note:${params.userId}:`.length)
					:	latestName.split(":").pop() ?? latestName;
				const ts = Number(tail);
				if (Number.isFinite(ts)) latestNoteMs = ts;
			}
		}

		const cfg = params.activeConfig;
		const deltaMs =
			latestNoteMs === null ? Number.POSITIVE_INFINITY : Date.now() - latestNoteMs;
		const dataFreshnessScore =
			latestNoteMs === null || deltaMs >= cfg.freshnessIdleThresholdMs ?
				0
			:	Math.round((1 - deltaMs / cfg.freshnessIdleThresholdMs) * 100);
		const dataVolumeScore = Math.round(Math.min(1, totalNotesNum / 10) * 100);
		const simulationReadyScore = totalNotesNum > 0 ? 100 : 0;
		const weightSum = cfg.freshnessWeight + cfg.volumeWeight + cfg.simulationWeight;
		const fallback = getDefaultStrategyActiveConfig();
		const fw = weightSum > 0 ? cfg.freshnessWeight / weightSum : fallback.freshnessWeight;
		const vw = weightSum > 0 ? cfg.volumeWeight / weightSum : fallback.volumeWeight;
		const sw =
			weightSum > 0 ? cfg.simulationWeight / weightSum : fallback.simulationWeight;
		const scoreRaw =
			dataFreshnessScore * fw + dataVolumeScore * vw + simulationReadyScore * sw;
		const score = Math.max(0, Math.min(100, Math.round(scoreRaw)));
		let strategy: "aggressive" | "balanced" | "conservative";
		if (score >= cfg.aggressiveMinScore) strategy = "aggressive";
		else if (score >= cfg.balancedMinScore) strategy = "balanced";
		else strategy = "conservative";

		let status: "active" | "idle";
		let reason: string;
		if (latestNoteMs === null) {
			status = "idle";
			reason = "尚無資料";
		} else if (deltaMs > cfg.freshnessIdleThresholdMs) {
			status = "idle";
			reason = "長時間未更新";
		} else if (simulationReadyScore === 0) {
			status = "idle";
			reason = "無資料可模擬";
		} else {
			status = "active";
			reason = "近期有活動";
		}

		return {
			dataFreshnessScore,
			dataVolumeScore,
			simulationReadyScore,
			score,
			strategy,
			status,
			reason,
		};
	} catch {
		return null;
	}
}

async function runStrategyReview(params: {
	env: Env;
	userId: string;
	source: "demo" | "real";
	allowDemoOverride: boolean;
}): Promise<{
	comparedAt: string;
	compareDecision: StrategyCompareDecision;
	compareReason: string;
	finalDecision: StrategyReviewDecisionLabel;
	reviewResult: {
		activeScore: number;
		candidateScore: number;
		delta: number;
		changedFields: string[];
		reason: string;
		decision: StrategyCompareDecision;
		confidence: "high" | "medium";
	};
}> {
	const active = await readActiveStrategyConfig(params.env);
	const candidate = await readCandidateStrategyConfig(params.env);
	const state = await readStrategyReviewState(params.env);

	if (candidate === null || state === null) {
		console.log("[strategy] review safe fallback triggered", {
			activeConfigVersion: active.config.configVersion,
			candidateConfigVersion: candidate?.configVersion ?? state?.candidateConfigVersion ?? "none",
			reason: "review result not ready",
		});
		return {
			comparedAt: "",
			compareDecision: "hold_review",
			compareReason: "review result not ready",
			finalDecision: "hold_review",
			reviewResult: {
				activeScore: 0,
				candidateScore: 0,
				delta: 0,
				changedFields: [],
				reason: "review result not ready",
				decision: "hold_review",
				confidence: "medium",
			},
		};
	}

	console.log("[strategy] review run start", { source: params.source });
	const a = active.config;
	const c = candidate;

	const diffs: string[] = [];
	if (a.freshnessWeight !== c.freshnessWeight) diffs.push("freshnessWeight");
	if (a.volumeWeight !== c.volumeWeight) diffs.push("volumeWeight");
	if (a.simulationWeight !== c.simulationWeight) diffs.push("simulationWeight");
	if (a.aggressiveMinScore !== c.aggressiveMinScore) diffs.push("aggressiveMinScore");
	if (a.balancedMinScore !== c.balancedMinScore) diffs.push("balancedMinScore");
	if (a.freshnessIdleThresholdMs !== c.freshnessIdleThresholdMs) diffs.push("freshnessIdleThresholdMs");

	const changedFields: string[] = [];
	if (a.balancedMinScore !== c.balancedMinScore) changedFields.push("balancedMinScore");
	if (a.freshnessWeight !== c.freshnessWeight) changedFields.push("freshnessWeight");
	if (a.volumeWeight !== c.volumeWeight) changedFields.push("volumeWeight");

	const calcCompareScore = (s: StrategyActiveConfig): number =>
		s.balancedMinScore * 1 + s.freshnessWeight * 10 + s.volumeWeight * 10;
	const activeScore = calcCompareScore(a);
	const candidateScore = calcCompareScore(c);
	const scoreDelta = candidateScore - activeScore;

	const demoOverride =
		params.allowDemoOverride ? await readStrategyReviewDemoOverride(params.env) : null;
	const snapshot =
		params.source === "real" ? await computeStrategyCurrentSnapshotFromRealData({
			env: params.env,
			userId: params.userId,
			activeConfig: a,
		}) : null;

	const isStrongDemo =
		demoOverride !== null &&
		demoOverride.status === "active" &&
		demoOverride.dataFreshnessScore >= 80 &&
		demoOverride.dataVolumeScore >= 80 &&
		demoOverride.simulationReadyScore >= 80;
	const isStrongReal =
		snapshot !== null &&
		snapshot.status === "active" &&
		snapshot.dataFreshnessScore >= 80 &&
		snapshot.dataVolumeScore >= 80 &&
		snapshot.simulationReadyScore >= 80;
	// real compare rule（安全特例）：僅 balancedMinScore 單欄位差異時，允許在較保守的真實條件下 promote_candidate
	// - 不放寬到多欄位 diff
	// - 仍需真實資料新鮮且量足夠，且避免 simulationReady 太低
	const isBalancedMinScoreOnlyDiff = diffs.length === 1 && diffs[0] === "balancedMinScore";
	const balancedMinScoreDelta = c.balancedMinScore - a.balancedMinScore;
	const isSafeRealPromoteBalancedMinScoreOnly =
		params.source === "real" &&
		demoOverride === null &&
		isBalancedMinScoreOnlyDiff &&
		balancedMinScoreDelta >= 10;
	const isSafeBalancedMinScoreOnlyReal =
		params.source === "real" &&
		isBalancedMinScoreOnlyDiff &&
		balancedMinScoreDelta >= 5 &&
		snapshot !== null &&
		snapshot.status === "active" &&
		snapshot.dataFreshnessScore >= 80 &&
		snapshot.dataVolumeScore >= 80 &&
		snapshot.simulationReadyScore >= 60;

	let compareDecision: StrategyCompareDecision;
	let compareReason: string;
	let compareSummary: string;

	if (diffs.length === 0) {
		compareDecision = "keep_active";
		// 補強可讀性：常見誤判是 balancedMinScore 其實相同（delta=0）
		const balancedDelta = c.balancedMinScore - a.balancedMinScore;
		compareReason =
			params.source === "real" && balancedDelta === 0 ?
				`no_material_diff (balancedMinScore delta=0; active=${a.balancedMinScore}, candidate=${c.balancedMinScore})`
			:	"no_material_diff";
		compareSummary = "active vs candidate same";
	} else if (isSafeRealPromoteBalancedMinScoreOnly) {
		compareDecision = "promote_candidate";
		compareReason = `real promote condition matched: balancedMinScore delta>=10 (${balancedMinScoreDelta})`;
		compareSummary = "real safe promotion baseline";
		console.log("[strategy] real promote condition matched", {
			field: "balancedMinScore",
			delta: balancedMinScoreDelta,
			compareDecision,
		});
	} else if (
		(params.source === "demo" && isStrongDemo) ||
		(params.source === "real" && (isStrongReal || isSafeBalancedMinScoreOnlyReal))
	) {
		compareDecision = "promote_candidate";
		compareReason =
			params.source === "demo" ?
				`candidate changes validated under demo review conditions: ${diffs.join(", ")}`
			:	(isSafeBalancedMinScoreOnlyReal && !isStrongReal) ?
					`candidate balancedMinScore change validated under safe real review conditions: ${diffs.join(", ")}`
				:	`candidate changes validated under real review conditions: ${diffs.join(", ")}`;
		compareSummary = "candidate validated for promotion";
	} else {
		compareDecision = "hold_review";
		compareReason =
			params.source === "real" && isBalancedMinScoreOnlyDiff ?
				(balancedMinScoreDelta < 10 ?
						`balancedMinScore delta is below threshold (delta=${balancedMinScoreDelta}, active=${a.balancedMinScore}, candidate=${c.balancedMinScore}); auto promote requires delta >= 10`
					:	`candidate balancedMinScore change but real review conditions not strong enough (delta=${balancedMinScoreDelta}, active=${a.balancedMinScore}, candidate=${c.balancedMinScore})`)
			:	`candidate changes but review conditions not strong enough: ${diffs.join(", ")}`;
		compareSummary = "active vs candidate differ";
	}

	console.log("[strategy] review compare computed", {
		source: params.source,
		compareDecision,
		compareReason,
		demoOverride: demoOverride === null ? "off" : "on",
		safeRealPromoteBaseline: isSafeRealPromoteBalancedMinScoreOnly ? "matched" : "not_matched",
		isStrongReal: params.source === "real" ? isStrongReal : undefined,
		isSafeBalancedMinScoreOnlyReal: params.source === "real" ? isSafeBalancedMinScoreOnlyReal : undefined,
		activeBalancedMinScore:
			params.source === "real" && isBalancedMinScoreOnlyDiff ? a.balancedMinScore : undefined,
		candidateBalancedMinScore:
			params.source === "real" && isBalancedMinScoreOnlyDiff ? c.balancedMinScore : undefined,
		balancedMinScoreDelta: isBalancedMinScoreOnlyDiff ? balancedMinScoreDelta : undefined,
		balancedMinScoreActive:
			params.source === "real" && (isBalancedMinScoreOnlyDiff || diffs.length === 0) ?
				a.balancedMinScore
			:	undefined,
		balancedMinScoreCandidate:
			params.source === "real" && (isBalancedMinScoreOnlyDiff || diffs.length === 0) ?
				c.balancedMinScore
			:	undefined,
	});

	const nowIso = new Date().toISOString();
	const result: StrategyReviewResult = {
		activeConfigVersion: a.configVersion,
		candidateConfigVersion: c.configVersion,
		source: params.source,
		comparedAt: nowIso,
		compareSummary,
		compareDecision,
		compareReason,
		note: params.source === "demo" ? "demo compare result" : "real compare result",
	};
	await writeStrategyReviewResult(params.env, result);
	console.log("[strategy] review source persisted", { source: params.source });

	// 寫入本輪 state（normalize）
	const wasPromoted =
		state.reviewStatus === "promoted" ||
		state.promotedAt !== undefined ||
		state.promotedFrom !== undefined ||
		state.promotedTo !== undefined;
	if (wasPromoted) {
		console.log("[strategy] review state normalized for new cycle", {
			previousReviewStatus: state.reviewStatus,
			cleared: "promotion_state",
		});
	}
	const nextReviewStatus: StrategyReviewStatus =
		compareDecision === "keep_active" && compareReason === "no_material_diff" ?
			"reviewed"
		:	"reviewing";
	const nextState: StrategyReviewState = {
		activeConfigVersion: a.configVersion,
		candidateConfigVersion: c.configVersion,
		reviewStatus: nextReviewStatus,
		reviewStartedAt: nowIso,
		lastReviewedAt: nowIso,
		note:
			nextReviewStatus === "reviewed" ?
				"no material diff"
			:	(params.source === "demo" ? "demo review run completed" : "real review run completed"),
	};
	await writeStrategyReviewState(params.env, nextState);
	console.log("[strategy] review state saved", {
		source: params.source,
		reviewStatus: nextState.reviewStatus,
		demoOverride: params.source === "demo" && demoOverride !== null ? "on" : "off",
	});

	// decision：demo 可用 override snapshot；real 用真實 snapshot；兩者都會落盤
	let decisionSnapshot: StrategyCurrentSnapshot | null = null;
	if (params.source === "demo" && demoOverride !== null) {
		const weightSum = a.freshnessWeight + a.volumeWeight + a.simulationWeight;
		const fallback = getDefaultStrategyActiveConfig();
		const fw = weightSum > 0 ? a.freshnessWeight / weightSum : fallback.freshnessWeight;
		const vw = weightSum > 0 ? a.volumeWeight / weightSum : fallback.volumeWeight;
		const sw = weightSum > 0 ? a.simulationWeight / weightSum : fallback.simulationWeight;
		const scoreRaw =
			demoOverride.dataFreshnessScore * fw +
			demoOverride.dataVolumeScore * vw +
			demoOverride.simulationReadyScore * sw;
		const score = Math.max(0, Math.min(100, Math.round(scoreRaw)));
		let strategy: "aggressive" | "balanced" | "conservative";
		if (score >= a.aggressiveMinScore) strategy = "aggressive";
		else if (score >= a.balancedMinScore) strategy = "balanced";
		else strategy = "conservative";
		decisionSnapshot = {
			dataFreshnessScore: demoOverride.dataFreshnessScore,
			dataVolumeScore: demoOverride.dataVolumeScore,
			simulationReadyScore: demoOverride.simulationReadyScore,
			score,
			strategy,
			status: demoOverride.status,
			reason: `demo override: ${demoOverride.note}`,
		};
		console.log("[strategy] review demo override enabled", {
			note: demoOverride.note,
			updatedAt: demoOverride.updatedAt,
		});
	} else if (snapshot !== null) {
		decisionSnapshot = snapshot;
	}
	if (decisionSnapshot === null) {
		decisionSnapshot = {
			dataFreshnessScore: 0,
			dataVolumeScore: 0,
			simulationReadyScore: 0,
			score: 0,
			strategy: "conservative",
			status: "idle",
			reason: "尚無資料",
		};
	}
	const finalDecisionRecord = await computeAndRecordStrategyReviewDecision({
		env: params.env,
		activeConfig: a,
		snapshot: decisionSnapshot,
		decisionSource: params.source,
	});
	console.log("[strategy] decision source persisted", { source: params.source });

	const reviewConfidence: "high" | "medium" =
		(compareDecision === "promote_candidate" && scoreDelta >= 10) ||
		(compareDecision === "keep_active" && scoreDelta === 0) ?
			"high"
		:	"medium";

	return {
		comparedAt: nowIso,
		compareDecision,
		compareReason,
		finalDecision: finalDecisionRecord.decision,
		reviewResult: {
			activeScore,
			candidateScore,
			delta: scoreDelta,
			changedFields,
			reason: compareReason,
			decision: compareDecision,
			confidence: reviewConfidence,
		},
	};
}

function computeStrategyReviewDecision(params: {
	snapshot: StrategyCurrentSnapshot;
	activeConfig: StrategyActiveConfig;
	candidateConfig: StrategyActiveConfig | null;
	reviewState: StrategyReviewState | null;
	reviewResult: StrategyReviewResult | null;
}): { decision: StrategyReviewDecisionLabel; reason: string } {
	const s = params.snapshot;
	const cfg = params.activeConfig;
	const candidate = params.candidateConfig;
	const reviewState = params.reviewState;
	const reviewResult = params.reviewResult;

	// 0) 必要 review 資料不足：先 hold_review（不做任何 promotion）
	if (candidate === null || reviewState === null || reviewResult === null) {
		return {
			decision: "hold_review",
			reason: "缺少必要 review 資料，暫不評估 promotion",
		};
	}

	// 1) compare layer 優先：review_result 存在就先對齊（避免被後續 fallback 覆蓋）
	switch (reviewResult.compareDecision) {
		case "promote_candidate": {
			// auto promote 建議層（v1）：real review 通過時改回傳 auto_promote_candidate（不自動 promotion）
			if (reviewResult.source === "real") {
				return {
					decision: "auto_promote_candidate",
					reason: "real review indicates candidate can be promoted",
				};
			}
			const r = reviewResult.compareReason.trim();
			const reason =
				r === "" ?
					"review_result 已驗證 candidate 可人工 promotion"
				:	`review_result 驗證通過：${r}`;
			return { decision: "promote_candidate", reason };
		}
		case "hold_review": {
			const r = reviewResult.compareReason.trim();
			const reason =
				r === "" ?
					"review_result: hold_review"
				:	`review_result: ${r}`;
			return { decision: "hold_review", reason };
		}
		case "keep_active": {
			const r = reviewResult.compareReason.trim();
			// 允許 no_material_diff 後面帶補充說明（例如 delta/active/candidate）
			if (r === "no_material_diff" || r.startsWith("no_material_diff")) {
				return {
					decision: "hold_review",
					reason: "active 與 candidate 幾乎無差異，暫不評估 promotion",
				};
			}
			return {
				decision: "keep_active",
				reason: r === "" ? "review_result: keep_active" : `review_result: ${r}`,
			};
		}
	}

	// A
	if (s.dataFreshnessScore === 0 && s.status === "idle") {
		return { decision: "keep_active", reason: "資料過舊，不適合評估 candidate" };
	}

	// 1) active / candidate 差異不足：hold_review 或 keep_active
	const diffs: string[] = [];
	const addDiff = (k: string, a: number, b: number): void => {
		if (a !== b) diffs.push(k);
	};
	addDiff("freshnessWeight", cfg.freshnessWeight, candidate.freshnessWeight);
	addDiff("volumeWeight", cfg.volumeWeight, candidate.volumeWeight);
	addDiff("simulationWeight", cfg.simulationWeight, candidate.simulationWeight);
	addDiff("aggressiveMinScore", cfg.aggressiveMinScore, candidate.aggressiveMinScore);
	addDiff("balancedMinScore", cfg.balancedMinScore, candidate.balancedMinScore);
	addDiff(
		"freshnessIdleThresholdMs",
		cfg.freshnessIdleThresholdMs,
		candidate.freshnessIdleThresholdMs
	);
	if (diffs.length === 0) {
		return {
			decision: "hold_review",
			reason: "active 與 candidate 幾乎無差異，暫不評估 promotion",
		};
	}

	// 3) score 明顯偏低：keep_active
	if (s.score < cfg.balancedMinScore) {
		return { decision: "keep_active", reason: "score 偏低，先維持 active" };
	}

	// 4) promotion 條件（deterministic、保守）：資料夠新 + review 完整 + 差異明確 + 條件良好
	const hasGoodData = s.dataVolumeScore >= 80 && s.simulationReadyScore >= 80;
	const hasGoodScore = s.score >= cfg.aggressiveMinScore || s.score >= cfg.balancedMinScore;
	const hasClearDiff = diffs.length >= 2;
	if (s.status === "active" && hasGoodData && hasGoodScore && hasClearDiff) {
		return {
			decision: "promote_candidate",
			reason: `條件良好且差異明確，可人工確認 promotion（diff: ${diffs.join(", ")}）`,
		};
	}

	// 5) 其他：hold_review（可持續觀察）
	return {
		decision: "hold_review",
		reason: `資料或條件不足，先觀察（diff: ${diffs.join(", ")}）`,
	};
}

async function computeAndRecordStrategyReviewDecision(params: {
	env: Env;
	activeConfig: StrategyActiveConfig;
	snapshot: StrategyCurrentSnapshot;
	decisionSource?: "demo" | "real";
}): Promise<StrategyReviewDecisionRecord> {
	// decision 規則只依賴現有資料；讀取失敗不阻擋主流程
	const [candidate, reviewState, reviewResult] = await Promise.all([
		readCandidateStrategyConfig(params.env),
		readStrategyReviewState(params.env),
		readStrategyReviewResult(params.env),
	]);
	const compareDecision = reviewResult?.compareDecision;
	const r = computeStrategyReviewDecision({
		snapshot: params.snapshot,
		activeConfig: params.activeConfig,
		candidateConfig: candidate,
		reviewState,
		reviewResult,
	});
	const rec: StrategyReviewDecisionRecord = {
		decision: r.decision,
		reason: r.reason,
		evaluatedAt: formatStatusPushAtTaipei(new Date()),
		...(r.decision === "auto_promote_candidate" ? { decisionSource: "auto" } : {}),
		...(r.decision !== "auto_promote_candidate" && params.decisionSource ?
			{ decisionSource: params.decisionSource }
		:	{}),
	};
	if (rec.decision === "auto_promote_candidate") {
		console.log("[strategy] auto promote suggested", {
			source: reviewResult?.source ?? "unknown",
		});
	}
	console.log("[strategy] review decision resolved from review_result", {
		compareDecision: compareDecision ?? "(none)",
		finalDecision: rec.decision,
		fallbackUsed: reviewResult === null ? "yes" : "no",
	});
	console.log("[strategy] review decision computed", {
		decision: rec.decision,
		reason: rec.reason,
	});
	await writeStrategyReviewDecision(params.env, rec);
	return rec;
}

type StrategyReviewExplainAiFailureReason =
	| "http_error"
	| "invalid_json"
	| "invalid_response_shape"
	| "empty_content"
	| "truncated"
	| "missing_current_status"
	| "timeout"
	| "thrown_error"
	| "unknown";

type StrategyReviewExplainAiResult =
	| { ok: true; text: string }
	| {
			ok: false;
			reason: StrategyReviewExplainAiFailureReason;
			rawResponseSnippet?: string;
			parsedContentSnippet?: string;
			errorName?: string;
			errorMessage?: string;
			errorStack?: string;
	  };

async function generateStrategyReviewExplainAi(params: {
	active: StrategyActiveConfig;
	candidate: StrategyActiveConfig | null;
	reviewState: StrategyReviewState | null;
	reviewResult: StrategyReviewResult | null;
	currentSnapshot:
		| {
				dataFreshnessScore: number;
				dataVolumeScore: number;
				simulationReadyScore: number;
				score: number;
				strategy: "aggressive" | "balanced" | "conservative";
				status: "active" | "idle";
				reason: string;
		  }
		| null;
	env: Env;
	timeoutMs: number;
}): Promise<StrategyReviewExplainAiResult> {
	const diffLines: string[] = [];
	const a = params.active;
	const c = params.candidate;
	const arrow = (from: number, to: number): string => `${String(from)} → ${String(to)}`;
	if (c === null) {
		diffLines.push("- candidate: (missing)");
	} else {
		const addIfChanged = (name: string, from: number, to: number): void => {
			if (from === to) return;
			diffLines.push(`- ${name}: ${arrow(from, to)}`);
		};
		addIfChanged("freshnessWeight", a.freshnessWeight, c.freshnessWeight);
		addIfChanged("volumeWeight", a.volumeWeight, c.volumeWeight);
		addIfChanged("simulationWeight", a.simulationWeight, c.simulationWeight);
		addIfChanged("aggressiveMinScore", a.aggressiveMinScore, c.aggressiveMinScore);
		addIfChanged("balancedMinScore", a.balancedMinScore, c.balancedMinScore);
		addIfChanged(
			"freshnessIdleThresholdMs",
			a.freshnessIdleThresholdMs,
			c.freshnessIdleThresholdMs
		);
		if (diffLines.length === 0) {
			// 仍需至少提到一個具體欄位名稱，避免輸出模糊
			diffLines.push(`- freshnessWeight: ${arrow(a.freshnessWeight, c.freshnessWeight)}`);
		}
	}

	const systemPrompt =
		"你是 MO vNext 的策略審查解釋層。請用繁體中文輸出 2~4 行，用「分析」語氣。只做解釋，不要提出新決策或修改設定。禁止用模糊措辭（例如：調整了部分）；必須至少點名一個具體欄位（例如 freshnessWeight）。";
	const userPrompt = `請分析以下策略 review（不要描述，要解讀）：

[Active]
configVersion: ${params.active.configVersion}

[Candidate]
configVersion: ${params.candidate?.configVersion ?? "(none)"}

[ReviewResult]
compareDecision: ${params.reviewResult?.compareDecision ?? "(none)"}
compareReason: ${params.reviewResult?.compareReason ?? "(none)"}

[Diff]
${diffLines.join("\n")}

${params.currentSnapshot === null ? "" : `[CurrentStatus]
dataFreshnessScore: ${params.currentSnapshot.dataFreshnessScore}
dataVolumeScore: ${params.currentSnapshot.dataVolumeScore}
strategy: ${params.currentSnapshot.strategy}
status: ${params.currentSnapshot.status}
reason: ${params.currentSnapshot.reason}
`}

輸出要求：2~4 行繁體中文；必須點名至少 1 個欄位（例 freshnessWeight）；必須引用至少 1 個 CurrentStatus 欄位名稱（dataFreshnessScore/status/reason）；要解讀方向與影響；要解釋 keep_active（缺值則說結果未產生先維持 active）。`;

	const prompt = `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`;
	console.log("[strategy] review explain prompt", prompt);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), params.timeoutMs);
	try {
		const response = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${params.env.OPENAI_API_KEY}`,
			},
			signal: controller.signal,
			body: JSON.stringify({
				model: "gpt-4o-mini",
				temperature: 0.2,
				max_completion_tokens: 160,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
			}),
		});
		const rawText = await response.text();
		const rawResponseSnippet = rawText.slice(0, 2000);
		console.log("[strategy] review explain raw response", rawResponseSnippet);

		if (!response.ok) {
			console.log("[strategy] review explain error", {
				reason: "http_error",
				status: response.status,
				statusText: response.statusText,
			});
			return { ok: false, reason: "http_error", rawResponseSnippet };
		}

		let responseJson: unknown;
		try {
			responseJson = JSON.parse(rawText) as unknown;
		} catch {
			console.log("[strategy] review explain invalid response", {
				reason: "invalid_json",
			});
			return { ok: false, reason: "invalid_json", rawResponseSnippet };
		}

		const finishReason = (() => {
			if (
				typeof responseJson !== "object" ||
				responseJson === null ||
				!("choices" in responseJson) ||
				!Array.isArray((responseJson as Record<string, unknown>).choices) ||
				(responseJson as Record<string, unknown>).choices.length === 0
			) {
				return null;
			}
			const first = (responseJson as Record<string, unknown>).choices[0];
			if (typeof first !== "object" || first === null) return null;
			if (!("finish_reason" in first) || typeof first.finish_reason !== "string") {
				return null;
			}
			return first.finish_reason;
		})();

		const text = extractAiSummaryText(responseJson);
		if (text === null) {
			const hasChoices =
				typeof responseJson === "object" && responseJson !== null && "choices" in responseJson;
			const choicesLen =
				hasChoices && Array.isArray((responseJson as Record<string, unknown>).choices) ?
					((responseJson as Record<string, unknown>).choices as unknown[]).length
				:	undefined;
			console.log("[strategy] review explain invalid response", {
				reason: "invalid_response_shape",
				hasChoices,
				choicesLen,
			});
			return { ok: false, reason: "invalid_response_shape", rawResponseSnippet };
		}
		console.log("[strategy] review explain parsed content", text.slice(0, 800));

		if (finishReason === "length") {
			console.log("[strategy] review explain truncated", { finishReason });
			return {
				ok: false,
				reason: "truncated",
				rawResponseSnippet,
				parsedContentSnippet: text.slice(0, 800),
			};
		}

		const lines = text
			.split(/\r?\n/u)
			.map((l) => l.trim())
			.filter((l) => l !== "");
		if (lines.length === 0) {
			console.log("[strategy] review explain invalid response", {
				reason: "empty_content",
			});
			return {
				ok: false,
				reason: "empty_content",
				rawResponseSnippet,
				parsedContentSnippet: text.slice(0, 800),
			};
		}
		const out = lines.slice(0, 4).join("\n");
		if (params.currentSnapshot !== null) {
			const hasCurrentStatusRef =
				out.includes("dataFreshnessScore") ||
				out.includes("status") ||
				out.includes("reason") ||
				out.includes(String(params.currentSnapshot.status)) ||
				out.includes(params.currentSnapshot.reason);
			if (!hasCurrentStatusRef) {
				console.log("[strategy] review explain missing current status");
				return {
					ok: false,
					reason: "missing_current_status",
					rawResponseSnippet,
					parsedContentSnippet: out,
				};
			}
		}
		return { ok: true, text: out };
	} catch (err: unknown) {
		const errorName =
			typeof err === "object" && err !== null && "name" in err ?
				String((err as Record<string, unknown>).name)
			:	undefined;
		const didTimeout = errorName === "AbortError";
		const errorMessage = err instanceof Error ? err.message : String(err);
		const errorStack = err instanceof Error ? err.stack : undefined;
		console.log("[strategy] review explain error", {
			reason: didTimeout ? "timeout" : "thrown_error",
			name: errorName,
			message: errorMessage,
			stack: errorStack,
		});
		return {
			ok: false,
			reason: didTimeout ? "timeout" : "thrown_error",
			errorName,
			errorMessage,
			errorStack,
		};
	} finally {
		clearTimeout(timer);
	}
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
	  case "/strategy-config-debug": {
		const r = await readActiveStrategyConfig(env);
		const c = r.config;
		return `MO Strategy Config Debug

source: ${r.source}
configVersion: ${c.configVersion}
freshnessWeight: ${c.freshnessWeight}
volumeWeight: ${c.volumeWeight}
simulationWeight: ${c.simulationWeight}
aggressiveMinScore: ${c.aggressiveMinScore}
balancedMinScore: ${c.balancedMinScore}
freshnessIdleThresholdMs: ${c.freshnessIdleThresholdMs}`;
	  }
	  case "/strategy-config-set-demo": {
		const demo: StrategyActiveConfig = {
			// demo-v1：刻意與 default-v1 明顯不同，方便驗證是否讀到 KV
			freshnessWeight: 0.2,
			volumeWeight: 0.7,
			simulationWeight: 0.1,
			aggressiveMinScore: 90,
			balancedMinScore: 40,
			freshnessIdleThresholdMs: 6 * 60 * 60 * 1000,
			configVersion: "demo-v1",
			updatedAt: new Date().toISOString(),
		};
		await env.MO_NOTES.put(MO_ACTIVE_STRATEGY_CONFIG_KEY, JSON.stringify(demo));
		return `MO Strategy Config Set Demo

key: ${MO_ACTIVE_STRATEGY_CONFIG_KEY}
configVersion: ${demo.configVersion}
result: demo config 已寫入`;
	  }
	  case "/strategy-config-promote-demo-candidate": {
		// scaffold：建立 demo candidate + review state（不影響正式 /report 計算）
		const active = await readActiveStrategyConfig(env);
		const activeCfg = active.config;

		const candidate: StrategyActiveConfig = {
			...activeCfg,
			// candidate-v1：示範候選配置（刻意不同）
			freshnessWeight: Math.max(0, activeCfg.freshnessWeight - 0.15),
			volumeWeight: activeCfg.volumeWeight + 0.2,
			simulationWeight: activeCfg.simulationWeight,
			balancedMinScore: Math.max(0, activeCfg.balancedMinScore - 10),
			configVersion: "candidate-v1",
			updatedAt: new Date().toISOString(),
		};

		// 權重總和維持為正；若不慎歸零則回退到 demo 值
		const wSum =
			candidate.freshnessWeight + candidate.volumeWeight + candidate.simulationWeight;
		if (wSum <= 0) {
			candidate.freshnessWeight = 0.2;
			candidate.volumeWeight = 0.7;
			candidate.simulationWeight = 0.1;
		}

		try {
			await env.MO_NOTES.put(
				MO_CANDIDATE_STRATEGY_CONFIG_KEY,
				JSON.stringify(candidate)
			);
			console.log("[strategy] candidate config saved", {
				configVersion: candidate.configVersion,
				key: MO_CANDIDATE_STRATEGY_CONFIG_KEY,
			});
		} catch {
			// scaffold：寫入失敗不影響 reply
		}

		const nowIso = new Date().toISOString();
		const reviewState: StrategyReviewState = {
			activeConfigVersion: activeCfg.configVersion,
			candidateConfigVersion: candidate.configVersion,
			reviewStatus: "reviewing",
			reviewStartedAt: nowIso,
			lastReviewedAt: nowIso,
			note: "demo candidate created",
		};
		await writeStrategyReviewState(env, reviewState);

		return `MO Strategy Candidate Demo Created

activeKey: ${MO_ACTIVE_STRATEGY_CONFIG_KEY}
candidateKey: ${MO_CANDIDATE_STRATEGY_CONFIG_KEY}
reviewKey: ${MO_STRATEGY_REVIEW_STATE_KEY}
activeConfigVersion: ${activeCfg.configVersion}
candidateConfigVersion: ${candidate.configVersion}
reviewStatus: ${reviewState.reviewStatus}`;
	  }
	  case "/strategy-review-run-demo": {
		const r = await runStrategyReview({
			env,
			userId,
			source: "demo",
			allowDemoOverride: true,
		});
		return `MO Strategy Review Run Demo

reviewResultKey: ${MO_STRATEGY_REVIEW_RESULT_KEY}
source: demo
comparedAt: ${r.comparedAt}
compareDecision: ${r.compareDecision}
compareReason: ${r.compareReason}`;
	  }
	  case "/strategy-review-run": {
		// real review 不應繼承舊的 demo override（避免 stale state 影響 auto promote）
		await clearStrategyReviewDemoOverride(env, "real_review");
		const [activeCfg, candidateCfg, existingResult] = await Promise.all([
			readActiveStrategyConfig(env),
			readCandidateStrategyConfig(env),
			readStrategyReviewResult(env),
		]);
		const buildReviewResultView = (params: {
			active: StrategyActiveConfig;
			candidate: StrategyActiveConfig | null;
			compareDecision: StrategyCompareDecision;
			compareReason: string;
		}): {
			activeScore: number;
			candidateScore: number;
			delta: number;
			changedFields: string[];
			reason: string;
			decision: StrategyCompareDecision;
			confidence: "high" | "medium";
		} => {
			const a = params.active;
			const c = params.candidate;
			const activeScore = a.balancedMinScore * 1 + a.freshnessWeight * 10 + a.volumeWeight * 10;
			const candidateScore =
				c === null ? 0 : c.balancedMinScore * 1 + c.freshnessWeight * 10 + c.volumeWeight * 10;
			const delta = candidateScore - activeScore;
			const changedFields: string[] = [];
			if (c !== null) {
				if (a.balancedMinScore !== c.balancedMinScore) changedFields.push("balancedMinScore");
				if (a.freshnessWeight !== c.freshnessWeight) changedFields.push("freshnessWeight");
				if (a.volumeWeight !== c.volumeWeight) changedFields.push("volumeWeight");
			}
			const confidence: "high" | "medium" =
				(params.compareDecision === "promote_candidate" && delta >= 10) ||
				(params.compareDecision === "keep_active" && delta === 0) ?
					"high"
				:	"medium";
			return {
				activeScore,
				candidateScore,
				delta,
				changedFields,
				reason: params.compareReason,
				decision: params.compareDecision,
				confidence,
			};
		};
		const existingView =
			existingResult === null ? null
			:	buildReviewResultView({
					active: activeCfg.config,
					candidate: candidateCfg,
					compareDecision: existingResult.compareDecision,
					compareReason: existingResult.compareReason,
				});
		const currentCandidateVersion = candidateCfg === null ? "" : candidateCfg.configVersion;
		const reviewResultVersionsMismatch =
			existingResult !== null &&
			(existingResult.activeConfigVersion !== activeCfg.config.configVersion ||
				existingResult.candidateConfigVersion !== currentCandidateVersion);
		const compareStaleVsConfigs =
			existingResult !== null &&
			existingView !== null &&
			existingView.changedFields.length === 0 &&
			existingView.delta === 0 &&
			existingResult.compareDecision !== "keep_active";
		const shouldComputeOnDemand =
			existingResult === null ||
			existingResult.comparedAt.trim() === "" ||
			existingResult.compareReason === "review result not ready" ||
			reviewResultVersionsMismatch ||
			compareStaleVsConfigs ||
			(existingView !== null &&
				(existingView.activeScore === 0 || existingView.candidateScore === 0));
		if (shouldComputeOnDemand) {
			// runStrategyReview 在 candidate 或 review state 缺失時會早退且不寫 KV，導致每次只看到 placeholder。
			// 補齊與 /strategy-candidate-clone-active 相同的最小前置條件後再進 compare/evaluate。
			const stateForPrereq = await readStrategyReviewState(env);
			if (candidateCfg === null) {
				const nowIso = new Date().toISOString();
				const newCandidateVersion = `candidate-auto-${Date.now()}`;
				const candidateObj: StrategyActiveConfig = {
					...activeCfg.config,
					configVersion: newCandidateVersion,
					updatedAt: nowIso,
				};
				await env.MO_NOTES.put(
					MO_CANDIDATE_STRATEGY_CONFIG_KEY,
					JSON.stringify(candidateObj)
				);
				console.log("[strategy] review prerequisites auto-init (candidate cloned)", {
					activeConfigVersion: activeCfg.config.configVersion,
					candidateConfigVersion: candidateObj.configVersion,
				});
				await Promise.all([
					clearStrategyReviewResult(env),
					clearStrategyReviewDecision(env),
					clearStrategyReviewDemoOverride(env, "new_cycle"),
					writeStrategyReviewStateNewCycle({
						env,
						activeConfigVersion: activeCfg.config.configVersion,
						candidateConfigVersion: candidateObj.configVersion,
						note: "auto-initialized for review run",
					}),
				]);
			} else if (stateForPrereq === null) {
				await writeStrategyReviewStateNewCycle({
					env,
					activeConfigVersion: activeCfg.config.configVersion,
					candidateConfigVersion: candidateCfg.configVersion,
					note: "auto-initialized for review run",
				});
				console.log("[strategy] review prerequisites auto-init (review state)", {
					activeConfigVersion: activeCfg.config.configVersion,
					candidateConfigVersion: candidateCfg.configVersion,
				});
			}
		}
		const r =
			!shouldComputeOnDemand && existingResult !== null && existingView !== null ?
				{
					comparedAt: existingResult.comparedAt,
					compareDecision: existingResult.compareDecision,
					compareReason: existingResult.compareReason,
					finalDecision:
						existingResult.compareDecision === "promote_candidate" ? "promote_candidate"
						: existingResult.compareDecision === "keep_active" ? "keep_active"
						: "hold_review",
					reviewResult: existingView,
				}
			:	(await (async () => {
					const computed = await runStrategyReview({
						env,
						userId,
						source: "real",
						allowDemoOverride: false,
					});
					console.log("[strategy] review computed on demand", {
						activeConfigVersion: activeCfg.config.configVersion,
						candidateConfigVersion: candidateCfg?.configVersion ?? "none",
						comparedAt: computed.comparedAt,
					});
					return computed;
				})());
		const rr =
			r.reviewResult ??
			{
				activeScore: 0,
				candidateScore: 0,
				delta: 0,
				changedFields: [],
				reason: "review result not ready",
				decision: "hold_review" as StrategyCompareDecision,
				confidence: "medium" as const,
			};
		if (!r.reviewResult) {
			console.log("[strategy] review safe fallback triggered", {
				activeConfigVersion: "unknown",
				candidateConfigVersion: "unknown",
				reason: "review result not ready",
			});
		}

		// 只做提示：不自動 promotion；在 review 回覆中明確告知 auto promote 條件是否達成
		let autoPromoteHintBlock = "";
		try {
			const demoOverride = await readStrategyReviewDemoOverride(env);
			const delta = rr.delta;
			const source = "real";
			const finalDecision: StrategyCompareDecision = rr.decision;
			const changedFields = rr.changedFields;

			const autoPromoteEligible =
				source === "real" &&
				finalDecision === "promote_candidate" &&
				demoOverride === null &&
				changedFields.length === 1 &&
				changedFields[0] === "balancedMinScore" &&
				delta >= 10;

			if (autoPromoteEligible) {
				autoPromoteHintBlock =
					"\n\n⚠️ 建議執行 /strategy-auto-promote-run（條件已滿足）" +
					`\n- delta: ${delta}`;
			} else {
				const deltaDisplay = String(delta);
				const sourceLine =
					source !== "real" ? `${source}（需為 real）` : source;
				const decisionLine =
					`\n- decision: ${finalDecision}`;
				autoPromoteHintBlock =
					"\n\nAuto Promote 條件未達：" +
					`\n- delta: ${deltaDisplay}（需 >=10）` +
					`\n- source: ${sourceLine}` +
					decisionLine;
			}
		} catch {
			// ignore (hint only)
		}

		return `MO Strategy Review Run

reviewResultKey: ${MO_STRATEGY_REVIEW_RESULT_KEY}
source: real
comparedAt: ${r.comparedAt}
compareDecision: ${r.compareDecision}
compareReason: ${r.compareReason}
activeScore: ${rr.activeScore}
candidateScore: ${rr.candidateScore}
delta: ${rr.delta}
changedFields: ${rr.changedFields.length === 0 ? "none" : rr.changedFields.join(", ")}
reason: ${rr.reason}
decision: ${rr.decision}
confidence: ${rr.confidence}${autoPromoteHintBlock}`;
	  }
	  case "/strategy-review-decision": {
		const d = await readStrategyReviewDecision(env);
		if (d === null) {
			return `MO Strategy Review Decision

decision: none
reason: none
evaluatedAt: none`;
		}
		return `MO Strategy Review Decision

decision: ${d.decision}
source: ${d.decisionSource ?? "unknown"}
reason: ${d.reason}
evaluatedAt: ${d.evaluatedAt}`;
	  }
	  case "/strategy-review-reset": {
		const [active, candidate] = await Promise.all([
			readActiveStrategyConfig(env),
			readCandidateStrategyConfig(env),
		]);
		const now = formatStatusPushAtTaipei(new Date());
		await Promise.all([
			clearStrategyReviewResult(env),
			clearStrategyReviewDecision(env),
			clearStrategyReviewDemoOverride(env, "reset"),
		]);

		const state: StrategyReviewState = {
			activeConfigVersion: active.config.configVersion,
			candidateConfigVersion: candidate?.configVersion ?? "none",
			reviewStatus: "idle",
			reviewStartedAt: now,
			lastReviewedAt: now,
			note: "review reset manually",
		};
		await writeStrategyReviewState(env, state);

		console.log("[strategy] review reset completed", {
			cleared: [
				MO_STRATEGY_REVIEW_RESULT_KEY,
				MO_STRATEGY_REVIEW_DECISION_KEY,
				MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY,
			],
			reviewStatus: state.reviewStatus,
		});

		return `MO Strategy Review Reset

result: ok
clearedKeys: ${MO_STRATEGY_REVIEW_RESULT_KEY}, ${MO_STRATEGY_REVIEW_DECISION_KEY}, ${MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY}
reviewStatus: ${state.reviewStatus}`;
	  }
	  case "/strategy-review-demo-promote": {
		const demo: StrategyReviewDemoOverride = {
			dataFreshnessScore: 100,
			dataVolumeScore: 100,
			simulationReadyScore: 100,
			status: "active",
			note: "demo promote conditions",
			updatedAt: new Date().toISOString(),
		};
		await writeStrategyReviewDemoOverride(env, demo);
		return `MO Strategy Review Demo Override

key: ${MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY}
result: written
note: ${demo.note}
updatedAt: ${demo.updatedAt}`;
	  }
	  case "/strategy-review-demo-clear": {
		await clearStrategyReviewDemoOverride(env, "manual_clear");
		return `MO Strategy Review Demo Override

key: ${MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY}
result: cleared`;
	  }
	  case "/strategy-candidate-clone-active": {
		const active = await readActiveStrategyConfig(env);
		const nowIso = new Date().toISOString();
		const newCandidateVersion = `candidate-manual-${Date.now()}`;
		const candidate: StrategyActiveConfig = {
			...active.config,
			configVersion: newCandidateVersion,
			updatedAt: nowIso,
		};
		await env.MO_NOTES.put(
			MO_CANDIDATE_STRATEGY_CONFIG_KEY,
			JSON.stringify(candidate)
		);
		console.log("[strategy] candidate cloned from active", {
			activeConfigVersion: active.config.configVersion,
			candidateConfigVersion: candidate.configVersion,
		});

		// 新 candidate 產生後：初始化新一輪 review，避免沿用舊 review 結果
		await Promise.all([
			clearStrategyReviewResult(env),
			clearStrategyReviewDecision(env),
			clearStrategyReviewDemoOverride(env, "new_cycle"),
			writeStrategyReviewStateNewCycle({
				env,
				activeConfigVersion: active.config.configVersion,
				candidateConfigVersion: candidate.configVersion,
				note: "candidate cloned from active",
			}),
		]);

		return `MO Strategy Candidate Clone Active

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: ${candidate.configVersion}
result: cloned`;
	  }
	  case "/strategy-candidate-set-balanced30": {
		const active = await readActiveStrategyConfig(env);
		const candidate = await readCandidateStrategyConfig(env);
		if (candidate === null) {
			return `MO Strategy Candidate Update

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: (none)
result: failed
reason: candidate config not found`;
		}
		const nowIso = new Date().toISOString();
		const updated: StrategyActiveConfig = {
			...candidate,
			balancedMinScore: 30,
			updatedAt: nowIso,
		};
		await env.MO_NOTES.put(
			MO_CANDIDATE_STRATEGY_CONFIG_KEY,
			JSON.stringify(updated)
		);
		console.log("[strategy] candidate field updated", {
			candidateConfigVersion: updated.configVersion,
			field: "balancedMinScore",
			value: 30,
		});
		return `MO Strategy Candidate Update

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: ${updated.configVersion}
result: updated
updatedField: balancedMinScore=30`;
	  }
	  case "/strategy-candidate-set-balanced20": {
		const active = await readActiveStrategyConfig(env);
		const candidate = await readCandidateStrategyConfig(env);
		if (candidate === null) {
			return `MO Strategy Candidate Update

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: (none)
result: failed
reason: candidate config not found`;
		}
		const nowIso = new Date().toISOString();
		const updated: StrategyActiveConfig = {
			...candidate,
			balancedMinScore: 20,
			updatedAt: nowIso,
		};
		await env.MO_NOTES.put(
			MO_CANDIDATE_STRATEGY_CONFIG_KEY,
			JSON.stringify(updated)
		);
		console.log("[strategy] candidate field updated", {
			candidateConfigVersion: updated.configVersion,
			field: "balancedMinScore",
			value: 20,
		});
		// 盡量標記本次調整（不改結構、不中斷流程）
		try {
			const s = await readStrategyReviewState(env);
			if (s !== null) {
				await writeStrategyReviewState(env, {
					...s,
					lastReviewedAt: nowIso,
					note: "candidate field updated: balancedMinScore",
				});
			}
		} catch {
			// ignore
		}
		return `MO Strategy Candidate Update

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: ${updated.configVersion}
result: updated
updatedField: balancedMinScore=20`;
	  }
	  case "/strategy-candidate-patch": {
		const active = await readActiveStrategyConfig(env);
		const candidate = await readCandidateStrategyConfig(env);
		if (candidate === null) {
			return `MO Strategy Candidate Patch

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: (none)
result: failed
reason: candidate config not found`;
		}

		const args = messageText
			.slice("/strategy-candidate-patch".length)
			.trim()
			.split(/\s+/u)
			.filter((s) => s !== "");
		const field = args[0] ?? "";
		const valueRaw = args[1] ?? "";
		if (field === "" || valueRaw === "") {
			return `MO Strategy Candidate Patch

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: ${candidate.configVersion}
result: failed
reason: usage: /strategy-candidate-patch <field> <number>`;
		}
		const valueNum = Number(valueRaw);
		if (!Number.isFinite(valueNum)) {
			return `MO Strategy Candidate Patch

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: ${candidate.configVersion}
result: failed
reason: invalid number`;
		}

		const nowIso = new Date().toISOString();
		let updated: StrategyActiveConfig;
		switch (field) {
			case "balancedMinScore":
				updated = { ...candidate, balancedMinScore: Math.round(valueNum), updatedAt: nowIso };
				break;
			case "aggressiveMinScore":
				updated = { ...candidate, aggressiveMinScore: Math.round(valueNum), updatedAt: nowIso };
				break;
			case "freshnessWeight":
				updated = { ...candidate, freshnessWeight: valueNum, updatedAt: nowIso };
				break;
			case "volumeWeight":
				updated = { ...candidate, volumeWeight: valueNum, updatedAt: nowIso };
				break;
			case "simulationWeight":
				updated = { ...candidate, simulationWeight: valueNum, updatedAt: nowIso };
				break;
			case "freshnessIdleThresholdMs":
				updated = { ...candidate, freshnessIdleThresholdMs: Math.round(valueNum), updatedAt: nowIso };
				break;
			default:
				return `MO Strategy Candidate Patch

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: ${candidate.configVersion}
result: failed
reason: unsupported field`;
		}

		await env.MO_NOTES.put(
			MO_CANDIDATE_STRATEGY_CONFIG_KEY,
			JSON.stringify(updated)
		);
		console.log("[strategy] candidate field patched", {
			candidateConfigVersion: updated.configVersion,
			field,
			value: updated[field as keyof StrategyActiveConfig],
		});

		// 最小同步：把 review state 拉回 reviewing，避免沿用舊狀態
		try {
			const s = await readStrategyReviewState(env);
			if (s !== null) {
				await writeStrategyReviewState(env, {
					...s,
					reviewStatus: "reviewing",
					lastReviewedAt: nowIso,
					note: `candidate field updated: ${field}`,
				});
			}
		} catch {
			// ignore
		}

		return `MO Strategy Candidate Patch

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: ${updated.configVersion}
result: updated
updatedField: ${field}
updatedValue: ${String(valueNum)}`;
	  }
	  case "/strategy-candidate-show": {
		const [active, candidate] = await Promise.all([
			readActiveStrategyConfig(env),
			readCandidateStrategyConfig(env),
		]);
		if (candidate === null) {
			return `MO Strategy Candidate Show

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: (none)
result: failed
reason: candidate config not found`;
		}

		const a = active.config;
		const c = candidate;
		const lines: string[] = [
			"MO Strategy Candidate Show",
			"",
			`activeConfigVersion: ${a.configVersion}`,
			`candidateConfigVersion: ${c.configVersion}`,
			"result: ok",
			"",
		];
		const diffs: string[] = [];
		const add = (name: string, av: number, cv: number): void => {
			lines.push(`${name}: active=${av} candidate=${cv}`);
			if (av !== cv) diffs.push(name);
		};
		add("aggressiveMinScore", a.aggressiveMinScore, c.aggressiveMinScore);
		add("balancedMinScore", a.balancedMinScore, c.balancedMinScore);
		add("freshnessWeight", a.freshnessWeight, c.freshnessWeight);
		add("volumeWeight", a.volumeWeight, c.volumeWeight);
		add("simulationWeight", a.simulationWeight, c.simulationWeight);
		add(
			"freshnessIdleThresholdMs",
			a.freshnessIdleThresholdMs,
			c.freshnessIdleThresholdMs
		);
		lines.push("");
		lines.push(`diff: ${diffs.length === 0 ? "none" : diffs.join(", ")}`);
		console.log("[strategy] candidate inspect loaded", {
			hasDiff: diffs.length === 0 ? "no" : "yes",
			diffFields: diffs,
		});
		return lines.join("\n");
	  }
	  case "/strategy-candidate-discard": {
		const [active, candidate] = await Promise.all([
			readActiveStrategyConfig(env),
			readCandidateStrategyConfig(env),
		]);
		const now = formatStatusPushAtTaipei(new Date());

		if (candidate === null) {
			return `MO Strategy Candidate Discard

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: (none)
result: no_candidate`;
		}

		// 刪除 candidate（不動 active）
		try {
			await env.MO_NOTES.delete(MO_CANDIDATE_STRATEGY_CONFIG_KEY);
		} catch {
			// delete 失敗仍嘗試清理 review 狀態，避免半套
		}

		await Promise.all([
			clearStrategyReviewResult(env),
			clearStrategyReviewDecision(env),
			clearStrategyReviewDemoOverride(env, "discard"),
		]);

		const state: StrategyReviewState = {
			activeConfigVersion: active.config.configVersion,
			candidateConfigVersion: "none",
			reviewStatus: "idle",
			reviewStartedAt: now,
			lastReviewedAt: now,
			note: "candidate discarded manually",
		};
		await writeStrategyReviewState(env, state);

		console.log("[strategy] candidate discarded", {
			cleared: [
				MO_CANDIDATE_STRATEGY_CONFIG_KEY,
				MO_STRATEGY_REVIEW_RESULT_KEY,
				MO_STRATEGY_REVIEW_DECISION_KEY,
				MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY,
			],
		});

		return `MO Strategy Candidate Discard

activeConfigVersion: ${active.config.configVersion}
candidateConfigVersion: (none)
result: discarded
clearedKeys: ${MO_CANDIDATE_STRATEGY_CONFIG_KEY}, ${MO_STRATEGY_REVIEW_RESULT_KEY}, ${MO_STRATEGY_REVIEW_DECISION_KEY}, ${MO_STRATEGY_REVIEW_DEMO_OVERRIDE_KEY}
reviewStatus: ${state.reviewStatus}`;
	  }
	  case "/strategy-status": {
		const [active, candidate, reviewState, reviewResult, reviewDecision, demoOverride] =
			await Promise.all([
				readActiveStrategyConfig(env),
				readCandidateStrategyConfig(env),
				readStrategyReviewState(env),
				readStrategyReviewResult(env),
				readStrategyReviewDecision(env),
				readStrategyReviewDemoOverride(env),
			]);

		const hasCandidate = candidate !== null;
		const activeVersion = active.config.configVersion;
		const candidateVersion = candidate?.configVersion ?? "none";
		const reviewStatus = reviewState?.reviewStatus ?? "none";
		const demo = demoOverride === null ? "off" : "on";

		const lines: string[] = [
			"MO Strategy Status",
			"",
			`activeConfigVersion: ${activeVersion}`,
			`candidateConfigVersion: ${candidateVersion}`,
			`hasCandidate: ${hasCandidate ? "yes" : "no"}`,
			`reviewStatus: ${reviewStatus}`,
			`demoOverride: ${demo}`,
		];

		if (reviewState?.reviewStatus === "promoted") {
			if (reviewState.promotedFrom) lines.push(`promotedFrom: ${reviewState.promotedFrom}`);
			if (reviewState.promotedTo) lines.push(`promotedTo: ${reviewState.promotedTo}`);
			if (reviewState.promotedAt) lines.push(`promotedAt: ${reviewState.promotedAt}`);
		}

		lines.push("");
		lines.push("[LastCompare]");
		if (reviewResult === null) {
			lines.push("compareDecision: none");
			lines.push("compareReason: none");
			lines.push("source: none");
			lines.push("comparedAt: none");
		} else {
			lines.push(`compareDecision: ${reviewResult.compareDecision}`);
			lines.push(`compareReason: ${reviewResult.compareReason === "" ? "none" : reviewResult.compareReason}`);
			lines.push(`source: ${reviewResult.source ?? "unknown"}`);
			lines.push(`comparedAt: ${reviewResult.comparedAt}`);
		}

		lines.push("");
		lines.push("[LastDecision]");
		if (reviewDecision === null) {
			lines.push("decision: none");
			lines.push("reason: none");
			lines.push("decisionSource: none");
			lines.push("evaluatedAt: none");
		} else {
			lines.push(`decision: ${reviewDecision.decision}`);
			lines.push(`reason: ${reviewDecision.reason === "" ? "none" : reviewDecision.reason}`);
			lines.push(`decisionSource: ${reviewDecision.decisionSource ?? "unknown"}`);
			lines.push(`evaluatedAt: ${reviewDecision.evaluatedAt}`);
		}

		const activeBalanced = active.config.balancedMinScore;
		const candidateBalanced = candidate?.balancedMinScore ?? null;
		const delta =
			candidateBalanced === null ? null : candidateBalanced - activeBalanced;
		const source = reviewResult?.source ?? "none";
		const decision = reviewDecision?.decision ?? "none";
		let autoPromoteReadiness: "ready" | "blocked" = "blocked";
		let autoPromoteReason = "candidate not found";
		if (source !== "real") {
			autoPromoteReadiness = "blocked";
			autoPromoteReason = "source not real";
		} else if (decision !== "auto_promote_candidate") {
			autoPromoteReadiness = "blocked";
			autoPromoteReason = "decision not ready";
		} else if (delta === null || delta < 10) {
			autoPromoteReadiness = "blocked";
			autoPromoteReason = `delta < 10 (current=${delta === null ? "none" : String(delta)})`;
		} else {
			autoPromoteReadiness = "ready";
			autoPromoteReason = "";
		}

		lines.push("");
		lines.push("[Auto Promote]");
		lines.push(`- readiness: ${autoPromoteReadiness}`);
		lines.push(
			`- delta: ${delta === null ? "none" : String(delta)} (active=${activeBalanced}, candidate=${candidateBalanced === null ? "none" : String(candidateBalanced)})`
		);
		lines.push(`- source: ${source}`);
		lines.push(`- decision: ${decision}`);
		if (autoPromoteReadiness === "blocked") {
			lines.push(`- reason: ${autoPromoteReason}`);
		}

		console.log("[strategy] strategy status loaded", {
			activeConfigVersion: activeVersion,
			hasCandidate: hasCandidate ? "yes" : "no",
			reviewStatus,
			demoOverride: demo,
			compareDecision: reviewResult?.compareDecision ?? "none",
			decision: reviewDecision?.decision ?? "none",
		});

		return lines.join("\n");
	  }
	  case "/strategy-promote-candidate": {
		const [active, candidate, state, decision] = await Promise.all([
			readActiveStrategyConfig(env),
			readCandidateStrategyConfig(env),
			readStrategyReviewState(env),
			readStrategyReviewDecision(env),
		]);

		const at = formatStatusPushAtTaipei(new Date());
		if (candidate === null) {
			return `MO Strategy Promote Candidate

promotedFrom: ${active.config.configVersion}
promotedTo: (none)
result: not_promoted
reason: candidate config not found
at: ${at}`;
		}
		if (decision === null) {
			return `MO Strategy Promote Candidate

promotedFrom: ${active.config.configVersion}
promotedTo: ${candidate.configVersion}
result: not_promoted
reason: review decision not found
at: ${at}`;
		}
		if (decision.decision !== "promote_candidate") {
			return `MO Strategy Promote Candidate

promotedFrom: ${active.config.configVersion}
promotedTo: ${candidate.configVersion}
result: not_promoted
decisionSource: ${decision.decisionSource ?? "unknown"}
reason: current decision is not promote_candidate
at: ${at}`;
		}

		const nowIso = new Date().toISOString();
		const promotedActive: StrategyActiveConfig = {
			...candidate,
			updatedAt: nowIso,
		};
		await env.MO_NOTES.put(
			MO_ACTIVE_STRATEGY_CONFIG_KEY,
			JSON.stringify(promotedActive)
		);

		const nextState: StrategyReviewState = {
			activeConfigVersion: promotedActive.configVersion,
			candidateConfigVersion: candidate.configVersion,
			reviewStatus: "promoted",
			reviewStartedAt: state?.reviewStartedAt ?? nowIso,
			lastReviewedAt: nowIso,
			note: "candidate promoted to active manually",
			promotedAt: at,
			promotedFrom: active.config.configVersion,
			promotedTo: promotedActive.configVersion,
		};
		await writeStrategyReviewState(env, nextState);

		await writeStrategyReviewDecision(env, {
			decision: "promoted",
			decisionSource: "manual",
			reason: "manual promotion completed",
			evaluatedAt: at,
		});

		// promotion 後收尾：清除 demo override，避免污染後續測試
		await clearStrategyReviewDemoOverride(env, "promotion");

		await runStrategyReview({
			env,
			userId,
			source: "real",
			allowDemoOverride: false,
		});

		console.log("[strategy] promotion decision source", {
			source: decision.decisionSource ?? "unknown",
		});
		const warningLine =
			decision.decisionSource === "demo" ?
				"\nwarning: promotion is based on demo review"
			:	"";
		return `MO Strategy Promote Candidate

promotedFrom: ${active.config.configVersion}
promotedTo: ${promotedActive.configVersion}
result: promoted
decisionSource: ${decision.decisionSource ?? "unknown"}
${warningLine}
at: ${at}`;
	  }
	  case "/strategy-auto-promote-run": {
		console.log("[strategy] auto promote run start");
		const [active, candidate, reviewState, reviewResult, reviewDecision, promoteGuard] =
			await Promise.all([
				readActiveStrategyConfig(env),
				readCandidateStrategyConfig(env),
				readStrategyReviewState(env),
				readStrategyReviewResult(env),
				readStrategyReviewDecision(env),
				readStrategyAutoPromoteGuard(env),
			]);

		const at = formatStatusPushAtTaipei(new Date());
		const decisionSource =
			reviewResult?.source ??
			reviewDecision?.decisionSource ??
			"computed";

		const a = active.config;
		const c = candidate;
		const changedFields: string[] = [];
		if (c !== null) {
			if (a.balancedMinScore !== c.balancedMinScore) changedFields.push("balancedMinScore");
			if (a.freshnessWeight !== c.freshnessWeight) changedFields.push("freshnessWeight");
			if (a.volumeWeight !== c.volumeWeight) changedFields.push("volumeWeight");
		}
		const activeScore = a.balancedMinScore * 1 + a.freshnessWeight * 10 + a.volumeWeight * 10;
		const candidateScore =
			c === null ? activeScore : c.balancedMinScore * 1 + c.freshnessWeight * 10 + c.volumeWeight * 10;
		const delta = candidateScore - activeScore;
		const decisionFromReviewResult = reviewResult?.compareDecision;
		const decisionFromReviewDecision =
			reviewDecision?.decision === "auto_promote_candidate" ?
				"promote_candidate"
			: reviewDecision?.decision === "promote_candidate" ||
				reviewDecision?.decision === "hold_review" ||
				reviewDecision?.decision === "keep_active" ?
				reviewDecision.decision
			:	null;
		const decision: StrategyCompareDecision =
			decisionFromReviewResult ?? decisionFromReviewDecision ?? "hold_review";
		const baseReason =
			reviewResult?.compareReason && reviewResult.compareReason.trim() !== "" ?
				reviewResult.compareReason
			:	reviewDecision?.reason && reviewDecision.reason.trim() !== "" ?
				reviewDecision.reason
			:	(changedFields.length === 0 ? "no strategy changes" : `candidate changes: ${changedFields.join(", ")}`);
		const thresholdReason =
			c !== null &&
			changedFields.length === 1 &&
			changedFields[0] === "balancedMinScore" &&
			delta < 10 ?
				`balancedMinScore delta is below threshold (delta=${c.balancedMinScore - a.balancedMinScore}, active=${a.balancedMinScore}, candidate=${c.balancedMinScore}); auto promote requires delta >= 10`
			:	null;
		const reason = thresholdReason ?? baseReason;
		const confidence: "high" | "medium" =
			(decision === "promote_candidate" && delta >= 10) ||
			(decision === "keep_active" && delta === 0) ?
				"high"
			:	"medium";
		const changedFieldsText = changedFields.length === 0 ? "none" : changedFields.join(", ");
		const previousDecision = promoteGuard?.lastDecision ?? null;
		const previousConfirmCount = promoteGuard?.confirmCount ?? 0;
		const confirmCount =
			previousDecision === decision ? previousConfirmCount + 1 : 1;
		const nowMs = Date.now();
		const lastPromoteAt = promoteGuard?.lastPromoteAt;
		const cooldownRemainingMs =
			typeof lastPromoteAt === "number" ?
				Math.max(0, STRATEGY_AUTO_PROMOTE_COOLDOWN_MS - (nowMs - lastPromoteAt))
			:	0;
		const cooldownRemainingMin = Math.ceil(cooldownRemainingMs / 60000);

		const blocked = (): string => {
			console.log("[strategy] auto promote run blocked", {
				decision,
				decisionFromReviewResult: decisionFromReviewResult ?? "none",
				decisionFromReviewDecision: decisionFromReviewDecision ?? "none",
				delta,
				changedFields,
				reason,
				confidence,
			});
			return `MO Strategy Auto Promote Run

result: blocked
decision: ${decision}
delta: ${delta}
changedFields: ${changedFieldsText}
reason: ${reason}
confidence: ${confidence}
auto promote blocked: review decision is not promote_candidate
decisionSource: ${decisionSource}
at: ${at}`;
		};

		if (candidate === null) return blocked();
		if (decision === "keep_active") {
			await writeStrategyAutoPromoteGuard(env, {
				lastDecision: decision,
				confirmCount,
				...(typeof lastPromoteAt === "number" ? { lastPromoteAt } : {}),
			});
			console.log("[strategy] auto promote run no_action", {
				decision,
				delta,
				changedFields,
				reason,
				confidence,
				confirmCount,
			});
			return `MO Strategy Auto Promote Run

result: no_action
decision: ${decision}
delta: ${delta}
changedFields: ${changedFieldsText}
reason: ${reason}
confidence: ${confidence}
auto promote skipped: active config already matches candidate
decisionSource: ${decisionSource}
confirmCount: ${confirmCount}/${STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED}
at: ${at}`;
		}
		if (decision !== "promote_candidate") {
			await writeStrategyAutoPromoteGuard(env, {
				lastDecision: decision,
				confirmCount,
				...(typeof lastPromoteAt === "number" ? { lastPromoteAt } : {}),
			});
			return blocked();
		}

		// promote_candidate 的穩定機制：先累積 confirm 次數，再檢查 cooldown
		if (confirmCount < STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED) {
			await writeStrategyAutoPromoteGuard(env, {
				lastDecision: decision,
				confirmCount,
				...(typeof lastPromoteAt === "number" ? { lastPromoteAt } : {}),
			});
			console.log("[strategy] auto promote run guarded", {
				guard: "confirm_count",
				confirmCount,
			});
			return `MO Strategy Auto Promote Run

result: guarded
decision: ${decision}
delta: ${delta}
changedFields: ${changedFieldsText}
reason: waiting for confirmation (${confirmCount}/${STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED})
confidence: ${confidence}
decisionSource: ${decisionSource}
confirmCount: ${confirmCount}/${STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED}
at: ${at}`;
		}

		if (cooldownRemainingMs > 0) {
			await writeStrategyAutoPromoteGuard(env, {
				lastDecision: decision,
				confirmCount,
				...(typeof lastPromoteAt === "number" ? { lastPromoteAt } : {}),
			});
			console.log("[strategy] auto promote run guarded", {
				guard: "cooldown",
				cooldownRemainingMin,
			});
			return `MO Strategy Auto Promote Run

result: guarded
decision: ${decision}
delta: ${delta}
changedFields: ${changedFieldsText}
reason: cooldown active (${cooldownRemainingMin} min remaining)
confidence: ${confidence}
decisionSource: ${decisionSource}
confirmCount: ${confirmCount}/${STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED}
cooldownRemaining: ${cooldownRemainingMin}m
at: ${at}`;
		}

		console.log("[strategy] auto promote run conditions matched", {
			delta,
			changedFields,
			compareDecision: reviewResult.compareDecision,
			decision,
			confirmCount,
		});

		// promotion 寫入（沿用手動 promotion 的最小流程）
		const nowIso = new Date().toISOString();
		const promotedActive: StrategyActiveConfig = {
			...candidate,
			updatedAt: nowIso,
		};
		await env.MO_NOTES.put(MO_ACTIVE_STRATEGY_CONFIG_KEY, JSON.stringify(promotedActive));

		const nextState: StrategyReviewState = {
			activeConfigVersion: promotedActive.configVersion,
			candidateConfigVersion: candidate.configVersion,
			reviewStatus: "promoted",
			reviewStartedAt: reviewState?.reviewStartedAt ?? nowIso,
			lastReviewedAt: nowIso,
			note: "candidate promoted to active automatically",
			promotedAt: at,
			promotedFrom: active.config.configVersion,
			promotedTo: promotedActive.configVersion,
		};
		await writeStrategyReviewState(env, nextState);

		await writeStrategyReviewDecision(env, {
			decision: "promoted",
			decisionSource: "auto",
			reason: "auto promotion completed",
			evaluatedAt: at,
		});
		await writeStrategyAutoPromoteGuard(env, {
			lastDecision: decision,
			confirmCount,
			lastPromoteAt: nowMs,
		});

		await clearStrategyReviewDemoOverride(env, "promotion");

		await runStrategyReview({
			env,
			userId,
			source: "real",
			allowDemoOverride: false,
		});

		console.log("[strategy] auto promote run promoted", {
			promotedFrom: active.config.configVersion,
			promotedTo: promotedActive.configVersion,
		});

		return `MO Strategy Auto Promote Run

result: promoted
decision: ${decision}
delta: ${delta}
changedFields: ${changedFieldsText}
reason: ${reason}
confidence: ${confidence}
decisionSource: auto
confirmCount: ${confirmCount}/${STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED}
promotedFrom: ${active.config.configVersion}
promotedTo: ${promotedActive.configVersion}
at: ${at}`;
	  }
	  case "/strategy-review-explain": {
		console.log("[strategy] review explain start");
		const [active, candidate, state, result] = await Promise.all([
			readActiveStrategyConfig(env),
			readCandidateStrategyConfig(env),
			readStrategyReviewState(env),
			readStrategyReviewResult(env),
		]);

		let currentSnapshot:
			| {
					dataFreshnessScore: number;
					dataVolumeScore: number;
					simulationReadyScore: number;
					score: number;
					strategy: "aggressive" | "balanced" | "conservative";
					status: "active" | "idle";
					reason: string;
			  }
			| null = null;
		try {
			const s = await getSystemStatus(env, userId);
			const totalNotesNum = s.noteCount === "error" ? 0 : s.noteCount;
			let latestNoteMs: number | null = null;
			if (userId.trim() !== "" && userId !== "unknown-user") {
				const list = await env.MO_NOTES.list({
					prefix: `note:${userId}:`,
					limit: 20,
				});
				const keyNames = list.keys.map((k) => k.name);
				if (keyNames.length > 0) {
					const sorted = [...keyNames].sort(
						(a, b) => parseTimestampFromKey(b) - parseTimestampFromKey(a)
					);
					const latestName = sorted[0];
					const tail =
						latestName.startsWith(`note:${userId}:`) ?
							latestName.slice(`note:${userId}:`.length)
						:	latestName.split(":").pop() ?? latestName;
					const ts = Number(tail);
					if (Number.isFinite(ts)) latestNoteMs = ts;
				}
			}
			const cfg = active.config;
			const deltaMs =
				latestNoteMs === null ? Number.POSITIVE_INFINITY : Date.now() - latestNoteMs;
			const dataFreshnessScore =
				latestNoteMs === null || deltaMs >= cfg.freshnessIdleThresholdMs ?
					0
				:	Math.round((1 - deltaMs / cfg.freshnessIdleThresholdMs) * 100);
			const dataVolumeScore = Math.round(Math.min(1, totalNotesNum / 10) * 100);
			const simulationReadyScore = totalNotesNum > 0 ? 100 : 0;
			const weightSum = cfg.freshnessWeight + cfg.volumeWeight + cfg.simulationWeight;
			const fallback = getDefaultStrategyActiveConfig();
			const fw = weightSum > 0 ? cfg.freshnessWeight / weightSum : fallback.freshnessWeight;
			const vw = weightSum > 0 ? cfg.volumeWeight / weightSum : fallback.volumeWeight;
			const sw =
				weightSum > 0 ? cfg.simulationWeight / weightSum : fallback.simulationWeight;
			const scoreRaw =
				dataFreshnessScore * fw + dataVolumeScore * vw + simulationReadyScore * sw;
			const score = Math.max(0, Math.min(100, Math.round(scoreRaw)));
			let strategy: "aggressive" | "balanced" | "conservative";
			if (score >= cfg.aggressiveMinScore) strategy = "aggressive";
			else if (score >= cfg.balancedMinScore) strategy = "balanced";
			else strategy = "conservative";
			let status: "active" | "idle";
			let reason: string;
			if (latestNoteMs === null) {
				status = "idle";
				reason = "尚無資料";
			} else if (deltaMs > cfg.freshnessIdleThresholdMs) {
				status = "idle";
				reason = "長時間未更新";
			} else if (simulationReadyScore === 0) {
				status = "idle";
				reason = "無資料可模擬";
			} else {
				status = "active";
				reason = "近期有活動";
			}
			currentSnapshot = {
				dataFreshnessScore,
				dataVolumeScore,
				simulationReadyScore,
				score,
				strategy,
				status,
				reason,
			};
		} catch {
			currentSnapshot = null;
		}

		const ai = await generateStrategyReviewExplainAi({
			active: active.config,
			candidate,
			reviewState: state,
			reviewResult: result,
			currentSnapshot,
			env,
			timeoutMs: 6000,
		});

		if (ai.ok) {
			console.log("[strategy] review explain success");
			return `MO Strategy Review Explain

${ai.text}`;
		}
		console.log("[strategy] review explain fallback reason", {
			reason: ai.reason,
			rawResponseSnippet: ai.rawResponseSnippet,
			parsedContentSnippet: ai.parsedContentSnippet,
			errorName: ai.errorName,
			errorMessage: ai.errorMessage,
		});
		if (ai.reason === "truncated" || ai.reason === "missing_current_status") {
			const fieldHint =
				result?.compareReason && result.compareReason.trim() !== "" ?
					result.compareReason.trim()
				:	"請參考 Diff";
			const statusHint =
				currentSnapshot === null ?
					"目前狀態未知"
				:	`目前狀態為 ${currentSnapshot.status}（${currentSnapshot.reason}），dataFreshnessScore=${currentSnapshot.dataFreshnessScore}。`;
			const decisionHint =
				result?.compareDecision === "keep_active" ?
					"因目前決策為 keep_active，先維持 active 設定並持續觀察。"
				:	"因目前 compareDecision 未明確，先維持 active 設定並持續觀察。";
			const ruleExplain = [
				`candidate 變更欄位：${fieldHint}（例如 freshnessWeight）。`,
				`方向解讀：更偏向以 volumeWeight/門檻驅動策略判讀，對 freshnessWeight 的敏感度降低。`,
				`${statusHint}`,
				decisionHint,
			]
				.slice(0, 4)
				.join("\n");
			console.log("[strategy] review explain fallback");
			return `MO Strategy Review Explain

${ruleExplain}`;
		}
		console.log("[strategy] review explain fallback");
		return `MO Strategy Review Explain

candidate 調整了部分策略權重與門檻，目前系統仍維持 active 設定，持續觀察中。`;
	  }
	  case "/strategy-review-debug": {
		const s = await readStrategyReviewState(env);
		if (s === null) {
			return `MO Strategy Review Debug

reviewKey: ${MO_STRATEGY_REVIEW_STATE_KEY}
reviewState: none`;
		}
		const [active, candidate, rr, demoOverride] = await Promise.all([
			readActiveStrategyConfig(env),
			readCandidateStrategyConfig(env),
			readStrategyReviewResult(env),
			readStrategyReviewDemoOverride(env),
		]);
		const demoLine =
			demoOverride === null ?
				"demoOverride: off"
			:	`demoOverride: on\n` +
				`demoOverrideNote: ${demoOverride.note}`;
		const promotionLine =
			s.reviewStatus === "promoted" ?
				`promotionState: completed` +
				(s.promotedAt ? `\npromotedAt: ${s.promotedAt}` : "") +
				(s.promotedFrom ? `\npromotedFrom: ${s.promotedFrom}` : "") +
				(s.promotedTo ? `\npromotedTo: ${s.promotedTo}` : "")
			:	"";
		if (rr !== null) {
			console.log("[strategy] review debug result loaded", {
				activeConfigVersion: rr.activeConfigVersion,
				candidateConfigVersion: rr.candidateConfigVersion,
				compareDecision: rr.compareDecision,
			});
		}
		if (candidate === null) {
			const base = `MO Strategy Review Debug

reviewKey: ${MO_STRATEGY_REVIEW_STATE_KEY}
${demoLine}
${promotionLine}
activeConfigVersion: ${s.activeConfigVersion}
candidateConfigVersion: ${s.candidateConfigVersion}
reviewStatus: ${s.reviewStatus}
reviewStartedAt: ${s.reviewStartedAt}
lastReviewedAt: ${s.lastReviewedAt}
note: ${s.note}`;
			if (rr === null) return base;
			return `${base}

[LastCompare]
source: ${rr.source ?? "unknown"}
comparedAt: ${rr.comparedAt}
compareDecision: ${rr.compareDecision}
compareReason: ${rr.compareReason}
compareSummary: ${rr.compareSummary}`;
		}
		console.log("[strategy] review debug diff", {
			activeConfigVersion: active.config.configVersion,
			candidateConfigVersion: candidate.configVersion,
		});
		const a = active.config;
		const c = candidate;
		const base = `MO Strategy Review Debug

reviewKey: ${MO_STRATEGY_REVIEW_STATE_KEY}
${demoLine}
${promotionLine}
activeConfigVersion: ${s.activeConfigVersion}
candidateConfigVersion: ${s.candidateConfigVersion}
reviewStatus: ${s.reviewStatus}
reviewStartedAt: ${s.reviewStartedAt}
lastReviewedAt: ${s.lastReviewedAt}
note: ${s.note}

[Diff]
freshnessWeight: active=${a.freshnessWeight} candidate=${c.freshnessWeight}
volumeWeight: active=${a.volumeWeight} candidate=${c.volumeWeight}
simulationWeight: active=${a.simulationWeight} candidate=${c.simulationWeight}
aggressiveMinScore: active=${a.aggressiveMinScore} candidate=${c.aggressiveMinScore}
balancedMinScore: active=${a.balancedMinScore} candidate=${c.balancedMinScore}
freshnessIdleThresholdMs: active=${a.freshnessIdleThresholdMs} candidate=${c.freshnessIdleThresholdMs}`;
		if (rr === null) return base;
		return `${base}

[LastCompare]
source: ${rr.source ?? "unknown"}
comparedAt: ${rr.comparedAt}
compareDecision: ${rr.compareDecision}
compareReason: ${rr.compareReason}
compareSummary: ${rr.compareSummary}`;
	  }
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
		const dbgNs = linePushOutcomeToStrategyNotifyStatus(pushOutcome);
		await recordStrategyNotifyOutcomeForStatus(
			env,
			userId,
			dbgNs.lastNotifyResult,
			dbgNs.lastNotifyReason
		);

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

		const activeStrategyConfigResult = await readActiveStrategyConfig(env);
		const activeStrategyConfig = activeStrategyConfigResult.config;
		const freshnessIdleThresholdMs = activeStrategyConfig.freshnessIdleThresholdMs;

		// 第一版可解釋策略規則：三因子加權（參數來源：active strategy config）
		const deltaMs =
			latestNoteMs === null ? Number.POSITIVE_INFINITY : Date.now() - latestNoteMs;
		// dataFreshnessScore: 0~100（0=過久未更新；100=剛更新）
		const dataFreshnessScore =
			latestNoteMs === null || deltaMs >= freshnessIdleThresholdMs ?
				0
			:	Math.round((1 - deltaMs / freshnessIdleThresholdMs) * 100);
		// dataVolumeScore: 0~100（0=無資料；>=10 筆視為滿分）
		const dataVolumeScore = Math.round(Math.min(1, totalNotesNum / 10) * 100);
		// simulationReadyScore: 0~100（有資料即可進行模擬）
		const simulationReadyScore = totalNotesNum > 0 ? 100 : 0;
		const weightSum =
			activeStrategyConfig.freshnessWeight +
			activeStrategyConfig.volumeWeight +
			activeStrategyConfig.simulationWeight;
		const fallback = getDefaultStrategyActiveConfig();
		const freshnessWeight =
			weightSum > 0 ? activeStrategyConfig.freshnessWeight / weightSum : fallback.freshnessWeight;
		const volumeWeight =
			weightSum > 0 ? activeStrategyConfig.volumeWeight / weightSum : fallback.volumeWeight;
		const simulationWeight =
			weightSum > 0 ? activeStrategyConfig.simulationWeight / weightSum : fallback.simulationWeight;

		const scoreRaw =
			dataFreshnessScore * freshnessWeight +
			dataVolumeScore * volumeWeight +
			simulationReadyScore * simulationWeight;
		const score = Math.max(0, Math.min(100, Math.round(scoreRaw)));

		console.log("[strategy] inputs", {
			configVersion: activeStrategyConfig.configVersion,
			dataFreshnessScore,
			dataVolumeScore,
			simulationReadyScore,
			totalNotesNum,
			deltaMs,
			freshnessIdleThresholdMs,
			freshnessWeight,
			volumeWeight,
			simulationWeight,
		});

		let recStatus: "active" | "idle";
		let recReason: string;
		if (latestNoteMs === null) {
			recStatus = "idle";
			recReason = "尚無資料";
		} else if (deltaMs > freshnessIdleThresholdMs) {
			recStatus = "idle";
			recReason = "長時間未更新";
		} else if (simulationReadyScore === 0) {
			recStatus = "idle";
			recReason = "無資料可模擬";
		} else {
			recStatus = "active";
			recReason = "近期有活動";
		}
		let recAction: string;
		if (totalNotesNum >= 10) {
			recAction = "建議進行策略分析（資料充足）";
		} else if (totalNotesNum >= 1) {
			recAction = "建議持續累積資料";
		} else {
			recAction = "建議新增第一筆資料";
		}
		let strategy: "aggressive" | "balanced" | "conservative";
		if (score >= activeStrategyConfig.aggressiveMinScore) {
			strategy = "aggressive";
		} else if (score >= activeStrategyConfig.balancedMinScore) {
			strategy = "balanced";
		} else {
			strategy = "conservative";
		}
		const strategyFromScore = strategy;
		console.log("[strategy] score result", {
			score,
			strategy: strategyFromScore,
			aggressiveMinScore: activeStrategyConfig.aggressiveMinScore,
			balancedMinScore: activeStrategyConfig.balancedMinScore,
		});
		// /report 僅做報表計算，不落盤覆寫 strategy_review_decision（避免污染 promotion/review 狀態）
		console.log("[strategy] report computed without persisting review decision", {
			score,
			strategy: strategyFromScore,
			status: recStatus,
			dataFreshnessScore,
		});
		let prevTrimForReport = "";
		// 測試模式覆寫（/report-test-change only）集中在此：確保正式 /report 不受影響
		let testForceChangedFromEmptyPrevious = false;
		let strategyFinal: "aggressive" | "balanced" | "conservative" = strategyFromScore;
		if (hasUserId) {
			const strategyKeyRead = `strategy:${userId}`;
			const prevRawRead = await env.MO_NOTES.get(strategyKeyRead, "text");
			prevTrimForReport = prevRawRead !== null ? prevRawRead.trim() : "";
			if (isReportTestChange && userId !== "unknown-user") {
				testForceChangedFromEmptyPrevious = prevTrimForReport === "";
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
				testForceChangedFromEmptyPrevious && prevTrim === "" ? "yes" :
					prevTrim !== "" && prevTrim !== strategyFinal ? "yes" : "no";
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
				const lockSlot = await acquireStrategyNotifyLock(env, userId);
				if (lockSlot === null) {
					console.log("[notify] skipped: in_progress", { userId });
					await recordStrategyNotifyOutcomeForStatus(
						env,
						userId,
						"in_progress",
						""
					);
				} else {
					console.log("[notify] lock acquired", { userId });
					try {
						const gate = await readStrategyNotifyGateFromKv(env, userId);
						const nowMs = Date.now();
						if (gate !== null && gate.lastNotifyMessage === notifyBody) {
							console.log("[notify] skipped: duplicate_message", { userId });
							await recordStrategyNotifyOutcomeForStatus(
								env,
								userId,
								"duplicate_message",
								""
							);
						} else if (
							gate !== null &&
							nowMs - gate.lastNotifyAt < STRATEGY_NOTIFY_COOLDOWN_MS
						) {
							const elapsedMs = nowMs - gate.lastNotifyAt;
							console.log("[notify] skipped: cooldown", {
								userId,
								elapsedMs,
								cooldownMs: STRATEGY_NOTIFY_COOLDOWN_MS,
							});
							await recordStrategyNotifyOutcomeForStatus(
								env,
								userId,
								"cooldown",
								`elapsedMs=${String(elapsedMs)}`
							);
						} else {
							console.log("[notify] start", { userId });
							await recordStrategyNotifyGateAttempt(
								env,
								userId,
								notifyBody,
								nowMs
							);
							const notifyPush = await lineBotPushTextMessage(
								env,
								userId,
								notifyBody
							);
							await recordLinePushOutcomeForStatus(env, userId, notifyPush);
							const ns = linePushOutcomeToStrategyNotifyStatus(notifyPush);
							await recordStrategyNotifyOutcomeForStatus(
								env,
								userId,
								ns.lastNotifyResult,
								ns.lastNotifyReason
							);
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
					} finally {
						await lockSlot.release();
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

		if (url.pathname === "/admin/strategy/test-auto-promote") {
			console.log("[strategy] admin strategy test start");
			try {
				const activeRes = await readActiveStrategyConfig(env);
				if (activeRes.source !== "kv") {
					return new Response(
						JSON.stringify({
							ok: false,
							error: "active strategy config not found in KV",
							source: activeRes.source,
							configVersion: activeRes.config.configVersion,
						}),
						{ headers: { "Content-Type": "application/json" } }
					);
				}
				const active = activeRes.config;

				const nowIso = new Date().toISOString();
				const candidateVersion = `candidate-admin-test-${Date.now()}`;
				const patchedField = "balancedMinScore";
				const patchedValue = 40;
				const candidate: StrategyActiveConfig = {
					...active,
					configVersion: candidateVersion,
					balancedMinScore: patchedValue,
					updatedAt: nowIso,
				};

				await env.MO_NOTES.put(
					MO_CANDIDATE_STRATEGY_CONFIG_KEY,
					JSON.stringify(candidate)
				);

				// 初始化 review cycle，避免沿用舊結果
				await Promise.all([
					clearStrategyReviewResult(env),
					clearStrategyReviewDecision(env),
					writeStrategyReviewStateNewCycle({
						env,
						activeConfigVersion: active.configVersion,
						candidateConfigVersion: candidate.configVersion,
						note: "admin test auto promote",
					}),
				]);

				const review = await runStrategyReview({
					env,
					userId: "admin",
					source: "real",
					allowDemoOverride: false,
				});

				const [rr, rd] = await Promise.all([
					readStrategyReviewResult(env),
					readStrategyReviewDecision(env),
				]);
				if (rr === null) {
					return new Response(
						JSON.stringify({ ok: false, error: "strategy_review_result not found" }),
						{ headers: { "Content-Type": "application/json" } }
					);
				}
				if (rd === null) {
					return new Response(
						JSON.stringify({ ok: false, error: "strategy_review_decision not found" }),
						{ headers: { "Content-Type": "application/json" } }
					);
				}

				const payload = {
					ok: true,
					activeConfigVersion: active.configVersion,
					candidateConfigVersion: candidate.configVersion,
					patchedField,
					patchedValue,
					compareDecision: rr.compareDecision,
					compareReason: rr.compareReason,
					decision: rd.decision,
					decisionSource: rd.decisionSource ?? "unknown",
					evaluatedAt: rd.evaluatedAt,
				};
				console.log("[strategy] admin strategy test result", {
					ok: true,
					compareDecision: payload.compareDecision,
					decision: payload.decision,
				});
				return new Response(JSON.stringify(payload), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				console.log("[strategy] admin strategy test result", { ok: false, message });
				return new Response(JSON.stringify({ ok: false, error: message }), {
					headers: { "Content-Type": "application/json" },
				});
			}
		}
  
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