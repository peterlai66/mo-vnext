# MO vNext Agent Rules

## Project
- This project is MO vNext
- Stack: Cloudflare Workers + TypeScript + LINE Bot
- Main runtime is Cloudflare Worker, not Node.js server
- Keep implementation deployable to Cloudflare Workers

## Code rules
- Do not use `any` unless explicitly approved
- Do not use `globalThis as any`
- Use native Cloudflare Worker types: `Request`, `Response`, `fetch`, `URL`
- Do not rename existing env variables without approval
- Do not change webhook route without approval
- Do not add packages unless explicitly requested
- Do not create extra files unless explicitly requested

## Editing rules
- Modify only the files explicitly requested
- Preserve existing working behavior unless the task requires changing it
- Prefer minimal changes over broad rewrites
- Keep code simple and easy to review

## Command system rules
- Keep command handling easy to extend
- Existing commands must not break when adding new commands
- Non-command text should keep current expected behavior unless requested otherwise

## Strategy validation rules
- 當修改 strategy 相關邏輯（包含 review / decision / auto promote / status readiness）後，必須先執行 `npm run dev:check`
- 回報結果時，需附上 `dev:check` 輸出摘要（至少包含 total / promote / hold / keep）
- `dev:check` 通過後才能進行 ship（可使用 `npm run ship:strategy`）

## Git rules
- **Commit message 必須使用中文**（標題與內文；建議繁體中文）
- 使用 **Conventional Commits**：`type` 為英文（`feat`、`fix`、`chore`、`refactor` 等），**說明為中文**，格式如 `feat(scope): 說明` 或 `chore: 說明`
- **英文僅用於 type**（必填）：`feat`、`fix`、`refactor`、`chore`、`docs`、`style`、`test` 等；**不可**將說明寫成英文
- **不可**使用英文撰寫整則 commit（標題／內文），**除非**是上述 type 關鍵字本身
- 若有內文，空一行接在標題後；內文以完整句子或條列說明變更緣由與內容
- 不要使用 `Body:` 這類標籤行
- **Cursor 協作**：修改程式後，代理應**主動建議**符合上述格式的中文 Conventional Commit（必要時含內文）；**使用者複製貼上**至 Git 即可，**不依賴** shell CLI 自動產生訊息
- **`npm run ac`**：使用固定模板 `chore: 自動提交（Cursor）`，確保可穩定執行、不會出現 empty message；若需語意化訊息，請以 Cursor 建議的內容**手動** `git commit` 或改寫後再提交

### 範例

```
feat(report): 新增 /report 指令（最小可用版本）

建立基礎報告輸出，包含 user 狀態與 notes 數量，
作為後續 report engine 與 AI 報告的基礎。
```

## Response rules
- When suggesting code changes, prefer production-safe implementation
- When unsure, do not invent architecture; extend the current structure