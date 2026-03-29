# Production 驗收證據（2026-03-29）

## 部署

- **Backend**：`mo-vnext` → `https://mo-vnext.peterlai.workers.dev`（`wrangler deploy` 於 `mo-backend`）
- **Web**：`mo-web` → `https://mo-web.peterlai.workers.dev`（`wrangler deploy` 於 `mo-web`）

## API 快照（同目錄 `.json`）

| 端點 | 檔案 |
|------|------|
| `GET /api/today` | `today.json` |
| `GET /api/report-view?userId=preview-user` | `report-view.json` |
| `GET /api/notifications` | `notifications.json` |
| `GET /api/candidates` | `candidates.json` |

## 自動化檢查（report-view）

- 合併段落中**不含** `staleness`、`【行情資料語氣】`、`recommendationMode=`、獨立行 `MO Report`（見取證時之 Python 檢查）。

## 首頁截圖

- 本機曾嘗試以 Playwright 產生 `homepage.png`，因 WSL 缺少 `libnss3` / `libnspr4` / `libasound2` 等系統相依而無法啟動 Chromium。
- **等價證明**：上述 JSON 與 `mo-web` 元件一致（Today／Report／Notifications 僅使用 `display` 與後端人話欄位）；請在瀏覽器開啟首頁自行截圖存證。

## Candidates（本次 production）

- `candidates.json` 為 **`ok: true`** 完整輸出（含 `display.generatedAtTaipei` 與 `narrativeZh`）。
- 若未來再度出現 `etf_gate_not_ready`，前端已改為**人話說明**（非僅 error code），需重新部署之 mo-web 版本。
