#!/usr/bin/env npx tsx
/**
 * 連續成長月數的分桶回測——回答「連幾個月才算數」。
 *
 * 前提：先跑過 npx tsx scripts/fetch-monthly-revenue.ts --months 36
 * （直接從 revenue-history 重算因子，不依賴 revenue-momentum-history）。
 *
 * ## 這支跟 backtest-revenue-momentum.ts 的分工
 *
 * 那支比的是「門檻內要不要排名」（結論：不要）。這支比的是「門檻之上要不要再加
 * 一個持續性條件、以及那個條件要設幾個月」。兩支共用同一套進出場框架。
 *
 * ## 兩種 streak 不要搞混
 *
 *   f.streak     連續 YoY > 0 的月數
 *   f.momStreak  連續 MoM > 0 的月數（原始單月營收，沒做季節調整）
 *
 * ⚠️ momStreak 每年 2、3 月幾乎必然歸零——1 月比 12 月低、農曆年那個月也會掉，
 * 這是日曆造成的，不是基本面轉壞。所以 MoM 桶會有幾個月樣本不足而被跳過
 * （下面的「有效月數」欄），這不是 bug，是這個指標的本質限制。
 *
 * ## 為什麼不看「桶的 IR」排名
 *
 * IR 的分母是該桶等權組合的波動，**桶越大越分散、波動越小、IR 越高**——量到的是
 * 分散程度不是訊號強度。所以主要結論一律看「同月份配對相減」的 t 值，桶的 IR 只
 * 當參考。實測 MoM>=1（171 檔）IR 2.55 高於 MoM>=3（43 檔）IR 2.27，但配對檢定
 * MoM>=3 − MoM>=2 是 +1.05pp、t=2.88——IR 排名剛好把結論顛倒過來。
 *
 * ## 訓練／保留樣本
 *
 * 用 --split <YYYY-MM> 把期間切兩段分別報告。這 19 個桶是一次跑出來挑最好的，
 * 有多重比較問題，全期間的 t 值會高估。保留樣本撐不住的桶不要拿去改 production。
 *
 * 用法：
 *   npx tsx scripts/backtest-revenue-streak.ts
 *   npx tsx scripts/backtest-revenue-streak.ts --split 2024-01
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadSnapshots, coverageOf, createFactorCalc, MIN_COVERAGE, GATE_YOY } from "./lib/revenue-factors";
import { closesOn, isTradingDay } from "./lib/twse-closes";

import { twIso } from "./lib/time";
const ROOT = process.cwd();
/** 一個桶當月至少要有幾檔才算數，太少的話那個月的桶平均純粹是個股運氣 */
const MIN_BUCKET = 8;

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

/** 一檔通過門檻的個股，只留分桶要用的三個因子與報酬 */
interface Pass {
  /** momStreak：連續 MoM > 0 的月數 */
  ms: number;
  /** streak：連續 YoY > 0 的月數 */
  ys: number;
  /** highMonths：近幾個月的營收新高，24 是上限 */
  hm: number;
  ret: number;
}

/** 桶的定義。互斥桶（=N）用來看資訊集中在哪一段，累積桶（>=N）才是可交易的規則。 */
const BUCKETS: { key: string; sel: (p: Pass) => boolean }[] = [
  { key: "MoM=0", sel: (p) => p.ms === 0 },
  { key: "MoM=1", sel: (p) => p.ms === 1 },
  { key: "MoM=2", sel: (p) => p.ms === 2 },
  { key: "MoM>=3", sel: (p) => p.ms >= 3 },
  { key: "MoM>=1", sel: (p) => p.ms >= 1 },
  { key: "MoM>=2", sel: (p) => p.ms >= 2 },
  { key: "MoM>=4", sel: (p) => p.ms >= 4 },
  { key: "MoM>=5", sel: (p) => p.ms >= 5 },
  { key: "YoY=1", sel: (p) => p.ys === 1 },
  { key: "YoY=2", sel: (p) => p.ys === 2 },
  { key: "YoY>=3", sel: (p) => p.ys >= 3 },
  { key: "MoM>=3 & YoY>=3", sel: (p) => p.ms >= 3 && p.ys >= 3 },
  { key: "現行核心(YoY>=3+24新高)", sel: (p) => p.ys >= 3 && p.hm === 24 },
  { key: "MoM>=3+24新高", sel: (p) => p.ms >= 3 && p.hm === 24 },
  { key: "現行核心+MoM>=3", sel: (p) => p.ys >= 3 && p.hm === 24 && p.ms >= 3 },
  { key: "門檻全部", sel: () => true },
];

/** 想看的配對比較。配對＝同月份相減，消掉大盤共同項，才是這支的主要結論。 */
const PAIRS: [string, string][] = [
  ["MoM>=3", "門檻全部"],
  ["MoM>=2", "門檻全部"],
  ["MoM>=1", "門檻全部"],
  ["MoM>=3", "MoM>=2"],
  ["MoM=2", "MoM=0"],
  ["MoM=1", "MoM=0"],
  ["YoY>=3", "門檻全部"],
  ["MoM>=3+24新高", "現行核心(YoY>=3+24新高)"],
  ["MoM>=3", "YoY>=3"],
];

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fpc = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const fpp = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}pp`;

/** 把一段月份的桶報酬整理成一列。超額是相對全市場等權，IR 已年化。 */
function summarize(rets: number[], mkt: number[], counts: number[]) {
  const idx = rets.map((_, i) => i).filter((i) => Number.isFinite(rets[i]) && Number.isFinite(mkt[i]));
  if (idx.length < 6) return null;
  const mean = avg(idx.map((i) => rets[i]));
  const ex = idx.map((i) => rets[i] - mkt[i]);
  const me = avg(ex);
  const sd = Math.sqrt(avg(ex.map((z) => (z - me) ** 2)));
  return {
    n: idx.length,
    size: avg(counts.filter(Number.isFinite)),
    mean,
    excess: me,
    win: ex.filter((z) => z > 0).length / ex.length,
    ir: (me / sd) * Math.sqrt(12),
  };
}

/** 配對 t 檢定：同月份相減。回 null 代表重疊月份太少，不下結論。 */
function pairedT(a: number[], b: number[]) {
  const d: number[] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) d.push(a[i] - b[i]);
  if (d.length < 6) return null;
  const m = avg(d);
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1));
  return { n: d.length, diff: m, t: m / (sd / Math.sqrt(d.length)), win: d.filter((x) => x > 0).length / d.length };
}

async function main() {
  const splitIdx = process.argv.indexOf("--split");
  const split = splitIdx > 0 ? process.argv[splitIdx + 1] : null;

  const snaps = loadSnapshots(ROOT);
  if (!snaps.size) {
    console.error("data/revenue-history 是空的，先跑 fetch-monthly-revenue.ts --months 36");
    process.exit(1);
  }
  // 只回測「已公布完」的月份；1 月不出名單（農曆年錯位，見 build-revenue-momentum.ts）
  const months = [...snaps.keys()].sort().filter((m) => coverageOf(snaps, m) >= MIN_COVERAGE && +m.slice(5, 7) !== 1);

  /** 桶 key → 逐月報酬（NaN 代表該月檔數不足 MIN_BUCKET） */
  const rets: Record<string, number[]> = {};
  const counts: Record<string, number[]> = {};
  for (const b of BUCKETS) {
    rets[b.key] = [];
    counts[b.key] = [];
  }
  const mkt: number[] = [];
  const done: string[] = [];

  for (const month of months) {
    const e = await entryOf(month);
    const x = await entryOf(monthsBack(month, -1));
    if (!e || !x) continue;

    const calc = createFactorCalc(snaps, month);
    const pass: Pass[] = [];
    for (const [code, row] of Object.entries(snaps.get(month)!.stocks)) {
      const f = calc.factorsFor(code, row);
      if (typeof f === "string" || f.yoy < GATE_YOY) continue;
      const a = e.closes[code];
      const b = x.closes[code];
      if (!(a > 0 && b > 0)) continue;
      pass.push({ ms: f.momStreak, ys: f.streak, hm: f.highMonths, ret: b / a - 1 });
    }
    if (pass.length < 20) continue;

    for (const b of BUCKETS) {
      const g = pass.filter(b.sel);
      counts[b.key].push(g.length);
      rets[b.key].push(g.length >= MIN_BUCKET ? avg(g.map((p) => p.ret)) : NaN);
    }
    mkt.push(avg(Object.keys(e.closes).map((c) => (e.closes[c] > 0 && x.closes[c] > 0 ? x.closes[c] / e.closes[c] - 1 : NaN)).filter(Number.isFinite)));
    done.push(month);
    process.stderr.write(`\r  ${month}  ${done.length}/${months.length}`);
  }
  process.stderr.write("\n");

  if (done.length < 12) {
    console.error(`可回測月份只有 ${done.length} 個，太少`);
    process.exit(1);
  }

  /** 期間切分：[名稱, 起, 迄)，全期間永遠在第一段 */
  const periods: { label: string; from: number; to: number }[] = [{ label: `全期間 ${done[0]} ~ ${done[done.length - 1]}`, from: 0, to: done.length }];
  if (split) {
    const cut = done.findIndex((m) => m >= split);
    if (cut > 6 && done.length - cut > 6) {
      periods.push({ label: `訓練 ${done[0]} ~ ${done[cut - 1]}`, from: 0, to: cut });
      periods.push({ label: `保留 ${done[cut]} ~ ${done[done.length - 1]}`, from: cut, to: done.length });
    } else {
      console.error(`[warn] --split ${split} 會讓其中一段不足 7 個月，忽略切分`);
    }
  }

  for (const p of periods) {
    const slice = (xs: number[]) => xs.slice(p.from, p.to);
    console.log(`\n=== ${p.label}（${p.to - p.from} 個月）每月 11 日進場、持有一個月，全部先過 YoY≥${(GATE_YOY * 100).toFixed(0)}% 門檻 ===`);
    console.log(`  桶名                       平均檔數  月均報酬     超額   勝率  年化IR  有效月`);
    for (const b of BUCKETS) {
      const s = summarize(slice(rets[b.key]), slice(mkt), slice(counts[b.key]));
      if (!s) {
        console.log(`  ${b.key.padEnd(24)} 樣本不足`);
        continue;
      }
      console.log(
        `  ${b.key.padEnd(24)} ${s.size.toFixed(0).padStart(6)}  ${fpc(s.mean).padStart(8)} ${fpp(s.excess).padStart(9)} ` +
          `${(s.win * 100).toFixed(0).padStart(4)}%  ${s.ir.toFixed(2).padStart(6)}  ${String(s.n).padStart(5)}`,
      );
    }
    console.log(`  ${"全市場等權".padEnd(24)} ${"".padStart(6)}  ${fpc(avg(slice(mkt))).padStart(8)}`);

    console.log(`\n  配對檢定（同月份相減，這才是主要結論——桶的 IR 會被分散程度污染）`);
    console.log(`  對照組                             月數    月均差    t值  勝月比`);
    for (const [a, b] of PAIRS) {
      const r = pairedT(slice(rets[a]), slice(rets[b]));
      if (!r) {
        console.log(`  ${`${a} − ${b}`.padEnd(34)} 重疊月份不足`);
        continue;
      }
      console.log(
        `  ${`${a} − ${b}`.padEnd(34)} ${String(r.n).padStart(4)}  ${fpp(r.diff).padStart(8)}  ${r.t.toFixed(2).padStart(5)}  ${(r.win * 100).toFixed(0).padStart(4)}%`,
      );
    }
  }

  // 逐年拆最關鍵的那一組：一個真訊號不該靠單一年份撐場
  const key: [string, string] = ["MoM>=3", "門檻全部"];
  const byYear: Record<string, number[]> = {};
  for (let i = 0; i < done.length; i++) {
    const a = rets[key[0]][i];
    const b = rets[key[1]][i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    (byYear[done[i].slice(0, 4)] ??= []).push(a - b);
  }
  console.log(`\n=== ${key[0]} 相對${key[1]}的逐年月均差（穩定性檢查）===`);
  for (const [y, v] of Object.entries(byYear)) console.log(`  ${y}  ${String(v.length).padStart(2)} 月  ${fpp(avg(v)).padStart(8)}`);

  console.log(
    `\n  ⚠️ ${BUCKETS.length} 個桶是一次跑出來挑最好的，全期間 t 值有多重比較偏誤（Bonferroni 約需 t≈3.0）。\n` +
      `  ⚠️ 沒扣交易成本；下市個股拿不到出場價會被排除，數字偏樂觀。`,
  );

  writeFileSync(
    resolve(ROOT, "data/revenue-streak-backtest.json"),
    JSON.stringify({ generatedAt: twIso(), months: done, mkt, rets, counts, periods, minBucket: MIN_BUCKET }, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
