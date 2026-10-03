#!/usr/bin/env npx tsx
/**
 * 把 data/price-history/ 缺掉的交易日補回來。
 *
 * ## 為什麼需要
 *
 * price-history 由 score-report.ts 寫入，而它只在「盤後報告有跑」的那天執行。
 * 報告目前是每晚手動跑，漏一天那個交易日就永久空一格。實測 2026-06-29~09-04
 * 之間有 38 個檔案、卻缺了 12 個交易日。
 *
 * 下游把這些檔案當成「連續的日 K」用：
 *   build-stock-picks.ts     MA10 / MA20 / 20 日高 / 10 日與 20 日報酬
 *   build-revenue-momentum.ts  MA20 / 20 日報酬
 *   build-tdcc-divergence.ts   20 日漲幅與 20 日均線
 * 缺格時 `arr.slice(-20)` 拿到的是「最近 20 個有紀錄的日子」，實際橫跨約 24 個
 * 交易日——**均線與報酬率全部失真**。月線該用 20 根 K 棒，不是 20 個有紀錄的日子。
 *
 * ## 做法
 *
 * 掃過去 N 天的每個平日，沒有檔案就去 TWSE / TPEx 抓當天全市場收盤。抓回來是空的
 * 就代表那天沒開盤（假日），略過。抓過的日子會快取在 data/cache/，重跑不會重抓。
 *
 * 用法：
 *   npx tsx scripts/backfill-price-history.ts          # 補最近 120 天
 *   npx tsx scripts/backfill-price-history.ts --days 400
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { closesOn, isTradingDay } from "./lib/twse-closes";
import { twNow } from "./lib/time";

const DIR = "data/price-history";
const DEFAULT_DAYS = 120;

const pad = (n: number) => String(n).padStart(2, "0");

async function main() {
  const args = process.argv.slice(2);
  const di = args.indexOf("--days");
  const days = di >= 0 ? Math.max(1, +args[di + 1] || DEFAULT_DAYS) : DEFAULT_DAYS;

  const root = process.cwd();
  mkdirSync(resolve(root, DIR), { recursive: true });

  // 用台北日期當「今天」，否則台灣凌晨跑會少算一天
  const today = twNow();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue; // 週末直接跳過，不用問 API
    dates.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }

  let filled = 0;
  let holiday = 0;
  let already = 0;
  for (const iso of dates.reverse()) {
    const path = resolve(root, DIR, `${iso}.json`);
    if (existsSync(path)) { already++; continue; }
    const closes = await closesOn(iso.replace(/-/g, ""), root);
    if (!isTradingDay(closes)) { holiday++; continue; }
    writeFileSync(path, JSON.stringify(closes, null, 2));
    filled++;
    console.log(`[fill] ${iso} 補上 ${Object.keys(closes).length} 檔`);
  }
  console.log(`[ok] 已有 ${already} 天、補上 ${filled} 天、非交易日 ${holiday} 天`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
