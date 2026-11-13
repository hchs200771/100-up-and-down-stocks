/** Local descriptive research. Run: node --import tsx scripts/research-aaii-sentiment.ts
 * Statistical/SVG helpers adapted from research-credit-breadth.ts and research-volume-profile-stop.ts
 * (those scripts execute on import). No Taiwan wide-market panel is needed for US indices.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';

const ID = '2026-11-13-aaii-sentiment', OUT = 'data/backtest/aaii-sentiment', CACHE = `${OUT}/cache`;
const CHART = `research/factor-lab/charts/${ID}`, RESULTS = `${OUT}/results.json`;
const NOW = new Date(), TODAY = NOW.toISOString().slice(0, 10), HORIZONS = [5, 10, 20, 60];
const warnings: string[] = [], sources: Record<string, unknown> = {};
for (const dir of [CACHE, CHART]) mkdirSync(dir, { recursive: true });
const log = (s: string) => console.log(`[AAII ${new Date().toISOString()}] ${s}`);
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const finite = Number.isFinite;
function quantile(a: number[], p: number) { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y), k = (b.length - 1) * p, i = Math.floor(k); return b[i] + (b[Math.min(i + 1, b.length - 1)] - b[i]) * (k - i); }
function rng(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' }, signal: AbortSignal.timeout(40000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
function fresh(file: string) { return existsSync(file) && Date.now() - statSync(file).mtimeMs < 18 * 3600000; }
interface Survey { date: string; bull: number; neutral: number; bear: number }
function parseSurvey(raw: Buffer): Survey[] {
  // Keep Excel serials: cellDates constructs local-midnight Dates, whose UTC date
  // would be the previous day in Taipei and would introduce a full day of look-ahead.
  const wb = XLSX.read(raw, { type: 'buffer', cellDates: false }), found: Survey[] = [];
  for (const sheet of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, raw: true });
    for (const r of rows) {
      let date = '';
      if (r[0] instanceof Date) date = r[0].toISOString().slice(0, 10);
      else if (typeof r[0] === 'number' && r[0] > 30000 && r[0] < 70000) date = new Date(Math.round((r[0] - 25569) * 86400000)).toISOString().slice(0, 10);
      else if (typeof r[0] === 'string' && /\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/.test(r[0]) && finite(Date.parse(r[0]))) date = new Date(r[0]).toISOString().slice(0, 10);
      const values = r.slice(1, 4).map(x => typeof x === 'string' ? Number(x.replace('%', '')) / (x.includes('%') ? 100 : 1) : Number(x));
      if (!date || date < '1987-01-01' || date > TODAY || values.some(v => !finite(v) || v < 0 || v > 1) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > .012) continue;
      found.push({ date, bull: values[0], neutral: values[1], bear: values[2] });
    }
  }
  const sorted = [...new Map(found.map(r => [r.date, r])).values()].sort((a, b) => a.date.localeCompare(b.date));
  assert(sorted.some(r => r.date < '2016-01-01') && sorted.length > 500, 'Invalid/incomplete AAII workbook');
  return sorted;
}
async function survey(): Promise<Survey[]> {
  const file = `${CACHE}/sentiment.xls`, urls = ['https://www.aaii.com/files/surveys/sentiment.xls', 'https://www.aaii.com/files/surveys/sentiment.xls?download=1'];
  if (!fresh(file)) for (const url of urls) {
    try { log(`download ${url}`); const b = await download(url); parseSurvey(b); writeFileSync(file, b); break; }
    catch (e) { log(`AAII download: ${e}`); }
  }
  // Optional TLS-compatible download for AAII's WAF. Requires Python curl_cffi;
  // no Python dependency is installed by this script. An existing raw cache also works offline.
  if (!fresh(file)) {
    try {
      const raw = execFileSync('python3', ['-c', `from curl_cffi import requests
import sys
s=requests.Session(impersonate='chrome')
s.get('https://www.aaii.com/sentimentsurvey/sent_results',timeout=40)
r=s.get('https://www.aaii.com/files/surveys/sentiment.xls',timeout=40)
r.raise_for_status()
sys.stdout.buffer.write(r.content)`], { timeout: 85000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      parseSurvey(raw); writeFileSync(file, raw); log('AAII official workbook downloaded with optional curl_cffi');
    } catch { log('Optional curl_cffi unavailable/failed; using raw cache if present. To enable: python3 -m pip install curl_cffi'); }
  }
  if (!existsSync(file)) throw new Error('Official AAII workbook unavailable; refusing to fabricate results. Retry after access is restored.');
  const rows = parseSurvey(readFileSync(file));
  sources.AAII = { url: urls[0], cache: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), cachedAt: statSync(file).mtime.toISOString(), first: rows[0].date, latest: rows.at(-1)!.date };
  if (Date.parse(TODAY) - Date.parse(rows.at(-1)!.date) > 10 * 86400000) warnings.push(`AAII latest release is stale: ${rows.at(-1)!.date}.`);
  return rows;
}
interface Bar { date: string; open: number; high: number; low: number; close: number }
async function prices(symbol: string, fred: string): Promise<Bar[]> {
  const file = `${CACHE}/${fred}.json`;
  if (fresh(file)) { const c = JSON.parse(readFileSync(file, 'utf8')); sources[symbol] = c.source; if (c.warning) warnings.push(c.warning); return c.rows; }
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) { const ms = [0, 15000, 30000, 60000][attempt]; log(`${symbol}: backoff ${ms / 1000}s`); await sleep(ms); }
    const host = attempt % 2 ? 'query2' : 'query1';
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${Date.parse('2015-10-01') / 1000}&period2=${Math.floor(Date.now() / 1000)}`;
      log(`Yahoo ${symbol} attempt ${attempt + 1}`);
      const j = JSON.parse((await download(url)).toString()), r = j.chart?.result?.[0], q = r?.indicators?.quote?.[0];
      if (!r?.timestamp || !q) throw new Error('Missing chart');
      const rows: Bar[] = r.timestamp.map((t: number, i: number) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] }));
      // Exclude the current, possibly incomplete US session. Reject gaps rather than compressing trading days.
      const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(NOW);
      const nyHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(NOW));
      const completed = rows.filter(b => b.date < nyDate || (b.date === nyDate && nyHour >= 17));
      if (completed.length < 2000 || completed.some(b => ![b.open, b.high, b.low, b.close].every(v => finite(v) && v > 0))) throw new Error('Incomplete OHLC history');
      const source = { provider: 'Yahoo OHLC', url, first: completed[0].date, latest: completed.at(-1)!.date };
      writeFileSync(file, JSON.stringify({ source, rows: completed })); sources[symbol] = source; return completed;
    } catch (e) { lastError = String(e); log(`${symbol}: ${lastError}`); }
  }
  const rawFile = `${CACHE}/${fred}.csv`, url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${fred}&cosd=2015-10-01`;
  try { writeFileSync(rawFile, await download(url)); } catch (e) { if (!existsSync(rawFile)) throw e; warnings.push(`${fred}: using stale cached FRED CSV after ${e}`); }
  const rows: Bar[] = readFileSync(rawFile, 'utf8').trim().split(/\r?\n/).slice(1).flatMap(l => { const [date, raw] = l.split(','), v = Number(raw); return v > 0 && date <= TODAY ? [{ date, open: v, high: v, low: v, close: v }] : []; });
  assert(rows.length > 500, `Insufficient FRED ${fred}`);
  const warning = `${symbol}: Yahoo failed (${lastError}); FRED close-only. All high/low and range tests use closes, not intraday extremes.`;
  warnings.push(warning);
  if (rows[0].date > '2016-01-08') warnings.push(`${symbol}: FRED starts ${rows[0].date}; requested 2016 coverage unavailable (SP500 has a rolling ten-year history).`);
  const source = { provider: 'FRED close-only', url, first: rows[0].date, latest: rows.at(-1)!.date };
  sources[symbol] = source; writeFileSync(file, JSON.stringify({ source, warning, rows })); return rows;
}
interface Week { date: string; release: string; t: number; above: boolean; weekReturn: number; high: number; low: number; bull: number; bear: number; spread: number; db: number; dn: number; dr: number; states: string[] }
const LABELS = { S1: '漲／多增空減', S2: '跌／多減空增', S3: '跌／多增空減', S4: '漲／空增', DD: '空減中立減', bear50: '空≥50%', bull30: '多≤30%', spreadM20: '多空差≤−20', bull50: '多≥50%', spreadP30: '多空差≥30' };
function classify(r: Survey, past: number, db: number, dr: number, dn: number) {
  const mask = { S1: past > 0 && db > 0 && dr < 0, S2: past < 0 && db < 0 && dr > 0, S3: past < 0 && db > 0 && dr < 0, S4: past > 0 && dr > 0, DD: dr < 0 && dn < 0, bear50: r.bear >= .5, bull30: r.bull <= .3, spreadM20: r.bull - r.bear <= -.2, bull50: r.bull >= .5, spreadP30: r.bull - r.bear >= .3 };
  return Object.keys(mask).filter(k => mask[k]);
}
function weeks(s: Survey[], bars: Bar[]): Week[] {
  const at = (date: string) => bars.findIndex(b => b.date >= date), out: Week[] = [];
  for (let i = 1; i < s.length; i++) {
    const r = s[i], prev = s[i - 1], t = at(r.date), p = at(prev.date);
    if (r.date < '2016-01-01' || t < 30 || p <= 0 || Date.parse(bars[t].date) - Date.parse(r.date) > 4 * 86400000) continue;
    const past = bars[t - 1].close / bars[p - 1].close - 1, db = (r.bull - prev.bull) * 100, dr = (r.bear - prev.bear) * 100, dn = (r.neutral - prev.neutral) * 100;
    out.push({ date: bars[t].date, release: r.date, t, above: bars[t].close > mean(bars.slice(t - 29, t + 1).map(b => b.close)), weekReturn: past, high: Math.max(...bars.slice(t - 5, t).map(b => b.high)), low: Math.min(...bars.slice(t - 5, t).map(b => b.low)), bull: r.bull, bear: r.bear, spread: (r.bull - r.bear) * 100, db, dn, dr, states: classify(r, past, db, dr, dn) });
  }
  assert(new Set(out.map(w => w.date)).size === out.length, 'Duplicate signal dates');
  return out;
}
// Circular moving blocks of ALL release weeks, including weeks without the signal.
// Joint signal/baseline resampling preserves their dependence; 13/26 week blocks cover 60d windows.
function bootstrap(values: number[], mask: boolean[], base: boolean[], block: number, iterations = 1500) {
  const group = (length: number) => values.map((_, start) => { const g = [0, 0, 0, 0, 0]; for (let k = 0; k < length; k++) { const i = (start + k) % values.length, v = values[i]; if (!finite(v)) continue; if (mask[i]) { g[0] += v; g[1]++; g[4] += v > 0 ? 1 : 0; } if (base[i]) { g[2] += v; g[3]++; } } return g; });
  const groups = group(block), remainder = values.length % block, tail = remainder ? group(remainder) : groups;
  const random = rng(20261113), means: number[] = [], excess: number[] = [], wins: number[] = [];
  for (let k = 0; k < iterations && groups.length; k++) { const sums = [0, 0, 0, 0, 0]; for (let j = 0; j < Math.ceil(values.length / block); j++) { const pool = remainder && j === Math.floor(values.length / block) ? tail : groups, g = pool[Math.floor(random() * pool.length)]; for (let z = 0; z < 5; z++) sums[z] += g[z]; } if (sums[1] && sums[3]) { means.push(sums[0] / sums[1]); excess.push(sums[0] / sums[1] - sums[2] / sums[3]); wins.push(sums[4] / sums[1]); } }
  const ci = (a: number[]) => [quantile(a, .025), quantile(a, .975)];
  return { meanCI95: ci(means), excessCI95: ci(excess), winRateCI95: ci(wins), blockWeeks: block, iterations, validDraws: means.length };
}
function stats(ws: Week[], values: number[], mask: boolean[], base = ws.map(() => true)) {
  const a = values.filter((v, i) => finite(v) && mask[i]), b = values.filter((v, i) => finite(v) && base[i]);
  return { n: a.length, baselineN: b.length, mean: mean(a), baselineMean: mean(b), excess: mean(a) - mean(b), winRate: mean(a.map(v => +(v > 0))), baselineWinRate: mean(b.map(v => +(v > 0))), ...bootstrap(values, mask, base, 13), sensitivity26Weeks: bootstrap(values, mask, base, 26, 1000) };
}
type Stat = ReturnType<typeof stats>;
function analysis(all: Week[], bars: Bar[], period: 'train' | 'validate') {
  const end = period === 'train' ? '2020-12-31' : TODAY;
  const ws = all.filter(w => period === 'train' ? w.date <= end : w.date >= '2021-01-01');
  const available = (w: Week, h: number) => w.t + h < bars.length && bars[w.t + h].date <= end;
  const forward = (w: Week, h: number) => available(w, h) ? bars[w.t + h].close / bars[w.t].close - 1 : NaN;
  const states = Object.keys(LABELS).flatMap(state => ['all', 'above', 'below'].map(split => ({ state, split, observations: ws.filter(w => w.states.includes(state) && (split === 'all' || w.above === (split === 'above'))).length,
    horizons: Object.fromEntries(HORIZONS.map(h => [h, stats(ws, ws.map(w => forward(w, h)), ws.map(w => w.states.includes(state) && (split === 'all' || w.above === (split === 'above'))))])) })));
  const probability = (state: string, horizon: number, fn: (w: Week) => boolean) => stats(ws, ws.map(w => available(w, horizon) ? +fn(w) : NaN), ws.map(w => w.states.includes(state)));
  const newLow = probability('S3', 20, w => bars.slice(w.t + 1, w.t + 21).some(b => b.low < w.low));
  const s4Continuation = probability('S4', 20, w => bars[w.t + 20].close > bars[w.t].close);
  const s1Chop = probability('S1', 20, w => { const next = bars.slice(w.t + 1, w.t + 21), entry = bars[w.t].close; return next.some(b => b.high > entry) && next.some(b => b.low < entry); });
  const upTest = (w: Week) => { for (let j = 1; j <= 5; j++) if (bars[w.t + j].high > w.high) return j; return 0; };
  const ddUp = probability('DD', 5, w => upTest(w) > 0);
  const ddUpThenDown = probability('DD', 10, w => { const j = upTest(w); return j > 0 && bars.slice(w.t + j + 1, w.t + 11).some(b => b.close < bars[w.t].close); });
  const sequence = ws.map(w => { if (!available(w, 10)) return NaN; const j = upTest(w); return j ? +bars.slice(w.t + j + 1, w.t + 11).some(b => b.close < bars[w.t].close) : NaN; });
  const ddDownGivenUp = stats(ws, sequence, ws.map(w => w.states.includes('DD')));
  // First closing break in t+1..t+20. Return follows the break for a further 20 days.
  const breaks = ws.map(w => { if (!available(w, 40)) return null; for (let j = 1; j <= 20; j++) { const b = bars[w.t + j]; const direction = b.close > w.high ? 1 : b.close < w.low ? -1 : 0; if (!direction) continue; return { date: b.date, direction, delay: j, directionalReturn: direction * (bars[w.t + j + 20].close / b.close - 1), falseBreak: bars.slice(w.t + j + 1, w.t + j + 6).some(x => x.close >= w.low && x.close <= w.high) }; } return { direction: 0, date: null, delay: null, directionalReturn: NaN, falseBreak: false }; });
  const ddBreak = Object.fromEntries(['up', 'down', 'none'].map(side => { const d = side === 'up' ? 1 : side === 'down' ? -1 : 0, mask = ws.map(w => w.states.includes('DD'));
    const incidence = stats(ws, breaks.map(b => b ? +(b.direction === d) : NaN), mask);
    const base = breaks.map(b => !!b && b.direction === d), selected = mask.map((m, i) => m && base[i]);
    return [side, { incidence, followThrough: stats(ws, breaks.map(b => b && b.direction === d && d ? b.directionalReturn : NaN), selected, base), falseBreak: stats(ws, breaks.map(b => b && b.direction === d && d ? +b.falseBreak : NaN), selected, base) }]; }));
  const ddReduce = Object.fromEntries([20, 60].map(h => [h, stats(ws, ws.map(w => forward(w, h)), ws.map(w => w.above && w.states.includes('DD')), ws.map(w => w.above && !w.states.includes('DD')))]));
  return { observations: ws.length, first: ws[0]?.date, latest: ws.at(-1)?.date, unconditional: Object.fromEntries(HORIZONS.map(h => [h, stats(ws, ws.map(w => forward(w, h)), ws.map(() => true))])), states, newLow, s4Continuation, s1Chop, ddUp, ddUpThenDown, ddDownGivenUp, ddBreak, ddReduce, breakEvents: ws.map((w, i) => ({ signalDate: w.date, dd: w.states.includes('DD'), ...breaks[i] })) };
}
const pct = (v: number, digits = 2) => finite(v) ? `${(v * 100).toFixed(digits)}%` : '—';
const ciText = (s: Stat) => `[${s.excessCI95.map(v => pct(v)).join(', ')}]`;
const svg = (title: string, body: string, height = 600) => `<svg viewBox="0 0 1000 ${height}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif" font-size="12" fill="currentColor"><title>${title}</title><text x="500" y="26" text-anchor="middle" font-size="17">${title}</text>${body}</svg>\n`;
const txt = (x: number, y: number, s: string, extra = '') => `<text x="${x}" y="${y}" ${extra}>${s}</text>`;
const line = (x: number, y: number, xx: number, yy: number, color = 'currentColor') => `<line x1="${x}" y1="${y}" x2="${xx}" y2="${yy}" stroke="${color}"/>`;
type Analysis = ReturnType<typeof analysis>;
const stateStat = (a: Analysis, state: string, h = 20) => a.states.find(r => r.state === state && r.split === 'all')!.horizons[h];
function charts(train: Analysis, validate: Analysis, ws: Week[], bars: Bar[]) {
  const keys = Object.keys(LABELS), all = [train, validate].flatMap(a => keys.flatMap(k => stateStat(a, k).excessCI95)).filter(finite);
  const limit = Math.max(.01, ...all.map(Math.abs)) * 1.12, x = (v: number) => 550 + v / limit * 360;
  let b = txt(250, 49, '藍：2016–2020；橘：2021+；95% CI（13 週區塊）；單位：百分點');
  for (let k = -2; k <= 2; k++) { const v = k * limit / 2; b += line(x(v), 65, x(v), 560, '#aaa') + txt(x(v), 585, (v * 100).toFixed(1), 'text-anchor="middle"'); }
  keys.forEach((key, i) => { const y = 77 + i * 48; b += txt(15, y + 12, `${key} ${LABELS[key]}`); [train, validate].forEach((a, j) => { const s = stateStat(a, key), yy = y + j * 18, color = j ? '#db8227' : '#4285bd'; if (!finite(s.excess)) return; const lo = s.excessCI95[0], hi = s.excessCI95[1]; b += `<rect x="${Math.min(x(0), x(s.excess))}" y="${yy - 5}" width="${Math.max(1, Math.abs(x(s.excess) - x(0)))}" height="10" fill="${color}"/>` + line(x(lo), yy, x(hi), yy, color) + line(x(lo), yy - 5, x(lo), yy + 5, color) + line(x(hi), yy - 5, x(hi), yy + 5, color) + txt(925, yy + 4, `n=${s.n}`); }); });
  writeFileSync(`${CHART}/01-state-excess.svg`, svg('Nasdaq：20 日超額報酬，訓練 vs 驗證', b));
  const end = bars.at(-1)!.date, from = new Date(end); from.setUTCFullYear(from.getUTCFullYear() - 2); const start = from.toISOString().slice(0, 10), daily = bars.filter(r => r.date >= start), weekly = ws.filter(w => w.date >= start);
  const xx = (d: string) => 75 + (Date.parse(d) - Date.parse(start)) / (Date.parse(end) - Date.parse(start)) * 830;
  const min = Math.min(...daily.map(r => r.low)) * .97, max = Math.max(...daily.map(r => r.high)) * 1.03, y = (v: number) => 335 - (v - min) / (max - min) * 260;
  const points = daily.map(r => `${xx(r.date)},${y(r.close)}`).join(' '), ma = daily.map(r => { const i = bars.indexOf(r); return `${xx(r.date)},${y(mean(bars.slice(i - 29, i + 1).map(z => z.close)))}`; }).join(' ');
  b = txt(75, 51, 'Nasdaq 藍線／SMA30 橘線；下圖 AAII 多空差（百分點）') + `<polyline points="${points}" fill="none" stroke="#4285bd" stroke-width="1.5"/><polyline points="${ma}" fill="none" stroke="#db8227" stroke-width="1.5"/>`;
  for (let i = 0; i <= 4; i++) { const v = min + (max - min) * i / 4; b += txt(8, y(v) + 4, Math.round(v).toLocaleString()); }
  b += line(75, 440, 905, 440, '#aaa');
  weekly.forEach(w => { const yy = 440 - w.spread * 1.6; b += `<rect x="${xx(w.date)}" y="${Math.min(yy, 440)}" width="4" height="${Math.max(1, Math.abs(yy - 440))}" fill="${w.spread >= 0 ? '#4285bd' : '#d95757'}"/>`; });
  for (const v of [-40, -20, 0, 20, 40]) b += txt(35, 444 - v * 1.6, `${v}`);
  for (let i = 0; i <= 4; i++) { const d = new Date(Date.parse(start) + (Date.parse(end) - Date.parse(start)) * i / 4).toISOString().slice(0, 10); b += txt(xx(d), 550, d, 'text-anchor="middle"'); }
  writeFileSync(`${CHART}/02-spread-nasdaq.svg`, svg('最近兩年：AAII 多空差與 Nasdaq／SMA30', b, 575));
  b = txt(75, 49, '驗證期；藍：雙降，灰：全部週；收盤首次突破；需完整 40 日追蹤');
  ['up', 'down', 'none'].forEach((side, i) => { const s = validate.ddBreak[side], x = 130 + i * 285; b += txt(x, 85, { up: '先向上突破', down: '先向下突破', none: '20 日未突破' }[side]); [s.incidence.mean, s.incidence.baselineMean].forEach((p, j) => { b += `<rect x="${x + j * 65}" y="${350 - p * 230}" width="50" height="${p * 230}" fill="${j ? '#999' : '#4285bd'}"/>` + txt(x + j * 65, 370, pct(p, 1)); }); if (side !== 'none') b += txt(x - 20, 420, `順向20日：${pct(s.followThrough.mean)} / ${pct(s.followThrough.baselineMean)}`) + txt(x - 20, 445, `超額CI：${ciText(s.followThrough)}`) + txt(x - 20, 470, `5日假突破：${pct(s.falseBreak.mean, 1)} / ${pct(s.falseBreak.baselineMean, 1)}`) + txt(x - 20, 495, `突破 n=${s.followThrough.n}；未扣成本`); });
  writeFileSync(`${CHART}/03-dd-range-break.svg`, svg('Nasdaq：雙降區間突破後，續行還是失敗？', b, 530));
}
function judgment(s: Stat, direction: number): string {
  if (s.n < 10 || !finite(s.excess)) return '不成立（樣本不足）';
  const c = s.excessCI95, c26 = s.sensitivity26Weeks.excessCI95;
  if (direction * s.excess <= 0) return '不成立';
  return (direction > 0 ? c[0] > 0 && c26[0] > 0 : c[1] < 0 && c26[1] < 0) ? '成立' : '部分成立（方向符合，CI 跨零）';
}
async function main() {
  // Fetch prices even if AAII is blocked, so a retry can reuse the expensive inputs.
  const inputs = await Promise.allSettled([survey(), prices('^IXIC', 'NASDAQCOM'), prices('^GSPC', 'SP500')]);
  const failed = inputs.filter(x => x.status === 'rejected');
  if (failed.length) { for (const f of failed) log(String((f as PromiseRejectedResult).reason)); throw new Error('Required input unavailable; no experiment or charts written.'); }
  const s = (inputs[0] as PromiseFulfilledResult<Survey[]>).value;
  const markets = Object.fromEntries(['^IXIC', '^GSPC'].map((symbol, i) => { const bars = (inputs[i + 1] as PromiseFulfilledResult<Bar[]>).value, ws = weeks(s, bars); log(`${symbol}: ${bars.length} daily bars, ${ws.length} release weeks; computing bootstrap`); const train = analysis(ws, bars, 'train'), validate = analysis(ws, bars, 'validate');
    const latest = ws.at(-1), latestSurvey = s.at(-1)!, prevSurvey = s.at(-2)!;
    const prior = bars.filter(b => b.date < latestSurvey.date), beforePrev = bars.filter(b => b.date < prevSurvey.date).at(-1)!;
    const db = (latestSurvey.bull - prevSurvey.bull) * 100, dr = (latestSurvey.bear - prevSurvey.bear) * 100, dn = (latestSurvey.neutral - prevSurvey.neutral) * 100;
    const weekReturn = prior.at(-1)!.close / beforePrev.close - 1;
    const activeDD = ws.filter(w => w.states.includes('DD') && Date.parse(latestSurvey.date) - Date.parse(w.release) <= 28 * 86400000).at(-1);
    const pending = latest?.release !== latestSurvey.date;
    const current = { latestAAII: latestSurvey, deltasPP: { bull: db, neutral: dn, bear: dr }, weekReturn,
      states: classify(latestSurvey, weekReturn, db, dr, dn), pendingReleaseClose: pending,
      sma30Position: pending ? 'pending release-day close' : latest!.above ? 'above' : 'below',
      lastCompletedClose: { date: bars.at(-1)!.date, close: bars.at(-1)!.close, sma30: mean(bars.slice(-30).map(b => b.close)), position: bars.at(-1)!.close > mean(bars.slice(-30).map(b => b.close)) ? 'above' : 'below' },
      latestCompletedSignal: latest,
      activeDDRange: dr < 0 && dn < 0 ? { release: latestSurvey.date, high: Math.max(...prior.slice(-5).map(b => b.high)), low: Math.min(...prior.slice(-5).map(b => b.low)) } : activeDD ? { release: activeDD.release, high: activeDD.high, low: activeDD.low } : null };
    log(`${symbol} current reading: ${JSON.stringify(current)}`);
    return [symbol, { train, validate, last5Years: { alias: 'validate', definition: '2021+ as requested; not a rolling five-year window' }, current, signalWeeks: ws, bars }]; }));
  const buildClaims = (primary: typeof markets[string]) => {
  const claims: { rule: string; verdict: string; train: Stat; validate: Stat; measure: string }[] = [];
  const add = (rule: string, measure: string, a: Stat, b: Stat, direction: number) => claims.push({ rule, measure, train: a, validate: b, verdict: judgment(b, direction) });
  for (const [k, direction] of [['S1', -1], ['S4', 1], ['bear50', 1], ['bull30', 1], ['spreadM20', 1], ['bull50', -1], ['spreadP30', -1]] as [string, number][]) add(k, '20d return excess', stateStat(primary.train, k), stateStat(primary.validate, k), direction);
  for (const h of [5, 10]) add(`S2-${h}d`, `${h}d return excess`, stateStat(primary.train, 'S2', h), stateStat(primary.validate, 'S2', h), 1);
  add('S3', '20d new low probability excess', primary.train.newLow, primary.validate.newLow, 1);
  add('DD-up', '5d up-test probability excess', primary.train.ddUp, primary.validate.ddUp, 1);
  add('DD-up-down', 'up-test then close below entry by t+10 joint probability excess', primary.train.ddUpThenDown, primary.validate.ddUpThenDown, 1);
  for (const side of ['up', 'down']) add(`DD-break-${side}`, 'directional return 20d after break vs same-side all-week breaks', primary.train.ddBreak[side].followThrough, primary.validate.ddBreak[side].followThrough, 1);
  for (const h of [20, 60]) add(`DD-reduce-${h}d`, 'return excess vs other above-SMA30 weeks', primary.train.ddReduce[h], primary.validate.ddReduce[h], -1);
  add('S4-win', '20d positive-return probability excess', primary.train.s4Continuation, primary.validate.s4Continuation, 1);
  add('S1-chop', '20d high above AND low below entry probability excess', primary.train.s1Chop, primary.validate.s1Chop, 1);
  return claims;
  };
  const claimsByMarket = Object.fromEntries(Object.entries(markets).map(([symbol, market]) => [symbol, buildClaims(market)]));
  const primary = markets['^IXIC'], claims = claimsByMarket['^IXIC'];
  warnings.push('Historical AAII workbook is the latest vintage; no archive of first-published values. Survey row dates are treated as release dates per specification; no hindsight adjustment.', 'Close(t) entry and SMA30 include signal-day close: assumes execution at that close; index price returns exclude dividends, fees and slippage.', 'Multiple states overlap; 13/26-week circular moving-block bootstrap is descriptive, with no multiple-testing adjustment. Sparse extremes cannot establish reliability.', 'Train outcomes crossing 2021 are censored; unfinished forward windows are excluded separately per metric. Range-break needs full 40d for every week to avoid outcome-dependent censoring.', 'S1 continuation discount means lower 20d mean return; 洗盤 proxy means next-20d high above AND low below entry (no minimum excursion threshold). DD pullback means a strictly later close after the first 5d up-test, by t+10 (not 10 days after the up-test).');
  const output = { id: ID, generatedAt: NOW.toISOString(), requestedPeriod: ['2016-01-01', TODAY], sources, method: { train: '2016–2020; outcomes end by 2020-12-31', validate: '2021+', blockWeeks: [13, 26], bootstrapSeed: 20261113, intervals: 'Percentile 95%, joint signal and baseline resampling over all release weeks', splitBaseline: 'All release weeks in same period, including above/below splits; DD-reduce uses OTHER above-SMA30 weeks', timing: 'release t, next trading day if closed; past return close(t-1)/close(previous release trading day-1)-1; entry close(t); range five trading days ending t-1', units: 'Returns and probabilities in fractions; deltas and spread in percentage points', verdict: 'Each market validate only (experiment uses Nasdaq): 成立 requires n≥10 and both 13/26-week excess CIs support direction; 部分成立 means direction only; 不成立 means opposite direction or insufficient sample' }, warnings, claims, claimsByMarket, markets };
  writeFileSync(RESULTS, JSON.stringify(output, null, 2) + '\n');
  charts(primary.train, primary.validate, primary.signalWeeks, primary.bars);
  const descriptions = { S1: '20日平均報酬折減', S4: '20日平均報酬', bear50: '空方≥50%反向買進', bull30: '多方≤30%反向買進', spreadM20: '多空差≤−20反向買進', bull50: '多方≥50%反向警戒', spreadP30: '多空差≥30反向警戒', 'S2-5d': '5日反彈', 'S2-10d': '10日反彈', S3: '20日跌破訊號週低點機率', 'DD-up': '5日上測週高機率', 'DD-up-down': '先上測再於第10日前跌回進場價之聯合機率', 'DD-break-up': '向上首次突破後20日順向報酬', 'DD-break-down': '向下首次突破後20日順向報酬', 'DD-reduce-20d': '月線上雙降20日報酬', 'DD-reduce-60d': '月線上雙降60日報酬', 'S4-win': '20日續漲機率', 'S1-chop': '20日高低分居進場價兩側機率' };
  const pp = (v: number) => finite(v) ? `${(v * 100).toFixed(2)} 個百分點` : '—';
  const findings = claims.map(c => `${c.rule}：${c.verdict}。${descriptions[c.rule]}，訓練 n=${c.train.n}、超額 ${pp(c.train.excess)}；驗證 n=${c.validate.n}、超額 ${pp(c.validate.excess)}，95% CI ${ciText(c.validate)}。`);
  const supported = claims.filter(c => c.verdict === '成立').length;
  const entry = { id: ID, date: '2026-11-13', category: '市場情緒', title: 'AAII 情緒解讀：反彈、續跌與雙降區間能預測 Nasdaq 嗎？', question: '作者的 S1–S4、雙降、情緒極端與月線減碼規則，在 2021 年後仍有超額預測力嗎？', verdict: supported ? '有條件' : '不成立', verdictNote: `驗證 ${claims.length} 項操作化主張中，${supported} 項獲兩種區塊 CI 支持；逐項成立／不成立／部分成立見 findings。`, summary: `AAII 最新 ${s.at(-1)!.date}；Nasdaq 訓練 ${primary.train.observations} 週、驗證 ${primary.validate.observations} 週。報酬、創低機率與雙降路徑均與同段全部週比較；S&P 500 為第二市場，完整分層與 5/10/20/60 日結果見 JSON。`, method: 'AAII 官方週資料；2016–2020 訓練、2021+ 驗證（亦為指定近五年）。發布日收盤進場，休市順延；前週漲跌截至 t−1，基準為上次發布日前一交易日。區間用 t−1 結束的五日高低；SMA30 含 t。13 與 26 週移動區塊、固定種子 bootstrap，聯合重算訊號／基準。訓練結果不跨入驗證，末端不足期數剔除；區間突破需完整 40 日。', stats: claims.filter(c => ['S3', 'S2-5d', 'DD-up-down', 'DD-reduce-60d'].includes(c.rule)).map(c => ({ label: c.rule, value: pct(c.validate.excess), tone: c.verdict === '成立' ? 'pos' : 'neg', note: `${c.verdict}；n=${c.validate.n}；CI ${ciText(c.validate)}` })), findings, caveats: [
    '使用最新版本的 AAII 歷史檔，沒有首次發布值的逐期封存，無法排除後續修訂；Excel 以原始日期序號轉換，避免台北時區造成日期提前。',
    '狀態可以重疊，報酬窗口也會重疊。13／26 週移動區塊 CI 仍只是描述統計，18 項主張及多種期限未做多重檢定校正；少量極端訊號不宜外推。',
    '以發布日收盤算 SMA30 並假設同收盤進場；價格指數未含股息、交易費用及滑價。訓練結果不跨入 2021，末端不足期數按各指標剔除，突破分析統一要求完整 40 日。',
    'S1 洗盤代理定義為未來 20 日高低點分居進場價兩側，沒有幅度門檻。雙降先上再下是 5 日內上測後、嚴格較晚且截至 t+10 的收盤跌回進場價；另列已上測之條件機率。',
    '成立須驗證 n≥10 且兩種區塊長度的超額 CI 都支持主張；部分成立只代表方向相符，無法據此宣稱顯著。反方向或樣本不足列不成立，也不代表證明沒有任何效果。',
    ...warnings.filter(w => !/^(Historical AAII|Close\(t\)|Multiple states|Train outcomes|S1 continuation)/.test(w)),
  ], nextIdeas: ['規則在讀過後段行情後提出，時間切分不等於真正事前驗證；固定門檻後累積新發布週，再評估可交易的減碼與回補策略。'], source: { script: 'scripts/research-aaii-sentiment.ts', results: RESULTS }, charts: [{ file: '01-state-excess.svg', caption: 'Nasdaq 20 日超額報酬：訓練／驗證與 95% 區塊 CI；多數 CI 跨零時不宣稱有效。' }, { file: '02-spread-nasdaq.svg', caption: '最近兩年 AAII 多空差與 Nasdaq／SMA30；上下圖分軸，非因果證據。' }, { file: '03-dd-range-break.svg', caption: '雙降與全部週的首次收盤突破；順向報酬與五日內收回區間的假突破。' }] };
  const file = 'research/factor-lab/experiments.json', experiments = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(entry).sort(), Object.keys(experiments.find((x: { id: string }) => x.id === '2026-11-13-volume-profile-stop')).sort(), 'Experiment schema mismatch');
  writeFileSync(file, JSON.stringify([entry, ...experiments.filter((e: { id: string }) => e.id !== ID)], null, 2) + '\n');
  console.table(claims.map(c => ({ rule: c.rule, trainN: c.train.n, trainExcess: pct(c.train.excess), validateN: c.validate.n, validateExcess: pct(c.validate.excess), CI: ciText(c.validate), verdict: c.verdict })));
  log(`Wrote ${RESULTS}, 3 SVG charts, experiment entry. Warnings: ${warnings.join(' | ')}`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
