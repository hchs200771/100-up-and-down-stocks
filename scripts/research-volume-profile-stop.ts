/** Paired, close-confirmed stop experiment. Offline only; run with node --import tsx. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { volumeProfileStop } from './lib/volume-profile-stop.ts';
import { loadExitResearch, COST, SEED, rng, type Signal } from './lib/exit-research.ts';
const started = Date.now(), ITERATIONS = 2000;
const OUT = 'data/backtest/volume-profile-stop-results.json';
const log = (s: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${s}`);
const { calendar, N, last, signals, ew, missing, excluded, exclusionDetails, profile, qualified, cache, forEachSample } = loadExitResearch(log);
const methods = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'] as const;
type Method = typeof methods[number];
interface Outcome { ret: number; hold: number; exit: string; exitDate: string; risk: number | null; r: number | null; washed: boolean | null }
interface Entry { id: string; code: string; date: string; group: string; pair: string; tooFar: boolean; stop: number; structuralStop: number | null; target: number | null; historyDays: number; ex20: number | null; ex60: number | null; outcomes: Partial<Record<Method, Outcome>> }
const entries: Entry[] = [];
function run(g: Signal, group: 'A' | 'B', pair: string): boolean {
  const p = qualified(g, group), { x, t } = g, s = x.s, entry = s.adjustedClose[t];
  if (!p) return false;
  const stops: Record<Method, number | null> = { S0: null, S1: entry * .93, S2: entry * .9, S3: entry - 1.5 * p.atr14, S4: entry - 2 * p.atr14, S5: s.adjustedLow[t] * .999, S6: p.stop, S7: p.structuralStop, S8: p.stop, S9: p.stop };
  const fwd = (h: number) => t + h < N && s.segmentId[t + h] === s.segmentId[t] ? s.adjustedClose[t + h] / entry - 1 - (ew[t + h] / ew[t] - 1) : null;
  const e: Entry = { id: `${group}/${pair}`, code: s.code, date: calendar[t], group, pair, tooFar: p.tooFar, stop: p.stop, structuralStop: p.structuralStop, target: p.targetPrice, historyDays: p.historyDays, ex20: fwd(20), ex60: fwd(60), outcomes: {} };
  for (const method of methods) {
    if (method === 'S8' && p.tooFar) continue;
    const stop = stops[method]; let end = t, exit = 'endOfData';
    for (let j = t + 1; j < N && j <= t + 120; j++) {
      if (s.segmentId[j] !== s.segmentId[t]) { exit = 'segmentEnd'; break; }
      if (!s.seen[j] || !(s.adjustedClose[j] > 0)) continue;
      end = j;
      if (stop !== null && s.adjustedClose[j] < stop) { exit = 'stop'; break; }
      if (method === 'S9' && p.targetPrice !== null && s.adjustedClose[j] >= p.targetPrice) { exit = 'target'; break; }
      if (s.adjustedClose[j] < x.ma[j]) { exit = 'ma20'; break; }
      if (j === t + 120) exit = 'max120';
    }
    const ret = s.adjustedClose[end] / entry - 1 - COST, risk = stop === null ? null : (entry - stop) / entry;
    let washed: boolean | null = null;
    if (exit === 'stop') {
      let recovered = false, complete = end + 20 < N;
      for (let j = end + 1; j <= Math.min(end + 20, N - 1); j++) {
        if (s.segmentId[j] !== s.segmentId[t]) { complete = false; break; }
        if (s.seen[j] && s.adjustedClose[j] >= entry) recovered = true;
      }
      washed = complete ? recovered : null;
    }
    e.outcomes[method] = { ret, hold: end - t, exit, exitDate: calendar[end], risk, r: risk !== null && risk > 0 ? ret / risk : null, washed };
  }
  entries.push(e); return true;
}
log(`signals A=${signals.length}; start direct VP calls`);
forEachSample(run);
const mean = (a: number[]) => a.length ? a.reduce((a, b) => a + b, 0) / a.length : null;
const pct = (v: number | null) => v === null ? null : v * 100;
const values = (a: (number | null)[]) => a.filter((x): x is number => x !== null && Number.isFinite(x));
function bootstrap(es: Entry[], method: Method) {
  const blocks = new Map<string, { sum: number; n: number }>();
  for (const e of es) {
    const a = e.outcomes[method], b = e.outcomes.S2; if (!a || !b) continue;
    const key = e.date.slice(0, 7), block = blocks.get(key) ?? { sum: 0, n: 0 };
    block.sum += a.ret - b.ret; block.n++; blocks.set(key, block);
  }
  const bs = [...blocks.values()], draw = rng(SEED), samples: number[] = [];
  if (!bs.length) return { meanDifferencePp: null, ci95Pp: [null, null], months: 0, n: 0 };
  for (let i = 0; i < ITERATIONS; i++) { let sum = 0, n = 0; for (let k = 0; k < bs.length; k++) { const b = bs[Math.floor(draw() * bs.length)]; sum += b.sum; n += b.n; } samples.push(sum / n * 100); }
  samples.sort((a, b) => a - b);
  return { meanDifferencePp: bs.reduce((a, b) => a + b.sum, 0) / bs.reduce((a, b) => a + b.n, 0) * 100, ci95Pp: [samples[49], samples[1949]], months: bs.length, n: bs.reduce((a, b) => a + b.n, 0) };
}
function stats(es: Entry[], method: Method) {
  es = es.filter(e => e.outcomes[method]);
  const os = es.map(e => e.outcomes[method]!), rets = os.map(o => o.ret).sort((a, b) => a - b), n = os.length;
  const avgWin = mean(rets.filter(v => v > 0)), avgLoss = mean(rets.filter(v => v <= 0));
  const stops = os.filter(o => o.exit === 'stop'), wash = stops.filter(o => o.washed !== null);
  return { n, avgPct: pct(mean(rets)), medianPct: n ? (rets[Math.floor((n - 1) / 2)] + rets[Math.floor(n / 2)]) / 2 * 100 : null, winPct: n ? rets.filter(v => v > 0).length / n * 100 : null, avgWinPct: pct(avgWin), avgLossPct: pct(avgLoss), payoff: avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null, hold: mean(os.map(o => o.hold)), stopRatePct: n ? stops.length / n * 100 : null, washRatePct: wash.length ? wash.filter(o => o.washed).length / wash.length * 100 : null, washEligible: wash.length, washCensored: stops.length - wash.length, avgStopDistancePct: pct(mean(values(os.map(o => o.risk)))), stopDefinedN: os.filter(o => o.risk !== null).length, avgR: mean(values(os.map(o => o.r))), rN: os.filter(o => o.r !== null).length, ex20Pct: pct(mean(values(es.map(e => e.ex20)))), ex20N: values(es.map(e => e.ex20)).length, ex60Pct: pct(mean(values(es.map(e => e.ex60)))), ex60N: values(es.map(e => e.ex60)).length, exits: Object.fromEntries([...new Set(os.map(o => o.exit))].map(k => [k, os.filter(o => o.exit === k).length])), vsS2: bootstrap(es, method) };
}
const periods = { train: (e: Entry) => e.date < '2016-01-01', validation: (e: Entry) => e.date >= '2016-01-01', all: (_e: Entry) => true };
function summarize(es: Entry[], subset: boolean) {
  const ms = subset ? methods.filter(m => m !== 'S7' && m !== 'S9') : methods;
  const summarizePeriod = (rows: Entry[]) => Object.fromEntries(ms.map(m => [m, stats(rows, m)]));
  return { ...Object.fromEntries(Object.entries(periods).map(([key, fn]) => [key, summarizePeriod(es.filter(fn))])), byYear: Object.fromEntries([...new Set(es.map(e => e.date.slice(0, 4)))].sort().map(y => [y, summarizePeriod(es.filter(e => e.date.startsWith(y)))])) };
}
log(`aggregate ${entries.length} entries`);
let cacheChecks = 0;
for (let i = 0; i < signals.length && cacheChecks < 20; i += Math.max(1, Math.floor(signals.length / 20))) {
  const g = signals[i], key = `${g.x.s.code}/${g.t}`, cached = cache.get(key);
  const direct = profile(g, true);
  const scalar = (p: ReturnType<typeof volumeProfileStop>) => p && [p.stop, p.structuralStop, p.targetPrice, p.atr14, p.tooFar, p.historyDays];
  assert.deepEqual(scalar(cached!), scalar(direct)); cacheChecks++;
}
for (const e of entries) {
  assert(e.historyDays >= 120);
  for (const m of methods.filter(m => m !== 'S8')) assert(e.outcomes[m], `${e.id} missing ${m}`);
  assert.equal(Boolean(e.outcomes.S8), !e.tooFar);
  if (!e.tooFar) assert.deepEqual(e.outcomes.S8, e.outcomes.S6);
  assert.equal(e.outcomes.S0!.risk, null);
  assert.equal(e.outcomes.S0!.exit === 'stop', false);
  for (const o of Object.values(e.outcomes)) assert(Number.isFinite(o.ret) && o.hold <= 120 && o.hold >= 0);
}
const results = Object.fromEntries(['A', 'B'].map(group => { const es = entries.filter(e => e.group === group); return [group, { full: summarize(es, false), notTooFar: summarize(es.filter(e => !e.tooFar), true) }]; }));
const output = { generatedAt: new Date().toISOString(), runtimeSeconds: (Date.now() - started) / 1000, period: [calendar[0], last], entryPeriod: [entries[0]?.date, entries.at(-1)?.date], seed: SEED, cost: COST, bootstrapIterations: ITERATIONS, missingFiles: missing, excluded, exclusionDetails, directCacheChecks: cacheChecks, methods: { S0: '無停損', S1: '固定−7%', S2: '固定−10%', S3: '1.5 ATR14', S4: '2 ATR14', S5: '突破K低×0.999', S6: '價量完整版', S7: '價量結構無上限', S8: '價量且非tooFar', S9: '價量＋首量峰停利' }, methodology: ['Calendar before 2019 extended from cached daily filenames; benchmark input only starts in 2019.', 'Rolling sums recover after invalid values to include later listings; original backtest-new-high naive sums can remain NaN forever. Original script unchanged.', 'Signals otherwise match 250-day high / 20-day prior-high age / 20-day cooldown; previous-day money20 >=30m, raw close>=10; limit-up proxy adjusted close return>=9.5%.', 'VP uses direct volumeProfileStop calls, observed same-segment OHLCV only, trailing two calendar years; volume in original shares as panel has no adjusted-volume field.', 'S5 uses entry low * .999 as backtest-new-high; all exits here are close-confirmed, strict close<stop. Stop beats target/MA on same day.', '120-day holding and 20-day wash windows use market sessions; stop recovery excludes exit day. All incomplete follow-up windows excluded from wash denominator, including observed early recoveries.', 'Segment break exits at last observed same-segment close. End-of-data positions liquidated; no invented delisting loss. See exits counters.', '20/60 excess is gross buy-and-hold signal return minus liquid-stock EW compounded daily return (same formula as backtest-new-high), independent of stop; missing horizons excluded.', 'Bootstrap resamples entry months with replacement, retaining all entries and weighting by entry count; 2000 samples, same fixed seed for every comparison; no multiple-test adjustment.', 'B draws with replacement, one non-A stock per accepted A signal on same date, then drops insufficient-history B across all methods; group pair key retained.', 'S8 has its own smaller sample; notTooFar reports S0–S6 and S8 on exactly that subset. All statistics are per-entry, not portfolio returns.'], results, entries };
mkdirSync('data/backtest', { recursive: true }); writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');
log(`wrote ${OUT}; exclusions ${JSON.stringify(excluded)}`);

// Reproducible SVGs and factor-lab entry; no publication.
const experimentId = '2026-11-13-volume-profile-stop', chartDir = `research/factor-lab/charts/${experimentId}`;
mkdirSync(chartDir, { recursive: true });
// Aggregation shape is dynamic by group/period/method; scalar stats remain typed above.
const res = results as Record<string, any>;
const f = (v: number | null, digits = 2) => v === null ? '—' : v.toFixed(digits);
const svg = (title: string, body: string, height = 520) => `<svg viewBox="0 0 900 ${height}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif" font-size="12" fill="currentColor"><title>${title}</title><text x="450" y="26" text-anchor="middle" font-size="16" font-weight="600">${title}</text>${body}</svg>\n`;
const text = (x: number, y: number, s: string, extra = '') => `<text x="${x}" y="${y}" ${extra}>${s}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, extra = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" opacity=".2" ${extra}/>`;
{
  const max = Math.max(...methods.flatMap(m => ['train', 'validation'].map(p => res.A.full[p][m].avgPct)), 1) * 1.15;
  const scale = (v: number) => 200 + v / max * 620;
  let b = '';
  for (let i = 0; i <= 5; i++) { const v = max * i / 5, x = scale(v); b += line(x, 48, x, 476) + text(x, 495, `${f(v, 1)}%`, 'text-anchor="middle"'); }
  methods.forEach((m, i) => {
    const y = 55 + i * 42;
    b += text(190, y + 18, `${m} ${output.methods[m]}`, 'text-anchor="end"');
    ['train', 'validation'].forEach((p, j) => {
      const v = res.A.full[p][m].avgPct;
      b += `<rect x="200" y="${y + j * 17}" width="${scale(v) - 200}" height="14" fill="${j ? '#2f7fd8' : '#888888'}"/>` + text(scale(v) + 5, y + j * 17 + 11, f(v));
    });
  });
  b += text(200, 518, '灰：訓練 2005–2015　藍：驗證 2016–2026；S8 為非 tooFar 子樣本，不能與全樣本直接比較');
  writeFileSync(`${chartDir}/01-mean-return.svg`, svg('新高組：每筆平均淨報酬（%）', b, 535));
}
{
  const pts = methods.filter(m => m !== 'S0').map(m => ({ m, ...res.A.full.all[m] }));
  const xmax = Math.max(...pts.map(s => s.avgStopDistancePct)) * 1.15;
  const ymax = Math.max(...pts.map(s => s.washRatePct)) * 1.18;
  const sx = (v: number) => 85 + v / xmax * 730, sy = (v: number) => 435 - v / ymax * 360;
  let b = '';
  for (let i = 0; i <= 5; i++) {
    const x = xmax * i / 5, y = ymax * i / 5;
    b += line(sx(x), 65, sx(x), 435) + text(sx(x), 457, f(x, 1), 'text-anchor="middle"');
    b += line(85, sy(y), 820, sy(y)) + text(75, sy(y) + 4, f(y, 0), 'text-anchor="end"');
  }
  const offsets: Partial<Record<Method, [number, number]>> = { S9: [10, 17], S6: [10, -8], S1: [10, 14], S4: [10, -9] };
  for (const p of pts) {
    const x = sx(p.avgStopDistancePct), y = sy(p.washRatePct), off = offsets[p.m] ?? [10, -8];
    b += `<circle cx="${x}" cy="${y}" r="6" fill="${p.m === 'S6' || p.m === 'S9' ? '#de7b32' : '#2f7fd8'}"><title>${p.m}: 距離 ${f(p.avgStopDistancePct)}%, 被洗 ${f(p.washRatePct)}%</title></circle>` + text(x + off[0], y + off[1], p.m);
  }
  b += text(450, 486, '平均停損距離（%；S7 僅有結構停損者）', 'text-anchor="middle"') + text(85, 56, '被洗率（%）') + text(85, 512, '全期；S0 無停損不列。S8 是子樣本；被洗率分母僅含具完整 20 日追蹤的停損出場。');
  writeFileSync(`${chartDir}/02-wash-distance.svg`, svg('新高組：停損越近，是否越容易被洗？', b, 535));
}
{
  const rows = Object.entries(res.A.full.byYear) as [string, any][];
  const ymax = Math.max(...rows.map(([, r]) => Math.abs(r.S6.avgPct - r.S2.avgPct)), .2) * 1.2;
  const sy = (v: number) => 250 - v / ymax * 160;
  let b = '';
  for (let i = -2; i <= 2; i++) { const v = ymax * i / 2; b += line(75, sy(v), 850, sy(v)) + text(65, sy(v) + 4, f(v, 1), 'text-anchor="end"'); }
  rows.forEach(([year, r], i) => {
    const x = 85 + i * 760 / rows.length, d = r.S6.avgPct - r.S2.avgPct;
    b += `<rect x="${x}" y="${Math.min(sy(d), sy(0))}" width="${760 / rows.length - 5}" height="${Math.abs(sy(d) - sy(0))}" fill="${d >= 0 ? '#2f7fd8' : '#de7b32'}"><title>${year}: ${f(d)}pp, n=${r.S6.n}</title></rect>`;
    b += text(x + 10, 435, year.slice(2), 'text-anchor="middle"');
  });
  b += text(85, 57, 'S6 − S2，每筆平均淨報酬差（百分點；正值為價量較高）') + text(85, 478, '年份 2006–2026；2026 截至 9/30。年度結果屬描述統計，配對月份 bootstrap 區間見結果 JSON。');
  writeFileSync(`${chartDir}/03-yearly-difference.svg`, svg('新高組：價量完整版相對固定 −10% 的年度差異', b));
}
const aT = res.A.full.train, aV = res.A.full.validation, aAll = res.A.full.all;
const bT = res.B.full.train, bV = res.B.full.validation;
const ci = (s: any) => `[${s.vsS2.ci95Pp.map((v: number) => f(v)).join(', ')}]`;
const subset = res.A.notTooFar;
const entry = {
  id: experimentId, date: '2026-11-13', category: '出場規則／停損', title: '價量分布停損：比固定百分比更賺、更不容易被洗嗎？',
  question: '用價量分布量峰訂停損，會比固定百分比或 ATR 停損好嗎？',
  verdict: '不成立', verdictNote: `新高組價量停損兩段期望值均低於固定 −10%，且被洗率更高；驗證差 ${f(aV.S6.avgPct - aV.S2.avgPct)} 個百分點，95% CI 跨 0。`,
  summary: `新高組訓練 ${aT.S6.n} 筆、驗證 ${aV.S6.n} 筆：價量完整版每筆淨報酬 ${f(aT.S6.avgPct)}%／${f(aV.S6.avgPct)}%，固定 −10% 為 ${f(aT.S2.avgPct)}%／${f(aV.S2.avgPct)}%。價量被洗率 ${f(aT.S6.washRatePct, 1)}%／${f(aV.S6.washRatePct, 1)}%，固定 −10% 為 ${f(aT.S2.washRatePct, 1)}%／${f(aV.S2.washRatePct, 1)}%。比 ATR 或突破 K 低點更少被洗，但沒有證據顯示勝過固定 −10%。這只否定普遍優越的主張，不代表每檔股票都不適合結構停損。`,
  method: `wide-market 還原日線 2005-01-03～${last}，訊號自 ${output.entryPeriod[0]} 起；2005–2015 訓練、2016–2026 驗證。250 日首次新高突破、前高 ≥20 日前、20 日冷卻、前一日 20 日均額 ≥3000 萬、原價 ≥10 元、排除還原收盤漲幅 ≥9.5%；收盤進場，來回成本 0.6%。B 組每筆 A 同日隨機抽一檔非 A 股票（有放回，seed ${SEED}），再套 120 日歷史資格。S0–S7/S9 同批進場；S8 排除 tooFar，另列 S0–S6 同子樣本。停損於進場固定，以後收盤跌破出場；共同 MA20 或 120 日出場，停損同日優先。S5 按原腳本為突破低點×0.999。20/60 日超額用流動股等權日報酬累乘基準，為進場後固定期間指標。依進場月份分群、2000 次 bootstrap 比較每筆報酬與 S2 差異，完整指標／逐年／逐筆／排除明細見 results。`,
  stats: [
    { label: '新高組訓練：價量／固定−10%', value: `${f(aT.S6.avgPct)}% / ${f(aT.S2.avgPct)}%`, tone: 'neg', note: `配對差 95% CI ${ci(aT.S6)} 個百分點` },
    { label: '新高組驗證：價量／固定−10%', value: `${f(aV.S6.avgPct)}% / ${f(aV.S2.avgPct)}%`, tone: 'neg', note: `配對差 95% CI ${ci(aV.S6)} 個百分點` },
    { label: '驗證被洗率：價量／固定−10%', value: `${f(aV.S6.washRatePct, 1)}% / ${f(aV.S2.washRatePct, 1)}%`, tone: 'neg', note: `平均停損距離 ${f(aV.S6.avgStopDistancePct)}% / 10%` },
    { label: '隨機組驗證：價量／固定−10%', value: `${f(bV.S6.avgPct)}% / ${f(bV.S2.avgPct)}%`, tone: 'neg', note: `n=${bV.S6.n}；差 95% CI ${ci(bV.S6)} 個百分點` },
  ],
  findings: [
    `期望值：新高組 S6 相對 S2 訓練 ${f(aT.S6.avgPct - aT.S2.avgPct)}、驗證 ${f(aV.S6.avgPct - aV.S2.avgPct)} 個百分點，方向一致但兩段 CI 都跨 0。全期差 ${f(aAll.S6.avgPct - aAll.S2.avgPct)}，CI ${ci(aAll.S6)}；不宣稱顯著落後或優於固定 −10%。`,
    `被洗：驗證 S6 ${f(aV.S6.washRatePct, 1)}%，介於 S2 ${f(aV.S2.washRatePct, 1)}% 與 1.5 ATR ${f(aV.S3.washRatePct, 1)}%、2 ATR ${f(aV.S4.washRatePct, 1)}%、突破 K 低 ${f(aV.S5.washRatePct, 1)}% 之間。無上限結構 S7 為 ${f(aV.S7.washRatePct, 1)}%，但停損距離 ${f(aV.S7.avgStopDistancePct, 1)}%、停損出場僅 ${f(aV.S7.stopRatePct, 1)}%；不能只看被洗率而忽略風險尺度與 MA20 搶先出場。`,
    `tooFar 濾網：A 保留 ${subset.train.S8.n}/${aT.S6.n} 與 ${subset.validation.S8.n}/${aV.S6.n} 筆。S6 在子樣本訓練／驗證 ${f(subset.train.S6.avgPct)}%／${f(subset.validation.S6.avgPct)}%，對應 S2 ${f(subset.train.S2.avgPct)}%／${f(subset.validation.S2.avgPct)}%，仍沒有勝出。相對未篩選 S6 也未提高兩段平均報酬；B 的子樣本改善較多，與 A 不一致，不宜當通用濾網。`,
    `首量峰停利：A 的 S9 訓練／驗證 ${f(aT.S9.avgPct)}%／${f(aV.S9.avgPct)}%，低於 S6 ${f(aT.S6.avgPct)}%／${f(aV.S6.avgPct)}%。全期少 ${f(aAll.S6.avgPct - aAll.S9.avgPct)} 個百分點，方向支持「提早停利可能吃掉波段」，但不能據此推論所有波段都應更慢出場。`,
    `隨機對照：B 訓練 ${bT.S6.n} 筆，S6 ${f(bT.S6.avgPct)}% vs S2 ${f(bT.S2.avgPct)}%；驗證 ${bV.S6.n} 筆，${f(bV.S6.avgPct)}% vs ${f(bV.S2.avgPct)}%，驗證配對 CI ${ci(bV.S6)}。價量停損沒有替隨機進場創造可見優勢。`,
  ],
  caveats: [
    '日線僅能將成交量按高低區間均勻攤入分箱，非真實逐筆價量分布；漲停鎖死日的量集中在單一價位。panel 無還原成交量欄，使用原始成交股數。',
    `benchmark-input 只從 2019 開始，早期日曆由快取補齊。上櫃缺少最早 ${missing.tpex} 個交易日（從 2007-04-23 才有快取），訓練段較早年份只有上市股，且樣本比驗證段少。`,
    '為納入後來上市股票，修正本研究的移動平均遇缺值後永遠 NaN 問題；原 backtest-new-high.ts 未修改。因此不是原腳本樣本的逐筆重播，訊號定義與流動性門檻保持一致。',
    `A 排除 ${excluded.A} 筆、B 排除 ${excluded.B} 筆（歷史不足或函式價格範圍不支援）；原函式分箱表無法處理 reference×1.5% >50 的還原價，直接呼叫無法計算 ${excluded.unsupportedPrice} 次；沒有改寫或延伸其邏輯。排除明細保留於 JSON。`,
    '停損以收盤判斷且假設同收盤可成交；未模擬跌停賣不掉、滑價或實際委託。持有上限與回復窗口按市場交易日計，缺報價不算觸發；未知還原事件中斷則於前一有效收盤結算。',
    '資料末端未滿 120 日仍以末日結算；被洗率僅計有完整 20 日追蹤者。S7 無 structuralStop 視為不設停損，平均距離／R 僅對有定義者計算。',
    '單筆交易可重疊，並非可交易資金曲線；月份 bootstrap 未處理跨月殘餘相關或多重檢定。訓練／驗證是按時間切分，既有價量規則非本次只用訓練段估計，後段不等同全新前向測試。',
  ],
  nextIdeas: ['保留固定 −10% 為基準，前向追蹤價量停損；若要測部位調整、真實分價量或大盤濾網，先固定規則後另立實驗，避免用這批驗證段反覆挑參數。'],
  source: { script: 'scripts/research-volume-profile-stop.ts', results: OUT },
  charts: [
    { file: '01-mean-return.svg', caption: '**固定 −10% 的訓練與驗證平均報酬都高於價量完整版**；S8 是較小子樣本，配對結果請看內文。' },
    { file: '02-wash-distance.svg', caption: '**較遠停損通常較少被洗**；結構無上限的少數停損事件，不代表承擔風險較小。S6 與 S9 可能重疊。' },
    { file: '03-yearly-difference.svg', caption: '**年度差異並不穩定**；正值代表價量較好，負值代表固定 −10% 較好。' },
  ],
};
const experimentPath = 'research/factor-lab/experiments.json';
const experiments = JSON.parse(readFileSync(experimentPath, 'utf8')) as { id: string }[];
writeFileSync(experimentPath, JSON.stringify([entry, ...experiments.filter(e => e.id !== experimentId)], null, 2) + '\n');
log(`wrote experiment and 3 SVGs; verified ${cacheChecks} direct/cache comparisons`);
