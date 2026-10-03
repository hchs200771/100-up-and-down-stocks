#!/usr/bin/env npx tsx
/**
 * 台股月營收快照（上市 + 上櫃）。
 *
 * 資料源：公開資訊觀測站的月營收統計表
 *   https://mopsov.twse.com.tw/nas/t21/{sii|otc}/t21sc03_<民國年>_<月>_0.html
 *
 * 為什麼不用 openapi：TWSE/TPEx 的 openapi（t187ap05_L / mopsfin_t187ap05_O）
 * **只回傳最新一個月**，沒有歷史，而且更新比 mopsov 慢（2026-09-06 實測 openapi
 * 還停在資料年月 11507、出表日 08/17，mopsov 的同一張表出表日已經是 09/06）。
 * mopsov 這組 URL 一個月一頁、可回溯多年，同一支解析器就能同時做回補與每日更新。
 *
 * ⚠️ 月營收會「長大」也會「被更正」：
 *   - 依規定次月 10 日前公布，所以當月頁在 1–10 號只有零星早報的公司
 *     （2026-09-06 抓 115_8 只有 80KB，而 115_7 是 453KB）。
 *   - 已公布的月份仍會因為補報/更正而變動（115_7 的出表日期是 115/09/06）。
 * 因此冪等規則不是「有檔案就跳過」，而是**最近 N 個月一律重抓，更舊的才凍結**。
 *
 * 用法：
 *   npx tsx scripts/fetch-monthly-revenue.ts              # 重抓最近 3 個月（每日排程用）
 *   npx tsx scripts/fetch-monthly-revenue.ts --months 36  # 回補 36 個月（一次性）
 *   npx tsx scripts/fetch-monthly-revenue.ts --force      # 連凍結的月份也重抓
 *
 * 產出：data/revenue-history/<YYYY-MM>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { twIso } from "./lib/time";
const HISTORY_DIR = "data/revenue-history";
/** 最近幾個月視為「還會變動」，每次跑都重抓 */
const REFRESH_MONTHS = 3;
/** 對 mopsov 客氣一點：每個請求之間的間隔 */
const GAP_MS = 400;

/**
 * 排除的產業別：
 *  - 存託憑證：TDR，母公司在海外，這裡的營收沒有可比性
 * 金融保險業本來就不在 t21sc03 裡（銀行/保險不申報月營收），不需要另外濾。
 */
const SKIP_INDUSTRIES = new Set(["存託憑證"]);

/** 單一公司的月營收（單位：千元，直接沿用原表） */
export interface RevenueRow {
  /** 公司名稱 */
  n: string;
  /** 市場別 */
  m: "twse" | "tpex";
  /** 產業別（原表的分類，下游用來做同業比較與濾網） */
  ind: string;
  /** 當月營收（千元） */
  rev: number;
  /** 去年當月營收（千元）——原表直接給，不必自己從去年的檔案湊 */
  prevY: number;
  /** 當月累計營收（千元） */
  cum: number;
  /** 去年累計營收（千元） */
  cumPrevY: number;
}

export interface RevenueSnapshot {
  /** 資料月份 YYYY-MM */
  month: string;
  /** 原表的出表日期（民國格式，例如 115/09/06）——用來判斷這份抓到時有多新 */
  publishedAt: string;
  fetchedAt: string;
  /** 收錄家數，上市/上櫃分開，方便看出「這個月還沒公布完」 */
  coverage: { twse: number; tpex: number };
  stocks: Record<string, RevenueRow>;
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, "").replace(/&nbsp;/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

/** YYYY-MM → 民國年月，例如 2026-07 → { y: 115, m: 7 } */
const toRoc = (month: string) => ({ y: +month.slice(0, 4) - 1911, m: +month.slice(5, 7) });

/** 從 YYYY-MM 往回推 n 個月 */
export function monthsBack(month: string, n: number): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 「今天這一刻，最新可能存在資料的月份」。
 * 月營收次月 10 日前公布，所以 9/6 的最新月份是 8 月（雖然只有零星公司報了）。
 */
export function latestMonth(asOf = new Date()): string {
  return monthsBack(`${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, "0")}`, 1);
}

async function fetchBig5(url: string, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      // mopsov 是 big5，不是 utf-8。用 utf-8 解會把公司名整片變成亂碼但不報錯，
      // 所以這裡一定要指定 big5。
      const html = new TextDecoder("big5").decode(buf);
      if (!html.includes("營業收入")) throw new Error("body 不像月營收表");
      return html;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  throw new Error(`${url} failed: ${(lastErr as Error)?.message}`);
}

/**
 * 解析 t21sc03 頁面。
 *
 * 版面是「一個產業別一張表」，產業名稱在表前的 `<th class=tt align=left>產業別：X</th>`，
 * 所以邊掃邊記住當前產業。個股列固定是 `<tr align=right><td align=center>代號</td>`，
 * 而「合計」列用的是 `<th ... colspan=2>`，天生就不會被這個 pattern 吃到。
 */
export function parseT21(html: string, market: "twse" | "tpex"): {
  publishedAt: string;
  rows: Map<string, RevenueRow>;
} {
  const publishedAt = html.match(/出表日期：\s*([\d/]+)/)?.[1] ?? "";
  const rows = new Map<string, RevenueRow>();

  // 產業標題與個股列交錯出現，用一個 regex 同時抓兩種，靠 group 判斷是哪一種
  const re =
    /產業別：([^<]+)<|<tr align=right><td align=center>([^<]*)<\/td><td align=left>([^<]*)<\/td>((?:<td[^>]*>[^<]*<\/td>)+)/gi;
  let ind = "";
  for (const m of html.matchAll(re)) {
    if (m[1]) {
      ind = m[1].trim();
      continue;
    }
    const code = (m[2] ?? "").trim();
    if (!/^\d{4}$/.test(code)) continue;
    if (SKIP_INDUSTRIES.has(ind)) continue;
    const cells = [...m[4].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    // 欄序：當月營收 / 上月營收 / 去年當月營收 / MoM% / YoY% / 當月累計 / 去年累計 / 前期比較%
    rows.set(code, {
      n: (m[3] ?? "").trim(),
      m: market,
      ind,
      rev: num(cells[0]),
      prevY: num(cells[2]),
      cum: num(cells[5]),
      cumPrevY: num(cells[6]),
    });
  }
  return { publishedAt, rows };
}

async function fetchMonth(month: string): Promise<RevenueSnapshot> {
  const { y, m } = toRoc(month);
  const out: RevenueSnapshot = {
    month,
    publishedAt: "",
    fetchedAt: twIso(),
    coverage: { twse: 0, tpex: 0 },
    stocks: {},
  };
  for (const [seg, market] of [
    ["sii", "twse"],
    ["otc", "tpex"],
  ] as const) {
    const html = await fetchBig5(`https://mopsov.twse.com.tw/nas/t21/${seg}/t21sc03_${y}_${m}_0.html`);
    const { publishedAt, rows } = parseT21(html, market);
    if (publishedAt > out.publishedAt) out.publishedAt = publishedAt;
    for (const [code, row] of rows) out.stocks[code] = row;
    out.coverage[market] = rows.size;
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const monthsArg = args.indexOf("--months");
  const total = monthsArg >= 0 ? Math.max(1, +args[monthsArg + 1] || 1) : REFRESH_MONTHS;
  const force = args.includes("--force");

  mkdirSync(resolve(process.cwd(), HISTORY_DIR), { recursive: true });
  const newest = latestMonth();

  for (let i = 0; i < total; i++) {
    const month = monthsBack(newest, i);
    const path = resolve(process.cwd(), HISTORY_DIR, `${month}.json`);
    // 凍結規則：超過 REFRESH_MONTHS 個月的檔案已經穩定，有就不重抓
    if (!force && i >= REFRESH_MONTHS && existsSync(path)) {
      console.log(`[skip] ${month} 已存在（凍結區）`);
      continue;
    }
    try {
      const snap = await fetchMonth(month);
      const n = snap.coverage.twse + snap.coverage.tpex;
      if (n === 0) {
        console.warn(`[warn] ${month} 一家都沒有，略過不寫`);
        continue;
      }
      writeFileSync(path, JSON.stringify(snap, null, 0));
      console.log(`[ok]   ${month} ${n} 家（上市 ${snap.coverage.twse} / 上櫃 ${snap.coverage.tpex}）出表 ${snap.publishedAt}`);
    } catch (e) {
      console.warn(`[warn] ${month} 失敗：${(e as Error).message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
