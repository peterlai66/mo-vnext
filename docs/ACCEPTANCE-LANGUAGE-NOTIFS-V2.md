# 本輪驗收證據：語言層清理 + Notifications v2

**取證環境（本地等價真實輸出）**

- **Backend**：`mo-backend` 以 `wrangler dev --port 8788` 執行（本機 PID 會變動，取證時以實際指令為準）。
- **證據檔目錄**：`docs/evidence-local-2026-03-29/`（`curl` 寫入之 JSON，可重現）。
- **Web 開發伺服器**：`mo-web` 可於 `VITE_MO_BACKEND_URL=http://127.0.0.1:8788 npm run dev -- --host 127.0.0.1 --port 5173` 啟動；`curl http://127.0.0.1:5173/` 可取得 SPA 載入殼（實際畫面需瀏覽器執行 JS 後由 `/api/*` 填內容）。

**Production 對照（同時刻取樣）**

- `https://mo-web.peterlai.workers.dev/api/today` 仍回傳**舊版** Stub 文案且**無** `data.display`／`recommendation.display`（見同目錄 `production-today.json`）。**部署更新前，不得以該 URL 作為本輪通過依據。**

---

## 1. Today（本地真實 `/api/today`）

**節錄**（來源：`evidence-local-2026-03-29/today.json`）

- **無「Stub」字樣**於 `market.summaryText`、`recommendation.headline`／`display.headlineZh`（本取樣為一般人話文案）。
- **建議標題不為空**：`recommendation.display.headlineZh` =「今日投資建議重點」。
- **畫面應使用之欄位**（Web 僅 bind `display`，不顯示 raw）：`recommendation.display.headlineZh`、`summaryZh`、`stanceLabelZh`、`confidenceLabelZh`；`data.display.tradeDateLabelZh`、`generatedAtTaipei`。
- **台灣時間**：`data.display.generatedAtTaipei` = `2026/03/29 18:24`（與 `generatedAt` ISO 對應）。
- **Raw 仍存於 JSON 供相容**（`recommendation.mode`、`recommendation.confidence`）；**Web 元件不渲染**（見 `mo-web/src/App.tsx` 僅讀 `display`）。

---

## 2. Report（本地真實 `/api/report-view`）

**節錄**（來源：`evidence-local-2026-03-29/report-view.json`）

- **無重複「MO Report」標題行**：JSON 僅 `titleZh: "今日報告"`，段落陣列不含獨立 `MO Report` 行。
- **無 `staleness` 英文字樣**、**無 `【行情資料語氣】` 段**（由 `sanitizeReportPlainForWeb` 字串級清理）。
- **無 `recommendationMode=`／`decisionEligible=` 等 ASCII key=value dump**（同 sanitizer）。
- **段落為分章敘述**（`【資料品質】`、`【建議】` 等），非單一內部 log；末段仍可能含業務詞「gate」等中文敘述，屬產品用語而非 enum dump。

---

## 3. Candidates

### 3a. HTTP（本地）：`GET /api/candidates`

**真實回傳**（`evidence-local-2026-03-29/candidates-http.json`）：

```json
{"ok":false,"generatedAt":"...","error":"etf_gate_not_ready","message":"gate=insufficient_data"}
```

- 代表在目前 **wrangler dev + 遠端資料** 下，ETF gate 未就緒時之**真實錯誤**；此時無法以 HTTP 展示成功 `display`。

### 3b. Builder（白盒／與 HTTP 成功路徑同源）

**真實輸出**（`evidence-local-2026-03-29/candidates-builder-success.json`，以 `mapEtfContextToCandidatesApiSuccess` + 測試用 pipeline 產生）：

- `data.display.decisionLabelZh`、`confidenceNarrativeZh` 為人話。
- `deltaExplain.pairs[].narrativeZh` 為人話摘要。
- **`data.display.generatedAtTaipei` 由後端填入**；Web `CandidatesSection` 僅顯示該欄位，**已移除**客端 `formatIsoToTaipeiReadable(generatedAt)`。

---

## 4. Notifications v2（本地真實 `/api/notifications`）

**節錄**（`evidence-local-2026-03-29/notifications.json`）

- 每筆含 **`changeType`**、**`isNew`**、**`timestampTaipei`**、**`isSummaryDigest`**。
- **`data.feedNoteZh`** 明示為**系統摘要整理（非即時事件通知）**。
- `title`／`summary` 為可讀中文；**摘要型**列可藉 `isSummaryDigest: true` 與 feed 說明區分於「事件」。

---

## 5. API 與首頁證據

| 項目 | 位置／指令 |
|------|------------|
| `/api/today` | `docs/evidence-local-2026-03-29/today.json` |
| `/api/candidates`（HTTP） | `docs/evidence-local-2026-03-29/candidates-http.json` |
| `/api/candidates`（builder 成功範例） | `docs/evidence-local-2026-03-29/candidates-builder-success.json` |
| `/api/notifications` | `docs/evidence-local-2026-03-29/notifications.json` |
| `/api/report-view` | `docs/evidence-local-2026-03-29/report-view.json` |
| 首頁 | 本地 `http://127.0.0.1:5173/`（`curl` 僅見 `index.html` 殼；**瀏覽器截圖需在本機手動截取**）。 |

---

## 6. 灰盒對照（同一案例鏈）

| 區塊 | Internal／Builder | API | Web 顯示 |
|------|-------------------|-----|----------|
| **Today** | `today-stub-builder` 填 `recommendation.display`、`data.display` | `GET /api/today` | `App.tsx`：`tradeDateLabel`、`rec-headline` 等僅 `*.display.*` |
| **Candidates** | `candidates-builder` 填 `display`、`narrativeZh`、`generatedAtTaipei` | `GET /api/candidates`（成功時同 builder 形） | `CandidatesSection`：`candidates-decision-human`、`pair` 敘述、`generatedAtTaipei` |
| **Report** | `handleCommand` → `sanitizeReportPlainForWeb` | `GET /api/report-view` | `ReportSection`：`titleZh`、`paragraphs`、`display.generatedAtTaipei` |
| **Notifications v2** | `notifications-builder` | `GET /api/notifications` | `NotificationsSection`：`feedNoteZh`、`changeType`、`isNew`、`isSummaryDigest` |

---

## 7. 本輪規格：完成／未完成對照

| 項目 | 狀態 | 說明 |
|------|------|------|
| Today 語言層 | **完成**（本地證據） | `today.json`：無 Stub 文案、有 display 人話、台灣時間欄位；**production 仍舊版** |
| Report 語言層 | **完成**（本地證據） | `report-view.json`：無 staleness／行情語氣／enum dump；**production 未驗** |
| Candidates 語言層 | **部分完成** | Builder 成功 JSON 完整；**本地 HTTP 目前為 gate 錯誤**，無法以同一環境展示成功 GET |
| Notifications v2 | **完成**（本地證據） | `notifications.json` 具 changeType／isNew／摘要註記 |
| 台灣時間顯示 | **完成**（本地證據） | Today／Report／Notifications 之 `*Taipei`；Candidates 成功體之 `display.generatedAtTaipei` |
| Production 驗證 | **未完成** | `production-today.json` 仍 Stub；需 **backend + mo-web** 重新部署後再以同 URL 取證 |

---

*本文件與 `docs/evidence-local-2026-03-29/*.json` 可一併附於驗收；若需瀏覽器畫面，請於部署後或使用本地 dev 時自行截圖並補入。*
