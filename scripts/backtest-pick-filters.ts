#!/usr/bin/env node --import tsx
/** Exploratory execution sensitivity tests on the four dated stock-pick snapshots. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PriceRow { date: string; open?: number | null; max?: number | null; min?: number | null; close?: number | null; Trading_Volume?: number | null; Trading_money?: number | null }
export interface InstitutionalRow { date: string; name: string; buy: number; sell: number }
export interface Pick { code: string; name?: string; close?: number; metrics?: Record<string, string>; signals?: { label?: string }[] }
export interface Snapshot { date: string; long: Pick[]; short: Pick[] }
export interface PriceInput { source: string; startDate: string; endDate: string; prices: Record<string, PriceRow[]>; institutional?: Record<string, InstitutionalRow[]>; corporateActions?: Record<string, { date: string; dataset?: string; [key: string]: unknown }[]>; corporateActionCoverage?: Record<string, boolean> }
export const HORIZONS = [5, 10, 20] as const;
export const ROUND_TRIP_COST_PP = 0.585;
export const FILTERS = ["baseline", "above_ma20", "daytrade_le35", "r20_positive", "r20_not_hot", "foreign_streak", "no_cb", "trust_streak3", "trust_net5_positive", "liquidity20"] as const;
export type FilterName = typeof FILTERS[number];
export interface FilterContext { signalDate: string; calendar: string[]; stockRows: Map<string, PriceRow>; institutionalRows: InstitutionalRow[] }

export function parseMetricNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*%?$/);
  return m ? Number(m[1]) : null;
}
function trailingDates(context: FilterContext, count: number): string[] | null {
  const dates = [...new Set(context.calendar)].filter((date) => date <= context.signalDate).sort();
  return dates.length < count ? null : dates.slice(-count);
}
function trustNet(row: InstitutionalRow | undefined): number | null {
  if (!row || row.name !== "Investment_Trust" || !Number.isFinite(row.buy) || !Number.isFinite(row.sell)) return null;
  return row.buy - row.sell;
}
export function passesFilter(filter: FilterName, pick: Pick, context?: FilterContext): boolean | null {
  if (filter === "baseline") return true;
  const metrics = pick.metrics ?? {};
  if (filter === "above_ma20") { const ma = parseMetricNumber(metrics.ma20); return ma === null || typeof pick.close !== "number" ? null : pick.close > ma; }
  if (filter === "daytrade_le35") { const x = parseMetricNumber(metrics.dayTrade); return x === null ? null : x <= 35; }
  if (filter === "r20_positive" || filter === "r20_not_hot") {
    const x = parseMetricNumber(metrics.r20); if (x === null) return null;
    return filter === "r20_positive" ? x > 0 : x <= 25;
  }
  if (filter === "trust_streak3" || filter === "trust_net5_positive") {
    if (!context) return null;
    const count = filter === "trust_streak3" ? 3 : 5;
    const dates = trailingDates(context, count); if (!dates) return null;
    const rows = new Map(context.institutionalRows.filter((r) => r.name === "Investment_Trust").map((r) => [r.date, r]));
    const netBuys = dates.map((date) => trustNet(rows.get(date)));
    if (netBuys.some((x) => x === null)) return null;
    return filter === "trust_streak3" ? netBuys.every((x) => x! > 0) : netBuys.reduce((sum, x) => sum + x!, 0) > 0;
  }
  if (filter === "liquidity20") {
    if (!context) return null;
    const dates = trailingDates(context, 20); if (!dates) return null;
    const values = dates.map((date) => context.stockRows.get(date)?.Trading_money);
    if (values.some((x) => typeof x !== "number" || !Number.isFinite(x))) return null;
    return (values as number[]).reduce((sum, x) => sum + x, 0) / 20 >= 50_000_000;
  }
  if (!Array.isArray(pick.signals)) return null;
  const labels = pick.signals.map((s) => s.label ?? "");
  if (filter === "foreign_streak") return labels.some((x) => x.includes("外資連買"));
  if (filter === "no_cb") return !labels.some((x) => x.includes("CB+設質"));
  return null;
}
export function nextTradingDay(dates: string[], signalDate: string): string | null {
  const sorted = [...new Set(dates)].sort();
  const i = sorted.indexOf(signalDate);
  return i >= 0 ? sorted[i + 1] ?? null : null;
}
export function inclusiveExitDay(dates: string[], entryDate: string, horizon: number): string | null {
  const sorted = [...new Set(dates)].sort(); const i = sorted.indexOf(entryDate);
  return i >= 0 && Number.isInteger(horizon) && horizon > 0 ? sorted[i + horizon - 1] ?? null : null;
}
export function calculateDirectionalReturns(stockOpen: number, stockClose: number, benchmarkOpen: number, benchmarkClose: number) {
  const grossReturnPct = (stockClose / stockOpen - 1) * 100;
  const benchmarkReturnPct = (benchmarkClose / benchmarkOpen - 1) * 100;
  const netReturnPct = grossReturnPct - ROUND_TRIP_COST_PP;
  return { grossReturnPct, netReturnPct, benchmarkReturnPct, netExcessPct: netReturnPct - benchmarkReturnPct };
}
function closeEnough(actual: number | null | undefined, expected: number | undefined): boolean {
  return typeof actual === "number" && Number.isFinite(actual) && typeof expected === "number" && Math.abs(actual / expected - 1) <= 0.0005;
}
function validExecutionRow(row: PriceRow | undefined): string | null {
  if (!row) return "missing_price_row";
  if (!(typeof row.open === "number" && row.open > 0 && typeof row.close === "number" && row.close > 0)) return "missing_or_zero_open_close";
  if (typeof row.Trading_Volume !== "number" || row.Trading_Volume <= 0) return "missing_or_zero_volume";
  if (typeof row.max !== "number" || typeof row.min !== "number") return "missing_high_low";
  if (row.open === row.max && row.open === row.min) return "locked_one_price";
  return null;
}
const asRows = (rows: PriceRow[]) => new Map(rows.map((r) => [r.date, r]));

/** One signal-to-trade calculation. Calendar is always the TAIEX date sequence; stock gaps never shift entry/exit. */
export function evaluateTrade(args: { pick: Pick; signalDate: string; direction: "long" | "short"; horizon: number; calendar: string[]; stockRows: Map<string, PriceRow>; benchmarkRows: Map<string, PriceRow>; corporateActions?: PriceInput["corporateActions"]; corporateActionCoverage?: PriceInput["corporateActionCoverage"] }) {
  const { pick, signalDate, direction, horizon, calendar, stockRows, benchmarkRows, corporateActions, corporateActionCoverage } = args;
  const signalRow = stockRows.get(signalDate);
  if (!closeEnough(signalRow?.close, pick.close)) return { observation: null, exclusion: "signal_close_mismatch_or_missing" } as const;
  const entryDate = nextTradingDay(calendar, signalDate);
  if (!entryDate) return { observation: null, exclusion: "no_next_taiex_trading_day" } as const;
  const exitDate = inclusiveExitDay(calendar, entryDate, horizon);
  if (!exitDate) return { observation: null, exclusion: "horizon_not_mature" } as const;
  if (corporateActionCoverage && corporateActionCoverage[pick.code] !== true) return { observation: null, exclusion: "corporate_action_coverage_missing" } as const;
  if ((corporateActions?.[pick.code] ?? []).some((event) => event.date > entryDate && event.date <= exitDate)) return { observation: null, exclusion: "corporate_action_within_holding" } as const;
  for (const [date, rows] of [[entryDate, stockRows], [exitDate, stockRows]] as const) {
    const reason = validExecutionRow(rows.get(date));
    if (reason) return { observation: null, exclusion: `${reason}:${date}` } as const;
  }
  const bEntry = benchmarkRows.get(entryDate), bExit = benchmarkRows.get(exitDate);
  if (!bEntry || !(typeof bEntry.open === "number" && bEntry.open > 0) || !bExit || !(typeof bExit.close === "number" && bExit.close > 0)) return { observation: null, exclusion: "missing_benchmark_entry_or_exit" } as const;
  const stockEntry = stockRows.get(entryDate)!, stockExit = stockRows.get(exitDate)!;
  return { exclusion: null, observation: { signalDate, entryDate, exitDate, direction, horizon, code: pick.code, name: pick.name ?? "", ...calculateDirectionalReturns(stockEntry.open!, stockExit.close!, bEntry.open!, bExit.close!) } } as const;
}

function summarize(observations: ReturnType<typeof evaluateTrade> extends { observation: infer O } ? Exclude<O, null>[] : never[], candidates: number, exclusions: Record<string, number>, baselineCount: number) {
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const cohorts = new Map<string, number[]>();
  for (const o of observations) { const xs = cohorts.get(o.signalDate) ?? []; xs.push(o.netExcessPct); cohorts.set(o.signalDate, xs); }
  const cohortMeans = [...cohorts.values()].map((xs) => mean(xs)!);
  return { candidatePicks: candidates, maturedTrades: observations.length, failedEntriesOrImmature: Object.values(exclusions).reduce((a, b) => a + b, 0), exclusions,
    stocks: [...new Set(observations.map((o) => o.code))].sort(), dates: [...new Set(observations.map((o) => o.signalDate))].sort(),
    missingFactorCount: exclusions.missing_factor ?? 0, retentionFromBaselinePct: baselineCount ? observations.length / baselineCount * 100 : null,
    transactionNetWinRatePct: observations.length ? observations.filter((o) => o.netReturnPct > 0).length / observations.length * 100 : null,
    netExcessWinRatePct: observations.length ? observations.filter((o) => o.netExcessPct > 0).length / observations.length * 100 : null,
    meanNetReturnPct: mean(observations.map((o) => o.netReturnPct)), meanNetExcessPct: mean(observations.map((o) => o.netExcessPct)),
    cohortMeanNetExcessPct: mean(cohortMeans), cohortPositiveRatePct: cohortMeans.length ? cohortMeans.filter((x) => x > 0).length / cohortMeans.length * 100 : null, cohortCount: cohorts.size };
}

export function runBacktest(snapshots: Snapshot[], input: PriceInput) {
  const prices = Object.fromEntries(Object.entries(input.prices).map(([code, rows]) => [code, asRows(rows)]));
  const benchmarkRows = prices.TAIEX ?? prices["IX0001"];
  if (!benchmarkRows) throw new Error("price input must include TAIEX (or IX0001)");
  const calendar = [...benchmarkRows.keys()].sort();
  const observations: Record<string, Record<string, Record<number, unknown[]>>> = {};
  const summaries: Record<string, unknown>[] = [];
  const missingData: Record<string, unknown>[] = [];
  const baselineMatured = new Map<string, number>();
  for (const direction of ["long", "short"] as const) {
    observations[direction] = {};
    for (const filter of FILTERS) {
      const selected: { pick: Pick; date: string }[] = [];
      let missingFactorCount = 0;
      for (const snapshot of snapshots) for (const pick of snapshot[direction] ?? []) {
        const stockRows = prices[pick.code] ?? new Map<string, PriceRow>();
        const context: FilterContext = { signalDate: snapshot.date, calendar, stockRows, institutionalRows: input.institutional?.[pick.code] ?? [] };
        const pass = passesFilter(filter, pick, context);
        if (pass === null) { if (filter !== "baseline") missingFactorCount++; missingData.push({ date: snapshot.date, direction, filter, code: pick.code }); continue; }
        if (pass) selected.push({ pick, date: snapshot.date });
      }
      observations[direction][filter] = {};
      const perHorizon = new Map<number, { obs: NonNullable<ReturnType<typeof evaluateTrade>["observation"]>[]; fail: Record<string, number> }>();
      for (const h of HORIZONS) perHorizon.set(h, { obs: [], fail: {} });
      for (const { pick, date } of selected) for (const h of HORIZONS) {
        const stockRows = prices[pick.code];
        const result = stockRows ? evaluateTrade({ pick, signalDate: date, direction, horizon: h, calendar, stockRows, benchmarkRows, corporateActions: input.corporateActions, corporateActionCoverage: input.corporateActionCoverage ?? {} }) : { observation: null, exclusion: "missing_stock_price_series" };
        const bucket = perHorizon.get(h)!;
        if (result.observation) bucket.obs.push(result.observation); else bucket.fail[result.exclusion] = (bucket.fail[result.exclusion] ?? 0) + 1;
      }
      for (const h of HORIZONS) {
        const { obs, fail } = perHorizon.get(h)!;
        observations[direction][filter][h] = obs;
        if (filter === "baseline") baselineMatured.set(`${direction}:${h}`, obs.length);
        const baselineCount = baselineMatured.get(`${direction}:${h}`) ?? 0;
        summaries.push({ direction, filter, horizonTradingDays: h, ...summarize(obs, selected.length, { ...fail, ...(missingFactorCount ? { missing_factor: missingFactorCount } : {}) }, baselineCount) });
      }
    }
  }
  return { status: "exploratory_four_signal_dates_not_oos", source: input.source, priceRange: { startDate: input.startDate, endDate: input.endDate }, signalDates: snapshots.map((s) => s.date), cost: { roundTripPctPoints: ROUND_TRIP_COST_PP, assumption: "Hypothetical price-only round-trip cost deducted per stock trade; benchmark has no costs." }, caveats: ["These are sensitivity tests of existing selected stocks, not reconstructed all-market strategies or revenue-base add-ons.", "Both the 波段 (long) and 短線 (short) boards are tested as long stock positions; short denotes the short-term pick board, not short selling.", "Price returns are price-only and corporate actions inside the holding window are excluded; securities with incomplete corporate-action coverage are also excluded.", "Signals use only snapshot and factor inputs dated on or before the signal date. No CAGR or maximum drawdown is reported because the observations overlap and do not define a deployable portfolio."], summaries, observations, missingFactorPicks: missingData };
}

export function main() {
  const root = resolve(process.cwd()); const picksDir = resolve(root, "data/stock-picks-history"); const inputPath = resolve(root, "data/backtest/price-input.json");
  if (!existsSync(inputPath)) throw new Error("Missing data/backtest/price-input.json; provide the local FinMind OHLC input before running the backtest.");
  const snapshots = readdirSync(picksDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(resolve(picksDir, f), "utf8")) as Snapshot);
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as PriceInput; const output = runBacktest(snapshots, input);
  const outputPath = resolve(root, "data/backtest/pick-filter-results.json"); mkdirSync(resolve(root, "data/backtest"), { recursive: true }); writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ output: "data/backtest/pick-filter-results.json", status: output.status, summaries: output.summaries }, null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
