/** Render the wide-market experiment results as a mechanical, auditable report. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const INPUT = resolve(ROOT, "data/backtest/wide/results.json");
const OUTPUT = resolve(ROOT, "docs/factor-experiments-wide-results-2026-10-02.md");

type AnyRecord = Record<string, any>;
const showPct = (v: unknown, digits = 2) => typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(digits)}%` : "—";
const showPp = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(2)} pp` : "—";
const showNum = (v: unknown, digits = 1) => typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
const showInt = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "—";
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const min = (values: number[]) => values.length ? Math.min(...values) : null;
const max = (values: number[]) => values.length ? Math.max(...values) : null;
const escapeCell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const showInterval = (v: unknown, suffix = "%") => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number")
  ? `[${v[0].toFixed(2)}, ${v[1].toFixed(2)}]${suffix}` : "未計算";
const showP = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "未計算";

function adjustmentExitCount(cohorts: AnyRecord[]): number {
  let count = 0;
  for (const cohort of cohorts) {
    const result = cohort?.result;
    if (result?.valid || typeof result?.reason !== "string") continue;
    const codes = new Set<string>(Array.isArray(result.invalidCodes) ? result.invalidCodes : []);
    for (const code of codes) {
      const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|;\\s*)${escaped}:\\s*(?:missing exit quote|exit volume|exit OHLC|exit adjustedClose|missing or nonpositive adjustedClose on)`);
      if (re.test(result.reason)) count++;
    }
  }
  return count;
}

function coverageSection(inputCoverage: AnyRecord, signalCoverage: AnyRecord[]): string[] {
  const dayCoverage: AnyRecord[] = Array.isArray(inputCoverage.dayCoverage) ? inputCoverage.dayCoverage : [];
  const sourceDates = ["twse", "tpex"].map((source) => {
    const complete = dayCoverage.filter((d) => Number(d[source]) > 0).length;
    return { source, complete, missing: dayCoverage.length - complete };
  });
  const unavailable: AnyRecord[] = Array.isArray(inputCoverage.unavailableSignals) ? inputCoverage.unavailableSignals : [];
  const skippedByMonth = new Map<string, { signals: number; missingDateHits: number }>();
  for (const item of unavailable) {
    const month = String(item.date ?? "").slice(0, 7) || "未知月份";
    const entry = skippedByMonth.get(month) ?? { signals: 0, missingDateHits: 0 };
    entry.signals++;
    entry.missingDateHits += Array.isArray(item.missingInputDates) ? item.missingInputDates.length : 0;
    skippedByMonth.set(month, entry);
  }
  const lines = [
    "## 母體與資料覆蓋",
    "",
    `歷史資料涵蓋 **${showInt(inputCoverage.historicalUniqueCodes)} 檔唯一代碼、${showInt(inputCoverage.sessions)} 個交易日**（${inputCoverage.start ?? "?"} 至 ${inputCoverage.end ?? "?"}）。按原始每20日調倉phase，預計 **${showInt(inputCoverage.plannedCohorts)} 個訊號窗口**，其中來源完整、可回測 **${showInt(inputCoverage.coveredCohorts)} 個**；其餘 ${unavailable.length} 個因窗口內來源日期不完整而跳過。下列表格只含可回測covered windows，不能解讀為連續完整的2020–2026績效。四碼一般股票母體按歷史每日上市櫃資料建立，含四碼TDR，排除ETF、權證與興櫃，不用今日選股結果倒推歷史。`,
    "",
    "| 來源 | 完整交易日 | 總交易日 | 缺資料日 |",
    "| --- | ---: | ---: | ---: |",
    ...sourceDates.map((x) => `| ${x.source.toUpperCase()} | ${showInt(x.complete)} | ${showInt(dayCoverage.length)} | ${showInt(x.missing)} |`),
    "",
    "### 被跳過的訊號月份",
    "",
    "| 訊號年月 | 跳過窗口數 | 缺來源日期命中數 |",
    "| --- | ---: | ---: |",
    ...(skippedByMonth.size
      ? [...skippedByMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, x]) => `| ${month} | ${x.signals} | ${x.missingDateHits} |`)
      : ["| 無 | 0 | 0 |"]),
    "",
    "| 訊號日可選股數 | 最少 | 中位數 | 最多 | 原始量能通過數平均 | 因子可計算後數平均 | 平均差額 | 差額合計 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [label, rawKey, eligibleKey] of [
    ["成交≥100張", "volume100LotsRaw", "eligible100"],
    ["成交≥50張", "volume50LotsRaw", "eligible50"],
  ]) {
    const raw = signalCoverage.map((x) => Number(x[rawKey])).filter(Number.isFinite);
    const eligible = signalCoverage.map((x) => Number(x[eligibleKey])).filter(Number.isFinite);
    const gaps = raw.map((x, i) => x - (eligible[i] ?? 0));
    lines.push(`| ${label} | ${showInt(min(eligible))} | ${showInt(median(eligible))} | ${showInt(max(eligible))} | ${showNum(mean(raw) ?? NaN)} | ${showNum(mean(eligible) ?? NaN)} | ${showNum(mean(gaps) ?? NaN)} | ${showInt(gaps.reduce((a, b) => a + b, 0))} |`);
  }
  const unresolved = Array.isArray(inputCoverage.unresolvedAdjustments) ? inputCoverage.unresolvedAdjustments : [];
  const unresolvedEvents = unresolved.reduce((sum: number, item: AnyRecord) => sum + (Array.isArray(item.dates) ? item.dates.length : 0), 0);
  lines.push(
    "",
    `原始量能通過數與因子可計算後數的差額，是61日暖機或所需特徵不足的觀察差，不代表股票從下載母體移除。公司行動代理共觀察到 **${showInt(inputCoverage.observedAdjustmentEvents)}** 件；未知參考價 / 未解調整事件（含可能的重設）共 **${showInt(unresolvedEvents)}** 個股票日期（涉及${showInt(unresolved.length)}檔）。`,
    "",
  );
  return lines;
}

function statTable(periodId: string, period: AnyRecord, rules: AnyRecord[], cohortsByRule: AnyRecord): string[] {
  const strategies: AnyRecord = period.strategies;
  const labels: Record<string, string> = {
    all: "全樣本可回測窗口",
    development_2020_2023: "開發期可回測窗口（2020–2023）",
    validation_2024_2026: "時間驗證期可回測窗口（2024–2026）",
  };
  const lines = [
    `## ${labels[periodId] ?? periodId}`,
    "",
    "| 規則 | 有效/總期 | 打敗TAIEX含息勝率（有效期） | 未解期勝率上下界 | 有持倉期勝率 | 每期平均淨報酬 | 每期平均淨超額 | 配對報酬差（對基準） | 配對勝率差（百分點） | 32比較校正CI / p | 平均投入 | 無效持倉股次 | 滑價後平均超額 / 勝率 | 連續CAGR |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const rule of rules) {
    const stats = strategies[rule.id] ?? {};
    const cohorts: AnyRecord[] = cohortsByRule[rule.id] ?? [];
    const periodCohorts = cohorts.filter((c) => {
      if (periodId === "development_2020_2023") return c.exitDate < "2024-01-01";
      if (periodId === "validation_2024_2026") return c.signalDate >= "2024-01-01";
      return true;
    });
    const pairedReturn = stats.pairedVsBaseline;
    const pairedWin = stats.pairedExcessWinVsBaseline;
    const corrected = pairedReturn || pairedWin
      ? `報酬 ${showInterval(pairedReturn?.familywiseCi)} / p=${showP(pairedReturn?.adjustedP)}；勝率差 ${showInterval(pairedWin?.familywiseCi, " pp")} / p=${showP(pairedWin?.adjustedP)}`
      : "基準規則";
    const performance = stats.performance;
    const cagr = performance && typeof performance.cagrPct === "number" ? showPct(performance.cagrPct) : "無法計算";
    const stress = stats.slippageScenario ?? {};
    const unresolvedExit = periodCohorts.reduce((sum, c) => sum + (c.result?.valid ? 0 : (c.result?.invalidCodes?.length ?? 0)), 0);
    lines.push(`| ${escapeCell(`${rule.id}: ${rule.rule}`)} | ${showInt(stats.validCohorts)}/${showInt(stats.cohortCount)} | ${showPct(stats.excessWinRatePct, 1)} | ${showInterval(stats.excessWinRateBoundsWithInvalidPct)} | ${showPct(stats.activeExcessWinRatePct, 1)} | ${showPct(stats.meanCohortNetReturnPct)} | ${showPct(stats.meanCohortNetExcessPct)} | ${rule.id === "baseline" ? "—" : showPct(pairedReturn?.meanDeltaPct)} | ${rule.id === "baseline" ? "—" : showPp(pairedWin?.meanDeltaPct)} | ${corrected} | ${showPct(stats.averageInvestedWeightPct, 1)} | ${unresolvedExit} | ${showPct(stress.meanNetExcessPct)} / ${showPct(stress.excessWinRatePct, 1)} | ${cagr} |`);
  }
  const invalidRules = rules.filter((r) => strategies[r.id]?.performance === null || strategies[r.id]?.performance === undefined);
  lines.push("", `本表總期為 **${showInt(period.coveredCohorts ?? strategies.baseline?.cohortCount)} 個source-covered窗口**，只代表資料來源齊全且按原調倉phase可計算的窗口，不是該年份區間的完整計畫期數。勝率與單期均值分母按有效期；有效/總期保留執行無效期。${period.timelineComplete === false || invalidRules.length ? `來源中斷或無效執行使連續 performance 為 null，不能計算連續 CAGR；${invalidRules.length ? `受影響規則：${invalidRules.map((r) => r.id).join("、")}。` : ""}` : "本期的連續performance可計算。"}`, "");
  return lines;
}

export function renderWideReport(data: AnyRecord): string {
  if (data.status !== "historical_all_stock_covered_window_experiments") throw new Error(`Unexpected results status: ${String(data.status)}`);
  const rules: AnyRecord[] = data.config?.strategies;
  if (!Array.isArray(rules) || rules.length !== 17) throw new Error(`Expected 17 fixed strategies, got ${rules?.length ?? "none"}`);
  const periods = ["all", "development_2020_2023", "validation_2024_2026"];
  if (periods.some((p) => !data.summaries?.[p])) throw new Error("Missing one or more required period summaries");
  const out = [
    "# 全市場固定規則回測結果",
    "",
    "本文件由 results.json 機械產生，不加入主觀挑選或結論。",
    "",
    ...coverageSection(data.inputCoverage ?? {}, data.signalCoverage ?? []),
    "## 回測方法與解讀",
    "",
    `訊號於收盤後形成，下一交易日開盤買進，持有20個交易日並於第20日收盤賣出；每20個交易日換倉。買進成本0.1425%、賣出成本0.4425%。基準使用同期間TAIEX含息指數，入口開盤值由同日價格指數與總報酬指數比例換算。個股調整價是參考價再投資近似，不是實際逐筆現金股利。61個交易日暖機只用於計算指標，不算入績效；成交50/100張門檻在訊號日判斷。${data.config?.universe ?? ""}`,
    "",
    `選股規則與成本情境依預先固定設定；推論方法：${data.inference ?? "結果檔未提供推論說明"}`,
    "",
    "勝率上下界將所有無效期分別視為全敗／全勝；有持倉期勝率僅計投入比例大於零的有效期，避免把空手期誤讀為個股交易勝率。每期淨超額＝策略該期淨報酬減同區間TAIEX含息報酬；勝率以20日組合期為單位。配對勝率差欄的bootstrap均值與區間實際單位是百分點（pp），不是比例。32比較校正欄分列配對報酬差與配對勝率差的 familywise CI 及校正 p 值。滑價情境是在原成本外再假設買入、賣出各不利0.5%。",
    "",
    "`performance` 為 null 時，原因可能是無效／未解 cohort，也可能是歷史來源缺日造成時間軸不連續；兩者都不能計算連續組合績效與 CAGR。表內仍列covered windows、有效期/總期、單期平均及無效持倉統計，不得把可用窗口當成完整連續回測。",
    "",
  ];
  for (const periodId of periods) out.push(...statTable(periodId, data.summaries[periodId], rules, data.cohorts ?? {}));
  return `${out.join("\n").trimEnd()}\n`;
}

function main() {
  if (!existsSync(INPUT)) throw new Error(`Missing ${INPUT}; run the wide-market backtest first.`);
  const results = JSON.parse(readFileSync(INPUT, "utf8"));
  const report = renderWideReport(results);
  writeFileSync(OUTPUT, report, "utf8");
  console.log(`Rendered ${OUTPUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
