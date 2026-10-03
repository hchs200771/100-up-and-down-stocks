#!/usr/bin/env npx tsx
/**
 * 漏跑幾天報告後，把「官方有歷史可查」的每日序列補回來，並列出補不回來的日子。
 *
 * 報告是手動跑，週三、週四沒跑、週五才跑時，下列序列會在那兩天空一格：
 *
 *   可補（官方 API 能查過去日期，直接沿用既有回補程式）
 *     data/price-history/      backfill-price-history.ts（均線、報酬、選股追蹤都靠它連續）
 *     data/margin-history.json fetch-margin-options.ts --backfill（融資餘額、維持率）
 *     data/market-history.json backfill-micro-retail.ts（微台散戶多空比＋加權收盤；
 *                              當沖比、漲跌家數等其他欄位留 null）
 *
 *   自己會補（下次執行就接上，不用處理）
 *     集保大戶、設質+CB 是週資料；分點追蹤每次抓約 45 個交易日再合併；
 *     ETF 資金流以最近的快照相減。
 *
 *   補不回來（需要當天盤後的即時快照與 AI 分析，事後重跑會拿到今天的資料）
 *     data/stock-picks-history/、族群分析、memory
 *     → 只列出來；選股前瞻追蹤會自動略過這些日子。
 *
 * 用法：
 *   npx tsx scripts/backfill-missed-days.ts            # 檢查最近 30 個日曆天
 *   npx tsx scripts/backfill-missed-days.ts --days 60
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { twNow } from "./lib/time";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const di = args.indexOf("--days");
const DAYS = di >= 0 ? Math.max(1, +args[di + 1] || 30) : 30;

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const today = twNow();
const since = isoOf(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - DAYS + 1)));

function run(script: string, ...scriptArgs: string[]): boolean {
  console.log(`[run] ${script} ${scriptArgs.join(" ")}`.trim());
  const r = spawnSync(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts", script), ...scriptArgs], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) console.warn(`[warn] ${script} 結束碼 ${r.status}，繼續其他項目`);
  return r.status === 0;
}

const datesIn = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)) : [];
function datesOfArray(path: string): Set<string> {
  try {
    return new Set((JSON.parse(readFileSync(path, "utf8")) as { date: string }[]).map((x) => x.date));
  } catch {
    return new Set();
  }
}

// 1. 先補收盤價：補完後 price-history 就是「這段期間的交易日曆」，其他序列拿它對帳
run("backfill-price-history.ts", "--days", String(DAYS));
const tradingDays = datesIn(resolve(ROOT, "data/price-history")).filter((d) => d >= since).sort();
if (!tradingDays.length) {
  console.warn(`[warn] ${since} 之後沒有任何交易日收盤，可能是 API 失敗；略過其餘回補`);
  process.exit(0);
}
const latest = tradingDays[tradingDays.length - 1];
const missingFrom = (have: Set<string>) => tradingDays.filter((d) => !have.has(d));

// 2. 融資餘額
const marginPath = resolve(ROOT, "data/margin-history.json");
if (missingFrom(datesOfArray(marginPath)).length) run("fetch-margin-options.ts", "--backfill", String(DAYS));

// 3. 市場情緒序列：從最早缺的那天補到最近交易日
const marketPath = resolve(ROOT, "data/market-history.json");
const marketMissing = missingFrom(datesOfArray(marketPath));
if (marketMissing.length) run("backfill-micro-retail.ts", marketMissing[0], latest);

// 4. 對帳結果
const report = [
  ["收盤價 price-history", tradingDays.filter((d) => !existsSync(resolve(ROOT, `data/price-history/${d}.json`)))],
  ["融資 margin-history", missingFrom(datesOfArray(marginPath))],
  ["市場情緒 market-history", missingFrom(datesOfArray(marketPath))],
] as const;
console.log(`\n[summary] ${since} ~ ${latest}，共 ${tradingDays.length} 個交易日`);
for (const [label, missing] of report) {
  console.log(missing.length ? `[warn] ${label} 仍缺 ${missing.length} 天：${missing.join(", ")}` : `[ok] ${label} 無缺口`);
}

// 最近交易日的選股池由這次報告產生，不算漏
const picks = new Set(datesIn(resolve(ROOT, "data/stock-picks-history")));
const lostPicks = tradingDays.filter((d) => d !== latest && !picks.has(d));
if (lostPicks.length) {
  console.log(`[info] 無法補回的選股池快照（需當天盤後快照與 AI 分析）${lostPicks.length} 天：${lostPicks.join(", ")}`);
}
