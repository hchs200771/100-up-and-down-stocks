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

### Step 1.5 — 更新記分板（幂等，可重跑）

執行：

```
npx tsx scripts/score-report.ts
```

- 快照今日收盤價到 `data/price-history/<tradingDate>.json`
- 快照昨日分析到 `data/analysis-history/<date>.json`（若已存在則跳過）
- 重算 `data/scorecard.json`（族群 T+1 / T+5 勝率記分板，含 `byStage`（連1日/連2日/連3日+/回歸 各位階的後續報酬）與 `byCall`（歷史「順勢/觀察/反轉」判斷的勝率成績單））
- 重算 `data/group-timeline.json`（每個族群出現在強勢/弱勢榜的日期軸、目前連續天數與位階）

若此步驟失敗，**繼續流程**，不影響當日報告。

### Step 1.6 — 抓國際市場數字（純 script，可跳過）

執行：

```
npx tsx scripts/fetch-intl-market.ts
```

用 Yahoo Finance（免費、無金鑰）抓 13 個國際標的的最新收盤與漲跌幅，輸出 `data/intl-market-latest.json`：

- **美股**：標普500、道瓊、那斯達克、費城半導體（費半）
- **中國**：上證指數、滬深300、恒生指數
- **日韓**：日經225、韓國KOSPI
- **原物料/利率**：西德州原油、黃金、美元指數、美10年期殖利率

各市場收盤時間不同：對台股傍晚跑的盤後報告，亞股是「當日」收盤，美股/費半/原油/殖利率是「隔夜」前一交易日。這些數字是 Step 4 國際情勢 worker 的判讀依據，也會直接呈現在報告的「🌐 國際情勢」表格。

若此步驟失敗（Yahoo 掛掉），**繼續流程**：國際情勢 worker 會少掉精準數字、只能靠 WebSearch 敘述，但不影響台股報告與寄信。

### Step 1.7 — 題材偵察 worker（背景 spawn，越早越好）

**Step 1 一跑完就 spawn**（與 Step 1.5/1.6 的 script 平行），這樣它搜尋時你可以繼續跑 script 與讀記憶，Step 3 分類前它多半已寫完檔。spawn 前先 `rm -f data/tmp/theme-scan.md` 清掉前一天的舊檔。

**worker 設定：** Agent tool，`subagent_type: "general-purpose"`、`model: "haiku"`、`run_in_background: true`。只 spawn 1 個。

worker prompt 樣板（把 `<今日強勢股前30名>` 換成 gainers 前 30 檔的 `名稱(代號) +pct%` 清單）：

```
你是台股題材偵察員。任務：找出「現在市場最紅的新族群/新題材」，並比對今日強勢股，寫成檔案。

第一步：讀 data/themes.json（已知題材字典，含每個題材的成員股）。不存在就當空的。

第二步：用 WebSearch 查最近 3~7 天台股最熱的新題材與概念股（例：「台股 最新 概念股 題材 本週」「台股 新題材 漲停」；也可針對今日強勢股裡看不懂為何大漲的個股查「<股名> 概念股」）。**最多 3 次 WebSearch。**重點是找 themes.json 裡「還沒有」的新題材，以及既有題材的新成員（老公司跨足新領域）。

今日強勢股前30名：
<今日強勢股前30名>

第三步：用 Write 寫 data/tmp/theme-scan.md，格式：

## 新發現題材（themes.json 沒有的）
- <題材名>: <成員股 名稱(代號)，特別標出今日在強勢榜的> — <一句話：題材是什麼、為何最近紅>

## 既有題材的新成員
- <題材名>: +<名稱(代號)> — <理由>

## 今日強勢股的題材歸屬提示
- <名稱(代號)> → <題材名>（僅列出「不查就容易被歸錯或丟進其他」的，最多 10 檔）

查不到新題材就在檔案裡寫「本次無新發現」，不要硬湊。全文台灣繁體中文。

最後只回覆一行：done themes
```

**為什麼這樣做：** 題材是不斷變化的（玻璃基板 TGV 就是活例——老公司跨新領域，靠傳統主業分類會全部歸錯）。這個 worker 把「理解現在什麼最紅」變成每天自動做的事，而不是等使用者提醒。背景平行跑，不拉長整體時間；失敗或沒寫出檔案就照常分類，不影響流程。

### Step 2 — 讀取記憶

列出 `data/memory/` 下最近 **2 份** markdown（依檔名日期排序，最新的在前）。
如果資料夾不存在或沒檔案，跳過這步，summary 就不做歷史比較。

讀這 2 天是為了在 Step 5 判斷**波段趨勢**：哪些族群連續強勢、哪些今天才新進場、哪些昨強今弱出現反轉、哪些連跌 N 日後開始止跌。

### Step 3 — 產業分類（主對話模型本地分析，不可下放小模型）

**分類必須由主對話的大模型親自做**：分類是整條流程的地基，族群一旦分錯，後面的故事、時間軸、記分板全部跟著錯。曾嘗試交給 haiku subagent，出現「信驊(BMC)歸車用電子、晶技(石英)歸光學鏡頭」等指標股級錯誤，已證實不可行。

讀 `data/market-latest.json`，對 `gainers` 和 `losers` 各做一次分類。

只需要 `gainers`、`losers` 陣列（每筆只取 `code`、`name`、`pct`）、`tradingDate`、`timestamp`，**跳過 `stockMap`**（分類用不到）。建議用以下指令取出所需欄位：

```bash
npx tsx -e "
const d = JSON.parse(require('fs').readFileSync('data/market-latest.json','utf-8'));
console.log(JSON.stringify({tradingDate: d.tradingDate, timestamp: d.timestamp, gainers: d.gainers.map(({code,name,pct})=>({code,name,pct})), losers: d.losers.map(({code,name,pct})=>({code,name,pct}))}));
"
```

分類前先看兩個檔：

1. `data/taxonomy.json` 的 canonical 分類名，優先沿用既有名稱（避免同一族群每天換名字，影響時間軸與記分板的連續性）；沒有合適的才發明新名。
2. `data/themes.json`（題材字典）與 `data/tmp/theme-scan.md`（Step 1.7 偵察 worker 的當日產出，還沒寫完就等它 30 秒、再沒有就跳過）——這兩份告訴你「現在市場在紅什麼新題材、哪些今日強勢股其實屬於新題材」。分類時優先用它們判斷歸屬。

**分類完成後維護題材字典**：若 theme-scan 有「新發現題材」且你採用了（立了新族群），把它併進 `data/themes.json`（格式 `{"themes": [{"name", "since", "members": ["名稱(代號)"], "note"}]}`，`since` 用當日 tradingDate），同時在 `data/taxonomy.json` 加一筆 canonical，讓名稱從第一天就穩定。既有題材若出現新成員也順手補進 members。

**分類原則：**

1. **以漲跌幅為主軸**：只要進前 100 名都納入考慮，不依成交金額排序或篩選。
2. **拒絕大雜燴**：使用最新、最細分的概念股名稱分類。例如不要只寫「電子」，要細分出「CPO 光通訊」、「CoWoS 設備」、「散熱」、「特化」、「IP 矽智財」、「車用二極體」等。例：昇達科放在「低軌衛星」比放在「網通與微波通訊」更適合。
3. **微型聚落**：即使該族群只有 2 檔股票（例如只有兩檔光學股），也要獨立成一個分類，不要丟進其他。
4. **禁止混淆**：禁止將「電源管理 IC」與「驅動 IC」混為一談。
5. **弱勢股單檔不成族群**：跌幅榜的單一股票分類可以保留（例如台積電獨立），但 Step 4 不為單檔弱勢股寫故事（見下）。
6. **依實際主業歸類**：不確定該公司主業時，寧可歸入「其他強勢/弱勢個股」也不要亂塞。
7. **主動偵測新興題材，不被舊 taxonomy 綁死**：taxonomy 是「命名的連續性」參考，不是題材的全集。市場題材不斷更新（例：玻璃基板 TGV、CPO、機器人、BBU），老公司常因跨足新領域而起漲——此時要依「當日驅動股價的題材」歸類，而不是公司的傳統主業。例：正達、群創若因玻璃基板題材上漲，應歸「玻璃基板」而非「光學鏡頭」「面板」。判斷依據：同日有多檔不同傳統產業的股票齊漲、且共通點是同一個新題材時，就該立新族群名。
8. **一檔股票有多重族群性**：像南亞既是塑化、又持有南亞科（記憶體）與南電（ABF 載板）。classification 裡仍只歸入「當日最可能的驅動題材」那一組（一檔只出現一次，避免記分板重複計分），但寫該組簡述或給 subagent 的 prompt 時，可點出這種跨題材身分（例：塑化權值因記憶體轉投資收益而漲）。
9. **「其他」是最後手段，先做第二輪掃描**：第一輪分完後，回頭看「其他強勢/弱勢個股」清單，主動找新題材連結（漲停與漲幅前段的優先查）。對看不出歸屬的漲停股，可用**最多 2 次 WebSearch**查「<股名> 漲停 題材」確認當日驅動原因，再決定歸組或立新族群。目標是把「其他強勢個股」壓在 15 檔以內；真的查不出共通題材的才留在其他，不要硬湊。

**輸出格式**：每一邊產出一個陣列 `[{category, stocks}]`，其中 `stocks` 陣列元素必須是 `股票名稱(四碼代號)`。

**分類完成後，寫 `data/tmp/classification.json`（這是後面組裝的唯一資料來源，故事文字不會再經過你的 output）：**

先清空中繼檔，**分成三條各自獨立的指令**執行（不要用 `&&` 串接，否則整串複合指令會落到全域 `rm -rf*` 的 ask 規則而跳確認；拆開後每條都命中 settings.local.json 既有的 allow）：

```
rm -rf data/tmp/stories
mkdir -p data/tmp/stories
rm -f data/tmp/intl-brief.txt
rm -f data/tmp/playbook.txt
```

（`theme-scan.md` **不要**在這裡清——它是 Step 1.7 在更早就開始寫的當日產出；正確的清除時機是 Step 1.7 spawn 之前 `rm -f data/tmp/theme-scan.md`。）

（`playbook.txt` 是 shell 管線 finalizer 的產物；互動流程不產它，但若留著舊檔，assemble 會把前一天的操作建議混進今天的報告，一定要清。）

再用 Write 寫：

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
- `summary` 與 `call` 這裡先不寫，等 Step 5 再補。

### Step 4 — 族群故事（平行 subagent，subagent 直接寫檔）

**門檻（精簡後）：**
- 強勢（gainers）：**3 檔以上**才 spawn subagent 寫故事。2 檔族群不 spawn，用 Step 3 在 classification 裡寫的一句判讀帶過；單檔跳過。
- 弱勢（losers）：只挑**成員數最多、且 3 檔以上的前 3 個族群**做 research；其餘弱勢族群不 spawn，沿用 classification 裡的簡述或留空。

**subagent 設定：** 用 Agent tool，`subagent_type: "general-purpose"`、`model: "haiku"`。
（不要用 Explore——Explore 沒有 Write 工具，無法寫檔。）

**兩階段流程：**
- **階段 A**：所有符合門檻的**強勢**族群，**外加 1 個「國際情勢 worker」（見 Step 4.5）**，全部放在**同一個 assistant message** 裡平行 spawn。國際 worker 與台股族群 worker 同時跑，幾乎不增加整體 wall-clock。全部回來後跑一次 `npx tsx scripts/assemble-analysis.ts` 當 checkpoint（此時 losers 用 classification 的簡述/空白、summary 空）。
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

### Step 4.5 — 國際情勢 worker（與階段 A 同批平行 spawn）

**這個 worker 必須跟 Step 4 階段 A 的強勢族群 worker 放在同一個 assistant message 裡一起 spawn**，這樣它跟台股族群故事同時在跑，不會拉長整體報告時間（使用者常在深夜執行，整體時間要短）。

**worker 設定：** Agent tool，`subagent_type: "general-purpose"`、`model: "sonnet"`（這份要套總經分析框架，用 sonnet 判讀品質較穩；因為平行跑，不影響總時間）。只 spawn **1 個**。

worker 拿到的 prompt 樣板：

```
你是「財經M平方」風格的總經研究員。請產出一段「國際情勢」盤後判讀，並把結果「寫成檔案」。

**字數硬上限：全文嚴格 300 字以內（中文字計），最多 3 段。** 盤後快訊不是長文，寫超過就刪到 300 字內再寫檔；寧可濃縮成精華，不要流水帳。

第一步：讀本專案的分析框架（一定要讀，當你的思考骨架）：
- .claude/skills/macromicro-analyst/SKILL.md（核心三層分析：事件定性 → 影響鏈 → 勝率（紅線/歷史類比/痛苦指數）→ 數據確認）
- 需要時可參考同目錄 fed-reading.md（Fed/利率）、data-reading.md（原油/黃金/數據）。

第二步：讀國際數字 data/intl-market-latest.json（美股、費半、上證、滬深300、恒生、日經、KOSPI、原油、黃金、美元指數、美10年期殖利率的收盤與漲跌幅）。若檔案不存在就略過數字、純靠新聞。

第三步：用 WebSearch 找最近 1–2 天「最會影響股市」的幾條國際政治經濟新聞（地緣衝突、Fed/各國央行、CPI/就業、關稅、重要財報、原物料）；**最多 3 次 WebSearch**。

內容要求（用 macromicro 框架，不要只是流水帳）：
1. 開頭一句帶過國際指數數字的重點（誰強誰弱、費半/美股隔夜、亞股當日）。
2. 挑最關鍵的 2 條大事（最多 3 條），每條用一兩句濃縮框架：定性「消息面 vs 傷基本面」+ 影響鏈（例：油價→通膨→Fed利率→股市估值）+ 機率傾向（可用紅線：美10年殖利率 4.4–4.5%、油價 ~$100）。不要每條都展開成一大段。
3. 收在「對台股的意涵」：隔夜美股/費半與殖利率怎麼影響今日台股估值與電子權值，是順風還是逆風。
4. 全文台灣繁體中文與台灣金融慣用語（記憶體/半導體/晶圓/伺服器/殖利率/估值），不要簡體或中國用語。
5. 是研究判讀、不是投資建議；基於可查證事實，不硬湊。

完成後用 Write 工具，把「純判讀文字」（不要標題、不要 markdown、不要來源清單）寫到：
data/tmp/intl-brief.txt

最後只回覆一行：done intl
```

**為什麼這樣做：** 國際判讀長文由 worker 自己寫檔，不經過主對話 output（省 token）；與台股族群 worker 同批平行，整體時間幾乎不變。`intl-brief.txt` 連同 `intl-market-latest.json` 會在 Step 6 由 `assemble-analysis.ts` 自動併進 `analysis.intl`，報告裡呈現為「🌐 國際情勢」區塊。worker 失敗或檔案沒寫出來也沒關係——assemble 會只放數字表、或整段略過，不影響台股報告與寄信。

### Step 5 — 盤後總結（250 字內）

以資深台股操盤手的口吻寫 250 字內總結。**使用者以做多為主，重點放在強勢族群的波段機會。**

**寫總結前先跑籌碼彙總（純 script）：**

```
npx tsx scripts/group-chips.ts
```

它讀 classification.json + market-latest.json 的 per-stock `chips`，印出每個族群的外資/投信買賣超合計、投信連買 ≥3 日的認養名單、平均當沖比（≥30% 標記隔日沖熱）。投信認養是波段續航力最強的確認訊號；當沖過熱族群追價風險高。

分析前建議參考：
- `data/market-latest.json` 的 `market` 區塊（三大法人、當沖比重、breadth、加權/櫃買指數、微臺散戶多空比、注意/處置股）
- `data/group-timeline.json`（若存在）—— 每個族群的**連續天數與位階**（連1日/連2日/連3日+/回歸），這是機械計算的，比記憶檔目測準；注意它的 `asOf` 是昨日快照，今日的位階 = 昨日 streak + 1（若今日仍在榜）
- `data/scorecard.json`（若存在）—— `byStage` 告訴你「第 N 天追入」的歷史後續報酬；`byCall` 是你過去「順勢/觀察/反轉」判斷的勝率成績單，用它校準今天的信心

- **波段趨勢分析**：對比 Step 2 讀到的最近 2 天記憶 + group-timeline，點名：
  - 哪些族群**連續 N 日**在強勢榜 → 主流，可順勢
  - 哪些是**今日新進場**的族群 → 需觀察是否只是一日行情
  - 哪些**昨強今弱**或反之 → 反轉訊號
- 觀察資金是否有明顯族群性；有投信認養的起漲族群優先點名
- 專業、犀利
- 給建議的資金比例與策略，不要太激進
- 弱勢族群著墨可少一些（只需點出是否拖累大盤），不用給做空建議

寫好後，用 Edit 一次完成兩件事：

1. 把這段 summary 加進 `data/tmp/classification.json` 的 `"summary"` 欄位（250 字內）。
2. **給每個強勢族群標 `"call"` 欄位**（打分驗證迴路的輸入，之後 scorecard `byCall` 會回頭驗證這些判斷的勝率）：
   - `"順勢"` — 主流、可加碼或續抱
   - `"觀察"` — 新進場或訊號不足，先看一天
   - `"反轉"` — 過熱、當沖比爆量、或預期熄火
   - 沒把握就省略欄位，不要硬標。losers 不用標。

### Step 6 — 組裝 analysis-latest.json（純 script，不用你重打故事）

```
npx tsx scripts/assemble-analysis.ts
```

這支 script 讀 `data/tmp/classification.json` + `data/tmp/stories/<id>.txt`，機械合併成 `data/analysis-latest.json`（結構：`{timestamp, date, gainers:[{category,stocks,story,stage?,call?}], losers:[...], summary}`），正是 `send-report.ts` 期望的格式。`call` 會跟著快照進 `analysis-history/`，隔天 score-report 用它算 `byCall` 勝率。故事文字不會經過你的 output。

**同時**它會讀 `data/intl-market-latest.json`（國際數字）+ `data/tmp/intl-brief.txt`（國際 worker 的判讀），併成 `analysis.intl = {summary, indices}`。兩者皆缺就不附 `intl`，報告自動略過國際區塊。看它印出的 `intl ... idx / brief ...` 統計確認有併進來。

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

## 國際情勢

<intl-brief.txt 原文；若該日 worker 沒寫出來則略過這段>

## 強勢族群

- <category>: <檔數>檔 — <代表股 1, 2, 3>
- ...

## 弱勢族群

- <category>: <檔數>檔 — <代表股 1, 2, 3>
- ...
```

這份 markdown 是下一次執行 Skill 時的輸入（Step 2 會讀）。

### Step 9 — 部署到 Vercel（wrapper 自動執行）

wrapper 在寄信完成後會執行 `scripts/publish-github-pages.sh`，將 `data/report-latest.html` 組進 `data/site/` 並 commit + push；GitHub Actions（.github/workflows/pages.yml）隨後把它部署到 https://hchs200771.github.io/100-up-and-down-stocks/ 。不需要任何 token（用本機既有的 git 權限）。

## 結尾回報

跑完跟使用者簡短回報：
- 當日時間戳
- 漲最多 / 跌最多的股票
- 漲跌方各自分了幾個族群
- 是否已寄信（或為何沒寄）

## 需要注意的

- 所有檔案路徑用工作目錄相對路徑（`data/...`、`scripts/...`），不要寫絕對路徑
- `data/memory/` 資料夾如果不存在，自己 mkdir
- 中繼檔在 `data/tmp/`：`classification.json`（你寫的族群結構 + summary + call）、`stories/<id>.txt`（subagent 寫的故事）、`intl-brief.txt`（國際 worker 的判讀）、`group-chips.json`（`group-chips.ts` 產出的族群籌碼彙總）。Step 4 開始前先清空 `data/tmp/stories/` 與 `intl-brief.txt`。analysis-latest.json 由 `assemble-analysis.ts` 從這些檔組出來（含 `data/intl-market-latest.json` 的國際數字），不要再手動逐段重打故事
- 國際數字源是 Yahoo Finance（`scripts/fetch-intl-market.ts`），免費無金鑰；stooq 已改成需瀏覽器驗證、不能用
- 本流程不應修改 `src/services/aiService.ts`（前端 UI 還在用它）
- 不需要 `GEMINI_API_KEY` 環境變數
