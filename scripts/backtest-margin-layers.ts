#!/usr/bin/env npx tsx
/**
 * 季報品質濾網的分層回測：毛利率 vs 營業利益率，誰該當第二層？
 *
 * 前提：revenue-history（月營收）與 financials-history（季報，要有 op 欄位）都補齊。
 *
 * 問題：月營收門檻之上，再用「最新一季毛利率比上季升／降」分兩堆已知有差
 * （升的那堆報酬約是降的兩倍）。營業利益率多扣了營業費用，理論上能再濾掉
 * 「毛利升但費用暴增」——但費用暴增也可能是擴張前置投資，所以不能想當然，要拆開看：
 *   毛利↑&OPM↑ / 毛利↑&OPM↓ / 毛利↓&OPM↑ / 毛利↓&OPM↓
 * 如果「毛利↑&OPM↓」明顯輸「毛利↑&OPM↑」，OPM 才值得升格成條件。
 *
 * 時間軸與 backtest-revenue-momentum.ts 完全一致（次月 11 日進場、持有一個月），
 * 季報只用「進場日當時申報期限已過」的那一季——lib/gross-margin.ts 的 latestPublishedQuarter。
 *
 * 用法：npx tsx scripts/backtest-margin-layers.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadSnapshots, coverageOf, createFactorCalc, screen, MIN_COVERAGE } from "./lib/revenue-factors";
import { closesOn, isTradingDay } from "./lib/twse-closes";
import { loadFinancials, latestPublishedQuarter, prevQuarter, marginOf, opMarginOf, marginSeries } from "./lib/gross-margin";
import { twIso } from "./lib/time";

const ROOT = process.cwd();
/** 某個籃子當月至少要有幾檔才算數，太少就是雜訊 */
const MIN_BUCKET = 5;

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

interface Row {
  core: boolean;
  ret: number;
  /** 毛利率 QoQ（pp），算不出來為 null */
  gmQ: number | null;
  /** 營業利益率 QoQ */
  opQ: number | null;
  /** 營業利益率 YoY（vs 去年同季） */
  opY: number | null;
  /** 單季毛利率是否為近 4 季最高 */
  gmHigh4: boolean;
}

type Pick = (r: Row) => boolean;
const up = (v: number | null) => v !== null && v > 0;
const dn = (v: number | null) => v !== null && v < 0;

/** 籃子定義。順序就是輸出順序 */
const BUCKETS: [string, Pick][] = [
  ["全部", () => true],
  ["有季報資料", (r) => r.gmQ !== null && r.opQ !== null],
  ["毛利↑", (r) => up(r.gmQ)],
  ["毛利↓", (r) => dn(r.gmQ)],
  ["毛利創4季新高", (r) => r.gmHigh4],
  ["OPM↑", (r) => up(r.opQ)],
  ["OPM↓", (r) => dn(r.opQ)],
  ["毛利↑ & OPM↑", (r) => up(r.gmQ) && up(r.opQ)],
  ["毛利↑ & OPM↓", (r) => up(r.gmQ) && dn(r.opQ)],
  ["毛利↓ & OPM↑", (r) => dn(r.gmQ) && up(r.opQ)],
  ["毛利↓ & OPM↓", (r) => dn(r.gmQ) && dn(r.opQ)],
  ["OPM YoY↑", (r) => up(r.opY)],
  ["OPM YoY↓", (r) => dn(r.opY)],
  ["OPM↑ & OPM YoY↑", (r) => up(r.opQ) && up(r.opY)],
  ["毛利↑ & OPM YoY↑", (r) => up(r.gmQ) && up(r.opY)],
];

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function main() {
  const snaps = loadSnapshots(ROOT);
  const fin = loadFinancials(ROOT);
  if (!snaps.size || !fin.size) {
    console.error("revenue-history 或 financials-history 是空的");
    process.exit(1);
  }
  const months = [...snaps.keys()].sort().filter((m) => coverageOf(snaps, m) >= MIN_COVERAGE && +m.slice(5, 7) !== 1);

  /** [tier][bucket] → 每月平均報酬（null＝當月籃子太小） */
  const series: Record<string, Record<string, (number | null)[]>> = { 門檻: {}, 核心: {} };
  const counts: Record<string, Record<string, number[]>> = { 門檻: {}, 核心: {} };
  for (const t of ["門檻", "核心"]) for (const [k] of BUCKETS) { series[t][k] = []; counts[t][k] = []; }
  const mkt: number[] = [];
  const done: string[] = [];

  for (const month of months) {
    const e = await entryOf(month);
    const x = await entryOf(monthsBack(month, -1));
    if (!e || !x) continue;
    const asOf = new Date(Date.UTC(+e.date.slice(0, 4), +e.date.slice(4, 6) - 1, +e.date.slice(6, 8)));
    const q = latestPublishedQuarter(asOf, fin);
    if (!q) continue;
    const q1 = prevQuarter(q);
    const q4 = prevQuarter(prevQuarter(prevQuarter(q1)));
    // 兩季都要算得出來，不然 QoQ 是空的；這個月連一檔都算不出來就代表資料還沒到，跳過
    let any = false;

    const calc = createFactorCalc(snaps, month);
    const rows: Row[] = [];
    for (const [code, row] of Object.entries(snaps.get(month)!.stocks)) {
      const f = calc.factorsFor(code, row);
      if (typeof f === "string") continue;
      const s = screen(f);
      if (!s) continue;
      const a = e.closes[code];
      const b = x.closes[code];
      if (!(a > 0 && b > 0)) continue;
      const gm = marginOf(code, q, fin), gmP = marginOf(code, q1, fin);
      const op = opMarginOf(code, q, fin), opP = opMarginOf(code, q1, fin), opY = opMarginOf(code, q4, fin);
      const gmQ = gm !== null && gmP !== null ? gm - gmP : null;
      const opQ = op !== null && opP !== null ? op - opP : null;
      if (gmQ !== null && opQ !== null) any = true;
      const ser = marginSeries(code, q, 4, fin);
      const gmHigh4 = gm !== null && ser.every((v) => v !== null) && ser.slice(1).every((v) => v! < gm);
      rows.push({ core: s.tier === "核心", ret: b / a - 1, gmQ, opQ, opY: op !== null && opY !== null ? op - opY : null, gmHigh4 });
    }
    if (rows.length < 20 || !any) continue;

    const m = avg(Object.keys(e.closes).map((c) => (e.closes[c] > 0 && x.closes[c] > 0 ? x.closes[c] / e.closes[c] - 1 : NaN)).filter(Number.isFinite));
    mkt.push(m);
    done.push(month);
    for (const [tier, pool] of [["門檻", rows], ["核心", rows.filter((r) => r.core)]] as const) {
      for (const [k, pick] of BUCKETS) {
        const xs = pool.filter(pick).map((r) => r.ret);
        counts[tier][k].push(xs.length);
        series[tier][k].push(xs.length >= MIN_BUCKET ? avg(xs) : null);
      }
    }
    const g = (t: string, k: string) => series[t][k].at(-1);
    const fp = (v: number | null | undefined) => (v === null || v === undefined ? "   —  " : `${(v * 100).toFixed(1).padStart(6)}%`);
    console.log(`${month} 季報 ${q}  門檻 ${String(rows.length).padStart(3)} 檔  毛利↑ ${fp(g("門檻", "毛利↑"))}  毛利↑&OPM↑ ${fp(g("門檻", "毛利↑ & OPM↑"))}  毛利↑&OPM↓ ${fp(g("門檻", "毛利↑ & OPM↓"))}  市場 ${fp(m)}`);
  }

  if (!mkt.length) { console.error("沒有任何月份可回測"); process.exit(1); }
  const f = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
  const summary: Record<string, Record<string, { months: number; avgN: number; mean: number; excess: number; win: number; ir: number }>> = { 門檻: {}, 核心: {} };

  console.log(`\n=== ${mkt.length} 個月（${done[0]} ~ ${done[done.length - 1]}）每月 11 日進場、持有一個月；全市場等權月均 ${f(avg(mkt))} ===`);
  for (const tier of ["門檻", "核心"] as const) {
    console.log(`\n[${tier}]`.padEnd(24) + "月數  均檔   月均      超額    勝率  年化IR");
    for (const [k] of BUCKETS) {
      const v = series[tier][k];
      const idx = v.map((_, i) => i).filter((i) => v[i] !== null);
      if (!idx.length) continue;
      const ex = idx.map((i) => v[i]! - mkt[i]);
      const me = avg(ex);
      const sd = Math.sqrt(avg(ex.map((z) => (z - me) ** 2)));
      const st = { months: idx.length, avgN: avg(idx.map((i) => counts[tier][k][i])), mean: avg(idx.map((i) => v[i]!)), excess: me, win: ex.filter((z) => z > 0).length / ex.length, ir: (me / sd) * Math.sqrt(12) };
      summary[tier][k] = st;
      console.log(`  ${k.padEnd(20)} ${String(st.months).padStart(3)}  ${st.avgN.toFixed(0).padStart(4)}  ${f(st.mean).padStart(7)}  ${f(st.excess).padStart(7)}  ${(st.win * 100).toFixed(0).padStart(4)}%  ${st.ir.toFixed(2).padStart(6)}`);
    }
  }
  console.log(`\n  籃子當月不足 ${MIN_BUCKET} 檔就不計入該月，所以各列的「月數」可能不同，比較時先看月數。`);
  writeFileSync(resolve(ROOT, "data/margin-layers-backtest.json"), JSON.stringify({ generatedAt: twIso(), months: done, mkt, summary, series, counts }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
