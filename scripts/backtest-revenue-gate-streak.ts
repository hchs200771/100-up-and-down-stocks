#!/usr/bin/env npx tsx
/**
 * 營收 YoY 門檻 15% vs 20%、「連續達標」2 個月 vs 3 個月的回測。結果與解讀見 docs/revenue-gate-streak-backtest.md。
 *
 * 進出場（預設，開盤價）：M 月營收的申報截止日是 M+1 月 10 日（遇非交易日順延到下一個交易日），
 * 截止日後第一個交易日「開盤」進場，下個月同規則開盤出場。開盤價來自 data/backtest/wide/daily/（backtest:wide:fetch）。
 * 沒有各公司實際申報日，用截止日是保守近似：早公布的公司實際可以更早買。
 * PRICE=close 改回舊框架（11 日後第一個交易日收盤，ENTRY_DAY 可改日期），與 backtest-revenue-streak.ts 相同。
 *
 * 用法：npx tsx scripts/backtest-revenue-gate-streak.ts [split=2023-01]
 */
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadSnapshots, coverageOf, createFactorCalc, MIN_COVERAGE } from "./lib/revenue-factors";
import { closesOn, isTradingDay } from "./lib/twse-closes";
const ROOT = process.cwd();
const SPLIT = process.argv[2] ?? "2023-01";
const MIN_BUCKET = 8;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
async function closesOnOrAfter(y: number, m: number, d: number) {
  for (let i = 0; i < 8; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    if (dt.getTime() > Date.now()) return null;
    const closes = await closesOn(ymd(dt), ROOT);
    if (isTradingDay(closes)) return closes as Record<string, number>;
  }
  return null;
}
// 開盤價模式（預設）：進場＝營收申報截止日（10 日，遇非交易日順延到下一個交易日）的「下一個交易日開盤」，出場＝下個月同樣規則的開盤
const WD = `${ROOT}/data/backtest/wide/daily`;
const TDAYS = readdirSync(`${WD}/twse`).map((f) => f.slice(0, 10)).sort();
const openCache = new Map<string, Record<string, number>>();
const opensOn = (d: string) => {
  if (!openCache.has(d)) {
    const o: Record<string, number> = {};
    for (const m of ["twse", "tpex"]) {
      try {
        for (const r of JSON.parse(gunzipSync(readFileSync(`${WD}/${m}/${d}.json.gz`)).toString()).rows) if (r.open > 0) o[r.code] = r.open;
      } catch {}
    }
    openCache.set(d, o);
  }
  return openCache.get(d)!;
};
const entryOf = async (month: string) => {
  const n = monthsBack(month, -1);
  if (process.env.PRICE === "close") return closesOnOrAfter(+n.slice(0, 4), +n.slice(5, 7), Number(process.env.ENTRY_DAY ?? 11));
  const i = TDAYS.findIndex((d) => d >= `${n}-10`);
  if (i < 0 || i + 1 >= TDAYS.length) return null;
  return opensOn(TDAYS[i + 1]);
};

const snaps = loadSnapshots(ROOT);
const all = [...snaps.keys()].sort();
// 每月每檔的 YoY（用 factorsFor，含規模/產業過濾），回頭算「連續 N 月 YoY≥X」
const yoyMap = new Map<string, Map<string, number>>();
const calcs = new Map<string, ReturnType<typeof createFactorCalc>>();
for (const m of all) {
  const calc = createFactorCalc(snaps, m);
  calcs.set(m, calc);
  const mp = new Map<string, number>();
  for (const [code, row] of Object.entries(snaps.get(m)!.stocks)) {
    const f = calc.factorsFor(code, row);
    if (typeof f !== "string") mp.set(code, f.yoy);
  }
  yoyMap.set(m, mp);
}
const runAbove = (code: string, m: string, x: number) => {
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const v = yoyMap.get(monthsBack(m, i))?.get(code);
    if (v === undefined || v < x) break;
    n++;
  }
  return n;
};

interface S { yoy: number; r15: number; r20: number; ys: number; hm: number; ret: number }
const B: [string, (s: S) => boolean][] = [
  ["YoY≥20（現行門檻）", (s) => s.yoy >= 0.2],
  ["YoY≥15", (s) => s.yoy >= 0.15],
  ["15≤YoY<20（差一點的）", (s) => s.yoy >= 0.15 && s.yoy < 0.2],
  ["20≤YoY<25", (s) => s.yoy >= 0.2 && s.yoy < 0.25],
  ["≥20 連1月（只有當月）", (s) => s.r20 === 1],
  ["≥20 連2月整", (s) => s.r20 === 2],
  ["≥20 連≥2月", (s) => s.r20 >= 2],
  ["≥20 連≥3月", (s) => s.r20 >= 3],
  ["≥15 連≥2月", (s) => s.r15 >= 2],
  ["≥15 連≥3月", (s) => s.r15 >= 3],
  ["≥20 + YoY>0連2月整", (s) => s.yoy >= 0.2 && s.ys === 2],
  ["≥20 + YoY>0連≥3月", (s) => s.yoy >= 0.2 && s.ys >= 3],
  ["核心(≥20,YoY>0連≥3,24高)", (s) => s.yoy >= 0.2 && s.ys >= 3 && s.hm === 24],
  ["核心但連≥2", (s) => s.yoy >= 0.2 && s.ys >= 2 && s.hm === 24],
  ["核心但門檻15", (s) => s.yoy >= 0.15 && s.ys >= 3 && s.hm === 24],
  ["15~20 + 連≥3 + 24高", (s) => s.yoy >= 0.15 && s.yoy < 0.2 && s.ys >= 3 && s.hm === 24],
];
const PAIRS: [string, string][] = [
  ["15≤YoY<20（差一點的）", "YoY≥20（現行門檻）"],
  ["15≤YoY<20（差一點的）", "20≤YoY<25"],
  ["YoY≥15", "YoY≥20（現行門檻）"],
  ["≥20 連≥3月", "≥20 連≥2月"],
  ["≥20 連2月整", "≥20 連1月（只有當月）"],
  ["≥20 連≥2月", "YoY≥20（現行門檻）"],
  ["≥20 連≥3月", "YoY≥20（現行門檻）"],
  ["≥15 連≥3月", "≥15 連≥2月"],
  ["≥15 連≥3月", "≥20 連≥3月"],
  ["≥15 連≥2月", "≥20 連≥2月"],
  ["≥20 + YoY>0連≥3月", "≥20 + YoY>0連2月整"],
  ["核心但連≥2", "核心(≥20,YoY>0連≥3,24高)"],
  ["核心但門檻15", "核心(≥20,YoY>0連≥3,24高)"],
  ["15~20 + 連≥3 + 24高", "核心(≥20,YoY>0連≥3,24高)"],
];

const months = all.filter((m) => coverageOf(snaps, m) >= MIN_COVERAGE && +m.slice(5, 7) !== 1);
const rets: Record<string, number[]> = {}, cnt: Record<string, number[]> = {}, hit: Record<string, number[]> = {};
for (const [k] of B) (rets[k] = []), (cnt[k] = []), (hit[k] = []);
const mkt: number[] = [], done: string[] = [];
for (const month of months) {
  const e = await entryOf(month), x = await entryOf(monthsBack(month, -1));
  if (!e || !x) continue;
  const calc = calcs.get(month);
  const pass: S[] = [];
  for (const [code, row] of Object.entries(snaps.get(month)!.stocks)) {
    const f = calc.factorsFor(code, row);
    if (typeof f === "string" || f.yoy < 0.15) continue;
    if (!(e[code] > 0 && x[code] > 0)) continue;
    pass.push({ yoy: f.yoy, r15: runAbove(code, month, 0.15), r20: runAbove(code, month, 0.2), ys: f.streak, hm: f.highMonths, ret: x[code] / e[code] - 1 });
  }
  if (pass.length < 20) continue;
  for (const [k, sel] of B) {
    const g = pass.filter(sel);
    cnt[k].push(g.length);
    rets[k].push(g.length >= MIN_BUCKET ? g.reduce((a, p) => a + p.ret, 0) / g.length : NaN);
    hit[k].push(g.length >= MIN_BUCKET ? g.filter((p) => p.ret > 0).length / g.length : NaN);
  }
  const mr = Object.keys(e).map((c) => (e[c] > 0 && x[c] > 0 ? x[c] / e[c] - 1 : NaN)).filter(Number.isFinite);
  mkt.push(mr.reduce((a, b) => a + b, 0) / mr.length);
  done.push(month);
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fp = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}`;
const cut = done.findIndex((m) => m >= SPLIT);
for (const [label, from, to] of [[`全期間 ${done[0]}~${done.at(-1)}`, 0, done.length], [`訓練 ~${done[cut - 1]}`, 0, cut], [`保留 ${SPLIT}~`, cut, done.length]] as [string, number, number][]) {
  console.log(`\n=== ${label}（${to - from} 月）===`);
  console.log("桶 | 平均檔數 | 月均報酬% | 超額pp | 月勝率(贏大盤) | 個股上漲比 | IR");
  for (const [k] of B) {
    const idx = [...Array(to - from).keys()].map((i) => i + from).filter((i) => Number.isFinite(rets[k][i]));
    if (idx.length < 6) { console.log(`${k} | 樣本不足`); continue; }
    const ex = idx.map((i) => rets[k][i] - mkt[i]);
    const me = avg(ex), sd = Math.sqrt(avg(ex.map((z) => (z - me) ** 2)));
    console.log(`${k} | ${avg(idx.map((i) => cnt[k][i])).toFixed(0)} | ${fp(avg(idx.map((i) => rets[k][i])))} | ${fp(me)} | ${(ex.filter((z) => z > 0).length / ex.length * 100).toFixed(0)}% | ${(avg(idx.map((i) => hit[k][i])) * 100).toFixed(1)}% | ${(me / sd * Math.sqrt(12)).toFixed(2)} (${idx.length}月)`);
  }
  console.log("配對（同月相減） | 月數 | 差pp | t | 勝月比");
  for (const [a, b] of PAIRS) {
    const d: number[] = [];
    for (let i = from; i < to; i++) if (Number.isFinite(rets[a][i]) && Number.isFinite(rets[b][i])) d.push(rets[a][i] - rets[b][i]);
    if (d.length < 6) { console.log(`${a} − ${b} | 不足`); continue; }
    const m = avg(d), sd = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / (d.length - 1));
    console.log(`${a} − ${b} | ${d.length} | ${fp(m)} | ${(m / (sd / Math.sqrt(d.length))).toFixed(2)} | ${(d.filter((v) => v > 0).length / d.length * 100).toFixed(0)}%`);
  }
}
