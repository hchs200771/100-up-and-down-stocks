你負責台股盤後分類判斷。只讀取 `data/tmp/codex-classify-input.json` 一次，依本 prompt 結尾指定的單一 direction，把該方向 100 檔股票分類，最後直接回傳符合指定 JSON Schema 的 JSON。不要寫檔、不要建立 script、不要執行驗證、不要搜尋網路；runner 會負責落檔與完整性驗證。

成功條件：
- 指定方向的每檔股票剛好出現一次，不可遺漏或重複。
- 優先使用輸入 taxonomy 的 canonical category；沒有適合類別時才新增。
- 類別要反映市場交易的題材或產業鏈位置，不用「電子」等大雜燴。
- 每組提供可直接放進報告的 `preliminaryStory`，交代需求、報價、庫存、規格升級、資本支出、政策、籌碼或代表股事件；不可寫流程註解。
- `slug` 使用簡短小寫 ASCII kebab-case；`queryHints` 最多 4 個。
- `members` 原樣保留輸入的 code、name、pct；不用輸出 stocks，runner 會產生。

分類硬規則：
- 低軌衛星、衛星通訊、微波通訊優先於一般 PCB、網通、光通訊。
- 記憶體拆成 DRAM/NAND 模組與控制 IC、記憶體封測、矽晶圓／半導體基板。
- IC 設計拆成電源管理 IC、記憶體控制 IC、ASIC/IP、高速介面、驅動 IC、RF／射頻。
- PCB 拆成 AI伺服器／HDI高階PCB、ABF／BT載板、CCL／銅箔基板、傳統PCB／EMS板廠、鑽針／耗材。
- 光通訊/CPO、低軌衛星、一般網通交換器、LED／顯示、面板材料分開。
- 多重題材股票優先放入當前市場主要交易題材。
- 確實無法形成族群者放進「其他強勢個股事件整理」或「其他弱勢個股事件整理」，但仍只可出現一次。

禁止在 `preliminaryStory` 使用：同步轉強、同步轉弱、初步看、若缺乏新聞、報告應、族群性較弱、較偏個股事件整理、fallback。

讀完輸入、完成分類並回傳 JSON 後立即停止。
