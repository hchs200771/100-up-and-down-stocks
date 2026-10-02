# 全市場固定規則回測結果

本文件由 results.json 機械產生，不加入主觀挑選或結論。

## 母體與資料覆蓋

歷史資料涵蓋 **2084 檔唯一代碼、1880 個交易日**（2019-01-02 至 2026-09-30）。按原始每20日調倉phase，預計 **81 個訊號窗口**，其中來源完整、可回測 **30 個**；其餘 51 個因窗口內來源日期不完整而跳過。下列表格只含可回測covered windows，不能解讀為連續完整的2020–2026績效。四碼一般股票母體按歷史每日上市櫃資料建立，含四碼TDR，排除ETF、權證與興櫃，不用今日選股結果倒推歷史。

| 來源 | 完整交易日 | 總交易日 | 缺資料日 |
| --- | ---: | ---: | ---: |
| TWSE | 1347 | 1880 | 533 |
| TPEX | 1880 | 1880 | 0 |

### 被跳過的訊號月份

| 訊號年月 | 跳過窗口數 | 缺來源日期命中數 |
| --- | ---: | ---: |
| 2021-01 | 1 | 4 |
| 2021-03 | 1 | 24 |
| 2021-04 | 1 | 37 |
| 2021-05 | 1 | 37 |
| 2021-06 | 2 | 86 |
| 2021-07 | 1 | 24 |
| 2021-08 | 1 | 42 |
| 2021-09 | 1 | 49 |
| 2021-10 | 1 | 58 |
| 2021-11 | 1 | 78 |
| 2021-12 | 1 | 81 |
| 2022-01 | 1 | 81 |
| 2022-02 | 1 | 81 |
| 2022-03 | 1 | 81 |
| 2022-04 | 1 | 81 |
| 2022-05 | 1 | 81 |
| 2022-06 | 1 | 81 |
| 2022-07 | 1 | 81 |
| 2022-08 | 1 | 81 |
| 2022-09 | 1 | 80 |
| 2022-10 | 1 | 61 |
| 2022-11 | 1 | 41 |
| 2022-12 | 1 | 21 |
| 2023-01 | 1 | 17 |
| 2023-02 | 1 | 26 |
| 2023-03 | 1 | 26 |
| 2023-04 | 1 | 26 |
| 2023-05 | 1 | 12 |
| 2023-10 | 1 | 18 |
| 2023-11 | 1 | 32 |
| 2023-12 | 1 | 32 |
| 2024-01 | 1 | 34 |
| 2024-02 | 1 | 35 |
| 2024-03 | 1 | 36 |
| 2024-04 | 1 | 44 |
| 2024-05 | 1 | 60 |
| 2024-06 | 1 | 42 |
| 2024-07 | 1 | 26 |
| 2024-08 | 1 | 33 |
| 2024-09 | 1 | 22 |
| 2024-10 | 1 | 22 |
| 2024-11 | 1 | 22 |
| 2024-12 | 1 | 6 |
| 2025-07 | 1 | 1 |
| 2025-08 | 1 | 21 |
| 2025-09 | 1 | 41 |
| 2025-10 | 1 | 53 |
| 2025-11 | 1 | 53 |
| 2025-12 | 1 | 33 |
| 2026-01 | 1 | 13 |

| 訊號日可選股數 | 最少 | 中位數 | 最多 | 原始量能通過數平均 | 因子可計算後數平均 | 平均差額 | 差額合計 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 成交≥100張 | 1024 | 1224 | 1481 | 1250.3 | 1235.2 | 15.1 | 452 |
| 成交≥50張 | 1198 | 1408 | 1650 | 1434.3 | 1413.9 | 20.5 | 614 |

原始量能通過數與因子可計算後數的差額，是61日暖機或所需特徵不足的觀察差，不代表股票從下載母體移除。公司行動代理共觀察到 **38152** 件；未知參考價 / 未解調整事件（含可能的重設）共 **2707** 個股票日期（涉及276檔）。

## 回測方法與解讀

訊號於收盤後形成，下一交易日開盤買進，持有20個交易日並於第20日收盤賣出；每20個交易日換倉。買進成本0.1425%、賣出成本0.4425%。基準使用同期間TAIEX含息指數，入口開盤值由同日價格指數與總報酬指數比例換算。個股調整價是參考價再投資近似，不是實際逐筆現金股利。61個交易日暖機只用於計算指標，不算入績效；成交50/100張門檻在訊號日判斷。Dynamic historical TWSE and TPEx four-digit regular stock rows (including four-digit TDRs, foreign and innovation-board shares); excludes ETFs, warrants and emerging-market stocks; no current listing or popularity screen

選股規則與成本情境依預先固定設定；推論方法：Exploratory 3-cohort circular block bootstrap within contiguous paired-cohort segments only, 10000 draws; Bonferroni across 32 return/win non-baseline comparisons. Provider calendar gaps limit observations; results cannot establish full-period performance. Retrospective chronological validation, no tuning.

勝率上下界將所有無效期分別視為全敗／全勝；有持倉期勝率僅計投入比例大於零的有效期，避免把空手期誤讀為個股交易勝率。每期淨超額＝策略該期淨報酬減同區間TAIEX含息報酬；勝率以20日組合期為單位。配對勝率差欄的bootstrap均值與區間實際單位是百分點（pp），不是比例。32比較校正欄分列配對報酬差與配對勝率差的 familywise CI 及校正 p 值。滑價情境是在原成本外再假設買入、賣出各不利0.5%。

`performance` 為 null 時，原因可能是無效／未解 cohort，也可能是歷史來源缺日造成時間軸不連續；兩者都不能計算連續組合績效與 CAGR。表內仍列covered windows、有效期/總期、單期平均及無效持倉統計，不得把可用窗口當成完整連續回測。

## 全樣本可回測窗口

| 規則 | 有效/總期 | 打敗TAIEX含息勝率（有效期） | 未解期勝率上下界 | 有持倉期勝率 | 每期平均淨報酬 | 每期平均淨超額 | 配對報酬差（對基準） | 配對勝率差（百分點） | 32比較校正CI / p | 平均投入 | 無效持倉股次 | 滑價後平均超額 / 勝率 | 連續CAGR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline: Top10 equal weights | 24/30 | 37.5% | [30.00, 50.00]% | 37.5% | 2.73% | -0.05% | — | — | 基準規則 | 93.3% | 9 | -1.00% / 37.5% | 無法計算 |
| price_ma20: Close > MA20 | 24/30 | 37.5% | [30.00, 50.00]% | 37.5% | 2.74% | -0.05% | 0.00% | 0.00 pp | 報酬 [-0.25, 0.25]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 93.7% | 9 | -1.01% / 37.5% | 無法計算 |
| price_trend: Close > MA20 and MA20 > MA60 | 24/30 | 37.5% | [30.00, 50.00]% | 37.5% | 2.99% | 0.21% | 0.25% | 0.00 pp | 報酬 [-1.03, 2.02]% / p=1.0000；勝率差 [-16.67, 20.83] pp / p=1.0000 | 93.3% | 9 | -0.75% / 37.5% | 無法計算 |
| price_breakout20: Close > prior20-session adjusted high | 24/30 | 33.3% | [26.67, 46.67]% | 33.3% | 0.86% | -2.08% | -2.24% | 0.00 pp | 報酬 [-7.38, 4.75]% / p=1.0000；勝率差 [-54.55, 54.55] pp / p=1.0000 | 94.2% | 7 | -3.02% / 33.3% | 無法計算 |
| price_volume15: Signal volume >1.5x prior20-session mean volume, and signal close >=previous close | 26/30 | 23.1% | [20.00, 33.33]% | 23.1% | -0.16% | -2.78% | -3.46% | -13.64 pp | 報酬 [-8.67, 2.92]% / p=1.0000；勝率差 [-63.64, 45.45] pp / p=1.0000 | 96.2% | 6 | -3.74% / 23.1% | 無法計算 |
| price_lowvol_half: 20-session log-return volatility <= median among contemporaneously eligible stocks | 29/30 | 37.9% | [36.67, 40.00]% | 37.9% | 1.12% | -1.04% | -0.36% | 0.00 pp | 報酬 [-8.84, 8.04]% / p=1.0000；勝率差 [-65.22, 69.57] pp / p=1.0000 | 100.0% | 1 | -2.04% / 31.0% | 無法計算 |
| price_cap_r20: 20-session return <=25% | 29/30 | 51.7% | [50.00, 53.33]% | 51.7% | 2.93% | 0.08% | -1.33% | 4.35 pp | 報酬 [-8.64, 5.22]% / p=1.0000；勝率差 [-47.83, 52.17] pp / p=1.0000 | 98.6% | 2 | -0.94% / 41.4% | 無法計算 |
| market_ma20: TAIEX close > MA20; otherwise cash | 27/30 | 51.9% | [46.67, 56.67]% | 50.0% | 4.18% | 2.09% | 1.97% | 8.33 pp | 報酬 [-0.11, 5.30]% / p=1.0000；勝率差 [0.00, 29.17] pp / p=1.0000 | 61.9% | 5 | 1.43% / 51.9% | 無法計算 |
| market_ma60: TAIEX close > MA60; otherwise cash | 25/30 | 48.0% | [40.00, 56.67]% | 50.0% | 3.59% | 1.13% | 1.01% | 8.33 pp | 報酬 [-3.02, 4.83]% / p=1.0000；勝率差 [-8.33, 29.17] pp / p=1.0000 | 59.2% | 7 | 0.51% / 48.0% | 無法計算 |
| market_breadth: >50% of all contemporaneously observed ordinary shares with features above MA20; require >=500 observations; otherwise cash | 29/30 | 44.8% | [43.33, 46.67]% | 50.0% | 3.32% | 0.82% | 1.28% | 4.17 pp | 報酬 [-5.47, 5.64]% / p=1.0000；勝率差 [-37.50, 29.17] pp / p=1.0000 | 37.2% | 1 | 0.41% / 44.8% | 無法計算 |
| portfolio_top5: Equal-weight top5 | 27/30 | 44.4% | [40.00, 50.00]% | 44.4% | 3.11% | 0.56% | 1.27% | 8.33 pp | 報酬 [-3.82, 7.47]% / p=1.0000；勝率差 [-37.50, 45.83] pp / p=1.0000 | 94.1% | 3 | -0.41% / 44.4% | 無法計算 |
| portfolio_top20: Equal-weight top20 | 21/30 | 42.9% | [30.00, 60.00]% | 42.9% | 1.11% | -1.28% | -0.69% | 9.52 pp | 報酬 [-4.03, 3.06]% / p=1.0000；勝率差 [0.00, 52.38] pp / p=1.0000 | 96.0% | 13 | -2.25% / 38.1% | 無法計算 |
| portfolio_inversevol: Top10 inverse 20-session volatility weights, cap20% per name, unallocatable capital cash | 24/30 | 37.5% | [30.00, 50.00]% | 37.5% | 2.37% | -0.41% | -0.37% | 0.00 pp | 報酬 [-1.43, 0.44]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 93.7% | 9 | -1.37% / 37.5% | 無法計算 |
| event_quarter_half: Only signal dates in final15+ calendar days of Mar/Jun/Sep/Dec; other cohorts cash | 30/30 | 33.3% | [33.33, 33.33]% | 0.0% | -1.36% | -3.71% | -4.43% | -12.50 pp | 報酬 [-12.98, 2.05]% / p=1.0000；勝率差 [-62.50, 45.83] pp / p=1.0000 | 12.3% | 0 | -3.82% / 33.3% | 無法計算 |
| event_post_adjustment5: Observed reference-price corporate adjustment on signal day or within previous5 sessions; not assumed cash-only or pre-announced | 30/30 | 26.7% | [26.67, 26.67]% | 24.1% | -0.47% | -2.82% | -1.88% | -12.50 pp | 報酬 [-9.44, 5.20]% / p=1.0000；勝率差 [-62.50, 29.17] pp / p=1.0000 | 96.2% | 0 | -3.78% / 23.3% | 無法計算 |
| event_avoid_adjustment5: Exclude observed reference-price corporate adjustment within previous5 sessions | 24/30 | 37.5% | [30.00, 50.00]% | 37.5% | 2.71% | -0.07% | -0.02% | 0.00 pp | 報酬 [-0.22, 0.12]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 93.3% | 9 | -1.03% / 37.5% | 無法計算 |
| universe_volume50: Same baseline ranking, but signal-date volume >=50000 shares (50 lots) | 24/30 | 41.7% | [33.33, 53.33]% | 41.7% | 2.59% | -0.19% | -0.14% | 4.17 pp | 報酬 [-1.42, 1.70]% / p=1.0000；勝率差 [0.00, 37.50] pp / p=1.0000 | 93.3% | 9 | -1.14% / 37.5% | 無法計算 |

本表總期為 **30 個source-covered窗口**，只代表資料來源齊全且按原調倉phase可計算的窗口，不是該年份區間的完整計畫期數。勝率與單期均值分母按有效期；有效/總期保留執行無效期。來源中斷或無效執行使連續 performance 為 null，不能計算連續 CAGR；受影響規則：baseline、price_ma20、price_trend、price_breakout20、price_volume15、price_lowvol_half、price_cap_r20、market_ma20、market_ma60、market_breadth、portfolio_top5、portfolio_top20、portfolio_inversevol、event_quarter_half、event_post_adjustment5、event_avoid_adjustment5、universe_volume50。

## 開發期可回測窗口（2020–2023）

| 規則 | 有效/總期 | 打敗TAIEX含息勝率（有效期） | 未解期勝率上下界 | 有持倉期勝率 | 每期平均淨報酬 | 每期平均淨超額 | 配對報酬差（對基準） | 配對勝率差（百分點） | 32比較校正CI / p | 平均投入 | 無效持倉股次 | 滑價後平均超額 / 勝率 | 連續CAGR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline: Top10 equal weights | 14/17 | 21.4% | [17.65, 35.29]% | 21.4% | 1.64% | -0.97% | — | — | 基準規則 | 88.6% | 5 | -1.86% / 21.4% | 無法計算 |
| price_ma20: Close > MA20 | 14/17 | 21.4% | [17.65, 35.29]% | 21.4% | 1.53% | -1.07% | -0.11% | 0.00 pp | 報酬 [-0.43, 0.00]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 89.3% | 5 | -1.98% / 21.4% | 無法計算 |
| price_trend: Close > MA20 and MA20 > MA60 | 14/17 | 28.6% | [23.53, 41.18]% | 28.6% | 2.51% | -0.09% | 0.87% | 7.14 pp | 報酬 [0.00, 3.06]% / p=1.0000；勝率差 [0.00, 28.57] pp / p=1.0000 | 89.3% | 5 | -1.00% / 28.6% | 無法計算 |
| price_breakout20: Close > prior20-session adjusted high | 14/17 | 35.7% | [29.41, 47.06]% | 35.7% | 0.36% | -2.24% | -1.28% | 14.29 pp | 報酬 [-5.37, 8.05]% / p=1.0000；勝率差 [0.00, 71.43] pp / p=1.0000 | 90.7% | 3 | -3.15% / 35.7% | 無法計算 |
| price_volume15: Signal volume >1.5x prior20-session mean volume, and signal close >=previous close | 16/17 | 25.0% | [23.53, 29.41]% | 25.0% | -0.09% | -2.23% | -2.56% | 0.00 pp | 報酬 [-9.59, 5.63]% / p=1.0000；勝率差 [-28.57, 64.29] pp / p=1.0000 | 93.7% | 1 | -3.16% / 25.0% | 無法計算 |
| price_lowvol_half: 20-session log-return volatility <= median among contemporaneously eligible stocks | 16/17 | 43.8% | [41.18, 47.06]% | 43.8% | 1.67% | 0.35% | 2.57% | 30.77 pp | 報酬 [-9.50, 11.35]% / p=1.0000；勝率差 [-30.77, 92.31] pp / p=1.0000 | 100.0% | 1 | -0.66% / 43.8% | 無法計算 |
| price_cap_r20: 20-session return <=25% | 17/17 | 52.9% | [52.94, 52.94]% | 52.9% | 2.39% | 0.68% | 0.75% | 21.43 pp | 報酬 [-9.84, 7.22]% / p=1.0000；勝率差 [0.00, 57.14] pp / p=1.0000 | 99.4% | 0 | -0.33% / 47.1% | 無法計算 |
| market_ma20: TAIEX close > MA20; otherwise cash | 16/17 | 37.5% | [35.29, 41.18]% | 30.0% | 2.94% | 1.12% | 1.72% | 7.14 pp | 報酬 [-0.26, 5.24]% / p=1.0000；勝率差 [0.00, 28.57] pp / p=1.0000 | 54.4% | 2 | 0.55% / 37.5% | 無法計算 |
| market_ma60: TAIEX close > MA60; otherwise cash | 15/17 | 33.3% | [29.41, 41.18]% | 25.0% | 1.59% | -0.49% | 0.06% | 7.14 pp | 報酬 [-5.74, 4.14]% / p=1.0000；勝率差 [-21.43, 35.71] pp / p=1.0000 | 45.3% | 3 | -0.96% / 33.3% | 無法計算 |
| market_breadth: >50% of all contemporaneously observed ordinary shares with features above MA20; require >=500 observations; otherwise cash | 16/17 | 43.8% | [41.18, 47.06]% | 37.5% | 3.99% | 2.05% | 2.93% | 14.29 pp | 報酬 [-0.13, 5.85]% / p=0.1152；勝率差 [0.00, 35.71] pp / p=1.0000 | 42.5% | 1 | 1.58% / 43.8% | 無法計算 |
| portfolio_top5: Equal-weight top5 | 15/17 | 40.0% | [35.29, 47.06]% | 40.0% | 3.12% | 0.83% | 2.93% | 21.43 pp | 報酬 [-3.31, 12.38]% / p=1.0000；勝率差 [0.00, 64.29] pp / p=1.0000 | 89.3% | 2 | -0.09% / 40.0% | 無法計算 |
| portfolio_top20: Equal-weight top20 | 13/17 | 30.8% | [23.53, 47.06]% | 30.8% | 0.59% | -1.75% | -0.93% | 7.69 pp | 報酬 [-5.23, 2.26]% / p=1.0000；勝率差 [0.00, 30.77] pp / p=1.0000 | 93.8% | 7 | -2.68% / 30.8% | 無法計算 |
| portfolio_inversevol: Top10 inverse 20-session volatility weights, cap20% per name, unallocatable capital cash | 14/17 | 21.4% | [17.65, 35.29]% | 21.4% | 1.47% | -1.13% | -0.16% | 0.00 pp | 報酬 [-0.94, 0.91]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 89.2% | 5 | -2.03% / 21.4% | 無法計算 |
| event_quarter_half: Only signal dates in final15+ calendar days of Mar/Jun/Sep/Dec; other cohorts cash | 17/17 | 41.2% | [41.18, 41.18]% | 0.0% | -1.12% | -2.83% | -3.00% | 7.14 pp | 報酬 [-16.90, 5.02]% / p=1.0000；勝率差 [-50.00, 71.43] pp / p=1.0000 | 15.9% | 0 | -2.98% / 41.2% | 無法計算 |
| event_post_adjustment5: Observed reference-price corporate adjustment on signal day or within previous5 sessions; not assumed cash-only or pre-announced | 17/17 | 29.4% | [29.41, 29.41]% | 25.0% | -0.18% | -1.89% | -1.49% | 0.00 pp | 報酬 [-13.43, 7.94]% / p=1.0000；勝率差 [-50.00, 50.00] pp / p=1.0000 | 93.3% | 0 | -2.82% / 29.4% | 無法計算 |
| event_avoid_adjustment5: Exclude observed reference-price corporate adjustment within previous5 sessions | 14/17 | 21.4% | [17.65, 35.29]% | 21.4% | 1.60% | -1.01% | -0.04% | 0.00 pp | 報酬 [-0.33, 0.21]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 88.6% | 5 | -1.90% / 21.4% | 無法計算 |
| universe_volume50: Same baseline ranking, but signal-date volume >=50000 shares (50 lots) | 14/17 | 28.6% | [23.53, 41.18]% | 28.6% | 1.85% | -0.75% | 0.22% | 7.14 pp | 報酬 [-0.29, 2.84]% / p=1.0000；勝率差 [0.00, 64.29] pp / p=1.0000 | 88.6% | 5 | -1.65% / 28.6% | 無法計算 |

本表總期為 **17 個source-covered窗口**，只代表資料來源齊全且按原調倉phase可計算的窗口，不是該年份區間的完整計畫期數。勝率與單期均值分母按有效期；有效/總期保留執行無效期。來源中斷或無效執行使連續 performance 為 null，不能計算連續 CAGR；受影響規則：baseline、price_ma20、price_trend、price_breakout20、price_volume15、price_lowvol_half、price_cap_r20、market_ma20、market_ma60、market_breadth、portfolio_top5、portfolio_top20、portfolio_inversevol、event_quarter_half、event_post_adjustment5、event_avoid_adjustment5、universe_volume50。

## 時間驗證期可回測窗口（2024–2026）

| 規則 | 有效/總期 | 打敗TAIEX含息勝率（有效期） | 未解期勝率上下界 | 有持倉期勝率 | 每期平均淨報酬 | 每期平均淨超額 | 配對報酬差（對基準） | 配對勝率差（百分點） | 32比較校正CI / p | 平均投入 | 無效持倉股次 | 滑價後平均超額 / 勝率 | 連續CAGR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline: Top10 equal weights | 10/13 | 60.0% | [46.15, 69.23]% | 60.0% | 4.27% | 1.24% | — | — | 基準規則 | 100.0% | 4 | 0.20% / 60.0% | 無法計算 |
| price_ma20: Close > MA20 | 10/13 | 60.0% | [46.15, 69.23]% | 60.0% | 4.43% | 1.39% | 0.15% | 0.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 100.0% | 4 | 0.35% / 60.0% | 無法計算 |
| price_trend: Close > MA20 and MA20 > MA60 | 10/13 | 50.0% | [38.46, 61.54]% | 50.0% | 3.65% | 0.62% | -0.62% | -10.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 99.0% | 4 | -0.40% / 50.0% | 無法計算 |
| price_breakout20: Close > prior20-session adjusted high | 10/13 | 30.0% | [23.08, 46.15]% | 30.0% | 1.56% | -1.84% | -3.92% | -25.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 99.0% | 4 | -2.84% / 30.0% | 無法計算 |
| price_volume15: Signal volume >1.5x prior20-session mean volume, and signal close >=previous close | 10/13 | 20.0% | [15.38, 38.46]% | 20.0% | -0.27% | -3.67% | -5.03% | -37.50 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 100.0% | 5 | -4.66% / 20.0% | 無法計算 |
| price_lowvol_half: 20-session log-return volatility <= median among contemporaneously eligible stocks | 13/13 | 30.8% | [30.77, 30.77]% | 30.8% | 0.45% | -2.75% | -4.17% | -40.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 100.0% | 0 | -3.74% / 15.4% | 無法計算 |
| price_cap_r20: 20-session return <=25% | 12/13 | 50.0% | [46.15, 53.85]% | 50.0% | 3.70% | -0.78% | -4.57% | -22.22 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 97.5% | 2 | -1.79% / 33.3% | 無法計算 |
| market_ma20: TAIEX close > MA20; otherwise cash | 11/13 | 72.7% | [61.54, 76.92]% | 75.0% | 6.00% | 3.49% | 2.33% | 10.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 72.7% | 3 | 2.71% / 72.7% | 無法計算 |
| market_ma60: TAIEX close > MA60; otherwise cash | 10/13 | 70.0% | [53.85, 76.92]% | 75.0% | 6.60% | 3.57% | 2.33% | 10.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 80.0% | 4 | 2.71% / 70.0% | 無法計算 |
| market_breadth: >50% of all contemporaneously observed ordinary shares with features above MA20; require >=500 observations; otherwise cash | 13/13 | 46.2% | [46.15, 46.15]% | 75.0% | 2.50% | -0.70% | -1.03% | -10.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 30.8% | 0 | -1.03% / 46.2% | 無法計算 |
| portfolio_top5: Equal-weight top5 | 12/13 | 50.0% | [46.15, 53.85]% | 50.0% | 3.10% | 0.22% | -1.07% | -10.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 100.0% | 1 | -0.81% / 50.0% | 無法計算 |
| portfolio_top20: Equal-weight top20 | 8/13 | 62.5% | [38.46, 76.92]% | 62.5% | 1.97% | -0.53% | -0.29% | 12.50 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 99.4% | 6 | -1.54% / 50.0% | 無法計算 |
| portfolio_inversevol: Top10 inverse 20-session volatility weights, cap20% per name, unallocatable capital cash | 10/13 | 60.0% | [46.15, 69.23]% | 60.0% | 3.62% | 0.59% | -0.65% | 0.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 100.0% | 4 | -0.44% / 60.0% | 無法計算 |
| event_quarter_half: Only signal dates in final15+ calendar days of Mar/Jun/Sep/Dec; other cohorts cash | 13/13 | 23.1% | [23.08, 23.08]% | 0.0% | -1.66% | -4.86% | -6.44% | -40.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 7.7% | 0 | -4.92% / 23.1% | 無法計算 |
| event_post_adjustment5: Observed reference-price corporate adjustment on signal day or within previous5 sessions; not assumed cash-only or pre-announced | 13/13 | 23.1% | [23.08, 23.08]% | 23.1% | -0.85% | -4.05% | -2.43% | -30.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 100.0% | 0 | -5.03% / 15.4% | 無法計算 |
| event_avoid_adjustment5: Exclude observed reference-price corporate adjustment within previous5 sessions | 10/13 | 60.0% | [46.15, 69.23]% | 60.0% | 4.27% | 1.24% | 0.00% | 0.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 100.0% | 4 | 0.20% / 60.0% | 無法計算 |
| universe_volume50: Same baseline ranking, but signal-date volume >=50000 shares (50 lots) | 10/13 | 60.0% | [46.15, 69.23]% | 60.0% | 3.62% | 0.59% | -0.65% | 0.00 pp | 報酬 未計算 / p=未計算；勝率差 未計算 / p=未計算 | 100.0% | 4 | -0.44% / 50.0% | 無法計算 |

本表總期為 **13 個source-covered窗口**，只代表資料來源齊全且按原調倉phase可計算的窗口，不是該年份區間的完整計畫期數。勝率與單期均值分母按有效期；有效/總期保留執行無效期。來源中斷或無效執行使連續 performance 為 null，不能計算連續 CAGR；受影響規則：baseline、price_ma20、price_trend、price_breakout20、price_volume15、price_lowvol_half、price_cap_r20、market_ma20、market_ma60、market_breadth、portfolio_top5、portfolio_top20、portfolio_inversevol、event_quarter_half、event_post_adjustment5、event_avoid_adjustment5、universe_volume50。
