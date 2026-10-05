/** 波段出場規則研究：跌破 MA5 / MA10 / MA20 等出場，在全上市櫃還原價上比較「抱住長波段」與「回吐」。
 *  純研究腳本，不影響每日報告。用法：node --import tsx scripts/research-ma-exit.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createPanel, addDayQuotes, addReferenceEvent, finalizePanel, type StockPanel } from './lib/wide-market-panel.ts';

const BUY_COST = 0.001425, SELL_COST = 0.004425;
const MIN_SHARES = 500_000, MIN_PRICE = 10, COOLDOWN = 60, MAX_HOLD = 250, WAVE_WINDOW = 120;
const OUT = 'data/backtest/ma-exit';

// ---------- 讀資料（與 backtest-wide-market.ts 同一套還原邏輯） ----------
const bench = JSON.parse(readFileSync('research/wide-market/benchmark-input.json', 'utf8')).benchmarkTotalReturn;
const calendar: string[] = bench.TaiwanStockPrice.map((r: { date: string }) => r.date).sort();
const n = calendar.length;
const panel = createPanel(calendar);
const refs = JSON.parse(readFileSync('data/backtest/wide/actions/twse-ex-references.json', 'utf8')).rows as { code: string; date: string; reference: number; kind: string }[];
const actionByKey = new Map(refs.map((a) => [`${a.date}/${a.code}`, a]));
const missing: Record<string, number> = { twse: 0, tpex: 0 };
const missingDay = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  for (const source of ['twse', 'tpex'] as const) {
    const file = `data/backtest/wide/daily/${source}/${calendar[i]}.json.gz`;
    if (!existsSync(file)) { missing[source]++; missingDay[i] = 1; continue; }
    const cached = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
    addDayQuotes(panel, i, cached.rows.map((q: Record<string, any>) => {
      const a = actionByKey.get(`${calendar[i]}/${q.code}`);
      return a ? { ...q, explicitReference: a.reference, changeLabel: a.kind } : q;
    }));
  }
}
const calIndex = new Map(calendar.map((d, i) => [d, i]));
for (const [key, a] of actionByKey) { const i = calIndex.get(key.split('/')[0]); if (i !== undefined) addReferenceEvent(panel, i, a.code, a.reference); }
finalizePanel(panel);
console.error(`sessions=${n} stocks=${panel.size} missingFiles=${JSON.stringify(missing)}`);
if (missing.twse + missing.tpex > 0) throw new Error('Incomplete daily cache; run scripts/fetch-wide-market-history.py first');

// ---------- 指標 ----------
const ok = (s: StockPanel, i: number) => s.segmentId[i] >= 0 && s.adjustedClose[i] > 0 && Number.isFinite(s.adjustedClose[i]);
function sma(s: StockPanel, len: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  let sum = 0, run = 0;
  for (let i = 0; i < n; i++) {
    if (!ok(s, i) || (i > 0 && s.segmentId[i] !== s.segmentId[i - 1])) { sum = 0; run = 0; }
    if (!ok(s, i)) continue;
    sum += s.adjustedClose[i]; run++;
    if (run > len) { sum -= s.adjustedClose[i - len]; run = len; }
    if (run === len) out[i] = sum / len;
  }
  return out;
}

// ---------- 出場規則 ----------
interface Ctx { s: StockPanel; ma: Record<number, Float64Array>; entry: number }
type ExitRule = { id: string; label: string; shouldExit: (c: Ctx, t: number, state: { peak: number; below: number }) => boolean };
const belowMa = (len: number, confirm = 1): ExitRule['shouldExit'] => (c, t, st) => {
  st.below = c.s.adjustedClose[t] < c.ma[len][t] ? st.below + 1 : 0;
  return st.below >= confirm;
};
const RULES: ExitRule[] = [
  { id: 'ma5', label: '收盤跌破 MA5', shouldExit: belowMa(5) },
  { id: 'ma5x2', label: '連 2 日收在 MA5 下', shouldExit: belowMa(5, 2) },
  { id: 'ma10', label: '收盤跌破 MA10', shouldExit: belowMa(10) },
  { id: 'ma20', label: '收盤跌破 MA20（月線）', shouldExit: belowMa(20) },
  { id: 'ma20x2', label: '連 2 日收在 MA20 下', shouldExit: belowMa(20, 2) },
  { id: 'trail15', label: '參考：自最高收盤回落 15%', shouldExit: (c, t, st) => c.s.adjustedClose[t] <= st.peak * 0.85 },
  { id: 'hold60', label: '參考：固定持有 60 日', shouldExit: (c, t) => t - c.entry + 1 >= 60 },
];

// ---------- 進場訊號 ----------
interface Signal { code: string; signal: number; entry: number; r20: number; s: StockPanel; ma: Record<number, Float64Array> }
type Setup = 'breakout' | 'strong';
const SETUPS: Record<Setup, string> = {
  breakout: '一般波段：收盤創 60 日新高、站上 MA20 且 MA20 > MA60',
  strong: '強勢股：20 日漲幅 ≥ 30%、收盤 > MA5 > MA10 > MA20',
};
const signals: Record<Setup, Signal[]> = { breakout: [], strong: [] };
for (const s of panel.values()) {
  const ma = { 5: sma(s, 5), 10: sma(s, 10), 20: sma(s, 20), 60: sma(s, 60) } as Record<number, Float64Array>;
  const vol20 = new Float64Array(n).fill(NaN);
  for (let i = 19; i < n; i++) { let v = 0; for (let k = i - 19; k <= i; k++) v += s.volume[k] || 0; vol20[i] = v / 20; }
  const last: Record<Setup, number> = { breakout: -1e9, strong: -1e9 };
  for (let i = 60; i < n - 1; i++) {
    if (!s.seen[i] || !ok(s, i) || !ok(s, i - 20) || s.segmentId[i - 60] !== s.segmentId[i] || missingDay[i]) continue;
    const c = s.adjustedClose[i];
    if (!(Number.isFinite(ma[60][i]) && s.close[i] >= MIN_PRICE && vol20[i] >= MIN_SHARES)) continue;
    const e = i + 1;
    if (!s.seen[e] || !(s.adjustedOpen[e] > 0) || s.segmentId[e] !== s.segmentId[i]) continue;
    const r20 = c / s.adjustedClose[i - 20] - 1;
    let hi60 = 0; for (let k = i - 60; k < i; k++) hi60 = Math.max(hi60, s.adjustedClose[k]);
    const hits: Record<Setup, boolean> = {
      breakout: c > hi60 && c > ma[20][i] && ma[20][i] > ma[60][i],
      strong: r20 >= 0.30 && c > ma[5][i] && ma[5][i] > ma[10][i] && ma[10][i] > ma[20][i],
    };
    for (const k of Object.keys(hits) as Setup[]) {
      if (!hits[k] || i - last[k] < COOLDOWN) continue;
      last[k] = i;
      signals[k].push({ code: s.code, signal: i, entry: e, r20, s, ma });
    }
  }
}

// ---------- 單筆交易模擬 ----------
interface Trade { code: string; signalDate: string; entry: number; exit: number; exitPx: number; days: number; ret: number; potential: number | null; peakRet: number; giveback: number; open: boolean; afterUp10: boolean | null; afterDown10: boolean | null }
function simulate(sig: Signal, rule: ExitRule): Trade {
  const { s, entry } = sig;
  const seg = s.segmentId[entry];
  const entryPx = s.adjustedOpen[entry];
  const st = { peak: entryPx, below: 0 };
  let exitIdx = -1, exitPx = NaN, open = false, lastValid = entry;
  for (let t = entry; t < n; t++) {
    if (s.segmentId[t] !== seg) { exitIdx = lastValid; exitPx = s.adjustedClose[lastValid]; break; } // 下市/無法還原：最後收盤出場
    if (!s.seen[t] || !ok(s, t)) continue;
    lastValid = t;
    st.peak = Math.max(st.peak, s.adjustedClose[t]);
    const forced = t - entry + 1 >= MAX_HOLD;
    if (rule.shouldExit({ s, ma: sig.ma, entry }, t, st) || forced) {
      let u = t + 1; while (u < n && s.segmentId[u] === seg && !s.seen[u]) u++; // 隔日（或復牌日）開盤賣
      if (u < n && s.segmentId[u] === seg && s.adjustedOpen[u] > 0) { exitIdx = u; exitPx = s.adjustedOpen[u]; }
      else { exitIdx = t; exitPx = s.adjustedClose[t]; open = u >= n; }
      break;
    }
  }
  if (exitIdx < 0) { exitIdx = lastValid; exitPx = s.adjustedClose[lastValid]; open = true; }
  const ret = (exitPx * (1 - SELL_COST)) / (entryPx * (1 + BUY_COST)) - 1;
  // 進場後 120 日內最高收盤 = 這段波段的「潛在漲幅」
  let potential: number | null = null;
  if (entry + WAVE_WINDOW < n) {
    let mx = entryPx;
    for (let t = entry; t < entry + WAVE_WINDOW && s.segmentId[t] === seg; t++) if (ok(s, t)) mx = Math.max(mx, s.adjustedClose[t]);
    potential = mx / entryPx - 1;
  }
  let afterUp10: boolean | null = null, afterDown10: boolean | null = null;
  if (!open && exitIdx + 20 < n) {
    let mx = 0, mn = Infinity;
    for (let t = exitIdx; t <= exitIdx + 20 && s.segmentId[t] === seg; t++) if (ok(s, t)) { mx = Math.max(mx, s.adjustedClose[t]); mn = Math.min(mn, s.adjustedClose[t]); }
    afterUp10 = mx >= exitPx * 1.10; afterDown10 = mn <= exitPx * 0.90;
  }
  return { code: s.code, signalDate: calendar[sig.signal], entry, exit: exitIdx, exitPx, days: exitIdx - entry, ret, potential,
    peakRet: st.peak / entryPx - 1, giveback: 1 - exitPx / st.peak, open, afterUp10, afterDown10 };
}

// ---------- 統計 ----------
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a: number[], q: number) => { const b = [...a].sort((x, y) => x - y); if (!b.length) return NaN; const k = (b.length - 1) * q, lo = Math.floor(k); return b[lo] + (b[Math.min(lo + 1, b.length - 1)] - b[lo]) * (k - lo); };
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function clusterBootstrap(diffs: { month: string; d: number }[], iters = 5000) {
  const byMonth = new Map<string, number[]>();
  for (const x of diffs) { if (!byMonth.has(x.month)) byMonth.set(x.month, []); byMonth.get(x.month)!.push(x.d); }
  const months = [...byMonth.values()];
  const r = rng(42), means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let sum = 0, cnt = 0;
    for (let m = 0; m < months.length; m++) { const g = months[Math.floor(r() * months.length)]; for (const v of g) { sum += v; cnt++; } }
    means.push(sum / cnt);
  }
  return { mean: mean(diffs.map((x) => x.d)), lo: pct(means, 0.025), hi: pct(means, 0.975), pPositive: means.filter((x) => x > 0).length / iters };
}

function summarize(trades: Trade[]) {
  const r = trades.map((t) => t.ret);
  const wins = r.filter((x) => x > 0), losses = r.filter((x) => x <= 0);
  const big = trades.filter((t) => t.potential !== null && t.potential >= 0.5);
  const huge = trades.filter((t) => t.potential !== null && t.potential >= 1.0);
  const capture = (ts: Trade[]) => ts.map((t) => Math.max(-1, t.ret / t.potential!));
  const after = trades.filter((t) => t.afterUp10 !== null);
  return {
    n: trades.length, meanRet: mean(r), medianRet: pct(r, 0.5), winRate: wins.length / r.length,
    profitFactor: wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0),
    avgWin: mean(wins), avgLoss: mean(losses), p05: pct(r, 0.05), worst: Math.min(...r),
    meanDays: mean(trades.map((t) => t.days)), medianDays: pct(trades.map((t) => t.days), 0.5),
    logRetPerDay: mean(r.map((x) => Math.log(1 + x))) / Math.max(1, mean(trades.map((t) => t.days))),
    meanGiveback: mean(trades.map((t) => t.giveback)), meanPeakRet: mean(trades.map((t) => t.peakRet)),
    bigWaveN: big.length, bigWaveMeanRet: mean(big.map((t) => t.ret)), bigWaveCaptureMedian: pct(capture(big), 0.5),
    bigWaveHalfCaptured: big.filter((t) => t.ret >= t.potential! / 2).length / big.length,
    bigWaveExitedBelow10: big.filter((t) => t.ret < 0.10).length / big.length,
    hugeWaveN: huge.length, hugeWaveMeanRet: mean(huge.map((t) => t.ret)), hugeWaveCaptureMedian: pct(capture(huge), 0.5),
    whipsawUp10: after.filter((t) => t.afterUp10).length / after.length,
    savedDown10: after.filter((t) => t.afterDown10).length / after.length,
    stillOpen: trades.filter((t) => t.open).length,
  };
}

// 組合模擬：最多 10 檔等權，訊號依 20 日漲幅排序先到先買，資金閒置不計息。
function portfolio(sigs: Signal[], rule: ExitRule, slots = 10) {
  const byEntry = new Map<number, Signal[]>();
  for (const s of sigs) { if (!byEntry.has(s.entry)) byEntry.set(s.entry, []); byEntry.get(s.entry)!.push(s); }
  let cash = 1;
  const pos: { sig: Signal; shares: number; trade: Trade }[] = [];
  const curve: number[] = [];
  let taken = 0;
  for (let t = 0; t < n; t++) {
    for (let k = pos.length - 1; k >= 0; k--) {
      const p = pos[k];
      if (p.trade.exit === t) {
        cash += p.shares * p.trade.exitPx * (1 - SELL_COST); pos.splice(k, 1);
      }
    }
    const today = (byEntry.get(t) ?? []).sort((a, b) => b.r20 - a.r20);
    const markValue = () => cash + pos.reduce((v, p) => v + p.shares * lastPx(p.sig.s, t), 0);
    for (const sig of today) {
      if (pos.length >= slots || pos.some((p) => p.sig.code === sig.code)) continue;
      const equity = markValue(), budget = Math.min(cash, equity / slots);
      if (budget <= 0) break;
      const px = sig.s.adjustedOpen[t], trade = simulate(sig, rule);
      if (trade.exit <= t) continue;
      pos.push({ sig, shares: budget / (px * (1 + BUY_COST)), trade });
      cash -= budget; taken++;
    }
    curve.push(markValue());
  }
  const start = calendar.indexOf('2019-04-01');
  const c = curve.slice(start), years = (c.length - 1) / 250;
  let peak = 0, mdd = 0; for (const v of c) { peak = Math.max(peak, v); mdd = Math.max(mdd, 1 - v / peak); }
  const yearly: Record<string, number> = {};
  for (let i = start + 1; i < n; i++) { const y = calendar[i].slice(0, 4); const prevYearEnd = calendar[i - 1].slice(0, 4) !== y; if (prevYearEnd) yearly[y] = curve[i - 1]; }
  const yr: Record<string, number> = {};
  const ys = Object.keys(yearly);
  ys.forEach((y, k) => { const end = k + 1 < ys.length ? yearly[ys[k + 1]] : curve[n - 1]; yr[y] = end / yearly[y] - 1; });
  return { cagr: (c[c.length - 1] / c[0]) ** (1 / years) - 1, total: c[c.length - 1] / c[0] - 1, mdd, trades: taken, yearly: yr };
}
function lastPx(s: StockPanel, t: number) { for (let u = t; u >= 0; u--) if (ok(s, u)) return s.adjustedClose[u]; return 0; }

// ---------- 執行 ----------
const results: Record<string, unknown> = {};
for (const setup of Object.keys(SETUPS) as Setup[]) {
  const sigs = signals[setup].filter((s) => calendar[s.signal] >= '2019-04-01');
  const tradesByRule: Record<string, Trade[]> = {};
  for (const rule of RULES) tradesByRule[rule.id] = sigs.map((s) => simulate(s, rule));
  const summary = Object.fromEntries(RULES.map((r) => [r.id, { label: r.label, ...summarize(tradesByRule[r.id]) }]));
  const byYear: Record<string, Record<string, number>> = {};
  for (const r of RULES) for (const t of tradesByRule[r.id]) {
    const y = t.signalDate.slice(0, 4); byYear[y] ??= {}; (byYear[y] as any)[`_${r.id}`] ??= []; (byYear[y] as any)[`_${r.id}`].push(t.ret);
  }
  const yearTable = Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, Object.fromEntries(Object.entries(v).map(([k, a]) => [k.slice(1), { n: (a as any).length, meanRet: mean(a as any) }]))]));
  const paired = (a: string, b: string) => clusterBootstrap(sigs.map((s, i) => ({ month: calendar[s.signal].slice(0, 7), d: tradesByRule[a][i].ret - tradesByRule[b][i].ret })));
  const pairedBig = (a: string, b: string) => { const idx = sigs.map((_, i) => i).filter((i) => (tradesByRule[a][i].potential ?? 0) >= 0.5); return clusterBootstrap(idx.map((i) => ({ month: calendar[sigs[i].signal].slice(0, 7), d: tradesByRule[a][i].ret - tradesByRule[b][i].ret }))); };
  const port = Object.fromEntries(RULES.map((r) => [r.id, portfolio(sigs, r)]));
  results[setup] = { definition: SETUPS[setup], signals: sigs.length, summary, yearTable, portfolio: port,
    paired: { ma20_minus_ma5: paired('ma20', 'ma5'), ma10_minus_ma5: paired('ma10', 'ma5'), ma20_minus_ma10: paired('ma20', 'ma10'), ma5x2_minus_ma5: paired('ma5x2', 'ma5'),
      bigWave_ma20_minus_ma5: pairedBig('ma20', 'ma5') } };
  console.error(`${setup}: ${sigs.length} signals`);
}
// ---------- 進場研究：站上月線再進場，勝率是否較高？ ----------
// 每個流動性合格的「個股-交易日」都是一筆觀察；隔日開盤買，持有 h 日後收盤賣（含成本）。
// 超額 = 該筆報酬 − 同一天所有合格觀察的平均報酬，用來扣掉大盤當時的多空。
const HORIZONS = [5, 20, 60] as const;
const GROUPS = ['all', 'above', 'below', 'aboveRising', 'crossUp', 'crossUpRising', 'crossUpFalling', 'crossDown'] as const;
const GROUP_LABEL: Record<string, string> = { all: '所有日子（基準）', above: '收在月線上', below: '收在月線下', aboveRising: '月線上且月線上揚',
  crossUp: '當天由下往上站上月線', crossUpRising: '站上月線且月線上揚', crossUpFalling: '站上月線但月線仍下彎', crossDown: '當天跌破月線' };
const CAP = panel.size * n;
const obsDay = new Int32Array(CAP), obsFlags = new Uint8Array(CAP), obsR = new Float32Array(CAP * 3);
let nObs = 0;
const crossSignals: Signal[] = [];
for (const s of panel.values()) {
  const ma = { 5: sma(s, 5), 10: sma(s, 10), 20: sma(s, 20), 60: sma(s, 60) } as Record<number, Float64Array>;
  let v20 = 0;
  for (let i = 0; i < n; i++) {
    v20 += s.volume[i] || 0; if (i >= 20) v20 -= s.volume[i - 20] || 0;
    if (i < 25 || i + 60 >= n || !s.seen[i] || !ok(s, i) || !ok(s, i - 1)) continue;
    if (s.close[i] < MIN_PRICE || v20 / 20 < MIN_SHARES || !Number.isFinite(ma[20][i - 5]) || s.segmentId[i - 5] !== s.segmentId[i]) continue;
    if (!s.seen[i + 1] || !(s.adjustedOpen[i + 1] > 0) || s.segmentId[i + 1] !== s.segmentId[i]) continue;
    const c = s.adjustedClose[i], m = ma[20][i];
    const above = c > m, prevAbove = s.adjustedClose[i - 1] > ma[20][i - 1], rising = m > ma[20][i - 5];
    const fl: Record<string, boolean> = { all: true, above, below: !above, aboveRising: above && rising, crossUp: above && !prevAbove,
      crossUpRising: above && !prevAbove && rising, crossUpFalling: above && !prevAbove && !rising, crossDown: !above && prevAbove };
    const entryPx = s.adjustedOpen[i + 1];
    const r: number[] = [];
    let valid = true;
    for (const h of HORIZONS) {
      const t = i + h;
      if (s.segmentId[t] !== s.segmentId[i] || !ok(s, t)) { valid = false; break; }
      r.push((s.adjustedClose[t] * (1 - SELL_COST)) / (entryPx * (1 + BUY_COST)) - 1);
    }
    if (!valid) continue;
    let flags = 0; GROUPS.forEach((g, k) => { if (fl[g]) flags |= 1 << k; });
    obsDay[nObs] = i; obsFlags[nObs] = flags; obsR[nObs * 3] = r[0]; obsR[nObs * 3 + 1] = r[1]; obsR[nObs * 3 + 2] = r[2]; nObs++;
    if (fl.crossUp && calendar[i] >= '2019-04-01') crossSignals.push({ code: s.code, signal: i, entry: i + 1, r20: c / s.adjustedClose[i - 20] - 1, s, ma });
  }
}
const daySum = new Float64Array(n * 3), dayCnt = new Float64Array(n);
for (let j = 0; j < nObs; j++) { const d = obsDay[j]; dayCnt[d]++; for (let h = 0; h < 3; h++) daySum[d * 3 + h] += obsR[j * 3 + h]; }
const startDay = calendar.indexOf('2019-04-01');
const excessOf = (j: number, k: number) => obsR[j * 3 + k] - daySum[obsDay[j] * 3 + k] / dayCnt[obsDay[j]];
function groupStats(g: number) {
  const rows: number[] = [];
  for (let j = 0; j < nObs; j++) if (obsFlags[j] & (1 << g) && obsDay[j] >= startDay) rows.push(j);
  return Object.fromEntries(HORIZONS.map((h, k) => {
    const r = rows.map((j) => obsR[j * 3 + k]), ex = rows.map((j) => excessOf(j, k));
    return [`d${h}`, { n: r.length, meanRet: mean(r), medianRet: pct(r, 0.5), winRate: r.filter((x) => x > 0).length / r.length,
      meanExcess: mean(ex), beatSameDayRate: ex.filter((x) => x > 0).length / ex.length }];
  }));
}
// 兩組超額平均的差；以月份為區塊重抽（先彙總成每月的和與筆數）
function groupDiff(a: number, b: number, k: number) {
  const months = new Map<string, number[]>(); // [sumA, cntA, sumB, cntB]
  for (let j = 0; j < nObs; j++) {
    if (obsDay[j] < startDay) continue;
    const m = calendar[obsDay[j]].slice(0, 7), ex = excessOf(j, k);
    if (!months.has(m)) months.set(m, [0, 0, 0, 0]);
    const v = months.get(m)!;
    if (obsFlags[j] & (1 << a)) { v[0] += ex; v[1]++; }
    if (obsFlags[j] & (1 << b)) { v[2] += ex; v[3]++; }
  }
  const ms = [...months.values()], r = rng(7), diffs: number[] = [];
  const tot = ms.reduce((t, v) => t.map((x, q) => x + v[q]), [0, 0, 0, 0]);
  for (let it = 0; it < 3000; it++) {
    const acc = [0, 0, 0, 0];
    for (let q = 0; q < ms.length; q++) { const g = ms[Math.floor(r() * ms.length)]; for (let z = 0; z < 4; z++) acc[z] += g[z]; }
    diffs.push(acc[0] / acc[1] - acc[2] / acc[3]);
  }
  return { diff: tot[0] / tot[1] - tot[2] / tot[3], lo: pct(diffs, 0.025), hi: pct(diffs, 0.975) };
}
const gi = (g: string) => GROUPS.indexOf(g as any);
const entryGroups = Object.fromEntries(GROUPS.map((g, k) => [g, { label: GROUP_LABEL[g], ...groupStats(k) }]));
const entryDiffs = Object.fromEntries(HORIZONS.map((h, k) => [`d${h}`, {
  crossUp_vs_all: groupDiff(gi('crossUp'), gi('all'), k), above_vs_below: groupDiff(gi('above'), gi('below'), k),
  crossUpRising_vs_all: groupDiff(gi('crossUpRising'), gi('all'), k), crossDown_vs_all: groupDiff(gi('crossDown'), gi('all'), k) }]));
// 交易規則：站上月線隔日開盤買、跌破月線隔日開盤賣；同一檔持有中不重複進場
function nonOverlapping(sigs: Signal[], rule: ExitRule, filter: (s: Signal) => boolean = () => true) {
  const byCode = new Map<string, Signal[]>();
  for (const s of sigs.filter(filter)) { if (!byCode.has(s.code)) byCode.set(s.code, []); byCode.get(s.code)!.push(s); }
  const out: { sig: Signal; trade: Trade }[] = [];
  for (const list of byCode.values()) { let busyUntil = -1; for (const sig of list.sort((a, b) => a.signal - b.signal)) { if (sig.signal < busyUntil) continue; const trade = simulate(sig, rule); out.push({ sig, trade }); busyUntil = trade.exit; } }
  return out;
}
const ma20Rule = RULES.find((r) => r.id === 'ma20')!;
const crossAll = nonOverlapping(crossSignals, ma20Rule);
const crossRising = nonOverlapping(crossSignals, ma20Rule, (s) => s.ma[20][s.signal] > s.ma[20][s.signal - 5]);
const crossTrades = {
  crossUp_exitMa20: { ...summarize(crossAll.map((x) => x.trade)), portfolio: portfolio(crossAll.map((x) => x.sig), ma20Rule) },
  crossUpRising_exitMa20: { ...summarize(crossRising.map((x) => x.trade)), portfolio: portfolio(crossRising.map((x) => x.sig), ma20Rule) },
};
// 大盤擇時：加權指數收在月線上才持有（含息報酬），否則空手
function indexTiming() {
  const px = bench.TaiwanStockPrice as { date: string; close: number }[];
  const trMap = new Map((bench.TaiwanStockTotalReturnIndex as { date: string; price: number }[]).map((r) => [r.date, r.price]));
  const rows = px.filter((r) => trMap.has(r.date));
  let hold = 1, timing = 1, inMkt = false, switches = 0, daysIn = 0, pkH = 0, pkT = 0, mddH = 0, mddT = 0, cnt = 0;
  for (let i = 20; i < rows.length; i++) {
    const ma = rows.slice(i - 20, i).reduce((a, r) => a + r.close, 0) / 20; // 前一日收盤 vs 前一日月線
    const sig = rows[i - 1].close > ma;
    if (rows[i].date < '2019-04-01') { inMkt = sig; continue; }
    const r = trMap.get(rows[i].date)! / trMap.get(rows[i - 1].date)! - 1;
    if (sig !== inMkt) { timing *= sig ? 1 - 0.001425 : 1 - 0.002425; switches++; inMkt = sig; }
    if (inMkt) { timing *= 1 + r; daysIn++; }
    hold *= 1 + r; cnt++;
    pkH = Math.max(pkH, hold); pkT = Math.max(pkT, timing); mddH = Math.max(mddH, 1 - hold / pkH); mddT = Math.max(mddT, 1 - timing / pkT);
  }
  const y = cnt / 250;
  return { buyHold: { cagr: hold ** (1 / y) - 1, mdd: mddH }, aboveMa20Only: { cagr: timing ** (1 / y) - 1, mdd: mddT, timeInMarket: daysIn / cnt, switches } };
}
results.entryStudy = { groups: entryGroups, diffs: entryDiffs, trades: crossTrades, indexTiming: indexTiming(), observations: nObs };
// 大盤含息報酬作為組合參考
const tr = bench.TaiwanStockTotalReturnIndex as { date: string; price: number }[];
const trS = tr.find((r) => r.date >= '2019-04-01')!, trE = tr[tr.length - 1];
const trYears = (calendar.length - 1 - calendar.indexOf('2019-04-01')) / 250;
let pk = 0, trMdd = 0; for (const r of tr.filter((r) => r.date >= '2019-04-01')) { pk = Math.max(pk, r.price); trMdd = Math.max(trMdd, 1 - r.price / pk); }
results.benchmark = { cagr: (trE.price / trS.price) ** (1 / trYears) - 1, total: trE.price / trS.price - 1, mdd: trMdd, from: trS.date, to: trE.date };
results.meta = { sessions: n, from: calendar[0], to: calendar[n - 1], costs: { buy: BUY_COST, sell: SELL_COST }, minShares: MIN_SHARES, minPrice: MIN_PRICE, cooldown: COOLDOWN, maxHold: MAX_HOLD, waveWindow: WAVE_WINDOW };
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(`wrote ${OUT}/results.json`);
