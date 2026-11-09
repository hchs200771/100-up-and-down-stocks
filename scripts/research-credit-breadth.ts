/** Local-only descriptive research. Run: npx tsx scripts/research-credit-breadth.ts */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createPanel, addDayQuotes, addReferenceEvent, finalizePanel, type NormalizedQuote } from './lib/wide-market-panel.ts';

const started = performance.now();
const OUT = 'data/backtest/credit-breadth';
const finite = Number.isFinite;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
function quantile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y), k = (a.length - 1) * p, lo = Math.floor(k);
  return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (k - lo);
}
const blank = (n: number) => Array<number>(n).fill(NaN);
interface Observation { date: string; value: number }
const warnings: string[] = [];
const coverage: Record<string, unknown> = {};
function csv(id: string): Observation[] {
  const lines = readFileSync(`data/backtest/credit-spread/${id}.csv`, 'utf8').trim().split(/\r?\n/);
  const rows: Observation[] = [];
  let missing = 0;
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',').map(x => x.trim().replace(/^"|"$/g, ''));
    if (!raw || raw === '.' || !finite(Number(raw))) { missing++; continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid ${id} date: ${date}`);
    rows.push({ date, value: Number(raw) });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length || new Set(rows.map(r => r.date)).size !== rows.length) throw new Error(`Empty/duplicate CSV: ${id}`);
  coverage[id] = { start: rows[0].date, end: rows.at(-1)!.date, observations: rows.length, skippedMissing: missing };
  return rows;
}
const ids = ['BAA10Y', 'BAMLH0A0HYM2', 'BAMLH0A3HYC', 'BAMLC0A0CM'] as const;
const source = Object.fromEntries([...ids, 'SP500', 'VIXCLS'].map(id => [id, csv(id)]));
const benchmark = JSON.parse(readFileSync('research/wide-market/benchmark-input.json', 'utf8')).benchmarkTotalReturn.TaiwanStockPrice as { date: string; close: number }[];
benchmark.sort((a, b) => a.date.localeCompare(b.date));
const dates = benchmark.map(r => r.date), taiex = benchmark.map(r => r.close), n = dates.length;
if (taiex.some(x => !finite(x) || x <= 0)) throw new Error('Invalid TAIEX closes');
coverage.TAIEX = { start: dates[0], end: dates.at(-1), observations: n };

// Strict inequality for Taiwan: same-date US closes are still in the future.
function align(rows: Observation[], calendar: string[], strict: boolean, label: string): number[] {
  let j = -1, stale = 0, carried = 0;
  const out = calendar.map(date => {
    while (j + 1 < rows.length && (strict ? rows[j + 1].date < date : rows[j + 1].date <= date)) j++;
    if (j < 0) return NaN;
    const age = (Date.parse(date) - Date.parse(rows[j].date)) / 86400000;
    if (age > 7) { stale++; return NaN; }
    if (age > (strict ? 1 : 0)) carried++;
    return rows[j].value;
  });
  coverage[label] = { valid: out.filter(finite).length, unavailable: out.filter(x => !finite(x)).length, carried, staleOver7Days: stale };
  if (stale) warnings.push(`${label}: ${stale} sessions rejected because the latest observation was >7 calendar days old.`);
  return out;
}
function difference(x: number[], h: number): number[] { return x.map((v, i) => i >= h && finite(v) && finite(x[i - h]) ? v - x[i - h] : NaN); }
function returns(x: number[], h: number, forward = false): number[] {
  return x.map((v, i) => {
    const j = forward ? i + h : i - h;
    return j >= 0 && j < x.length && v > 0 && x[j] > 0 ? (forward ? x[j] / v : v / x[j]) - 1 : NaN;
  });
}
function ranks(x: number[]): number[] {
  const sorted = x.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v), r = blank(x.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
    for (let k = i; k < j; k++) r[sorted[k].i] = (i + j - 1) / 2;
    i = j;
  }
  return r;
}
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let cross = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; cross += x * y; va += x * x; vb += y * y; }
  return a.length >= 3 && va > 0 && vb > 0 ? cross / Math.sqrt(va * vb) : NaN;
}
function correlation(x: number[], y: number[], spacing = 1) {
  const a: number[] = [], b: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++) if (finite(x[i]) && finite(y[i]) && i - last >= spacing) { a.push(x[i]); b.push(y[i]); last = i; }
  return { n: a.length, pearson: pearson(a, b), spearman: pearson(ranks(a), ranks(b)) };
}
function correlations(x: number[], index: number[]) {
  return { levels: correlation(x, index), weeklyChangesVsReturns: correlation(difference(x, 5), returns(index, 5)) };
}
function leadLag(x: number[], index: number[]) {
  return [5, 20].flatMap(past => [5, 20, 60].map(forward => ({
    past, forward,
    // Spacing past+forward also prevents reuse between the full predictor/outcome windows.
    nonOverlapping: correlation(difference(x, past), returns(index, forward, true), past + forward),
    overlapping: correlation(difference(x, past), returns(index, forward, true)),
  })));
}
function rng(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
// Resample ALL eligible entry months jointly, recomputing both conditional and baseline means.
function bootstrap(calendar: string[], ret: number[], mask: boolean[], eligible: boolean[]) {
  const grouped = new Map<string, number[]>();
  for (let i = 0; i < ret.length; i++) if (eligible[i]) {
    const m = calendar[i].slice(0, 7), g = grouped.get(m) ?? [0, 0, 0, 0];
    g[0] += ret[i]; g[1]++;
    if (mask[i]) { g[2] += ret[i]; g[3]++; }
    grouped.set(m, g);
  }
  const groups = [...grouped.values()], random = rng(20261109), draws: number[] = [];
  for (let k = 0; k < 1000 && groups.length; k++) {
    let bs = 0, bn = 0, cs = 0, cn = 0;
    for (let j = 0; j < groups.length; j++) { const g = groups[Math.floor(random() * groups.length)]; bs += g[0]; bn += g[1]; cs += g[2]; cn += g[3]; }
    if (cn) draws.push(cs / cn - bs / bn);
  }
  return { lo: quantile(draws, 0.025), hi: quantile(draws, 0.975), draws: 1000, validDraws: draws.length, baselineMonths: groups.length,
    signalMonths: groups.filter(g => g[3] > 0).length };
}
interface Condition { signal: string; mask: boolean[]; valid: boolean[] }
function condition(signal: string, x: number[], predicate: (v: number, i: number) => boolean): Condition {
  return { signal, mask: x.map((v, i) => finite(v) && predicate(v, i)), valid: x.map(finite) };
}
function quintiles(label: string, x: number[]) {
  const cuts = [0.2, 0.4, 0.6, 0.8].map(p => quantile(x.filter(finite), p));
  const conditions = Array.from({ length: 5 }, (_, q) => condition(`${label}:Q${q + 1}`, x, v => cuts.filter(c => v > c).length === q));
  return { cuts, conditions };
}
function conditional(calendar: string[], index: number[], conditions: Condition[]) {
  return conditions.flatMap(c => [20, 60].map(horizon => {
    const ret = returns(index, horizon, true), eligible = ret.map((r, i) => finite(r) && c.valid[i]);
    const selected = ret.filter((_, i) => eligible[i] && c.mask[i]), base = ret.filter((_, i) => eligible[i]);
    const signalDates = calendar.filter((_, i) => eligible[i] && c.mask[i]);
    return { signal: c.signal, horizon, n: selected.length, baselineN: base.length,
      first: signalDates[0] ?? null, last: signalDates.at(-1) ?? null,
      meanReturn: mean(selected), hitRate: selected.length ? selected.filter(r => r > 0).length / selected.length : NaN,
      baselineMean: mean(base), baselineHitRate: base.length ? base.filter(r => r > 0).length / base.length : NaN,
      excessMean: mean(selected) - mean(base), excessCI95: bootstrap(calendar, ret, c.mask, eligible) };
  }));
}
function drawdowns(calendar: string[], index: number[], rapid: Condition) {
  return [20, 60].map(horizon => {
    const mdd = (i: number) => {
      let peak = index[i], worst = 0;
      for (let j = i + 1; j <= i + horizon; j++) { peak = Math.max(peak, index[j]); worst = Math.min(worst, index[j] / peak - 1); }
      return worst;
    };
    const episodes: { date: string; maxDrawdown: number }[] = [], baseline: number[] = [];
    let lastSignal = -Infinity, lastBase = -Infinity;
    for (let i = 0; i + horizon < index.length; i++) {
      if (!rapid.valid[i]) continue;
      if (i - lastBase >= horizon) { baseline.push(mdd(i)); lastBase = i; }
      if (rapid.mask[i] && !rapid.mask[i - 1] && i - lastSignal >= horizon) { episodes.push({ date: calendar[i], maxDrawdown: mdd(i) }); lastSignal = i; }
    }
    const values = episodes.map(e => e.maxDrawdown);
    return { horizon, n: values.length, meanMaxDrawdown: mean(values), medianMaxDrawdown: quantile(values, 0.5),
      worstMaxDrawdown: values.length ? Math.min(...values) : NaN, baselineN: baseline.length, baselineMeanMaxDrawdown: mean(baseline), episodes };
  });
}

console.error(`Loading adjusted breadth panel: ${n} Taiwan sessions...`);
const panel = createPanel(dates);
interface Action { code: string; date: string; reference: number; kind: string }
const actions = (JSON.parse(readFileSync('data/backtest/wide/actions/twse-ex-references.json', 'utf8')).rows as Action[]).filter(a => /^\d{4}$/.test(a.code));
const byKey = new Map(actions.map(a => [`${a.date}/${a.code}`, a]));
const missingFiles: string[] = [], incomplete = new Set<number>();
let progressAt = performance.now();
for (let i = 0; i < n; i++) {
  for (const market of ['twse', 'tpex']) {
    const file = `data/backtest/wide/daily/${market}/${dates[i]}.json.gz`;
    if (!existsSync(file)) { missingFiles.push(file); incomplete.add(i); continue; }
    const rows = (JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')).rows as NormalizedQuote[]).filter(q => /^\d{4}$/.test(q.code));
    addDayQuotes(panel, i, rows.map(q => {
      const a = byKey.get(`${dates[i]}/${q.code}`);
      return a ? { ...q, explicitReference: a.reference, changeLabel: a.kind } : q;
    }));
  }
  if (performance.now() - progressAt > 30000) { console.error(`Breadth loading: ${i + 1}/${n} sessions (${dates[i]})`); progressAt = performance.now(); }
}
const dateIndex = new Map(dates.map((d, i) => [d, i]));
for (const a of actions) { const i = dateIndex.get(a.date); if (i !== undefined) addReferenceEvent(panel, i, a.code, a.reference); }
finalizePanel(panel);
const above = Object.fromEntries([20, 60, 200].map(h => [h, Array<number>(n).fill(0)]));
const eligibleMa = Object.fromEntries([20, 60, 200].map(h => [h, Array<number>(n).fill(0)]));
const advancers = Array<number>(n).fill(0), decliners = Array<number>(n).fill(0), unchanged = Array<number>(n).fill(0);
const highs = Array<number>(n).fill(0), lows = Array<number>(n).fill(0), eligibleHighLow = Array<number>(n).fill(0), observed = Array<number>(n).fill(0);
let unresolved = 0;
for (const s of panel.values()) {
  unresolved += s.unresolvedAdjustmentIndices.length;
  let run = 0;
  const sums: Record<number, number> = { 20: 0, 60: 0, 200: 0 };
  for (let i = 0; i < n; i++) {
    const px = s.adjustedClose[i], ok = finite(px) && px > 0 && s.segmentId[i] >= 0;
    if (!ok || (i > 0 && s.segmentId[i] !== s.segmentId[i - 1])) { run = 0; sums[20] = sums[60] = sums[200] = 0; }
    if (!ok) continue;
    run++;
    const quoted = !!s.seen[i] && s.close[i] > 0 && !incomplete.has(i);
    if (quoted) {
      observed[i]++;
      if (finite(s.change[i]) && !/^[XＸ]/u.test(s.changeLabel[i].trim())) {
        if (s.change[i] > 0) advancers[i]++; else if (s.change[i] < 0) decliners[i]++; else unchanged[i]++;
      }
    }
    for (const h of [20, 60, 200]) {
      sums[h] += px;
      if (run > h) sums[h] -= s.adjustedClose[i - h];
      if (quoted && run >= h) { eligibleMa[h][i]++; if (px > sums[h] / h) above[h][i]++; }
    }
    if (quoted && run >= 61) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - 60; j < i; j++) { hi = Math.max(hi, s.adjustedClose[j]); lo = Math.min(lo, s.adjustedClose[j]); }
      eligibleHighLow[i]++;
      if (px > hi) highs[i]++; if (px < lo) lows[i]++;
    }
  }
}
const pctAbove = (h: number) => dates.map((_, i) => !incomplete.has(i) && eligibleMa[h][i] ? above[h][i] / eligibleMa[h][i] * 100 : NaN);
const pct20 = pctAbove(20), pct60 = pctAbove(60), pct200 = pctAbove(200);
let cumulative = 0;
const adLine = dates.map((_, i) => { if (incomplete.has(i) || !observed[i]) return NaN; cumulative += advancers[i] - decliners[i]; return cumulative; });
const adRatio = dates.map((_, i) => !incomplete.has(i) && decliners[i] ? advancers[i] / decliners[i] : NaN);
const netHighs = dates.map((_, i) => !incomplete.has(i) && eligibleHighLow[i] ? highs[i] - lows[i] : NaN);
coverage.breadth = { stocks: panel.size, missingFiles, incompleteSessions: incomplete.size, unresolvedAdjustmentEvents: unresolved,
  firstMA20: dates[pct20.findIndex(finite)], firstMA60: dates[pct60.findIndex(finite)], firstMA200: dates[pct200.findIndex(finite)],
  lastEligibleMA20: eligibleMa[20].at(-1), lastEligibleMA60: eligibleMa[60].at(-1), lastEligibleMA200: eligibleMa[200].at(-1),
  advDeclUnavailableSessions: adRatio.filter(x => !finite(x)).length };
if (missingFiles.length) warnings.push(`${missingFiles.length} missing quote files: all breadth measures masked on affected dates; AD line resumes without reconstructing missing advances/declines.`);
if (unresolved) warnings.push(`${unresolved} unresolved corporate-action events: panel segment resets prevent MAs spanning these breaks.`);
warnings.push('MA warm-up starts in January 2019; MA200 is unavailable initially. Historical universe is the cached four-digit listings, including inactive names when quoted; no present-day constituent filter.');
warnings.push('HY/CCC/IG history begins in November 2023; 252-session rapid-widening percentile rule has an additional one-year warm-up. Short-history results may represent few independent episodes.');
warnings.push('US and Taiwan sample end dates differ. VIX is audited for coverage only; it is not one of the requested spread predictors.');
console.error(`Panel complete: ${panel.size} stocks; ${missingFiles.length} missing quote files. Computing statistics...`);

const usDates = source.SP500.map(r => r.date), sp500 = source.SP500.map(r => r.value);
const credit: Record<string, unknown> = {}, alignedTW: Record<string, number[]> = {};
type ConditionalRow = ReturnType<typeof conditional>[number];
const summaryRows: { name: string; level: number; weekly: number; lead20to20: number; lead20to60: number }[] = [];
const keyConditions: (ConditionalRow & { predictor: string })[] = [];
for (const id of ids) {
  const byIndex: Record<string, unknown> = {};
  for (const target of ['SP500', 'TAIEX']) {
    const calendar = target === 'SP500' ? usDates : dates, index = target === 'SP500' ? sp500 : taiex;
    const x = align(source[id], calendar, target === 'TAIEX', `${id}/${target}`);
    if (target === 'TAIEX') alignedTW[id] = x;
    const delta20 = difference(x, 20), relative20 = x.map((v, i) => i >= 20 && x[i - 20] > 0 && finite(v) ? v / x[i - 20] - 1 : NaN);
    const ma50 = x.map((_, i) => i >= 49 && x.slice(i - 49, i + 1).every(finite) ? mean(x.slice(i - 49, i + 1)) : NaN);
    const p80 = x.map((_, i) => i >= 252 && x.slice(i - 252, i).every(finite) ? quantile(x.slice(i - 252, i), 0.8) : NaN);
    // OR is evaluable before percentile warm-up when the relative-change branch is available.
    const rapid = condition('rapidWidening', relative20, (v, i) => v >= 0.2 || (finite(p80[i]) && x[i] > p80[i] && delta20[i] > 0));
    const q = quintiles('change20', delta20);
    const maDistance = x.map((v, i) => finite(ma50[i]) ? v - ma50[i] : NaN);
    const conditions = [...q.conditions, rapid,
      condition('rapidRelative20_ge20pct', relative20, v => v >= 0.2),
      condition('aboveTrailing1yP80_andRising20', p80.map((p, i) => finite(p) && finite(delta20[i]) ? x[i] - p : NaN), (v, i) => v > 0 && delta20[i] > 0),
      condition('aboveMA50', maDistance, v => v > 0), condition('belowOrEqualMA50', maDistance, v => v <= 0)];
    const corr = correlations(x, index), lead = leadLag(x, index), cond = conditional(calendar, index, conditions);
    byIndex[target] = { correlations: corr, leadLag: lead, change20QuintileCuts: q.cuts, conditionalReturns: cond, rapidWideningDrawdowns: drawdowns(calendar, index, rapid) };
    summaryRows.push({ name: `${id}/${target}`, level: corr.levels.pearson, weekly: corr.weeklyChangesVsReturns.pearson,
      lead20to20: lead.find(r => r.past === 20 && r.forward === 20)!.nonOverlapping.pearson,
      lead20to60: lead.find(r => r.past === 20 && r.forward === 60)!.nonOverlapping.pearson });
    keyConditions.push(...cond.filter(r => ['rapidWidening', 'aboveMA50'].includes(r.signal)).map(r => ({ predictor: `${id}/${target}`, ...r })));
  }
  credit[id] = byIndex;
  console.error(`Statistics complete: ${id}`);
}
const breadthInputs: Record<string, number[]> = { pctAboveMa20: pct20, pctAboveMa60: pct60, pctAboveMa200: pct200, advDeclRatio: adRatio, adLine, newHighsMinusLows60: netHighs };
const breadthMetrics = Object.fromEntries(Object.entries(breadthInputs).map(([name, x]) => {
  const corr = correlations(x, taiex), lead = leadLag(x, taiex);
  summaryRows.push({ name, level: corr.levels.pearson, weekly: corr.weeklyChangesVsReturns.pearson,
    lead20to20: lead.find(r => r.past === 20 && r.forward === 20)!.nonOverlapping.pearson,
    lead20to60: lead.find(r => r.past === 20 && r.forward === 60)!.nonOverlapping.pearson });
  return [name, { correlations: corr, leadLag: lead }];
}));
const levelQ = quintiles('pctAboveMa60', pct60), changeQ = quintiles('pctAboveMa60Change20', difference(pct60, 20));
const divergence = blank(n);
for (let i = 59; i < n; i++) {
  const b = pct60.slice(i - 59, i + 1);
  if (!b.every(finite)) continue;
  divergence[i] = taiex[i] >= Math.max(...taiex.slice(i - 59, i + 1)) && Math.max(...b) - pct60[i] >= 10 ? 1 : 0;
}
const breadthConditional = conditional(dates, taiex, [...levelQ.conditions, ...changeQ.conditions,
  condition('pctAboveMa60_lt20', pct60, v => v < 20), condition('pctAboveMa60_gt80', pct60, v => v > 80),
  condition('bearishDivergence', divergence, v => v === 1)]);
keyConditions.push(...breadthConditional.map(r => ({ predictor: 'breadth/TAIEX', ...r })));
const results = {
  generatedAt: new Date().toISOString(), runtimeSeconds: 0,
  methodology: {
    scope: 'Local-only, exploratory/descriptive associations; no transaction costs, causal claims, or fitted trading strategy. Index price returns, not total returns.',
    units: 'Index returns, excess returns, hit rates, and drawdowns are fractions. Spread values/changes are percentage points; breadth percentages/changes are percentage points (0–100).',
    alignment: 'SP500 valid observations define US sessions; US spread date <= index date. TAIEX: latest spread date strictly < TW date. Carry forward at most 7 calendar days; no backfill. All lags, MAs, and lookbacks use target-index sessions after alignment.',
    correlations: 'Levels vs index levels (potentially spurious trends); 5-session absolute predictor changes vs backward 5-session simple index returns. Pairwise finite observations; Spearman uses average tied ranks. Weekly correlations overlap.',
    leadLag: 'Predictor absolute changes over past 5/20 target sessions vs forward 5/20/60 close-to-close returns. Headline samples greedily spaced past+forward sessions from first valid pair; full predictor/outcome windows do not overlap (shared boundary closes allowed). Overlapping estimates also supplied.',
    signals: 'Evaluated at target-index close, forward returns start at that close. Quintile cuts use full-sample finite predictor values and are descriptive, not investable historical thresholds; ties go to lower bucket and may leave empty buckets.',
    rapidWidening: '20-session relative increase >=20% OR level >80th percentile of previous 252 aligned sessions AND 20-session absolute change >0. Relative branch available after 20 sessions; percentile branch requires full 252-session history. MA50 includes current session; equality assigned to belowOrEqual.',
    conditionalBaseline: 'For each signal/horizon, all dates with required predictor data and complete forward index return; same eligible dates form unconditional mean. Daily signals and forward outcomes overlap; n counts signal-days, not independent episodes.',
    bootstrap: 'Seeded 1000-draw percentile bootstrap of calendar entry-month clusters. Sample all eligible months with replacement, jointly recompute conditional and unconditional means, take conditional minus baseline; exclude draws with zero selected events. Monthly clustering does not fully remove cross-month dependence in 60-session overlapping outcomes; no multiple-testing correction.',
    drawdowns: '20/60-session close-to-close peak-to-trough maximum drawdown, negative fraction; peaks start at signal close. Episodes start only on false-to-true rapid-widening transitions, thinned by horizon. Baseline uses horizon-spaced eligible entries over same predictor-available period; different phase/event counts limit comparisons.',
    breadth: 'TWSE+TPEx observed positive-close four-digit codes only. MAs use panel-adjusted closes and reset at segment breaks; require h consecutive valid adjusted calendar-session closes. Suspended/missing quotes may be carried inside historical windows, but current-day membership requires an actual positive quote. No pre-2019 warm-up.',
    advanceDecline: 'Official numeric quote change sign, excluding X/Ｘ noncomparable labels; zero changes tracked separately. A/D ratio missing if no decliners. Cumulative AD starts at zero. New highs/lows compare adjusted current close strictly to previous 60 adjusted closes in same segment.',
    bearishDivergence: 'TAIEX close >= trailing 60-session maximum including current; pctAboveMa60 at least 10 percentage points below its trailing 60-session maximum, requiring all 60 breadth observations.',
  }, coverage, warnings,
  credit, breadth: { metrics: breadthMetrics, levelQuintileCuts: levelQ.cuts, change20QuintileCuts: changeQ.cuts,
    conditionalReturns: breadthConditional,
    daily: dates.map((date, i) => ({ date, pctAboveMa20: pct20[i], pctAboveMa60: pct60[i], pctAboveMa200: pct200[i],
      eligibleMa20: eligibleMa[20][i], eligibleMa60: eligibleMa[60][i], eligibleMa200: eligibleMa[200][i],
      observed: observed[i], advancers: incomplete.has(i) ? NaN : advancers[i], decliners: incomplete.has(i) ? NaN : decliners[i], unchanged: incomplete.has(i) ? NaN : unchanged[i],
      advDeclRatio: adRatio[i], adLine: adLine[i], newHighs60: finite(netHighs[i]) ? highs[i] : NaN, newLows60: finite(netHighs[i]) ? lows[i] : NaN,
      eligibleHighLow60: eligibleHighLow[i], newHighsMinusLows60: netHighs[i], bearishDivergence: divergence[i] })) },
};
mkdirSync(OUT, { recursive: true });
const series = dates.map((date, i) => ({ date, taiex: taiex[i], baa10y: alignedTW.BAA10Y[i], hyOas: alignedTW.BAMLH0A0HYM2[i], cccOas: alignedTW.BAMLH0A3HYC[i], pctAboveMa60: pct60[i], pctAboveMa20: pct20[i], adLine: adLine[i] }));
writeFileSync(`${OUT}/series.json`, JSON.stringify(series));
results.runtimeSeconds = (performance.now() - started) / 1000;
// JSON serializes NaN as null, preserving gaps rather than inventing zero observations.
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const fmt = (x: number, digits = 3) => finite(x) ? x.toFixed(digits) : 'NA';
console.log('\nPearson correlations (complete Pearson/Spearman + counts in results.json):');
console.table(summaryRows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? fmt(v) : v]))));
console.log('\nConditional returns: %, excess/CI in percentage points; overlapping signal-days.');
console.table(keyConditions.map(r => ({ predictor: r.predictor, signal: r.signal, h: r.horizon, n: r.n,
  meanPct: fmt(r.meanReturn * 100, 2), hitPct: fmt(r.hitRate * 100, 1), baselinePct: fmt(r.baselineMean * 100, 2),
  excessPP: fmt(r.excessMean * 100, 2), CI95: `[${fmt(r.excessCI95.lo * 100, 2)}, ${fmt(r.excessCI95.hi * 100, 2)}]`, months: r.excessCI95.signalMonths })));
console.log(`\nRuntime: ${results.runtimeSeconds.toFixed(2)}s. Outputs: ${OUT}/{results,series}.json`);
for (const warning of warnings) console.log(`WARNING: ${warning}`);
