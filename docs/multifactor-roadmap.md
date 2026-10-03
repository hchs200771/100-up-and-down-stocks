# 多因子選股改版路線圖

> 目標：讓「終極選股池」（`scripts/build-stock-picks.ts`）的權重由數據決定，而不是手感；
> 用「扣大盤、扣成本、隔日才進場」的真實勝率／期望值來評估，逐步提高命中率。
>
> 撰寫日期：2026-09-30。依 2026-09-02 的 `data/stock-picks-latest.json` 與目前程式碼審閱而來，
> 尚未用實際歷史資料驗證（歷史資料只在 Mac 上，repo 內被 `.gitignore` 排除）。

## 為什麼要改：目前的六個問題

1. **選股從沒被驗證過。** `data/stock-picks-history/` 每天都存，但沒有任何腳本回頭算這些股票後來漲跌；
   `scorecard.json` 只評族群，不評個股。所有權重（`+22`、`-14`…）都未經校正。
2. **「共振」其實是同一個訊號。** 短線的「動能強」「族群啟動」「RRG 領先」量的都是「這族群最近在漲」，
   `sources >= 2` 門檻形同虛設。09-02 短線 10 檔有 6 檔是光學鏡頭。
3. **有資料就加分、沒資料算 0。** 出現在越多資料源的股票分數越高；當沖比只有漲跌榜內的股票有值，
   09-02 短線 10 檔裡 5 檔是空值，當沖過熱的扣分根本沒檢查到。
4. **長短線分數不同尺度卻直接比較。** 09-02 長線 17–28 分、短線 64–89 分，去重時幾乎都判給短線；
   長線榜 10 檔全是「CB+設質」再加一個訊號。
5. **動能百分位只在候選池內排。** 候選池本身已偏強勢，「前 30%」不是全市場的前 30%。
6. **族群記分板偏樂觀。** 用訊號當日收盤當進場價（報告收盤後才出，實際最快是隔日開盤）、
   不扣大盤、不扣成本（台股來回手續費＋證交稅約 0.585%）、只看勝率不看期望值。

另外，`regimeNotes`（大盤全面回檔等警告）目前只是附註，沒有真的收緊選股或部位。

## 執行順序總覽

- **Phase 0**（今晚，約 30 分鐘）：盤點 Mac 上有多少歷史資料。
- **Phase 1**（1–2 天）：建「因子面板」與前瞻報酬，開始每天累積。
- **Phase 2**（Phase 1 完成後即可跑，資料越多越準）：逐因子 IC 檢驗、相關矩陣、分群。
- **Phase 3**：重寫合成分數（標準化、缺值中性、分群共振、等權起步）。
- **Phase 4**：組合層級限制（族群上限、流動性硬門檻、ATR 停損）。
- **Phase 5**：大盤環境（regime）控制門檻與檔數。
- **Phase 6**：補台股特有因子（月營收、投信、融資、借券）。

每個 Phase 都要能獨立上線、不破壞 `npm run report`；新腳本失敗時一律 `log warn` 後繼續，
比照 `run-daily-report-codex-parallel.sh` 既有寫法。

---

## Phase 0：盤點歷史資料（今晚先做）

在 Mac 專案根目錄執行：

```bash
git pull
ls data/price-history | wc -l                 # 每日收盤快照天數
ls data/price-history | head -1; ls data/price-history | tail -1
ls data/analysis-history | wc -l              # 族群分析快照天數
ls data/stock-picks-history | wc -l           # 選股快照天數
ls data/tdcc-history data/cb-pledge-history | wc -l
ls data/cache | head                          # RRG 用的 Yahoo 日線快取，看是否含 OHLC 與成交量
npm run report:score                          # 看現有 scorecard 的 byStage / byCall 數字
```

要回答的問題（把結果記在這份文件最下方的「執行紀錄」）：

- [ ] `price-history` 有幾天？（決定價格類因子能回填多長）
- [ ] 有沒有保存每日的 `market-latest.json`（含全市場 `stockMap` 法人／當沖）？
      **預期沒有** → 籌碼類因子只能從今天起往後累積，無法回填。
- [ ] `data/cache/` 的 Yahoo 資料是否有開盤價、成交量？有的話可用來算「隔日開盤進場」與流動性。
- [ ] 現有 `scorecard.json` 的 `byCall`：「順勢」的 T+5 勝率是否明顯高於「反轉」？
      沒有明顯差距 → LLM 的 call 在 Phase 3 先不給權重。

---

## Phase 1：因子面板與前瞻報酬（最優先）

### 1-1 每日存下完整候選池的因子原始值

- 修改 `scripts/build-stock-picks.ts`：在評分前，把 **所有** `feats`（不是只有前 10 名）的原始因子值
  寫到 `data/factor-panel/<date>.jsonl`，一行一檔。
- 欄位至少包含：`code, close, r10, r20, ma10, ma20, distHigh, aboveMa20, dayTrade, foreignNet, trustNet,
  totalNet, foreignBuyStreak, trustBuyStreak, tdccView, tdccScore, tdccDCum, tdccStreak, cbScore,
  pledgeRatio, quadrant, sector, groupCall, groupStage, lowLiquidity, flags`。
- 缺值寫 `null`，**不要**寫 0（Phase 3 要能區分「沒資料」和「數值為 0」）。
- 同時把 `market.stockMap` 壓縮存一份到 `data/market-archive/<date>.json.gz`，之後新增因子時才能回算。
- 兩個目錄都加進 `.gitignore`（資料量大且可再生）。

### 1-2 補開盤價

- `scripts/fetch-market-data.ts` 目前只存 `closeMap`。TWSE `STOCK_DAY_ALL`／TPEx 日行情都有開盤價，
  加一個 `openMap`，`score-report.ts` 同步存到 `data/price-history-open/<date>.json`。
- 在開盤價累積起來前，前瞻報酬先用「T+1 收盤」當進場價（保守代理），並在輸出中標註。

### 1-3 新增 `scripts/backtest-factors.ts`

對每個面板日期 D、每檔股票算：

- 進場價：D 的下一個交易日開盤（沒有就用 T+1 收盤）。
- 前瞻報酬：T+5、T+10、T+20 收盤相對進場價。
- **超額報酬**：減去同期加權指數報酬（`data/market-history.json` 的 `taiexClose`）。
- **淨報酬**：再扣 0.585% 來回成本。
- 輸出 `data/backtest/panel-with-returns.jsonl`。

同時回測既有選股：讀 `data/stock-picks-history/*.json`，對長線／短線榜分別算
勝率、平均超額報酬、盈虧比、期望值，輸出 `data/backtest/picks-report.json`
並在終端印出摘要。這就是「目前系統的真實成績單」，之後每次改版都要跟它比。

### 1-4 回填價格類因子

`r10 / r20 / ma / distHigh` 只需要 `price-history`，可以對過去每一天回算（嚴格只用當天以前的資料）。
寫成 `backtest-factors.ts --backfill-price`，讓 Phase 2 不用等三個月才有東西看。

### 1-5 接進每日流程與 npm scripts

- `package.json` 加 `"backtest": "tsx scripts/backtest-factors.ts"`。
- `run-daily-report-codex-parallel.sh` 在 `stock-picks` 之後加一行 `timed backtest run_tsx scripts/backtest-factors.ts || log "[warn] ..."`。
- 補 `tests/backtest-factors.test.ts`：驗證進場日＝下一交易日、超額報酬計算、不偷看未來資料。

**Phase 1 驗收**：`npm run backtest` 能印出既有選股的勝率與期望值；`data/factor-panel/` 每天多一個檔案。

---

## Phase 2：逐因子檢驗

新增 `scripts/analyze-factors.ts`（可以是 `backtest-factors.ts` 的子指令），輸出 `data/backtest/factor-report.md`：

- **Rank IC**：每天把因子排名和 T+5／T+10／T+20 超額報酬排名算 Spearman 相關，列出平均 IC、IC 標準差、
  IR（平均／標準差）、IC > 0 的天數比例。
- **分位數報酬**：因子分五組，看最高組 − 最低組的平均超額報酬，並看五組是不是單調。
- **衰退**：同一因子在 T+1／5／10／20 的 IC，決定它該放在短線還是長線。
- **因子相關矩陣**：相關 > 0.6 的歸成同一群。預期的分群：
  - 價格動能群：`r10` 百分位、`r20`、RRG 象限、族群連漲天數、`distHigh`
  - 法人籌碼群：外資／投信淨買、連買天數、外投同向
  - 大戶／公司派群：TDCC 背離／同向、CB+設質分數
  - 風險群：當沖比、流動性、注意／處置、漲停
- **LLM 判斷**：`groupCall`、`groupStage` 也當因子跑一次 IC，有顯著預測力才保留權重。

判讀原則：

- 樣本少於 40 個交易日的結果只當參考，不改權重。
- |平均 IC| < 0.02 或 IC > 0 的天數比例低於 55% 的因子，視為無效。
- 只在某一段時間有效的因子，要到 Phase 5 用分環境 IC 再確認。

**Phase 2 驗收**：`factor-report.md` 能回答「哪幾個因子真的有用、分成幾群、各適合幾天的持有期」。

---

## Phase 3：重寫合成分數

修改 `scripts/build-stock-picks.ts`（保留舊版函式，用環境變數 `PICKS_SCORING=v2` 切換，並排跑兩週比較）：

1. **全市場標準化**：每個因子在「當日全市場」（不是候選池）轉成百分位排名或 z-score，
   截尾在 ±3。全市場資料來自 `stockMap` 與 `price-history`。
2. **缺值給中性**：沒資料＝該因子得分 0（中位數），不加不扣。
3. **群內先合、群間再合**：同群因子先平均成一個群分數，再把各群加權，避免同一件事重複計分。
4. **權重**：先用等權。Phase 2 累積到 60 個交易日以上後，改成「50% 等權 + 50% IC-IR 權重」，
   之後每月更新一次，每次調整幅度上限 ±20%，避免過度擬合。
5. **共振門檻**：改成「至少 2 個 **不同群** 的分數 > 0.5 個標準差」。
6. **長短線去重**：兩張榜各自轉成百分位後再比較，誰的百分位高就放哪邊。
7. **當沖比**：沒有值的股票，用 `market-archive` 補算或標記「未檢查」，不能默默當作安全。

**Phase 3 驗收**：v2 與 v1 並排兩週以上；`picks-report.json` 顯示 v2 的淨期望值高於 v1 才切換為預設。

---

## Phase 4：組合層級限制

在 `build-stock-picks.ts` 選股之後加一層：

- 同一族群（`sector`）每張榜最多 3 檔。
- 流動性改成**硬門檻**：20 日平均成交金額 ≥ 5,000 萬（數值用 Phase 2 資料再校準）；注意股、處置股直接排除。
- 停損改用 ATR：`進場價 − 2 × ATR(14)`，取代固定 −8%。需要最高價和最低價，
  沒有的話先用 20 日收盤標準差代替。
- 建議部位：以「每檔虧到停損時虧損占總資金 1%」反推張數，寫進 `plan`。

---

## Phase 5：大盤環境控制

新增 `scripts/lib/regime.ts`，每天輸出 `bull | neutral | bear`，依據：

- 加權指數對 MA20／MA60 的位置
- 上漲下跌家數比的 10 日平均（`market-history.json` 的 `up`／`down`）
- 微台散戶多空比（已有 `retailNetPct`）
- 融資餘額變化（`data/margin-history.json`）

用法：

- `bear`：共振門檻從 2 群提高到 3 群，每張榜最多 5 檔，只保留長線的「背離佈局」型。
- `neutral`：維持預設。
- `bull`：維持預設，可放寬族群上限到 4 檔。
- Phase 2 的 IC 報告加一欄「分環境 IC」，確認每個因子在不同環境下是否都有效。

---

## Phase 6：補台股特有因子

依 Phase 2 驗證完再決定權重，優先順序：

1. **月營收年增率與加速度**：公開資訊觀測站每月 10 日前公布。要注意**公布日**才能用，
   不能用所屬月份當日期（避免偷看未來）。預期是最強的基本面因子。
2. **投信連買**：`chips.trustBuyStreak` 已存在，但目前短線評分幾乎沒用；對中小型股特別有效。
3. **融資增減、券資比**：`fetch-margin-options.ts` 已在抓大盤融資，擴充到個股。
4. **借券賣出餘額**：外資放空的領先訊號。
5. **季底投信作帳**：季底前三週、投信持股比例高的股票加一個日曆因子。

所有新因子都遵守同一個原則：**先進 `factor-panel`、先過 Phase 2 的 IC 檢驗，才進評分。**

---

## 防止偷看未來（每個 Phase 都要檢查）

- TDCC 集保資料的「資料基準日」和「公布日」不同，面板要用公布日（實際拿得到的那天），不是基準日。
- CB+設質、月營收同理，都用公布日。
- 回填價格因子時，第 D 天只能用 D 以前（含 D）的收盤。
- RRG、族群分類若會用到整段資料重算，回測時必須逐日重建，不能直接用今天的結果套過去。

## 在 Mac 上交給 AI 執行的建議方式

一次只做一個 Phase，對 Claude Code 或 Codex 說：

> 依 `docs/multifactor-roadmap.md` 執行 Phase 1（1-1 到 1-5），完成後跑 `npm test`、`npm run lint`、
> `npm run backtest`，把結果貼在文件最下方的「執行紀錄」並 commit。

## 執行紀錄

（Phase 0 盤點結果、各 Phase 完成日期與回測數字寫在這裡）
