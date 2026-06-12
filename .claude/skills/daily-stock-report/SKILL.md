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

**分類完成後，寫 `data/tmp/classification.json`（這是後面組裝的唯一資料來源，故事文字不會再經過你的 output）：**

先 `rm -rf data/tmp/stories && mkdir -p data/tmp/stories`，再用 Write 寫：

```json
{
  "timestamp": "<market-latest.json 的 timestamp>",
  "date": "<tradingDate>",
  "gainers": [
    {"id": "g01", "category": "...", "stocks": ["名稱(代號)"], "story": ""},
    ...
  ],
  "losers": [
    {"id": "l01", "category": "...", "stocks": ["名稱(代號)"], "story": ""},
    ...
  ]
}
```

規則：
- 每個 group 給穩定 `id`：gainers 用 `g01`、`g02`…；losers 用 `l01`、`l02`…（subagent 會把故事寫到 `data/tmp/stories/<id>.txt`，script 靠 id 對回來）。
- **會 spawn subagent 的 group（見 Step 4 門檻）**：`story` 留 `""`，故事交給 subagent。
- **不 spawn 的 group**（gainers 2 檔、losers 非前 3 大、各方單檔）：你直接在這裡把 `story` 寫成一句 30–50 字的盤面判讀；真的不值得寫就留 `""`。
- `summary` 這裡先不寫，等 Step 5 再補。

### Step 4 — 族群故事（平行 subagent，subagent 直接寫檔）

**門檻（精簡後）：**
- 強勢（gainers）：**3 檔以上**才 spawn subagent 寫故事。2 檔族群不 spawn，用 Step 3 在 classification 裡寫的一句判讀帶過；單檔跳過。
- 弱勢（losers）：只挑**成員數最多、且 3 檔以上的前 3 個族群**做 research；其餘弱勢族群不 spawn，沿用 classification 裡的簡述或留空。

**subagent 設定：** 用 Agent tool，`subagent_type: "general-purpose"`、`model: "haiku"`。
（不要用 Explore——Explore 沒有 Write 工具，無法寫檔。）

**兩階段流程：**
- **階段 A**：所有符合門檻的**強勢**族群，在**同一個 assistant message** 裡平行 spawn。全部回來後跑一次 `npx tsx scripts/assemble-analysis.ts` 當 checkpoint（此時 losers 用 classification 的簡述/空白、summary 空）。
- **階段 B**：弱勢前 3 大族群，在**另一個 assistant message** 裡平行 spawn。
- 階段 B 若因 token / rate limit / 其他原因失敗，losers 直接沿用 classification 內容即可，不影響 gainers 與寄信。優先確保 gainers 完整、報告能寄出。

**關鍵：每一階段所有 spawn 必須放在同一個 assistant message 裡**，才是真平行。

每個 subagent 拿到的 prompt 樣板：

```
你是資深台股產業分析師。為以下族群寫一段約 300 字的今日盤後故事，並把結果「寫成檔案」。

族群 id：<id>
族群名稱：<category>
族群成員（今日強勢/弱勢）：<stocks 列表，含代號>
今日交易日：<tradingDate>
漲/跌方向：<強勢 or 弱勢>

內容要求：
1. 約 300 字，內容紮實，以資深產業分析師身分撰寫。
2. 用 WebSearch 找最近 2 天的新聞、法說會、月營收、外資評等、產業動態當依據；**最多 2 次 WebSearch**。查不到就用產業鏈邏輯與長線題材補足，不要硬湊新聞、也不要寫「查不到 / 沒有新聞」。
3. 結構：先講產業層面催化劑（技術趨勢、供需、政策、同業財報），再講族群內代表股發生了什麼。
4. 若硬湊成同一族群但其實沒明顯產業共通性，就改談個股各自的營收、財報、新聞、法人買賣超，不要硬凹產業故事。
5. 開頭不要「XX 族群今日表現強/弱勢」這種套話，直接切入產業或個股。
6. 基於可查證的基本面，避免過度臆測。
7. **全文一律使用台灣繁體中文與台灣金融慣用語**（例如「記憶體／半導體／晶圓／伺服器／報價／庫存」，不要寫成「内存／存储芯片／服务器／价格／库存」等簡體或中國用語）。

完成後用 Write 工具，把「純故事文字」（不要標題、不要 markdown、不要來源清單）寫到：
data/tmp/stories/<id>.txt

最後只回覆一行：done <id>
```

**為什麼這樣做：**
- 故事長文由 subagent 各自寫檔，**完全不經過主對話的 output**——這是省 token 與省生成時間的最大來源。
- 真平行：wall-clock 約等於最慢那個 subagent。
- 主對話 context 乾淨：不會被 N 組搜尋結果或 N 段故事污染。

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

寫好後，用 Edit 把這段 summary 加進 `data/tmp/classification.json` 的 `"summary"` 欄位（這是 summary 唯一會經過你 output 的地方，250 字內，成本很低）。

### Step 6 — 組裝 analysis-latest.json（純 script，不用你重打故事）

```
npx tsx scripts/assemble-analysis.ts
```

這支 script 讀 `data/tmp/classification.json` + `data/tmp/stories/<id>.txt`，機械合併成 `data/analysis-latest.json`（結構：`{timestamp, date, gainers:[{category,stocks,story}], losers:[...], summary}`），正是 `send-report.ts` 期望的格式。故事文字不會經過你的 output。

> 簡轉繁保險：assemble 會用 `opencc-js`（s2twp）把每段 story 與 summary 自動轉成台灣繁體（含用語：`内存→記憶體`、`服务器→伺服器`），所以即使 subagent 偶爾寫出簡體或中國用語也會被擋下，不必再人工挑字。

跑完看一眼它印出的統計（幾組有 story、summary 是否 set）確認沒漏。

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
- 中繼檔在 `data/tmp/`：`classification.json`（你寫的族群結構 + summary）、`stories/<id>.txt`（subagent 寫的故事）。Step 4 開始前先清空 `data/tmp/stories/`。analysis-latest.json 由 `assemble-analysis.ts` 從這兩者組出來，不要再手動逐段重打故事
- 本流程不應修改 `src/services/aiService.ts`（前端 UI 還在用它）
- 不需要 `GEMINI_API_KEY` 環境變數
