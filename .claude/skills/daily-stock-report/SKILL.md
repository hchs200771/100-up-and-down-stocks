---
name: daily-stock-report
description: 台股盤後分析工作流。抓當日漲跌幅前 100 名、用 Claude 本地分析做產業分類與盤後總結、寄信出去。取代原本使用 Gemini API 的流程。Trigger when user asks to run daily stock report, 跑台股盤後, 產生盤後報告, etc.
---

# Daily Stock Report Skill

這個 Skill 取代了 `src/services/aiService.ts` 裡原本呼叫 Gemini API 的邏輯。
AI 的工作（分類、族群故事、盤後總結）由 Claude 在對話裡直接完成，不呼叫任何 LLM API。

工作目錄：`/Users/huangguanxue/Desktop/Projects/100-up-and-down-stocks`

## 執行順序總覽（先讀這段，決定什麼跟什麼平行）

底下的 Step 編號是**閱讀順序，不是執行順序**。整條流程幾乎全是網路 I/O 等待、CPU 閒置，序列執行純粹是浪費 wall-clock（使用者常在深夜跑，總時間要短）。實際要照三條水線並行推進：

| 水線 | 內容 | 何時開始 | 產出何時才被需要 |
|---|---|---|---|
| A 主線 | Step 1 抓盤 → Step 2 讀記憶 → Step 3 分類 → Step 4 spawn workers | 立刻 | 全程 |
| B 背景 script | Step 1.8 RRG 三支（依序 chain） | **t=0，跟 Step 1 同時**，不必等抓盤 | Step 6 assemble |
| C 背景 script | Step 1.5 記分板、Step 1.6 國際數字、Step 1.65 信用利差、Step 1.66 指數貢獻（四者互不相依，同時丟） | Step 1 一跑完 | 1.5 → Step 5 寫總結；1.6/1.65 → Step 6 assemble；1.66 → Step 9 送報告時直接讀檔 |

**具體怎麼做**：用 Bash tool 的 `run_in_background: true` 把 B 和 C 丟出去，主對話繼續往下跑 Step 2 / Step 3。**不要**用 `;` 或 `&&` 把互不相依的 script 串成一條 bash 依序執行——那等於自己放棄平行。

**關鍵相依（只有這幾條，其餘都可以並行）**：
- Step 1.5 讀 `market-latest.json` → 必須在 Step 1 之後
- Step 1.8 三支彼此 chain（build → alerts → render），但整組**不依賴當日盤後資料**（只讀 `sector-baskets.json` + Yahoo），所以可以最早開跑。它是整條鏈最慢的一塊，排最後跑是今天最大的浪費來源
- Step 1.7 題材偵察 worker 要在 Step 3 分類前寫完檔 → Step 1 一跑完就 spawn
- Step 5 寫總結前要有 `scorecard.json` / `group-timeline.json`（水線 C）
- Step 6 assemble 前要有全部 stories、`intl-brief.txt`、RRG alerts

B 和 C 的任一步驟失敗都**不阻斷主線**（各步驟原本就標「可跳過」），到 Step 5 / Step 6 時檔案不在就照原本的降級行為處理。

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

**水線 C，背景執行**：Step 1 一跑完就用 `run_in_background: true` 丟出去，**不要**等它，主線直接往 Step 2 / Step 3 走。它的產出到 Step 5 寫總結才需要。

```
npx tsx scripts/score-report.ts
```

- 快照今日收盤價到 `data/price-history/<tradingDate>.json`
- 快照昨日分析到 `data/analysis-history/<date>.json`（若已存在則跳過）
- 重算 `data/scorecard.json`（族群 T+1 / T+5 勝率記分板，含 `byStage`（連1日/連2日/連3日+/回歸 各位階的後續報酬）與 `byCall`（歷史「順勢/觀察/反轉」判斷的勝率成績單））
- 重算 `data/group-timeline.json`（每個族群出現在強勢/弱勢榜的日期軸、目前連續天數與位階）

若此步驟失敗，**繼續流程**，不影響當日報告。

### Step 1.6 — 抓國際市場數字（純 script，可跳過）

**水線 C，背景執行**：跟 Step 1.5、Step 1.65 **同時**丟成三個獨立的背景 job（互不相依），不要串成一條 bash 依序跑。產出到 Step 4.5 的國際 worker 與 Step 6 assemble 才需要。

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

### Step 1.65 — 抓信用利差（純 script，可跳過）

**水線 C，背景執行**：與 Step 1.5、Step 1.6 同批平行丟出，不要等。

執行：

```
npx tsx scripts/fetch-credit-spreads.ts
```

從 FRED 抓 ICE BofA 的 OAS（免費 CSV、無金鑰），輸出 `data/credit-spreads-latest.json`：高收益債（`BAMLH0A0HYM2`）、投資等級（`BAMLC0A0CM`）、AAA（`BAMLC0A1CAAA`），每條含 bps、日／月變化與近一年百分位。

**為什麼不是真 CDS**：CDX／iTraxx／主權 CDS 是 Markit 的商品，沒有免費可自動抓的來源；OAS 是公開資料裡最貼近、且天天更新的替代品，跟 CDX 高度同向。**為什麼用利差不用殖利率**：AAA 殖利率主要跟著無風險利率動，跟報告裡的美10年期殖利率重疊，看不出信用面；利差才是純風險溢酬。

FRED 有 T+1 時差，`asOf` 通常是前一個美國交易日。數字會經 `attach-intl.ts` 併進 `analysis.intl.credit`，呈現在「🌐 國際情勢」表格的「信用利差」列，也是國際情勢 worker 判斷「資金鬆不鬆」的依據。此步驟失敗一樣**繼續流程**。

### 報告的「🏠 總覽」分頁

`send-report.ts` 會自動把一個總覽分頁插到最前面，列出每個分頁**在回答什麼問題**（不是內容摘要），並給第一次看的人一條建議閱讀動線：國際情勢 → 市場總覽 → 指數貢獻 → 上漲族群 → 族群輪動 → 操作建議。

兩個維護重點：

- **`TAB_GUIDE` 的 key 必須與 `sections` 的 label 逐字相同**（含 emoji 與空白）。對不上時卡片只剩標題、不會報錯，所以 `renderHome` 會 `console.warn` 列出缺說明的分頁——看到那行就去補。新增分頁時一併補 `TAB_GUIDE`，需要的話也加進 `READ_ORDER`。
- **卡片刻意不是 `<a>`，也不輸出「前往」字樣**。網頁版由 tab script 在執行時把卡片變成可點入口並補上箭頭；Email 沒有 JS，卡片維持純文字導讀。**不要為了「方便」直接寫成連結或加箭頭**——Email 版所有分頁本來就依序攤開，寫死的連結在信件裡會變成一排點不動的死連結。

**`READ_ORDER` 是分頁順序的唯一來源。** `renderHtml` 會用它重排 `sections`，所以分頁列、面板順序、總覽卡片三者永遠一致——三者只要有一個不同步，「建議第 N 站」就會跟上方分頁列對不起來。不在動線上的（下跌族群、圖例、評分說明）沉到最後、不給徽章。要調整報告的閱讀動線，改 `READ_ORDER` 就好，不要去動 `sections` 的宣告順序。

這個排序同時也是 **Email 版的段落順序**（信件沒有分頁，段落是依序攤開的），所以改 `READ_ORDER` 等於同時改了網頁與信件的閱讀動線。

總覽卡片是**單列橫向**（標題 · 說明同一行，箭頭靠右 float），不是上下兩行——兩行版每張卡片會吃掉約 78px 而右側大半留白，八張就佔滿整個首屏。窄螢幕下說明會自然換行，已在 360px 驗過不爆版。

### Step 1.66 — 加權指數貢獻拆解（可與其他 script 平行）

```
npx tsx scripts/build-index-contribution.ts
```

把當日加權指數的漲跌拆回**每一檔上市普通股**與**官方產業別**，輸出 `data/index-contribution-latest.json`。只吃三支 TWSE 端點（`STOCK_DAY_ALL`、`t187ap03_L`、`FMTQIK`），跟盤後主流程沒有相依，可以跟 Step 1.5／1.6／1.65 一起丟。

公式：`個股貢獻點數 = 漲跌價差 × 發行股數 ÷ 昨日總市值 × 昨日指數`。產業別直接取 `t187ap03_L` 的「產業別」欄位（官方 30 幾類），不是每日 AI 分類，也不是 RRG 的固定籃子——三套分類各有用途，不要混。

**為什麼要校準係數**：發行股數是 MOPS 月更資料（出表日通常早交易日一天），而且特別股／私募股／全額交割股無法從公開資料剝離，原始加總與交易所公佈值會差幾個 %（實測約 8-9%）。輸出裡的 `calibration` 是把加總對齊實際指數漲跌的整體係數——總數精確，個股之間的相對比重不受影響。報告註腳會把這件事寫給讀者看，不要拿掉。

**只涵蓋上市**，加權指數本來就不含上櫃。ETF、權證等非指數成分會被排除（靠 `t187ap03_L` 沒有該代號來判斷）。

`send-report.ts` 讀這個檔案產出「⚖️ 指數貢獻拆解」分頁：產業 treemap（面積＝絕對貢獻、紅推升綠拖累）＋產業淨貢獻表＋推升／拖累最多的個股。**檔案的 `tradingDate` 與 `analysis.date` 不符時會自動略過該分頁**，避免把昨天的數字混進今天的報告。

分頁裡有兩張圖，用途不同、不要合併：

- **貢獻傳導 Sankey**（上方）：三欄——資金方向（上漲／下跌貢獻）→ 產業 → 主要個股，帶寬正比於點數。回答「這股力道從哪來、流去哪」。用 **inline SVG**，Gmail 會整段剝掉，所以它是加分項不是主體；下方 treemap 與表格是純表格，信件裡照樣完整，區塊裡也有一行說明引導讀者去看網頁版。
- **產業貢獻分布 treemap**（下方）：面積＝絕對貢獻。回答「哪個產業今天是主戰場」。

treemap 用巢狀 `<table>` 畫（每一列各自一張表），不是 CSS grid/flex——Gmail 會剝掉現代版面屬性，但固定 px 的巢狀表格在所有信件客戶端都畫得出來。**不要把它併回單一 table**：`table-layout:fixed` 會用第一列決定欄數，後面列多出來的格子會被壓成寬度 0 而整個消失。

Sankey 的節點量有上限（前 10 大產業 + 合併節點；佔總戰場 6% 以上的產業才展開到個股，各取前 3 檔 + 「其他成分股」）。**「其他成分股」那一格不能省**：少了它，產業節點的流出量會小於流入量，帶寬就不再守恆，整張圖的比例會說謊。

**`tradingDate` 一定取自 FMTQIK 的日期欄，不能用執行當下的日期**：這支在收盤前、假日或隔天早上跑，交易所回的都是「上一個交易日」的數字，用時鐘當日期會讓 send-report 的新鮮度檢查誤判而整個分頁消失。

**這一步失敗就跳過，不影響當日報告。**

### Step 1.67 — 集保大戶持股（週資料，冪等）

```
npx tsx scripts/fetch-tdcc-holders.ts && npx tsx scripts/build-tdcc-divergence.ts
```

產出「🏦 大戶籌碼」分頁。分頁有**兩種視角 × 五種門檻**可切換：

- **背離**：大戶增加、股價還沒反映（週漲跌壓在 −15% ~ +8%）。找還沒發動的。
- **同向**：大戶增加、股價也漲、且站上 20 日均線。找籌碼與技術同步、正在走趨勢的。

兩者不是誰優誰劣，是兩個不同的問題（背離勝在賠率、輸在等待；同向勝在確認度、輸在追價成本），同一週兩張榜單常常沒交集，那是正常的。門檻是**累計**的 ≥200 / ≥400 / ≥600 / ≥800 / ≥1000 張，不是單一級距——跨級移動在門檻內部相消。

**TDCC 最高只到級 15（1000 張以上），沒有更細的分級。** 想看「超大戶是否在集中」只能看級 15 的「平均每人持股張數」（股數 ÷ 人數），輸出裡是 `avgTop` / `dAvgTop`。

**分頁的渲染分兩半**：只有預設組合（背離 × 400 張）是伺服器端渲染的完整表格，其餘 9 組壓成精簡 JSON（短 key、約 13KB）由 JS 現畫。**不要改成全部展開**——2×5×20 = 200 列 HTML 約 160KB，信件會爆。切換器本身預設 `display:none`，由 JS 打開，所以沒有 JS 的信件不會出現一排點不動的按鈕。

**這是週資料，不是日資料。** TDCC 每週五結算、**隔天（週六）才拿得到**（實測資料日 08/28 → 08/29 抓到，T+1）。所以同一份榜單會連續出現好幾天，直到下週六更新——分頁標題有標資料週期，不要誤以為是當日數字。

**冪等**：`fetch-tdcc-holders.ts` 看資料日是否已存過，存過就 no-op。所以放在每日流程裡每天跑也沒關係，只有週六那次會真的抓。要重抓加 `--force`。

**為什麼要自己累積快照**：TDCC 批次端點（`opendata.tdcc.com.tw/getOD.ashx?id=1-5`）**只回傳最新一週**，沒有歷史。歷史只能走逐檔查詢，而逐檔查詢一個請求只能拿「一檔 × 一週」——全市場一年 4000 × 52 ≈ 20.8 萬次請求。所以歷史一定要自己存在 `data/tdcc-history/<YYYYMMDD>.json`。

`backfill-tdcc-history.ts` 是限定範圍的回補工具（預設流動性前 400 檔），只在「不想等下一週」時用。它產出的快照會標 `partial: true`，下游會在分頁上顯示警告——**回補快照涵蓋範圍小於全市場，不能把「沒回補到」當成「沒有大戶異動」**。

**逐檔查詢必須串行**：`SYNCHRONIZER_TOKEN` 是一次性的，每次回應帶回新 token，下一個請求得用它。並發會讓多條 worker 互相把對方的 token 作廢（實測並發 3 條、12 檔只成功 1 檔）。

**四個訊號品質問題**（都寫在 `build-tdcc-divergence.ts` 檔頭，改動前先讀）：

1. **主訊號一定用「累計門檻」的比例，不要單看某一級。** 級距之間會互相流動：900 張的人加碼到 1100 張，就會離開級 12–14、進入級 15，只看 mid 會把它讀成減碼（實測 `corr(dMid, dTop) = −0.43`）。曾用 dMid（只有級 12–14）當主排序，結果 25 檔榜單裡有 14 檔的 400 張以上總比例其實是**下降**的。
   附帶更正一個曾經寫在這裡的錯誤說法：級 15 並非「都是保管銀行與政府基金」。實測 1000 張成本不到 0.5 億的小型股，級 15 佔比一樣有 ~49%，那是公司派與真大戶；而且 dTop 與當期股價的相關性（0.30~0.49）遠高於 dMid（≈0.0）。保管帳戶污染只在**大型權值股**成立（台積電大戶 87.5% 裡有 84.75% 在級 15），不是級距本身的性質。
2. **除權息／現增／可轉債轉換**會讓比例變動但不是買賣。用「大戶人數」交叉驗證：比例升但人數沒動的標 `dilutionRisk`，排序降權（不剔除，讓人自己判斷）。
3. **不要用絕對門檻**（例如一律「週增 ≥1.5%」）。大型股大戶比例週變動 1% 已是巨量，小型股 1% 只是雜訊——絕對門檻會讓榜單被小型股洗版。改用 z-score 標準化。
4. 只比較**兩份快照都有**的個股。

**定位：觀察名單產生器，不是買賣訊號。** 大戶增加不必然領先股價。分頁文案已寫明，不要改掉。

**回測需知**：TDCC 只保留 52 週歷史，所以最多只有 52 次調倉可回測；配上多個可調參數幾乎必然過度配適。要做回測請先累積足夠週數，並且務必處理**還原股價**（除權息旺季會讓未還原價看起來像暴跌）與**交易成本**（手續費 0.1425%×2 + 證交稅 0.3% ≈ 每趟 0.6%）。

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

### Step 1.8 — 族群輪動 RRG（純 script，可跳過）

**水線 B，最早開跑**：這一組**不讀當日盤後資料**（只讀 `data/sector-baskets.json` 與 Yahoo 日線），所以**不必等 Step 1**——整條流程一開始就把它用 `run_in_background: true` 丟出去，跟 Step 1 抓盤同時進行。它是整條鏈裡最慢的一塊（要抓 27 個籃子的成分股日線），排在最後跑會白白拉長總時間。產出到 Step 6 assemble 才需要。

三支彼此有相依（第二支吃第一支的產出），所以**這三支之間**要串成一條依序執行的背景指令：

```
npx tsx scripts/build-tw-rrg.ts && npx tsx scripts/build-rrg-alerts.ts && npx tsx scripts/render-tw-rrg.ts
```

- `build-tw-rrg.ts`：輸出 `data/tw-rrg-data.json`，含**四組** universe：
  - `tw_sectors` 台股族群輪動——讀 `data/sector-baskets.json` 的**固定**籃子，抓 Yahoo 還原收盤（`.TW`／`.TWO` 自動偵測並記錄，本機快取 12 小時），編成等權指數，對 `^TWII` 算 RS-Ratio / RS-Momentum
  - `assets` 全球資產、`us_sectors` 美股板塊、`markets` 全球市場——標的定義沿用隔壁 rrg-radar 的 `build_data.py`，但**用本專案的 TS 管線重跑**，四組出自同一份資料與同一時間戳。任一組失敗只跳過該組。
- `build-rrg-alerts.ts`：只讀 `tw_sectors`，找出值得講的象限異動，輸出 `data/tw-rrg-alerts.json`。多族群同時觸發同一訊號時會收斂成「市場狀態」，避免真訊號被淹沒。
- `render-tw-rrg.ts`：注入 `templates/rrg-tw.html`（**本專案自己的 fork**，不再依賴 rrg-radar 專案存在）產出 `data/tw-rrg.html`（整頁，本地預覽用）與 `data/tw-rrg-embed.html`（可內嵌片段，CSS 全鎖在 `.rrg-root` 底下）。頁面可切四個市場、120/60/20 日視窗；每個族群有勾選框（是否畫在圖上）與可點的名稱（展開成分股、連到 Yahoo 股市），並有 Gmail 式的全選／全不選。

Step 6 的 `assemble-analysis.ts` 會自動把 alerts 併進 `analysis.rrg`，報告出現「🔄 族群輪動」分頁；Step 9 的 `build-site-html.ts` 會把 `tw-rrg-embed.html` 直接塞進報告的 `<!--RRG_EMBED-->` 佔位處——互動圖就在同一頁的分頁裡，沒有 iframe、也沒有 `rrg.html` 子頁。

**這一步失敗就跳過，不影響當日報告**——`analysis.rrg` 不存在時報告會自動略過該分頁。

**重要提醒：**
- 改過 `data/sector-baskets.json` 後**一定要跑 `npx tsx scripts/verify-baskets.ts`**：它拿交易所名冊逐檔對帳代號與名稱。代號打錯時若那個代號剛好是另一檔存在的股票，build 不會報錯，那檔會靜靜地被算進錯的族群（2026-08-01 改版就抓到 4 檔：2375 是凱美不是智寶、2883 已更名凱基金、2887 已更名台新新光金、1704 榮化已下市）。
- `data/sector-baskets.json` 的成分要**長期穩定**，每季 review 一次就好。改成分時記得同步更新 `_changelog` 與 `version`；因為族群指數每次都從兩年前重算，改成分會連歷史軌跡一起變，改版前後的圖不能直接比對。它跟每日分類（`classification.json`）是**刻意分開**的兩套東西：每日分類要動態抓當日題材，RRG 籃子要固定才能跨日比較軌跡。**不要把每日分類的結果寫回籃子。**
- RRG 的 `asOf` 來自 Yahoo 日線，當日盤後若 Yahoo 尚未更新，會是前一個交易日；報告會照實顯示，不要當成錯誤。Yahoo 對「最新一根」有時長區間查不到、短區間查得到（甚至同一天內又消失），所以 `fetchYahoo` 會把 `range=2y` 與 `range=1mo` 疊起來取值。
- 個股缺值會往 benchmark 日期軸前向填補（最多 3 天），但**若最新一天有超過 20% 的成分股都靠補**，該日會整個丟掉。理由：那代表資料源當日尚未落檔，硬補會讓族群指數在大漲/大跌日原地不動，做出與事實相反的相對強弱。

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

**單一批次 spawn（不要再分兩階段）：**

把**所有**符合門檻的強勢族群 + 弱勢前 3 大族群 + 1 個「國際情勢 worker」（見 Step 4.5），**全部放在同一個 assistant message 裡一次 spawn 完**（通常 15–18 個）。

**關鍵：所有 spawn 必須在同一個 assistant message 裡**，才是真平行；wall-clock 等於最慢那一個 worker。

以前這裡分「階段 A 強勢 / 階段 B 弱勢」兩批，理由是怕 B 失敗污染 A——但**每個 worker 各自寫自己的 `<id>.txt`、彼此完全隔離**，任一個失敗本來就只損失那一個檔案，分批並不會提供額外保護，卻硬生生多等一輪最慢 worker 的時間（實測約多 2 分鐘）。所以合併成一批。

失敗處理不變：某個 worker 沒寫出檔，assemble 時該組就沿用 classification 裡的簡述或留空，不影響其他組與寄信。優先確保報告能寄出。

**⚠️ spawn 完立刻核對數量（必做）**：spawn 是會偶發失敗的（曾遇到 classifier 暫時不可用，15 個裡有 1 個直接回 error）。送出後**當場數一遍成功啟動的數量是否等於預期數量**，對不上就**立刻補送缺的那一個**，不要等到 Step 6 才從 `ls data/tmp/stories/` 發現少檔——那時候補送等於整條流程多等一輪。

注意錯誤是照 spawn 順序回報的，**不要用回報內容猜是哪一個失敗**（曾把失敗的族群 worker 誤判成國際 worker，結果國際 worker 重跑兩次、真正缺的那組完全沒補到）。按位置對，第 N 個結果就是第 N 個 spawn。

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

### Step 4.5 — 國際情勢 worker（與 Step 4 同批平行 spawn）

**這個 worker 必須跟 Step 4 的所有族群 worker 放在同一個 assistant message 裡一起 spawn**，這樣它跟台股族群故事同時在跑，不會拉長整體報告時間（使用者常在深夜執行，整體時間要短）。它讀的 `intl-market-latest.json` / `credit-spreads-latest.json` 由水線 C 的背景 job 產出，spawn 前確認那兩支已經跑完；沒跑完也照 spawn，worker 會降級成純靠 WebSearch。

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

**也會**讀 `data/tw-rrg-alerts.json`（Step 1.8 的族群輪動訊號），併成 `analysis.rrg`，報告出現「🔄 族群輪動」分頁。檔案不存在就不附 `rrg`。看它印出的 `rrg N alerts / M regime @ <asOf>` 確認。

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

### Step 9 —（必做）部署到 GitHub Pages

> **這是流程的最後一步，一定要執行，不能只跑到寄信就當完成。** 寄信成功 ≠ 任務完成；報告網站沒更新等於沒發布。
>
> **本專案已於 2026-07 從 Vercel 全面改用 GitHub Pages，Vercel 已停用、不要再嘗試部署到 Vercel。**

寄信（Step 7）完成後，**你（互動流程）要親自執行**這支腳本：

```
bash scripts/publish-github-pages.sh
```

它會將 `data/report-latest.html` 組進 `data/site/` 並 commit + push；GitHub Actions（.github/workflows/pages.yml）隨後把它部署到 https://hchs200771.github.io/100-up-and-down-stocks/ 。不需要任何 token（用本機既有的 git 權限）。

若 Step 1.8 有跑，`build-site-html.ts` 會把 `data/tw-rrg-embed.html` 內嵌進 `data/site/index.html`，互動圖直接出現在「🔄 族群輪動」分頁裡（不另外發佈 `rrg.html`）。

**push 成功 ≠ 部署成功**（2026-08-17 踩過：push 綠燈，但 Actions 的 deploy job 在 Set up 階段就掛掉，網站停在前一天的報告，卻回報了「已部署」）。所以 push 完**一定要再等 workflow 真的跑完**：

```
gh run watch $(gh run list --workflow=pages.yml --limit 1 --json databaseId -q '.[0].databaseId') --exit-status --interval 15
```

- **綠燈** → 部署完成，繼續下一步。
- **紅燈** → 先看失敗原因：`gh run view <run-id> --log-failed | tail -40`。
  - 若是**環境性/暫時性失敗**（下載 action 時 429 Too Many Requests、runner 網路錯誤、`Internal server error`），直接 `gh run rerun <run-id>` 重跑一次，再 watch 一輪。這類失敗跟報告內容無關，重跑通常就過。
  - 若**重跑第二次仍失敗**，或失敗原因來自我們自己的內容（build-site 產物有問題、檔案過大、workflow 設定錯），**不要再重跑**，在結尾回報明講「已寄信但網站未部署」並附上失敗原因。

最後再驗一次線上內容真的換成今天的（避免 workflow 綠燈但頁面沒更新）：

```
curl -s https://hchs200771.github.io/100-up-and-down-stocks/ | grep -o "<今日 timestamp，例 2026/08/17>" | head -1
```

抓得到今天的日期才算真的完成。

## 結尾回報

跑完跟使用者簡短回報：
- 當日時間戳
- 漲最多 / 跌最多的股票
- 漲跌方各自分了幾個族群
- 是否已寄信（或為何沒寄）
- **是否已部署到 GitHub Pages（Step 9）**——附上 commit 與網址。**只有在 Actions workflow 綠燈、且線上頁面確認是今天的日期時，才能說「已部署」**；push 成功但 workflow 失敗要明講「已寄信但網站未部署」與失敗原因，不可含糊帶過

## 需要注意的

- 所有檔案路徑用工作目錄相對路徑（`data/...`、`scripts/...`），不要寫絕對路徑
- `data/memory/` 資料夾如果不存在，自己 mkdir
- 中繼檔在 `data/tmp/`：`classification.json`（你寫的族群結構 + summary + call）、`stories/<id>.txt`（subagent 寫的故事）、`intl-brief.txt`（國際 worker 的判讀）、`group-chips.json`（`group-chips.ts` 產出的族群籌碼彙總）。Step 4 開始前先清空 `data/tmp/stories/` 與 `intl-brief.txt`。analysis-latest.json 由 `assemble-analysis.ts` 從這些檔組出來（含 `data/intl-market-latest.json` 的國際數字），不要再手動逐段重打故事
- 國際數字源是 Yahoo Finance（`scripts/fetch-intl-market.ts`），免費無金鑰；stooq 已改成需瀏覽器驗證、不能用
- 信用利差源是 FRED 的 ICE BofA OAS（`scripts/fetch-credit-spreads.ts`），免費無金鑰、T+1；真 CDS 指數（CDX/iTraxx）是付費商品，不要為了「更正統」去接
- 本流程不應修改 `src/services/aiService.ts`（前端 UI 還在用它）
- 不需要 `GEMINI_API_KEY` 環境變數
- **總時間就是這個 Skill 的品質指標之一**。回頭看「執行順序總覽」那張表：互不相依的 script 一律 `run_in_background` 平行丟、所有 worker 一次 spawn 完。判斷「這步能不能跟上一步同時跑」的方法是問「它讀的檔是誰寫的」——沒有相依就不要等。整條流程的 wall-clock 下限約等於「最慢的那個 worker + 分類時間」，跑出來明顯超過就是編排出了問題
