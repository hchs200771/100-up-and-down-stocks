請在目前專案目錄執行「台股盤後報告 finalizer」流程，直接修改/產出專案內檔案。

目標：
1. 讀取 `data/market-latest.json`
2. 讀取 `data/tmp/group-tasks/*.json`
3. 讀取 `data/tmp/group-results/*.json`
4. 合併成 `data/analysis-latest.json`
5. 另寫出獨立的長線策略判斷 `longTermStrategy`
6. 寫入 `data/memory/<tradingDate>.md`
7. 最後簡短回報

重要限制：
- 不要重新抓市場資料。
- 不要執行寄信腳本。
- `analysis.date` 與 memory 檔名一律使用 `data/market-latest.json` 內的 `tradingDate`
- 若某些 worker 結果缺失，允許保留空 story，但不要讓整份報告失敗。
- 弱勢族群分析規則：前 3 大弱勢族群（依成員數）**以及**任何帶有 `retreatSignal: true` 的弱勢族群，都必須輸出完整 story；`retreatSignal` 族群的 story 必須點出「這是換手、分化、還是退潮」（因為它前幾日出現在強勢榜），並在輸出 JSON 的該族群物件加 `"retreatSignal": true`。其他弱勢族群全部合併成一組 `其他弱勢`，只列股票、story 為空字串。
- 弱勢族群若含有 `overnightDump: true` 的成員，story 必須將「隔日沖出貨調節」與族群基本面題材分開說明：先交代該股是昨漲停今爆當沖收黑的投機性出貨，再講族群整體的產業或籌碼邏輯；不可把隔日沖個股當作族群基本面惡化的代表。
- 合併 story 時，優先使用 `data/tmp/group-results/*.json` 的 `story`；若強勢族群或前三大弱勢族群缺失，改用對應 task 檔中的 `preliminaryStory`，但必須先去除模板廢話並補成完整分析；若連 `preliminaryStory` 都沒有，才留空。
- 報告中的 story 不可以出現這些模板句或同義句：`最近 2 天沒有`、`最近 3 天沒有`、`沒有查到`、`沒有看到`、`族群性較弱`、`較偏個股事件整理`、`同步轉強`、`同步轉弱`、`初步看`、`若缺乏`、`報告應`、`fallback`。
- 不要重複畫面已經知道的方向：強勢區不要說「上漲/轉強」，弱勢區不要說「下跌/轉弱」。直接講原因、題材、籌碼與代表股。
- 即使強勢族群或前三大弱勢族群 worker 缺失，也要用 task 的 category、members、queryHints、最近 memory 與你的產業知識寫出 80 到 220 字的專業故事，不可只寫風險提示或空泛分類；非前三大弱勢族群除外，必須併入 `其他弱勢` 並保留空 story。

策略判讀規則：
- 報告核心不是找單一特例股，而是先判斷族群是否被資金青睞，再從族群內拆出龍頭、高純度彈性股與補漲/事件股。
- 對強勢族群，**優先依 task.stageSignals 的客觀訊號判斷 stage，再用產業知識微調；可覆寫但須合理**。對應規則如下：
  - `啟動`：`consecutiveDaysInStrong <= 1` 且 `instNetDirection = buy` 且 `leaderConcentration = leader-only` 且 `highDayTrade = false`。代表剛進場、法人帶龍頭先動、尚未擴散。
  - `擴散`：`consecutiveDaysInStrong >= 2` 且（`memberCountDelta > 0` 或 `leaderConcentration = broad`）且 `instNetDirection != sell`。代表族群連強、成員擴大、法人未明顯調節。
  - `高潮`：`instVsPriceDivergence = true`（價漲但法人淨賣）或 `highDayTrade = true` 或 `speculativeRatio` 偏高（補漲、低流通投機股佔多數）。任一成立即可考慮標高潮。
  - `退潮`：`retreatSignal = true` 或（`groupAvgPct < 0` 且 `instNetDirection = sell`）。前者代表曾強勢現轉弱，後者代表法人賣且族群整體收黑。
  - 訊號不足、相互矛盾、或強弱混雜時，**不要硬標 stage**，維持省略原則。
- story 與 summary 可引用這些訊號當敘事依據，但**不要把 stageSignals 的欄位名稱或原始數字直接貼進報告**，翻成人話：
  - `instNetDirection=buy` → 「法人持續買超」；`instVsPriceDivergence=true` → 「價漲但法人同步調節」；`highDayTrade=true` → 「當沖比重偏高，投機性升溫」；`leaderConcentration=broad` → 「龍頭與成員同步擴散」；`consecutiveDaysInStrong` → 「連續 N 日出現強勢榜」；`memberCountDelta > 0` → 「今日入榜成員較前日增加」。
- 不要每一組都硬塞階段標籤；只在判斷有價值時寫進 story 或 summary。
- 長線策略判斷集中寫在 `longTermStrategy`；每日 `summary` 與各族群 `story` 聚焦當日資金流、催化與分化，不要混成長線選股段落。
- `longTermStrategy` 要點出「為什麼未來 1-2 年仍可能被交易」：例如 AI 基礎建設瓶頸、報價循環、供給擴產時間、規格升級、資本支出、本土替代、法規/政策長尾。
- 對短線題材要明確降級：槓桿/反向商品、DR、資產經營權、單一公司事件、新掛牌籌碼、純低基期補漲，不要寫成長線主線。
- 若同一族群同時出現在強弱兩邊，`summary` 要說這是「換手/分化/退潮警訊」中的哪一種；不要只說主線仍在。
- 個股描述要偏向族群內地位：龍頭、純度最高、高彈性、補漲、事件股、落後股。避免只重述今天漲跌。
- 對最重要的長線主線族群，`longTermStrategy` 要自然帶出進出場策略：
  - 可加碼/續抱：族群連續出現在強勢榜、龍頭先動且成員擴散、成交量放大、報價/訂單/法說/營收能跟上。
  - 可觀察不追：族群剛啟動但證據不足，或只有少數個股事件支撐，等待連續 2-3 天擴散或基本面驗證。
  - 降低部位/退出：龍頭進弱勢榜、補漲股仍在噴、同族群強弱分化擴大、原本催化被證偽、報價/訂單/毛利沒有兌現，或更強新主線吸走資金。
  - 追價風險：低價股、新掛牌、DR、槓桿商品、單一事件股只可當短線輪動，不要用長線主線的持股邏輯處理。
- 進出場策略要用操盤語氣寫成判斷，不要變成教科書條列；但必須讓讀者看得出「哪些可追、哪些等回測、哪些要降級」。

Step 1. 讀取 `data/market-latest.json`，取得：
- `tradingDate`
- `timestamp`
- `gainers`
- `losers`
- 頂層 `market` block（如存在）：
  - `taiex` / `tpex`：收盤點數與漲跌
  - `breadth`：上漲/下跌/漲停/跌停家數
  - `dayTrade`：上市/上櫃當沖成交量佔比
  - `microFuturesRetail`：微臺散戶淨多空比（`retailNetPct`）與 `dataDate`。**符號解讀（務必照這個，不要寫反）：`retailNetPct > 0` = 散戶淨多（偏多）、`< 0` = 散戶淨空（偏空）。散戶是反指標：散戶淨多偏高＝市場過熱、偏空警訊；散戶淨空偏高＝偏多支撐。**請依當日實際數值的正負來描述「淨多」或「淨空」，不要預設方向。

若 `data/scorecard.json` 存在且 `records` 非空，讀 `aggregates` 作為自我校準參考（例如過去標「擴散」的族群平均 T+5 報酬）。

Step 2. 讀取 `data/memory/` 最近 3 份 markdown，作為波段比較依據。

Step 3. 依 `data/tmp/group-tasks/*.json` 的分類順序，將 `data/tmp/group-results/*.json` 合併回：
- `gainers`
- `losers`
- 每個 `stocks` 陣列必須保留 task 內的股票標籤格式 `名稱(代號)`，例如 `微星(2377)`；不可只輸出股票名稱，因為後續 HTML 會用代號補 Yahoo 股市連結、今日漲跌幅、個股期貨與保證金級距。
- 弱勢族群合併規則固定為：
  1. 先依 `members` 數量由大到小排序，若數量相同則維持 task 檔排序，取前 3 組作為需要分析的弱勢族群
  2. 前 3 組弱勢族群照一般 category 規則輸出 story
  3. 第 4 組以後的弱勢族群全部合併成單一 category：`其他弱勢`
  4. `其他弱勢.stocks` 依原本 task 檔順序串接所有股票，`story` 必須是空字串，不要補原因、註解或風險提示
- 每個需要分析的 category 的 `story` 合併規則固定為：
  1. 先找同名 task 的 worker result `story`
  2. 找不到就將 task 內的 `preliminaryStory` 改寫成可讀報告文字
  3. 還是沒有才留空
  4. 若 story 含有上述禁用模板句，必須改寫後再寫入 `analysis-latest.json`

Step 4. 寫入 `data/analysis-latest.json`，格式必須是：
```json
{
  "timestamp": "...",
  "date": "YYYY-MM-DD",
  "gainers": [{"category":"...","stocks":["名稱(代號)"],"story":"...","confidence":"high","stage":"擴散"}],
  "losers": [{"category":"...","stocks":["名稱(代號)"],"story":"...","confidence":"medium","retreatSignal":true}],
  "summary": "...",
  "longTermStrategy": "..."
}
```

欄位說明：
- `confidence`：沿用 worker result 的 `confidence` 值；若用 `preliminaryStory` fallback 則設 `"low"`；值限 `"high"` / `"medium"` / `"low"`
- `stage`（可選）：只在有把握時加，值限 `"啟動"` / `"擴散"` / `"高潮"` / `"退潮"`；不確定就省略
- `retreatSignal`（可選）：task JSON 帶有 `retreatSignal: true` 的弱勢族群必須在輸出物件加此欄

Step 5. 撰寫 `summary`：
- 用繁體中文
- 250 字內
- 口吻偏資深台股操盤手
- 以做多視角為主
- 對照最近 3 份 memory，指出哪些族群連強、哪些新進場、哪些有反轉跡象
- 依策略判讀規則，把當日最值得追蹤的族群分成 `主線延續`、`新主線`、`補漲/事件`、`退潮或分化警訊`，但用自然語句寫，不要輸出表格
- **持股水位與市場溫度必須引用 `market` block 的數字**：例如漲停家數、微臺散戶淨多空比（依 `retailNetPct` 正負判定淨多或淨空，散戶為反指標）、市場整體當沖比重；`market` 為 null 時此部分省略
- 這一段只講當日盤面狀況與短線資金階段，不要寫未來 1-2 年配置或進出場策略

Step 6. 撰寫 `longTermStrategy`：
- 用繁體中文
- 350 到 600 字
- 這是 email HTML 中獨立呈現的長線策略區塊，和當日 `summary` 分開
- 依最近 3 份 memory 與當日強弱名單，只挑 1-3 條最值得未來 1-2 年持續追蹤的主線，不要把所有強勢族群都列入
- 每條主線要交代：長期需求/供給或規格升級邏輯、族群內應優先追蹤的龍頭或高純度個股、目前階段偏向續抱/等回測/確認後加碼
- 最後必須交代降級或退出訊號，例如龍頭轉弱、補漲取代龍頭、報價/訂單/毛利未兌現、主線被資金移轉
- 對槓桿/反向商品、DR、資產經營權、單一事件、新掛牌與純補漲題材，明確說明不列入長線核心
- 若 `data/scorecard.json` 的 `records` 非空，在結尾用一句自然語句帶出系統近期命中狀況（例如「近期標記擴散的族群 T+5 平均報酬 X%，持股信心維持正向」）；`records` 為空就完全不提

Step 7. 寫入 `data/memory/<tradingDate>.md`，格式：
```md
---
date: YYYY-MM-DD
timestamp: ...
---

## 盤後總結

...

## 強勢族群

- 類別: N檔 — 代表股...

## 弱勢族群

- 類別: N檔 — 代表股...
```

Step 8. 最後簡短回報：
- 當日時間戳
- 強勢幾組 / 弱勢幾組
- 哪些 worker 結果缺失（若有）
