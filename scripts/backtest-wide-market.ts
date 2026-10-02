/** All historical TWSE/TPEx ordinary shares: contemporaneous, fixed-rule experiments. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanel, addDayQuotes, addReferenceEvent, finalizePanel, featuresAt, historyRows, type StockPanel, type WideMarketFeatures } from './lib/wide-market-panel.ts';
import { cappedInverseVolWeights } from './lib/expanded-backtest-features.ts';
import { simulateCohort, performanceStats } from './lib/expanded-portfolio.ts';
import { summarize, pairedBlockInterval, type ExperimentCohort } from './backtest-price-market-events.ts';

interface Candidate { stock: StockPanel; feature: WideMarketFeatures }
interface Rule { id: string; rule: string }
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
export function eligibleCandidates(observed: Candidate[], index: number, minimumShares: number): Candidate[] {
  return observed.filter((c) => c.stock.volume[index] >= minimumShares)
    .sort((a, b) => b.feature.r20 - a.feature.r20 || a.stock.code.localeCompare(b.stock.code));
}
export function filterCandidates(id: string, eligible: Candidate[], observed: Candidate[], market: WideMarketFeatures, index: number, date: string): Candidate[] {
  if (id === 'market_ma20' && !market.closeAboveMa20) return [];
  if (id === 'market_ma60' && !market.closeAboveMa60) return [];
  if (id === 'market_breadth' && (observed.length < 500 || observed.filter((c) => c.feature.closeAboveMa20).length / observed.length <= .5)) return [];
  if (id === 'event_quarter_half' && (!['03', '06', '09', '12'].includes(date.slice(5, 7)) || Number(date.slice(8)) < 15)) return [];
  const vols = eligible.map((c) => c.feature.annualized20LogReturnVol).sort((a, b) => a - b);
  const median = vols.length ? (vols[Math.floor((vols.length - 1) / 2)] + vols[Math.floor(vols.length / 2)]) / 2 : 0;
  return eligible.filter(({ stock, feature: f }) => {
    if (id === 'price_ma20') return f.closeAboveMa20;
    if (id === 'price_trend') return f.closeAboveMa20 && f.ma20AboveMa60;
    if (id === 'price_breakout20') return stock.adjustedClose[index] > f.prior20AdjustedHigh;
    if (id === 'price_volume15') return f.volumeMultiple !== null && f.volumeMultiple > 1.5 && stock.adjustedClose[index] >= stock.adjustedClose[index - 1];
    if (id === 'price_lowvol_half') return f.annualized20LogReturnVol <= median;
    if (id === 'price_cap_r20') return f.r20 <= 25;
    if (id === 'event_post_adjustment5') return f.observedAdjustmentAge !== null && f.observedAdjustmentAge <= 5;
    if (id === 'event_avoid_adjustment5') return f.observedAdjustmentAge === null || f.observedAdjustmentAge > 5;
    return true;
  });
}
export function stressReturn(cohort: ExperimentCohort, slippage = .005): number | null {
  const r = cohort.result;
  if (!r.valid || r.netReturnPct === null) return null;
  const cash = 1 - r.investedWeight;
  return (cash + (1 + r.netReturnPct / 100 - cash) * (1 - slippage) / (1 + slippage) - 1) * 100;
}
export function main() {
  const config = JSON.parse(readFileSync('docs/factor-experiments-wide-config.json', 'utf8'));
  const benchmarkPath = existsSync('research/wide-market/benchmark-input.json')
    ? 'research/wide-market/benchmark-input.json' : 'data/backtest/expanded/expanded-input.json';
  const benchmarkInput = JSON.parse(readFileSync(benchmarkPath, 'utf8')).benchmarkTotalReturn;
  const auditThrough = process.argv.find((arg) => arg.startsWith('--audit-through='))?.split('=')[1];
  const raw = benchmarkInput.TaiwanStockPrice.filter((r: { date: string }) => !auditThrough || r.date <= auditThrough).map((r: Record<string, any>) => ({
    date: r.date as string, open: r.open as number, close: r.close as number,
    high: (r.high ?? r.max) as number, low: (r.low ?? r.min) as number,
    volume: (r.volume ?? r.Trading_Volume) as number,
    money: (r.money ?? r.Trading_money) as number,
  })) as { date: string; open: number; high: number; low: number; close: number; volume: number; money: number }[];
  const calendar = raw.map((r) => r.date).sort();
  const panel = createPanel(calendar);
  const references = JSON.parse(readFileSync('data/backtest/wide/actions/twse-ex-references.json', 'utf8')).rows as { code: string; date: string; reference: number; kind: string }[];
  const actionByKey = new Map<string, { reference: number; kind: string }>();
  for (const action of references) {
    const key = `${action.date}/${action.code}`;
    if (actionByKey.has(key) && Math.abs(actionByKey.get(key)!.reference - action.reference) > 1e-8) throw new Error(`Conflicting official references ${key}`);
    actionByKey.set(key, action);
  }
  const dayCoverage: { date: string; twse: number; tpex: number }[] = [];
  for (let i = 0; i < calendar.length; i++) {
    const counts = { date: calendar[i], twse: 0, tpex: 0 };
    for (const source of ['twse', 'tpex'] as const) {
      const file = `data/backtest/wide/daily/${source}/${calendar[i]}.json.gz`;
      if (!existsSync(file)) continue;
      const cached = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
      if (cached.parserVersion !== 'all-ordinary-rows-v2' || cached.requestedDate !== calendar[i].replaceAll('-', '') || !cached.rows.length) throw new Error(`Invalid cache: ${file}`);
      counts[source] = cached.rows.length;
      addDayQuotes(panel, i, cached.rows.map((quote: Record<string, any>) => {
        const action = actionByKey.get(`${calendar[i]}/${quote.code}`);
        return action ? { ...quote, explicitReference: action.reference, changeLabel: action.kind } : quote;
      }));
    }
    dayCoverage.push(counts);
  }
  const calendarIndex = new Map(calendar.map((date, i) => [date, i]));
  for (const [key, action] of actionByKey) {
    const [date, code] = key.split('/');
    const index = calendarIndex.get(date);
    if (index !== undefined) addReferenceEvent(panel, index, code, action.reference);
  }
  finalizePanel(panel);
  if (auditThrough) {
    const stockCoverage = [...panel.values()].map((s) => ({ code: s.code, unresolvedDates: s.unresolvedAdjustmentIndices.map((i) => calendar[i]), lastFeatureValid: !!featuresAt(s, calendar.length - 1) }));
    writeFileSync('data/backtest/wide/panel-audit.json', JSON.stringify({ sessions: calendar.length, through: calendar.at(-1), stockCoverage }, null, 2));
    console.log(JSON.stringify({ sessions: calendar.length, through: calendar.at(-1), codes: panel.size, validLastFeatures: stockCoverage.filter((s) => s.lastFeatureValid).length, unresolved: stockCoverage.filter((s) => s.unresolvedDates.length) }, null, 2));
    return;
  }
  const marketPanel = createPanel(calendar);
  raw.forEach((r) => addDayQuotes(marketPanel, calendar.indexOf(r.date), [{ ...r, code: 'INDEX', name: 'TAIEX', market: 'index', volume: r.volume > 0 ? r.volume : 1, money: r.money >= 0 ? r.money : 0, change: null, changeLabel: '', nextReference: null }]));
  finalizePanel(marketPanel);
  const marketStock = marketPanel.get('INDEX')!;
  const benchmarkRows = new Map(raw.map((r) => [r.date, { open: r.open, close: r.close }]));
  const benchmarkTR = new Map<string, number>(benchmarkInput.TaiwanStockTotalReturnIndex.map((r: { date: string; price: number }) => [r.date, r.price]));
  const rules: Rule[] = config.strategies;
  const results: Record<string, ExperimentCohort[]> = Object.fromEntries(rules.map((r) => [r.id, []]));
  const signalCoverage: Record<string, unknown>[] = [];
  const unavailableSignals: { date: string; missingInputDates: string[] }[] = [];
  let plannedCohorts = 0;
  const start = calendar.indexOf(config.evaluationStart);
  if (start < 60) throw new Error('Insufficient benchmark warmup');
  for (let i = start; i + 20 < calendar.length; i += 20) {
    const date = calendar[i];
    plannedCohorts++;
    // A missing entire-market date is a provider gap, never an observed zero-volume day.
    const missingInputDates = dayCoverage.slice(i - 60, i + 21).filter((d) => !d.twse || !d.tpex).map((d) => d.date);
    if (missingInputDates.length) { unavailableSignals.push({ date, missingInputDates }); continue; }
    const dates = calendar.slice(i + 1, i + 21);
    const indices = Array.from({ length: 20 }, (_, k) => i + 1 + k);
    const market = featuresAt(marketStock, i);
    if (!market) throw new Error(`Invalid benchmark features ${date}`);
    const observed: Candidate[] = [];
    let quoted = 0, gate100 = 0, gate50 = 0;
    for (const stock of panel.values()) {
      if (stock.seen[i]) quoted++;
      if (stock.volume[i] >= 100000 && stock.close[i] > 0) gate100++;
      if (stock.volume[i] >= 50000 && stock.close[i] > 0) gate50++;
      const feature = featuresAt(stock, i);
      if (feature) observed.push({ stock, feature });
    }
    const eligible100 = eligibleCandidates(observed, i, 100000);
    const eligible50 = eligibleCandidates(observed, i, 50000);
    signalCoverage.push({ date, quotedOrdinaryShares: quoted, volume100LotsRaw: gate100, volume50LotsRaw: gate50, withFeatures: observed.length, eligible100: eligible100.length, eligible50: eligible50.length, aboveMa20Pct: observed.filter((c) => c.feature.closeAboveMa20).length / observed.length * 100 });
    const rowCache = new Map<string, ReturnType<typeof historyRows>>();
    for (const rule of rules) {
      const eligible = rule.id === 'universe_volume50' ? eligible50 : eligible100;
      const count = rule.id === 'portfolio_top5' ? 5 : rule.id === 'portfolio_top20' ? 20 : 10;
      let candidates = filterCandidates(rule.id, eligible, observed, market, i, date);
      if (rule.id === 'portfolio_inversevol') candidates = candidates.filter((c) => c.feature.annualized20LogReturnVol > 0);
      const selected = candidates.slice(0, count);
      const weights = rule.id === 'portfolio_inversevol' ? cappedInverseVolWeights(selected.map((c) => c.feature.annualized20LogReturnVol), .2) : selected.map(() => 1 / selected.length);
      const selections = selected.map((c, k) => ({ code: c.stock.code, weight: weights[k] }));
      const holdings = selected.map((c, k) => {
        if (!rowCache.has(c.stock.code)) rowCache.set(c.stock.code, historyRows(c.stock, indices));
        return { code: c.stock.code, weight: weights[k], series: rowCache.get(c.stock.code)! };
      });
      results[rule.id].push({ signalDate: date, entryDate: dates[0], exitDate: dates.at(-1)!, selections, result: simulateCohort({ dates, holdings, benchmarkRows, benchmarkTR }) });
    }
  }
  const summaries: Record<string, any> = {};
  const periods = [ { id: 'all', keep: (_c: ExperimentCohort) => true }, { id: 'development_2020_2023', keep: (c: ExperimentCohort) => c.exitDate < '2024-01-01' }, { id: 'validation_2024_2026', keep: (c: ExperimentCohort) => c.signalDate >= '2024-01-01' } ];
  for (const period of periods) {
    const baseline = results.baseline.filter(period.keep);
    const byDate = new Map(baseline.map((c) => [c.signalDate, c]));
    const first = baseline[0];
    const b = benchmarkRows.get(first.entryDate)!;
    const entryTR = b.open * benchmarkTR.get(first.entryDate)! / b.close;
    const benchmarkValues = [1, ...baseline.flatMap((c) => c.result.portfolioDaily.map((r) => benchmarkTR.get(r.date)! / entryTR))];
    const consecutive = baseline.every((c, k) => k === 0 || calendar.indexOf(c.signalDate) - calendar.indexOf(baseline[k - 1].signalDate) === 20);
    summaries[period.id] = { benchmark: consecutive ? performanceStats(benchmarkValues) : null, timelineComplete: consecutive, coveredCohorts: baseline.length, strategies: {} };
    for (const rule of rules) {
      const cohorts = results[rule.id].filter(period.keep);
      const pairs = cohorts.flatMap((c) => c.result.valid && byDate.get(c.signalDate)?.result.valid ? [{ strategy: c, baseline: byDate.get(c.signalDate)! }] : []);
      const deltas = pairs.map(({ strategy: c, baseline: base }) => c.result.netReturnPct! - base.result.netReturnPct!);
      const winDeltas = pairs.map(({ strategy: c, baseline: base }) => (Number(c.result.netReturnPct! > c.result.benchmarkReturnPct!) - Number(base.result.netReturnPct! > base.result.benchmarkReturnPct!)) * 100);
      let group = 0;
      const groupIds = pairs.map(({ strategy: c }, k) => {
        if (k > 0 && calendar.indexOf(c.signalDate) - calendar.indexOf(pairs[k - 1].strategy.signalDate) !== 20) group++;
        return group;
      });
      const stress = cohorts.flatMap((c) => { const r = stressReturn(c); return r === null ? [] : [{ r, excess: r - c.result.benchmarkReturnPct! }]; });
      const seed = [...rule.id].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 1729);
      const stats = summarize(cohorts);
      if (!consecutive) { stats.performance = null; stats.daily = []; }
      summaries[period.id].strategies[rule.id] = { ...stats, timelineComplete: consecutive, pairedVsBaseline: rule.id === 'baseline' ? null : pairedBlockInterval(deltas, seed, (rules.length - 1) * 2, groupIds),
        pairedExcessWinVsBaseline: rule.id === 'baseline' ? null : pairedBlockInterval(winDeltas, seed + 1, (rules.length - 1) * 2, groupIds), pairedCoverageComplete: deltas.length === cohorts.length,
        slippageScenario: { adverseEntryPct: .5, adverseExitPct: .5, validCohorts: stress.length, meanNetReturnPct: mean(stress.map((x) => x.r)), meanNetExcessPct: mean(stress.map((x) => x.excess)), excessWinRatePct: stress.length ? stress.filter((x) => x.excess > 0).length / stress.length * 100 : null } };
    }
  }
  const output = { status: 'historical_all_stock_covered_window_experiments', config,
    inputCoverage: { sessions: calendar.length, start: calendar[0], end: calendar.at(-1), historicalUniqueCodes: panel.size, dayCoverage,
      plannedCohorts, coveredCohorts: signalCoverage.length, unavailableSignals,
      missingSourceDates: dayCoverage.filter((d) => !d.twse || !d.tpex),
      unresolvedAdjustments: [...panel.values()].filter((s) => s.unresolvedAdjustmentIndices.length).map((s) => ({ code: s.code, dates: s.unresolvedAdjustmentIndices.map((i) => calendar[i]) })),
      observedAdjustmentEvents: [...panel.values()].reduce((s, stock) => s + stock.observedAdjustmentIndices.length, 0) }, signalCoverage,
    execution: 'Failed buys stay cash; unresolved exits invalidate cohort and suppress cumulative metrics. No hindsight exclusion or substitution.',
    inference: 'Exploratory 3-cohort circular block bootstrap within contiguous paired-cohort segments only, 10000 draws; Bonferroni across 32 return/win non-baseline comparisons. Provider calendar gaps limit observations; results cannot establish full-period performance. Retrospective chronological validation, no tuning.', summaries, cohorts: results };
  writeFileSync('data/backtest/wide/results.json', JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ output: 'data/backtest/wide/results.json', coverage: { codes: panel.size, sessions: calendar.length }, summaries: Object.fromEntries(Object.entries(summaries).map(([p, summary]) => [p, { benchmark: summary.benchmark, strategies: Object.fromEntries(Object.entries(summary.strategies).map(([id, stats]: [string, any]) => [id, { ...stats, daily: undefined }])) }])) }, null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
