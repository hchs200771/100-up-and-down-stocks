#!/usr/bin/env npx tsx
/**
 * 月營收篩選規則的 in-sample 回測。
 *
 * 前提：先跑過 npx tsx scripts/fetch-monthly-revenue.ts --months 36
 * （直接從 revenue-history 重算因子，不依賴 revenue-momentum-history）。
 *
 * 這支的用途不只是「看策略賺不賺」，而是**比較規則變體**——當初就是它證明了
 * 門檻內排名沒有資訊（隨機取 15 檔打敗所有排序法），才決定整套改成純篩選。
 * 之後想動門檻（20% 改 15% 或 30%）或加確認條件，回到這裡先跑過再說。
 *
 * ## 時間軸（不能偷看未來）
 *
 * N 月營收在 (N+1) 月 10 日前公布，所以榜單最早能在 **(N+1) 月 11 日**拿到。
 *   進場 = (N+1) 月 11 日之後第一個交易日的收盤
 *   出場 = (N+2) 月 11 日之後第一個交易日的收盤（持有一個月，跟下次營收公布對齊）
 * 用 11 日而不是 10 日，是因為 10 日當天可能還有公司在收盤後才報。
 *
 * ## 基準
 *
 * 「等權全市場」＝ 當月有評分的所有股票的等權平均報酬。用等權而不是加權指數，
 * 因為策略本身是等權選股，拿市值加權指數比會把「小型股溢酬」誤算成策略的功勞。
 *
 * 價格用 TWSE MI_INDEX / TPEx dailyQuotes 的單日全市場收盤，一天一個請求，
 * 快取在 data/cache/close-<YYYYMMDD>.json，重跑不會重抓。
 *
 * 用法：npx tsx scripts/backtest-revenue-momentum.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadSnapshots, coverageOf, createFactorCalc, MIN_COVERAGE, GATE_YOY } from "./lib/revenue-factors";
import { closesOn, isTradingDay } from "./lib/twse-closes";

import { twIso } from "./lib/time";
const ROOT = process.cwd();
/** 集中度測試用：從門檻內取幾檔 */
const CONCENTRATED_N = 15;
/** 隨機抽樣重複次數——單次抽樣的運氣成分太大，取多次平均才看得出排序有沒有資訊 */
const DRAWS = 500;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

/** 從某個日期往後找第一個有資料的交易日（最多找 8 天，跨得過連假） */
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

/** 營收月份 → 進場日（次月 11 日之後第一個交易日） */
const entryOf = (month: string) => {
  const next = monthsBack(month, -1);
  return closesOnOrAfter(+next.slice(0, 4), +next.slice(5, 7), 11);
};

async function main() {
  const snaps = loadSnapshots(ROOT);
  if (!snaps.size) {
    console.error("data/revenue-history 是空的，先跑 fetch-monthly-revenue.ts --months 36");
    process.exit(1);
  }
  // 只回測「已公布完」的月份；1 月不出名單（農曆年錯位，見 build-revenue-momentum.ts）
  const months = [...snaps.keys()].sort().filter((m) => coverageOf(snaps, m) >= MIN_COVERAGE && +m.slice(5, 7) !== 1);

  const variants: Record<string, (number | null)[]> = {
    "門檻全部等權": [], "門檻+連3月": [], "門檻+連3月+24月新高": [],
    "隨機15檔": [], "按YoY取前15": [], "按加速度取前15": [], "全市場等權": [],
  };
  const sizes: Record<string, number[]> = { 門檻: [], 連3月: [], 核心: [] };
  /** 真的評到的月份（最後一兩個月因為還沒到出場日會被跳過） */
  const done: string[] = [];
  const push = (k: string, v: number | null) => variants[k].push(v);

  // 固定種子的 LCG：回測結果要能重現，不能每次跑出不同的隨機組合
  let seed = 20260907;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  for (const month of months) {
    const e = await entryOf(month);
    const x = await entryOf(monthsBack(month, -1));
    if (!e || !x) continue;

    const calc = createFactorCalc(snaps, month);
    const pass: { yoy: number; accel: number | null; streak: number; highMonths: number; ret: number }[] = [];
    for (const [code, row] of Object.entries(snaps.get(month)!.stocks)) {
      const f = calc.factorsFor(code, row);
      if (typeof f === "string" || f.yoy < GATE_YOY) continue;
      const a = e.closes[code];
      const b = x.closes[code];
      if (!(a > 0 && b > 0)) continue;
      pass.push({ yoy: f.yoy, accel: f.accel, streak: f.streak, highMonths: f.highMonths, ret: b / a - 1 });
    }
    if (pass.length < 20) continue;

    const s3 = pass.filter((p) => p.streak >= 3);
    const core = s3.filter((p) => p.highMonths === 24);
    sizes.門檻.push(pass.length);
    sizes.連3月.push(s3.length);
    sizes.核心.push(core.length);
    done.push(month);

    const draws: number[] = [];
    for (let t = 0; t < DRAWS; t++) {
      const pool = [...pass];
      let acc = 0;
      for (let i = 0; i < CONCENTRATED_N; i++) acc += pool.splice(Math.floor(rnd() * pool.length), 1)[0].ret;
      draws.push(acc / CONCENTRATED_N);
    }
    const byYoy = [...pass].sort((a, b) => b.yoy - a.yoy);
    const byAccel = pass.filter((p) => p.accel !== null).sort((a, b) => b.accel! - a.accel!);

    push("門檻全部等權", avg(pass.map((p) => p.ret)));
    push("門檻+連3月", avg(s3.map((p) => p.ret)));
    push("門檻+連3月+24月新高", core.length >= 8 ? avg(core.map((p) => p.ret)) : null);
    push("隨機15檔", avg(draws));
    push("按YoY取前15", avg(byYoy.slice(0, CONCENTRATED_N).map((p) => p.ret)));
    push("按加速度取前15", avg(byAccel.slice(0, CONCENTRATED_N).map((p) => p.ret)));
    push("全市場等權", avg(Object.keys(e.closes).map((c) => (e.closes[c] > 0 && x.closes[c] > 0 ? x.closes[c] / e.closes[c] - 1 : NaN)).filter((v) => Number.isFinite(v))));

    console.log(`${month}  ${e.date}→${x.date}  門檻 ${String(pass.length).padStart(3)} 檔 / 核心 ${String(core.length).padStart(3)} 檔  核心報酬 ${((variants["門檻+連3月+24月新高"].at(-1) ?? NaN) * 100).toFixed(1).padStart(6)}%  市場 ${((variants["全市場等權"].at(-1) ?? NaN) * 100).toFixed(1).padStart(6)}%`);
  }

  const mkt = variants["全市場等權"];
  if (!mkt.length) {
    console.error("沒有任何月份可回測");
    process.exit(1);
  }
  const f = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

  console.log(`\n=== ${mkt.length} 個月（${done[0]} ~ ${done[done.length - 1]}）每月 11 日進場、持有一個月 ===`);
  console.log(`  平均檔數：門檻 ${avg(sizes.門檻).toFixed(0)}、連3月 ${avg(sizes.連3月).toFixed(0)}、核心 ${avg(sizes.核心).toFixed(0)}`);
  for (const [k, v] of Object.entries(variants)) {
    const idx = v.map((_, i) => i).filter((i) => v[i] !== null && Number.isFinite(v[i]!) && mkt[i] !== null);
    const mean = avg(idx.map((i) => v[i]!));
    if (k === "全市場等權") { console.log(`  ${k.padEnd(22)} 月均 ${f(mean).padStart(7)}`); continue; }
    const ex = idx.map((i) => v[i]! - mkt[i]!);
    const me = avg(ex);
    const sd = Math.sqrt(avg(ex.map((z) => (z - me) ** 2)));
    console.log(
      `  ${k.padEnd(22)} 月均 ${f(mean).padStart(7)}  超額 ${f(me).padStart(7)}  勝率 ${((ex.filter((z) => z > 0).length / ex.length) * 100).toFixed(0).padStart(3)}%  年化IR ${((me / sd) * Math.sqrt(12)).toFixed(2)}`,
    );
  }
  console.log(
    `\n  注意：隨機 15 檔是 ${DRAWS} 次抽樣的平均，把個股風險平均掉了——實際只持有 15 檔的波動會明顯大於這裡的數字。\n` +
      `  這一列的用途是判斷「排序有沒有資訊」，不是拿來當可交易績效。`,
  );

  writeFileSync(resolve(ROOT, "data/revenue-momentum-backtest.json"), JSON.stringify({ generatedAt: twIso(), months: mkt.length, sizes, variants }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
