#!/usr/bin/env npx tsx
/**
 * 乖離率濾網的分層回測：月營收門檻（＋毛利率）之上，「已經漲多」的股票勝率會不會下降？
 *
 * 乖離率＝進場日收盤 ÷ MA20 − 1。MA20 用進場日（含）往回 20 個交易日的收盤，
 * 進場當天收盤就知道，不偷看未來。收盤價未還原除權息，除息日附近會略為低估乖離。
 *
 * 要抓每個進場日前約一個月的日收盤，第一次跑會慢（抓過的日子存在 data/cache）。
 * 用法：npx tsx scripts/backtest-bias-layers.ts
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadSnapshots, coverageOf, createFactorCalc, screen, MIN_COVERAGE } from "./lib/revenue-factors";
import { closesOn, isTradingDay } from "./lib/twse-closes";
import { loadFinancials, latestPublishedQuarter, prevQuarter, marginOf } from "./lib/gross-margin";
import { twIso } from "./lib/time";

const ROOT = process.cwd();
const MIN_BUCKET = 5;
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

/** 抓沒快取的日子要放慢，TWSE 打太快會被擋 */
async function closesThrottled(date: string): Promise<Record<string, number>> {
  const cached = existsSync(resolve(ROOT, "data/cache", `close-${date}.json`));
  const c = await closesOn(date, ROOT);
  if (!cached) await new Promise((r) => setTimeout(r, 1200));
  return c;
}

/** 進場日（含）往回 MA 個交易日的收盤，由新到舊 */
async function trailingCloses(entry: string): Promise<Record<string, number>[]> {
  const out: Record<string, number>[] = [];
  const d0 = new Date(Date.UTC(+entry.slice(0, 4), +entry.slice(4, 6) - 1, +entry.slice(6, 8)));
  for (let i = 0; out.length < MA && i < 45; i++) {
    const c = await closesThrottled(ymd(new Date(d0.getTime() - i * 86400000)));
    if (isTradingDay(c)) out.push(c);
  }
  return out;
}
const entryOf = (month: string) => {
  const next = monthsBack(month, -1);
  return closesOnOrAfter(+next.slice(0, 4), +next.slice(5, 7), 11);
};

interface Row {
  core: boolean;
  gmUp: boolean;
  ret: number;
  /** 乖離率（小數），算不出來為 null */
  bias: number | null;
}

type Pick = (r: Row) => boolean;
const bias = (lo: number, hi: number): Pick => (r) => r.bias !== null && r.bias >= lo && r.bias < hi;

const BUCKETS: [string, Pick][] = [
  ["全部", () => true],
  ["月線下 (<0%)", bias(-Infinity, 0)],
  ["乖離 0-5%", bias(0, 0.05)],
  ["乖離 5-10%", bias(0.05, 0.1)],
  ["乖離 10-15%", bias(0.1, 0.15)],
  ["乖離 15-20%", bias(0.15, 0.2)],
  ["乖離 ≥ 20%", bias(0.2, Infinity)],
  ["月線上 (≥0%)", bias(0, Infinity)],
  ["月線上且 <10%", bias(0, 0.1)],
  ["月線上且 <15%", bias(0, 0.15)],
  ["乖離 < 10%（含月線下）", bias(-Infinity, 0.1)],
  ["乖離 < 15%（含月線下）", bias(-Infinity, 0.15)],
];

const TIERS = ["門檻", "門檻+毛利↑", "核心", "核心+毛利↑"] as const;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function main() {
  const snaps = loadSnapshots(ROOT);
  const fin = loadFinancials(ROOT);
  const months = [...snaps.keys()].sort().filter((m) => coverageOf(snaps, m) >= MIN_COVERAGE && +m.slice(5, 7) !== 1);

  const series: Record<string, Record<string, (number | null)[]>> = {};
  const counts: Record<string, Record<string, number[]>> = {};
  for (const t of TIERS) { series[t] = {}; counts[t] = {}; for (const [k] of BUCKETS) { series[t][k] = []; counts[t][k] = []; } }
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
    const hist = await trailingCloses(e.date);

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
      const px = hist.map((h) => h[code]).filter((v) => v > 0);
      const ma = px.length === MA ? px.reduce((s, v) => s + v, 0) / MA : null;
      rows.push({ core: s.tier === "核心", gmUp: gm !== null && gmP !== null && gm > gmP, ret: b / a - 1, bias: ma ? a / ma - 1 : null });
    }
    if (rows.length < 20 || hist.length < MA) continue;

    const m = avg(Object.keys(e.closes).map((c) => (e.closes[c] > 0 && x.closes[c] > 0 ? x.closes[c] / e.closes[c] - 1 : NaN)).filter(Number.isFinite));
    mkt.push(m);
    done.push(month);
    const pools: Record<string, Row[]> = {
      門檻: rows,
      "門檻+毛利↑": rows.filter((r) => r.gmUp),
      核心: rows.filter((r) => r.core),
      "核心+毛利↑": rows.filter((r) => r.core && r.gmUp),
    };
    for (const t of TIERS) {
      const pool = pools[t];
      for (const [k, pick] of BUCKETS) {
        const xs = pool.filter(pick).map((r) => r.ret);
        counts[t][k].push(xs.length);
        series[t][k].push(xs.length >= MIN_BUCKET ? avg(xs) : null);
      }
    }
    const med = rows.map((r) => r.bias).filter((v): v is number => v !== null).sort((a, b) => a - b);
    console.log(`${month} 進場 ${e.date}  門檻 ${String(rows.length).padStart(3)} 檔  乖離中位數 ${med.length ? (med[Math.floor(med.length / 2)] * 100).toFixed(1) + "%" : "—"}`);
  }

  const f = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
  const summary: Record<string, Record<string, object>> = {};
  console.log(`\n=== ${mkt.length} 個月（${done[0]} ~ ${done.at(-1)}）每月 11 日進場、持有一個月；全市場等權月均 ${f(avg(mkt))} ===`);
  for (const t of TIERS) {
    summary[t] = {};
    console.log(`\n[${t}]`.padEnd(24) + "月數  均檔   月均      超額    勝率  年化IR");
    for (const [k] of BUCKETS) {
      const v = series[t][k];
      const idx = v.map((_, i) => i).filter((i) => v[i] !== null);
      if (!idx.length) continue;
      const ex = idx.map((i) => v[i]! - mkt[i]);
      const me = avg(ex);
      const sd = Math.sqrt(avg(ex.map((z) => (z - me) ** 2)));
      const st = { months: idx.length, avgN: avg(idx.map((i) => counts[t][k][i])), mean: avg(idx.map((i) => v[i]!)), excess: me, win: ex.filter((z) => z > 0).length / ex.length, ir: (me / sd) * Math.sqrt(12) };
      summary[t][k] = st;
      console.log(`  ${k.padEnd(22)} ${String(st.months).padStart(3)}  ${st.avgN.toFixed(0).padStart(4)}  ${f(st.mean).padStart(7)}  ${f(st.excess).padStart(7)}  ${(st.win * 100).toFixed(0).padStart(4)}%  ${st.ir.toFixed(2).padStart(6)}`);
    }
  }
  console.log(`\n  籃子當月不足 ${MIN_BUCKET} 檔就不計入該月，所以各列的「月數」可能不同，比較時先看月數。`);
  writeFileSync(resolve(ROOT, "data/bias-layers-backtest.json"), JSON.stringify({ generatedAt: twIso(), months: done, mkt, summary, series, counts }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
