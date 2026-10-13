/** Offline CB time-axis experiments. Run: npx tsx scripts/backtest-cb-time-axis.ts */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createPanel, addDayQuotes, addReferenceEvent, finalizePanel, type StockPanel } from './lib/wide-market-panel.ts';

const ROOT = 'data/backtest/cb-time-axis';
const COST = .00585;
const positive = (x: number) => Number.isFinite(x) && x > 0;
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const quantile = (a: number[], p: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), k = (s.length - 1) * p, lo = Math.floor(k);
  return s[lo] + (s[Math.ceil(k)] - s[lo]) * (k - lo);
};
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
const yearsTo = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / (365.25 * 86400000));
const iso = (s: string) => /^\d{4}\/\d{2}\/\d{2}$/.test(s) ? s.replaceAll('/', '-') : '';
const num = (s: string) => s.trim() ? Number(s.replaceAll(',', '')) : NaN;
const fileDate = (s: string) => s.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
function csvLine(line: string): string[] {
  const cells: string[] = []; let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { cells.push(value.trim()); value = ''; }
    else value += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  cells.push(value.trim()); return cells;
}
function csvRows(path: string): Record<string, string>[] {
  let header: string[] | undefined; const rows: Record<string, string>[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n|\\r\\n/)) {
    if (!line.startsWith('HEADER,') && !line.startsWith('BODY,')) continue;
    const cells = csvLine(line);
    if (cells[0] === 'HEADER') header = cells.slice(1);
    else {
      if (!header || cells.length !== header.length + 1) throw new Error(`Malformed row: ${path}`);
      rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i + 1]])));
    }
  }
  if (!header) throw new Error(`Missing HEADER: ${path}`);
  return rows;
}
interface Board { date: string; id: string; name: string; stock: string; issue: string; contractMaturity: string; delist: string; conv: number; converted: number; putEnd: string; putPrice: number }
// Only the board available at time t may supply an early delist date.
const knownEnd = (r: Board) => r.delist && r.delist < r.contractMaturity ? r.delist : r.contractMaturity;
interface Bond { id: string; rows: Board[]; last: string; early: boolean }
interface Quote { date: string; close: number }
interface Observation { value: number; valueTr?: number; trBenchmarkEntry?: number; trBenchmarkExit?: number; year: string; bond: string; stock: string; start: string; end: string; stockEntry?: number; stockExit?: number; benchmarkEntry?: number; benchmarkExit?: number; cost?: number }
function stats(rows: Observation[]) {
  const a = rows.map(r => r.value), avg = mean(a);
  const sd = a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - avg!) ** 2, 0) / (a.length - 1)) : null;
  const perYear = Object.fromEntries([...new Set(rows.map(r => r.year))].sort().map(y => {
    const values = rows.filter(r => r.year === y).map(r => r.value);
    return [y, { n: values.length, mean: mean(values) }];
  }));
  const leaveOneYearOut = Object.fromEntries(Object.keys(perYear).map(y => [y, mean(rows.filter(r => r.year !== y).map(r => r.value))]));
  const robust = Object.values(perYear).filter(v => v.mean! > 0).length >= 2 && Object.values(leaveOneYearOut).every(v => v !== null && v > 0);
  return { n: a.length, mean: avg, meanTr: mean(rows.flatMap(r => r.valueTr === undefined ? [] : [r.valueTr])), median: quantile(a, .5), winRate: a.length ? a.filter(x => x > 0).length / a.length : null,
    tStat: sd && avg !== null ? avg / (sd / Math.sqrt(a.length)) : null, min: a.length ? Math.min(...a) : null, p10: quantile(a, .1),
    perYear, leaveOneYearOut, sampleStatus: a.length < 30 ? '樣本不足' : '足夠', notSingleYearDriven: robust,
    passesBar: a.length >= 30 && avg! > 0 && robust };
}
const skipped: Record<string, number> = {};
const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
function main() {
  console.log('載入月末 CB 看板與每日等價成交…');
  const boardFiles = readdirSync(`${ROOT}/board`).filter(f => /^\d{8}\.csv$/.test(f)).sort();
  const boardDates = boardFiles.map(fileDate), boards = new Map<string, Map<string, Board>>(), bonds = new Map<string, Bond>();
  for (const file of boardFiles) {
    const date = fileDate(file), map = new Map<string, Board>();
    for (const r of csvRows(`${ROOT}/board/${file}`)) {
      const issue = iso(r['轉換起日'] ?? ''), contractMaturity = iso(r['轉換迄日'] ?? ''), delist = iso(r['終止櫃檯買賣日'] ?? '');
      if (!issue || !contractMaturity || !/^\d{5,6}$/.test(r['債券代碼'])) { skip('invalidBoardRow'); continue; }
      const issued = num(r['原始發行總額']), balance = num(r['上月底發行餘額']);
      const row: Board = { date, id: r['債券代碼'], name: r['債券簡稱'], stock: r['債券代碼'].slice(0, 4), issue: addMonths(issue, -3), contractMaturity, delist,
        conv: num(r['轉換價格']), converted: positive(issued) && Number.isFinite(balance) ? 1 - balance / issued : NaN,
        putEnd: iso(r['最近賣回權迄日'] ?? ''), putPrice: num(r['最近賣回權價格']) };
      map.set(row.id, row);
      if (!bonds.has(row.id)) bonds.set(row.id, { id: row.id, rows: [], last: date, early: false });
      bonds.get(row.id)!.rows.push(row); bonds.get(row.id)!.last = date;
    }
    boards.set(date, map);
  }
  for (const b of bonds.values()) b.early = b.last < addMonths(b.rows.at(-1)!.contractMaturity, -1);
  const quoteFiles = readdirSync(`${ROOT}/quotes`).filter(f => /^\d{8}\.csv$/.test(f)).sort();
  const quoteFileDates = quoteFiles.map(fileDate), tradedDates = new Set<string>(), quotes = new Map<string, Quote[]>(), quoteMaps = new Map<string, Map<string, number>>();
  for (const file of quoteFiles) {
    const date = fileDate(file);
    for (const r of csvRows(`${ROOT}/quotes/${file}`)) {
      const id = r['代號'], close = num(r['收市']);
      if (!id || r['交易'] !== '等價' || !positive(close)) continue;
      tradedDates.add(date);
      if (!quotes.has(id)) { quotes.set(id, []); quoteMaps.set(id, new Map()); }
      quotes.get(id)!.push({ date, close }); quoteMaps.get(id)!.set(date, close);
    }
  }
  const cbCalendar = quoteFileDates.filter(d => tradedDates.has(d));
  console.log(`看板 ${boardFiles.length} 期、${bonds.size} 檔債；載入還原現股面板…`);
  const input = JSON.parse(readFileSync('data/backtest/expanded/expanded-input.json', 'utf8')).benchmarkTotalReturn;
  const raw = input.TaiwanStockPrice as { date: string; open: number; close: number }[];
  const calendar = raw.map(r => r.date).filter(d => d >= '2019-01-02' && d <= '2026-09-30').sort();
  const panel = createPanel(calendar), actionByKey = new Map<string, { reference: number; kind: string }>();
  for (const action of JSON.parse(readFileSync('data/backtest/wide/actions/twse-ex-references.json', 'utf8')).rows) {
    const key = `${action.date}/${action.code}`;
    if (actionByKey.has(key) && Math.abs(actionByKey.get(key)!.reference - action.reference) > 1e-8) throw new Error(`Conflicting references ${key}`);
    actionByKey.set(key, action);
  }
  const coverage: { date: string; twse: number; tpex: number }[] = [];
  for (let i = 0; i < calendar.length; i++) {
    const counts = { date: calendar[i], twse: 0, tpex: 0 };
    for (const source of ['twse', 'tpex'] as const) {
      const file = `data/backtest/wide/daily/${source}/${calendar[i]}.json.gz`;
      if (!existsSync(file)) continue;
      const cached = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
      if (cached.parserVersion !== 'all-ordinary-rows-v2' || cached.requestedDate !== calendar[i].replaceAll('-', '') || !cached.rows.length) throw new Error(`Invalid cache ${file}`);
      counts[source] = cached.rows.length;
      addDayQuotes(panel, i, cached.rows.map((q: any) => {
        const a = actionByKey.get(`${calendar[i]}/${q.code}`);
        return a ? { ...q, explicitReference: a.reference, changeLabel: a.kind } : q;
      }));
    }
    coverage.push(counts);
  }
  const calendarIndex = new Map(calendar.map((d, i) => [d, i]));
  if (calendar.some(d => !tradedDates.has(d))) throw new Error('Missing CB trading-date coverage within stock calendar');
  for (const [key, action] of actionByKey) {
    const [date, code] = key.split('/'), i = calendarIndex.get(date);
    if (i !== undefined) addReferenceEvent(panel, i, code, action.reference);
  }
  finalizePanel(panel);
  const trMap = new Map<string, number>(input.TaiwanStockTotalReturnIndex.map((r: any) => [r.date, r.price]));
  const priceMap = new Map(raw.map(r => [r.date, r]));
  const tr = calendar.map(d => trMap.get(d) ?? NaN);
  const trOpen = calendar.map((d, i) => { const r = priceMap.get(d)!; return r.open * tr[i] / r.close; });
  // Daily rebalanced whole-market EW; close and open use the identical eligible set.
  const ew = Array<number>(calendar.length).fill(NaN), ewOpen = Array<number>(calendar.length).fill(NaN);
  const ewCounts = Array<number>(calendar.length).fill(0);
  const winsorize = (r: number) => Math.max(-.11, Math.min(.11, r));
  ew[0] = 1;
  for (let i = 1; i < calendar.length; i++) {
    if (!coverage[i].twse || !coverage[i].tpex) throw new Error(`Incomplete EW market coverage ${calendar[i]}`);
    let closeSum = 0, openSum = 0;
    for (const s of panel.values()) {
      if (!s.seen[i] || !positive(s.adjustedClose[i - 1]) || !positive(s.adjustedClose[i]) ||
          s.segmentId[i] < 0 || s.segmentId[i] !== s.segmentId[i - 1]) continue;
      // Never silently change the open basket relative to the close basket.
      if (!positive(s.adjustedOpen[i])) throw new Error(`Missing EW eligible open ${s.code}/${calendar[i]}`);
      closeSum += winsorize(s.adjustedClose[i] / s.adjustedClose[i - 1] - 1);
      openSum += winsorize(s.adjustedOpen[i] / s.adjustedClose[i - 1] - 1);
      ewCounts[i]++;
    }
    if (!ewCounts[i]) throw new Error(`Empty EW basket ${calendar[i]}`);
    ew[i] = ew[i - 1] * (1 + closeSum / ewCounts[i]);
    ewOpen[i] = ew[i - 1] * (1 + openSum / ewCounts[i]);
  }
  const benchmarkSanity = { start: calendar[0], end: calendar.at(-1), ewStart: ew[0], ewEnd: ew.at(-1),
    ewTotalChange: ew.at(-1)! / ew[0] - 1, trTotalChange: tr.at(-1)! / tr[0] - 1,
    minEligible: Math.min(...ewCounts.slice(1)), maxEligible: Math.max(...ewCounts.slice(1)) };
  console.log('Benchmark sanity:', JSON.stringify(benchmarkSanity));
  const lower = (dates: string[], date: string) => { let l = 0, h = dates.length; while (l < h) { const m = (l + h) >>> 1; if (dates[m] < date) l = m + 1; else h = m; } return l; };
  // Latest global board strictly before t. Missing bonds are not carried indefinitely.
  const boardAt = (date: string) => boards.get(boardDates[lower(boardDates, date) - 1]);
  const pit = (id: string, date: string) => boardAt(date)?.get(id);
  const validRange = (s: StockPanel, from: number, to: number, open = false) => {
    if (from < 0 || to >= calendar.length || to <= from || s.segmentId[from] < 0 || s.segmentId[from] !== s.segmentId[to]) return false;
    if (!positive(open ? s.adjustedOpen[from] : s.adjustedClose[from]) || !positive(s.adjustedClose[to]) || !positive(s.close[from]) || !positive(s.close[to])) return false;
    for (let i = from; i <= to; i++) if (!coverage[i].twse || !coverage[i].tpex || s.segmentId[i] !== s.segmentId[from] || !positive(s.adjustedClose[i])) return false;
    return positive(ew[to]) && positive(open ? ewOpen[from] : ew[from]) && positive(tr[to]) && positive(open ? trOpen[from] : tr[from]);
  };
  const observation = (b: Bond, s: StockPanel, from: number, to: number, open: boolean, cost: number): Observation | null => {
    if (!validRange(s, from, to, open) || (open && (!s.seen[from] || !s.seen[to] || s.volume[from] <= 0 || s.volume[to] <= 0))) { skip('invalidReturnWindow'); return null; }
    return { value: (s.adjustedClose[to] / (open ? s.adjustedOpen[from] : s.adjustedClose[from]) - 1 - (ew[to] / (open ? ewOpen[from] : ew[from]) - 1) - cost) * 100,
      valueTr: (s.adjustedClose[to] / (open ? s.adjustedOpen[from] : s.adjustedClose[from]) - 1 - (tr[to] / (open ? trOpen[from] : tr[from]) - 1) - cost) * 100,
      year: calendar[from].slice(0, 4), bond: b.id, stock: s.code, start: calendar[from], end: calendar[to],
      stockEntry: open ? s.adjustedOpen[from] : s.adjustedClose[from], stockExit: s.adjustedClose[to], benchmarkEntry: open ? ewOpen[from] : ew[from], benchmarkExit: ew[to],
      trBenchmarkEntry: open ? trOpen[from] : tr[from], trBenchmarkExit: tr[to], cost };
  };
  const cohorts = [...bonds.values()].filter(b => b.rows[0].issue >= '2018-01-01');
  const q1Rows: Record<string, Observation[]> = Object.fromEntries(['1–3', '4–6', '7–12', '13–24', '25–36', '37–60', 'maturity−12…−1', 'other'].map(k => [k, []]));
  // Ex-post outcomes are descriptive only; unresolved bonds are not counted as matured.
  const q1MaturitySplit: Record<string, Observation[]> = { reachedContractMaturity: [], endedEarly: [], rightCensored: [] };
  const q1Months: Record<string, Observation[]> = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [String(i + 1), []]));
  const q2Rows: Record<string, Observation[]> = {};
  console.log(`現股 ${calendar[0]}～${calendar.at(-1)}；Q1/Q2 發行世代 ${cohorts.length} 檔…`);
  for (const b of cohorts) {
    const first = b.rows[0], last = b.rows.at(-1)!, s = panel.get(first.stock);
    if (!s) { skip('cohortNoStock'); continue; }
    const stop = [last.contractMaturity, b.last].sort()[0];
    for (let k = 1; k <= 60; k++) {
      const start = addMonths(first.issue, k - 1), end = addMonths(first.issue, k);
      if (start < calendar[0] || end > calendar.at(-1)! || end > stop) continue;
      const from = lower(calendar, start + 'Z') - 1, to = lower(calendar, end + 'Z') - 1;
      if (from < 0) continue;
      const obs = observation(b, s, from, to, false, 0); if (!obs) continue;
      const bucket = k <= 3 ? '1–3' : k <= 6 ? '4–6' : k <= 12 ? '7–12' : k <= 24 ? '13–24' : k <= 36 ? '25–36' : '37–60';
      q1Rows[bucket].push(obs); q1Months[k].push(obs);
      const preMaturity = start >= addMonths(last.contractMaturity, -12) && start < last.contractMaturity;
      q1Rows[preMaturity ? 'maturity−12…−1' : 'other'].push(obs);
      if (preMaturity) {
        const ended = b.last < boardDates.at(-1)!;
        const outcome = ended && b.early ? 'endedEarly' : ended && last.contractMaturity <= boardDates.at(-1)! ? 'reachedContractMaturity' : 'rightCensored';
        q1MaturitySplit[outcome].push(obs);
      }
    }
    const blindStart = addMonths(first.issue, 3), blindEnd = addMonths(first.issue, 6);
    if (blindStart < calendar[0] || blindEnd > calendar.at(-1)! || blindEnd > stop) { skip('blindWindowOutsideCoverage'); continue; }
    const from = lower(calendar, blindStart), to = lower(calendar, blindEnd + 'Z') - 1;
    if (!validRange(s, from, to)) { skip('blindInvalidStockWindow'); continue; }
    let max = -Infinity, crossed = false, missing = false;
    for (let i = from; i <= to; i++) {
      const r = pit(b.id, calendar[i]);
      if (!r || !positive(r.conv) || !positive(s.adjustmentFactor[i])) { missing = true; break; }
      if (!positive(s.close[i])) continue; // Forward-filled suspension prices are not new observed closes.
      max = Math.max(max, s.adjustedClose[i]);
      if (s.adjustedClose[i] >= r.conv * s.adjustmentFactor[i]) crossed = true;
    }
    if (missing) { skip('blindMissingPointInTimeBoard'); continue; }
    const gain = max / s.adjustedClose[from] - 1;
    for (const threshold of [.10, .15, .20]) {
      const label = gain < threshold && !crossed ? '落空' : '有動';
      for (const [a, z] of [[6, 12], [12, 24]]) {
        const start = addMonths(first.issue, a), plannedEnd = addMonths(first.issue, z), end = [plannedEnd, stop].sort()[0];
        const key = `${threshold * 100}%/${a}–${z}/${label}`; q2Rows[key] ??= [];
        if (start >= end || start < calendar[0] || end > calendar.at(-1)!) { skip('blindFollowupCensored'); continue; }
        const obs = observation(b, s, lower(calendar, start), lower(calendar, end + 'Z') - 1, false, COST);
        if (obs) q2Rows[key].push(obs);
      }
    }
  }
  interface Event { rule: string; bond: string; stock: string; date: string; index: number; board: Board }
  const events: Record<string, Event[]> = {}, cooldown = new Map<string, number>();
  function emit(rule: string, r: Board, i: number) {
    const key = `${rule}/${r.stock}`, previous = cooldown.get(key);
    if (previous !== undefined && i - previous < 60) return;
    cooldown.set(key, i); (events[rule] ??= []).push({ rule, bond: r.id, stock: r.stock, date: calendar[i], index: i, board: r });
  }
  const scopes = ['late', 'blind', 'cool', 'all'];
  const signals = ['A', 'B1.5', 'A∪B1.5', 'B2.0', 'A∪B2.0'];
  for (const scope of scopes) for (const sig of signals) events[`Q3/${scope}/${sig}`] = [];
  const variants = ['base', 'maturity18', 'noMA20', 'conv−25'];
  for (const v of variants) events[`Q4/${v}`] = [];
  const stage = (r: Board, d: string) => d < addMonths(r.issue, 3) ? 'lock' : d < addMonths(r.issue, 6) ? 'blind' : d < addMonths(r.issue, 12) ? 'cool' : r.contractMaturity <= addMonths(d, 12) ? 'preMaturity' : 'afterYear';
  const feature = (s: StockPanel, i: number) => {
    if (i < 20 || !s.seen[i] || !positive(s.close[i]) || s.volume[i] <= 0) return null;
    let sum = 0, max = -Infinity, vol = 0;
    for (let j = i - 20; j <= i; j++) {
      if (!positive(s.adjustedClose[j]) || s.segmentId[j] !== s.segmentId[i] || !coverage[j].twse || !coverage[j].tpex) return null;
      if (j >= i - 19) sum += s.adjustedClose[j];
      if (j < i) { max = Math.max(max, s.adjustedClose[j]); vol += s.volume[j]; }
    }
    return { ma: s.adjustedClose[i] > sum / 20, breakout: s.adjustedClose[i] > max, volume: vol > 0 ? s.volume[i] / (vol / 20) : 0 };
  };
  const conditionA = (r: Board | undefined, s: StockPanel, i: number, f: ReturnType<typeof feature>) => !!r && !!f && positive(r.conv) && f.ma && s.adjustedClose[i] > r.conv * s.adjustmentFactor[i];
  const conditionQ4 = (r: Board | undefined, s: StockPanel, i: number, f: ReturnType<typeof feature>, v: string) => {
    if (!r || !positive(r.conv) || !Number.isFinite(r.converted) || !positive(s.close[i]) || !positive(s.adjustmentFactor[i]) || !coverage[i].twse || !coverage[i].tpex) return false;
    const d = calendar[i], cb = quoteMaps.get(r.id)?.get(d) ?? NaN, vs = s.adjustedClose[i] / (r.conv * s.adjustmentFactor[i]) - 1;
    return (!r.putEnd || r.putEnd < d) && r.converted <= .30 && vs >= (v === 'conv−25' ? -.25 : -.15) && vs <= .05 &&
      r.contractMaturity > d && r.contractMaturity <= addMonths(d, v === 'maturity18' ? 18 : 12) && positive(cb) && cb <= 110 && (v === 'noMA20' || !!f && f.ma);
  };
  console.log('Q3/Q4 每日掃描與每股每規則 60 session 冷卻…');
  for (let i = 1; i < calendar.length; i++) {
    const active = boardAt(calendar[i]); if (!active) continue;
    const featureCache = new Map<string, ReturnType<typeof feature>>(), prevCache = new Map<string, ReturnType<typeof feature>>();
    for (const r of [...active.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (calendar[i] >= knownEnd(r) || calendar[i] < r.issue) continue;
      const s = panel.get(r.stock); if (!s) continue;
      if (!featureCache.has(s.code)) { featureCache.set(s.code, feature(s, i)); prevCache.set(s.code, feature(s, i - 1)); }
      const f = featureCache.get(s.code);
      const prev = pit(r.id, calendar[i - 1]), pf = prevCache.get(s.code);
      const a = conditionA(r, s, i, f) && !conditionA(prev, s, i - 1, pf);
      const b15 = !!f && f.breakout && f.volume >= 1.5, b20 = !!f && f.breakout && f.volume >= 2;
      const st = stage(r, calendar[i]);
      for (const scope of scopes) {
        if (scope !== 'all' && !(scope === 'late' ? st === 'preMaturity' || st === 'afterYear' : st === scope)) continue;
        for (const [sig, yes] of [['A', a], ['B1.5', b15], ['A∪B1.5', a || b15], ['B2.0', b20], ['A∪B2.0', a || b20]] as [string, boolean][]) if (yes) emit(`Q3/${scope}/${sig}`, r, i);
      }
      for (const v of variants) if (conditionQ4(r, s, i, f, v) && !conditionQ4(prev, s, i - 1, pf, v)) emit(`Q4/${v}`, r, i);
    }
  }
  const stockRows: Record<string, Observation[]> = {};
  for (const [rule, evs] of Object.entries(events)) for (const h of [20, 60]) {
    const key = `${rule}/${h}`; stockRows[key] = [];
    for (const e of evs) {
      const b = bonds.get(e.bond)!, s = panel.get(e.stock)!;
      const obs = observation(b, s, e.index + 1, e.index + h, true, COST);
      if (obs) stockRows[key].push(obs);
    }
  }
  interface CbResult { bond: string; stock: string; signal: string; entry: string; exit: string; entryPrice: number; exitPrice: number; value: number; drawdown?: number; staleSessions?: number }
  const cbHoldRows: Record<string, CbResult[]> = {}, cbasRows: Record<string, CbResult[]> = {};
  const cbEntry = (e: Event) => {
    const idx = lower(cbCalendar, e.date + 'Z'), map = quoteMaps.get(e.bond);
    for (let j = idx; j < Math.min(idx + 5, cbCalendar.length); j++) {
      const price = map?.get(cbCalendar[j]);
      if (price && cbCalendar[j] < knownEnd(e.board)) return { date: cbCalendar[j], close: price, index: j };
    }
    skip('cbNoEntryWithin5'); return null;
  };
  const cbRules = Object.keys(events).filter(k => k.startsWith('Q4/') || /^Q3\/.*\/A∪B/.test(k));
  for (const rule of cbRules) {
    if (rule.startsWith('Q4/')) cbHoldRows[rule] = [];
    for (const h of [20, 60]) cbasRows[`${rule}/${h}`] = [];
    for (const e of events[rule]) {
      const entry = cbEntry(e); if (!entry) continue;
      const b = bonds.get(e.bond)!, qs = quotes.get(e.bond)!;
      const pending = !!e.board.putEnd && e.board.putEnd >= e.date;
      const floorDate = pending ? e.board.putEnd : knownEnd(e.board);
      const floor = pending ? e.board.putPrice : 100;
      if (!positive(floor)) { skip('cbInvalidFloor'); continue; }
      const ended = b.last < boardDates.at(-1)!;
      const lastTrade = qs.at(-1)!;
      const earlyTradeEnd = ended && lastTrade.date < floorDate;
      if (rule.startsWith('Q4/')) {
        if (floorDate > cbCalendar.at(-1)! && !earlyTradeEnd) skip('cbHoldRightCensored');
        else {
          const endDate = lastTrade.date < floorDate ? lastTrade.date : floorDate;
          const held = qs.filter(q => q.date >= entry.date && q.date <= endDate);
          if (!held.length || endDate < entry.date) skip('cbHoldNoExit');
          else {
            // A valid last traded close takes priority over par; do not force maturity quotes to 100.
            const exitPrice = held.at(-1)?.close ?? (!pending && floorDate <= cbCalendar.at(-1)! ? 100 : NaN);
            let peak = entry.close, dd = 0;
            for (const q of [...held, { date: endDate, close: exitPrice }]) { peak = Math.max(peak, q.close); dd = Math.min(dd, q.close / peak - 1); }
            cbHoldRows[rule].push({ bond: e.bond, stock: e.stock, signal: e.date, entry: entry.date, exit: endDate, entryPrice: entry.close, exitPrice,
              value: (exitPrice / entry.close - 1) * 100, drawdown: dd * 100 });
          }
        }
      }
      const premium = entry.close - floor / 1.02 ** yearsTo(entry.date, floorDate);
      if (premium < 1) { skip('cbasPremiumBelow1'); continue; }
      for (const h of [20, 60]) {
        const exitIndex = entry.index + h - 1;
        if (exitIndex >= cbCalendar.length) { skip('cbasRightCensored'); continue; }
        const target = cbCalendar[exitIndex];
        // Fixed horizon experiment: exclude bonds which mature/disappear before the horizon.
        if (target > floorDate || (ended && target > lastTrade.date)) { skip('cbasEndedBeforeHorizon'); continue; }
        const held = qs.filter(q => q.date >= entry.date && q.date <= target), exit = held.at(-1);
        if (!exit) { skip('cbasNoExit'); continue; }
        const exitPremium = Math.max(0, exit.close - floor / 1.02 ** yearsTo(target, floorDate));
        cbasRows[`${rule}/${h}`].push({ bond: e.bond, stock: e.stock, signal: e.date, entry: entry.date, exit: target, entryPrice: premium, exitPrice: exitPremium,
          value: (exitPremium / premium - 1) * 100, staleSessions: exitIndex - lower(cbCalendar, exit.date) });
      }
    }
  }
  const summarizeCb = (rows: CbResult[]) => ({ ...stats(rows.map(r => ({ value: r.value, year: r.entry.slice(0, 4), bond: r.bond, stock: r.stock, start: r.entry, end: r.exit }))),
    grossNumericBar: stats(rows.map(r => ({ value: r.value, year: r.entry.slice(0, 4), bond: r.bond, stock: r.stock, start: r.entry, end: r.exit }))).passesBar,
    passesBar: null, // CB returns are uncosted simulations, not the plan's net-excess trading test.
    lossShare: rows.length ? rows.filter(r => r.value < 0).length / rows.length : null,
    meanMaxDrawdown: mean(rows.map(r => r.drawdown).filter((x): x is number => x !== undefined)), worstMaxDrawdown: rows.some(r => r.drawdown !== undefined) ? Math.min(...rows.map(r => r.drawdown!)) : null,
    staleExits: rows.filter(r => (r.staleSessions ?? 0) > 0).length, maxStaleSessions: rows.length ? Math.max(...rows.map(r => r.staleSessions ?? 0)) : null });
  const result = {
    date: '2026-10-13', units: 'returns/means/median/drawdown in percentage points; winRate/lossShare in fractions',
    specification: { cost: COST, cooldownSessions: 60, boardStrictlyBeforeSignal: true, benchmark: 'daily-rebalanced whole-market equal-weight adjusted-price index', secondaryBenchmark: 'TaiwanStockTotalReturnIndex', dailyWinsorization: [-.11, .11], cbasRate: .02,
      contractMaturity: '轉換迄日; used for Q1 labels, stages and Q4 maturity windows', delist: '終止櫃檯買賣日; point-in-time earlier end for CB floor and tradability', earlyDelisted: 'last board appearance < contractMaturity minus one calendar month; must have left final board', q1MaturitySplit: 'ex-post only; reached = ended, not early, contract maturity within board coverage; unresolved = right censored',
      yearRobustness: 'at least two positive calendar-year means AND every leave-one-year-out pooled mean positive', cohortCost: COST, monthlyCost: 0 },
    coverage: { boardFiles: boardFiles.length, boardStart: boardDates[0], boardEnd: boardDates.at(-1), quoteFiles: quoteFiles.length, quoteStart: cbCalendar[0], quoteEnd: cbCalendar.at(-1), cbSessions: cbCalendar.length, nonTradingQuoteFiles: quoteFileDates.filter(d => !tradedDates.has(d)),
      stockStart: calendar[0], stockEnd: calendar.at(-1), sessions: calendar.length, bonds: bonds.size, cohorts: cohorts.length,
      endedBonds: [...bonds.values()].filter(b => b.last < boardDates.at(-1)!).length,
      earlyDelistedObserved: [...bonds.values()].filter(b => b.early && b.last < boardDates.at(-1)!).length,
      missingMarketDays: coverage.filter(r => !r.twse || !r.tpex), unresolvedStockAdjustments: [...panel.values()].reduce((n, s) => n + s.unresolvedAdjustmentIndices.length, 0) },
    benchmarkSanity, skipped, q1: Object.fromEntries(Object.entries(q1Rows).map(([k, v]) => [k, { ...stats(v), passesBar: null }])),
    q1MaturitySplit: Object.fromEntries(Object.entries(q1MaturitySplit).map(([k, v]) => [k, { ...stats(v), passesBar: null }])),
    q1Monthly: Object.fromEntries(Object.entries(q1Months).map(([k, v]) => [k, { ...stats(v), passesBar: null }])),
    q2: Object.fromEntries(Object.entries(q2Rows).map(([k, v]) => [k, stats(v)])),
    stock: Object.fromEntries(Object.entries(stockRows).map(([k, v]) => [k, stats(v)])),
    cbHold: Object.fromEntries(Object.entries(cbHoldRows).map(([k, v]) => [k, summarizeCb(v)])),
    cbas: Object.fromEntries(Object.entries(cbasRows).map(([k, v]) => [k, summarizeCb(v)])),
    eventCounts: Object.fromEntries(Object.entries(events).map(([k, v]) => [k, v.length])),
  };
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(`${ROOT}/results.json`, JSON.stringify(result, null, 2) + '\n');
  writeFileSync(`${ROOT}/observations.json`, JSON.stringify({ q1Rows, q1MaturitySplit, q1Months, q2Rows, stockRows, events, cbHoldRows, cbasRows }) + '\n');
  renderDoc(result);
  console.log(JSON.stringify({ coverage: { bonds: result.coverage.bonds, cohorts: result.coverage.cohorts, sessions: result.coverage.sessions, missingMarketDays: result.coverage.missingMarketDays.length }, Q1: result.q1, Q1MaturitySplit: result.q1MaturitySplit, Q2base: Object.fromEntries(Object.entries(result.q2).filter(([k]) => k.startsWith('10%'))),
    Q3lateUnion: [result.stock['Q3/late/A∪B1.5/20'], result.stock['Q3/late/A∪B1.5/60']], Q4base: [result.stock['Q4/base/20'], result.stock['Q4/base/60']],
    CBhold: result.cbHold['Q4/base'], CBAS: result.cbas['Q4/base/60'], skipped }, (_k, v) => v && typeof v === 'object' && 'perYear' in v ? { n: v.n, mean: v.mean, passesBar: v.passesBar } : v, 2));
}

interface DocResults { benchmarkSanity: any; coverage: any; stock: Record<string, any>; q1: Record<string, any>; q1MaturitySplit: Record<string, any>; q2: Record<string, any>; cbHold: Record<string, any>; cbas: Record<string, any>; skipped: Record<string, number> }
function renderDoc(r: DocResults) {
  const f = (v: number | null | undefined, digits = 2) => v === null || v === undefined ? '—' : v.toFixed(digits);
  const pp = (v: number | null | undefined) => v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}pp`;
  const pct = (v: number | null | undefined) => v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
  const status = (s: any) => s.n < 30 ? '樣本不足' : s.passesBar === null ? '未驗淨值' : s.passesBar ? '通過' : '未通過';
  const table = (headers: string[], rows: (string | number)[][]) => '\n| ' + headers.join(' | ') + ' |\n| ' + headers.map((_, i) => i ? '---:' : '---').join(' | ') + ' |\n' + rows.map(row => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n';
  const stockTable = (entries: [string, any][]) => table(['組別／日數', 'n', 'EW 淨超額均值', 'TR 淨超額均值', 'EW 勝率', 'EW t／判定'], entries.map(([k, s]) => [k, s.n, pp(s.mean), pp(s.meanTr), pct(s.winRate), `${f(s.tStat)}／${status(s)}`]));
  const yearly = (entries: [string, any][]) => {
    const years = [...new Set(entries.flatMap(([, s]) => Object.keys(s.perYear)))].sort();
    let tables = '';
    for (let i = 0; i < years.length; i += 4) {
      const chunk = years.slice(i, i + 4);
      tables += table(['組別（均值／n）', ...chunk], entries.map(([k, s]) => [k, ...chunk.map(y => s.perYear[y] ? `${pp(s.perYear[y].mean)}／${s.perYear[y].n}` : '—')]));
    }
    return tables;
  };
  const late20 = r.stock['Q3/late/A∪B1.5/20'], late60 = r.stock['Q3/late/A∪B1.5/60'];
  const base20 = r.stock['Q4/base/20'], base60 = r.stock['Q4/base/60'];
  const blank612 = r.q2['10%/6–12/落空'], moved612 = r.q2['10%/6–12/有動'];
  const blank1224 = r.q2['10%/12–24/落空'], moved1224 = r.q2['10%/12–24/有動'];
  const hold = r.cbHold['Q4/base'], cbas60 = r.cbas['Q4/base/60'];
  const maturity = r.q1['maturity−12…−1'], other = r.q1.other;
  const reached = r.q1MaturitySplit.reachedContractMaturity, early = r.q1MaturitySplit.endedEarly, censored = r.q1MaturitySplit.rightCensored;
  const passing = Object.entries({ ...r.q2, ...r.stock }).filter(([, s]) => s.passesBar).map(([k]) => k);
  const q2Support = blank612?.n >= 30 && moved612?.n >= 30 && blank1224?.n >= 30 && moved1224?.n >= 30 && blank612.mean < moved612.mean && blank1224.mean < moved1224.mean;
  let doc = `# CB 時間軸規則回測（2026-10-13）\n\n問題：\n\n1. 發行一年後、到期前一年，是否存在較高的現股月超額？\n2. 3–6 個月盲盒落空後，6–12／12–24 個月是否較弱？\n3. 一年後啟動的時間階段，是否比同樣訊號的早期／全階段控制組更有資訊？\n4. 公司起手勢的現股、持債到保底日與 CBAS，是否有正期望值及有限下檔？\n\n`;
  const allNeg = (s: any) => { const ys = Object.values(s?.perYear ?? {}) as any[]; return ys.length > 0 && ys.every(y => y.mean < 0); };
  const all20 = r.stock['Q3/all/A∪B1.5/20'], all60 = r.stock['Q3/all/A∪B1.5/60'];
  const d20 = late20.mean - all20.mean, d60 = late60.mean - all60.mean;
  const stageNote = d20 <= 0.5 && d60 <= 0.5 ? '階段沒有增加資訊（late−all 差為負或很小）' : 'late 高於 all 控制組，但仍未通過門檻，不能直接視為階段本身有效';
  const blankYears = allNeg(blank612) && allNeg(blank1224) ? '落空組在每個年度皆為負' : allNeg(blank612) ? '6–12 個月落空組在每個年度皆為負，12–24 個月則非每年皆負' : allNeg(blank1224) ? '12–24 個月落空組在每個年度皆為負，6–12 個月則非每年皆負' : '落空組並非每個年度皆為負';
  doc += `## 結論\n\n**總結：文章的兩條規律都沒有通過回測；唯一穩定的是「盲盒落空」，而且方向是負的（風險提示，不是買點）。**\n\n`
    + `- **Q1 時間窗口：** 契約到期前一年 EW 月超額 ${pp(maturity.mean)}（t ${f(maturity.tStat)}），其他月份 ${pp(other.mean)}；${maturity.mean <= 0 || Math.abs(maturity.tStat) < 2 ? '沒有到期前一年效應（超額不為正或不顯著）' : '到期前一年有正超額，但僅為描述、不是可交易規則'}。舊版用強贖下櫃日當到期日造成前視，修正後效應消失。\n`
    + `- **Q2 盲盒落空（10%）：** 6–12 個月 落空 ${pp(blank612.mean)}（n=${blank612.n}、t ${f(blank612.tStat)}）vs 有動 ${pp(moved612.mean)}；12–24 個月 落空 ${pp(blank1224.mean)}（n=${blank1224.n}、t ${f(blank1224.tStat)}）vs 有動 ${pp(moved1224.mean)}；${blankYears}。\n`
    + `- **Q3 一年後啟動（A∪B 1.5 倍量）：** late 20／60 日 ${pp(late20.mean)}／${pp(late60.mean)}，all 控制組 ${pp(all20.mean)}／${pp(all60.mean)}，判定 ${status(late20)}／${status(late60)}；${stageNote}。\n`
    + `- **Q4 公司起手勢：** 現股 20／60 日 ${pp(base20.mean)}（n=${base20.n}）／${pp(base60.mean)}（n=${base60.n}）；持 CB 到保底：n=${hold.n}、平均 ${pp(hold.mean)}、中位 ${pp(hold.median)}、虧損占比 ${pct(hold.lossShare)}、最差 ${pp(hold.min)}；CBAS 60 日 平均 ${pp(cbas60.mean)} vs 中位 ${pp(cbas60.median)}${cbas60.mean > cbas60.median ? '（平均高於中位，彩券型分布）' : ''}。CB／CBAS 報酬未扣成本、未扣大盤，未驗證計畫的「淨超額」門檻。\n`
    + `- **判定標準：** n≥30、扣成本淨超額>0、至少兩年為正且刪任一年仍為正。\n\n`;
  doc += `## 規格\n\n- 資料全部本機讀取、無網路。TPEx 月末看板 ${r.coverage.boardStart}～${r.coverage.boardEnd}，${r.coverage.boardFiles} 期、歷史聯集 ${r.coverage.bonds} 檔（已離開看板 ${r.coverage.endedBonds} 檔；可觀察提前下櫃 ${r.coverage.earlyDelistedObserved} 檔）。依 HEADER 名稱解析，不依欄位位置。每日 CB 等價成交 ${r.coverage.quoteStart}～${r.coverage.quoteEnd}，${r.coverage.quoteFiles} 期；議價與空收市全部忽略。行情檔含 ${r.coverage.nonTradingQuoteFiles.length} 個全市場皆無等價成交的非交易日（農曆年前結算日）；從 CB session 日曆剔除，不拿來計算 5／20／60 日。\n- 現股面板 ${r.coverage.stockStart}～${r.coverage.stockEnd}，${r.coverage.sessions} sessions。完全沿用 wide-market 的 createPanel／addDayQuotes／addReferenceEvent／finalizePanel 與官方除權參考；報酬用 adjustedOpen／adjustedClose。跨未解決公司行動的 segment 排除；收盤與轉換價比較時，轉換價乘當日同一 adjustmentFactor，與未還原價比較等價。\n- Q1–Q4 現股的主要基準為同面板全市場等權 EW，避免台積電等大型股主導的市值加權 TAIEX TR 將中小型 CB 發行人的超額系統性壓低。每個 session i≥1，當日 TWSE／TPEx 均有覆蓋，納入前後 adjustedClose>0、segmentId 相同且 s.seen[i] 的全部股票；各股收盤日報酬截至 −11%～+11% 後取平均（台股一般日限幅 10%，額外 1pp 防壞資料），EW[0]=1，逐日複利。EWopen[i]＝EW[i−1]×(1+同一股票集合 adjustedOpen[i]／adjustedClose[i−1]−1 截尾後的均值)；缺市場覆蓋、空集合或合格股無正開盤價則中止，避免換籃子。淨超額＝還原現股報酬−同窗 EW 報酬−0.585pp；Q2 同樣扣一趟，Q1 月超額不扣。TaiwanStockTotalReturnIndex 保留為同事件的敏感度欄，TR 開盤仍為 TAIEX open×TR／close；勝率、t、年度表、門檻與結論均用 EW。\n- 基準健全性：${r.benchmarkSanity.start}～${r.benchmarkSanity.end}，EW 由 1 至 ${f(r.benchmarkSanity.ewEnd, 4)}（${pct(r.benchmarkSanity.ewTotalChange)}），TAIEX TR ${pct(r.benchmarkSanity.trTotalChange)}；每日合格股 ${r.benchmarkSanity.minEligible}～${r.benchmarkSanity.maxEligible} 檔。\n- 發行日估為轉換起日減 3 **曆月**（月底日期夾至目標月最後一天）；contractMaturity 固定取轉換迄日（契約到期），delist 另取可空白的終止櫃檯買賣日。舊版將 delist 優先當成到期，會用強贖後才知道的提早下櫃日回推 Q1 的漲勢月份，並使階段隨強贖通知切換，已修正。Q1 標記、所有階段與 Q4 的 12／18 月窗口一律用 contractMaturity。最後看板出現早於契約到期減 1 曆月視為提前下櫃；最後一期仍存在的債不當作已下櫃。Q1/Q2 僅估計發行日≥2018-01-01 的 ${r.coverage.cohorts} 檔。\n- 訊號日 t 僅取**全市場最新且日期嚴格小於 t 的看板**；該期未出現的債不繼續沿用舊資料。轉換價、餘額／原額、賣回日價、發行與契約到期階段皆按當期欄位；delist 僅使用當期已揭露值。已知賣回迄日≥t 才是 pending；空白視為無賣回權。餘額是看板揭露的上月底餘額。\n- 階段先匹配：<3 月閉鎖、3–<6 月盲盒、6–<12 月冷卻，再判距契約到期≤12 月，否則滿一年後。過契約到期或當期已知的較早 delist 不產生訊號。A 是股價>含今日 MA20 且>轉換價的布林值由假轉真；階段不納入 A 的前日判斷。B 是高於前 20 個**收盤**，量≥前 20 日均量的 1.5／2.0 倍。\n- Q3/Q4 訊號隔一個共同市場 session 開盤進場，進場算第 1 日，第 20／60 日收盤出場。不完整窗口排除。每股每個規則分開冷卻 60 sessions，跨債同日只算一件，依債券代碼排序取第一檔；不同規則可重疊。冷卻以訊號日開始，含後來無法計算報酬的訊號。\n- Q1 使用發行曆月週年界點當日或之前的相鄰收盤（兩端連續，避免漏算跨月跳空），完整月份才納入，到 min(contractMaturity、最後看板出現) 停止；按月份起點所屬年度分組。Q2 盲盒窗口兩端含，起點為首個收盤；整段要有還原價和當時看板。落空＝最大還原收盤／首收盤−1<門檻，且無任日收盤≥當時轉換價；其餘為有動。後續由 issue+6／12 月首個交易日收盤到 issue+12／24 月當日或之前收盤，截於最後出現／契約到期，未完成且未下櫃者排除。\n- Q4 為整組條件由假轉真（含當日 CB 有成交）：賣回過或無、convertedPct≤30%、現股相對轉換價 −15%～+5%、契約到期≤12 月、CB≤110、現股>MA20。放寬版本每次只改一條：18 月、不要求 MA20、下界 −25%。無法取得完整條件的前日視為假，包含前日 CB 未成交；不要求 MA20 的版本也不要求 20 日暖機。\n- CB 隔日開始 5 個市場 sessions 內找首個成交**收盤**進場，不用開盤或看板參考價。floorDate 取訊號日已知 pending 賣回迄日；無 pending 時取當期已揭露且早於契約到期的 delist，否則 contractMaturity；持至 floorDate；若債已結束則截於更早的最後成交，按日成交收盤算最大回撤。出場用該日或之前最後成交價；實際到期且完全無可用成交才以 100 替代，不把所有到期出場強制算面額。未完成持債樣本排除。\n- CBAS entry＝成交價−floor／1.02^剩餘年數（365.25 日／年）；floor＝pending 賣回價，否則 100。entry premium<1 排除。由 CB 進場算 20／60 個 CB 市場 sessions，exit＝max(0, 最後可得 CB 價−exit 日折現 floor)，報酬 exit／entry−1，**不另扣費用**。若債在固定持有期內到期／結束則排除，最後成交可為舊價，stale 次數留於 JSON。Q3 各階段 A∪B 也做同樣模擬。\n- t 為未聚類的平均／樣本標準誤；年度表以「均值／n」表示，僅描述，不從年度低樣本下結論；全期 n<30 均標「樣本不足」且不下結論。年度按現股／CB 進場年；JSON 含每組年度 n、均值、刪年檢查、完整第 1–60 月與排除原因，observations.json 可逐事件稽核。\n- 腳本：\`scripts/backtest-cb-time-axis.ts\`；執行 \`npx tsx scripts/backtest-cb-time-axis.ts\`，重建 \`data/backtest/cb-time-axis/results.json\`、\`observations.json\` 與本文件。\n\n`;
  doc += '## 結果：Q1 事件月份\n\n這是描述性現股月超額，沒有交易成本；重複債券與重疊月份仍各計一個 bond-month。不能單靠月超額>0 通過交易規則門檻。\n';
  doc += table(['發行月份／時段', 'bond-months', 'EW 月超額', 'EW 中位', 'TR 月超額', 'EW t'], Object.entries(r.q1).map(([k, s]: [string, any]) => [s.n < 30 ? `${k}（樣本不足）` : k, s.n, pp(s.mean), pp(s.median), pp(s.meanTr), f(s.tStat)]));
  doc += `EW 契約到期前一年（maturity−12…−1）${pp(maturity.mean)} vs other ${pp(other.mean)}，均值差 ${pp(maturity.mean - other.mean)}；描述性非配對比較，不代表因果或可交易門檻通過。\n\n`;
  doc += '### 契約到期前一年：事後（ex-post）存續分組\n\n僅拆分上述 maturity−12…−1 bucket，不參與訊號或交易規則。到期組為已離開看板、最後出現不早於契約到期減 1 曆月，且契約到期已在看板覆蓋內（按月觀察的到期代理，不是實際兌付證明）；提前結束組為已離開看板且最後出現早於契約到期減 1 曆月；其餘為觀察未完成。分組是事後資訊，不能在進場時選股。\n';
  const splitLabels: Record<string, string> = { reachedContractMaturity: '到達契約到期（ex-post，月末代理）', endedEarly: '提前結束（ex-post）', rightCensored: '觀察未完成（ex-post）' };
  doc += table(['事後組別', 'bond-months', 'EW 均值', 'EW 中位', 'TR 均值', 'EW t'], Object.entries(r.q1MaturitySplit).map(([k, s]) => [splitLabels[k], s.n, pp(s.mean), pp(s.median), pp(s.meanTr), f(s.tStat)]));
  doc += yearly(Object.entries(r.q1));
  doc += '## 結果：Q2 盲盒落空\n\n完整盲盒窗口後的收盤到收盤淨超額；門檻敏感度三種均列，不以表現最好者代替預設 10%。有動包括「漲幅過門檻」或「站上轉換價」。\n';
  doc += stockTable(Object.entries(r.q2));
  doc += table(['門檻', '後續月份', '落空−有動均值', '落空 n', '有動 n'], [10, 15, 20].flatMap(t => ['6–12', '12–24'].map(w => {
    const a = r.q2[`${t}%/${w}/落空`], b = r.q2[`${t}%/${w}/有動`];
    return [`${t}%`, w, a?.mean !== null && b?.mean !== null ? pp(a.mean - b.mean) : '—', a?.n ?? 0, b?.n ?? 0];
  })));
  doc += yearly(Object.entries(r.q2));
  doc += '## 結果：Q3 一年後啟動與階段控制\n\nlate＝滿一年後或到期前一年；blind＝盲盒；cool＝冷卻；all＝全部階段。下表同時檢查訊號與階段，避免把一般突破效果歸因於發行時間。兩種量門檻的聯集皆呈現。\n';
  for (const scope of ['late', 'blind', 'cool', 'all']) {
    doc += `### ${scope}\n` + stockTable(Object.entries(r.stock).filter(([k]) => k.startsWith(`Q3/${scope}/`)));
  }
  doc += table(['訊號／日數', 'late−all', 'late−blind', 'late−cool', '說明'], ['A', 'B1.5', 'A∪B1.5', 'B2.0', 'A∪B2.0'].flatMap(sig => [20, 60].map(h => {
    const a = r.stock[`Q3/late/${sig}/${h}`];
    return [`${sig}/${h}`, ...['all', 'blind', 'cool'].map(sc => pp(a.mean - r.stock[`Q3/${sc}/${sig}/${h}`].mean)), '均值差，非配對檢定'];
  })));
  doc += yearly(Object.entries(r.stock).filter(([k]) => k.startsWith('Q3/')));
  doc += '## 結果：Q4 公司起手勢\n\nbase 為原版；其他均為逐一放寬。低樣本不據此下結論，也不因放寬後變正就修改原版規則。\n';
  doc += stockTable(Object.entries(r.stock).filter(([k]) => k.startsWith('Q4/')));
  doc += yearly(Object.entries(r.stock).filter(([k]) => k.startsWith('Q4/')));
  doc += '### 買 CB 持有到保底日\n\n報酬不扣 CB 成本；同一事件的價格路徑只用有成交的等價收盤。不是把未成交日視為可成交價格。\n';
  doc += table(['組別', 'n', '均值／中位', '最差／p10', '虧損占比', '判定'], Object.entries(r.cbHold).map(([k, s]: [string, any]) => [k, s.n, `${pp(s.mean)}／${pp(s.median)}`, `${pp(s.min)}／${pp(s.p10)}`, pct(s.lossShare), status(s)]));
  doc += table(['組別', 'n', '平均最大回撤', '最差最大回撤'], Object.entries(r.cbHold).map(([k, s]: [string, any]) => [k, s.n, pp(s.meanMaxDrawdown), pp(s.worstMaxDrawdown)]));
  doc += yearly(Object.entries(r.cbHold));
  doc += '### CBAS：固定 2% 折現、零額外成本\n\n這是拆解溢價的價格模擬，不是可成交 CBAS 契約的實際損益；槓桿與溢價低基數可放大正負報酬。\n';
  doc += table(['組別／日數', 'n', '均值', '中位數', '勝率', '最差／樣本'], Object.entries(r.cbas).map(([k, s]: [string, any]) => [k, s.n, pp(s.mean), pp(s.median), pct(s.winRate), `${pp(s.min)}／${s.sampleStatus}`]));
  doc += `原版 60 日 CBAS：平均 ${pp(cbas60.mean)}，中位 ${pp(cbas60.median)}，最差 ${pp(cbas60.min)}，${cbas60.staleExits}/${cbas60.n} 件出場用了舊成交價（最長 ${cbas60.maxStaleSessions} sessions）。平均為正不代表高勝率或可實際交易。\n\n`;
  doc += yearly(Object.entries(r.cbas));
  doc += '## 限制與判斷\n\n- 月末看板不能還原月中轉換價重設的精確生效日，轉換價、強贖下櫃公告與已消失債的資料都有至多約一月的觀察落差；訊號嚴格用前一期，但這不是逐日真正有效條款資料。契約到期日固定，不再以事後強贖下櫃日回推到期前一年。Q1/Q2 的最後出現終點及 Q1 到期／提前結束分組是事後描述性標記，沒有用來選 Q3/Q4 訊號。\n- 發行日是估計；最後出現不是精確實際下櫃日。聯集納入已消失債降低倖存者偏誤，但月間短暫存在、完全未出現在任何看板的債仍不可觀察。資料尾端早消失也可能只是不完整觀察。\n- 現股自 2019 年起，因此 2018 發行世代早期月份可能缺失；完整盲盒要求排除了缺少同期看板的樣本。按月／年度完整案例仍可能有存續與可交易性偏誤。現股有無法還原的除權事件則切段排除；面板為參考價還原，並非逐筆實領股息帳本。\n- 事件可能來自同一公司、多檔債、同年行情與重疊持有期。60-session 冷卻只降低同規則現股重複，無法讓所有 bond-month 與各組事件獨立。t 未做公司／日期聚類，多重門檻和控制比較也未校正，應視為探索結果。階段均值差未控制發行人／行情／轉換狀態，不能解讀成因果。\n- 持 CB 報酬未納入強贖、違約回收、補償金、應計利息、CB 費用或最後一筆以後的實際現金結算；最後成交價代替回收款。最大回撤漏掉無成交期間波動，沒有流動性或保底兌付保證。未完成持債事件排除可能造成完成樣本偏差。\n- CBAS 固定年率 2%，**未加信用利差**，亦沒有拆解費、融資、契約期限條款、可成交買賣價差；CB 以次日或五日內收盤進場。出場允許前次成交舊價，可能高估流動性。CBAS 固定持有期內提早結束的事件排除，不等於提前結算收益。Q4 禁止 pending put，因此原版保底日採訊號日已知的較早 delist，否則契約到期；pending 分支主要供 Q3 CBAS 使用。\n\n';
  doc += table(['排除／資料問題', '次數'], Object.entries(r.skipped));
  doc += '排除計數為各窗口／門檻／規則的處理次數，不是互斥的債券數；不能將各列相加當作母體。完整事件與年度數值以 results.json／observations.json 為準。\n';
  writeFileSync('docs/cb-time-axis-backtest.md', doc);
}
main();
