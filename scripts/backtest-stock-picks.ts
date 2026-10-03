#!/usr/bin/env npx tsx
/**
 * 用每日保存的 stock-picks-history 與 price-history 評估選股分數。
 *
 * 每一筆報酬都扣掉同進出場日的全市場等權報酬，避免把大盤漲跌誤認成選股能力。
 * 樣本會隨每日 report 自動增加；至少累積 20 個可觀測進場日後，再據此調權重。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { twIso } from "./lib/time";

type PriceMap = Record<string, number>;
type Pick = {
  code: string;
  rank?: number;
  score: number;
  signals?: Array<{ label?: string }>;
  themeRadar?: Array<{ id: string }>;
};
type PickSnapshot = {
  date: string;
  basis?: { themeRadarAsOf?: string | null };
  long?: Pick[];
  short?: Pick[];
};
type Observation = {
  date: string;
  entryDate: string;
  exitDate: string;
  horizon: "long" | "short";
  days: number;
  code: string;
  rank: number;
  score: number;
  returnPct: number;
  netReturnPct: number;
  marketPct: number;
  excessPct: number;
  signals: string[];
  themeRadar: boolean;
  themeRadarAvailable: boolean;
};

const ROOT = process.cwd();
const PRICE_DIR = resolve(ROOT, "data/price-history");
const PICKS_DIR = resolve(ROOT, "data/stock-picks-history");
const OUT = resolve(ROOT, "data/stock-picks-backtest.json");
const HOLDING_DAYS = [1, 5, 20] as const;
const ENTRY_LAG_DAYS = 1;
// 股票一般交易：買賣手續費各 0.1425%＋賣出證交稅 0.3%，另留 0.2% 往返滑價。
const ROUND_TRIP_COST_PCT = 0.585;
const SLIPPAGE_PCT = 0.2;
const IMPLEMENTATION_COST_PCT = ROUND_TRIP_COST_PCT + SLIPPAGE_PCT;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const avg = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round = (value: number | null) => value === null ? null : Math.round(value * 100) / 100;

function summarize(rows: Observation[]) {
  const raw = rows.map((row) => row.returnPct);
  const net = rows.map((row) => row.netReturnPct);
  const excess = rows.map((row) => row.excessPct);
  return {
    n: rows.length,
    entryDates: new Set(rows.map((row) => row.date)).size,
    avgReturnPct: round(avg(raw)),
    avgNetReturnPct: round(avg(net)),
    avgExcessPct: round(avg(excess)),
    winRatePct: rows.length ? round(100 * rows.filter((row) => row.returnPct > 0).length / rows.length) : null,
    netWinRatePct: rows.length ? round(100 * rows.filter((row) => row.netReturnPct > 0).length / rows.length) : null,
    excessWinRatePct: rows.length ? round(100 * rows.filter((row) => row.excessPct > 0).length / rows.length) : null,
  };
}

if (!existsSync(PRICE_DIR) || !existsSync(PICKS_DIR)) {
  throw new Error("缺少 data/price-history 或 data/stock-picks-history，請先累積每日報告快照");
}

const dates = readdirSync(PRICE_DIR)
  .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
  .map((file) => file.slice(0, -5))
  .sort();
const prices = new Map(dates.map((date) => [date, readJson<PriceMap>(resolve(PRICE_DIR, `${date}.json`))]));
const observations: Observation[] = [];

for (const file of readdirSync(PICKS_DIR).filter((name) => name.endsWith(".json")).sort()) {
  const snapshot = readJson<PickSnapshot>(resolve(PICKS_DIR, file));
  const signalIndex = dates.indexOf(snapshot.date);
  const entryIndex = signalIndex + ENTRY_LAG_DAYS;
  const entryDate = dates[entryIndex];
  const entryPrices = entryDate ? prices.get(entryDate) : undefined;
  if (signalIndex < 0 || !entryDate || !entryPrices) continue;

  for (const days of HOLDING_DAYS) {
    const exitDate = dates[entryIndex + days];
    const exitPrices = exitDate ? prices.get(exitDate) : undefined;
    if (!exitDate || !exitPrices) continue;

    const marketReturns = Object.entries(entryPrices)
      .filter(([code, price]) => price > 0 && (exitPrices[code] ?? 0) > 0)
      .map(([code, price]) => 100 * (exitPrices[code] / price - 1));
    const marketPct = avg(marketReturns);
    if (marketPct === null) continue;

    for (const horizon of ["long", "short"] as const) {
      for (const [index, pick] of (snapshot[horizon] ?? []).entries()) {
        const entry = entryPrices[pick.code];
        const exit = exitPrices[pick.code];
        if (!(entry > 0 && exit > 0)) continue;
        const returnPct = 100 * (exit / entry - 1);
        const netReturnPct = returnPct - IMPLEMENTATION_COST_PCT;
        observations.push({
          date: snapshot.date,
          entryDate,
          exitDate,
          horizon,
          days,
          code: pick.code,
          rank: pick.rank ?? index + 1,
          score: pick.score,
          returnPct,
          netReturnPct,
          marketPct,
          excessPct: returnPct - marketPct,
          signals: (pick.signals ?? []).map((signal) => signal.label).filter((label): label is string => Boolean(label)),
          themeRadar: (pick.themeRadar?.length ?? 0) > 0,
          themeRadarAvailable: snapshot.basis?.themeRadarAsOf === snapshot.date,
        });
      }
    }
  }
}

const byHorizon: Record<string, ReturnType<typeof summarize>> = {};
for (const horizon of ["long", "short"] as const) {
  for (const days of HOLDING_DAYS) {
    byHorizon[`${horizon}:T+${days}`] = summarize(
      observations.filter((row) => row.horizon === horizon && row.days === days),
    );
  }
}

const scoreBuckets = [
  { label: "<60", min: -Infinity, max: 59 },
  { label: "60-69", min: 60, max: 69 },
  { label: "70-79", min: 70, max: 79 },
  { label: "80+", min: 80, max: Infinity },
];
const t5 = observations.filter((row) => row.days === 5);
const byScore = Object.fromEntries(
  scoreBuckets.map((bucket) => [
    bucket.label,
    summarize(t5.filter((row) => row.score >= bucket.min && row.score <= bucket.max)),
  ]),
);

const signalNames = [...new Set(t5.flatMap((row) => row.signals))].sort();
const bySignal = Object.fromEntries(
  signalNames
    .map((signal) => [signal, summarize(t5.filter((row) => row.signals.includes(signal)))] as const)
    .filter(([, stats]) => stats.n >= 5),
);

// 前瞻追蹤：全市場回測（docs/wide-market-scan-conclusion.md）顯示只買前 5 檔比前 10 檔好，
// 但未達顯著。這裡用每日真實榜單驗證：前 5 名 vs 第 6–10 名，以進場日等權比較，
// 避免某天留下較多股票就主導結果。累積約 6 個月（120 個進場日）再決定是否集中持股。
function dateAvgExcess(rows: Observation[]) {
  const byDate = new Map<string, number[]>();
  for (const row of rows) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row.excessPct]);
  return new Map([...byDate].map(([date, values]) => [date, avg(values)!]));
}
const topFiveTracking = Object.fromEntries(
  (["long", "short"] as const).flatMap((horizon) => HOLDING_DAYS.map((days) => {
    const rows = observations.filter((row) => row.horizon === horizon && row.days === days);
    const top5 = rows.filter((row) => row.rank <= 5);
    const rest = rows.filter((row) => row.rank > 5 && row.rank <= 10);
    const top5ByDate = dateAvgExcess(top5);
    const restByDate = dateAvgExcess(rest);
    const paired = [...top5ByDate.keys()].filter((date) => restByDate.has(date));
    const diffs = paired.map((date) => top5ByDate.get(date)! - restByDate.get(date)!);
    return [`${horizon}:T+${days}`, {
      top5: summarize(top5),
      rank6to10: summarize(rest),
      top10: summarize(rows.filter((row) => row.rank <= 10)),
      pairedDates: paired.length,
      avgDateExcessDiffPct: round(avg(diffs)),
      top5BeatsRestDates: diffs.filter((diff) => diff > 0).length,
    }] as const;
  })),
);

const result = {
  generatedAt: twIso(),
  pickFiles: readdirSync(PICKS_DIR).filter((name) => name.endsWith(".json")).length,
  priceDates: dates.length,
  entryLagDays: ENTRY_LAG_DAYS,
  methodology: "訊號後下一交易日收盤進場的固定持有基準，不等同報告中的條件式進場；全市場等權為相對基準",
  implementationCostPct: IMPLEMENTATION_COST_PCT,
  implementationCostBasis: "一般股票往返手續費 0.285%＋賣出證交稅 0.3%＋滑價 0.2%",
  minimumRecommendedEntryDates: 20,
  byHorizon,
  topFiveTracking,
  topFiveTrackingNote: "前 5 名 vs 第 6–10 名；avgDateExcessDiffPct 為同進場日兩組平均超額之差（前 5 減後 5）的日平均，正值代表前 5 名較好",
  t5ByScore: byScore,
  t5BySignal: bySignal,
  themeRadarComparison: Object.fromEntries(
    ["long", "short"].flatMap((horizon) => [5, 20].map((days) => {
      const available = observations.filter((row) => row.horizon === horizon && row.days === days && row.themeRadarAvailable);
      const datesWithBoth = new Set(available.filter((row) => row.themeRadar).map((row) => row.date)
        .filter((date) => available.some((row) => row.date === date && !row.themeRadar)));
      const cohort = available.filter((row) => datesWithBoth.has(row.date));
      return [`${horizon}:T+${days}`, {
        withTheme: summarize(cohort.filter((row) => row.themeRadar)),
        withoutTheme: summarize(cohort.filter((row) => !row.themeRadar)),
      }] as const;
    })),
  ),
};

writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
// --quiet：每日流程用，只印前 5 名追蹤一行摘要，不把整份 JSON 灌進 log
if (process.argv.includes("--quiet")) {
  const t20 = topFiveTracking["long:T+20"];
  console.log(`[top5] long T+20 配對 ${t20.pairedDates} 日，前5−後5 日均超額 ${t20.avgDateExcessDiffPct ?? "—"}%，前5勝 ${t20.top5BeatsRestDates} 日 → ${OUT}`);
} else {
  console.log(JSON.stringify(result, null, 2));
}
if (Math.max(...Object.values(byHorizon).map((stats) => stats.entryDates)) < result.minimumRecommendedEntryDates) {
  console.warn("[warn] 可觀測進場日少於 20 天；結果只適合監控，不適合據此最佳化權重");
}
