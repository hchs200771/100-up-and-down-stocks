---
name: daily-stock-report
description: 台股盤後分析工作流。抓當日漲跌幅前 100 名、用 Claude 本地分析做產業分類與盤後總結、寄信出去。取代原本使用 Gemini API 的流程。Trigger when user asks to run daily stock report, 跑台股盤後, 產生盤後報告, etc.
---

# Daily Stock Report Skill

這個 Skill 取代了 `src/services/aiService.ts` 裡原本呼叫 Gemini API 的邏輯。
AI 的工作（分類、族群故事、盤後總結）由 Claude 在對話裡直接完成，不呼叫任何 LLM API。

工作目錄：`/Users/max/Projects/100-up-and-down-stocks`

## 執行步驟

### Step 1 — 抓當日市場資料（可跳過）
執行：

```
npx tsx scripts/fetch-market-data.ts
```

輸出：`data/market-latest.json`，結構：

```json
{
  "gainers": [{"code","name","pct","close","amount","futures?"}, ...100 檔],
  "losers":  [...100 檔],
  "stockMap": {"2330": {"pct": "+2.00%", "futures": {...}}, ...},
  "timestamp": "2026/04/17",
  "tradingDate": "2026-04-17"
}
```

**假日行為**：TWSE / TPEX API 在非交易日會自動回傳最近一個交易日的資料，`tradingDate` 會是那個真正的交易日。**後續所有日期（memory 檔名、analysis.date）都要用 `tradingDate`，不要用系統今天的日期**，否則週末跑出來的檔名會錯。

如果這一步失敗（例如 API 掛掉），停止流程並告訴使用者。

### Step 2 — 讀取記憶

列出 `data/memory/` 下最近 **2 份** markdown（依檔名日期排序，最新的在前）。
如果資料夾不存在或沒檔案，跳過這步，summary 就不做歷史比較。

讀這 2 天是為了在 Step 5 判斷**波段趨勢**：哪些族群連續強勢、哪些今天才新進場、哪些昨強今弱出現反轉、哪些連跌 N 日後開始止跌。

### Step 3 — 產業分類（Claude 本地分析）

讀 `data/market-latest.json`，對 `gainers` 和 `losers` 各做一次分類。

只需要 `gainers`、`losers` 陣列（每筆只取 `code`、`name`、`pct`）、`tradingDate`、`timestamp`，**跳過 `stockMap`**（分類用不到）。建議用以下指令取出所需欄位：

```bash
npx tsx -e "
const d = JSON.parse(require('fs').readFileSync('data/market-latest.json','utf-8'));
console.log(JSON.stringify({tradingDate: d.tradingDate, timestamp: d.timestamp, gainers: d.gainers.map(({code,name,pct})=>({code,name,pct})), losers: d.losers.map(({code,name,pct})=>({code,name,pct}))}));
"
```

**分類原則：**

1. **以漲跌幅為主軸**：只要進前 100 名都納入考慮，不依成交金額排序或篩選。
2. **拒絕大雜燴**：使用最新、最細分的概念股名稱分類。例如不要只寫「電子」，要細分出「CPO 光通訊」、「CoWoS 設備」、「散熱」、「特化」、「IP 矽智財」、「車用二極體」等。例：昇達科放在「低軌衛星」比放在「網通與微波通訊」更適合。
3. **微型聚落**：即使該族群只有 2 檔股票（例如只有兩檔光學股），也要獨立成一個分類，不要丟進其他。
4. **禁止混淆**：禁止將「電源管理 IC」與「驅動 IC」混為一談。
5. **弱勢股單檔不成族群**：跌幅榜的單一股票分類可以保留（例如台積電獨立），但 Step 4 不為單檔弱勢股寫故事（見下）。

**輸出格式**：每一邊產出一個陣列 `[{category, stocks}]`，其中 `stocks` 陣列元素必須是 `股票名稱(四碼代號)`。

### Step 4 — 族群故事（平行 subagent，每個 category 約 300 字）

**執行方式：分兩階段，每階段都平行 spawn**

對每一個**兩檔以上**的分類，用 Agent tool（`subagent_type: Explore`）平行 spawn 一個 Haiku subagent 產故事。（請使用 model: Haiku，省 token）
上漲的族群，如果只有單檔，一律跳過，因為沒有族群性，不值得找故事。
下跌的族群，要 3 檔以上，才視為族群，因為我注重在上漲的族群。只有 1, 2 檔就不用找故事了。
另外，**弱勢股只需要挑成員數最多的前 3 個族群做第二階段 research**；其他弱勢族群直接沿用第一階段分類時的簡短盤面判讀，或留空即可，不要花時間再搜。

**兩階段流程（重要）：**

- **階段 A**：把所有**強勢（gainers）**的多檔分類，在**同一個 assistant message** 裡平行 spawn。等全部回來後，立刻寫一次 `data/analysis-latest.json`（此時 losers 可以先填空陣列或佔位），當成 checkpoint 存檔。這樣即使階段 B 失敗，漲的部分也已落地。
- **階段 B**：接著只把**弱勢（losers）成員數最多的前 3 個多檔分類**，在**另一個 assistant message** 裡平行 spawn。其餘弱勢分類直接保留第一階段簡述或空白。回來後再更新 `analysis-latest.json` 寫入 losers。
- 如果階段 B 因為 token、rate limit 或其他原因失敗，**losers 部分可以跳過**（losers 陣列維持空或佔位），直接進入 Step 5 用只有 gainers 的資料產出總結與寄信。優先確保 gainers 完整、報告能寄出。

**關鍵：每一階段所有 spawn 必須放在同一個 assistant message 裡**，才是真平行；序列呼叫會浪費時間，失去改這步的意義。

每個 subagent 拿到的 prompt 樣板：

```
你是資深台股產業分析師。為以下族群寫一段約 300 字的今日盤後故事。

族群名稱：<category>
族群成員（今日強勢/弱勢）：<stocks 列表，含代號>
今日交易日：<tradingDate>
漲/跌方向：<強勢 or 弱勢>

內容要求：
1. 目標長度 300 字，不是 100。內容要紮實，以資深產業分析師身分撰寫。
2. 用 WebSearch 找最近 2 天的台股相關新聞、法說會、月營收、外資評等、產業動態，作為撰寫依據。
3. 結構：先講產業層面催化劑（技術趨勢、供需、政策、同業財報），再講族群內代表股發生了什麼（營收、訂單、新聞）。
4. 若硬湊成同一族群但其實沒明顯產業共通性，就改談個股各自的月營收、財報、新聞、除權息、法人買賣超等，不要硬凹產業故事。
5. 開頭不要「XX 族群今日表現強/弱勢」這種套話，直接切入產業或個股。
6. 基於可查證的基本面與市場動態，避免過度臆測。

只回傳純故事文字，不要加標題、不要加 markdown 結構、不要引用來源。
```

**彙總：** 所有 subagent 回傳後，把各自的故事字串寫進對應 category 的 `story` 欄位。

**為什麼這樣做：**
- 真平行：wall-clock 時間約等於最慢那個 subagent（而非 N 個序列累加）
- 故事品質更好：每個 subagent 獨立 WebSearch，有真實新聞依據
- 主對話 context 乾淨：不會被 N 組搜尋結果污染

### Step 5 — 盤後總結（250 字內）

以資深台股操盤手的口吻寫 250 字內總結。**使用者以做多為主，重點放在強勢族群的波段機會。**

- **波段趨勢分析**：對比 Step 2 讀到的最近 2 天記憶，點名：
  - 哪些族群**連續 N 日**在強勢榜 → 主流，可順勢
  - 哪些是**今日新進場**的族群 → 需觀察是否只是一日行情
  - 哪些**昨強今弱**或反之 → 反轉訊號
- 觀察資金是否有明顯族群性
- 專業、犀利
- 給建議的資金比例與策略，不要太激進
- 弱勢族群著墨可少一些（只需點出是否拖累大盤），不用給做空建議

### Step 6 — 寫 analysis-latest.json

寫到 `data/analysis-latest.json`，結構要和 `scripts/send-report.ts` 期望的一致：

```json
{
  "timestamp": "<market-latest.json 的 timestamp>",
  "date": "<market-latest.json 的 tradingDate，格式 YYYY-MM-DD>",
  "gainers": [{"category", "stocks", "story"}, ...],
  "losers":  [{"category", "stocks", "story"}, ...],
  "summary": "..."
}
```

### Step 7 — 寄信（POST 到 GAS）

```
npx tsx scripts/send-report.ts
```

這個腳本會：讀 analysis-latest.json → 產 HTML → 寫 `data/report-latest.html` → 更新 `data/history.json` → POST 到 `GAS_WEBHOOK_URL` 寄信。

如果 `GAS_WEBHOOK_URL` 還沒設，會失敗。這時候改跑：

```
npx tsx scripts/send-report.ts data/analysis-latest.json --no-email
```

只產 HTML 預覽不寄信，並跟使用者說「GAS webhook 還沒設，已跳過寄信」。

### Step 8 — 寫記憶 markdown

寫到 `data/memory/<tradingDate>.md`（用實際交易日，不是今天）：

```markdown
---
date: YYYY-MM-DD
timestamp: <同 analysis>
---

## 盤後總結

<summary 原文>

## 強勢族群

- <category>: <檔數>檔 — <代表股 1, 2, 3>
- ...

## 弱勢族群

- <category>: <檔數>檔 — <代表股 1, 2, 3>
- ...
```

這份 markdown 是下一次執行 Skill 時的輸入（Step 2 會讀）。

## 結尾回報

跑完跟使用者簡短回報：
- 當日時間戳
- 漲最多 / 跌最多的股票
- 漲跌方各自分了幾個族群
- 是否已寄信（或為何沒寄）

## 需要注意的

- 所有檔案路徑用工作目錄相對路徑（`data/...`、`scripts/...`），不要寫絕對路徑
- `data/memory/` 資料夾如果不存在，自己 mkdir
- 本流程不應修改 `src/services/aiService.ts`（前端 UI 還在用它）
- 不需要 `GEMINI_API_KEY` 環境變數
