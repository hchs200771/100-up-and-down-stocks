請在目前專案目錄執行「台股盤後族群切 task」流程，直接修改/產出專案內檔案。

目標：
1. 讀取 `data/market-latest.json`
2. 將 `gainers` 與 `losers` 各 100 檔依族群性分類
3. 將每個族群拆成一個 task 檔，寫入 `data/tmp/group-tasks/`
4. 不要產出最終報告，這一步只負責切 task

重要限制：
- 不要使用任何外部 AI API SDK。
- 不要修改 `src/services/aiService.ts`。
- 這一步原則上不要使用 web search；只在股票定位不確定、且會影響族群歸類時，才查 1 次最精準關鍵字。
- 類別要細分，不要用「電子」這種大雜燴。
- 類別名稱要用真正驅動股價的主題或產業鏈位置，不要只用公司傳統產業別。
- 強勢與弱勢都要切 task。
- 弱勢股後續只會對「成員數最多的前 3 個族群」做第二階段 research，所以所有弱勢 task 都要先附一段第一階段簡述，供後續直接沿用。
- 若 `data/tmp/group-tasks/` 已存在舊檔，先清空再重建。
- 每個 task 檔的檔名要穩定、可讀，建議格式：`01-gainer-dram-nand.json`
- 產出前必須檢查 `gainers` 與 `losers` 各 100 檔是否都剛好出現在一個 task 中。
- 若檢查發現漏掉股票，不要停下來等待或反覆重寫大型腳本；直接把漏掉的強勢股放入「其他強勢個股事件整理」、漏掉的弱勢股放入「其他弱勢個股事件整理」，並完成寫檔。
- 若檢查發現同一檔股票重複出現在多個 task，保留較精準題材分類，移除較籠統分類中的重複項。

執行步驟：

Step 1. 讀取 `data/market-latest.json`，只取：
- `tradingDate`
- `timestamp`
- `gainers[].{code,name,pct}`
- `losers[].{code,name,pct}`

Step 2. 讀取 `data/memory/` 最近 3 份 markdown（若存在），供你理解近期主流，但這一步不用寫 summary。

Step 3. 分別將 `gainers` / `losers` 分成細族群：
- 每組至少要有 `category`、`direction`、`stocks`、`preliminaryStory`
- `direction` 只能是 `gainer` 或 `loser`
- `stocks` 內容固定為 `股票名稱(代號)`
- `members` 需保留 `{code,name,pct}`
- 可加 `queryHints`
- `preliminaryStory` 是第一階段的短摘要：
  - 強勢股要寫出這個題材的交易亮點，例如需求升級、報價、庫存、規格切換、資本支出、政策或代表股事件。
  - 弱勢股要寫出賣壓來源與原本市場亮點，例如前波漲多後籌碼調節、報價預期降溫、庫存疑慮、長假前資金收斂、法人賣壓或個股事件。
  - 這段不需要額外深搜新聞，但要像可直接放進報告的分析文字，不要像流程註解。
  - 禁止使用「同步轉強」、「同步轉弱」、「初步看」、「若缺乏新聞」、「報告應」、「族群性較弱」、「較偏個股事件整理」這類模板句。

細分類規則：
- 低軌衛星、衛星通訊、微波通訊優先於一般 PCB、網通、光通訊。例如 `華通(2313)` 應優先歸在「低軌衛星/HDI高階PCB」，不是一般「PCB/CCL」；`昇達科(3491)` 應優先歸在「低軌衛星/微波通訊」。
- 記憶體要拆細，不要和其他半導體或電子零組件混在一起。`DRAM/NAND記憶體模組與控制IC`、`記憶體封測`、`矽晶圓/半導體基板` 應分開；不要把威剛、十銓、群聯、商丞、晶豪科、華東與環球晶混成一組。
- IC 設計也要拆細。電源管理 IC、記憶體控制 IC、ASIC/IP、高速介面、驅動 IC、RF/射頻不可混成單一「IC設計」。
- PCB 要拆成 `AI伺服器/HDI高階PCB`、`ABF/BT載板`、`CCL/銅箔基板`、`傳統PCB/EMS板廠`、`鑽針/耗材`；只有明確同一鏈條才合併。
- 光通訊/CPO、低軌衛星、一般網通交換器、LED/顯示、面板材料要分開，不要用「光電/通訊」大類合併。
- 若某檔股票同時有傳統產業與熱門題材，優先用當前市場通常交易的題材分類；但 `preliminaryStory` 要點出它和傳統分類的差異。

Step 4. 將每個族群各自寫成一個 JSON 檔到 `data/tmp/group-tasks/`

每個 task 檔格式固定為：
```json
{
  "tradingDate": "YYYY-MM-DD",
  "timestamp": "...",
  "category": "...",
  "direction": "gainer",
  "stocks": ["股票名稱(1234)"],
  "members": [{"code":"1234","name":"...","pct":12.34}],
  "preliminaryStory": "...",
  "queryHints": ["...", "..."]
}
```

Step 5. 最後簡短回報：
- 一共切出幾個 task
- 強勢幾組 / 弱勢幾組
- task 目錄路徑
