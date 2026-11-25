#!/usr/bin/env npx tsx
/**
 * 財報選股：財報季每天掃描新公布的季報，挑「獲利驚喜」最高 20%（候選）與最低 20%（警示）。純規則、零 LLM。
 *
 * 依據 scripts/research-earnings-drift.py（2020Q3–2026Q2 共 24 季，因子驗證 2026-11-25-earnings-drift）：
 *   獲利驚喜 = (單季 EPS − 去年同季 EPS × 今年單季營收 ÷ 去年單季營收) ÷ 公布日收盤價（去年同季 EPS > 0 才算）
 *   最高 20%、公布隔天開盤買：20 日超額 +1.70%（扣成本 +1.12%，t 4.6），60 日 +2.32%；等到法定期限才買只剩 +0.81%
 *   最低 20%：20 日 −2.40%、60 日 −3.09%，每一年都落後
 *   門檻用「前 4 季全部公司」的第 20／80 百分位（每天掃描時只知道過去），回測一樣成立
 *
 * 讀：data/market-latest.json、data/financials-history（fetch-quarterly-financials.ts 在申報期限前每天重抓當季）、
 *     data/cache/close-*.json（公布日收盤）、公開資訊觀測站「每日重大訊息」、Yahoo 日線（還原、開盤價）
 * 寫：data/earnings-scan-latest.json、data/earnings-scan.html、
 *     data/earnings-scan-history/filings-<Q>.json（公布日）、data/earnings-scan-positions.json（紙上部位）
 *
 * 用法：npx tsx scripts/build-earnings-scan.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { deadlineOf, loadFinancials, prevQuarter } from "./lib/gross-margin";
import { renderEarningsScan } from "./lib/earnings-scan-page";
import { twDate } from "./lib/time";

const ROOT = process.cwd();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const HISTORY_DIR = "data/earnings-scan-history";
const POSITIONS_PATH = "data/earnings-scan-positions.json";
const OUT_LATEST = "data/earnings-scan-latest.json";
const MIN_MONEY = 2e7, MIN_AGE = 60;
const COST = 0.00585;
const HOLDS = [20, 60] as const;

const readJson = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(resolve(ROOT, p), "utf8")) as T; } catch { return null; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s + "T00:00:00Z") + n * 864e5));

// ---------- 申報窗口與公布日（重大訊息） ----------
/** 跟 fetch-financial-report-dates.py 一樣：Q1 4/1–5/25、Q2 7/1–8/24、Q3 10/1–11/24、年報 隔年 1/15–4/10 */
function windowOf(q: string): [string, string] {
  const y = +q.slice(0, 4), s = +q[5];
  return s === 1 ? [`${y}-04-01`, `${y}-05-25`] : s === 2 ? [`${y}-07-01`, `${y}-08-24`] : s === 3 ? [`${y}-10-01`, `${y}-11-24`] : [`${y + 1}-01-15`, `${y + 1}-04-10`];
}
const nextQuarter = (q: string) => (q[5] === "4" ? `${+q.slice(0, 4) + 1}Q1` : `${q.slice(0, 5)}${+q[5] + 1}`);
/** 窗口已開始的最近兩季（年報與 Q1 窗口會重疊） */
function activeQuarters(today: string): string[] {
  let q = `${+today.slice(0, 4) - 1}Q1`;
  const started: string[] = [];
  while (windowOf(q)[0] <= today) { started.push(q); q = nextQuarter(q); }
  return started.slice(-2);
}

const FIN = /財務報/, OK = /通過|承認|核准|提報/, BAD = /更正|重編|補正|重新/;
function subjectSeason(s: string): number | null {
  if (/第\s*[一1１]\s*季|[一1１]\s*季|Q1/.test(s)) return 1;
  if (/第\s*[二2２]\s*季|上半年|半年度|Q2/.test(s)) return 2;
  if (/第\s*[三3３]\s*季|前三季|Q3/.test(s)) return 3;
  if (/年度.{0,8}財務報/.test(s) && !s.includes("季")) return 4;
  return null;
}

type Filing = { date: string; time: string; subject: string; seen?: string };
interface FilingStore { quarter: string; fetched: string[]; stocks: Record<string, Filing> }

async function fetchDay(d: string, typek: "sii" | "otc"): Promise<string[][]> {
  const [y, m, dd] = d.split("-").map(Number);
  const body = `encodeURIComponent=1&step=0&firstin=true&off=1&TYPEK=${typek}&year=${y - 1911}&month=${String(m).padStart(2, "0")}&day=${String(dd).padStart(2, "0")}`;
  for (let i = 1; i <= 4; i++) {
    try {
      const res = await fetch("https://mopsov.twse.com.tw/mops/web/ajax_t05st02", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = await res.text();
      const rows: string[][] = [];
      if (t.includes("查無")) return rows;
      for (const tr of t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
        const c = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").replace(/\s+/g, " ").trim());
        if (c.length >= 5 && /^\d{2,3}\/\d{2}\/\d{2}$/.test(c[0])) {
          const [ry, rm, rd] = c[0].split("/").map(Number);
          rows.push([`${ry + 1911}-${String(rm).padStart(2, "0")}-${String(rd).padStart(2, "0")}`, c[1], c[2], c[3], c[4]]);
        }
      }
      return rows;
    } catch (e) {
      if (i === 4) throw e;
      await sleep(3000 * i);
    }
  }
  return [];
}

/** 補抓窗口內還沒抓過的日子；今天與前兩天每次都重抓（晚上才發的公告） */
async function updateFilings(q: string, today: string, warnings: string[]): Promise<FilingStore> {
  const path = `${HISTORY_DIR}/filings-${q}.json`;
  const store = readJson<FilingStore>(path) ?? { quarter: q, fetched: [], stocks: {} };
  const [lo, hi] = windowOf(q);
  const end = today < hi ? today : hi;
  const done = new Set(store.fetched);
  let failed = 0;
  for (let d = lo; d <= end; d = addDays(d, 1)) {
    if (done.has(d) && d < addDays(today, -2)) continue;
    let ok = true;
    for (const typek of ["sii", "otc"] as const) {
      let rows: string[][];
      try { rows = await fetchDay(d, typek); } catch { ok = false; failed++; continue; }
      for (const [dt, tm, code, , subj] of rows) {
        if (dt < lo || dt > hi || !/^\d{4}$/.test(code)) continue;
        const ss = subjectSeason(subj);
        if (ss !== null && ss !== +q[5]) continue;
        if (!FIN.test(subj) || !OK.test(subj) || BAD.test(subj)) continue;
        const cur = store.stocks[code];
        if (!cur || dt + tm < cur.date + cur.time) store.stocks[code] = { ...cur, date: dt, time: tm, subject: subj.slice(0, 60) };
      }
      await sleep(800);
    }
    if (ok && !done.has(d)) { store.fetched.push(d); done.add(d); }
  }
  if (failed) warnings.push(`${q} 重大訊息有 ${failed} 個日別抓取失敗，下次再補`);
  store.fetched.sort();
  mkdirSync(resolve(ROOT, HISTORY_DIR), { recursive: true });
  writeFileSync(resolve(ROOT, path), JSON.stringify(store));
  return store;
}

// ---------- 財報指標 ----------
const fin = loadFinancials(ROOT);
type One = { rev: number; cost: number; op: number | null; eps: number | null };
function single(code: string, q: string): One | null {
  const c = fin.get(q)?.stocks[code];
  if (!c) return null;
  if (q[5] === "1") return { rev: c.rev, cost: c.cost, op: c.op ?? null, eps: c.eps ?? null };
  const p = fin.get(prevQuarter(q))?.stocks[code];
  if (!p) return null;
  const sub = (a?: number | null, b?: number | null) => (a == null || b == null ? null : a - b);
  return { rev: c.rev - p.rev, cost: c.cost - p.cost, op: sub(c.op, p.op), eps: sub(c.eps, p.eps) };
}
/** 累計相減會有浮點尾數（1.5699999…），EPS 取到小數第二位 */
const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
const yearAgo = (q: string) => `${+q.slice(0, 4) - 1}Q${q[5]}`;
interface Metrics { surp: number | null; gmYoy: number | null; opmYoy: number | null; epsYoy: number | null; eps: number | null; epsLy: number | null; revYoy: number | null }
function metrics(code: string, q: string, px: number): Metrics | null {
  const a = single(code, q), b = single(code, yearAgo(q));
  if (!a || !b || !(a.rev > 0) || !(b.rev > 0) || !(px > 0)) return null;
  const gm = (x: One) => (x.rev - x.cost) / x.rev, opm = (x: One) => (x.op == null ? null : x.op / x.rev);
  const oa = opm(a), ob = opm(b);
  return {
    surp: a.eps != null && b.eps != null && b.eps > 0 ? (a.eps - (b.eps * a.rev) / b.rev) / px : null,
    gmYoy: (gm(a) - gm(b)) * 100, opmYoy: oa != null && ob != null ? (oa - ob) * 100 : null,
    epsYoy: a.eps != null && b.eps != null ? (a.eps - b.eps) / px : null,
    eps: r2(a.eps), epsLy: r2(b.eps), revYoy: (a.rev / b.rev - 1) * 100,
  };
}

/** 某日（含）以前最近一天的全市場收盤（本地快取） */
const closeCache = new Map<string, Record<string, number> | null>();
function closesOnOrBefore(d: string): Record<string, number> | null {
  for (let i = 0; i < 10; i++) {
    const k = addDays(d, -i).replaceAll("-", "");
    if (!closeCache.has(k)) closeCache.set(k, readJson<Record<string, number>>(`data/cache/close-${k}.json`));
    const c = closeCache.get(k);
    if (c && Object.keys(c).length > 500) return c;
  }
  return null;
}
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
/** 前 4 季全部公司的獲利驚喜第 20／80 百分位；價格用該季申報期限當天收盤（只影響分母，近似公布日） */
function cutoffs(q: string): { lo: number; hi: number; quarters: string[]; n: number } | null {
  const vals: number[] = [], qs: string[] = [];
  let p = q;
  for (let i = 0; i < 4; i++) {
    p = prevQuarter(p);
    const snap = fin.get(p), px = closesOnOrBefore(iso(deadlineOf(p)));
    if (!snap || !px) return null;
    qs.push(p);
    for (const code of Object.keys(snap.stocks)) { const m = metrics(code, p, px[code]); if (m?.surp != null && Number.isFinite(m.surp)) vals.push(m.surp); }
  }
  return vals.length > 1000 ? { lo: pct(vals, 0.2), hi: pct(vals, 0.8), quarters: qs.reverse(), n: vals.length } : null;
}

// ---------- Yahoo 日線（還原，含開盤；寫法同 build-new-high-scan.ts） ----------
interface Series { dates: string[]; open: number[]; close: number[]; rawOpen: number[]; money20: number }
async function fetchSeries(ticker: string): Promise<Series | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return null;
      if (res.ok) {
        const r = (await res.json())?.chart?.result?.[0];
        if (!r?.timestamp) return null;
        const q = r.indicators?.quote?.[0], adj = r.indicators?.adjclose?.[0]?.adjclose ?? q?.close;
        const s: Series = { dates: [], open: [], close: [], rawOpen: [], money20: NaN };
        const money: number[] = [];
        r.timestamp.forEach((ts: number, i: number) => {
          const o = q.open[i], c = q.close[i];
          if (!(o > 0) || !(c > 0)) return;
          const k = adj?.[i] > 0 ? adj[i] / c : 1;
          s.dates.push(new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10));
          s.open.push(o * k); s.close.push(c * k); s.rawOpen.push(o); money.push((q.volume[i] ?? 0) * c);
        });
        const m20 = money.slice(-20);
        s.money20 = m20.length ? m20.reduce((a, b) => a + b, 0) / m20.length : NaN;
        return s;
      }
    } catch { /* retry */ }
    await sleep(600 * (attempt + 1));
  }
  return null;
}
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); } }));
  return out;
}

// ---------- 紙上部位：公布日（或第一次看到數字那天）後第一個交易日開盤買，20／60 個交易日後開盤賣 ----------
interface Leg { status: "open" | "closed"; exitDate?: string; ret?: number; excess?: number }
interface Position {
  code: string; name: string; market: string; quarter: string; side: "top" | "bottom"; announce: string; after: string; surp: number;
  backfill?: boolean; entryDate?: string; entry?: number; lastDate?: string; ret?: number; excess?: number; held?: number; d20: Leg; d60: Leg;
}
function updatePosition(p: Position, s: Series, bench: Series | null): void {
  const e = s.dates.findIndex((d) => d > p.after);
  if (e < 0) return;
  p.entryDate = s.dates[e];
  p.entry = +s.rawOpen[e].toFixed(2);
  const bi = bench ? bench.dates.indexOf(p.entryDate) : -1;
  /** 第 j 天的價格 px（還原）相對進場開盤的報酬，與同期加權指數（bpx 取開盤或收盤）比較 */
  const perf = (j: number, px: number, useClose: boolean) => {
    const r = px / s.open[e] - 1;
    const bj = bench && bi >= 0 ? bench.dates.indexOf(s.dates[j]) : -1;
    const b = bj >= 0 ? (useClose ? bench!.close[bj] : bench!.open[bj]) / bench!.open[bi] - 1 : NaN;
    return { ret: +((r - COST) * 100).toFixed(2), excess: Number.isFinite(b) ? +((r - b) * 100).toFixed(2) : undefined };
  };
  for (const h of HOLDS) {
    const leg = h === 20 ? p.d20 : p.d60;
    if (leg.status === "open" && e + h < s.dates.length) Object.assign(leg, { status: "closed", exitDate: s.dates[e + h], ...perf(e + h, s.open[e + h], false) });
  }
  const last = s.dates.length - 1;
  Object.assign(p, { lastDate: s.dates[last], held: last - e, ...perf(last, s.close[last], true) });
}

// ---------- main ----------
async function main() {
  const market = readJson<{ tradingDate: string; closeMap: Record<string, number>; stockMap: Record<string, { name: string }> }>("data/market-latest.json");
  if (!market?.tradingDate) throw new Error("data/market-latest.json 沒有 tradingDate");
  const tradingDate = market.tradingDate, today = twDate();
  const warnings: string[] = [];
  const firstRun = !existsSync(resolve(ROOT, POSITIONS_PATH));
  const positions = readJson<Position[]>(POSITIONS_PATH) ?? [];

  const seasons: any[] = [];
  const pending: Position[] = [];
  for (const q of activeQuarters(today)) {
    const store = await updateFilings(q, today, warnings);
    const cut = cutoffs(q);
    if (!cut) { warnings.push(`${q} 前 4 季財報或收盤快取不足，算不出門檻`); continue; }
    const rows: any[] = [];
    let noData = 0;
    for (const [code, f] of Object.entries(store.stocks)) {
      const px = f.date >= tradingDate ? market.closeMap[code] : closesOnOrBefore(f.date)?.[code];
      const m = px ? metrics(code, q, px) : null;
      if (!m) { noData++; continue; }
      // 第一次看到這家的財報數字是哪一天：盤後公布、當晚彙總表就有的話＝公布日；晚幾天才進彙總表就照實延後進場
      f.seen ??= firstRun ? f.date : (tradingDate > f.date ? tradingDate : f.date);
      const side = m.surp == null ? null : m.surp >= cut.hi ? "top" : m.surp <= cut.lo ? "bottom" : null;
      const snap = fin.get(q)!.stocks[code];
      rows.push({ code, name: snap.n, market: snap.m, date: f.date, time: f.time, seen: f.seen, px, side, ...m, surp: m.surp == null ? null : +(m.surp * 100).toFixed(2) });
      if (side && !positions.some((p) => p.code === code && p.quarter === q))
        pending.push({ code, name: snap.n, market: snap.m, quarter: q, side, announce: f.date, after: f.seen > f.date ? f.seen : f.date, surp: +(m.surp! * 100).toFixed(2), ...(firstRun ? { backfill: true } : {}), d20: { status: "open" }, d60: { status: "open" } });
    }
    writeFileSync(resolve(ROOT, `${HISTORY_DIR}/filings-${q}.json`), JSON.stringify(store));
    const [lo, hi] = windowOf(q);
    seasons.push({
      quarter: q, window: [lo, hi], deadline: iso(deadlineOf(q)), filed: Object.keys(store.stocks).length, noData,
      cutoff: { loPct: +(cut.lo * 100).toFixed(2), hiPct: +(cut.hi * 100).toFixed(2), from: cut.quarters, n: cut.n }, rows,
    });
  }

  // 流動性：候選／警示與持有中部位抓 Yahoo 日線（20 日均成交值 ≥ 2000 萬、上市滿 60 日才列入紙上部位）
  const open = positions.filter((p) => p.d20.status === "open" || p.d60.status === "open");
  const codes = [...new Set([...pending.map((p) => p.code), ...open.map((p) => p.code), ...seasons.flatMap((s) => s.rows.filter((r: any) => r.side).map((r: any) => r.code))])];
  const series = new Map<string, Series>();
  const mktOf = new Map(seasons.flatMap((s) => s.rows.map((r: any) => [r.code, r.market] as const)).concat(positions.map((p) => [p.code, p.market] as const)));
  await mapPool(codes, 6, async (code) => { const s = await fetchSeries(`${code}${mktOf.get(code) === "tpex" ? ".TWO" : ".TW"}`); if (s) series.set(code, s); });
  const bench = await fetchSeries("^TWII");
  if (!bench) warnings.push("抓不到加權指數，超額欄位空白");
  const liquid = (code: string, d: string) => { const s = series.get(code); if (!s) return null; const i = s.dates.filter((x) => x <= d).length; return s.money20 >= MIN_MONEY && i >= MIN_AGE; };
  for (const s of seasons) for (const r of s.rows) if (r.side) r.liquid = liquid(r.code, r.date);
  for (const p of pending) if (liquid(p.code, p.announce)) positions.push(p);
  for (const p of positions) if (p.d20.status === "open" || p.d60.status === "open") { const s = series.get(p.code); if (s) updatePosition(p, s, bench); }
  writeFileSync(resolve(ROOT, POSITIONS_PATH), JSON.stringify(positions, null, 1));

  const stat = (side: "top" | "bottom", h: 20 | 60) => {
    const legs = positions.filter((p) => p.side === side).map((p) => (h === 20 ? p.d20 : p.d60)).filter((l) => l.status === "closed");
    if (!legs.length) return null;
    const avg = (a: number[]) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
    const ex = legs.map((l) => l.excess).filter((v): v is number => v != null);
    return { n: legs.length, avg: avg(legs.map((l) => l.ret!)), win: +((legs.filter((l) => l.ret! > 0).length / legs.length) * 100).toFixed(1), excess: ex.length ? avg(ex) : null };
  };
  const result = {
    generatedAt: new Date().toISOString(), tradingDate, warnings, seasons,
    positions: {
      open: positions.filter((p) => p.d60.status === "open").sort((a, b) => b.announce.localeCompare(a.announce)),
      closed: positions.filter((p) => p.d60.status === "closed").slice(-80).reverse(), total: positions.length,
      stats: { top20: stat("top", 20), top60: stat("top", 60), bottom20: stat("bottom", 20), bottom60: stat("bottom", 60) },
    },
  };
  writeFileSync(resolve(ROOT, OUT_LATEST), JSON.stringify(result, null, 1));
  writeFileSync(resolve(ROOT, "data/earnings-scan.html"), renderEarningsScan(result));
  const latest = seasons.at(-1);
  console.log(`[earnings-scan] ${tradingDate} ${seasons.map((s) => `${s.quarter} 已公布 ${s.filed}、候選 ${s.rows.filter((r: any) => r.side === "top").length}、警示 ${s.rows.filter((r: any) => r.side === "bottom").length}`).join("；")}；紙上部位 ${result.positions.open.length} 持有、累計 ${positions.length}${latest ? "" : "（沒有進行中的財報季）"}`);
  for (const w of warnings) console.warn(`[earnings-scan][warn] ${w}`);
}

main().catch((e) => { console.error(`[earnings-scan] ${(e as Error).stack ?? e}`); process.exit(1); });
