請在目前專案目錄執行「台股盤後報告 finalizer」流程，直接修改/產出專案內檔案。

目標：
1. 讀取 `data/market-latest.json`
2. 讀取 `data/tmp/group-tasks/*.json`
3. 讀取 `data/tmp/group-results/*.json`
4. 合併成 `data/analysis-latest.json`
5. 寫入 `data/memory/<tradingDate>.md`
6. 最後簡短回報

重要限制：
- 不要重新抓市場資料。
- 不要執行寄信腳本。
- `analysis.date` 與 memory 檔名一律使用 `data/market-latest.json` 內的 `tradingDate`
- 若某些 worker 結果缺失，允許保留空 story，但不要讓整份報告失敗。
- 合併 story 時，優先使用 `data/tmp/group-results/*.json` 的 `story`；若缺失，改用對應 task 檔中的 `preliminaryStory`，但必須先去除模板廢話並補成完整分析；若連 `preliminaryStory` 都沒有，才留空。
- 報告中的 story 不可以出現這些模板句或同義句：`最近 2 天沒有`、`最近 3 天沒有`、`沒有查到`、`沒有看到`、`族群性較弱`、`較偏個股事件整理`、`同步轉強`、`同步轉弱`、`初步看`、`若缺乏`、`報告應`、`fallback`。
- 不要重複畫面已經知道的方向：強勢區不要說「上漲/轉強」，弱勢區不要說「下跌/轉弱」。直接講原因、題材、籌碼與代表股。
- 即使 worker 缺失，也要用 task 的 category、members、queryHints、最近 memory 與你的產業知識寫出 80 到 220 字的專業故事，不可只寫風險提示或空泛分類。

Step 1. 讀取 `data/market-latest.json`，取得：
- `tradingDate`
- `timestamp`
- `gainers`
- `losers`

Step 2. 讀取 `data/memory/` 最近 2 份 markdown，作為波段比較依據。

Step 3. 依 `data/tmp/group-tasks/*.json` 的分類順序，將 `data/tmp/group-results/*.json` 合併回：
- `gainers`
- `losers`
- 每個 `stocks` 陣列必須保留 task 內的股票標籤格式 `名稱(代號)`，例如 `微星(2377)`；不可只輸出股票名稱，因為後續 HTML 會用代號補 Yahoo 股市連結、今日漲跌幅、個股期貨與保證金級距。
- 每個 category 的 `story` 合併規則固定為：
  1. 先找同名 task 的 worker result `story`
  2. 找不到就將 task 內的 `preliminaryStory` 改寫成可讀報告文字
  3. 還是沒有才留空
  4. 若 story 含有上述禁用模板句，必須改寫後再寫入 `analysis-latest.json`

Step 4. 寫入 `data/analysis-latest.json`，格式必須是：
```json
{
  "timestamp": "...",
  "date": "YYYY-MM-DD",
  "gainers": [{"category":"...","stocks":["名稱(代號)"],"story":"..."}],
  "losers": [{"category":"...","stocks":["名稱(代號)"],"story":"..."}],
  "summary": "..."
}
```

Step 5. 撰寫 `summary`：
- 用繁體中文
- 250 字內
- 口吻偏資深台股操盤手
- 以做多視角為主
- 對照最近 2 份 memory，指出哪些族群連強、哪些新進場、哪些有反轉跡象

Step 6. 寫入 `data/memory/<tradingDate>.md`，格式：
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

Step 7. 最後簡短回報：
- 當日時間戳
- 強勢幾組 / 弱勢幾組
- 哪些 worker 結果缺失（若有）
