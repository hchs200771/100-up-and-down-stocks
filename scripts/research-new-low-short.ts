/** 創新低放空研究：120/200 日收盤新低是否為好的放空訊號？並與鏡像的「創新高做多」並排比較。
 *  純研究腳本，不影響每日報告。用法：node --import tsx scripts/research-new-low-short.ts
 *  輸出：data/backtest/new-low-short/results.json，stdout 為精簡摘要。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createPanel, addDayQuotes, addReferenceEvent, finalizePanel, type StockPanel } from './lib/wide-market-panel.ts';

const LONG_BUY = 0.001425, LONG_SELL = 0.004425;
const SHORT_SELL = 0.004425 + 0.0008, SHORT_BUY = 0.001425; // 空單：賣出手續費+證交稅 + 借券費；回補手續費
const MIN_SHARES = 500_000, MIN_PRICE = 10, COOLDOWN = 60, MAX_HOLD = 120;
const START = '2019-04-01';
const OUT = 'data/backtest/new-low-short';

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

// ---------- 市場序列（含息報酬指數）與 TAIEX MA200 ----------
function mapSeries(rows: { date: string }[], key: string): Float64Array {
  const m = new Map(rows.map((r: any) => [r.date, r[key] as number]));
  const out = new Float64Array(n).fill(NaN);
  let last = NaN;
  for (let i = 0; i < n; i++) { const v = m.get(calendar[i]); if (v !== undefined && v > 0) last = v; out[i] = last; }
  return out;
}
const mkt = mapSeries(bench.TaiwanStockTotalReturnIndex, 'price');
const taiex = mapSeries(bench.TaiwanStockPrice, 'close');
const taiexMa200 = new Float64Array(n).fill(NaN);
for (let i = 199; i < n; i++) { let s = 0; for (let k = i - 199; k <= i; k++) s += taiex[k]; taiexMa200[i] = s / 200; }

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

// ---------- 訊號 ----------
type Setup = 'low120' | 'low200' | 'high120' | 'high200';
const SETUPS: Setup[] = ['low120', 'low200', 'high120', 'high200'];
const SETUP_N: Record<Setup, number> = { low120: 120, low200: 200, high120: 120, high200: 200 };
const isShort = (k: Setup) => k.startsWith('low');
interface Signal { code: string; signal: number; entry: number; s: StockPanel; ma: Record<number, Float64Array>; dist: number; market: string }
const signals: Record<Setup, Signal[]> = { low120: [], low200: [], high120: [], high200: [] };
for (const s of panel.values()) {
  const ma = { 20: sma(s, 20), 200: sma(s, 200) } as Record<number, Float64Array>;
  const last: Record<Setup, number> = { low120: -1e9, low200: -1e9, high120: -1e9, high200: -1e9 };
  let v20 = 0;
  for (let i = 0; i < n - 1; i++) {
    v20 += s.volume[i] || 0; if (i >= 20) v20 -= s.volume[i - 20] || 0;
    if (i < 200 || calendar[i] < START) continue;
    if (!s.seen[i] || !ok(s, i) || missingDay[i]) continue;
    if (s.close[i] < MIN_PRICE || v20 / 20 < MIN_SHARES) continue;
    const e = i + 1;
    if (!s.seen[e] || !(s.adjustedOpen[e] > 0) || s.segmentId[e] !== s.segmentId[i]) continue;
    const c = s.adjustedClose[i];
    // 120 / 200 日前高低（前 N 日，須同一 segment 且有效收盤 >= 95% N）
    const stat = (N: number) => {
      if (s.segmentId[i - N] !== s.segmentId[i] || s.segmentId[i + 1] !== s.segmentId[i]) return null;
      let mn = Infinity, mx = 0, cnt = 0;
      for (let k = i - N; k < i; k++) if (ok(s, k) && s.segmentId[k] === s.segmentId[i]) { cnt++; const v = s.adjustedClose[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
      return cnt >= N * 0.95 ? { mn, mx } : null;
    };
    const st120 = stat(120), st200 = stat(200);
    const hits: Record<Setup, boolean> = {
      low120: !!st120 && c < st120.mn, low200: !!st200 && c < st200.mn,
      high120: !!st120 && c > st120.mx, high200: !!st200 && c > st200.mx,
    };
    for (const k of SETUPS) {
      if (!hits[k] || i - last[k] < COOLDOWN) continue;
      last[k] = i;
      signals[k].push({ code: s.code, signal: i, entry: e, s, ma, dist: c / ma[200][i] - 1, market: String((s as any).marketByIndex?.[i] ?? '?') });
    }
  }
}

// ---------- 交易模擬 ----------
const retOf = (short: boolean, entryPx: number, exitPx: number) => short
  ? (entryPx * (1 - SHORT_SELL) - exitPx * (1 + SHORT_BUY)) / entryPx
  : (exitPx * (1 - LONG_SELL)) / (entryPx * (1 + LONG_BUY)) - 1;
interface Row { ret: number; ex: number; mret: number; month: string; year: string; regime: string; distB: string; market: string; exit: number; exitPx: number; entry: number; code: string; open: boolean }
function mkRow(sig: Signal, short: boolean, exitIdx: number, exitPx: number, open = false): Row {
  const entryPx = sig.s.adjustedOpen[sig.entry];
  const ret = retOf(short, entryPx, exitPx);
  const mret = mkt[exitIdx] / mkt[sig.signal] - 1;
  const ex = short ? ret + mret : ret - mret;
  const i = sig.signal;
  const regime = Number.isFinite(taiexMa200[i]) ? (taiex[i] > taiexMa200[i] ? 'above' : 'below') : 'na';
  const d = sig.dist;
  const distB = !Number.isFinite(d) ? 'na' : d < -0.30 ? '<-30%' : d < -0.15 ? '-30~-15%' : '>-15%';
  return { ret, ex, mret, month: calendar[i].slice(0, 7), year: calendar[i].slice(0, 4), regime, distB, market: sig.market, exit: exitIdx, exitPx, entry: sig.entry, code: sig.code, open };
}
function fixedTrade(sig: Signal, short: boolean, H: number): Row | null {
  const { s, entry } = sig, seg = s.segmentId[entry];
  const x = entry + H - 1;
  if (x >= n) return null;
  for (let t = x; t >= entry; t--) if (s.segmentId[t] === seg && ok(s, t) && s.seen[t]) return mkRow(sig, short, t, s.adjustedClose[t]);
  return null;
}
type RuleId = 'ma20' | 'stop10_hold60' | 'trail15';
const RULES: RuleId[] = ['ma20', 'stop10_hold60', 'trail15'];
function ruleTrade(sig: Signal, short: boolean, rule: RuleId): Row | null {
  const { s, entry } = sig, seg = s.segmentId[entry], entryPx = s.adjustedOpen[entry];
  let ext = entryPx, lastValid = entry;
  for (let t = entry; t < n; t++) {
    if (s.segmentId[t] !== seg) return mkRow(sig, short, lastValid, s.adjustedClose[lastValid]); // 下市：最後收盤
    if (!s.seen[t] || !ok(s, t)) continue;
    lastValid = t;
    const c = s.adjustedClose[t];
    ext = short ? Math.min(ext, c) : Math.max(ext, c);
    const age = t - entry + 1;
    let hit = false;
    if (rule === 'ma20') { const m = sig.ma[20][t]; hit = Number.isFinite(m) && (short ? c > m : c < m); }
    else if (rule === 'stop10_hold60') hit = short ? c >= entryPx * 1.1 : c <= entryPx * 0.9;
    else hit = short ? c >= ext * 1.15 : c <= ext * 0.85;
    if (rule === 'stop10_hold60' && !hit && age >= 60) return mkRow(sig, short, t, c);
    if (age >= MAX_HOLD && !hit) return mkRow(sig, short, t, c);
    if (hit) {
      let u = t + 1; while (u < n && s.segmentId[u] === seg && !s.seen[u]) u++;
      if (u < n && s.segmentId[u] === seg && s.adjustedOpen[u] > 0) return mkRow(sig, short, u, s.adjustedOpen[u]);
      return mkRow(sig, short, t, c, u >= n);
    }
  }
  return null; // 資料結束仍未出場：排除
}

// ---------- 統計 ----------
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (a: number[], q: number) => { const b = [...a].sort((x, y) => x - y); if (!b.length) return NaN; const k = (b.length - 1) * q, lo = Math.floor(k); return b[lo] + (b[Math.min(lo + 1, b.length - 1)] - b[lo]) * (k - lo); };
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function clusterBootstrap(diffs: { month: string; d: number }[], iters = 3000) {
  const agg = new Map<string, [number, number]>();
  for (const x of diffs) { const v = agg.get(x.month) ?? [0, 0]; v[0] += x.d; v[1]++; agg.set(x.month, v); }
  const months = [...agg.values()];
  const r = rng(42), means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let sum = 0, cnt = 0;
    for (let m = 0; m < months.length; m++) { const g = months[Math.floor(r() * months.length)]; sum += g[0]; cnt += g[1]; }
    means.push(sum / cnt);
  }
  return { mean: mean(diffs.map((x) => x.d)), lo: pct(means, 0.025), hi: pct(means, 0.975), pPositive: means.filter((x) => x > 0).length / iters };
}
function summarize(rows: Row[], boot = true) {
  if (!rows.length) return { n: 0 };
  const r = rows.map((t) => t.ret);
  const wins = r.filter((x) => x > 0), losses = r.filter((x) => x <= 0);
  return {
    n: rows.length, meanRet: mean(r), medianRet: pct(r, 0.5), winRate: wins.length / r.length,
    profitFactor: wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0),
    p05: pct(r, 0.05), worst: Math.min(...r), meanExcess: mean(rows.map((t) => t.ex)),
    ...(boot ? {
      retBoot: clusterBootstrap(rows.map((t) => ({ month: t.month, d: t.ret }))),
      excessBoot: clusterBootstrap(rows.map((t) => ({ month: t.month, d: t.ex }))),
    } : {}),
  };
}
const groupBy = (rows: Row[], f: (r: Row) => string) => {
  const m: Record<string, Row[]> = {};
  for (const r of rows) (m[f(r)] ??= []).push(r);
  return Object.fromEntries(Object.keys(m).sort().map((k) => [k, summarize(m[k])]));
};

// ---------- 組合模擬 ----------
function lastPx(s: StockPanel, t: number) { for (let u = t; u >= 0; u--) if (ok(s, u)) return s.adjustedClose[u]; return 0; }
function portfolio(setup: Setup, slots = 10) {
  const short = isShort(setup);
  const byEntry = new Map<number, { sig: Signal; trade: Row }[]>();
  for (const sig of signals[setup]) {
    const trade = ruleTrade(sig, short, 'stop10_hold60');
    if (!trade) continue;
    if (!byEntry.has(sig.entry)) byEntry.set(sig.entry, []);
    byEntry.get(sig.entry)!.push({ sig, trade });
  }
  let cash = 1, taken = 0;
  const pos: { sig: Signal; shares: number; trade: Row }[] = [];
  const curve: number[] = [];
  for (let t = 0; t < n; t++) {
    for (let k = pos.length - 1; k >= 0; k--) {
      const p = pos[k];
      if (p.trade.exit !== t) continue;
      const entryPx = p.sig.s.adjustedOpen[p.sig.entry];
      cash += short ? p.shares * (entryPx - p.trade.exitPx) - p.shares * p.trade.exitPx * SHORT_BUY : p.shares * p.trade.exitPx * (1 - LONG_SELL);
      pos.splice(k, 1);
    }
    const mark = () => cash + pos.reduce((v, p) => v + (short ? p.shares * (p.sig.s.adjustedOpen[p.sig.entry] - lastPx(p.sig.s, t)) : p.shares * lastPx(p.sig.s, t)), 0);
    const today = (byEntry.get(t) ?? []).sort((a, b) => a.sig.code < b.sig.code ? -1 : a.sig.code > b.sig.code ? 1 : 0);
    for (const { sig, trade } of today) {
      if (pos.length >= slots || pos.some((p) => p.sig.code === sig.code) || trade.exit <= t) continue;
      const equity = mark();
      const px = sig.s.adjustedOpen[t];
      if (short) {
        const notional = equity / slots;
        if (notional <= 0) break;
        cash -= notional * SHORT_SELL; // 進場賣出費用 + 借券費
        pos.push({ sig, shares: notional / px, trade }); taken++;
      } else {
        const budget = Math.min(cash, equity / slots);
        if (budget <= 0) break;
        pos.push({ sig, shares: budget / (px * (1 + LONG_BUY)), trade }); cash -= budget; taken++;
      }
    }
    curve.push(mark());
  }
  const start = calendar.findIndex((d) => d >= START);
  const c = curve.slice(start), years = (c.length - 1) / 250;
  let peak = 0, mdd = 0; for (const v of c) { peak = Math.max(peak, v); mdd = Math.max(mdd, 1 - v / peak); }
  return { cagr: (c[c.length - 1] / c[0]) ** (1 / years) - 1, total: c[c.length - 1] / c[0] - 1, mdd, trades: taken, finalEquity: c[c.length - 1] / c[0] };
}

// ---------- 執行 ----------
const HORIZONS = [5, 10, 20, 60, 120];
const results: Record<string, any> = {};
const rowsStore: Record<string, Row[]> = {};
for (const k of SETUPS) {
  const short = isShort(k), sigs = signals[k];
  const horizons: Record<string, unknown> = {}, rules: Record<string, unknown> = {};
  for (const H of HORIZONS) {
    const rows = sigs.map((sg) => fixedTrade(sg, short, H)).filter((r): r is Row => !!r);
    rowsStore[`${k}/H${H}`] = rows;
    horizons[`H${H}`] = summarize(rows);
  }
  for (const rule of RULES) {
    const rows = sigs.map((sg) => ruleTrade(sg, short, rule)).filter((r): r is Row => !!r);
    rowsStore[`${k}/${rule}`] = rows;
    rules[rule] = { ...summarize(rows), meanDays: mean(rows.map((r) => r.exit - r.entry)) };
  }
  const breakdowns: Record<string, unknown> = {};
  if (short) for (const H of [20, 60]) {
    const rows = rowsStore[`${k}/H${H}`];
    breakdowns[`H${H}`] = {
      byYear: groupBy(rows, (r) => r.year), byRegime: groupBy(rows, (r) => r.regime),
      byDistMa200: groupBy(rows, (r) => r.distB), byMarket: groupBy(rows, (r) => r.market),
    };
  }
  results[k] = { signals: sigs.length, direction: short ? 'short' : 'long', horizons, rules, breakdowns };
  console.error(`${k}: ${sigs.length} signals`);
}
const startI = calendar.findIndex((d) => d >= START);
const years = (n - 1 - startI) / 250;
let pk = 0, mddB = 0; for (let i = startI; i < n; i++) { pk = Math.max(pk, mkt[i]); mddB = Math.max(mddB, 1 - mkt[i] / pk); }
results.portfolio = { low120_short_stop10_hold60: portfolio('low120'), high120_long_stop10_hold60: portfolio('high120'),
  benchmarkTR: { cagr: (mkt[n - 1] / mkt[startI]) ** (1 / years) - 1, total: mkt[n - 1] / mkt[startI] - 1, mdd: mddB, from: calendar[startI], to: calendar[n - 1] } };
results.meta = { sessions: n, from: calendar[0], to: calendar[n - 1], signalStart: START, costs: { longBuy: LONG_BUY, longSell: LONG_SELL, shortSell: 0.004425, borrow: 0.0008, shortBuy: SHORT_BUY },
  minShares: MIN_SHARES, minPrice: MIN_PRICE, cooldown: COOLDOWN, maxHold: MAX_HOLD,
  note: 'mktRet = TR index close(exit) / close(signal day) - 1; short excess = shortRet + mktRet; rule trades still open at data end are excluded' };
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));

// ---------- 摘要 ----------
const f = (x: number | undefined, d = 1) => x === undefined || !Number.isFinite(x) ? '   n/a' : (x * 100).toFixed(d).padStart(6);
const line = (label: string, s: any) => s.n ? `${label.padEnd(16)} n=${String(s.n).padStart(6)} mean${f(s.meanRet)}% med${f(s.medianRet)}% win${f(s.winRate, 0)}% PF${(s.profitFactor ?? NaN).toFixed(2).padStart(5)} p05${f(s.p05)}% worst${f(s.worst, 0)}% | exc${f(s.meanExcess)}% CI[${f(s.excessBoot?.lo)},${f(s.excessBoot?.hi)}] p+${(s.excessBoot?.pPositive ?? NaN).toFixed(2)} | retCI[${f(s.retBoot?.lo)},${f(s.retBoot?.hi)}] p+${(s.retBoot?.pPositive ?? NaN).toFixed(2)}` : `${label.padEnd(16)} n=0`;
console.log(`sessions=${n} ${calendar[0]}..${calendar[n - 1]}, signals from ${START}`);
for (const k of SETUPS) {
  const r = results[k];
  console.log(`\n=== ${k} (${r.direction}) signals=${r.signals} ===`);
  for (const H of HORIZONS) console.log(line(`H${H}`, r.horizons[`H${H}`]));
  for (const rule of RULES) console.log(line(rule, r.rules[rule]) + ` days=${r.rules[rule].meanDays?.toFixed(1)}`);
}
for (const k of ['low120', 'low200'] as Setup[]) for (const H of [20, 60]) {
  const b = results[k].breakdowns[`H${H}`];
  console.log(`\n--- ${k} short H${H} breakdowns ---`);
  for (const [name, g] of Object.entries(b)) for (const [key, s] of Object.entries(g as any)) console.log(line(`${name.replace('by', '')}:${key}`, { ...(s as any), retBoot: undefined }));
}
console.log('\n--- portfolio (10 slots, stop10_hold60) ---');
for (const [k, v] of Object.entries(results.portfolio) as [string, any][]) console.log(`${k}: CAGR ${f(v.cagr)}% total ${f(v.total)}% MDD ${f(v.mdd)}%${v.trades !== undefined ? ` trades=${v.trades}` : ''}`);
console.log(`wrote ${OUT}/results.json`);
