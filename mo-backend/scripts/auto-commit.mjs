#!/usr/bin/env node
/**
 * 讀取目前 git staged diff（git diff --cached），呼叫 OpenAI 產生
 * 中文 Conventional Commit；僅將訊息寫入 stdout，供
 * `... | xargs git commit -m` 使用。
 * 無 staged 變更時不寫 stdout、exit 1（建議搭配 GNU `xargs -r`）。
 */
import { execSync } from "node:child_process";
import process from "node:process";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY || OPENAI_API_KEY.trim() === "") {
	console.error("auto-commit: 缺少環境變數 OPENAI_API_KEY");
	process.exit(1);
}

let diffText;
try {
	diffText = execSync("git diff --cached", {
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
} catch {
	console.error("auto-commit: 無法讀取 git diff --cached");
	process.exit(1);
}

if (!diffText.trim()) {
	console.error("auto-commit: 沒有 staged 變更，略過 commit");
	process.exit(1);
}

/**
 * 與「修錯誤、防呆、錯誤處理、HTTP/狀態判斷」高度相關的 diff 訊號。
 * 命中時 type 不應為 feat（避免「多加了分支／型別」就被當成新功能）。
 * @type {readonly RegExp[]}
 */
const COMMIT_FIX_DIFF_SIGNALS = [
	/\b429\b/,
	/\btimeout\b/i,
	/\bretry\b/i,
	/\bfallback\b/i,
	/\bsafeguard\b/i,
	/\bguard\b/i,
	/monthly\s+limit/i,
	/response\.ok/,
	/blocked_by_monthly/,
	/network_error/,
	/You have reached your monthly limit/,
	/錯誤處理|防呆|避免誤判|月額度|修正行為|修復/,
	/catch\s*\(\s*error\s*:\s*unknown/,
	/\[push\]\s*failed/i,
	/\[push\]\s*blocked/i,
];

/**
 * 明確「新增使用者可感知能力」的訊號（僅在**未**命中 fix 訊號時，才支持判為 feat）。
 * @type {readonly RegExp[]}
 */
const COMMIT_FEAT_DIFF_SIGNALS = [
	/^\+.*case\s+"\/[^"]+"/m,
	/^\+.*extractCommand\(/m,
];

/**
 * @param {string} diff
 * @returns {'fix' | 'feat' | null}
 */
function inferCommitTypeHintFromDiff(diff) {
	const fixHit = COMMIT_FIX_DIFF_SIGNALS.some((re) => re.test(diff));
	if (fixHit) return "fix";
	const featHit = COMMIT_FEAT_DIFF_SIGNALS.some((re) => re.test(diff));
	if (featHit) return "feat";
	return null;
}

/**
 * 模型偶爾將「修 bug／防呆／HTTP 處理」判成 feat；依 diff 訊號覆寫 type，其餘不動。
 * @param {string} line
 * @param {string} diff
 */
function applyCommitTypeOverride(line, diff) {
	const m = line.match(/^(feat|fix|chore|refactor|docs|test)(\([^)]*\))?:/u);
	if (!m) return line;
	const current = m[1];
	const hint = inferCommitTypeHintFromDiff(diff);

	if (hint === "fix") {
		if (current === "feat" || current === "refactor") {
			return line.replace(new RegExp(`^${current}\\b`, "u"), "fix");
		}
		if (current === "chore" && /^\+\+\+ b\/src\//m.test(diff)) {
			return line.replace(/^chore\b/u, "fix");
		}
		return line;
	}

	if (hint === "feat" && (current === "chore" || current === "refactor")) {
		return line.replace(new RegExp(`^${current}\\b`, "u"), "feat");
	}

	return line;
}

const systemPrompt = `你是 Git commit 訊息產生器。請根據提供的 git diff 產生**一則** Conventional Commit 訊息。

規則（必須遵守）：
- 全程使用繁體中文（僅 type 關鍵字可為英文）。
- 格式必須為單行：type(scope): 中文標題
- type 只能從以下擇一：feat、fix、chore、refactor、docs、test
- scope 請依變更檔案／功能推斷（小寫英文單字，例如 report、note、status、bot、line、scripts）
- 若無法判斷 scope，使用 general
- 標題簡短描述變更重點；可選在標題後加全形逗號與極短補充，仍須保持**同一行**、**不要換行**
- 不要 markdown、不要代碼區塊、不要編號列表
- 不要輸出英文句子（type 與 scope 除外）
- 只輸出這一行 commit message，前後不要空白行或說明文字

【type 判定優先序 — 必須遵守，且優先於「變更行數多寡」或「是否新增函式／型別」】
1) **fix**：修正既有錯誤行為；或為錯誤處理、防呆、fallback、retry、timeout、HTTP 狀態／status code（含 429）、safeguard／guard、避免誤判成功、與例外處理相關的邏輯調整。即使同時新增了型別、回傳值或分支，只要主軸是「讓錯誤被正確處理或呈現」，仍用 **fix**，不要用 feat。
2) **feat**：僅在**明確新增**使用者可感知的新功能、新指令、新入口、新 API 能力時使用（例如全新 slash command、全新對外路由）。微調既有流程的穩定性或正確性**不算** feat。
3) **refactor**：重構、命名整理、純結構調整，且**不改變**對外可觀察行為。
4) **chore**：建置、相依、設定、工具腳本等維運變更，且與產品 bug 修復無關。
5) **docs / test**：僅文件或僅測試。
6) 若同時像 feat 又像 fix，**一律選 fix**。
7) 不確定是否為「新功能」時，**不要**猜 feat；改用 fix、refactor 或 chore 中較符合者。`;

const userPrompt = `以下為 git diff --cached 內容，請產生 commit message：\n\n${diffText}`;

const response = await fetch("https://api.openai.com/v1/chat/completions", {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		Authorization: `Bearer ${OPENAI_API_KEY}`,
	},
	body: JSON.stringify({
		model: "gpt-4o-mini",
		temperature: 0.2,
		max_tokens: 200,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
	}),
});

if (!response.ok) {
	const errText = await response.text();
	console.error("auto-commit: OpenAI API 錯誤:", response.status, errText);
	process.exit(1);
}

/** @param {unknown} json */
function extractCommitMessage(json) {
	if (typeof json !== "object" || json === null) return null;
	if (!("choices" in json) || !Array.isArray(json.choices) || json.choices.length === 0) {
		return null;
	}
	const first = json.choices[0];
	if (typeof first !== "object" || first === null) return null;
	if (!("message" in first)) return null;
	const message = first.message;
	if (typeof message !== "object" || message === null) return null;
	if (!("content" in message) || typeof message.content !== "string") return null;
	return message.content.trim();
}

const rawJson = await response.json();
const raw = extractCommitMessage(rawJson);
if (!raw) {
	console.error("auto-commit: 無法解析模型回覆");
	process.exit(1);
}

let line = raw
	.replace(/^```[a-zA-Z]*\s*/u, "")
	.replace(/```$/u, "")
	.trim()
	.split(/\r?\n/u)
	.map((s) => s.trim())
	.filter((s) => s.length > 0)[0];

if (!line) {
	console.error("auto-commit: 模型回覆為空");
	process.exit(1);
}

line = applyCommitTypeOverride(line, diffText);

process.stdout.write(line);
