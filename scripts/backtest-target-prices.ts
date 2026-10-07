#!/usr/bin/env npx tsx
/**
 * 法人目標價回測：FactSet 共識目標價的「空間」與「上修／下修」，之後跑不跑得贏？
 *
 * 前提：
 *   npx tsx scripts/fetch-target-prices.ts --from 2024-01-01 --to <今天>   # 速報歷史（2024 起才有）
 *   python3 scripts/fetch-wide-market-history.py                          # 全市場日線（含除權息還原）
 *
 * ## 時間軸（不偷看未來）
 *
 *   速報在台北日期 d 發布（盤中、盤後都有）→ 一律 d 的下一個交易日開盤才進場。
 *   一檔股票在某天的共識 = 那天之前最新一則速報；超過 90 天沒有新速報視為過期、不在母體內。
 *
 * ## 兩種測法
 *
 * 1. 月度橫斷面（就是子頁的用法）：每月第一個交易日開盤，用前一天收盤算空間，
 *    分成「空間 ≥ 20%」與「< 20%」，持有到下個月第一個交易日開盤。另外切五分位看是不是單調。
 * 2. 事件研究：每一則速報（目標價上修／下修、EPS 上修／下修），進場後 5／20／60 個交易日。
 *    同一檔一天只算一次。事件窗互相重疊，所以 t 值先把「同一進場月份」的事件平均再算，
 *    避免把同一段行情重複計數。
 *
 * ## 比較基準
 *
 *   「同一天有共識、流動性足夠的股票」等權平均 —— 有 FactSet 共識的多是中大型、AI 供應鏈，
 *   直接跟大盤比會把族群效果當成訊號。另外也列相對加權報酬指數的結果當參考。
 *
 * ## 限制
 *
 *   樣本只有 2024-03 之後約 2.5 年，而且這段 AI 多頭極強；結論只能當參考。
 *   沒有扣交易成本（一來一回約 0.585%）。個別券商新聞（標題抽取）沒有歷史，無法回測。
 *
 * 用法：npx tsx scripts/backtest-target-prices.ts [--min-turnover 20]
 * 產出：data/backtest/target-price/results.json，摘要印在 stdout。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { addDayQuotes, addReferenceEvent, createPanel, finalizePanel, type StockPanel } from "./lib/wide-market-panel";
import type { FactsetEvent } from "./fetch-target-prices";

const OUT_DIR = "data/backtest/target-price";
const HISTORY_DIR = "data/target-price-history";
const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const MIN_TURNOVER = Number(arg("min-turnover") ?? 20) * 1e6;
const GATE = 0.2;
const STALE_DAYS = 90;
const HORIZONS = [5, 20, 60];
const DAY_MS = 86_400_000;
/** 前後兩段的分界（樣本約 2.5 年，切一半看是不是只靠某一段） */
const SPLIT = "2025-07";

// ---------- 價格面板（同 backtest-revenue-short.ts 的讀法） ----------
function loadPanel() {
  const bench = JSON.parse(readFileSync("research/wide-market/benchmark-input.json", "utf8")).benchmarkTotalReturn;
  const calendar: string[] = bench.TaiwanStockPrice.map((r: { date: string }) => r.date).sort();
  const tr = new Map<string, number>(bench.TaiwanStockTotalReturnIndex.map((r: { date: string; price: number }) => [r.date, r.price]));
  const panel = createPanel(calendar);
  const refs = JSON.parse(readFileSync("data/backtest/wide/actions/twse-ex-references.json", "utf8")).rows as { code: string; date: string; reference: number; kind: string }[];
  const actionByKey = new Map(refs.map((a) => [`${a.date}/${a.code}`, a]));
  // 速報 2024 年才開始，往前多留一段給 20 日均量與 60 日前報酬
  const start = calendar.findIndex((d) => d >= "2023-10-01");
  for (let i = start; i < calendar.length; i++) {
    for (const source of ["twse", "tpex"] as const) {
      const file = `data/backtest/wide/daily/${source}/${calendar[i]}.json.gz`;
      if (!existsSync(file)) continue;
      const cached = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
      addDayQuotes(panel, i, cached.rows.map((q: Record<string, any>) => {
        const a = actionByKey.get(`${calendar[i]}/${q.code}`);
        return a ? { ...q, explicitReference: a.reference, changeLabel: a.kind } : q;
      }));
    }
  }
  const idx = new Map(calendar.map((d, i) => [d, i]));
  for (const [key, a] of actionByKey) {
    const i = idx.get(key.split("/")[0]);
    if (i !== undefined && i >= start) addReferenceEvent(panel, i, a.code, a.reference);
  }
  finalizePanel(panel);
  return { calendar, panel, tr, start };
}

const ok = (v: number) => Number.isFinite(v) && v > 0;

/** 進場開盤 → 出場開盤的還原報酬；出場日沒報價就用持有期內最後一個收盤，除權斷鏈就丟掉 */
function holdReturn(s: StockPanel, entry: number, exit: number): number | null {
  if (!ok(s.adjustedOpen[entry]) || s.segmentId[entry] < 0) return null;
  const seg = s.segmentId[entry];
  if (ok(s.adjustedOpen[exit]) && s.segmentId[exit] === seg && ok(s.close[exit])) return s.adjustedOpen[exit] / s.adjustedOpen[entry] - 1;
  for (let i = exit - 1; i > entry; i--) {
    if (s.segmentId[i] !== seg) return null;
    if (ok(s.close[i]) && ok(s.adjustedClose[i])) return s.adjustedClose[i] / s.adjustedOpen[entry] - 1;
  }
  return null;
}

function avgTurnover(s: StockPanel, before: number): number {
  let sum = 0, n = 0;
  for (let i = before - 20; i < before; i++) {
    if (i < 0) continue;
    n++;
    if (s.seen[i] && Number.isFinite(s.money[i])) sum += s.money[i];
  }
  return n >= 10 ? sum / n : 0;
}

// ---------- 統計 ----------
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
function tstat(a: number[]): number | null {
  if (a.length < 3) return null;
  const m = mean(a);
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(a.length)) : null;
}
const r4 = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000);

// ---------- 速報歷史 ----------
function loadEvents(): FactsetEvent[] {
  return readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .flatMap((f) => Object.values(JSON.parse(readFileSync(`${HISTORY_DIR}/${f}`, "utf8")).factset as Record<string, FactsetEvent>))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

function main() {
  const events = loadEvents();
  if (!events.length) throw new Error(`${HISTORY_DIR} 沒有速報，先跑 fetch-target-prices.ts --from 2024-01-01`);
  const { calendar, panel, tr, start } = loadPanel();
  const stock = (code: string) => panel.get(code);
  /** 日期 d 之後的第一個交易日 index（d 本身不算） */
  const nextIdx = (d: string) => calendar.findIndex((c) => c > d);

  const byCode = new Map<string, FactsetEvent[]>();
  for (const ev of events) {
    if (!byCode.has(ev.code)) byCode.set(ev.code, []);
    byCode.get(ev.code)!.push(ev);
  }
  /** 收盤日 d 當時看得到的共識（d 當天發布的也算：用的是 d 收盤、隔天開盤才進場） */
  const consensusAt = (code: string, d: string): FactsetEvent | null => {
    const list = byCode.get(code) ?? [];
    let last: FactsetEvent | null = null;
    for (const ev of list) {
      if (ev.date > d) break;
      last = ev;
    }
    if (!last) return null;
    return Date.parse(d) - Date.parse(last.date) > STALE_DAYS * DAY_MS ? null : last;
  };

  const firstEvent = events[0].date;
  const lastPriced = calendar[calendar.length - 1];
  console.log(`速報 ${events.length} 則（${firstEvent} ~ ${events[events.length - 1].date}），${byCode.size} 檔；股價到 ${lastPriced}`);

  // ---------- 1. 月度橫斷面 ----------
  const monthStarts: number[] = [];
  for (let i = Math.max(start, nextIdx(firstEvent)); i < calendar.length; i++) {
    if (i === 0 || calendar[i].slice(0, 7) !== calendar[i - 1].slice(0, 7)) monthStarts.push(i);
  }
  // 速報剛開始的前兩個月覆蓋太少，跳過
  const months: {
    month: string; n: number; nHit: number; nNew: number;
    hit: number | null; rest: number | null; all: number; mkt: number | null; newHit: number | null;
    quint: (number | null)[];
  }[] = [];
  let prevHit = new Set<string>();
  for (let k = 0; k + 1 < monthStarts.length; k++) {
    const entry = monthStarts[k], exit = monthStarts[k + 1];
    const sigDay = calendar[entry - 1];
    const rows: { code: string; up: number; ret: number }[] = [];
    for (const code of byCode.keys()) {
      const s = stock(code);
      const ev = consensusAt(code, sigDay);
      if (!s || !ev || !ok(s.close[entry - 1])) continue;
      if (avgTurnover(s, entry) < MIN_TURNOVER) continue;
      const ret = holdReturn(s, entry, exit);
      if (ret === null) continue;
      rows.push({ code, up: ev.target / s.close[entry - 1] - 1, ret });
    }
    const hitSet = new Set(rows.filter((r) => r.up >= GATE).map((r) => r.code));
    if (rows.length >= 30) {
      const all = mean(rows.map((r) => r.ret));
      const hit = rows.filter((r) => r.up >= GATE), rest = rows.filter((r) => r.up < GATE);
      const fresh = hit.filter((r) => !prevHit.has(r.code));
      const sorted = [...rows].sort((a, b) => a.up - b.up);
      const quint = [0, 1, 2, 3, 4].map((q) => {
        const part = sorted.slice(Math.floor((q * sorted.length) / 5), Math.floor(((q + 1) * sorted.length) / 5));
        return part.length ? mean(part.map((r) => r.ret)) - all : null;
      });
      const a = tr.get(calendar[entry - 1]), b = tr.get(calendar[exit - 1]);
      months.push({
        month: calendar[entry].slice(0, 7), n: rows.length, nHit: hit.length, nNew: fresh.length,
        hit: hit.length >= 3 ? mean(hit.map((r) => r.ret)) - all : null,
        rest: rest.length >= 3 ? mean(rest.map((r) => r.ret)) - all : null,
        all, mkt: a && b ? all - (b / a - 1) : null,
        newHit: fresh.length >= 3 ? mean(fresh.map((r) => r.ret)) - all : null,
        quint,
      });
    }
    prevHit = hitSet;
  }
  const summ = (xs: (number | null)[], ms: string[] = months.map((m) => m.month)) => {
    const a = xs.filter((x): x is number => x !== null);
    const half = (f: (m: string) => boolean) => {
      const h = xs.filter((x, i): x is number => x !== null && f(ms[i]));
      return h.length ? r4(mean(h)) : null;
    };
    return {
      months: a.length, mean: a.length ? r4(mean(a)) : null, t: r4(tstat(a)),
      winRate: a.length ? r4(a.filter((x) => x > 0).length / a.length) : null,
      early: half((m) => m < SPLIT), late: half((m) => m >= SPLIT),
    };
  };
  const cross = {
    gate: GATE,
    universeAvg: Math.round(mean(months.map((m) => m.n))),
    hitAvg: Math.round(mean(months.map((m) => m.nHit))),
    hitMinusUniverse: summ(months.map((m) => m.hit)),
    restMinusUniverse: summ(months.map((m) => m.rest)),
    hitMinusRest: summ(months.map((m) => (m.hit !== null && m.rest !== null ? m.hit - m.rest : null))),
    newHitMinusUniverse: summ(months.map((m) => m.newHit)),
    universeMinusMarket: summ(months.map((m) => m.mkt)),
    quintilesMinusUniverse: [0, 1, 2, 3, 4].map((q) => summ(months.map((m) => m.quint[q]))),
    months,
  };

  // ---------- 2. 事件研究 ----------
  type Kind = "target-up" | "target-down" | "eps-up" | "eps-down";
  const evRows: { kind: Kind; month: string; up: number | null; prior20: number | null; ex: Record<number, number | null>; exMkt: Record<number, number | null> }[] = [];
  const seenDay = new Set<string>();
  /** 同一天、全體有共識股票的等權報酬（基準），快取 */
  const benchCache = new Map<string, number | null>();
  const universeRet = (entry: number, exit: number): number | null => {
    const key = `${entry}/${exit}`;
    if (benchCache.has(key)) return benchCache.get(key)!;
    const rets: number[] = [];
    for (const code of byCode.keys()) {
      const s = stock(code);
      if (!s || !consensusAt(code, calendar[entry - 1]) || avgTurnover(s, entry) < MIN_TURNOVER) continue;
      const r = holdReturn(s, entry, exit);
      if (r !== null) rets.push(r);
    }
    const v = rets.length >= 30 ? mean(rets) : null;
    benchCache.set(key, v);
    return v;
  };
  for (const ev of events) {
    const key = `${ev.code}/${ev.date}`;
    if (seenDay.has(key)) continue;
    seenDay.add(key);
    const s = stock(ev.code);
    const entry = nextIdx(ev.date);
    if (!s || entry < 1 || entry < start || avgTurnover(s, entry) < MIN_TURNOVER) continue;
    const kind = `${ev.kind}-${ev.direction}` as Kind;
    const ex: Record<number, number | null> = {}, exMkt: Record<number, number | null> = {};
    for (const h of HORIZONS) {
      const exit = entry + h;
      if (exit >= calendar.length) { ex[h] = exMkt[h] = null; continue; }
      const r = holdReturn(s, entry, exit);
      const u = universeRet(entry, exit);
      const a = tr.get(calendar[entry - 1]), b = tr.get(calendar[exit - 1]);
      ex[h] = r !== null && u !== null ? r - u : null;
      exMkt[h] = r !== null && a && b ? r - (b / a - 1) : null;
    }
    const prevClose = s.close[entry - 1];
    // 速報前 20 個交易日的還原報酬：目標價是不是在股價大漲之後才追上去
    const a = entry - 21, b = entry - 1;
    const prior20 = a >= 0 && ok(s.adjustedClose[a]) && ok(s.adjustedClose[b]) && s.segmentId[a] === s.segmentId[b] ? s.adjustedClose[b] / s.adjustedClose[a] - 1 : null;
    evRows.push({ kind, month: calendar[entry].slice(0, 7), up: ok(prevClose) ? ev.target / prevClose - 1 : null, prior20, ex, exMkt });
  }
  /** 先依進場月份平均、再對月份做 t（事件窗重疊，直接對事件算 t 會高估） */
  const clustered = (rows: typeof evRows, h: number, field: "ex" | "exMkt") => {
    const byMonth = new Map<string, number[]>();
    for (const r of rows) {
      const v = r[field][h];
      if (v === null) continue;
      if (!byMonth.has(r.month)) byMonth.set(r.month, []);
      byMonth.get(r.month)!.push(v);
    }
    const all = [...byMonth.values()].flat();
    const mm = [...byMonth.values()].map(mean);
    const sorted = [...all].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return { events: all.length, mean: all.length ? r4(mean(all)) : null, median: r4(median), months: mm.length, tMonthly: r4(tstat(mm)), winRate: all.length ? r4(all.filter((x) => x > 0).length / all.length) : null };
  };
  const groups: [string, (r: (typeof evRows)[number]) => boolean][] = [
    ["目標價上修", (r) => r.kind === "target-up"],
    ["目標價下修", (r) => r.kind === "target-down"],
    ["EPS 上修", (r) => r.kind === "eps-up"],
    ["EPS 下修", (r) => r.kind === "eps-down"],
    ["目標價上修且空間 ≥ 20%", (r) => r.kind === "target-up" && (r.up ?? -1) >= GATE],
    ["目標價上修且空間 < 20%", (r) => r.kind === "target-up" && (r.up ?? 9) < GATE],
    ["任何上修且空間 ≥ 20%", (r) => r.kind.endsWith("-up") && (r.up ?? -1) >= GATE],
  ];
  const eventStudy = groups.map(([label, f]) => {
    const rows = evRows.filter(f);
    const p20 = rows.map((r) => r.prior20).filter((x): x is number => x !== null);
    return {
      label,
      prior20: p20.length ? r4(mean(p20)) : null,
      vsUniverse: Object.fromEntries(HORIZONS.map((h) => [h, clustered(rows, h, "ex")])),
      vsMarket: Object.fromEntries(HORIZONS.map((h) => [h, clustered(rows, h, "exMkt")])),
    };
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const result = {
    generatedAt: new Date().toISOString(),
    sample: { events: events.length, stocks: byCode.size, firstEvent, lastEvent: events[events.length - 1].date, lastPriced, minTurnover: MIN_TURNOVER },
    crossSection: cross,
    eventStudy,
  };
  writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(result, null, 1));

  const pct = (v: number | null) => (v === null ? "   —  " : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
  const line = (label: string, x: ReturnType<typeof summ>) =>
    console.log(`  ${label.padEnd(14, "　")} ${pct(x.mean)}／月  t ${x.t ?? "—"}  勝率 ${x.winRate === null ? "—" : Math.round(x.winRate * 100) + "%"}  (${x.months} 個月)  前段 ${pct(x.early)} 後段 ${pct(x.late)}`);
  console.log(`\n## 月度橫斷面（母體平均 ${cross.universeAvg} 檔，空間 ≥ 20% 平均 ${cross.hitAvg} 檔；超額＝減母體等權）`);
  line("空間 ≥ 20%", cross.hitMinusUniverse);
  line("空間 < 20%", cross.restMinusUniverse);
  line("≥20% 減 <20%", cross.hitMinusRest);
  line("當月新進榜", cross.newHitMinusUniverse);
  line("母體 減 加權報酬指數", cross.universeMinusMarket);
  cross.quintilesMinusUniverse.forEach((q, i) => line(`空間五分位 Q${i + 1}${i === 0 ? "（最低）" : i === 4 ? "（最高）" : ""}`, q));
  console.log(`\n## 事件研究（進場＝速報隔日開盤；超額＝減同期有共識股票等權；t 以進場月份群集）`);
  for (const g of eventStudy) {
    console.log(`  ${g.label}（速報前 20 日平均漲幅 ${pct(g.prior20)}）`);
    for (const h of HORIZONS) {
      const u = g.vsUniverse[h], m = g.vsMarket[h];
      console.log(`    ${String(h).padStart(2)} 日：${pct(u.mean)}  t ${u.tMonthly ?? "—"}  勝率 ${u.winRate === null ? "—" : Math.round(u.winRate * 100) + "%"}  中位數 ${pct(u.median)}  n=${u.events}｜vs 大盤 ${pct(m.mean)}`);
    }
  }
}

main();
