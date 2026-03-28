"use strict";

/** MO live 資料可信度（與 Worker / dev-check 單一推導；規則集中於此） */

const MO_LIVE_GOV_FRESH_MS = 30 * 60 * 1000;
const MO_LIVE_GOV_AGING_MS = 2 * 60 * 60 * 1000;
const MO_LIVE_GOV_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * @param {string} yyyymmdd
 * @returns {number}
 */
function moLiveParseYyyymmddUtcMs(yyyymmdd) {
	const y = Number(yyyymmdd.slice(0, 4));
	const m = Number(yyyymmdd.slice(4, 6)) - 1;
	const d = Number(yyyymmdd.slice(6, 8));
	return Date.UTC(y, m, d);
}

/**
 * 交易日相對「今日」落後天數（非負表示 trade 在過去或未來；僅供分級）
 * @param {string} tradeYyyymmdd
 * @param {string} todayYyyymmdd
 */
function moLiveTradeDateLagDays(tradeYyyymmdd, todayYyyymmdd) {
	if (typeof tradeYyyymmdd !== "string" || !/^\d{8}$/.test(tradeYyyymmdd)) return 999;
	if (typeof todayYyyymmdd !== "string" || !/^\d{8}$/.test(todayYyyymmdd)) return 999;
	const tt = moLiveParseYyyymmddUtcMs(tradeYyyymmdd);
	const tn = moLiveParseYyyymmddUtcMs(todayYyyymmdd);
	return Math.round((tn - tt) / (24 * 60 * 60 * 1000));
}

/**
 * @param {number} ageMs
 * @returns {"fresh" | "aging" | "stale" | "too_old"}
 */
function moLiveStalenessFromAgeMs(ageMs) {
	if (!Number.isFinite(ageMs)) return "too_old";
	if (ageMs <= MO_LIVE_GOV_FRESH_MS) return "fresh";
	if (ageMs <= MO_LIVE_GOV_AGING_MS) return "aging";
	if (ageMs <= MO_LIVE_GOV_STALE_MS) return "stale";
	return "too_old";
}

/**
 * @param {number} lagDays
 */
function moLiveStalenessFromTradeLagDays(lagDays) {
	if (lagDays <= 0) return "fresh";
	if (lagDays <= 1) return "aging";
	if (lagDays <= 2) return "stale";
	return "too_old";
}

/**
 * @param {"fresh" | "aging" | "stale" | "too_old"} a
 * @param {"fresh" | "aging" | "stale" | "too_old"} b
 */
function moLiveMergeStalenessTier(a, b) {
	const order = ["fresh", "aging", "stale", "too_old"];
	const ia = order.indexOf(a);
	const ib = order.indexOf(b);
	return order[Math.max(ia, ib)];
}

/**
 * @param {string} raw
 * @returns {null | {
 *   v: number;
 *   source: string;
 *   sourceLevel: string;
 *   fetchStatus: string;
 *   confidence: string;
 *   rawAvailabilityNote: string;
 *   legacySummary: string;
 * }}
 */
function parseMoLiveV2PayloadSummaryForGov(raw) {
	if (typeof raw !== "string") return null;
	const t = raw.trim();
	if (!t.startsWith("{")) return null;
	try {
		const o = JSON.parse(t);
		if (typeof o !== "object" || o === null) return null;
		if (o.v !== 2) return null;
		if (typeof o.source !== "string") return null;
		if (
			o.sourceLevel !== "primary" &&
			o.sourceLevel !== "fallback1" &&
			o.sourceLevel !== "fallback2"
		) {
			return null;
		}
		if (
			o.fetchStatus !== "success" &&
			o.fetchStatus !== "fallback_used" &&
			o.fetchStatus !== "unavailable"
		) {
			return null;
		}
		if (
			o.confidence !== "high" &&
			o.confidence !== "medium" &&
			o.confidence !== "low"
		) {
			return null;
		}
		if (typeof o.rawAvailabilityNote !== "string") return null;
		if (typeof o.legacySummary !== "string") return null;
		return o;
	} catch {
		return null;
	}
}

/**
 * 單一入口：由 D1 列 + 現在時間推導可信度（不讀其他列；最新一筆 unavailable 仍明示不可用）。
 *
 * @param {{
 *   row: { trade_date: string; created_at: string; payload_summary: string } | null;
 *   nowMs: number;
 *   todayYyyymmdd: string;
 * }} p
 */
function deriveMoLiveDataGovernance(p) {
	const today = p.todayYyyymmdd;
	if (p.row === null) {
		return {
			tradeDate: "",
			source: "—",
			sourceLevel: "primary",
			fetchStatus: "unavailable",
			confidence: "low",
			rawAvailabilityNote: "無快照",
			legacySummary: "",
			dataUsability: "unusable",
			stalenessLevel: "too_old",
			freshnessMinutes: null,
			sourcePriority: 99,
			decisionEligible: false,
			pushEligible: false,
			displayFetchStatus: "unavailable",
			liveFreshness: "stale",
			v2: null,
		};
	}
	const row = p.row;
	const createdMs = Date.parse(row.created_at);
	const ageMs = Number.isFinite(createdMs) ? p.nowMs - createdMs : Number.POSITIVE_INFINITY;
	const freshnessMinutes = Number.isFinite(createdMs) ? Math.floor(ageMs / 60000) : null;
	const v2 = parseMoLiveV2PayloadSummaryForGov(row.payload_summary);
	const lagDays = moLiveTradeDateLagDays(row.trade_date, today);

	if (v2 === null) {
		const stalenessLevel = moLiveStalenessFromAgeMs(ageMs);
		const unusable = stalenessLevel === "too_old";
		return {
			tradeDate: row.trade_date,
			source: row.source,
			sourceLevel: "primary",
			fetchStatus: "success",
			confidence: "low",
			rawAvailabilityNote: "legacy payload_summary（非 v2 JSON）",
			legacySummary: row.payload_summary.slice(0, 200),
			dataUsability: unusable ? "unusable" : "display_only",
			stalenessLevel,
			freshnessMinutes,
			sourcePriority: 9,
			decisionEligible: false,
			pushEligible: false,
			displayFetchStatus: unusable ? "stale" : "success",
			liveFreshness: stalenessLevel === "fresh" ? "ok" : "stale",
			v2: null,
		};
	}

	const ageTier = moLiveStalenessFromAgeMs(ageMs);
	const lagTier = moLiveStalenessFromTradeLagDays(lagDays);
	let merged = moLiveMergeStalenessTier(ageTier, lagTier);
	if (v2.fetchStatus === "unavailable") {
		merged = "too_old";
	}
	const stalenessLevel = merged;

	const sourcePriority =
		v2.sourceLevel === "primary" ? 1
		: v2.sourceLevel === "fallback1" ? 2
		: v2.sourceLevel === "fallback2" ? 3
		: 9;

	let decisionEligible = false;
	if (stalenessLevel !== "too_old" && v2.fetchStatus !== "unavailable") {
		if (
			v2.sourceLevel === "primary" &&
			v2.fetchStatus === "success" &&
			lagDays <= 2
		) {
			decisionEligible = true;
		} else if (
			v2.sourceLevel === "fallback1" &&
			v2.fetchStatus === "fallback_used" &&
			(stalenessLevel === "fresh" || stalenessLevel === "aging") &&
			lagDays <= 1
		) {
			decisionEligible = true;
		}
		// fallback2：預設不提供 decision（僅顯示）；避免 OpenAPI 欄位少／日期落後誤判
	}

	let pushEligible = false;
	if (
		v2.sourceLevel === "primary" &&
		v2.fetchStatus === "success" &&
		stalenessLevel === "fresh" &&
		lagDays <= 0 &&
		ageMs <= MO_LIVE_GOV_FRESH_MS
	) {
		pushEligible = true;
	}

	let dataUsability = "display_only";
	if (v2.fetchStatus === "unavailable" || stalenessLevel === "too_old") {
		dataUsability = "unusable";
	} else if (pushEligible) {
		dataUsability = "push_ok";
	} else if (decisionEligible) {
		dataUsability = "decision_ok";
	} else {
		dataUsability = "display_only";
	}

	let displayFetchStatus = v2.fetchStatus;
	if (v2.fetchStatus === "unavailable") {
		displayFetchStatus = "unavailable";
	} else if (stalenessLevel === "stale" || stalenessLevel === "too_old") {
		displayFetchStatus = "stale";
	}

	let liveFreshness = "ok";
	if (stalenessLevel === "aging") {
		liveFreshness = "aging";
	}
	if (stalenessLevel === "stale" || stalenessLevel === "too_old") {
		liveFreshness = "stale";
	}

	return {
		tradeDate: row.trade_date,
		source: v2.source,
		sourceLevel: v2.sourceLevel,
		fetchStatus: v2.fetchStatus,
		confidence: v2.confidence,
		rawAvailabilityNote: v2.rawAvailabilityNote,
		legacySummary: v2.legacySummary,
		dataUsability,
		stalenessLevel,
		freshnessMinutes,
		sourcePriority,
		decisionEligible,
		pushEligible,
		displayFetchStatus,
		liveFreshness,
		v2,
	};
}

module.exports = {
	deriveMoLiveDataGovernance,
	MO_LIVE_GOV_FRESH_MS,
	MO_LIVE_GOV_AGING_MS,
	MO_LIVE_GOV_STALE_MS,
	moLiveTradeDateLagDays,
};
