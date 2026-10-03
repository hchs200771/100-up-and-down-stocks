#!/usr/bin/env npx tsx
/**
 * revenue.html 下拉選單的「全組合」回測：哪一組預設值最好？
 *
 * 把頁面上能回測的四個下拉全部排列組合跑一遍：
 *   營收 YoY 門檻 × 標記（門檻／核心／動能／兩者皆中）× 營收創高 × 毛利率
 * 再加一維「站上月線」（進場日收盤 > MA20），MA20 用進場日往回 20 個交易日的收盤（data/cache 已補齊逐日）。
 * 20 日報酬那個下拉沒放進格子——跟月線高度重疊，多一維只會讓組合數翻倍。
 *
 * ## 怎麼選「最好」——不是報酬最高
 *
 * 288 組裡挑報酬最高的那組，幾乎保證是過度配適：條件疊越多、檔數越少、
 * 越容易被幾檔飆股撐出漂亮數字。所以這裡的選法是：
 *   1. 平均檔數 ≥ MIN_AVG_N（不夠分散的不看）、有效月份 ≥ MIN_MONTHS
 *   2. 前半段與後半段的超額都要 > 0（一半靠運氣的淘汰）
 *   3. 剩下的按穩定度（年化 IR）排，不按報酬排
 * 時間軸與 backtest-revenue-momentum.ts 一致（次月 11 日進場、持有一個月），
 * 季報只用「進場日當時申報期限已過」的那一季。
 *
 * 用法：npx tsx scripts/backtest-filter-grid.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadSnapshots, coverageOf, createFactorCalc, screen, MIN_COVERAGE, GATE_YOY } from "./lib/revenue-factors";
import { closesOn, isTradingDay } from "./lib/twse-closes";
import { loadFinancials, latestPublishedQuarter, prevQuarter, marginOf, marginSeries } from "./lib/gross-margin";
import { twIso } from "./lib/time";

const ROOT = process.cwd();
const MIN_BUCKET = 5;
const MIN_AVG_N = 15;
const MIN_MONTHS = 50;
const MA = 20;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
async function closesOnOrAfter(y: number, m: number, d: number): Promise<{ date: string; closes: Record<string, number> } | null> {
  for (let i = 0; i < 8; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    if (dt.getTime() > Date.now()) return null;
    const date = ymd(dt);
    const closes = await closesOn(date, ROOT);
    if (isTradingDay(closes)) return { date, closes };
  }
  return null;
}
const entryOf = (month: string) => {
  const next = monthsBack(month, -1);
  return closesOnOrAfter(+next.slice(0, 4), +next.slice(5, 7), 11);
};

/** 進場日（含）往回 MA 個交易日的收盤，由新到舊 */
async function trailingCloses(entry: string): Promise<Record<string, number>[]> {
  const out: Record<string, number>[] = [];
  const d0 = Date.UTC(+entry.slice(0, 4), +entry.slice(4, 6) - 1, +entry.slice(6, 8));
  for (let i = 0; out.length < MA && i < 45; i++) {
    const c = await closesOn(ymd(new Date(d0 - i * 86400000)), ROOT);
    if (isTradingDay(c)) out.push(c);
  }
  return out;
}

interface Row { yoy: number; core: boolean; mom: boolean; h24: boolean; ath: boolean; gmQ: number | null; gmHigh4: boolean; aboveMa: boolean | null; ret: number }

/** 四個維度，值就是頁面 <select> 的 value，方便直接對回 UI */
const DIMS = {
  yoy: [["0.2", "≥20%"], ["0.3", "≥30%"], ["0.4", "≥40%"], ["0.5", "≥50%"]],
  tier: [["核心·動能,核心,動能,門檻", "門檻群"], ["核心·動能,核心", "核心"], ["核心·動能,動能", "動能"], ["核心·動能", "兩者皆中"]],
  high: [["", "不限"], ["h24", "2年以上新高"], ["ath", "5年新高"]],
  gm: [["", "不限"], ["up", "毛利率成長"], ["high4", "毛利率4季高"]],
  ma: [["", "不限"], ["above", "站上月線"]],
} as const;

const pick = (r: Row, yoy: string, tier: string, high: string, gm: string, ma: string): boolean => {
  if (r.yoy < +yoy) return false;
  if (tier === "核心·動能,核心" && !r.core) return false;
  if (tier === "核心·動能,動能" && !r.mom) return false;
  if (tier === "核心·動能" && !(r.core && r.mom)) return false;
  if (high === "h24" && !(r.h24 || r.ath)) return false;
  if (high === "ath" && !r.ath) return false;
  if (gm === "up" && !(r.gmQ !== null && r.gmQ > 0)) return false;
  if (gm === "high4" && !r.gmHigh4) return false;
  if (ma === "above" && r.aboveMa !== true) return false;
  return true;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function main() {
  const snaps = loadSnapshots(ROOT);
  const fin = loadFinancials(ROOT);
  const months = [...snaps.keys()].sort().filter((m) => coverageOf(snaps, m) >= MIN_COVERAGE && +m.slice(5, 7) !== 1);

  const monthly: { month: string; mkt: number; rows: Row[] }[] = [];
  for (const month of months) {
    const e = await entryOf(month);
    const x = await entryOf(monthsBack(month, -1));
    if (!e || !x) continue;
    const asOf = new Date(Date.UTC(+e.date.slice(0, 4), +e.date.slice(4, 6) - 1, +e.date.slice(6, 8)));
    const q = latestPublishedQuarter(asOf, fin);
    if (!q) continue;
    const hist = await trailingCloses(e.date);
    if (hist.length < MA) continue;
    const calc = createFactorCalc(snaps, month);
    const rows: Row[] = [];
    for (const [code, row] of Object.entries(snaps.get(month)!.stocks)) {
      const f = calc.factorsFor(code, row);
      if (typeof f === "string") continue;
      const s = screen(f, GATE_YOY);
      if (!s) continue;
      const a = e.closes[code], b = x.closes[code];
      if (!(a > 0 && b > 0)) continue;
      const gm = marginOf(code, q, fin), gmP = marginOf(code, prevQuarter(q), fin);
      const ser = marginSeries(code, q, 4, fin);
      const px = hist.map((h) => h[code]).filter((v) => v > 0);
      const ma = px.length === MA ? px.reduce((t, v) => t + v, 0) / MA : null;
      rows.push({
        yoy: f.yoy, core: s.tier === "核心", mom: s.momentum, h24: f.highMonths === 24, ath: f.allTimeHigh,
        gmQ: gm !== null && gmP !== null ? gm - gmP : null,
        gmHigh4: gm !== null && ser.every((v) => v !== null) && ser.slice(1).every((v) => v! < gm),
        aboveMa: ma === null ? null : a > ma,
        ret: b / a - 1,
      });
    }
    if (rows.length < 20 || !rows.some((r) => r.gmQ !== null)) continue;
    const mkt = avg(Object.keys(e.closes).map((c) => (e.closes[c] > 0 && x.closes[c] > 0 ? x.closes[c] / e.closes[c] - 1 : NaN)).filter(Number.isFinite));
    monthly.push({ month, mkt, rows });
    process.stdout.write(`\r${month} 門檻 ${rows.length} 檔   `);
  }
  console.log(`\n${monthly.length} 個月（${monthly[0].month} ~ ${monthly.at(-1)!.month}）`);
  const half = Math.floor(monthly.length / 2);

  interface Result { yoy: string; tier: string; high: string; gm: string; ma: string; label: string; months: number; avgN: number; excess: number; win: number; ir: number; exFirst: number; exSecond: number; ok: boolean }
  const results: Result[] = [];
  for (const [yoy, ly] of DIMS.yoy) for (const [tier, lt] of DIMS.tier) for (const [high, lh] of DIMS.high) for (const [gm, lg] of DIMS.gm) for (const [ma, lm] of DIMS.ma) {
    const ex: (number | null)[] = [];
    const ns: number[] = [];
    for (const m of monthly) {
      const xs = m.rows.filter((r) => pick(r, yoy, tier, high, gm, ma)).map((r) => r.ret);
      ns.push(xs.length);
      ex.push(xs.length >= MIN_BUCKET ? avg(xs) - m.mkt : null);
    }
    const idx = ex.map((_, i) => i).filter((i) => ex[i] !== null);
    if (idx.length < 12) continue;
    const e = idx.map((i) => ex[i]!);
    const me = avg(e);
    const sd = Math.sqrt(avg(e.map((z) => (z - me) ** 2)));
    const first = idx.filter((i) => i < half).map((i) => ex[i]!), second = idx.filter((i) => i >= half).map((i) => ex[i]!);
    const r: Result = {
      yoy, tier, high, gm, ma, label: [ly, lt, lh, lg, lm].join(" × "),
      months: idx.length, avgN: avg(idx.map((i) => ns[i])), excess: me, win: e.filter((z) => z > 0).length / e.length, ir: (me / sd) * Math.sqrt(12),
      exFirst: avg(first), exSecond: avg(second), ok: false,
    };
    r.ok = r.avgN >= MIN_AVG_N && r.months >= MIN_MONTHS && r.exFirst > 0 && r.exSecond > 0;
    results.push(r);
  }
  results.sort((a, b) => b.ir - a.ir);
  const f = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
  const line = (r: Result) => `  ${r.label.padEnd(44)} ${String(r.months).padStart(3)}  ${r.avgN.toFixed(0).padStart(4)}  ${f(r.excess).padStart(7)}  ${(r.win * 100).toFixed(0).padStart(3)}%  ${r.ir.toFixed(2).padStart(5)}   前半 ${f(r.exFirst).padStart(7)} / 後半 ${f(r.exSecond).padStart(7)}`;

  console.log(`\n=== 合格（均檔 ≥ ${MIN_AVG_N}、月數 ≥ ${MIN_MONTHS}、前後半段都為正）依穩定度排序 ===`);
  console.log("  組合".padEnd(46) + "月數  均檔    超額   勝率  穩定度");
  const ok = results.filter((r) => r.ok);
  ok.slice(0, 15).forEach((r) => console.log(line(r)));
  console.log(`\n=== 不合格但穩定度最高的前 8（給你看「太集中」長什麼樣） ===`);
  results.filter((r) => !r.ok).slice(0, 8).forEach((r) => console.log(line(r)));
  console.log(`\n=== 超額報酬最高的前 8（不論合格）——通常就是過度配適的長相 ===`);
  [...results].sort((a, b) => b.excess - a.excess).slice(0, 8).forEach((r) => console.log(line(r)));

  writeFileSync(resolve(ROOT, "data/revenue-filter-grid-backtest.json"), JSON.stringify({
    generatedAt: twIso(), months: monthly.map((m) => m.month), rules: { MIN_BUCKET, MIN_AVG_N, MIN_MONTHS },
    best: ok[0] ?? null, qualified: ok, all: results,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
