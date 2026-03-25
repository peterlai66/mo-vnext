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
- 只輸出這一行 commit message，前後不要空白行或說明文字`;

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

process.stdout.write(line);
