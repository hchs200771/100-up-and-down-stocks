/** Fixed-rule, chronological price/market/portfolio/event experiments. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAdjustedSeries, featuresAt, cappedInverseVolWeights,
  type RawOHLC, type CorporateAction, type AdjustedSeriesRow, type ExpandedFeatures,
} from "./lib/expanded-backtest-features.ts";
import { simulateCohort, performanceStats, type CohortResult } from "./lib/expanded-portfolio.ts";

interface ExpandedInput {
  source: string;
  universe: { code: string; name: string; initialTurnover: number }[];
  universeDate: string;
  prices: Record<string, RawOHLC[]>;
  actions: Record<string, { dataset: string; original: Record<string, any> }[]>;
  actionCoverage: Record<string, boolean>;
  benchmarkTotalReturn: { TaiwanStockPrice: RawOHLC[]; TaiwanStockTotalReturnIndex: { date: string; price: number }[] };
  coverage: unknown;
  errors: unknown[];
}
interface Rule { id: string; rule: string }
interface Candidate { code: string; row: AdjustedSeriesRow; feature: ExpandedFeatures }
export interface ExperimentCohort {
  signalDate: string; entryDate: string; exitDate: string;
  selections: { code: string; weight: number }[];
  result: CohortResult;
}
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function normalizeAction(dataset: string, original: Record<string, any>): CorporateAction {
  if (dataset === "TaiwanStockCapitalReductionReferencePrice") {
    return { dataset, date: original.date, before_price: original.ClosingPriceonTheLastTradingDay,
      after_price: original.PostReductionReferencePrice, kind: original.ReasonforCapitalReduction };
  }
  return { ...original, dataset, date: original.date, kind: original.stock_or_cache_dividend ?? original.type };
}

/** Circular blocks preserve adjacent-cohort dependence; all thresholds were fixed before execution. */
export function pairedBlockInterval(deltas: number[], seed = 1729, comparisons = 15, groupIds?: number[], blockLength = 3) {
  if (groupIds && groupIds.length !== deltas.length) throw new Error('Bootstrap group IDs must match observations');
  if (!Number.isInteger(blockLength) || blockLength < 1) throw new Error('Bootstrap block length must be a positive integer');
  if (deltas.length < 12) return { count: deltas.length, meanDeltaPct: mean(deltas), ci95: null, familywiseCi: null, adjustedP: null };
  const originalMean = mean(deltas)!;
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const draws: number[] = [];
  const groups = new Map<number, number[]>();
  deltas.forEach((_, i) => {
    const group = groupIds?.[i] ?? 0;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(i);
  });
  const positions = new Map<number, number>();
  for (const members of groups.values()) members.forEach((index, position) => positions.set(index, position));
  for (let repetition = 0; repetition < 10_000; repetition++) {
    const sample: number[] = [];
    while (sample.length < deltas.length) {
      const start = Math.floor(random() * deltas.length);
      const members = groups.get(groupIds?.[start] ?? 0)!;
      const position = positions.get(start)!;
      for (let k = 0; k < blockLength && sample.length < deltas.length; k++) sample.push(deltas[members[(position + k) % members.length]]);
    }
    draws.push(mean(sample)!);
  }
  const nullTail = (1 + draws.filter((x) => Math.abs(x - originalMean) >= Math.abs(originalMean)).length) / (draws.length + 1);
  draws.sort((a, b) => a - b);
  const quantile = (p: number) => draws[Math.min(draws.length - 1, Math.floor(p * draws.length))];
  return { count: deltas.length, meanDeltaPct: originalMean, blockLength,
    ci95: [quantile(0.025), quantile(0.975)],
    familywiseCi: [quantile(0.025 / comparisons), quantile(1 - 0.025 / comparisons)],
    adjustedP: Math.min(1, nullTail * comparisons) };
}

export function summarize(cohorts: ExperimentCohort[]) {
  const valid = cohorts.filter((c) => c.result.valid);
  const returns = valid.map((c) => c.result.netReturnPct!);
  const excess = valid.map((c) => c.result.netReturnPct! - c.result.benchmarkReturnPct!);
  const invalid = cohorts.filter((c) => !c.result.valid);
  const active = valid.filter((c) => c.result.investedWeight > 0);
  const excessWins = excess.filter((x) => x > 0).length;
  let wealth = 1;
  const values = [wealth];
  const daily: { date: string; wealth: number }[] = [];
  if (!invalid.length) {
    for (const cohort of cohorts) {
      const initial = wealth;
      for (const row of cohort.result.portfolioDaily) {
        values.push(initial * row.value);
        daily.push({ date: row.date, wealth: initial * row.value });
      }
      wealth = values.at(-1)!;
    }
  }
  return { cohortCount: cohorts.length, validCohorts: valid.length, invalidCohorts: invalid.length,
    invalidExecutions: invalid.map((c) => ({ signalDate: c.signalDate, reason: c.result.reason, codes: c.result.invalidCodes })),
    absoluteWinRatePct: returns.length ? returns.filter((x) => x > 0).length / returns.length * 100 : null,
    excessWinRatePct: excess.length ? excessWins / excess.length * 100 : null,
    excessWinRateBoundsWithInvalidPct: cohorts.length ? [excessWins / cohorts.length * 100, (excessWins + invalid.length) / cohorts.length * 100] : null,
    activeAbsoluteWinRatePct: active.length ? active.filter((c) => c.result.netReturnPct! > 0).length / active.length * 100 : null,
    activeExcessWinRatePct: active.length ? active.filter((c) => c.result.netReturnPct! > c.result.benchmarkReturnPct!).length / active.length * 100 : null,
    meanCohortNetReturnPct: mean(returns), meanCohortNetExcessPct: mean(excess),
    activeCohorts: valid.filter((c) => c.result.investedWeight > 0).length,
    averageInvestedWeightPct: mean(valid.map((c) => c.result.investedWeight * 100)),
    meanStockCount: mean(valid.map((c) => c.result.stockCount)),
    failedEntryCount: cohorts.reduce((sum, c) => sum + c.result.failedEntryCodes.length, 0),
    staleMarks: cohorts.reduce((sum, c) => sum + c.result.staleMarkCount, 0),
    performance: invalid.length || !cohorts.length ? null : performanceStats(values), daily };
}

function selectedCandidates(rule: string, candidates: Candidate[], observed: Candidate[], market: ExpandedFeatures): Candidate[] {
  const vols = candidates.map((x) => x.feature.annualized20LogReturnVol).sort((a, b) => a - b);
  const medianVol = vols.length ? (vols[Math.floor((vols.length - 1) / 2)] + vols[Math.floor(vols.length / 2)]) / 2 : 0;
  const date = market.date;
  if (rule === "market_ma20" && !market.closeAboveMa20) return [];
  if (rule === "market_ma60" && !market.closeAboveMa60) return [];
  if (rule === "market_breadth" && (observed.length < 30 || observed.filter((x) => x.feature.closeAboveMa20).length / observed.length <= 0.5)) return [];
  if (rule === "event_quarter_half" && (!["03", "06", "09", "12"].includes(date.slice(5, 7)) || Number(date.slice(8)) < 15)) return [];
  return candidates.filter((x) => {
    const f = x.feature;
    if (rule === "price_ma20") return f.closeAboveMa20;
    if (rule === "price_trend") return f.closeAboveMa20 && f.ma20AboveMa60;
    if (rule === "price_breakout20") return x.row.adjustedClose! > f.prior20AdjustedHigh;
    if (rule === "price_volume15") return f.volumeMultiple !== null && f.volumeMultiple > 1.5;
    if (rule === "price_lowvol_half") return f.annualized20LogReturnVol <= medianVol;
    if (rule === "price_cap_r20") return f.r20 <= 25;
    if (rule === "event_post_cash_ex5") return f.cashExAge !== null && f.cashExAge <= 5;
    if (rule === "event_avoid_cash_ex5") return f.cashExAge === null || f.cashExAge > 5;
    return true;
  });
}

export function runExpandedBacktest(input: ExpandedInput, rules: Rule[]) {
  if (input.errors.length || input.universe.some((s) => !input.prices[s.code]?.length || input.actionCoverage[s.code] !== true)) {
    throw new Error("Incomplete universe price/action coverage; refusing to discard unavailable or delisted stocks");
  }
  const rawBenchmark = input.benchmarkTotalReturn.TaiwanStockPrice;
  const calendar = rawBenchmark.map((r) => r.date).sort();
  const benchmarkRows = new Map(rawBenchmark.map((r) => [r.date, { open: r.open!, close: r.close! }]));
  const benchmarkTR = new Map(input.benchmarkTotalReturn.TaiwanStockTotalReturnIndex.map((r) => [r.date, r.price]));
  const series = new Map<string, Map<string, AdjustedSeriesRow>>();
  for (const stock of input.universe) {
    const actions = input.actions[stock.code].map((a) => normalizeAction(a.dataset, a.original));
    series.set(stock.code, new Map(buildAdjustedSeries(input.prices[stock.code], actions, calendar).map((r) => [r.date, r])));
  }
  const benchmarkSeries = new Map(buildAdjustedSeries(rawBenchmark, [], calendar).map((r) => [r.date, r]));
  const start = calendar.indexOf(input.universeDate);
  if (start < 60) throw new Error("Universe date missing or benchmark warm-up insufficient");
  const results: Record<string, ExperimentCohort[]> = Object.fromEntries(rules.map((r) => [r.id, []]));
  const signalCoverage: { date: string; observedStocks: number; eligibleStocks: number }[] = [];
  for (let i = start; i + 20 < calendar.length; i += 20) {
    const signalDate = calendar[i];
    const dates = calendar.slice(i + 1, i + 21);
    const market = featuresAt(benchmarkSeries, signalDate, calendar);
    if (!market) throw new Error(`Missing benchmark features on ${signalDate}`);
    const observed: Candidate[] = [];
    for (const stock of input.universe) {
      const stockSeries = series.get(stock.code)!;
      const feature = featuresAt(stockSeries, signalDate, calendar);
      if (feature) observed.push({ code: stock.code, row: stockSeries.get(signalDate)!, feature });
    }
    const eligible = observed.filter((x) => x.row.close! > 8 && x.row.volume! > 0 && x.feature.avgTurnover20 >= 50_000_000)
      .sort((a, b) => b.feature.r20 - a.feature.r20 || a.code.localeCompare(b.code));
    signalCoverage.push({ date: signalDate, observedStocks: observed.length, eligibleStocks: eligible.length });
    for (const rule of rules) {
      const count = rule.id === "portfolio_top5" ? 5 : rule.id === "portfolio_top20" ? 20 : 10;
      let selected = selectedCandidates(rule.id, eligible, observed, market).slice(0, count);
      if (rule.id === "price_volume15") {
        // Condition fixed before outcomes: rising signal price as well as unusual volume.
        selected = selectedCandidates(rule.id, eligible, observed, market)
          .filter((x) => x.row.adjustedClose! >= series.get(x.code)!.get(calendar[i - 1])!.adjustedClose!).slice(0, count);
      }
      if (rule.id === "portfolio_inversevol") selected = selected.filter((x) => x.feature.annualized20LogReturnVol > 0);
      const weights = rule.id === "portfolio_inversevol"
        ? cappedInverseVolWeights(selected.map((x) => x.feature.annualized20LogReturnVol), 0.2)
        : selected.map(() => 1 / selected.length);
      const selections = selected.map((x, n) => ({ code: x.code, weight: weights[n] }));
      const result = simulateCohort({ dates, holdings: selections.map((s) => ({ ...s, series: series.get(s.code)! })), benchmarkRows, benchmarkTR });
      results[rule.id].push({ signalDate, entryDate: dates[0], exitDate: dates.at(-1)!, selections, result });
    }
  }
  const periods = [
    { id: "all", keep: (_: ExperimentCohort) => true },
    { id: "development_2020_2023", keep: (c: ExperimentCohort) => c.exitDate < "2024-01-01" },
    { id: "validation_2024_2026", keep: (c: ExperimentCohort) => c.signalDate >= "2024-01-01" },
  ];
  const summaries: Record<string, any> = {};
  for (const period of periods) {
    const baseline = results.baseline.filter(period.keep);
    const baselineByDate = new Map(baseline.map((c) => [c.signalDate, c]));
    const first = baseline[0], last = baseline.at(-1);
    const benchmarkValues: number[] = [1];
    if (first && last) {
      const b = benchmarkRows.get(first.entryDate)!;
      const entryTR = b.open * benchmarkTR.get(first.entryDate)! / b.close;
      for (const c of baseline) for (const day of c.result.portfolioDaily) benchmarkValues.push(benchmarkTR.get(day.date)! / entryTR);
    }
    summaries[period.id] = { benchmark: performanceStats(benchmarkValues), strategies: {} };
    for (const rule of rules) {
      const cohorts = results[rule.id].filter(period.keep);
      const deltas = cohorts.flatMap((c) => {
        const base = baselineByDate.get(c.signalDate);
        return c.result.valid && base?.result.valid ? [c.result.netReturnPct! - base.result.netReturnPct!] : [];
      });
      const seed = [...rule.id].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 1729);
      summaries[period.id].strategies[rule.id] = { ...summarize(cohorts),
        pairedVsBaseline: rule.id === "baseline" ? null : pairedBlockInterval(deltas, seed, rules.length - 1),
        pairedCoverageComplete: deltas.length === cohorts.length };
    }
  }
  return { status: "fixed_rule_retrospective_experiments", source: input.source, universeDate: input.universeDate,
    universe: input.universe, inputCoverage: input.coverage, signalCoverage, rules,
    adjustment: "Forward reference-price corporate-action adjustment; dividend reinvestment proxy, not audited cash receipt total return",
    execution: "Next open after signal; full liquidation at 20th session close; failed buys remain cash; unresolved exits invalidate cohort and suppress cumulative performance",
    inference: "Paired 3-cohort circular block bootstrap, 10000 draws; Bonferroni family correction across all non-baseline rules; chronological validation without threshold tuning",
    summaries, cohorts: results };
}

export function main() {
  const input = JSON.parse(readFileSync("data/backtest/expanded/expanded-input.json", "utf8")) as ExpandedInput;
  const config = JSON.parse(readFileSync("docs/factor-experiments-round2-config.json", "utf8"));
  const output = runExpandedBacktest(input, config.strategies);
  writeFileSync("data/backtest/expanded/results.json", JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ output: "data/backtest/expanded/results.json", summaries: Object.fromEntries(
    Object.entries(output.summaries).map(([period, summary]) => [period, { benchmark: summary.benchmark,
      strategies: Object.fromEntries(Object.entries(summary.strategies).map(([rule, stats]: [string, any]) => [rule, { ...stats, daily: undefined }])) }]),
  ) }, null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
