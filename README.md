<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/5dd3b4df-4788-40bb-9fb0-054b9a54b4e1

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

---

## 盤後報告自動化（Claude Code Skill）

> 目前標準每日入口：`npm run report`（自動選引擎：`codex` 已安裝且登入時走 Codex parallel 版，否則走 Claude 版）。要指定引擎可用 `npm run report:codex` / `npm run report:claude`。
>
> 一般版與 parallel 版的「流程目標」相同：抓市場資料、完成族群分析、寫入 `data/analysis-latest.json`、更新 memory/history、產生 `data/report-latest.html`，並在有 `GAS_WEBHOOK_URL` 時寄信。差異在執行引擎：一般版走 Claude Code Skill 單一路徑；parallel 版走 Codex controller / worker / finalizer，並把族群 research 平行化。目前只採手動執行，不啟用 launchd 排程。

這個專案另外提供一個 Claude Code Skill `daily-stock-report`，取代原本的 Gemini API 流程，改由 Claude 本地分析、再透過 Google Apps Script webhook 寄信。

### 環境變數（`.env.local`）

```
GAS_WEBHOOK_URL=https://script.google.com/macros/s/.../exec
```

### 手動執行

**跑完整流程**（抓資料 → Claude 分析 → 寄信）：在 Claude Code 裡輸入：

```
/daily-stock-report
```

**只重抓市場資料**（不做分析）：

```bash
npx tsx scripts/fetch-market-data.ts
```
會寫入 `data/market-latest.json`。當日（Asia/Taipei）跑過後，Skill 會自動用這份快取，跳過重抓。

**只重寄信**（用現有的 `data/analysis-latest.json` 產 HTML + POST 到 GAS）：

```bash
npx tsx scripts/send-report.ts
```

**只產 HTML 預覽、不寄信**：

```bash
npx tsx scripts/send-report.ts data/analysis-latest.json --no-email
```
輸出在 `data/report-latest.html`。

**只重做 Claude 分析、不重抓 API**：在 Claude Code 裡叫 `/daily-stock-report`，只要 `data/market-latest.json` 的 mtime 還在今天，Skill 會自動用快取，只重跑分類/故事/總結。這條路徑適合迭代 prompt 或重寫 Skill 內容時驗證效果。

### 執行方式

目前每日任務只接受互動式手動觸發，不安裝或載入 launchd。手動執行時由代理持續監看 log，依 fetch、分類、研究、finalizer、HTML／發布等階段即時回報進度，並另外透過已連線的 Notion connector 完成持股健檢。

### 題材新聞觀察

每日報告會在抓取市場資料後讀取 [config/theme-radar.json](config/theme-radar.json) 的 RSS 與題材字典，將文章保存在 `data/theme-radar/articles.json`，並為交易日建立一次性快照。也可在已有 `data/market-latest.json` 時手動執行 `npm run themes:refresh`。更改題材關鍵字只影響往後快照，不回寫舊訊號。

訊號以最近 4 個**完整週**的題材提及占比，對比之前 12 週；至少需要 10 個基準週與 4 個近期週有文章。RSS 來源抓取失敗或回傳空白時，當日只保留診斷資料，不發加速訊號。選股頁只顯示「題材新聞觀察」，不因它加分或改變入選名單。

`npm run backtest:picks` 的輸出會在同一交易日內，分列有／無題材訊號的選股結果。需累積足夠跨日期樣本，再根據扣成本勝率與平均報酬決定是否調整選股規則。RSS 關鍵字與個股關聯是觀察假設，不代表該公司已產生對應題材營收。

### 檔案位置

- Skill 定義：`.claude/skills/daily-stock-report/SKILL.md`
- 排程 plist：`scripts/launchd/com.maxhuang.daily-stock-report.plist`
- launchd wrapper：`scripts/run-daily-report.sh`
- 市場資料（每日覆蓋）：`data/market-latest.json`
- 分析結果（每日覆蓋）：`data/analysis-latest.json`
- HTML 預覽：`data/report-latest.html`
- 歷史記憶（波段趨勢比對用）：`data/memory/YYYY-MM-DD.md`
- 執行 log：`data/logs/`

---

## 盤後報告自動化（Codex）

這是目前建議使用的每日報告入口。它與原本 Claude 流程產出的內容類型一致，但資料搜尋由 Codex 自己的 web search 完成，族群 research 會平行 fan-out 到多個 worker，再由 finalizer 彙總。

### 新增檔案

- task controller prompt：`scripts/prompts/group-task-controller.md`
- group worker prompt：`scripts/prompts/group-research-worker.md`
- finalizer prompt：`scripts/prompts/group-finalizer.md`
- parallel worker runner：`scripts/run-codex-group-workers.sh`
- Codex 穩定入口：`scripts/run-daily-report-codex.sh`
- Codex pipeline：`scripts/run-daily-report-codex-parallel.sh`
- launchd plist：`scripts/launchd/com.maxhuang.daily-stock-report-codex.plist`

### 手動執行

先確認本機 `codex` 已安裝並完成登入，然後執行：

```bash
npm run report
```

等同於：

```bash
npm run report:codex
```

此專案的 `.codex/config.toml` 也設定了 Codex CLI status line，會顯示模型、目錄、分支、context 剩餘量、5 小時額度與每週額度。重新進入此專案的 Codex CLI session 後生效；互動中可用 `/status` 看完整用量，或用 `/statusline` 調整欄位。

這個 wrapper 會：

1. 先抓 `market-latest.json`（含三大法人、當沖比重、注意/處置、breadth、加權/櫃買指數、微臺散戶多空比）
2. 執行 `npx tsx scripts/score-report.ts` 快照當日價格與前日分析、更新 `data/scorecard.json`（族群歷史勝率記分板）
3. 用 `codex exec -m gpt-5.6-terra` 切出族群 task
4. 用本地規則修正高風險誤分族群，例如低軌衛星、記憶體與矽晶圓拆分
5. 用多個 `codex exec -m gpt-5.6-luna` worker 平行做最近 2 天新聞 research
6. 再用 `codex exec -m gpt-5.6-terra` 做 finalizer，寫入 `analysis-latest.json` / memory；finalizer 可參考 `data/scorecard.json` 判斷族群歷史強弱
7. 最後由 shell 端寄信或產 HTML 預覽；報告含市場儀表板（breadth、法人動向）與族群信心度/退潮 badge

補充：

- wrapper 會自動載入 `.env.local`，所以直接執行 `npm run report:codex` 也能吃到 `GAS_WEBHOOK_URL`
- 每次從 `fetch` / `classify` 起跑時，會先清空 `data/tmp/group-results/`，避免舊 research 結果混進今天報告
- task controller 成功後，wrapper 會自動備份一份 `data/tmp/group-tasks-backup/`，worker 與 finalizer 都以這份 snapshot 為準，避免中途 task 被覆寫
- 若某個 `codex exec` 非零退出，但 task / analysis 檔已實際產出，wrapper 會優先以檔案存在與否決定是否繼續，而不是立刻整串失敗
- `scripts/refine-group-tasks.ts` 會在 task controller 後自動執行，用 deterministic overrides 把已知容易誤分的股票拆出來，例如 `華通(2313)` 優先放到低軌衛星/HDI 高階 PCB，記憶體模組/控制 IC 不和矽晶圓混在一起

### 調整並行數

預設一次開 `10` 個 worker。若遇到速率限制，可在執行前調低：

```bash
CODEX_GROUP_MAX_CONCURRENCY=6 npm run report:codex
```

### 調整模型與成本

預設模型：

- task controller：`gpt-5.6-terra`
- group research worker：`gpt-5.6-luna`
- finalizer：`gpt-5.6-terra`

需要時可用環境變數覆蓋：

```bash
CODEX_CONTROLLER_MODEL=gpt-5.6-terra CODEX_GROUP_WORKER_MODEL=gpt-5.6-luna CODEX_FINALIZER_MODEL=gpt-5.6-terra npm run report:codex
```

若要停用本地族群修正步驟：

```bash
CODEX_REFINE_GROUP_TASKS=0 npm run report:codex
```

### 斷點續跑

若中途中斷，可用 `CODEX_REPORT_START_STAGE` 從指定階段接回：

```bash
CODEX_REPORT_START_STAGE=research npm run report:codex
CODEX_REPORT_START_STAGE=finalize npm run report:codex
CODEX_REPORT_START_STAGE=send npm run report:codex
```

可用值：

- `fetch`：完整重跑全部流程（預設）
- `classify`：跳過抓市場資料，從族群切 task 開始
- `research`：沿用 `group-tasks-backup`，重跑 worker / finalizer / send
- `finalize`：沿用 snapshot 與現有 results，直接重組 `analysis-latest.json`
- `send`：只用現有 `analysis-latest.json` 產 HTML 並寄信
- `publish`：只跑部署步驟，執行 `scripts/publish-github-pages.sh` 部署到 GitHub Pages（https://hchs200771.github.io/100-up-and-down-stocks/）

### 手動限定

目前不使用 launchd 或其他排程。請在互動式工作階段要求代理「執行每日任務」；代理會執行 `npm run report`、持續顯示各階段 log，並用 Notion connector 完成持有中部位的最新健檢。

### 手動更新記分板

只重算 scorecard（不重跑報告）：

```bash
npm run report:score
```

冪等：若當日快照已存在會跳過，直接重算 `data/scorecard.json`。

選股池的分數校準可執行：

```bash
npm run backtest:picks
```

它會用 `stock-picks-history` 對照 `price-history`，以訊號後下一交易日收盤作為可執行的進場價，輸出持有 1 / 5 / 20 日的絕對與全市場等權超額報酬到 `data/stock-picks-backtest.json`。至少累積 20 個可觀測進場日後，再用這份結果調整權重。

### 退潮警訊（retreatSignal）

`data/analysis-latest.json` 的族群記錄可包含 `retreatSignal` 欄位，finalizer 用來標記「昨強今弱」或連跌訊號。報告的族群 badge 會反映此狀態。

### 檔案位置（Codex 版新增）

- 族群分類/歷史積分：`data/taxonomy.json`（進版控）
- 族群每日價格快照：`data/price-history/YYYY-MM-DD.json`
- 每日分析快照：`data/analysis-history/YYYY-MM-DD.json`
- 族群勝率記分板：`data/scorecard.json`

### 注意

- Codex 版本依賴本機 `codex` CLI 與登入狀態
- 族群搜尋與分析都由 Codex CLI 自行完成，不使用 `Gemini API`
- 若未設定 `GAS_WEBHOOK_URL`，流程會退回只產 `data/report-latest.html`
