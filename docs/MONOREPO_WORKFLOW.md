# Monorepo 工作流程（mo-project root）

Git 與提交一律在 **專案根目錄** `mo-project` 操作；部署仍由 **子專案** 各自的 `npm run deploy` 執行（Cloudflare Wrangler）。

## 前置條件

- 在 `mo-project` 初始化或 clone 好 repo，且 **`git` 根目錄為 mo-project**（根目錄有 `.git`）。
- 執行一次檢查：

```bash
npm run doctor
```

## 常用指令（請固定在此目錄執行）

| 指令 | 說明 |
|------|------|
| `npm run doctor` | 檢查 `.git`、`mo-backend/package.json`、`mo-web/package.json`、root `package.json` |
| `npm run status` | 目前 branch、`git status`、工作區是否乾淨 |
| `npm run commit -- "type: 說明"` | **根目錄** `git add .` + `git commit`（**必須**提供 message） |
| `npm run push` | **根目錄** `git push` |
| `npm run deploy:backend` | 進入 `mo-backend` 執行 `npm run deploy` |
| `npm run deploy:web` | 進入 `mo-web` 執行 `npm run deploy` |
| `npm run deploy:all` | 先 backend，再 web |
| `npm run ship:backend -- "type: 說明"` | root 提交並 push 後，只部署 **backend** |
| `npm run ship:web -- "type: 說明"` | root 提交並 push 後，只部署 **web** |
| `npm run ship:all -- "type: 說明"` | root 提交並 push 後，**依序**部署 backend → web |

`commit` / `ship:*` 若**未**在 `--` 後提供訊息，腳本會**錯誤退出**。

## 與舊習慣的差異

- **不要**再在 `mo-backend` 內依賴舊的 `npm run ship` 當成「唯一」流程；整庫變更應在 **root** 提交。
- `mo-backend` / `mo-web` 內建 scripts **未改動**，仍可單獨在子目錄跑 `npm run dev`、`npm run deploy` 等。

## Shell 環境

腳本為 **bash**（Linux / WSL / macOS 皆可）。若 `npm run` 找不到 bash，請確認 `bash` 在 `PATH` 中。
