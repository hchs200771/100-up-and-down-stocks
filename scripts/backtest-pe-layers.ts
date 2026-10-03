#!/usr/bin/env npx tsx
/**
 * 本益比濾網的分層回測：月營收門檻（＋毛利率）之上，再限制本益比有沒有用？
 *
 * 本益比＝進場日收盤 ÷ 近四季 EPS（TTM）。EPS 只用「進場日當時申報期限已過」的那一季
 * 往回推四季，跟 backtest-margin-layers.ts 同一套防偷看規則。
 * MOPS 的 EPS 是累計數：TTM = 累計Qn + 去年累計Q4 − 去年累計Qn（Qn 為 Q4 時就是累計Q4）。
 *
 * 絕對門檻（<15、<20）之外也看池內相對分位（低/高 1/3），因為整體市場本益比會隨年份漂移。
 *
 * 前提：financials-history 要有 eps 欄位（fetch-quarterly-financials.ts --force 重抓）。
 * 用法：npx tsx scripts/backtest-pe-layers.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FinSnapshot } from "./fetch-quarterly-financials";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadSnapshots, coverageOf, createFactorCalc, screen, MIN_COVERAGE } from "./lib/revenue-factors";
import { closesOn, isTradingDay } from "./lib/twse-closes";
import { loadFinancials, latestPublishedQuarter, prevQuarter, marginOf } from "./lib/gross-margin";
import { twIso } from "./lib/time";

const ROOT = process.cwd();
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

/** 近四季 EPS。缺任何一季就回 null */
function ttmEps(code: string, q: string, fin: Map<string, FinSnapshot>): number | null {
  const cum = (qq: string) => fin.get(qq)?.stocks[code]?.eps ?? null;
  const now = cum(q);
  if (now === null) return null;
  if (q.endsWith("Q4")) return now;
  const y = +q.slice(0, 4) - 1;
  const lastQ4 = cum(`${y}Q4`);
  const lastSame = cum(`${y}${q.slice(4)}`);
  return lastQ4 === null || lastSame === null ? null : now + lastQ4 - lastSame;
}

interface Row {
  core: boolean;
  gmUp: boolean;
  ret: number;
  /** null＝EPS 缺；虧損（TTM EPS≤0）為 Infinity */
  pe: number | null;
  /** 池內本益比分位 0..1（只對獲利股），在分池後才算 */
  rank?: number;
}

type Pick = (r: Row) => boolean;
const pe = (lo: number, hi: number): Pick => (r) => r.pe !== null && r.pe >= lo && r.pe < hi;

const BUCKETS: [string, Pick][] = [
  ["全部", () => true],
  ["有 EPS", (r) => r.pe !== null],
  ["虧損 (EPS≤0)", (r) => r.pe === Infinity],
  ["PE < 10", pe(0, 10)],
  ["PE 10-15", pe(10, 15)],
  ["PE 15-20", pe(15, 20)],
  ["PE 20-30", pe(20, 30)],
  ["PE 30-50", pe(30, 50)],
  ["PE ≥ 50", pe(50, Infinity)],
  ["PE < 15", pe(0, 15)],
  ["PE < 20", pe(0, 20)],
  ["PE ≥ 20（含虧損）", (r) => r.pe !== null && r.pe >= 20],
  ["池內 PE 低 1/3", (r) => r.rank !== undefined && r.rank < 1 / 3],
  ["池內 PE 中 1/3", (r) => r.rank !== undefined && r.rank >= 1 / 3 && r.rank < 2 / 3],
  ["池內 PE 高 1/3", (r) => r.rank !== undefined && r.rank >= 2 / 3],
];

const TIERS = ["門檻", "門檻+毛利↑", "核心", "核心+毛利↑"] as const;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function withRank(pool: Row[]): Row[] {
  const prof = pool.filter((r) => r.pe !== null && r.pe !== Infinity).sort((a, b) => a.pe! - b.pe!);
  const rk = new Map(prof.map((r, i) => [r, prof.length > 1 ? i / prof.length : 0]));
  return pool.map((r) => ({ ...r, rank: rk.get(r) }));
}

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
      const eps = ttmEps(code, q, fin);
      rows.push({ core: s.tier === "核心", gmUp: gm !== null && gmP !== null && gm > gmP, ret: b / a - 1, pe: eps === null ? null : eps <= 0 ? Infinity : a / eps });
    }
    if (rows.length < 20 || rows.every((r) => r.pe === null)) continue;

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
      const pool = withRank(pools[t]);
      for (const [k, pick] of BUCKETS) {
        const xs = pool.filter(pick).map((r) => r.ret);
        counts[t][k].push(xs.length);
        series[t][k].push(xs.length >= MIN_BUCKET ? avg(xs) : null);
      }
    }
    const med = rows.map((r) => r.pe).filter((v): v is number => v !== null && v !== Infinity).sort((a, b) => a - b);
    console.log(`${month} 季報 ${q}  門檻 ${String(rows.length).padStart(3)} 檔  PE 中位數 ${med[Math.floor(med.length / 2)]?.toFixed(1) ?? "—"}`);
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
      console.log(`  ${k.padEnd(20)} ${String(st.months).padStart(3)}  ${st.avgN.toFixed(0).padStart(4)}  ${f(st.mean).padStart(7)}  ${f(st.excess).padStart(7)}  ${(st.win * 100).toFixed(0).padStart(4)}%  ${st.ir.toFixed(2).padStart(6)}`);
    }
  }
  console.log(`\n  籃子當月不足 ${MIN_BUCKET} 檔就不計入該月，所以各列的「月數」可能不同，比較時先看月數。`);
  writeFileSync(resolve(ROOT, "data/pe-layers-backtest.json"), JSON.stringify({ generatedAt: twIso(), months: done, mkt, summary, series, counts }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
