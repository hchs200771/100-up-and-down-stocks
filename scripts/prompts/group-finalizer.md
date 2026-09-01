請在目前專案目錄執行「台股盤後報告 finalizer」流程，直接修改/產出專案內檔案。

`data/tmp/analysis-skeleton.json` 已經由腳本把 task 與 worker result 機械合併好了：族群配對、story fallback、弱勢合併、stage 判定、entryScore 的 timing / chips / risk 三軸都已經填入。**不要再去讀 `data/tmp/group-tasks/` 或 `data/tmp/group-results/` 的個別檔案**，那些工作已經做完了。

你要做的是骨架做不到、需要產業判斷的部分：`trend` 軸、`entryRationale`、被標記的 story、`summary`、`longTermStrategy`。

目標：
1. 讀取 `data/market-latest.json`
2. 讀取 `data/tmp/analysis-skeleton.json`
3. 補上需要判斷的欄位，寫成 `data/analysis-latest.json`
4. 另寫出獨立的長線策略判斷 `longTermStrategy`
5. 寫入 `data/memory/<tradingDate>.md`
6. 最後簡短回報

重要限制：
- 不要重新抓市場資料。
- 不要執行寄信腳本。
- `analysis.date` 與 memory 檔名一律使用 skeleton 的 `date`（來自 `data/market-latest.json` 的 `tradingDate`）。
- 若某些族群 story 為空且無法補寫，允許保留空 story，但不要讓整份報告失敗。

---

Step 1. 讀取 `data/market-latest.json`，取得：
- `tradingDate`
- `timestamp`
- 頂層 `market` block（如存在）：
  - `taiex` / `tpex`：收盤點數與漲跌
  - `breadth`：上漲/下跌/漲停/跌停家數
  - `dayTrade`：上市/上櫃當沖成交量佔比
  - `microFuturesRetail`：微臺散戶淨多空比（`retailNetPct`）與 `dataDate`。**符號解讀（務必照這個，不要寫反）：`retailNetPct > 0` = 散戶淨多（偏多）、`< 0` = 散戶淨空（偏空）。散戶是反指標：散戶淨多偏高＝市場過熱、偏空警訊；散戶淨空偏高＝偏多支撐。**請依當日實際數值的正負來描述「淨多」或「淨空」，不要預設方向。

不需要讀 `market-latest.json` 的 `gainers` / `losers`，族群與成員都已經在 skeleton 裡。

Step 2. 讀取 `data/tmp/analysis-skeleton.json`。它的結構是：

```json
{
  "timestamp": "...",
  "date": "YYYY-MM-DD",
  "gainers": [{
    "category": "...",
    "stocks": ["名稱(代號)"],
    "story": "...",
    "storySource": "worker | preliminary | none",
    "needsRewrite": false,
    "confidence": "high",
    "stage": "擴散",
    "alsoInLosers": true,
    "scoreBreakdown": {"trend": null, "timing": 24, "chips": 20, "risk": -5},
    "signals": { ... stageSignals 原始訊號 ... }
  }],
  "losers": [{"category":"...","stocks":[...],"story":"...","storySource":"...","needsRewrite":false,"confidence":"medium","retreatSignal":true,"signals":{...}}],
  "summary": "",
  "longTermStrategy": ""
}
```

骨架已經處理完、**你不需要重做也不要推翻**的部分：
- 族群順序、`category` 名稱、`stocks` 內容與 `名稱(代號)` 標籤格式 → 原樣照抄。HTML 端要用代號補 Yahoo 連結、漲跌幅、個股期貨與保證金級距，改動格式會壞掉。
- 弱勢族群的合併：前 3 大（依成員數）∪ 任何 `retreatSignal` 已經留下來，其餘已併成 `其他弱勢`。**不要重新排序、不要把 `其他弱勢` 拆開、不要給它 story**（它的 `story` 必須維持空字串，不補原因、註解或風險提示）。
- `confidence` 已依 worker result 或 fallback 規則填好，照抄。

Step 3. 讀取 `data/memory/` 最近 3 份 markdown，作為波段比較依據。若 `data/scorecard.json` 存在且 `records` 非空，讀 `aggregates` 作為自我校準參考（例如過去標「擴散」的族群平均 T+5 報酬）。

Step 4. 逐一處理 story。

- `needsRewrite: false` → **原樣照抄，不要潤飾、不要重寫**。這是省時間的關鍵，這些 story 已經是成品。
- `needsRewrite: true` → 依 `storySource` 處理：
  - `worker`：story 內含下列禁用模板句之一，改寫掉再輸出，保留原有的事實與數字。
  - `preliminary`：這是分類階段的草稿，要改寫成完整分析。
  - `none`：worker 缺失且無草稿，你要用 `category`、`stocks`、`signals`、最近 memory 與你的產業知識自己寫出 80 到 220 字的專業故事，不可只寫風險提示或空泛分類。

禁用模板句或其同義句：`最近 2 天沒有`、`最近 3 天沒有`、`沒有查到`、`沒有看到`、`族群性較弱`、`較偏個股事件整理`、`同步轉強`、`同步轉弱`、`初步看`、`若缺乏`、`報告應`、`fallback`。

story 撰寫規則（只適用於你要寫或改寫的那些）：
- 不要重複畫面已經知道的方向：強勢區不要說「上漲/轉強」，弱勢區不要說「下跌/轉弱」。直接講原因、題材、籌碼與代表股。
- 個股描述要偏向族群內地位：龍頭、純度最高、高彈性、補漲、事件股、落後股。避免只重述今天漲跌。
- 帶 `retreatSignal: true` 的弱勢族群，story 必須點出「這是換手、分化、還是退潮」（因為它前幾日出現在強勢榜）。
- 弱勢族群若有成員帶 `overnightDump`（見 `signals` 或成員旗標），必須把「隔日沖出貨調節」與族群基本面題材分開說明：先交代該股是昨漲停今爆當沖收黑的投機性出貨，再講族群整體的產業或籌碼邏輯；不可把隔日沖個股當作族群基本面惡化的代表。
- 可以引用 `signals` 當敘事依據，但**不要把欄位名稱或原始數字直接貼進報告**，翻成人話：
  - `instNetDirection=buy` → 「法人持續買超」；`instVsPriceDivergence=true` → 「價漲但法人同步調節」；`highDayTrade=true` → 「當沖比重偏高，投機性升溫」；`leaderConcentration=broad` → 「龍頭與成員同步擴散」；`consecutiveDaysInStrong` → 「連續 N 日出現強勢榜」；`memberCountDelta > 0` → 「今日入榜成員較前日增加」。

Step 5. 為每個**強勢族群**完成進場評分（弱勢族群不輸出任何評分欄位）。

核心觀念：分數量化的是「現在進場的 risk/reward」，不是「今天有多強」。剛起漲、上檔空間大、下檔風險小 → 高分；已經漲多進入高潮、上檔有限下檔大 → 低分。所以最強勢、最熱門的族群常常分數中等甚至偏低，這是正確的。

- **`scoreBreakdown.trend`（0-40）— 值不值得放錢 1-2 年。這一軸骨架給 `null`，一定要你填。** 與 `longTermStrategy` 用同一套判斷：
  - 35-40：結構性多年主線（供需瓶頸、規格升級、資本支出循環向上，如 AI 基建、記憶體循環、先進封裝、電力）。
  - 20-30：真產業題材但屬中期、會有報價/庫存週期波動。
  - 5-15：短線題材（補漲、單一公司事件、一次性政策利多）。
  - 0：純籌碼投機（DR、槓桿反向、資產股、新掛牌炒作）。
- `timing` / `chips` / `risk` 三軸骨架已經依規則填好，**預設沿用**。只有在你有明確產業理由認為判錯時才覆寫，並在 `entryRationale` 讓讀者看得出理由；不要無理由地整批調整。三軸的原始規則供你判斷是否合理：
  - `timing`（0-35）吃 stage：`啟動` 30-35（上檔最大、下檔最小，最佳佈局點）、`擴散` 20-28（主升段，可進但要有紀律）、`高潮` 5-12（減碼點不是進場點）、`退潮` 0-5（反向訊號，不放新錢）。
  - `chips`（0-25）：外資**且**投信同向買超、龍頭先動 → 20-25；單一法人買或 mixed → 10-15；法人淨賣 → 0-5。
  - `risk`（-30-0）逐項累減：`avgDayTradeRatio > 40%` → -10；投機/低流通股佔多 → -5~-10；成員含 `attention`/`disposition`/`lowLiquidity` → -5；任一成員 `overnightDump` → -10。
- `stage` 骨架已依客觀訊號判定，**可覆寫但須合理**；骨架在訊號不足或矛盾時會省略 `stage`，你若有把握可以補上，沒把握就維持省略，不要硬標。若你改了 `stage`，`timing` 要一併改成對應級距。
- `entryScore` = 四軸相加，**必須完全等於 `trend + timing + chips + risk`**。
- `entryAction` 依 `entryScore` 機械對應：≥85 `核心加碼`、70-84 `標準持有`、55-69 `觀察不追`、<55 `不碰減碼`。
- `entryRationale`：一句話（繁中、40 字內）用操盤語氣交代分數從哪來＋現在該怎麼做，不要逐軸報數字、不要貼欄位名。例如「長線主線＋擴散中、法人續買，可作底倉」。
- 若 `data/scorecard.json` 的 `aggregates` 顯示某 stage 的 T+5 報酬與直覺明顯背離，可在 `timing` 軸內微調 ±3，但不要大幅推翻規則。

Step 6. 寫入 `data/analysis-latest.json`，格式必須是：
```json
{
  "timestamp": "...",
  "date": "YYYY-MM-DD",
  "gainers": [{"category":"...","stocks":["名稱(代號)"],"story":"...","confidence":"high","stage":"擴散","entryScore":81,"scoreBreakdown":{"trend":38,"timing":25,"chips":18,"risk":0},"entryAction":"標準持有","entryRationale":"..."}],
  "losers": [{"category":"...","stocks":["名稱(代號)"],"story":"...","confidence":"medium","retreatSignal":true}],
  "summary": "...",
  "longTermStrategy": "..."
}
```

欄位說明：
- `timestamp` / `date`：沿用 skeleton
- `confidence`：沿用 skeleton，值限 `"high"` / `"medium"` / `"low"`
- `stage`（可選，只有強勢族群）：沿用或覆寫 skeleton，值限 `"啟動"` / `"擴散"` / `"高潮"` / `"退潮"`；skeleton 省略且你沒把握就繼續省略
- `retreatSignal`（可選，只有弱勢族群）：skeleton 帶此欄的族群必須原樣保留
- `entryScore`（強勢族群必填，弱勢族群不輸出）：0-100 整數
- `scoreBreakdown`（有 `entryScore` 時必填）：`{"trend":A,"timing":B,"chips":C,"risk":D}`，四項相加須等於 `entryScore`；`trend` 不可留 `null`
- `entryAction` / `entryRationale`（有 `entryScore` 時必填）
- **`storySource`、`needsRewrite`、`signals`、`alsoInLosers` 是骨架的工作欄位，不要寫進 `analysis-latest.json`**

Step 7. 撰寫 `summary`：
- 用繁體中文
- 250 字內
- 口吻偏資深台股操盤手
- 以做多視角為主
- 對照最近 3 份 memory，指出哪些族群連強、哪些新進場、哪些有反轉跡象
- 把當日最值得追蹤的族群分成 `主線延續`、`新主線`、`補漲/事件`、`退潮或分化警訊`，但用自然語句寫，不要輸出表格
- 帶 `alsoInLosers: true` 的族群代表同一族群同時出現在強弱兩邊，`summary` 要說這是「換手/分化/退潮警訊」中的哪一種；不要只說主線仍在
- **持股水位與市場溫度必須引用 `market` block 的數字**：例如漲停家數、微臺散戶淨多空比（依 `retailNetPct` 正負判定淨多或淨空，散戶為反指標）、市場整體當沖比重；`market` 為 null 時此部分省略
- 這一段只講當日盤面狀況與短線資金階段，不要寫未來 1-2 年配置或進出場策略

Step 8. 撰寫 `longTermStrategy`：
- 用繁體中文
- 350 到 600 字
- 這是 email HTML 中獨立呈現的長線策略區塊，和當日 `summary` 分開
- 報告核心不是找單一特例股，而是先判斷族群是否被資金青睞，再從族群內拆出龍頭、高純度彈性股與補漲/事件股
- 依最近 3 份 memory 與當日強弱名單，只挑 1-3 條最值得未來 1-2 年持續追蹤的主線，不要把所有強勢族群都列入
- 每條主線要交代：長期需求/供給或規格升級邏輯、族群內應優先追蹤的龍頭或高純度個股、目前階段偏向續抱/等回測/確認後加碼
- 要點出「為什麼未來 1-2 年仍可能被交易」：例如 AI 基礎建設瓶頸、報價循環、供給擴產時間、規格升級、資本支出、本土替代、法規/政策長尾
- 要自然帶出進出場策略，用操盤語氣寫成判斷，不要變成教科書條列；但必須讓讀者看得出「哪些可追、哪些等回測、哪些要降級」：
  - 可加碼/續抱：族群連續出現在強勢榜、龍頭先動且成員擴散、成交量放大、報價/訂單/法說/營收能跟上
  - 可觀察不追：族群剛啟動但證據不足，或只有少數個股事件支撐，等待連續 2-3 天擴散或基本面驗證
  - 降低部位/退出：龍頭進弱勢榜、補漲股仍在噴、同族群強弱分化擴大、原本催化被證偽、報價/訂單/毛利沒有兌現，或更強新主線吸走資金
- 對短線題材要明確降級：槓桿/反向商品、DR、資產經營權、單一公司事件、新掛牌籌碼、純低基期補漲，不要寫成長線主線，明確說明不列入長線核心；這類只可當短線輪動，不要用長線主線的持股邏輯處理
- 若 `data/scorecard.json` 的 `records` 非空，在結尾用一句自然語句帶出系統近期命中狀況（例如「近期標記擴散的族群 T+5 平均報酬 X%，持股信心維持正向」）；`records` 為空就完全不提

Step 9. 寫入 `data/memory/<tradingDate>.md`，格式：
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

Step 10. 最後簡短回報：
- 當日時間戳
- 強勢幾組 / 弱勢幾組
- 改寫了幾段 story（skeleton 標 `needsRewrite` 的數量）
