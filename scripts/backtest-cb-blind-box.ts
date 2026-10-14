/** Offline CB / CBAS blind-box backtest. Run: npx tsx scripts/backtest-cb-blind-box.ts */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createPanel, addDayQuotes, addReferenceEvent, finalizePanel, type StockPanel } from './lib/wide-market-panel.ts';

const ROOT = 'data/backtest/cb-time-axis';
const COST = .003;
const OUT = 'data/backtest/cb-blind-box';
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
interface Bond { id: string; rows: Board[]; last: string; early: boolean }
interface Quote { date: string; close: number }
const exclusions: Record<string, Record<string, number>> = {};
function skip(scope: string, reason?: string) {
  if (!reason) { reason = scope; scope = 'data'; }
  const counts = exclusions[scope] ??= {};
  counts[reason] = (counts[reason] ?? 0) + 1;
}
function main() {
  const started = performance.now();
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
  const validRange = (s: StockPanel, from: number, to: number) => {
    if (from < 0 || to >= calendar.length || to < from || s.segmentId[from] < 0 ||
        !positive(s.close[from]) || !positive(s.close[to])) return false;
    for (let i = from; i <= to; i++) if (!coverage[i].twse || !coverage[i].tpex ||
      s.segmentId[i] !== s.segmentId[from] || !positive(s.adjustedClose[i])) return false;
    return positive(ew[from]) && positive(ew[to]);
  };
  const strategies = { S1: '3→6', S2: '3→6, 有動續抱到12', S3: '3→6 停利120', S4: '3→6 停利130' };
  const reasons = ['issueBefore2018', 'leftOutsideCoverage', 'rightCensored', 'noStock', 'invalidLabelWindow', 'missingLabelBoard', 'noEntry', 'entryAtTakeProfit', 'noExit', 'exitBeforeEntry', 'invalidContextWindow'];
  for (const scope of ['common', ...Object.keys(strategies)]) exclusions[scope] = Object.fromEntries(reasons.map(r => [r, 0]));
  for (const scope of ['S1/CBAS', 'S2/CBAS']) exclusions[scope] = { missingEntryBoard: 0, invalidFloor: 0, premiumBelow1: 0 };
  const observations: EventObservation[] = [];
  // D itself counts as session 1. Never substitute a stale quote for a live bond.
  const resolve = (qs: Quote[], target: string, early: boolean) => {
    const last = qs.at(-1);
    if (early && last && last.date < target) return { ...last, endedEarly: true };
    const start = lower(cbCalendar, target), end = cbCalendar[Math.min(start + 4, cbCalendar.length - 1)];
    const q = qs.find(q => q.date >= target && q.date <= end);
    return q ? { ...q, endedEarly: false } : null;
  };
  console.log('計算 S1–S4、進場價分組及 CBAS…');
  for (const b of bonds.values()) {
    const first = b.rows[0], issue = first.issue, start = addMonths(issue, 3), six = addMonths(issue, 6);
    if (issue < '2018-01-01') { skip('common', 'issueBefore2018'); continue; }
    if (start < calendar[0] || start < cbCalendar[0]) { skip('common', 'leftOutsideCoverage'); continue; }
    if (six > calendar.at(-1)! || six > cbCalendar.at(-1)!) { skip('common', 'rightCensored'); continue; }
    const s = panel.get(first.stock);
    if (!s) { skip('common', 'noStock'); continue; }
    const from = lower(calendar, start), to = lower(calendar, six + 'Z') - 1;
    if (!validRange(s, from, to)) { skip('common', 'invalidLabelWindow'); continue; }
    let max = -Infinity, crossed = false, missing = false;
    for (let i = from; i <= to; i++) {
      const r = pit(b.id, calendar[i]);
      if (!r || !positive(r.conv) || !positive(s.adjustmentFactor[i])) { missing = true; break; }
      if (!positive(s.close[i])) continue;
      max = Math.max(max, s.adjustedClose[i]);
      if (s.adjustedClose[i] >= r.conv * s.adjustmentFactor[i]) crossed = true;
    }
    if (missing) { skip('common', 'missingLabelBoard'); continue; }
    const labelMaxGain = max / s.adjustedClose[from] - 1;
    const label = labelMaxGain < .10 && !crossed ? '落空' : '有動';
    const qs = quotes.get(b.id) ?? [], entry = resolve(qs, start, false);
    if (!entry) { skip('common', 'noEntry'); continue; }
    const entryBoard = pit(b.id, entry.date);
    for (const strategy of Object.keys(strategies)) {
      const target = strategy === 'S2' && label === '有動' ? addMonths(issue, 12) : six;
      // Full intended window required even for an early profit-taking observation.
      if (target > calendar.at(-1)! || target > cbCalendar.at(-1)!) { skip(strategy, 'rightCensored'); continue; }
      const threshold = strategy === 'S3' ? 120 : strategy === 'S4' ? 130 : Infinity;
      // An entry already at the take-profit level would exit the same day; it is not a take-profit trade.
      if (entry.close >= threshold) { skip(strategy, 'entryAtTakeProfit'); continue; }
      const hit = qs.find(q => q.date > entry.date && q.date <= six && q.close >= threshold);
      const exit = hit ? { ...hit, endedEarly: false } : resolve(qs, target, true);
      if (!exit) { skip(strategy, 'noExit'); continue; }
      if (exit.date < entry.date) { skip(strategy, 'exitBeforeEntry'); continue; }
      const ei = calendarIndex.get(entry.date), xi = calendarIndex.get(exit.date);
      if (ei === undefined || xi === undefined || !validRange(s, ei, xi)) { skip(strategy, 'invalidContextWindow'); continue; }
      const obs: EventObservation = { strategy, bond: b.id, name: first.name, stock: first.stock, issue,
        contractMaturity: first.contractMaturity, blindStart: start, labelAsOf: six, label, labelMaxGain, labelCrossedConversion: crossed,
        labelStockFirst: s.adjustedClose[from], labelStockMax: max, targetExit: target,
        entry: entry.date, exit: exit.date, entryPrice: entry.close, exitPrice: exit.close,
        endedEarly: exit.endedEarly, takeProfit: !!hit, year: entry.date.slice(0, 4),
        cbReturn: exit.close / entry.close - 1 - COST, ewReturn: ew[xi] / ew[ei] - 1,
        stockReturn: s.adjustedClose[xi] / s.adjustedClose[ei] - 1,
        stockEntry: s.adjustedClose[ei], stockExit: s.adjustedClose[xi], ewEntry: ew[ei], ewExit: ew[xi] };
      if (strategy === 'S1' || strategy === 'S2') {
        const scope = `${strategy}/CBAS`;
        if (!entryBoard) { skip(scope, 'missingEntryBoard'); obs.cbasExcluded = 'missingEntryBoard'; }
        else {
          const pending = !!entryBoard.putEnd && entryBoard.putEnd >= entry.date;
          const floor = pending ? entryBoard.putPrice : 100, floorDate = pending ? entryBoard.putEnd : entryBoard.contractMaturity;
          obs.floor = floor; obs.floorDate = floorDate; obs.entryBoardDate = entryBoard.date;
          if (!positive(floor)) { skip(scope, 'invalidFloor'); obs.cbasExcluded = 'invalidFloor'; }
          else {
            const premium = entry.close - floor / 1.02 ** yearsTo(entry.date, floorDate);
            obs.entryPremium = premium;
            if (premium < 1) { skip(scope, 'premiumBelow1'); obs.cbasExcluded = 'premiumBelow1'; }
            else {
              obs.exitPremium = Math.max(0, exit.close - floor / 1.02 ** yearsTo(exit.date, floorDate));
              obs.cbasReturn = obs.exitPremium / premium - 1;
            }
          }
        }
      }
      observations.push(obs);
    }
  }
  const groups: Record<string, ReturnType<typeof stats>> = {};
  for (const strategy of Object.keys(strategies)) for (const filter of ['all', '≤105', '≤110']) {
    const rows = observations.filter(o => o.strategy === strategy && (filter === 'all' || o.entryPrice <= (filter === '≤105' ? 105 : 110)));
    for (const instrument of strategy === 'S1' || strategy === 'S2' ? ['CB', 'CBAS'] : ['CB']) {
      const eligible = rows.filter(o => instrument === 'CB' || o.cbasReturn !== undefined);
      for (const label of ['all', '落空', '有動']) groups[`${strategy}/${filter}/${instrument}/${label}`] = stats(eligible.filter(o => label === 'all' || o.label === label), instrument);
    }
  }
  const result = { units: 'returns in fractions; displayed as percentages', strategies, groups, exclusions,
    coverage: { bonds: bonds.size, boardStart: boardDates[0], boardEnd: boardDates.at(-1), cbStart: cbCalendar[0], cbEnd: cbCalendar.at(-1),
      stockStart: calendar[0], stockEnd: calendar.at(-1), cbSessions: cbCalendar.length, stockSessions: calendar.length },
    benchmarkSanity, specification: { cbRoundTripCost: COST, cbasFees: 0, cbasRate: .02, minimumPremium: 1,
      sessionSearch: 5, boardStrictlyBeforeDate: true, contextDates: 'exact same trading dates; unavailable dates excluded',
      verdictExcess: 'underlying CB return minus EW, including CBAS subsets; instrument excess also reported', endedEarly: 'last observed CB trade before target (ex-post proxy, not verified redemption)',
      rightCensor: 'require planned branch horizon inside both calendars, including take-profit strategies' },
    conclusion: conclusion(groups), runtimeSeconds: (performance.now() - started) / 1000 };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/results.json`, JSON.stringify(result, null, 2) + '\n');
  writeFileSync(`${OUT}/observations.json`, JSON.stringify(observations, null, 2) + '\n');
  writeFileSync('docs/cb-blind-box-backtest.md', renderDoc(result));
  console.log(`完成 ${observations.length} 個策略事件；耗時 ${result.runtimeSeconds.toFixed(2)} 秒。`);
}
interface EventObservation {
  strategy: string; bond: string; name: string; stock: string; issue: string; contractMaturity: string; blindStart: string;
  labelAsOf: string; label: string; labelMaxGain: number; labelCrossedConversion: boolean; labelStockFirst: number; labelStockMax: number;
  targetExit: string; entry: string; exit: string; entryPrice: number; exitPrice: number; endedEarly: boolean; takeProfit: boolean; year: string;
  cbReturn: number; ewReturn: number; stockReturn: number; stockEntry: number; stockExit: number; ewEntry: number; ewExit: number;
  floor?: number; floorDate?: string; entryBoardDate?: string; entryPremium?: number; exitPremium?: number; cbasReturn?: number; cbasExcluded?: string;
}
function stats(rows: EventObservation[], instrument: string) {
  const values = rows.map(o => instrument === 'CB' ? o.cbReturn : o.cbasReturn!), avg = mean(values);
  const sd = values.length > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - avg!) ** 2, 0) / (values.length - 1)) : null;
  const perYear = Object.fromEntries([...new Set(rows.map(o => o.year))].sort().map(y => {
    const a = values.filter((_, i) => rows[i].year === y); return [y, { n: a.length, mean: mean(a) }];
  }));
  const leaveOneYearOut = Object.fromEntries(Object.keys(perYear).map(y => [y, mean(values.filter((_, i) => rows[i].year !== y))]));
  const loo = Object.values(leaveOneYearOut), leaveOneYearOutMin = loo.length && loo.every(v => v !== null) ? Math.min(...loo as number[]) : null;
  const meanExcess = mean(values.map((v, i) => v - rows[i].ewReturn));
  const meanCBExcess = mean(rows.map(o => o.cbReturn - o.ewReturn));
  return { n: values.length, mean: avg, median: quantile(values, .5), winRate: values.length ? values.filter(v => v > 0).length / values.length : null,
    p10: quantile(values, .1), p90: quantile(values, .9), worst: values.length ? Math.min(...values) : null, best: values.length ? Math.max(...values) : null,
    meanWinners: mean(values.filter(v => v > 0)), meanLosers: mean(values.filter(v => v < 0)), t: sd ? avg! / (sd / Math.sqrt(values.length)) : null,
    perYear, leaveOneYearOut, leaveOneYearOutMin, meanEW: mean(rows.map(o => o.ewReturn)), meanStock: mean(rows.map(o => o.stockReturn)), meanExcess, meanCBExcess,
    endedEarly: rows.filter(o => o.endedEarly).length,
    verdict: values.length < 30 ? '樣本不足' : avg! > 0 && leaveOneYearOutMin !== null && leaveOneYearOutMin > 0 && meanCBExcess! > 0 ? '通過' : '未通過' };
}
type Group = ReturnType<typeof stats>;
const pct = (v: number | null) => v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
const fixed = (v: number | null) => v === null ? '—' : v.toFixed(2);
function conclusion(g: Record<string, Group>) {
  return [
    ...['S1', 'S2'].map(s => { const a = g[`${s}/all/CB/all`], b = g[`${s}/≤105/CB/all`];
      return `${s} 買 CB：全體平均 ${pct(a.mean)}（n=${a.n}），中位 ${pct(a.median)}，扣除同期等權市場後 ${pct(a.meanExcess)}；進場≤105 平均 ${pct(b.mean)}（n=${b.n}），判定 ${a.verdict}／${b.verdict}。`; }),
    ...['S1', 'S2'].map(s => { const a = g[`${s}/all/CBAS/all`]; return `${s} CBAS：平均 ${pct(a.mean)}，中位 ${pct(a.median)}，勝率 ${pct(a.winRate).replace('+', '')}，最差 ${pct(a.worst)}（n=${a.n}）；判定 ${a.verdict}。這是零費用的溢價模擬，低本金會放大盈虧。`; }),
    '落空／有動分組是事後診斷，不能在進場時預知；通過代表本機歷史樣本符合門檻，並非未來獲利保證。',
  ];
}
function renderDoc(r: { groups: Record<string, Group>; strategies: Record<string, string>; exclusions: Record<string, Record<string, number>>; coverage: Record<string, string | number>; conclusion: string[]; runtimeSeconds: number }) {
  const table = (h: string[], rows: (string | number)[][]) => '\n| ' + h.join(' | ') + ' |\n| ' + h.map((_, i) => i ? '---:' : '---').join(' | ') + ' |\n' + rows.map(row => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n';
  let doc = '# CB 盲盒交易回測\n\n## 問題\n\n發行滿 3 個月買進可轉債本身，持有至滿 6 個月，或有動續抱、收盤停利，是否賺錢並超過同期市場？拆成 CBAS 溢價後，盈虧如何改變？\n\n## 結論\n\n' + r.conclusion.map(s => `- ${s}`).join('\n') + '\n\n';
  doc += `## 規格\n\n- 全部離線；月末看板 ${r.coverage.boardStart}～${r.coverage.boardEnd}，歷史聯集 ${r.coverage.bonds} 檔；CB 等價市場日曆 ${r.coverage.cbStart}～${r.coverage.cbEnd}，現股面板 ${r.coverage.stockStart}～${r.coverage.stockEnd}。CSV 依 HEADER 名稱解析，只用有正收市的等價成交，剔除全市場無等價成交日。\n- 發行估計日＝轉換起日減 3 曆月，沿用 addMonths 月底夾日；估計發行≥2018-01-01。contractMaturity＝轉換迄日，不以事後下櫃日替代。每策略預定窗口須完全落在兩種日曆內；S2 依滿 6 月時標籤決定是否要求滿 12 月，S3／S4 即使提早停利也要求完整 6 月窗口。\n- 進場＝issue+3m 當日或之後首個等價成交收盤，最多 5 個 CB 市場 sessions，首日算 1；沒有則 noEntry。只以此價格分 all、≤105、≤110，三組重疊。\n- 指定 D 出場＝D 起 5 個 CB sessions 首筆成交；最後成交早於 D 則以最後成交價出場並標 endedEarly；其餘 noExit。後者是事後停止交易代理，不能確認強贖／下櫃原因；尚未完成的預定窗口一律 rightCensored，不用最後成交繞過截尾。\n- S1：3→6；S2：6 月落空即出、有動續抱至 12 月；S3／S4：3→6 期間首次 CB 收盤≥120／130 即按該收盤出場（不含進場日）；進場價已≥停利線者不屬停利交易，計為 entryAtTakeProfit 排除。成交收盤決策與同價成交為理想化假設，未模擬盤中委託。\n- 標籤沿用 Q2：含兩端 [issue+3m, issue+6m]，首個現股交易日為基準；最大還原收盤／首收盤−1<10%，且沒有實際收盤≥當時轉換價，才是落空，其餘有動。當日只用全市場日期嚴格早於當日的最新看板，當期缺債不延用；轉換價乘當日 adjustmentFactor。缺現股／看板則排除。S2 在滿 6 月才用標籤；其他策略與所有進場均不以標籤選股，分組明列 ex-post。\n- 現股沿用 wide-market-panel 與官方除權參考，未解決公司行動跨 segment 排除。EW 沿用原腳本：每日同 segment、前後還原收盤正且當日 seen 的全市場股票，日報酬截尾±11% 後等權複利；市場資料不完整即中止。同期 EW 與發行人現股均按 CB 實際進出同一交易日期的還原收盤計算；日期不可用或還原窗口不連續則排除。\n- CB 報酬＝exit／entry−1−0.3%（來回成本）。CBAS 僅 S1／S2：進場前一期看板若最近賣回權迄日≥進場日，floor＝最近賣回權價格、floorDate＝該迄日；否則 floor＝100、floorDate＝契約到期。進場溢價＝CB−floor／1.02^years，years＝max(0, 日差／365.25)，溢價<1 排除。出場沿用進場已知 floor／floorDate，溢價=max(0, CB−折現 floor)；到 floorDate 後不再折現。報酬＝出場溢價／進場溢價−1，**不扣任何費用**。\n- 每組列 n、均值、中位、勝率、p10／p90、最差／最好、贏家／輸家均值、t＝mean／樣本標準誤、進場年度均值／n、刪任一年最低均值、同期 EW／現股及超額。同時列工具−EW 與 CB−EW；判定嚴格使用規格的 CB−EW（CBAS 子樣本亦用其對應 CB 報酬）。n≥30、均值>0、刪任一年最低均值>0、平均超額>0 才通過；n<30＝樣本不足，其餘未通過。只有一年時刪年無樣本，不能通過。\n- 不同債券與窗口可能重疊；t 未做發行人／時間聚類。發行日估計、月末條款滯後、最後成交代理、成交流動性與完整案例篩選皆有限制。CBAS 是固定 2% 無信用利差的價格拆解，未含拆解／融資費、買賣價差或實際契約結算。CB 最後成交也不等於兌付款。\n- 執行：\`npx tsx scripts/backtest-cb-blind-box.ts\`；本次計算約 ${r.runtimeSeconds.toFixed(2)} 秒。報酬 JSON 單位為小數，表格為百分比；超額數值解讀為百分點。\n\n### 排除計數\n\ncommon 為依順序互斥的債券排除；通過後才分策略計數，各策略亦依順序互斥。CBAS 另外計數，不影響 CB；價位／標籤分組不重複增加排除。零次原因也保留；不同層不能加總為債券數。\n`;
  doc += table(['範圍', '原因', '次數'], Object.entries(r.exclusions).flatMap(([scope, counts]) => Object.entries(counts).map(([why, n]) => [scope, why, n])));
  for (const [strategy, title] of Object.entries(r.strategies)) {
    doc += `## ${strategy} ${title}\n\n`;
    for (const label of ['all', '落空', '有動']) {
      doc += label === 'all' ? '### 全體\n\n' : `### 事後（ex-post）${label}\n\n此分組只診斷盈虧不對稱，進場時不可得知。\n\n`;
      const entries = Object.entries(r.groups).filter(([key]) => key.startsWith(strategy + '/') && key.endsWith('/' + label));
      const name = (key: string) => key.split('/').slice(1, 3).join('／');
      doc += table(['價位／工具', 'n', '均值', '中位', '勝率', 't', '判定'], entries.map(([k, s]) => [name(k), s.n, pct(s.mean), pct(s.median), pct(s.winRate).replace('+', ''), fixed(s.t), s.verdict]));
      doc += table(['價位／工具', 'p10', 'p90', '最差', '最好', '贏家均值', '輸家均值'], entries.map(([k, s]) => [name(k), pct(s.p10), pct(s.p90), pct(s.worst), pct(s.best), pct(s.meanWinners), pct(s.meanLosers)]));
      doc += table(['價位／工具', '刪年最低均值', '同期 EW', '同期現股', '工具−EW', 'CB−EW', '提前結束 n'], entries.map(([k, s]) => [name(k), pct(s.leaveOneYearOutMin), pct(s.meanEW), pct(s.meanStock), pct(s.meanExcess), pct(s.meanCBExcess), s.endedEarly]));
      doc += '年度均值／n（依進場年）：\n';
      const years = [...new Set(entries.flatMap(([, s]) => Object.keys(s.perYear)))].sort();
      for (let i = 0; i < years.length; i += 4) {
        const chunk = years.slice(i, i + 4);
        doc += table(['價位／工具', ...chunk], entries.map(([k, s]) => [name(k), ...chunk.map(y => s.perYear[y] ? `${pct(s.perYear[y].mean)}／${s.perYear[y].n}` : '—')]));
      }
    }
  }
  return doc;
}
main();
