# 全市場固定規則回測結果

本文件由 results.json 機械產生，不加入主觀挑選或結論。

## 母體與資料覆蓋

歷史資料涵蓋 **2084 檔唯一代碼、1880 個交易日**（2019-01-02 至 2026-09-30）。按原始每20日調倉phase，預計 **81 個訊號窗口**，其中來源完整、可回測 **81 個**；其餘 0 個因窗口內來源日期不完整而跳過。下列表格只含可回測covered windows，不能解讀為連續完整的2020–2026績效。四碼一般股票母體按歷史每日上市櫃資料建立，含四碼TDR，排除ETF、權證與興櫃，不用今日選股結果倒推歷史。

| 來源 | 完整交易日 | 總交易日 | 缺資料日 |
| --- | ---: | ---: | ---: |
| TWSE | 1880 | 1880 | 0 |
| TPEX | 1880 | 1880 | 0 |

### 被跳過的訊號月份

| 訊號年月 | 跳過窗口數 | 缺來源日期命中數 |
| --- | ---: | ---: |
| 無 | 0 | 0 |

| 訊號日可選股數 | 最少 | 中位數 | 最多 | 原始量能通過數平均 | 因子可計算後數平均 | 平均差額 | 差額合計 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 成交≥100張 | 1005 | 1224 | 1481 | 1239.0 | 1224.6 | 14.4 | 1169 |
| 成交≥50張 | 1198 | 1405 | 1650 | 1422.3 | 1402.5 | 19.8 | 1605 |

原始量能通過數與因子可計算後數的差額，是61日暖機或所需特徵不足的觀察差，不代表股票從下載母體移除。公司行動代理共觀察到 **17061** 件；未知參考價 / 未解調整事件（含可能的重設）共 **3606** 個股票日期（涉及306檔）。

## 回測方法與解讀

訊號於收盤後形成，下一交易日開盤買進，持有20個交易日並於第20日收盤賣出；每20個交易日換倉。買進成本0.1425%、賣出成本0.4425%。基準使用同期間TAIEX含息指數，入口開盤值由同日價格指數與總報酬指數比例換算。個股調整價是參考價再投資近似，不是實際逐筆現金股利。61個交易日暖機只用於計算指標，不算入績效；成交50/100張門檻在訊號日判斷。Dynamic historical TWSE and TPEx four-digit regular stock rows (including four-digit TDRs, foreign and innovation-board shares); excludes ETFs, warrants and emerging-market stocks; no current listing or popularity screen

選股規則與成本情境依預先固定設定；推論方法：Exploratory 3-cohort circular block bootstrap within contiguous paired-cohort segments only, 10000 draws; Bonferroni across 32 return/win non-baseline comparisons. Provider calendar gaps limit observations; results cannot establish full-period performance. Retrospective chronological validation, no tuning.

勝率上下界將所有無效期分別視為全敗／全勝；有持倉期勝率僅計投入比例大於零的有效期，避免把空手期誤讀為個股交易勝率。每期淨超額＝策略該期淨報酬減同區間TAIEX含息報酬；勝率以20日組合期為單位。配對勝率差欄的bootstrap均值與區間實際單位是百分點（pp），不是比例。32比較校正欄分列配對報酬差與配對勝率差的 familywise CI 及校正 p 值。滑價情境是在原成本外再假設買入、賣出各不利0.5%。

`performance` 為 null 時，原因可能是無效／未解 cohort，也可能是歷史來源缺日造成時間軸不連續；兩者都不能計算連續組合績效與 CAGR。表內仍列covered windows、有效期/總期、單期平均及無效持倉統計，不得把可用窗口當成完整連續回測。

## 全樣本可回測窗口

| 規則 | 有效/總期 | 打敗TAIEX含息勝率（有效期） | 未解期勝率上下界 | 有持倉期勝率 | 每期平均淨報酬 | 每期平均淨超額 | 配對報酬差（對基準） | 配對勝率差（百分點） | 32比較校正CI / p | 平均投入 | 無效持倉股次 | 滑價後平均超額 / 勝率 | 連續CAGR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline: Top10 equal weights | 70/81 | 50.0% | [43.21, 56.79]% | 50.0% | 4.08% | 1.59% | — | — | 基準規則 | 96.3% | 14 | 0.59% / 47.1% | 無法計算 |
| price_ma20: Close > MA20 | 70/81 | 50.0% | [43.21, 56.79]% | 50.0% | 4.05% | 1.56% | -0.02% | 0.00 pp | 報酬 [-0.21, 0.17]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 96.4% | 14 | 0.56% / 47.1% | 無法計算 |
| price_trend: Close > MA20 and MA20 > MA60 | 70/81 | 48.6% | [41.98, 55.56]% | 48.6% | 4.21% | 1.72% | 0.13% | -1.43 pp | 報酬 [-0.45, 0.97]% / p=1.0000；勝率差 [-10.00, 7.14] pp / p=1.0000 | 96.4% | 14 | 0.72% / 47.1% | 無法計算 |
| price_breakout20: Close > prior20-session adjusted high | 70/81 | 45.7% | [39.51, 53.09]% | 45.7% | 2.60% | 0.30% | -1.54% | -4.62 pp | 報酬 [-4.22, 1.42]% / p=1.0000；勝率差 [-29.23, 20.00] pp / p=1.0000 | 96.6% | 12 | -0.69% / 42.9% | 無法計算 |
| price_volume15: Signal volume >1.5x prior20-session mean volume, and signal close >=previous close | 72/81 | 41.7% | [37.04, 48.15]% | 41.7% | 1.37% | -0.84% | -2.59% | -7.69 pp | 報酬 [-5.81, 0.77]% / p=0.3264；勝率差 [-30.77, 15.38] pp / p=1.0000 | 97.6% | 11 | -1.82% / 37.5% | 無法計算 |
| price_lowvol_half: 20-session log-return volatility <= median among contemporaneously eligible stocks | 79/81 | 46.8% | [45.68, 48.15]% | 46.8% | 1.95% | 0.01% | -1.10% | -1.47 pp | 報酬 [-5.28, 3.36]% / p=1.0000；勝率差 [-30.88, 32.35] pp / p=1.0000 | 99.9% | 2 | -1.01% / 38.0% | 無法計算 |
| price_cap_r20: 20-session return <=25% | 79/81 | 45.6% | [44.44, 46.91]% | 45.6% | 1.82% | -0.38% | -2.46% | -8.82 pp | 報酬 [-6.11, 1.78]% / p=1.0000；勝率差 [-33.82, 20.59] pp / p=1.0000 | 99.1% | 3 | -1.38% / 39.2% | 無法計算 |
| market_ma20: TAIEX close > MA20; otherwise cash | 76/81 | 48.7% | [45.68, 51.85]% | 55.3% | 3.36% | 1.33% | -0.43% | -2.86 pp | 報酬 [-3.18, 2.06]% / p=1.0000；勝率差 [-20.00, 12.86] pp / p=1.0000 | 59.3% | 7 | 0.71% / 46.1% | 無法計算 |
| market_ma60: TAIEX close > MA60; otherwise cash | 75/81 | 52.0% | [48.15, 55.56]% | 54.9% | 3.45% | 1.40% | -0.38% | 1.43 pp | 報酬 [-2.84, 1.72]% / p=1.0000；勝率差 [-11.43, 15.71] pp / p=1.0000 | 65.5% | 8 | 0.71% / 49.3% | 無法計算 |
| market_breadth: >50% of all contemporaneously observed ordinary shares with features above MA20; require >=500 observations; otherwise cash | 78/81 | 46.2% | [44.44, 48.15]% | 57.6% | 2.95% | 0.77% | -0.79% | -4.29 pp | 報酬 [-3.62, 2.08]% / p=1.0000；勝率差 [-24.29, 15.71] pp / p=1.0000 | 40.3% | 3 | 0.34% / 43.6% | 無法計算 |
| portfolio_top5: Equal-weight top5 | 77/81 | 55.8% | [53.09, 58.02]% | 55.8% | 5.07% | 2.98% | 1.27% | 4.29 pp | 報酬 [-1.70, 4.41]% / p=1.0000；勝率差 [-15.71, 24.29] pp / p=1.0000 | 96.1% | 4 | 1.98% / 53.2% | 無法計算 |
| portfolio_top20: Equal-weight top20 | 63/81 | 47.6% | [37.04, 59.26]% | 47.6% | 2.94% | 0.46% | -1.17% | -3.17 pp | 報酬 [-3.19, 1.04]% / p=1.0000；勝率差 [-19.05, 14.29] pp / p=1.0000 | 97.6% | 22 | -0.55% / 44.4% | 無法計算 |
| portfolio_inversevol: Top10 inverse 20-session volatility weights, cap20% per name, unallocatable capital cash | 70/81 | 48.6% | [41.98, 55.56]% | 48.6% | 3.78% | 1.29% | -0.30% | -1.43 pp | 報酬 [-0.82, 0.22]% / p=1.0000；勝率差 [-7.14, 0.00] pp / p=1.0000 | 96.5% | 14 | 0.29% / 45.7% | 無法計算 |
| event_quarter_half: Only signal dates in final15+ calendar days of Mar/Jun/Sep/Dec; other cohorts cash | 78/81 | 29.5% | [28.40, 32.10]% | 22.2% | -0.52% | -2.80% | -4.66% | -24.29 pp | 報酬 [-8.75, -0.99]% / p=0.0032；勝率差 [-50.00, 5.71] pp / p=0.2080 | 11.0% | 3 | -2.91% / 29.5% | 無法計算 |
| event_post_adjustment5: Observed reference-price corporate adjustment on signal day or within previous5 sessions; not assumed cash-only or pre-announced | 78/81 | 34.6% | [33.33, 37.04]% | 33.8% | 0.15% | -1.93% | -2.95% | -11.94 pp | 報酬 [-6.85, 1.00]% / p=0.6751；勝率差 [-37.31, 14.93] pp / p=1.0000 | 98.5% | 4 | -2.91% / 30.8% | 無法計算 |
| event_avoid_adjustment5: Exclude observed reference-price corporate adjustment within previous5 sessions | 70/81 | 50.0% | [43.21, 56.79]% | 50.0% | 4.18% | 1.69% | 0.10% | 0.00 pp | 報酬 [-0.20, 0.53]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 96.3% | 14 | 0.69% / 47.1% | 無法計算 |
| universe_volume50: Same baseline ranking, but signal-date volume >=50000 shares (50 lots) | 67/81 | 52.2% | [43.21, 60.49]% | 52.2% | 3.99% | 1.52% | 0.01% | 2.99 pp | 報酬 [-0.46, 0.72]% / p=1.0000；勝率差 [0.00, 14.93] pp / p=1.0000 | 96.0% | 17 | 0.53% / 46.3% | 無法計算 |

本表總期為 **81 個source-covered窗口**，只代表資料來源齊全且按原調倉phase可計算的窗口，不是該年份區間的完整計畫期數。勝率與單期均值分母按有效期；有效/總期保留執行無效期。來源中斷或無效執行使連續 performance 為 null，不能計算連續 CAGR；受影響規則：baseline、price_ma20、price_trend、price_breakout20、price_volume15、price_lowvol_half、price_cap_r20、market_ma20、market_ma60、market_breadth、portfolio_top5、portfolio_top20、portfolio_inversevol、event_quarter_half、event_post_adjustment5、event_avoid_adjustment5、universe_volume50。

## 開發期可回測窗口（2020–2023）

| 規則 | 有效/總期 | 打敗TAIEX含息勝率（有效期） | 未解期勝率上下界 | 有持倉期勝率 | 每期平均淨報酬 | 每期平均淨超額 | 配對報酬差（對基準） | 配對勝率差（百分點） | 32比較校正CI / p | 平均投入 | 無效持倉股次 | 滑價後平均超額 / 勝率 | 連續CAGR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline: Top10 equal weights | 40/48 | 45.0% | [37.50, 54.17]% | 45.0% | 3.27% | 1.44% | — | — | 基準規則 | 94.5% | 10 | 0.47% / 42.5% | 無法計算 |
| price_ma20: Close > MA20 | 40/48 | 45.0% | [37.50, 54.17]% | 45.0% | 3.23% | 1.41% | -0.03% | 0.00 pp | 報酬 [-0.30, 0.24]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 94.7% | 10 | 0.43% / 42.5% | 無法計算 |
| price_trend: Close > MA20 and MA20 > MA60 | 40/48 | 45.0% | [37.50, 54.17]% | 45.0% | 3.70% | 1.88% | 0.43% | 0.00 pp | 報酬 [-0.28, 1.55]% / p=1.0000；勝率差 [-12.50, 10.00] pp / p=1.0000 | 95.0% | 10 | 0.89% / 45.0% | 無法計算 |
| price_breakout20: Close > prior20-session adjusted high | 42/48 | 47.6% | [41.67, 54.17]% | 47.6% | 1.55% | 0.13% | -1.32% | 2.56 pp | 報酬 [-4.76, 2.59]% / p=1.0000；勝率差 [-28.21, 33.33] pp / p=1.0000 | 95.5% | 6 | -0.84% / 45.2% | 無法計算 |
| price_volume15: Signal volume >1.5x prior20-session mean volume, and signal close >=previous close | 44/48 | 38.6% | [35.42, 43.75]% | 38.6% | 0.35% | -0.96% | -2.44% | -5.13 pp | 報酬 [-6.69, 2.02]% / p=1.0000；勝率差 [-28.21, 23.08] pp / p=1.0000 | 96.8% | 4 | -1.93% / 36.4% | 無法計算 |
| price_lowvol_half: 20-session log-return volatility <= median among contemporaneously eligible stocks | 46/48 | 52.2% | [50.00, 54.17]% | 52.2% | 1.91% | 1.02% | 0.50% | 13.16 pp | 報酬 [-5.80, 7.35]% / p=1.0000；勝率差 [-23.68, 52.63] pp / p=1.0000 | 99.8% | 2 | 0.01% / 45.7% | 無法計算 |
| price_cap_r20: 20-session return <=25% | 47/48 | 55.3% | [54.17, 56.25]% | 55.3% | 1.82% | 0.78% | -0.57% | 7.69 pp | 報酬 [-6.13, 5.30]% / p=1.0000；勝率差 [-23.08, 41.03] pp / p=1.0000 | 99.1% | 1 | -0.23% / 51.1% | 無法計算 |
| market_ma20: TAIEX close > MA20; otherwise cash | 45/48 | 44.4% | [41.67, 47.92]% | 50.0% | 2.38% | 1.14% | -0.59% | -2.50 pp | 報酬 [-4.51, 2.75]% / p=1.0000；勝率差 [-30.00, 22.50] pp / p=1.0000 | 50.0% | 4 | 0.62% / 42.2% | 無法計算 |
| market_ma60: TAIEX close > MA60; otherwise cash | 45/48 | 48.9% | [45.83, 52.08]% | 52.0% | 2.23% | 1.06% | -0.76% | 2.50 pp | 報酬 [-4.09, 1.74]% / p=1.0000；勝率差 [-20.00, 22.50] pp / p=1.0000 | 52.2% | 4 | 0.52% / 46.7% | 無法計算 |
| market_breadth: >50% of all contemporaneously observed ordinary shares with features above MA20; require >=500 observations; otherwise cash | 45/48 | 51.1% | [47.92, 54.17]% | 57.1% | 3.27% | 2.00% | 0.42% | 5.00 pp | 報酬 [-2.95, 3.72]% / p=1.0000；勝率差 [-20.00, 27.50] pp / p=1.0000 | 43.6% | 3 | 1.53% / 48.9% | 無法計算 |
| portfolio_top5: Equal-weight top5 | 45/48 | 53.3% | [50.00, 56.25]% | 53.3% | 4.58% | 3.36% | 1.61% | 5.00 pp | 報酬 [-2.38, 6.15]% / p=1.0000；勝率差 [-17.50, 30.00] pp / p=1.0000 | 94.7% | 3 | 2.37% / 51.1% | 無法計算 |
| portfolio_top20: Equal-weight top20 | 38/48 | 42.1% | [33.33, 54.17]% | 42.1% | 1.94% | 0.12% | -1.14% | -2.63 pp | 報酬 [-3.34, 0.91]% / p=1.0000；勝率差 [-21.05, 10.53] pp / p=1.0000 | 96.6% | 13 | -0.86% / 39.5% | 無法計算 |
| portfolio_inversevol: Top10 inverse 20-session volatility weights, cap20% per name, unallocatable capital cash | 40/48 | 45.0% | [37.50, 54.17]% | 45.0% | 3.04% | 1.22% | -0.22% | 0.00 pp | 報酬 [-0.74, 0.43]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 94.9% | 10 | 0.24% / 40.0% | 無法計算 |
| event_quarter_half: Only signal dates in final15+ calendar days of Mar/Jun/Sep/Dec; other cohorts cash | 45/48 | 35.6% | [33.33, 39.58]% | 28.6% | -0.47% | -1.92% | -3.79% | -15.00 pp | 報酬 [-9.78, 1.39]% / p=0.9631；勝率差 [-50.00, 25.00] pp / p=1.0000 | 14.7% | 3 | -2.06% / 35.6% | 無法計算 |
| event_post_adjustment5: Observed reference-price corporate adjustment on signal day or within previous5 sessions; not assumed cash-only or pre-announced | 47/48 | 38.3% | [37.50, 39.58]% | 37.0% | -0.08% | -1.09% | -2.18% | -2.56 pp | 報酬 [-7.99, 3.80]% / p=1.0000；勝率差 [-35.90, 33.33] pp / p=1.0000 | 97.6% | 2 | -2.06% / 36.2% | 無法計算 |
| event_avoid_adjustment5: Exclude observed reference-price corporate adjustment within previous5 sessions | 40/48 | 45.0% | [37.50, 54.17]% | 45.0% | 3.29% | 1.46% | 0.02% | 0.00 pp | 報酬 [-0.33, 0.41]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 94.5% | 10 | 0.49% / 42.5% | 無法計算 |
| universe_volume50: Same baseline ranking, but signal-date volume >=50000 shares (50 lots) | 39/48 | 48.7% | [39.58, 58.33]% | 48.7% | 3.68% | 1.71% | 0.09% | 2.56 pp | 報酬 [-0.40, 1.15]% / p=1.0000；勝率差 [0.00, 23.08] pp / p=1.0000 | 94.1% | 11 | 0.74% / 46.2% | 無法計算 |

本表總期為 **48 個source-covered窗口**，只代表資料來源齊全且按原調倉phase可計算的窗口，不是該年份區間的完整計畫期數。勝率與單期均值分母按有效期；有效/總期保留執行無效期。來源中斷或無效執行使連續 performance 為 null，不能計算連續 CAGR；受影響規則：baseline、price_ma20、price_trend、price_breakout20、price_volume15、price_lowvol_half、price_cap_r20、market_ma20、market_ma60、market_breadth、portfolio_top5、portfolio_top20、portfolio_inversevol、event_quarter_half、event_post_adjustment5、event_avoid_adjustment5、universe_volume50。

## 時間驗證期可回測窗口（2024–2026）

| 規則 | 有效/總期 | 打敗TAIEX含息勝率（有效期） | 未解期勝率上下界 | 有持倉期勝率 | 每期平均淨報酬 | 每期平均淨超額 | 配對報酬差（對基準） | 配對勝率差（百分點） | 32比較校正CI / p | 平均投入 | 無效持倉股次 | 滑價後平均超額 / 勝率 | 連續CAGR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline: Top10 equal weights | 29/32 | 58.6% | [53.13, 62.50]% | 58.6% | 5.56% | 2.08% | — | — | 基準規則 | 98.6% | 4 | 1.05% / 55.2% | 無法計算 |
| price_ma20: Close > MA20 | 29/32 | 58.6% | [53.13, 62.50]% | 58.6% | 5.55% | 2.08% | -0.01% | 0.00 pp | 報酬 [-0.26, 0.26]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 98.6% | 4 | 1.04% / 55.2% | 無法計算 |
| price_trend: Close > MA20 and MA20 > MA60 | 29/32 | 55.2% | [50.00, 59.38]% | 55.2% | 5.29% | 1.81% | -0.28% | -3.45 pp | 報酬 [-1.00, 0.11]% / p=1.0000；勝率差 [-17.24, 0.00] pp / p=1.0000 | 98.3% | 4 | 0.78% / 51.7% | 無法計算 |
| price_breakout20: Close > prior20-session adjusted high | 27/32 | 44.4% | [37.50, 53.13]% | 44.4% | 4.35% | 0.60% | -2.21% | -16.00 pp | 報酬 [-7.14, 2.94]% / p=1.0000；勝率差 [-56.00, 32.00] pp / p=1.0000 | 98.1% | 6 | -0.42% / 40.7% | 無法計算 |
| price_volume15: Signal volume >1.5x prior20-session mean volume, and signal close >=previous close | 27/32 | 44.4% | [37.50, 53.13]% | 44.4% | 2.83% | -0.92% | -3.47% | -16.00 pp | 報酬 [-7.95, 1.22]% / p=0.5311；勝率差 [-60.00, 32.00] pp / p=1.0000 | 98.9% | 7 | -1.93% / 37.0% | 無法計算 |
| price_lowvol_half: 20-session log-return volatility <= median among contemporaneously eligible stocks | 32/32 | 40.6% | [40.63, 40.63]% | 40.6% | 2.16% | -1.34% | -3.34% | -20.69 pp | 報酬 [-6.85, 1.06]% / p=0.2720；勝率差 [-58.62, 27.59] pp / p=1.0000 | 100.0% | 0 | -2.36% / 28.1% | 26.83% |
| price_cap_r20: 20-session return <=25% | 31/32 | 32.3% | [31.25, 34.38]% | 32.3% | 2.11% | -1.90% | -5.14% | -32.14 pp | 報酬 [-8.99, -1.22]% / p=0.0064；勝率差 [-57.14, 14.29] pp / p=0.3616 | 99.0% | 2 | -2.90% / 22.6% | 無法計算 |
| market_ma20: TAIEX close > MA20; otherwise cash | 30/32 | 56.7% | [53.13, 59.38]% | 63.6% | 5.16% | 1.88% | -0.23% | -3.45 pp | 報酬 [-3.58, 3.86]% / p=1.0000；勝率差 [-20.69, 13.79] pp / p=1.0000 | 72.0% | 3 | 1.12% / 53.3% | 無法計算 |
| market_ma60: TAIEX close > MA60; otherwise cash | 29/32 | 58.6% | [53.13, 62.50]% | 60.0% | 5.70% | 2.22% | 0.14% | 0.00 pp | 報酬 [-2.75, 3.87]% / p=1.0000；勝率差 [-13.79, 17.24] pp / p=1.0000 | 84.8% | 4 | 1.32% / 55.2% | 無法計算 |
| market_breadth: >50% of all contemporaneously observed ordinary shares with features above MA20; require >=500 observations; otherwise cash | 32/32 | 40.6% | [40.63, 40.63]% | 63.6% | 2.79% | -0.71% | -2.48% | -17.24 pp | 報酬 [-7.10, 2.36]% / p=1.0000；勝率差 [-55.17, 13.79] pp / p=1.0000 | 33.7% | 0 | -1.07% / 37.5% | 38.26% |
| portfolio_top5: Equal-weight top5 | 31/32 | 61.3% | [59.38, 62.50]% | 61.3% | 6.42% | 3.03% | 1.12% | 3.45 pp | 報酬 [-3.33, 5.87]% / p=1.0000；勝率差 [-37.93, 34.48] pp / p=1.0000 | 98.1% | 1 | 1.99% / 58.1% | 無法計算 |
| portfolio_top20: Equal-weight top20 | 24/32 | 58.3% | [43.75, 68.75]% | 58.3% | 4.80% | 1.16% | -1.39% | -4.17 pp | 報酬 [-4.80, 3.09]% / p=1.0000；勝率差 [-33.33, 37.50] pp / p=1.0000 | 99.2% | 9 | 0.13% / 54.2% | 無法計算 |
| portfolio_inversevol: Top10 inverse 20-session volatility weights, cap20% per name, unallocatable capital cash | 29/32 | 55.2% | [50.00, 59.38]% | 55.2% | 5.13% | 1.65% | -0.43% | -3.45 pp | 報酬 [-1.36, 0.41]% / p=1.0000；勝率差 [-17.24, 0.00] pp / p=1.0000 | 98.6% | 4 | 0.62% / 55.2% | 無法計算 |
| event_quarter_half: Only signal dates in final15+ calendar days of Mar/Jun/Sep/Dec; other cohorts cash | 32/32 | 21.9% | [21.88, 21.88]% | 0.0% | -0.62% | -4.12% | -6.24% | -37.93 pp | 報酬 [-11.55, -1.30]% / p=0.0096；勝率差 [-75.86, -6.90] pp / p=0.0544 | 6.2% | 0 | -4.17% / 21.9% | -8.47% |
| event_post_adjustment5: Observed reference-price corporate adjustment on signal day or within previous5 sessions; not assumed cash-only or pre-announced | 30/32 | 26.7% | [25.00, 31.25]% | 26.7% | 0.50% | -3.31% | -4.43% | -29.63 pp | 報酬 [-9.23, 0.42]% / p=0.1408；勝率差 [-62.96, 3.70] pp / p=0.3136 | 100.0% | 2 | -4.31% / 23.3% | 無法計算 |
| event_avoid_adjustment5: Exclude observed reference-price corporate adjustment within previous5 sessions | 29/32 | 58.6% | [53.13, 62.50]% | 58.6% | 5.77% | 2.29% | 0.21% | 0.00 pp | 報酬 [-0.17, 1.21]% / p=1.0000；勝率差 [0.00, 0.00] pp / p=1.0000 | 98.6% | 4 | 1.25% / 55.2% | 無法計算 |
| universe_volume50: Same baseline ranking, but signal-date volume >=50000 shares (50 lots) | 27/32 | 59.3% | [50.00, 65.63]% | 59.3% | 4.82% | 1.56% | -0.11% | 3.70 pp | 報酬 [-0.95, 0.84]% / p=1.0000；勝率差 [0.00, 18.52] pp / p=1.0000 | 98.5% | 6 | 0.53% / 48.1% | 無法計算 |

本表總期為 **32 個source-covered窗口**，只代表資料來源齊全且按原調倉phase可計算的窗口，不是該年份區間的完整計畫期數。勝率與單期均值分母按有效期；有效/總期保留執行無效期。來源中斷或無效執行使連續 performance 為 null，不能計算連續 CAGR；受影響規則：baseline、price_ma20、price_trend、price_breakout20、price_volume15、price_cap_r20、market_ma20、market_ma60、portfolio_top5、portfolio_top20、portfolio_inversevol、event_post_adjustment5、event_avoid_adjustment5、universe_volume50。
