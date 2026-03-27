import {
	computeStrategyComparePure,
	evaluateAutoPromoteCore,
	shouldRefreshStrategyReviewKv,
	STRATEGY_AUTO_PROMOTE_CONFIRM_REQUIRED,
	STRATEGY_AUTO_PROMOTE_COOLDOWN_MS,
	MO_LIVE_SOURCE_TWSE_MI_INDEX,
	getTaipeiYYYYMMDDMinusDaysFromToday,
	deriveMoLiveCycleStatus,
	summarizeTwseMiIndexPayload,
	isTwseMiIndexPayloadOk,
	formatMoLiveMarketStatusBlock,
	buildMoReportText as moReportComposeFullText,
	buildMoReportTextV1 as moReportComposeFullTextV1,
	buildMarketStatusText as moReportMarketLine,
	buildSystemDecisionText as moReportSystemDecision,
	buildActionText as moReportActionLine,
	getMoLiveCycleStatusFromSnapshotRead,
	formatDisplayDateFromYyyymmdd,
	deriveMoLiveDataGovernance,
	buildMoReportDataQualityNote,
	buildMarketStatusLineWithGovernance,
	getMoLiveReportCycleFromGovernance,
	deriveLiveMarketIntelligenceV1,
	buildMoReportMarketSummarySection,
	buildSystemDecisionLineLiveIntelligence,
	buildActionLineLiveIntelligence,
	buildSimulationStatusLineLiveIntelligence,
	evaluateMoPushEventDecision,
	MO_PUSH_COOLDOWN_MS_DEFAULT,
	MO_PUSH_COOLDOWN_MS_P3_ONLY,
} from "../scripts/dev-check.js";

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
	LINE_MODE?: "normal" | "reply_only" | "push_enabled";
	DEBUG_LOG?: string;
	/** 僅測試用：非空時覆寫 /report 與 push 決策用的 actionLine（未設定則維持 buildActionText(score)） */
	MO_FORCE_REPORT_ACTION_LINE?: string;
	/** FinMind API token（TWSE 失敗時 fallback 使用） */
	FINMIND_TOKEN?: string;
	/** 僅驗證用：設為 "1" 時不呼叫 TWSE，直接走 FinMind fallback（正式請勿啟用） */
	MO_FORCE_TWSE_FAIL_FOR_TEST?: string;
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
	moPushAudit: "mo_push_audit",
} as const;

/** 正式 strategy notify：兩次推播嘗試最短間隔（毫秒）；與 dev-check MO_PUSH_COOLDOWN_MS_DEFAULT 一致 */
const STRATEGY_NOTIFY_COOLDOWN_MS = MO_PUSH_COOLDOWN_MS_DEFAULT;

/** 早於此間隔的 mo_live 快照在 /status、/report 標示為 stale（僅顯示，不改 push 決策核心） */
const MO_LIVE_SNAPSHOT_STALE_MS = 6 * 60 * 60 * 1000;

function isMoLiveSnapshotStale(createdAtIso: string, nowMs: number): boolean {
	const t = Date.parse(createdAtIso);
	if (!Number.isFinite(t)) return true;
	return nowMs - t > MO_LIVE_SNAPSHOT_STALE_MS;
}

/** notify 併發鎖租約（毫秒）；應涵蓋 push 往返時間，逾時由 KV expiration 回收 */
const STRATEGY_NOTIFY_LOCK_LEASE_MS = 3 * 60 * 1000;

type StrategyNotifyGateRecord = {
	lastNotifyMessage: string;
	lastNotifyAt: number;
	/** 數字愈小愈高優先（與 MO_PUSH_PRIORITY 一致） */
	lastNotifyPriority?: number;
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
		let lastNotifyPriority: number | undefined;
		if (
			"lastNotifyPriority" in parsed &&
			typeof (parsed as Record<string, unknown>).lastNotifyPriority === "number" &&
			Number.isFinite((parsed as Record<string, unknown>).lastNotifyPriority as number)
		) {
			lastNotifyPriority = (parsed as Record<string, unknown>)
				.lastNotifyPriority as number;
		}
		return {
			lastNotifyMessage: parsed.lastNotifyMessage,
			lastNotifyAt: parsed.lastNotifyAt,
			...(lastNotifyPriority !== undefined ? { lastNotifyPriority } : {}),
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
	atMs: number,
	notifyPriority?: number
): Promise<void> {
	try {
		const rec: StrategyNotifyGateRecord = {
			lastNotifyMessage: message,
			lastNotifyAt: atMs,
			...(notifyPriority !== undefined ? { lastNotifyPriority: notifyPriority } : {}),
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

type MoPushEvaluationResult = {
	shouldNotify: boolean;
	triggeredEvents: Array<{ type: string; summary: string }>;
	primaryPushType: string | null;
	pushPriority: number | null;
	pushReason: string;
	pushResult: string;
	pushMessage: string;
	mergedMessage: string;
	cooldownRemainingMs: number | null;
	fingerprint: string;
	comparedState: {
		fingerprint: string;
		marketLine: string;
		actionLine: string;
		currentPromoteKey: string;
	};
	moPushDataGate?: string;
};

type MoPushAuditRecord = {
	lastPushType: string;
	lastPushEventsSummary: string;
	lastPushPriority: number | null;
	lastPushResult: string;
	lastPushReason: string;
	lastPushAt: string;
	lastPushDryRun: boolean;
	lastPushMessagePreview: string;
	cooldownRemainingMs: number | null;
	lastPushedFingerprint: string | null;
	comparedFingerprint: string;
	lastEvaluatedMarketLine: string | null;
	lastEvaluatedActionLine: string | null;
	lastEvaluatedPromoteKey: string | null;
	/** 資料可信度 gate（例如 push_ineligible_snapshot） */
	lastMoPushDataGate?: string;
};

function getMoPushAuditKey(userId: string): string {
	return buildMoUserKvKey(MO_USER_KV_PREFIX.moPushAudit, userId);
}

function truncateMoPushPreviewText(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

function parseMoPushAuditRecord(raw: string): MoPushAuditRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const o = parsed as Record<string, unknown>;
		if (typeof o.lastPushType !== "string") return null;
		if (typeof o.lastPushResult !== "string") return null;
		if (typeof o.lastPushReason !== "string") return null;
		if (typeof o.lastPushAt !== "string") return null;
		if (typeof o.lastPushDryRun !== "boolean") return null;
		if (typeof o.lastPushMessagePreview !== "string") return null;
		if (
			o.cooldownRemainingMs !== null &&
			(typeof o.cooldownRemainingMs !== "number" || !Number.isFinite(o.cooldownRemainingMs))
		) {
			return null;
		}
		if (o.lastPushedFingerprint !== null && typeof o.lastPushedFingerprint !== "string") {
			return null;
		}
		if (typeof o.comparedFingerprint !== "string") return null;
		let lastPushEventsSummary = "";
		if (typeof o.lastPushEventsSummary === "string") {
			lastPushEventsSummary = o.lastPushEventsSummary;
		}
		let lastPushPriority: number | null = null;
		if ("lastPushPriority" in o && o.lastPushPriority !== undefined) {
			if (o.lastPushPriority === null) {
				lastPushPriority = null;
			} else if (
				typeof o.lastPushPriority === "number" &&
				Number.isFinite(o.lastPushPriority)
			) {
				lastPushPriority = o.lastPushPriority;
			} else {
				return null;
			}
		}
		let lastEvaluatedMarketLine: string | null = null;
		if ("lastEvaluatedMarketLine" in o) {
			if (o.lastEvaluatedMarketLine === null) lastEvaluatedMarketLine = null;
			else if (typeof o.lastEvaluatedMarketLine === "string") {
				lastEvaluatedMarketLine = o.lastEvaluatedMarketLine;
			} else return null;
		}
		let lastEvaluatedActionLine: string | null = null;
		if ("lastEvaluatedActionLine" in o) {
			if (o.lastEvaluatedActionLine === null) lastEvaluatedActionLine = null;
			else if (typeof o.lastEvaluatedActionLine === "string") {
				lastEvaluatedActionLine = o.lastEvaluatedActionLine;
			} else return null;
		}
		let lastEvaluatedPromoteKey: string | null = null;
		if ("lastEvaluatedPromoteKey" in o) {
			if (o.lastEvaluatedPromoteKey === null) lastEvaluatedPromoteKey = null;
			else if (typeof o.lastEvaluatedPromoteKey === "string") {
				lastEvaluatedPromoteKey = o.lastEvaluatedPromoteKey;
			} else return null;
		}
		let lastMoPushDataGate: string | undefined;
		if ("lastMoPushDataGate" in o && o.lastMoPushDataGate !== undefined) {
			if (typeof o.lastMoPushDataGate !== "string") return null;
			lastMoPushDataGate = o.lastMoPushDataGate;
		}
		return {
			lastPushType: o.lastPushType,
			lastPushEventsSummary,
			lastPushPriority,
			lastPushResult: o.lastPushResult,
			lastPushReason: o.lastPushReason,
			lastPushAt: o.lastPushAt,
			lastPushDryRun: o.lastPushDryRun,
			lastPushMessagePreview: o.lastPushMessagePreview,
			cooldownRemainingMs: o.cooldownRemainingMs === null ? null : o.cooldownRemainingMs,
			lastPushedFingerprint: o.lastPushedFingerprint === null ? null : o.lastPushedFingerprint,
			comparedFingerprint: o.comparedFingerprint,
			lastEvaluatedMarketLine,
			lastEvaluatedActionLine,
			lastEvaluatedPromoteKey,
			...(lastMoPushDataGate !== undefined ? { lastMoPushDataGate } : {}),
		};
	} catch {
		return null;
	}
}

async function readMoPushAudit(env: Env, userId: string): Promise<MoPushAuditRecord | null> {
	return readMoUserKvJson(env, userId, getMoPushAuditKey(userId), parseMoPushAuditRecord);
}

async function recordMoPushAudit(env: Env, userId: string, rec: MoPushAuditRecord): Promise<void> {
	try {
		await env.MO_NOTES.put(getMoPushAuditKey(userId), JSON.stringify(rec));
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.log("[mo-push] audit write failed", { userId, message });
	}
}

function moPushAuditFromEvaluation(
	evaluation: MoPushEvaluationResult,
	params: {
		dryRun: boolean;
		lastPushedFingerprint: string | null;
		snapshotTimeIso: string;
		messagePreview: string;
		lastPushResultOverride?: string;
		lastPushTypeOverride?: string | null;
		lastEvaluatedSnapshot?: {
			marketLine: string;
			actionLine: string;
			promoteKey: string;
		} | null;
		previousAudit: MoPushAuditRecord | null;
	}
): MoPushAuditRecord {
	const primary =
		params.lastPushTypeOverride ??
		(evaluation.primaryPushType === null ? "none" : evaluation.primaryPushType);
	const eventsSummary = evaluation.triggeredEvents.map((e) => e.type).join(",");
	const evSnap = params.lastEvaluatedSnapshot;
	const prev = params.previousAudit;
	const lastEvaluatedMarketLine =
		evSnap !== undefined && evSnap !== null ? evSnap.marketLine
		: prev !== null ? prev.lastEvaluatedMarketLine
		: null;
	const lastEvaluatedActionLine =
		evSnap !== undefined && evSnap !== null ? evSnap.actionLine
		: prev !== null ? prev.lastEvaluatedActionLine
		: null;
	const lastEvaluatedPromoteKey =
		evSnap !== undefined && evSnap !== null ? evSnap.promoteKey
		: prev !== null ? prev.lastEvaluatedPromoteKey
		: null;
	return {
		lastPushType: primary,
		lastPushEventsSummary: eventsSummary,
		lastPushPriority: evaluation.pushPriority,
		lastPushResult: params.lastPushResultOverride ?? evaluation.pushResult,
		lastPushReason: evaluation.pushReason,
		...(evaluation.moPushDataGate !== undefined ?
			{ lastMoPushDataGate: evaluation.moPushDataGate }
		:	{}),
		lastPushAt: params.snapshotTimeIso,
		lastPushDryRun: params.dryRun,
		lastPushMessagePreview: truncateMoPushPreviewText(params.messagePreview, 200),
		cooldownRemainingMs: evaluation.cooldownRemainingMs,
		lastPushedFingerprint: params.lastPushedFingerprint,
		comparedFingerprint: evaluation.comparedState.fingerprint,
		lastEvaluatedMarketLine,
		lastEvaluatedActionLine,
		lastEvaluatedPromoteKey,
	};
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
function moPushEventPriorityForDisplay(t: string): number {
	if (t === "strategy_promoted") return 1;
	if (t === "report_action_changed") return 2;
	if (t === "market_status_changed") return 3;
	return 99;
}

/** 由 v2 fingerprint 還原主要事件型別（與 dev-check primary 規則一致） */
function derivePrimaryMoPushTypeFromV2Fingerprint(fp: string): string | null {
	if (!fp.startsWith("v2|")) return null;
	const second = fp.split("|")[1];
	if (second === undefined || second === "") return null;
	const types = second.split(",").filter((x) => x !== "");
	if (types.length === 0) return null;
	let best = types[0];
	let bestP = moPushEventPriorityForDisplay(best);
	for (const t of types) {
		const p = moPushEventPriorityForDisplay(t);
		if (p < bestP) {
			best = t;
			bestP = p;
		}
	}
	return best;
}

function eventSummaryFromV2Fingerprint(fp: string): string | null {
	if (!fp.startsWith("v2|")) return null;
	const second = fp.split("|")[1];
	return second === undefined ? null : second;
}

/** 舊版 KV（mo_update / 舊 reason / 非 v2 fingerprint）在顯示時需正規化，避免 /status 仍像走舊 decision */
function isLegacyMoPushAuditSnapshot(rec: MoPushAuditRecord): boolean {
	return (
		rec.lastPushType === "mo_update" ||
		rec.lastPushReason === "market_or_action_changed" ||
		!rec.comparedFingerprint.startsWith("v2|")
	);
}

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
	const lineMode =
		env.LINE_MODE === undefined || env.LINE_MODE === "" ? "normal" : env.LINE_MODE;
	if (!hasMoStatusUserId(userId)) {
		return [
			`lineMode: ${lineMode}`,
			"lastNotifyResult: none",
			"lastNotifyReason: none",
			"lastNotifyAt: none",
			"lastPush: none",
		].join("\n");
	}
	const [n, r, moAudit] = await Promise.all([
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
		readMoPushAudit(env, userId),
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
	} else {
		lines.push(`lastPush: ${r.kind}`);
		if (r.pushStatus !== undefined) {
			lines.push(`pushStatus: ${r.pushStatus}`);
		}
		lines.push(`pushAt: ${r.pushAt}`);
		if (r.pushBodySummary !== undefined && r.pushBodySummary !== "") {
			lines.push(`pushBody: ${r.pushBodySummary}`);
		}
	}
	if (moAudit === null) {
		lines.push("moPushAudit: none");
	} else {
		let displayType = moAudit.lastPushType;
		let displayReason = moAudit.lastPushReason;
		let displayEvents = moAudit.lastPushEventsSummary;
		let displayPriority = moAudit.lastPushPriority;
		if (isLegacyMoPushAuditSnapshot(moAudit)) {
			const fromFp = derivePrimaryMoPushTypeFromV2Fingerprint(moAudit.comparedFingerprint);
			const evFromFp = eventSummaryFromV2Fingerprint(moAudit.comparedFingerprint);
			if (fromFp !== null) {
				displayType = fromFp;
			} else if (moAudit.lastPushType === "mo_update") {
				displayType = "legacy_unmigrated";
			}
			if (evFromFp !== null && displayEvents.trim() === "") {
				displayEvents = evFromFp;
			}
			if (displayPriority === null && fromFp !== null) {
				displayPriority = moPushEventPriorityForDisplay(fromFp);
			}
			if (moAudit.lastPushReason === "market_or_action_changed") {
				displayReason =
					"legacy_market_or_action_changed（已停用；事件型紀錄將於下次 /report 或推播寫入後更新）";
			}
		}
		lines.push(`moPushType: ${displayType}`);
		if (displayEvents.trim() !== "") {
			lines.push(`moPushEvents: ${displayEvents.replace(/\s+/gu, " ").trim()}`);
		}
		if (displayPriority !== null) {
			lines.push(`moPushPriority: ${String(displayPriority)}`);
		}
		lines.push(`moPushResult: ${moAudit.lastPushResult}`);
		lines.push(`moPushReason: ${displayReason}`);
		if (moAudit.lastMoPushDataGate !== undefined && moAudit.lastMoPushDataGate !== "") {
			lines.push(`moPushDataGate: ${moAudit.lastMoPushDataGate}`);
		}
		lines.push(`moPushAt: ${moAudit.lastPushAt}`);
		lines.push(`moPushDryRun: ${moAudit.lastPushDryRun ? "yes" : "no"}`);
		const fpOne = moAudit.comparedFingerprint.replace(/\s+/gu, " ").trim();
		if (fpOne !== "") {
			const fpShow = fpOne.length > 160 ? `${fpOne.slice(0, 160)}…` : fpOne;
			lines.push(`moPushFingerprint: ${fpShow}`);
		}
		if (moAudit.cooldownRemainingMs !== null) {
			lines.push(`moPushCooldownRemainingMs: ${String(moAudit.cooldownRemainingMs)}`);
		}
		if (moAudit.lastPushMessagePreview.trim() !== "") {
			const previewOneLine = moAudit.lastPushMessagePreview.replace(/\s+/gu, " ").trim();
			lines.push(`moPushPreview: ${previewOneLine}`);
		}
	}
	if (
		lineMode === "reply_only" &&
		n !== null &&
		n.lastNotifyResult === "success"
	) {
		lines.push(
			"pushModeNote: reply_only 與 lastNotifyResult=success 並存異常，請確認 LINE_MODE 是否曾變更"
		);
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
	/** Live Market Intelligence v1 快照（供 /status Report 區塊） */
	reportDataQuality?: string;
	recommendationReadiness?: string;
	simulationReadiness?: string;
	recommendationGateReason?: string;
	simulationGateReason?: string;
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
		const optStr = (k: string): string | undefined => {
			if (!(k in parsed) || typeof (parsed as Record<string, unknown>)[k] !== "string") {
				return undefined;
			}
			const v = String((parsed as Record<string, unknown>)[k]).trim();
			return v === "" ? undefined : v;
		};
		const rdq = optStr("reportDataQuality");
		if (rdq !== undefined) rec.reportDataQuality = rdq;
		const rr = optStr("recommendationReadiness");
		if (rr !== undefined) rec.recommendationReadiness = rr;
		const sr = optStr("simulationReadiness");
		if (sr !== undefined) rec.simulationReadiness = sr;
		const rgr = optStr("recommendationGateReason");
		if (rgr !== undefined) rec.recommendationGateReason = rgr;
		const sgr = optStr("simulationGateReason");
		if (sgr !== undefined) rec.simulationGateReason = sgr;
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
	if (r.reportDataQuality !== undefined) {
		lines.push(`reportDataQuality: ${r.reportDataQuality}`);
	}
	if (r.recommendationReadiness !== undefined) {
		lines.push(`recommendationReadiness: ${r.recommendationReadiness}`);
	}
	if (r.simulationReadiness !== undefined) {
		lines.push(`simulationReadiness: ${r.simulationReadiness}`);
	}
	if (r.recommendationGateReason !== undefined) {
		lines.push(`recommendationGateReason: ${r.recommendationGateReason}`);
	}
	if (r.simulationGateReason !== undefined) {
		lines.push(`simulationGateReason: ${r.simulationGateReason}`);
	}
	lines.push(`reportAt: ${r.timestamp}`);
	return lines.join("\n");
}

type MoStatusState = {
	lastPushBlock: string;
	decisionBlock: string;
	reportBlock: string;
	liveMarketBlock: string;
};

type MoLiveSnapshotRow = {
	trade_date: string;
	source: string;
	payload_summary: string;
	created_at: string;
};

/** 與 D1 payload_summary JSON 對齊（v2 正規化） */
type MoLiveSummaryV2 = {
	v: 2;
	source: string;
	sourceLevel: "primary" | "fallback1" | "fallback2";
	fetchStatus: "success" | "fallback_used" | "unavailable";
	confidence: "high" | "medium" | "low";
	rawAvailabilityNote: string;
	legacySummary: string;
};

/** D1 `source`：FinMind TaiwanStockPrice，data_id=TAIEX（加權指數日線） */
const MO_LIVE_SOURCE_FINMIND_TAIEX = "FINMIND_TaiwanStockPrice";

/** TWSE 官方 Open API（與 rwd 主路徑不同） */
const MO_LIVE_SOURCE_TWSE_OPENAPI_MI_INDEX = "TWSE_OpenAPI_MI_INDEX";

/** 三層皆失敗時寫入快照的 source 標記 */
const MO_LIVE_SOURCE_UNAVAILABLE = "MO_LIVE_UNAVAILABLE";

const TWSE_OPENAPI_MI_INDEX_ENDPOINT =
	"https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX";

/** Open API 回傳之「發行量加權股價指數」列 */
const TWSE_OPENAPI_WEIGHTED_INDEX_NAME = "發行量加權股價指數";

function isMoLiveSummaryV2(x: unknown): x is MoLiveSummaryV2 {
	if (typeof x !== "object" || x === null) return false;
	const o = x as Record<string, unknown>;
	if (o.v !== 2) return false;
	if (typeof o.source !== "string") return false;
	if (
		o.sourceLevel !== "primary" &&
		o.sourceLevel !== "fallback1" &&
		o.sourceLevel !== "fallback2"
	) {
		return false;
	}
	if (
		o.fetchStatus !== "success" &&
		o.fetchStatus !== "fallback_used" &&
		o.fetchStatus !== "unavailable"
	) {
		return false;
	}
	if (o.confidence !== "high" && o.confidence !== "medium" && o.confidence !== "low") {
		return false;
	}
	if (typeof o.rawAvailabilityNote !== "string") return false;
	if (typeof o.legacySummary !== "string") return false;
	return true;
}

function parseMoLivePayloadSummaryV2(raw: string): MoLiveSummaryV2 | null {
	const t = raw.trim();
	if (!t.startsWith("{")) return null;
	try {
		const parsed: unknown = JSON.parse(t);
		return isMoLiveSummaryV2(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** 與 dev-check deriveMoLiveDataGovernance 對齊（單一推導來源） */
type MoLiveDataUsability = "display_only" | "decision_ok" | "push_ok" | "unusable";
type MoLiveStalenessLevel = "fresh" | "aging" | "stale" | "too_old";

type MoLiveDataGovernance = {
	tradeDate: string;
	source: string;
	sourceLevel: string;
	fetchStatus: string;
	confidence: string;
	rawAvailabilityNote: string;
	legacySummary: string;
	dataUsability: MoLiveDataUsability;
	stalenessLevel: MoLiveStalenessLevel;
	freshnessMinutes: number | null;
	sourcePriority: number;
	decisionEligible: boolean;
	pushEligible: boolean;
	displayFetchStatus: string;
	liveFreshness: string;
};

/** Live Market Intelligence v1（與 dev-check deriveLiveMarketIntelligenceV1 對齊） */
type MoLiveMarketIntelligenceV1 = {
	marketDataAvailable: boolean;
	marketDataQuality: "trusted" | "limited" | "weak" | "unusable";
	marketRecencyLabel: string;
	marketValue: string | null;
	marketValueChange: null;
	marketInterpretation: string;
	recommendationReadiness: "ready" | "limited" | "blocked";
	simulationReadiness: "ready" | "limited" | "blocked";
	recommendationGateReason: string;
	simulationGateReason: string;
};

function deriveMoLiveDataGovernanceTyped(
	row: MoLiveSnapshotRow | null,
	nowMs: number,
	todayYyyymmdd: string
): MoLiveDataGovernance {
	const g = deriveMoLiveDataGovernance({
		row,
		nowMs,
		todayYyyymmdd,
	}) as MoLiveDataGovernance;
	return g;
}

function formatMoLiveGovernanceStatusBlock(
	row: MoLiveSnapshotRow,
	gov: MoLiveDataGovernance
): string {
	const cycleLine =
		gov.dataUsability === "unusable" ? "fetch_failed" : "success";
	const fm =
		gov.freshnessMinutes === null ? "n/a" : String(gov.freshnessMinutes);
	return [
		`source: ${gov.source}`,
		`sourceLevel: ${gov.sourceLevel}`,
		`fetchStatus: ${gov.displayFetchStatus}`,
		`confidence: ${gov.confidence}`,
		`liveFreshness: ${gov.liveFreshness}`,
		`freshnessMinutes: ${fm}`,
		`stalenessLevel: ${gov.stalenessLevel}`,
		`dataUsability: ${gov.dataUsability}`,
		`decisionEligible: ${gov.decisionEligible ? "yes" : "no"}`,
		`pushEligible: ${gov.pushEligible ? "yes" : "no"}`,
		`sourcePriority: ${String(gov.sourcePriority)}`,
		`rawAvailabilityNote: ${gov.rawAvailabilityNote}`,
		`tradeDate: ${row.trade_date}`,
		`summary: ${gov.legacySummary}`,
		`storedAt: ${row.created_at}`,
		`cycle: ${cycleLine}`,
	].join("\n");
}

function formatMoLiveGovernanceSnapshotOnly(gov: MoLiveDataGovernance): string {
	const fm =
		gov.freshnessMinutes === null ? "n/a" : String(gov.freshnessMinutes);
	return [
		`source: ${gov.source}`,
		`sourceLevel: ${gov.sourceLevel}`,
		`fetchStatus: ${gov.displayFetchStatus}`,
		`confidence: ${gov.confidence}`,
		`liveFreshness: ${gov.liveFreshness}`,
		`freshnessMinutes: ${fm}`,
		`stalenessLevel: ${gov.stalenessLevel}`,
		`dataUsability: ${gov.dataUsability}`,
		`decisionEligible: ${gov.decisionEligible ? "yes" : "no"}`,
		`pushEligible: ${gov.pushEligible ? "yes" : "no"}`,
		`sourcePriority: ${String(gov.sourcePriority)}`,
		`rawAvailabilityNote: ${gov.rawAvailabilityNote}`,
		`tradeDate: ${gov.tradeDate}`,
		`summary: ${gov.legacySummary}`,
		`cycle: ${gov.dataUsability === "unusable" ? "fetch_failed" : "waiting_data"}`,
	].join("\n");
}

function parseFinMindTaiwanStockPriceTaiexResponse(
	parsed: unknown
): { tradeDateYyyymmdd: string; legacySummary: string } | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const o = parsed as Record<string, unknown>;
	if (o.msg === "error") return null;
	const data = o.data;
	if (!Array.isArray(data) || data.length === 0) return null;
	const last = data[data.length - 1];
	if (typeof last !== "object" || last === null) return null;
	const row = last as Record<string, unknown>;
	const dateRaw = row.date;
	if (typeof dateRaw !== "string") return null;
	const ymd = dateRaw.replace(/-/gu, "");
	if (!/^\d{8}$/.test(ymd)) return null;
	const close = row.close;
	const legacySummary = `finmind=TaiwanStockPrice;data_id=TAIEX;date=${ymd};close=${
		typeof close === "number" && Number.isFinite(close) ? String(close) : ""
	}`;
	return { tradeDateYyyymmdd: ymd, legacySummary };
}

/** FinMind v4 要求 start_date / end_date 為 YYYY-MM-DD（不可為 YYYYMMDD） */
function yyyymmddToFinMindDate(yyyymmdd: string): string | null {
	if (!/^\d{8}$/u.test(yyyymmdd)) return null;
	return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function maskFinMindTokenInRequestUrl(fullUrl: string): string {
	try {
		const u = new URL(fullUrl);
		if (u.searchParams.has("token")) {
			u.searchParams.set("token", "***");
		}
		return u.toString();
	} catch {
		return "<invalid url>";
	}
}

/**
 * FinMind fallback：GET /api/v4/data dataset=TaiwanStockPrice data_id=TAIEX
 * （與 TWSE MI_INDEX 欄位不同，僅最小日線；v4 已無 TaiwanStockDaily 資料集名稱）
 */
async function tryFinMindTaiexDaily(env: Env): Promise<
	| { ok: true; tradeDateYyyymmdd: string; rawText: string; legacySummary: string }
	| { ok: false; note: string }
> {
	const token = env.FINMIND_TOKEN?.trim();
	if (token === undefined || token === "") {
		return { ok: false, note: "FINMIND_TOKEN unset" };
	}
	let lastNote = "";
	for (let i = 0; i < 7; i++) {
		const td = getTaipeiYYYYMMDDMinusDaysFromToday(i);
		const finDate = yyyymmddToFinMindDate(td);
		if (finDate === null) {
			lastNote = `bad td ${td}`;
			continue;
		}
		const params = new URLSearchParams({
			dataset: "TaiwanStockPrice",
			data_id: "TAIEX",
			start_date: finDate,
			end_date: finDate,
			token,
		});
		const url = `https://api.finmindtrade.com/api/v4/data?${params.toString()}`;
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; MO-vNext/1.0; FinMind-fallback)",
				},
			});
			const text = await res.text();
			if (!res.ok) {
				console.log("[mo-live] finmind http error", {
					requestUrl: maskFinMindTokenInRequestUrl(url),
					status: res.status,
					bodyPreview: text.slice(0, 200),
				});
				lastNote = `http ${String(res.status)} for ${td}`;
				continue;
			}
			let j: unknown;
			try {
				j = JSON.parse(text) as unknown;
			} catch {
				lastNote = `json parse failed for ${td}`;
				continue;
			}
			const parsed = parseFinMindTaiwanStockPriceTaiexResponse(j);
			if (parsed !== null) {
				return {
					ok: true,
					tradeDateYyyymmdd: parsed.tradeDateYyyymmdd,
					rawText: text,
					legacySummary: parsed.legacySummary,
				};
			}
			lastNote = `no TAIEX row for ${td}`;
		} catch (err: unknown) {
			lastNote = err instanceof Error ? err.message : String(err);
		}
	}
	return { ok: false, note: lastNote || "FinMind TAIEX daily empty" };
}

/** Open API「日期」欄位：民國 yyyMMdd（7 位數）→ 西元 YYYYMMDD */
function rocYyyymmddToGregorianYyyymmdd(roc: string): string | null {
	if (!/^\d{7}$/u.test(roc)) return null;
	const rocY = Number(roc.slice(0, 3));
	const mm = roc.slice(3, 5);
	const dd = roc.slice(5, 7);
	const gy = rocY + 1911;
	if (gy < 1990 || gy > 2100) return null;
	return `${String(gy)}${mm}${dd}`;
}

function parseTwseOpenApiMiIndexWeightedResponse(
	parsed: unknown
): { tradeDateYyyymmdd: string; legacySummary: string } | null {
	if (!Array.isArray(parsed)) return null;
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		const nameRaw = row["指數"];
		if (typeof nameRaw !== "string") continue;
		if (nameRaw.trim() !== TWSE_OPENAPI_WEIGHTED_INDEX_NAME) continue;
		const rocDate = row["日期"];
		if (typeof rocDate !== "string") continue;
		const greg = rocYyyymmddToGregorianYyyymmdd(rocDate);
		if (greg === null) continue;
		const close = row["收盤指數"];
		let closeStr = "";
		if (typeof close === "string") {
			closeStr = close;
		} else if (typeof close === "number" && Number.isFinite(close)) {
			closeStr = String(close);
		}
		const legacySummary = `twse_openapi=exchangeReport/MI_INDEX;weighted=${TWSE_OPENAPI_WEIGHTED_INDEX_NAME};date=${greg};close=${closeStr}`;
		return { tradeDateYyyymmdd: greg, legacySummary };
	}
	return null;
}

/**
 * 第 3 層：TWSE 官方 Open API（openapi.twse.com.tw）GET /v1/exchangeReport/MI_INDEX
 * 僅取「發行量加權股價指數」收盤指數（UTF-8 JSON，與 rwd 主路徑不同）。
 */
async function tryTwseOpenApiMiIndexWeighted(env: Env): Promise<
	| { ok: true; tradeDateYyyymmdd: string; rawText: string; legacySummary: string }
	| { ok: false; note: string }
> {
	void env;
	let lastNote = "";
	for (let i = 0; i < 14; i++) {
		const td = getTaipeiYYYYMMDDMinusDaysFromToday(i);
		const url = `${TWSE_OPENAPI_MI_INDEX_ENDPOINT}?date=${encodeURIComponent(td)}`;
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; MO-vNext/1.0; TWSE-OpenAPI-fallback)",
				},
			});
			const text = await res.text();
			if (!res.ok) {
				console.log("[mo-live] official http error", {
					requestUrl: url,
					status: res.status,
					bodyPreview: text.slice(0, 200),
				});
				lastNote = `http ${String(res.status)} for ${td}`;
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(text) as unknown;
			} catch {
				lastNote = `json parse failed for ${td}`;
				continue;
			}
			const row = parseTwseOpenApiMiIndexWeightedResponse(parsed);
			if (row !== null) {
				return {
					ok: true,
					tradeDateYyyymmdd: row.tradeDateYyyymmdd,
					rawText: text,
					legacySummary: row.legacySummary,
				};
			}
			lastNote = `no weighted index row for ${td}`;
		} catch (err: unknown) {
			lastNote = err instanceof Error ? err.message : String(err);
		}
	}
	return { ok: false, note: lastNote || "TWSE OpenAPI MI_INDEX empty" };
}

async function readLatestMoLiveMarketSnapshot(
	env: Env
): Promise<{ kind: "ok"; row: MoLiveSnapshotRow | null } | { kind: "error"; message: string }> {
	try {
		const r = await env.MO_DB.prepare(
			`SELECT trade_date, source, payload_summary, created_at
			 FROM mo_live_market_snapshots
			 ORDER BY id DESC
			 LIMIT 1`
		).first<Record<string, unknown>>();
		if (r === null) {
			return { kind: "ok", row: null };
		}
		const td = r.trade_date;
		const src = r.source;
		const ps = r.payload_summary;
		const ca = r.created_at;
		if (
			typeof td !== "string" ||
			typeof src !== "string" ||
			typeof ps !== "string" ||
			typeof ca !== "string"
		) {
			return { kind: "error", message: "invalid mo_live row shape" };
		}
		return {
			kind: "ok",
			row: { trade_date: td, source: src, payload_summary: ps, created_at: ca },
		};
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { kind: "error", message };
	}
}

async function buildMoLiveMarketStatusBlock(env: Env): Promise<string> {
	const read = await readLatestMoLiveMarketSnapshot(env);
	const nowMs = Date.now();
	const todayYyyymmdd = getTaipeiYYYYMMDDMinusDaysFromToday(0);
	if (read.kind === "error") {
		return formatMoLiveMarketStatusBlock(null, { d1ReadError: read.message });
	}
	if (read.row === null) {
		const base = formatMoLiveMarketStatusBlock(null, {});
		const gov = deriveMoLiveDataGovernanceTyped(null, nowMs, todayYyyymmdd);
		return `${base}\n${formatMoLiveGovernanceSnapshotOnly(gov)}\nnote: 尚無快照；行情由排程寫入 D1，/report 不會即時抓外部來源。`;
	}
	const gov = deriveMoLiveDataGovernanceTyped(read.row, nowMs, todayYyyymmdd);
	const v2 = parseMoLivePayloadSummaryV2(read.row.payload_summary);
	if (v2 !== null) {
		return formatMoLiveGovernanceStatusBlock(read.row, gov);
	}
	let block = formatMoLiveMarketStatusBlock(read.row, {});
	if (isMoLiveSnapshotStale(read.row.created_at, nowMs)) {
		block = `${block}\nstale: yes（快照偏舊，僅供參考）`;
	}
	return `${block}\n${formatMoLiveGovernanceStatusBlock(read.row, gov)}`;
}

async function buildMoStatusState(env: Env, userId: string): Promise<MoStatusState> {
	const [lastPushBlock, decisionBlock, reportBlock, liveMarketBlock] = await Promise.all([
		formatLastPushStatusBlock(env, userId),
		formatLastStrategyDecisionStatusBlock(env, userId),
		formatLastReportSummaryStatusBlock(env, userId),
		buildMoLiveMarketStatusBlock(env),
	]);
	return { lastPushBlock, decisionBlock, reportBlock, liveMarketBlock };
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

${formatSection("Report", params.state.reportBlock)}

${formatSection("Live market", params.state.liveMarketBlock)}`;
	// safeguard: 避免標題被意外多出字元（例如 eMO Status）
	return statusText.replace(/^eMO Status/u, "MO Status");
}

async function buildMoStatusReplyText(env: Env, userId: string): Promise<string> {
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

/** 與 dev-check 共用之 MO Report 組字（決策導向、無 debug dump） */
function buildMoReportText(params: {
	displayDate: string;
	dataSource: string;
	marketStatusLine: string;
	systemDecisionLine: string;
	actionLine: string;
	notesLine?: string;
}): string {
	return moReportComposeFullText(params);
}

function buildMarketStatusText(
	cycle: "success" | "waiting_data" | "partial" | "fetch_failed"
): string {
	return moReportMarketLine(cycle);
}

function buildSystemDecisionText(
	strategy: "aggressive" | "balanced" | "conservative",
	score: number,
	hasAdequateData: boolean,
	recReason: string
): string {
	return moReportSystemDecision(strategy, score, hasAdequateData, recReason);
}

function buildActionText(score: number): string {
	return moReportActionLine(score);
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

	const demoOverride =
		params.allowDemoOverride ? await readStrategyReviewDemoOverride(params.env) : null;
	const snapshot =
		params.source === "real" ? await computeStrategyCurrentSnapshotFromRealData({
			env: params.env,
			userId: params.userId,
			activeConfig: a,
		}) : null;

	const out = computeStrategyComparePure(a, c, params.source, {
		demoOverride,
		snapshot,
	});
	const {
		compareDecision,
		compareReason,
		compareSummary,
		activeScore,
		candidateScore,
		scoreDelta,
		changedFields,
		diffs,
		reviewConfidence: reviewConfidence,
	} = out;
	const isBalancedMinScoreOnlyDiff = diffs.length === 1 && diffs[0] === "balancedMinScore";
	const balancedMinScoreDelta = c.balancedMinScore - a.balancedMinScore;
	const isSafeRealPromoteBalancedMinScoreOnly =
		params.source === "real" &&
		demoOverride === null &&
		isBalancedMinScoreOnlyDiff &&
		balancedMinScoreDelta >= 10;
	const isStrongReal =
		snapshot !== null &&
		snapshot.status === "active" &&
		snapshot.dataFreshnessScore >= 80 &&
		snapshot.dataVolumeScore >= 80 &&
		snapshot.simulationReadyScore >= 80;
	const isSafeBalancedMinScoreOnlyReal =
		params.source === "real" &&
		isBalancedMinScoreOnlyDiff &&
		balancedMinScoreDelta >= 5 &&
		snapshot !== null &&
		snapshot.status === "active" &&
		snapshot.dataFreshnessScore >= 80 &&
		snapshot.dataVolumeScore >= 80 &&
		snapshot.simulationReadyScore >= 60;

	if (isSafeRealPromoteBalancedMinScoreOnly) {
		console.log("[strategy] real promote condition matched", {
			field: "balancedMinScore",
			delta: balancedMinScoreDelta,
			compareDecision,
		});
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

type MoLiveCycleStatus = "success" | "partial" | "fetch_failed" | "waiting_data";

type MoLiveCycleResult = {
	ok: boolean;
	tradeDate: string;
	source: string;
	fetched: boolean;
	dbWrite: boolean;
	cycleStatus: MoLiveCycleStatus;
	note: string;
};

function truncateUtf16ForMoLive(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…(truncated)`;
}

async function ensureMoLiveMarketSnapshotsTable(env: Env): Promise<void> {
	await env.MO_DB.prepare(
		`CREATE TABLE IF NOT EXISTS mo_live_market_snapshots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			trade_date TEXT NOT NULL,
			source TEXT NOT NULL,
			payload_summary TEXT NOT NULL,
			raw_payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`
	).run();
}

async function executeMoLiveDataCycle(env: Env): Promise<MoLiveCycleResult> {
	const source = MO_LIVE_SOURCE_TWSE_MI_INDEX;
	try {
		await ensureMoLiveMarketSnapshotsTable(env);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			tradeDate: "",
			source,
			fetched: false,
			dbWrite: false,
			cycleStatus: "fetch_failed",
			note: `d1 schema: ${message}`,
		};
	}

	let jsonSeen = false;
	let lastNote = "";
	let tradeDate = "";
	let parsed: unknown = null;
	let rawText = "";
	let fetched = false;

	const forceTwseFailForTest = env.MO_FORCE_TWSE_FAIL_FOR_TEST === "1";
	if (forceTwseFailForTest) {
		console.log("[mo-live] twse forced fail for test");
		lastNote = "MO_FORCE_TWSE_FAIL_FOR_TEST=1";
	} else {
		for (let i = 0; i < 14; i++) {
			const td = getTaipeiYYYYMMDDMinusDaysFromToday(i);
			const url =
				`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${td}&selectType=MS&response=json`;
			try {
				const res = await fetch(url, {
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; MO-vNext/1.0)",
					},
				});
				if (!res.ok) {
					lastNote = `http ${String(res.status)} for ${td}`;
					continue;
				}
				const text = await res.text();
				rawText = text;
				let j: unknown;
				try {
					j = JSON.parse(text) as unknown;
				} catch {
					lastNote = `json parse failed for ${td}`;
					continue;
				}
				jsonSeen = true;
				if (isTwseMiIndexPayloadOk(j)) {
					tradeDate = td;
					parsed = j;
					fetched = true;
					break;
				}
				lastNote = `stat not OK or empty tables for ${td}`;
			} catch (err: unknown) {
				lastNote = err instanceof Error ? err.message : String(err);
			}
		}
	}

	if (fetched && parsed !== null) {
		const legacySummary = summarizeTwseMiIndexPayload(parsed);
		const payloadSummaryObj: MoLiveSummaryV2 = {
			v: 2,
			source,
			sourceLevel: "primary",
			fetchStatus: "success",
			confidence: "high",
			rawAvailabilityNote:
				"TWSE MI_INDEX（afterTrading MS）完整 JSON；與證交所公開格式一致。",
			legacySummary,
		};
		const payloadSummary = JSON.stringify(payloadSummaryObj);
		const createdAt = new Date().toISOString();
		const rawStore = truncateUtf16ForMoLive(rawText, 12000);
		console.log("[mo-live] twse success", { tradeDate });
		let dbWrite = false;
		let dbNote = "";
		try {
			await env.MO_DB
				.prepare(
					`INSERT INTO mo_live_market_snapshots (trade_date, source, payload_summary, raw_payload, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.bind(tradeDate, source, payloadSummary, rawStore, createdAt)
				.run();
			dbWrite = true;
		} catch (err: unknown) {
			dbNote = err instanceof Error ? err.message : String(err);
		}

		const cycleStatus = deriveMoLiveCycleStatus(true, dbWrite);
		const ok = cycleStatus === "success" || cycleStatus === "partial";
		const note = dbWrite ? "TWSE MI_INDEX fetched and stored" : `fetch ok; db: ${dbNote}`;
		return {
			ok,
			tradeDate,
			source,
			fetched: true,
			dbWrite,
			cycleStatus,
			note,
		};
	}

	if (!forceTwseFailForTest) {
		console.log("[mo-live] twse fail", { lastNote: lastNote || "no MI_INDEX in lookback" });
	}
	const fin = await tryFinMindTaiexDaily(env);
	if (fin.ok) {
		const finSource = MO_LIVE_SOURCE_FINMIND_TAIEX;
		const payloadSummaryObj: MoLiveSummaryV2 = {
			v: 2,
			source: finSource,
			sourceLevel: "fallback1",
			fetchStatus: "fallback_used",
			confidence: "medium",
			rawAvailabilityNote:
				"FinMind TaiwanStockPrice（data_id=TAIEX）僅含加權指數日線，非 TWSE MI_INDEX 全表；欄位較少。",
			legacySummary: fin.legacySummary,
		};
		const payloadSummary = JSON.stringify(payloadSummaryObj);
		const createdAt = new Date().toISOString();
		const rawStore = truncateUtf16ForMoLive(fin.rawText, 12000);
		console.log("[mo-live] finmind fallback success", { tradeDate: fin.tradeDateYyyymmdd });
		let dbWrite = false;
		let dbNote = "";
		try {
			await env.MO_DB
				.prepare(
					`INSERT INTO mo_live_market_snapshots (trade_date, source, payload_summary, raw_payload, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.bind(fin.tradeDateYyyymmdd, finSource, payloadSummary, rawStore, createdAt)
				.run();
			dbWrite = true;
		} catch (err: unknown) {
			dbNote = err instanceof Error ? err.message : String(err);
		}
		const cycleStatus = deriveMoLiveCycleStatus(true, dbWrite);
		const ok = cycleStatus === "success" || cycleStatus === "partial";
		const note =
			dbWrite ? "FinMind TAIEX daily fallback stored" : `finmind ok; db: ${dbNote}`;
		return {
			ok,
			tradeDate: fin.tradeDateYyyymmdd,
			source: finSource,
			fetched: true,
			dbWrite,
			cycleStatus,
			note,
		};
	}

	console.log("[mo-live] finmind fallback fail", { note: fin.note });
	const off = await tryTwseOpenApiMiIndexWeighted(env);
	if (off.ok) {
		const offSource = MO_LIVE_SOURCE_TWSE_OPENAPI_MI_INDEX;
		const payloadSummaryObj: MoLiveSummaryV2 = {
			v: 2,
			source: offSource,
			sourceLevel: "fallback2",
			fetchStatus: "fallback_used",
			confidence: "low",
			rawAvailabilityNote:
				"TWSE 官方 Open API（openapi.twse.com.tw）v1 exchangeReport/MI_INDEX；UTF-8 JSON 陣列；僅取「發行量加權股價指數」收盤指數；與 rwd MI_INDEX 主路徑表格式不同。",
			legacySummary: off.legacySummary,
		};
		const payloadSummary = JSON.stringify(payloadSummaryObj);
		const createdAt = new Date().toISOString();
		const rawStore = truncateUtf16ForMoLive(off.rawText, 12000);
		console.log("[mo-live] official fallback success", { tradeDate: off.tradeDateYyyymmdd });
		let dbWrite = false;
		let dbNote = "";
		try {
			await env.MO_DB
				.prepare(
					`INSERT INTO mo_live_market_snapshots (trade_date, source, payload_summary, raw_payload, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.bind(off.tradeDateYyyymmdd, offSource, payloadSummary, rawStore, createdAt)
				.run();
			dbWrite = true;
		} catch (err: unknown) {
			dbNote = err instanceof Error ? err.message : String(err);
		}
		const cycleStatus = deriveMoLiveCycleStatus(true, dbWrite);
		const ok = cycleStatus === "success" || cycleStatus === "partial";
		const note =
			dbWrite ?
				"TWSE OpenAPI MI_INDEX fallback stored"
			:	`official ok; db: ${dbNote}`;
		return {
			ok,
			tradeDate: off.tradeDateYyyymmdd,
			source: offSource,
			fetched: true,
			dbWrite,
			cycleStatus,
			note,
		};
	}

	console.log("[mo-live] official fallback fail", { note: off.note });
	const combinedNote = `twse: ${lastNote || "no MI_INDEX in lookback"}; finmind: ${fin.note}; official: ${off.note}`;
	const asOfTd = getTaipeiYYYYMMDDMinusDaysFromToday(0);
	const unavailPayload: MoLiveSummaryV2 = {
		v: 2,
		source: MO_LIVE_SOURCE_UNAVAILABLE,
		sourceLevel: "fallback2",
		fetchStatus: "unavailable",
		confidence: "low",
		rawAvailabilityNote: `三層皆失敗（TWSE rwd、FinMind、TWSE Open API）。${combinedNote}`,
		legacySummary: combinedNote,
	};
	const payloadSummaryUnavail = JSON.stringify(unavailPayload);
	const createdAtUnavail = new Date().toISOString();
	const rawStoreUnavail = truncateUtf16ForMoLive(
		JSON.stringify({
			twse: lastNote || "no MI_INDEX in lookback",
			finmind: fin.note,
			official: off.note,
		}),
		12000
	);
	let dbWriteUnavail = false;
	let dbNoteUnavail = "";
	try {
		await env.MO_DB
			.prepare(
				`INSERT INTO mo_live_market_snapshots (trade_date, source, payload_summary, raw_payload, created_at)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.bind(
				asOfTd,
				MO_LIVE_SOURCE_UNAVAILABLE,
				payloadSummaryUnavail,
				rawStoreUnavail,
				createdAtUnavail
			)
			.run();
		dbWriteUnavail = true;
	} catch (err: unknown) {
		dbNoteUnavail = err instanceof Error ? err.message : String(err);
	}
	const noTrading = jsonSeen;
	const cycleStatus: MoLiveCycleStatus =
		dbWriteUnavail ? "partial"
		: noTrading ? "waiting_data"
		: "fetch_failed";
	return {
		ok: false,
		tradeDate: asOfTd,
		source: MO_LIVE_SOURCE_UNAVAILABLE,
		fetched: false,
		dbWrite: dbWriteUnavail,
		cycleStatus,
		note:
			dbWriteUnavail ?
				`all sources failed; unavailable snapshot stored`
			:	`all sources failed; db: ${dbNoteUnavail}; ${combinedNote}`,
	};
}


async function computeMoPushEvaluationForUser(
	env: Env,
	userId: string,
	isReportTestChange: boolean
): Promise<{
	s: SystemStatus;
	hasUserId: boolean;
	totalNotesNum: number;
	latestNoteMs: number | null;
	score: number;
	strategyFinal: "aggressive" | "balanced" | "conservative";
	strategyFromScore: "aggressive" | "balanced" | "conservative";
	recReason: string;
	recStatus: "active" | "idle";
	recAction: string;
	noteCountForRec: number;
	simResult: string;
	simReady: string;
	marketStatusLine: string;
	displayDate: string;
	dataSource: string;
	hasAdequateData: boolean;
	systemDecisionLine: string;
	actionLine: string;
	moMessage: string;
	fingerprint: string;
	currentPromoteKey: string;
	strategyPromotedFrom?: string;
	strategyPromotedTo?: string;
	evaluation: MoPushEvaluationResult;
	snapshotTimeIso: string;
	prevTrimForReport: string;
	reportChanged: boolean;
	reportPreviousStrategy: string;
	activeStrategyConfig: StrategyActiveConfig;
	auditBeforeEvaluate: MoPushAuditRecord | null;
	liveSnapshotMissing: boolean;
	liveSnapshotStale: boolean;
	liveDataGovernance: MoLiveDataGovernance;
	liveMarketIntelligenceV1: MoLiveMarketIntelligenceV1;
	liveMarketPushEligible: boolean;
}> {
	const s = await getSystemStatus(env, userId);
	const hasUserId = userId.trim() !== "";
	const totalNotesNum = s.noteCount === "error" ? 0 : s.noteCount;
	let latestNoteMs: number | null = null;
	if (hasUserId) {
		try {
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
				if (Number.isFinite(ts)) {
					const t = new Date(ts).getTime();
					if (Number.isFinite(t)) {
						latestNoteMs = ts;
					}
				}
			}
		} catch {
			latestNoteMs = null;
		}
	}

	const activeStrategyConfigResult = await readActiveStrategyConfig(env);
	const activeStrategyConfig = activeStrategyConfigResult.config;
	const freshnessIdleThresholdMs = activeStrategyConfig.freshnessIdleThresholdMs;

	const deltaMs =
		latestNoteMs === null ? Number.POSITIVE_INFINITY : Date.now() - latestNoteMs;
	const dataFreshnessScore =
		latestNoteMs === null || deltaMs >= freshnessIdleThresholdMs ?
			0
		:	Math.round((1 - deltaMs / freshnessIdleThresholdMs) * 100);
	const dataVolumeScore = Math.round(Math.min(1, totalNotesNum / 10) * 100);
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

	let prevTrimForReport = "";
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
		}
	}

	const noteCountForRec = s.noteCount === "error" ? 0 : s.noteCount;
	const simReady = noteCountForRec > 0 ? "yes" : "no";
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

	const todayYyyymmddLive = getTaipeiYYYYMMDDMinusDaysFromToday(0);
	const liveRead = await readLatestMoLiveMarketSnapshot(env);
	const nowMsLive = Date.now();
	let marketStatusLine: string;
	let liveSnapshotMissing = false;
	let liveSnapshotStale = false;
	let liveDataGovernance: MoLiveDataGovernance;
	if (liveRead.kind === "error") {
		liveDataGovernance = deriveMoLiveDataGovernanceTyped(null, nowMsLive, todayYyyymmddLive);
		marketStatusLine = `${buildMarketStatusText("fetch_failed")}\n\n【資料品質】${buildMoReportDataQualityNote(liveDataGovernance)}`;
	} else if (liveRead.row === null) {
		liveSnapshotMissing = true;
		liveDataGovernance = deriveMoLiveDataGovernanceTyped(null, nowMsLive, todayYyyymmddLive);
		marketStatusLine = buildMarketStatusLineWithGovernance(
			getMoLiveReportCycleFromGovernance(liveDataGovernance),
			liveDataGovernance
		);
	} else {
		liveDataGovernance = deriveMoLiveDataGovernanceTyped(
			liveRead.row,
			nowMsLive,
			todayYyyymmddLive
		);
		liveSnapshotStale =
			liveDataGovernance.stalenessLevel === "stale" ||
			liveDataGovernance.stalenessLevel === "too_old";
		marketStatusLine = buildMarketStatusLineWithGovernance(
			getMoLiveReportCycleFromGovernance(liveDataGovernance),
			liveDataGovernance
		);
	}
	const liveMarketPushEligible = liveDataGovernance.pushEligible;
	const liveMarketIntelligenceV1 = deriveLiveMarketIntelligenceV1(
		liveDataGovernance,
		{
			rowIsNull: liveRead.kind !== "ok" || liveRead.row === null,
			noteCountForRec,
			todayYyyymmdd: todayYyyymmddLive,
		}
	) as MoLiveMarketIntelligenceV1;
	const displayDate =
		liveRead.kind === "ok" && liveRead.row !== null ?
			formatDisplayDateFromYyyymmdd(liveRead.row.trade_date)
		:	formatDisplayDateFromYyyymmdd(getTaipeiYYYYMMDDMinusDaysFromToday(0));
	const dataSource =
		liveRead.kind === "error" ? "—"
		: liveRead.row !== null ? liveRead.row.source
		: "—（無快照）";
	const hasAdequateData = totalNotesNum > 0;
	const systemDecisionLine = buildSystemDecisionLineLiveIntelligence(
		strategyFinal,
		score,
		hasAdequateData,
		recReason,
		liveMarketIntelligenceV1
	);
	const forcedActionLine = (env.MO_FORCE_REPORT_ACTION_LINE ?? "").trim();
	const actionLine =
		forcedActionLine !== "" ?
			forcedActionLine
		:	buildActionLineLiveIntelligence(score, liveMarketIntelligenceV1);
	const audit = await readMoPushAudit(env, userId);
	const strategyReview = await readStrategyReviewState(env);
	let currentPromoteKey = "";
	let promotedFrom: string | undefined;
	let promotedTo: string | undefined;
	if (
		strategyReview !== null &&
		strategyReview.reviewStatus === "promoted" &&
		strategyReview.promotedFrom !== undefined &&
		strategyReview.promotedTo !== undefined &&
		strategyReview.promotedFrom !== "" &&
		strategyReview.promotedTo !== ""
	) {
		currentPromoteKey = `${strategyReview.promotedFrom}|${strategyReview.promotedTo}`;
		promotedFrom = strategyReview.promotedFrom;
		promotedTo = strategyReview.promotedTo;
	}
	const gate = await readStrategyNotifyGateFromKv(env, userId);
	const nowMs = Date.now();
	const gatePriority =
		gate !== null && gate.lastNotifyPriority !== undefined ?
			gate.lastNotifyPriority
		:	3;
	const evaluation = evaluateMoPushEventDecision({
		displayDate,
		marketLine: marketStatusLine,
		actionLine,
		currentPromoteKey,
		promotedFrom,
		promotedTo,
		lastEvaluatedMarketLine: audit === null ? null : audit.lastEvaluatedMarketLine,
		lastEvaluatedActionLine: audit === null ? null : audit.lastEvaluatedActionLine,
		lastEvaluatedPromoteKey: audit === null ? null : audit.lastEvaluatedPromoteKey,
		lastPushedFingerprint: audit === null ? null : audit.lastPushedFingerprint,
		gateMessage: gate === null ? null : gate.lastNotifyMessage,
		gateAtMs: gate === null ? null : gate.lastNotifyAt,
		gatePriority,
		nowMs,
		cooldownMsDefault: STRATEGY_NOTIFY_COOLDOWN_MS,
		cooldownMsP3Only: MO_PUSH_COOLDOWN_MS_P3_ONLY,
		liveMarketPushEligible,
	});
	if (
		!evaluation.shouldNotify &&
		evaluation.pushReason === "blocked_by_data_usability"
	) {
		console.log("[mo-push] skipped: live data not push-eligible", {
			dataUsability: liveDataGovernance.dataUsability,
			stalenessLevel: liveDataGovernance.stalenessLevel,
		});
	}
	const moMessage = evaluation.mergedMessage;
	const fingerprint = evaluation.fingerprint;
	const snapshotTimeIso = new Date().toISOString();

	let reportPreviousStrategy = "none";
	let reportChanged = false;
	if (hasUserId) {
		const prevTrim = prevTrimForReport;
		const previousDisplay = prevTrim === "" ? "none" : prevTrim;
		const changed: "yes" | "no" =
			testForceChangedFromEmptyPrevious && prevTrim === "" ? "yes" :
				prevTrim !== "" && prevTrim !== strategyFinal ? "yes" : "no";
		reportPreviousStrategy = previousDisplay;
		reportChanged = changed === "yes";
	}

	return {
		s,
		hasUserId,
		totalNotesNum,
		latestNoteMs,
		score,
		strategyFinal,
		strategyFromScore,
		recReason,
		recStatus,
		recAction,
		noteCountForRec,
		simResult,
		simReady,
		marketStatusLine,
		displayDate,
		dataSource,
		hasAdequateData,
		systemDecisionLine,
		actionLine,
		moMessage,
		fingerprint,
		currentPromoteKey,
		strategyPromotedFrom: promotedFrom,
		strategyPromotedTo: promotedTo,
		evaluation,
		snapshotTimeIso,
		prevTrimForReport,
		reportChanged,
		reportPreviousStrategy,
		activeStrategyConfig,
		auditBeforeEvaluate: audit,
		liveSnapshotMissing,
		liveSnapshotStale,
		liveDataGovernance,
		liveMarketIntelligenceV1,
		liveMarketPushEligible,
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
		const snapshotForReview =
			candidateCfg === null ? null : await computeStrategyCurrentSnapshotFromRealData({
				env,
				userId,
				activeConfig: activeCfg.config,
			});
		const computedPreview =
			candidateCfg === null ?
				null
			:	computeStrategyComparePure(activeCfg.config, candidateCfg, "real", {
					demoOverride: null,
					snapshot: snapshotForReview,
				});
		const currentCandidateVersion = candidateCfg === null ? "" : candidateCfg.configVersion;
		const shouldComputeOnDemand =
			existingResult === null ||
			existingResult.comparedAt.trim() === "" ||
			existingResult.compareReason === "review result not ready" ||
			computedPreview === null ||
			shouldRefreshStrategyReviewKv(
				existingResult,
				activeCfg.config.configVersion,
				currentCandidateVersion,
				computedPreview
			) ||
			computedPreview.activeScore === 0 ||
			computedPreview.candidateScore === 0;
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
			!shouldComputeOnDemand && existingResult !== null && computedPreview !== null ?
				{
					comparedAt: existingResult.comparedAt,
					compareDecision: computedPreview.compareDecision,
					compareReason: computedPreview.compareReason,
					finalDecision:
						computedPreview.compareDecision === "promote_candidate" ? "promote_candidate"
						: computedPreview.compareDecision === "keep_active" ? "keep_active"
						: "hold_review",
					reviewResult: {
						activeScore: computedPreview.activeScore,
						candidateScore: computedPreview.candidateScore,
						delta: computedPreview.scoreDelta,
						changedFields: computedPreview.changedFields,
						reason: computedPreview.compareReason,
						decision: computedPreview.compareDecision,
						confidence: computedPreview.reviewConfidence,
					},
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

		const nowMs = Date.now();

		const blocked = (params: {
			decision: StrategyCompareDecision;
			delta: number;
			changedFieldsText: string;
			reason: string;
			confidence: "high" | "medium";
		}): string => {
			console.log("[strategy] auto promote run blocked", {
				decision: params.decision,
				delta: params.delta,
				changedFields: params.changedFieldsText,
				reason: params.reason,
				confidence: params.confidence,
			});
			return `MO Strategy Auto Promote Run

result: blocked
decision: ${params.decision}
delta: ${params.delta}
changedFields: ${params.changedFieldsText}
reason: ${params.reason}
confidence: ${params.confidence}
auto promote blocked: review decision is not promote_candidate
decisionSource: ${decisionSource}
at: ${at}`;
		};

		if (candidate === null) {
			return blocked({
				decision: "hold_review",
				delta: 0,
				changedFieldsText: "none",
				reason: "candidate config not found",
				confidence: "medium",
			});
		}

		let rr = reviewResult;
		let snapshot = await computeStrategyCurrentSnapshotFromRealData({
			env,
			userId,
			activeConfig: active.config,
		});
		let computed = computeStrategyComparePure(active.config, candidate, "real", {
			demoOverride: null,
			snapshot,
		});

		if (
			rr === null ||
			shouldRefreshStrategyReviewKv(
				rr,
				active.config.configVersion,
				candidate.configVersion,
				computed
			)
		) {
			await runStrategyReview({ env, userId, source: "real", allowDemoOverride: false });
			rr = await readStrategyReviewResult(env);
			snapshot = await computeStrategyCurrentSnapshotFromRealData({
				env,
				userId,
				activeConfig: active.config,
			});
			computed = computeStrategyComparePure(active.config, candidate, "real", {
				demoOverride: null,
				snapshot,
			});
		}

		const decision = computed.compareDecision;
		const delta = computed.scoreDelta;
		const changedFields = computed.changedFields;
		const reason = computed.compareReason;
		const confidence = computed.reviewConfidence;
		const changedFieldsText = changedFields.length === 0 ? "none" : changedFields.join(", ");

		const guardState: {
			lastDecision?: StrategyCompareDecision;
			confirmCount: number;
			lastPromoteAt?: number;
		} = {
			confirmCount: promoteGuard?.confirmCount ?? 0,
			...(promoteGuard?.lastDecision !== undefined ?
				{ lastDecision: promoteGuard.lastDecision }
			:	{}),
			...(typeof promoteGuard?.lastPromoteAt === "number" ?
				{ lastPromoteAt: promoteGuard.lastPromoteAt }
			:	{}),
		};

		const ap = evaluateAutoPromoteCore(guardState, decision, nowMs);
		const confirmCount = ap.confirmCount;
		const cooldownRemainingMs = ap.cooldownRemainingMs;
		const cooldownRemainingMin = Math.ceil(cooldownRemainingMs / 60000);

		const persistGuard = async (): Promise<void> => {
			await writeStrategyAutoPromoteGuard(env, {
				lastDecision: ap.nextState.lastDecision,
				confirmCount: ap.nextState.confirmCount,
				...(typeof ap.nextState.lastPromoteAt === "number" ?
					{ lastPromoteAt: ap.nextState.lastPromoteAt }
				:	{}),
			});
		};

		if (ap.result === "no_action") {
			await persistGuard();
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
		if (ap.result === "blocked") {
			await persistGuard();
			return blocked({ decision, delta, changedFieldsText, reason, confidence });
		}
		if (ap.result === "guarded") {
			await persistGuard();
			if (cooldownRemainingMs > 0) {
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

		console.log("[strategy] auto promote run conditions matched", {
			delta,
			changedFields,
			compareDecision: rr?.compareDecision ?? "none",
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
		await persistGuard();

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
		return await buildMoStatusReplyText(env, userId);
	  }
	  case "/report-test-change":
	  case "/report": {
		const isReportTestChange = command === "/report-test-change";
		const ctx = await computeMoPushEvaluationForUser(env, userId, isReportTestChange);
		const hasUserId = ctx.hasUserId;
		const totalNotesNum = ctx.totalNotesNum;
		const score = ctx.score;
		const strategyFinal = ctx.strategyFinal;
		const strategyFromScore = ctx.strategyFromScore;
		const recStatus = ctx.recStatus;
		const recReason = ctx.recReason;
		const noteCountForRec = ctx.noteCountForRec;
		const simResult = ctx.simResult;
		const simReady = ctx.simReady;
		const activeStrategyConfig = ctx.activeStrategyConfig;

		console.log("[strategy] score result", {
			score,
			strategy: strategyFromScore,
			aggressiveMinScore: activeStrategyConfig.aggressiveMinScore,
			balancedMinScore: activeStrategyConfig.balancedMinScore,
		});
		console.log("[report] final strategy selected", {
			userId,
			fromScore: strategyFromScore,
			final: strategyFinal,
			reportTestChange: isReportTestChange,
		});

		let strategyNotifyPushBody: string | null = ctx.evaluation.shouldNotify ?
			ctx.moMessage
		:	null;
		let reportPreviousStrategy = ctx.reportPreviousStrategy;
		let reportChanged = ctx.reportChanged;
		const reportShouldNotify = ctx.evaluation.shouldNotify;

		if (hasUserId) {
			const strategyKey = `strategy:${userId}`;
			await env.MO_NOTES.put(strategyKey, strategyFinal);
			const shouldNotifyStrategy: "yes" | "no" = ctx.reportChanged ? "yes" : "no";
			const strategyDecision: StrategyDecisionRecord = {
				changed: ctx.reportChanged,
				shouldNotify: shouldNotifyStrategy === "yes",
				hasMessage: strategyNotifyPushBody !== null,
				timestamp: formatStatusPushAtTaipei(new Date()),
			};
			await recordStrategyDecision(env, userId, strategyDecision);
		}

		const lastFpPersist: string | null =
			ctx.auditBeforeEvaluate === null ? null : ctx.auditBeforeEvaluate.lastPushedFingerprint;

		const reportEvaluatedSnapshot = {
			marketLine: ctx.marketStatusLine,
			actionLine: ctx.actionLine,
			promoteKey: ctx.currentPromoteKey,
		};
		const reportAuditOpts = {
			previousAudit: ctx.auditBeforeEvaluate,
			lastEvaluatedSnapshot: reportEvaluatedSnapshot,
		};

		if (hasUserId && userId !== "unknown-user") {
			if (!ctx.evaluation.shouldNotify) {
				console.log("[notify] skipped: mo_push_decision", {
					userId,
					result: ctx.evaluation.pushResult,
				});
				await recordMoPushAudit(
					env,
					userId,
					moPushAuditFromEvaluation(ctx.evaluation, {
						dryRun: false,
						lastPushedFingerprint: lastFpPersist,
						snapshotTimeIso: ctx.snapshotTimeIso,
						messagePreview: ctx.moMessage,
						...reportAuditOpts,
					})
				);
			} else if (strategyNotifyPushBody === null) {
				console.log("[notify] skipped: hasMessage=false", { userId });
			} else {
				const notifyBody = strategyNotifyPushBody;
				const lockSlot = await acquireStrategyNotifyLock(env, userId);
				if (lockSlot === null) {
					console.log("[notify] skipped: in_progress", { userId });
					await recordStrategyNotifyOutcomeForStatus(env, userId, "in_progress", "");
					const inProg: MoPushEvaluationResult = {
						shouldNotify: false,
						triggeredEvents: [],
						primaryPushType: null,
						pushPriority: null,
						pushReason: "parallel_notify_lock_active",
						pushResult: "skipped_in_progress",
						pushMessage: ctx.moMessage,
						mergedMessage: ctx.moMessage,
						cooldownRemainingMs: null,
						fingerprint: ctx.fingerprint,
						comparedState: ctx.evaluation.comparedState,
						moPushDataGate: undefined,
					};
					await recordMoPushAudit(
						env,
						userId,
						moPushAuditFromEvaluation(inProg, {
							dryRun: false,
							lastPushedFingerprint: lastFpPersist,
							snapshotTimeIso: ctx.snapshotTimeIso,
							messagePreview: ctx.moMessage,
							lastPushTypeOverride: "none",
							...reportAuditOpts,
						})
					);
				} else {
					console.log("[notify] lock acquired", { userId });
					try {
						const gate = await readStrategyNotifyGateFromKv(env, userId);
						const nowMs = Date.now();
						const gatePriIn =
							gate !== null && gate.lastNotifyPriority !== undefined ?
								gate.lastNotifyPriority
							:	3;
						const evalInLock = evaluateMoPushEventDecision({
							displayDate: ctx.displayDate,
							marketLine: ctx.marketStatusLine,
							actionLine: ctx.actionLine,
							currentPromoteKey: ctx.currentPromoteKey,
							promotedFrom: ctx.strategyPromotedFrom,
							promotedTo: ctx.strategyPromotedTo,
							lastEvaluatedMarketLine:
								ctx.auditBeforeEvaluate === null ?
									null
								:	ctx.auditBeforeEvaluate.lastEvaluatedMarketLine,
							lastEvaluatedActionLine:
								ctx.auditBeforeEvaluate === null ?
									null
								:	ctx.auditBeforeEvaluate.lastEvaluatedActionLine,
							lastEvaluatedPromoteKey:
								ctx.auditBeforeEvaluate === null ?
									null
								:	ctx.auditBeforeEvaluate.lastEvaluatedPromoteKey,
							lastPushedFingerprint: lastFpPersist,
							gateMessage: gate === null ? null : gate.lastNotifyMessage,
							gateAtMs: gate === null ? null : gate.lastNotifyAt,
							gatePriority: gatePriIn,
							nowMs,
							cooldownMsDefault: STRATEGY_NOTIFY_COOLDOWN_MS,
							cooldownMsP3Only: MO_PUSH_COOLDOWN_MS_P3_ONLY,
							liveMarketPushEligible: ctx.liveMarketPushEligible,
						});
						if (!evalInLock.shouldNotify) {
							console.log("[notify] skipped: mo_push_recheck", evalInLock.pushResult);
							await recordMoPushAudit(
								env,
								userId,
								moPushAuditFromEvaluation(evalInLock, {
									dryRun: false,
									lastPushedFingerprint: lastFpPersist,
									snapshotTimeIso: ctx.snapshotTimeIso,
									messagePreview: ctx.moMessage,
									...reportAuditOpts,
								})
							);
							if (evalInLock.pushResult === "skipped_cooldown") {
								const remaining = evalInLock.cooldownRemainingMs ?? 0;
								await recordStrategyNotifyOutcomeForStatus(
									env,
									userId,
									"cooldown",
									`remainingMs=${String(remaining)}`
								);
							} else {
								await recordStrategyNotifyOutcomeForStatus(
									env,
									userId,
									"duplicate_message",
									evalInLock.pushReason
								);
							}
						} else {
							console.log("[notify] start", { userId });
							const pri = evalInLock.pushPriority ?? 3;
							await recordStrategyNotifyGateAttempt(
								env,
								userId,
								notifyBody,
								nowMs,
								pri
							);
							const notifyPush = await lineBotPushTextMessage(env, userId, notifyBody);
							await recordLinePushOutcomeForStatus(env, userId, notifyPush);
							const ns = linePushOutcomeToStrategyNotifyStatus(notifyPush);
							await recordStrategyNotifyOutcomeForStatus(
								env,
								userId,
								ns.lastNotifyResult,
								ns.lastNotifyReason
							);
							if (notifyPush.result === "success") {
								await recordMoPushAudit(
									env,
									userId,
									moPushAuditFromEvaluation(evalInLock, {
										dryRun: false,
										lastPushedFingerprint: evalInLock.fingerprint,
										snapshotTimeIso: ctx.snapshotTimeIso,
										messagePreview: evalInLock.mergedMessage,
										lastPushResultOverride: "line_success",
										...reportAuditOpts,
									})
								);
							} else {
								const lineLabel =
									notifyPush.result === "skipped" ? "line_skipped_reply_only"
									: notifyPush.result === "blocked_by_monthly_limit" ? "line_blocked_quota"
									: notifyPush.result === "failed" ? "line_failed"
									: "line_network_error";
								await recordMoPushAudit(
									env,
									userId,
									moPushAuditFromEvaluation(evalInLock, {
										dryRun: false,
										lastPushedFingerprint: lastFpPersist,
										snapshotTimeIso: ctx.snapshotTimeIso,
										messagePreview: evalInLock.mergedMessage,
										lastPushResultOverride: lineLabel,
										...reportAuditOpts,
									})
								);
							}
							switch (notifyPush.result) {
								case "skipped":
									console.log("[notify] skipped: reply_only_or_dry", { userId });
									break;
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
				reportDataQuality: ctx.liveMarketIntelligenceV1.marketDataQuality,
				recommendationReadiness: ctx.liveMarketIntelligenceV1.recommendationReadiness,
				simulationReadiness: ctx.liveMarketIntelligenceV1.simulationReadiness,
				recommendationGateReason: ctx.liveMarketIntelligenceV1.recommendationGateReason,
				simulationGateReason: ctx.liveMarketIntelligenceV1.simulationGateReason,
			};
			await recordLastReportSummary(env, userId, summary);
		}

		let dataQualityLine = buildMoReportDataQualityNote(ctx.liveDataGovernance);
		if (ctx.liveSnapshotMissing) {
			dataQualityLine = `${dataQualityLine}\n（尚無 D1 快照；行情由排程寫入，非本指令即時抓取。）`;
		} else if (ctx.liveSnapshotStale) {
			dataQualityLine = `${dataQualityLine}\n（快照時效偏弱，請以 staleness 為準。）`;
		}

		const marketSummaryLine = buildMoReportMarketSummarySection(
			ctx.liveMarketIntelligenceV1,
			ctx.liveDataGovernance,
			ctx.displayDate,
			ctx.dataSource
		);
		const simulationLine = buildSimulationStatusLineLiveIntelligence(
			simResult,
			simReady === "yes" ? "yes" : "no",
			noteCountForRec,
			ctx.liveMarketIntelligenceV1
		);

		return moReportComposeFullTextV1({
			displayDate: ctx.displayDate,
			dataSource: ctx.dataSource,
			dataQualityLine,
			marketSummaryLine,
			systemDecisionLine: ctx.systemDecisionLine,
			actionLine: ctx.actionLine,
			simulationLine,
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

async function buildMoPushPreviewJsonResponse(
	env: Env,
	userId: string,
	isReportTestChange: boolean
): Promise<Response> {
	try {
		const ctx = await computeMoPushEvaluationForUser(env, userId, isReportTestChange);
		const audit = ctx.auditBeforeEvaluate;
		const lastFp = audit === null ? null : audit.lastPushedFingerprint;
		const previewResult =
			ctx.evaluation.pushResult === "would_push" ? "dry_run_preview" : ctx.evaluation.pushResult;
		await recordMoPushAudit(
			env,
			userId,
			moPushAuditFromEvaluation(ctx.evaluation, {
				dryRun: true,
				lastPushedFingerprint: lastFp,
				snapshotTimeIso: ctx.snapshotTimeIso,
				messagePreview: ctx.moMessage,
				lastPushResultOverride: previewResult,
				previousAudit: audit,
			})
		);
		const primary =
			ctx.evaluation.primaryPushType === null ? "none" : ctx.evaluation.primaryPushType;
		const body = {
			ok: true,
			dryRun: true,
			shouldNotify: ctx.evaluation.shouldNotify,
			triggeredEvents: ctx.evaluation.triggeredEvents,
			primaryPushType: primary,
			pushPriority: ctx.evaluation.pushPriority,
			pushReason: ctx.evaluation.pushReason,
			pushResult: previewResult,
			cooldownRemainingMs: ctx.evaluation.cooldownRemainingMs,
			message: ctx.moMessage,
			mergedMessage: ctx.evaluation.mergedMessage,
			fingerprint: ctx.evaluation.fingerprint,
			comparedState: ctx.evaluation.comparedState,
			snapshotTime: ctx.snapshotTimeIso,
		};
		return new Response(JSON.stringify(body), {
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(
			JSON.stringify({ ok: false, dryRun: true, error: message }),
			{
				status: 500,
				headers: { "Content-Type": "application/json; charset=utf-8" },
			}
		);
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

		if (url.pathname === "/admin/status-preview" && request.method === "GET") {
			const uid = url.searchParams.get("userId") ?? "preview-user";
			try {
				const text = await buildMoStatusReplyText(env, uid);
				return new Response(text, {
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return new Response(`status preview error: ${message}`, {
					status: 500,
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			}
		}

		if (url.pathname === "/admin/report-preview" && request.method === "GET") {
			const uid = url.searchParams.get("userId") ?? "preview-user";
			const testChange = url.searchParams.get("testChange") === "1";
			try {
				const cmd = testChange ? "/report-test-change" : "/report";
				const text = await handleCommand(cmd, cmd, env, uid);
				return new Response(text, {
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return new Response(`report preview error: ${message}`, {
					status: 500,
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			}
		}

		if (url.pathname === "/admin/push-preview" && request.method === "GET") {
			const uid = url.searchParams.get("userId") ?? "preview-user";
			const testChange = url.searchParams.get("testChange") === "1";
			return await buildMoPushPreviewJsonResponse(env, uid, testChange);
		}

		if (url.pathname === "/admin/run" && request.method === "GET") {
			try {
				const result = await executeMoLiveDataCycle(env);
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return new Response(
					JSON.stringify({
						ok: false,
						tradeDate: "",
						source: MO_LIVE_SOURCE_TWSE_MI_INDEX,
						fetched: false,
						dbWrite: false,
						cycleStatus: "fetch_failed",
						note: message,
					}),
					{ status: 500, headers: { "Content-Type": "application/json" } }
				);
			}
		}

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
	async scheduled(
		_event: { readonly cron?: string },
		env: Env,
		ctx: ExecutionContext
	): Promise<void> {
		ctx.waitUntil(
			executeMoLiveDataCycle(env).then((r) => {
				console.log("[cron] mo_live", {
					ok: r.ok,
					cycleStatus: r.cycleStatus,
					dbWrite: r.dbWrite,
					note: r.note,
				});
			})
		);
	},
  };