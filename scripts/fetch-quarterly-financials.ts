#!/usr/bin/env npx tsx
/**
 * 季報的營業收入、營業成本與營業利益（用來算毛利率、營業利益率）。
 *
 * 資料源：公開資訊觀測站「綜合損益表」彙總
 *   POST https://mopsov.twse.com.tw/mops/web/ajax_t163sb04   (TYPEK=sii|otc, year=民國, season=1..4)
 *
 * ⚠️ **MOPS 的季報數字是「累計」不是「單季」**。season=2 拿到的是上半年合計，
 * season=3 是前三季合計。要單季就得自己相減：Q1 = 累計Q1、Q2 = 累計Q2 − 累計Q1，依此類推。
 * 這支只負責把「累計」原封不動存下來，相減交給 lib/gross-margin.ts。
 *
 * ⚠️ 回傳頁面裡有好幾張表（金融業、證券業、一般業…），只有**一般業**那張有
 * 「營業收入 / 營業成本」。金融保險業的損益結構完全不同，本來就算不出可比的毛利率，
 * 直接不收。
 *
 * 毛利＝營收−成本 自己算，不去對「營業毛利」欄位——那欄在有未實現銷貨損益的公司會是
 * 空的（例如台泥 2026Q2 就是 `--`，數字在「營業毛利淨額」欄）。相減永遠對得上。
 *
 * 用法：
 *   npx tsx scripts/fetch-quarterly-financials.ts                 # 補最近 14 季
 *   npx tsx scripts/fetch-quarterly-financials.ts --quarters 20
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deadlineOf } from "./lib/gross-margin";

const DIR = "data/financials-history";
const DEFAULT_QUARTERS = 14;
const GAP_MS = 700;

/** 一家公司某一季的「累計」數字，單位千元 */
export interface FinRow {
  n: string;
  m: "twse" | "tpex";
  /** 累計營業收入 */
  rev: number;
  /** 累計營業成本 */
  cost: number;
  /** 累計營業利益（損失）。2026-09 才加的欄位，舊快照要 --force 重抓才會有 */
  op?: number | null;
  /** 累計基本每股盈餘（元）。算本益比用，2026-09 加的欄位 */
  eps?: number | null;
}

export interface FinSnapshot {
  /** 例：2026Q2 */
  quarter: string;
  fetchedAt: string;
  coverage: { twse: number; tpex: number };
  stocks: Record<string, FinRow>;
}

const num = (v: unknown): number | null => {
  const t = String(v ?? "").replace(/,/g, "").replace(/&nbsp;/g, "").trim();
  if (!t || t === "--" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

async function post(typek: "sii" | "otc", rocYear: number, season: number): Promise<string> {
  const body = `encodeURIComponent=1&step=1&firstin=1&off=1&isQuery=Y&TYPEK=${typek}&year=${rocYear}&season=${season}`;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch("https://mopsov.twse.com.tw/mops/web/ajax_t163sb04", {
        method: "POST",
        headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = await res.text();
      if (t.length < 5000) throw new Error("body 太短，可能被擋");
      return t;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  return "";
}

/**
 * 從頁面挑出「有營業成本那一張表」並解析。
 * 每列前兩格是代號與名稱，接著依序是營業收入、營業成本。
 * 營業利益的欄位位置每張表不同（一般業夾著生物資產、未實現銷貨等欄），要照表頭找。
 */
export function parseFinancials(html: string, market: "twse" | "tpex"): Map<string, FinRow> {
  const out = new Map<string, FinRow>();
  for (const tbl of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const inner = tbl[1];
    if (!inner.includes("營業成本")) continue;
    const heads = [...inner.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((c) => c[1].replace(/<[^>]*>/g, "").trim());
    const opIdx = heads.indexOf("營業利益（損失）");
    const epsIdx = heads.indexOf("基本每股盈餘（元）");
    for (const tr of inner.matchAll(/<tr class='(?:even|odd)'>([\s\S]*?)<\/tr>/g)) {
      const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]*>/g, "").trim());
      const code = cells[0];
      if (!/^\d{4}$/.test(code)) continue;
      const rev = num(cells[2]);
      const cost = num(cells[3]);
      if (rev === null || cost === null || rev <= 0) continue;
      out.set(code, { n: cells[1], m: market, rev, cost, op: opIdx >= 0 ? num(cells[opIdx]) : null, eps: epsIdx >= 0 ? num(cells[epsIdx]) : null });
    }
  }
  return out;
}

/** 從「現在」往回推 n 季，回傳 [{ rocYear, season, key }]，由新到舊 */
function recentQuarters(n: number, asOf = new Date()): { rocYear: number; season: number; key: string }[] {
  const y = asOf.getFullYear();
  const q = Math.floor(asOf.getMonth() / 3) + 1;
  const out: { rocYear: number; season: number; key: string }[] = [];
  for (let i = 0; i < n; i++) {
    let yy = y;
    let qq = q - i;
    while (qq <= 0) { qq += 4; yy -= 1; }
    out.push({ rocYear: yy - 1911, season: qq, key: `${yy}Q${qq}` });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const qi = args.indexOf("--quarters");
  const total = qi >= 0 ? Math.max(1, +args[qi + 1] || DEFAULT_QUARTERS) : DEFAULT_QUARTERS;
  const force = args.includes("--force");

  const root = process.cwd();
  mkdirSync(resolve(root, DIR), { recursive: true });

  for (const { rocYear, season, key } of recentQuarters(total)) {
    const path = resolve(root, DIR, `${key}.json`);
    // 財報公布後就不會再改，抓過一次就永久凍結，不重抓。
    // 唯一會重抓的是「申報期限還沒到」的那一季——公司陸續在報，今天抓到的只是一部分。
    const stale = Date.now() < deadlineOf(key).getTime();
    if (!force && existsSync(path) && !stale) { console.log(`[skip] ${key}`); continue; }
    const snap: FinSnapshot = { quarter: key, fetchedAt: new Date().toISOString(), coverage: { twse: 0, tpex: 0 }, stocks: {} };
    try {
      for (const [typek, market] of [["sii", "twse"], ["otc", "tpex"]] as const) {
        const rows = parseFinancials(await post(typek, rocYear, season), market);
        for (const [code, r] of rows) snap.stocks[code] = r;
        snap.coverage[market] = rows.size;
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    } catch (e) {
      console.warn(`[warn] ${key} 失敗：${(e as Error).message}`);
      continue;
    }
    const n = snap.coverage.twse + snap.coverage.tpex;
    if (n < 100) { console.warn(`[warn] ${key} 只有 ${n} 家，可能還沒公布，不寫入`); continue; }
    writeFileSync(path, JSON.stringify(snap));
    console.log(`[ok]   ${key} ${n} 家（上市 ${snap.coverage.twse} / 上櫃 ${snap.coverage.tpex}）`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
