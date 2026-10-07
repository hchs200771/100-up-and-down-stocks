# 台股漲跌 100 盤後報告

每天收盤後，自動整理台股漲幅與跌幅前 100 名，由 AI 分族群找原因、判斷資金階段，
再疊上法人、集保大戶、董監設質、族群輪動等籌碼資料，產出一份盤後報告：
寄到信箱，同時發佈到 GitHub Pages。

網頁版：<https://hchs200771.github.io/100-up-and-down-stocks/>

## 報告內容

網頁版依建議閱讀順序分成下列分頁；信件版是同一份內容的靜態版本，沒有互動圖表，段落順序也不同（避免重點被 Gmail 截斷）。

- **🌐 國際情勢**：美股、亞股、原物料、匯率與信用利差
- **📊 市場總覽**：盤後總結，加上指數、成交量、法人買賣超、當沖比、散戶部位、融資與外資選擇權
- **⚖️ 指數貢獻**：指數漲跌是哪些個股與產業推的、誰在拖
- **🔥 上漲族群／🧊 下跌族群**：各族群的產業故事、資金階段（啟動／擴散／高潮／退潮）、進場評分與建議動作
- **🔄 族群輪動**：台股族群 RRG 相對輪動圖與象限異動警示
- **🏦 大戶籌碼**：集保大戶持股週增減，可切「背離」與「同向」兩種視角、200～1000 張門檻
- **🎯 操作建議**：把當日結論收斂成可介入、再觀察、避開三類
- **🧭 長線策略**：跳出當日波動的長線進出場想法
- **🏆 終極選股池**：所有訊號統合後的長線 10 檔＋短線 10 檔，附入選理由與進出場計畫

圖例（各種標記的意思）與 0–100 進場評分的算法，收在上漲／下跌族群分頁最上方的「本頁說明」，點開即可看。

另有獨立子頁 `cb-pledge.html`：董監設質＋可轉債（CB）公司派作價候選池，每週更新。

## 快速開始

需要 Node.js 20 以上，以及 [Codex CLI](https://github.com/openai/codex) 或 [Claude Code](https://claude.com/claude-code) 其中之一（已登入）。

```bash
npm install
cp .env.example .env.local   # 再把內容換成下面的變數
npm run report
```

`.env.local` 目前只需要一個變數：

```bash
# Google Apps Script webhook，用來寄信。沒設定時只產 HTML 預覽，不寄信
GAS_WEBHOOK_URL=https://script.google.com/macros/s/.../exec
```

`npm run report` 會自動選引擎：本機有 `codex` 就用 Codex，沒有就用 Claude Code。
要指定時用 `npm run report:codex` 或 `npm run report:claude`，也可以設 `DAILY_REPORT_ENGINE=codex|claude`。

## 每日流程

兩種引擎跑的是同一條五段流程，只差由哪個 AI CLI 驅動：

1. **fetch**：抓市場資料，寫入 `data/market-latest.json`（漲跌榜、全市場收盤、法人、當沖、注意／處置、家數、指數、微台散戶多空比）。
   同時平行抓國際行情、信用利差、融資與選擇權、指數貢獻、集保大戶、設質＋CB、族群 RRG。
2. **classify**：`score-report.ts` 先快照當日價格並更新族群記分板 `data/scorecard.json`；
   接著由 controller 把漲跌股切成族群任務，`refine-group-tasks.ts` 再用固定規則修正容易誤分的股票。
3. **research**：多個 worker 平行搜尋各族群最近兩天的新聞，寫出族群故事。
4. **finalize**：`build-analysis-skeleton.ts` 先機械合併結果、判定資金階段與評分骨架，
   finalizer 再補上產業判斷與盤後總結，寫入 `data/analysis-latest.json` 和 `data/memory/`。
5. **send**：產生終極選股池與 HTML 報告、寄信，最後執行 `publish-github-pages.sh` 部署網頁版。

輔助步驟失敗時只會記 warning、略過對應區塊，不會中斷整份報告。

### 斷點續跑

中途失敗時，可以從指定階段接回（Claude 版改用 `CLAUDE_REPORT_START_STAGE`）：

```bash
CODEX_REPORT_START_STAGE=research npm run report:codex
```

| 值 | 從哪裡開始 |
| --- | --- |
| `fetch` | 完整重跑（預設） |
| `classify` | 沿用市場資料，從切族群開始 |
| `research` | 沿用族群任務快照，重跑 worker 之後的步驟 |
| `finalize` | 沿用 worker 結果，只重組 `analysis-latest.json` |
| `send` | 只用現有分析產 HTML、寄信 |
| `publish` | 只部署 GitHub Pages |

只想看 HTML、不寄信也不部署時，加 `REPORT_DRY_RUN=1`（目前只有 Claude 版支援）。

### 模型與並行數

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `CODEX_CONTROLLER_MODEL` | `gpt-6.1-sol`（目前最強） | 切族群任務 |
| `CODEX_GROUP_WORKER_MODEL` | `gpt-5.6-luna` | 族群新聞研究 |
| `CODEX_FINALIZER_MODEL` | `gpt-5.6-sol` | 彙總與盤後總結 |
| `CODEX_GROUP_MAX_CONCURRENCY` | `10` | 同時跑幾個 worker |
| `CODEX_REFINE_GROUP_TASKS` | `1` | 設 `0` 停用固定規則修正 |
| `CLAUDE_CONTROLLER_MODEL` | `opus`（最新 Opus） | Claude 版的切族群任務 |
| `CLAUDE_GROUP_WORKER_MODEL` | `haiku` | Claude 版的族群研究 |
| `CLAUDE_REPORT_MAX_CONCURRENCY` | `10` | Claude 版同時跑幾個 worker |

## 常用指令

```bash
npm run report:fetch     # 只重抓市場資料
npx tsx scripts/backfill-missed-days.ts   # 補漏跑日的收盤價／融資／市場情緒（每日流程自動跑）
npm run report:score     # 只重算族群記分板（當日快照已存在會跳過）
npm run report:picks     # 只重算終極選股池
npm run backtest:picks   # 選股池分數校準＋前 5 名前瞻追蹤（輸出 data/stock-picks-backtest.json，每日流程自動跑）
npm run backtest:novel   # 新因子研究：日間／隔夜拆解、大盤殘差動能（需本機全市場歷史行情）
npm run themes:refresh   # 重抓題材新聞觀察
npm run report:send      # 用現有分析重產 HTML 並寄信
npx tsx scripts/send-report.ts data/analysis-latest.json --no-email   # 只產 HTML 預覽
npm run screen:cb        # 重跑董監設質＋CB 篩選
npm run positions        # 分析凱基期貨持倉（見下方）
```

## 執行方式：手動限定

目前不使用 launchd 或其他排程。請在互動式工作階段要求代理「執行每日任務」；代理會執行 `npm run report`、持續顯示各階段 log，並用 Notion connector 完成持有中部位的最新健檢。
舊的 launchd plist 留在 `scripts/launchd/` 僅供參考。執行 log 在 `data/logs/`。

## 資料檔

**進版控**（其他機器 clone 下來就有）：

- `data/taxonomy.json`：族群標準名稱與別名
- `data/sector-baskets.json`：RRG 固定族群籃子。改完一定要跑 `npx tsx scripts/verify-baskets.ts` 對帳代號
- `data/tdcc-history/`、`data/cb-pledge-history/`：集保與設質的週快照（官方只提供最新一週，要自己累積）
- `data/stock-picks-history/`：每日選股池快照
- `data/site/`：GitHub Pages 發佈內容，這個目錄有變動時才會觸發部署

**只在本機**（被 `.gitignore` 排除，換電腦不會跟著走）：

- `data/market-latest.json`、`data/analysis-latest.json`、`data/report-latest.html`：當日產物，每天覆蓋
- `data/price-history/`、`data/analysis-history/`、`data/scorecard.json`：記分板與回測用的歷史資料
- `data/memory/`：每日摘要，供 finalizer 比對連續幾天的族群變化
- `data/kgi-positions.json`、`data/position-analysis.json`：帳戶持倉，**絕不進版控**

歷史資料只存在跑報告的那台機器上，要備份請自行處理。

## 週資料

- **集保大戶**：資料日是週五，隔天才公布。`fetch-tdcc-holders.ts` 同一週重跑會跳過，
  所以每天跑也只有一次真的抓取。要回補歷史用 `scripts/backfill-tdcc-history.ts`（只補流動性前 N 檔）。
- **董監設質＋CB**：同一個 ISO 週內重跑，直接沿用上次結果。

## 持倉分析（選用）

凱基官方套件只支援 Windows／Linux，且限台灣 IP、平日 10:00–22:00 連線，所以分成兩段：

1. 在台灣的 Windows／Linux 主機執行 `scripts/kgi/fetch_kgi_positions.py`，產出 `data/kgi-positions.json`（安裝方式與環境變數見檔案開頭說明）。
2. 把檔案放到 Mac 的 `data/` 下，執行 `npm run positions`。

## 選股研究與回測

研究結果包含未改善策略、暫不採用與資料不足的實驗，供後續研究者查閱，避免重複測試或只保留成功案例。

| 研究 | 結論與範圍 | 紀錄 |
| --- | --- | --- |
| 全台股因子掃描（2026-10-03） | 17條固定規則；原研究沒有可靠打敗基準的新條件 | [結論](docs/wide-market-scan-conclusion.md)／[數字](docs/factor-experiments-wide-results.md) |
| 新因子研究（2026-10-05，10-07 補齊行情重跑） | 日間動能、隔夜反轉、組合與大盤殘差代理，持有2／5／20日；補齊行情後配對增益都接近零，不加入正式選股。毛利／總資產尚未測 | [研究判讀](docs/novel-factor-backtest-review.md)／[完整結果](docs/novel-factor-backtest-results.md)／[固定規則](docs/novel-factor-backtest-config.json) |
| 營收衰退放空（2026-10-07） | 單月 YoY ≤ −20% 下月平均跑輸母體 1.22%（t −5.6），前後段與 50M 門檻皆成立；加 MoM 連 3 月衰退更強；股價跌深後大致仍未反映；毛利率單獨很弱。已接入每日流程：子頁 `/revenue-decline.html`（附個股期貨），另有 `/revenue-industry.html` 看產業族群性 | [結論](docs/revenue-short-backtest.md) |
| 週三價平合風險溫度計（2026-10-05，10-07 前瞻檢查） | 2023–2025 高檔訊號有增量，但加盤中振幅控制後不顯著；2026 前瞻幾乎無增量。只當觀察，不用來減碼 | [研究判讀](docs/weekly-straddle-risk-review.md)／[2026 前瞻](docs/weekly-straddle-forward-results.md)／[OI 區間](docs/option-range-review.md) |

新因子的精簡數字快照保存在 [research/novel-factors/](research/novel-factors/)（依執行日期命名，10-05 為有行情缺口的首輪），隨專案提供；逐期持倉與原始行情在被忽略的 `data/backtest/`，換機後需另外準備。重跑方式與資料需求見研究判讀。「暫不採用」代表本次規格沒有足夠支持，並不代表所有版本都已被證明無效；尚未回測的項目另列資料缺口。

## 開發

```bash
npm test         # 單元測試（node:test）
npm run lint     # TypeScript 型別檢查
```

相關文件：

- `AGENTS.md`：給 AI 代理的任務對照（改分類、改 prompt、改報告格式要先看哪些檔）
- `docs/multifactor-roadmap.md`：多因子選股的回測與改版路線圖
- `scripts/prompts/`：controller、worker、finalizer 的 prompt
- `.claude/skills/`：Claude Code 手動流程（`daily-stock-report`）與維護說明（`stock-report-maintenance`）
- `docs/wide-market-scan-conclusion.md`：全台股因子掃描的結論（17 條規則、81 個窗口）
- [新因子研究判讀](docs/novel-factor-backtest-review.md)：包含沒有改善的結果、限制、尚未測的項目與重跑方式

## 舊版網頁 App

`src/`、`server.ts` 是專案最初從 Google AI Studio 建立的 React App，用 Gemini API 即時分析。
每日報告已不再使用它；要啟動的話，在 `.env.local` 設 `GEMINI_API_KEY` 後執行 `npm run dev`。
