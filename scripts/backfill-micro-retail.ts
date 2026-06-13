/**
 * Backfill retailNetPct into data/market-history.json using TAIFEX historical CSV.
 *
 * Usage:
 *   npx tsx scripts/backfill-micro-retail.ts [startDate endDate]
 *   startDate/endDate: YYYY-MM-DD  (default: today-60 ~ today)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { upsertMarketHistory, type MarketHistoryEntry } from "./score-report.ts";

// ---------------------------------------------------------------------------
// Pure parsing functions (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse TAIFEX 三大法人未平倉 CSV (Big5, already decoded to UTF-8 string).
 * Returns Map<date "YYYY-MM-DD", {instLong, instShort}>.
 * Each date has 3 rows (自營商/投信/外資), we sum across all rows.
 */
export function parseInstiOiCsv(text: string): Map<string, { instLong: number; instShort: number }> {
  const result = new Map<string, { instLong: number; instShort: number }>();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // CSV rows: 日期,商品名稱,身份別,多方交易口數,...,多方未平倉口數(col9,0-idx),多方未平倉契約金額(col10),空方未平倉口數(col11),...
    // Split by comma, handle quoted fields
    const cols = splitCsvLine(trimmed);
    if (cols.length < 12) continue;

    // Date col 0: "YYYY/MM/DD" — may be quoted
    const rawDate = cols[0].replace(/"/g, "").trim();
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(rawDate)) continue;
    const date = rawDate.replace(/\//g, "-");

    // instLong = col index 9 (多方未平倉口數), instShort = col index 11 (空方未平倉口數)
    const longStr = cols[9].replace(/[",\s]/g, "");
    const shortStr = cols[11].replace(/[",\s]/g, "");
    const long = parseInt(longStr, 10);
    const short = parseInt(shortStr, 10);
    if (isNaN(long) || isNaN(short)) continue;

    const existing = result.get(date) ?? { instLong: 0, instShort: 0 };
    result.set(date, { instLong: existing.instLong + long, instShort: existing.instShort + short });
  }
  return result;
}

/**
 * Parse TAIFEX 期貨日成交量 CSV (Big5, already decoded).
 * Returns Map<date "YYYY-MM-DD", totalOI>.
 * Only sum rows where 交易時段=="一般" and 未沖銷契約數 is numeric (not "-").
 * Column layout: 交易日期(0),契約(1),到期月份(週別)(2),...,未沖銷契約數(11),...,交易時段(second-to-last)
 */
export function parseTotalOiCsv(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = splitCsvLine(trimmed);
    if (cols.length < 18) continue;

    // Date col 0
    const rawDate = cols[0].replace(/"/g, "").trim();
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(rawDate)) continue;
    const date = rawDate.replace(/\//g, "-");

    // 交易時段 = col 17 (0-indexed); header: 交易日期(0)...交易時段(17)...
    const session = cols[17].replace(/"/g, "").trim();
    if (session !== "一般") continue;

    // 未沖銷契約數 = col 11
    const oiStr = cols[11].replace(/[",\s]/g, "");
    if (oiStr === "-" || oiStr === "") continue;
    const oi = parseInt(oiStr, 10);
    if (isNaN(oi)) continue;

    result.set(date, (result.get(date) ?? 0) + oi);
  }
  return result;
}

/**
 * Compute retailNetPct and retailNetLots series from the two maps.
 * retailNetPct = (instShort - instLong) / totalOI * 100, rounded to 2 decimals.
 * retailNetLots = instShort - instLong (lots; positive = retail net long).
 */
export function computeRetailSeries(
  instiMap: Map<string, { instLong: number; instShort: number }>,
  totalMap: Map<string, number>,
): Array<{ date: string; retailNetPct: number; retailNetLots: number }> {
  const results: Array<{ date: string; retailNetPct: number; retailNetLots: number }> = [];
  for (const [date, { instLong, instShort }] of instiMap) {
    const totalOI = totalMap.get(date);
    if (totalOI === undefined || totalOI === 0) continue;
    const pct = parseFloat((((instShort - instLong) / totalOI) * 100).toFixed(2));
    // instShort - instLong = institutional net short = retail net long (zero-sum)
    const lots = instShort - instLong;
    results.push({ date, retailNetPct: pct, retailNetLots: lots });
  }
  results.sort((a, b) => a.date.localeCompare(b.date));
  return results;
}

/**
 * Parse TWSE FMTQIK (加權指數月報) JSON response.
 * Returns Map<date "YYYY-MM-DD", taiexClose>.
 * Row format: ["民國日期(115/04/01)", "成交股數", "成交金額", "成交筆數", "加權指數", "漲跌點數", ...]
 */
export function parseFmtqikMonth(json: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (!json || typeof json !== "object") return result;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.data)) return result;
  for (const row of obj.data as unknown[]) {
    if (!Array.isArray(row) || row.length < 5) continue;
    // Col 0: 民國日期 "115/04/01"
    const rawDate = String(row[0]).trim();
    const m = rawDate.match(/^(\d+)\/(\d{2})\/(\d{2})$/);
    if (!m) continue;
    const year = parseInt(m[1], 10) + 1911;
    const date = `${year}-${m[2]}-${m[3]}`;
    // Col 4: 加權指數 (may have commas)
    const closeStr = String(row[4]).replace(/,/g, "").trim();
    const close = parseFloat(closeStr);
    if (isNaN(close)) continue;
    result.set(date, close);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helper: naive CSV line splitter (handles quoted fields with commas)
// ---------------------------------------------------------------------------
function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function toTaifexDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function fetchBig5(url: string, body: string): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("big5").decode(buf);
  // TAIFEX returns HTML error pages for ranges that are too large
  if (text.trimStart().startsWith("<")) {
    throw new Error(`TAIFEX returned HTML instead of CSV (range too large?): ${text.slice(0, 200)}`);
  }
  return text;
}

/**
 * Chunk a date range into windows of at most maxDays calendar days.
 * Returns array of [start, end] Date pairs.
 */
function chunkDateRange(start: Date, end: Date, maxDays: number): Array<[Date, Date]> {
  const chunks: Array<[Date, Date]> = [];
  let cur = new Date(start);
  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push([new Date(cur), new Date(chunkEnd)]);
    cur.setDate(cur.getDate() + maxDays);
  }
  return chunks;
}

async function fetchInstiOiAll(startDate: Date, endDate: Date): Promise<string> {
  const chunks = chunkDateRange(startDate, endDate, 30);
  const parts: string[] = [];
  for (const [s, e] of chunks) {
    const text = await fetchBig5(
      "https://www.taifex.com.tw/cht/3/futContractsDateDown",
      `queryStartDate=${encodeURIComponent(toTaifexDate(s))}&queryEndDate=${encodeURIComponent(toTaifexDate(e))}&commodityId=TMF`,
    );
    // Strip header from all but first chunk
    const lines = text.split(/\r?\n/);
    const dataLines = parts.length === 0 ? lines : lines.slice(1);
    parts.push(dataLines.join("\n"));
  }
  return parts.join("\n");
}

async function fetchTotalOiAll(startDate: Date, endDate: Date): Promise<string> {
  const chunks = chunkDateRange(startDate, endDate, 30);
  const parts: string[] = [];
  for (const [s, e] of chunks) {
    const text = await fetchBig5(
      "https://www.taifex.com.tw/cht/3/futDataDown",
      `down_type=1&commodity_id=TMF&queryStartDate=${encodeURIComponent(toTaifexDate(s))}&queryEndDate=${encodeURIComponent(toTaifexDate(e))}`,
    );
    const lines = text.split(/\r?\n/);
    const dataLines = parts.length === 0 ? lines : lines.slice(1);
    parts.push(dataLines.join("\n"));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const DATA = resolve(process.cwd(), "data");
  const MARKET_HISTORY = resolve(DATA, "market-history.json");

  let startDate: Date;
  let endDate: Date;

  if (process.argv[2] && process.argv[3]) {
    startDate = new Date(process.argv[2]);
    endDate = new Date(process.argv[3]);
  } else {
    // Anchor on the report's trading date (from market-latest.json), not the
    // system clock — the sandbox clock can drift from the live market date.
    let anchor = new Date();
    try {
      const market = JSON.parse(readFileSync(resolve(DATA, "market-latest.json"), "utf8"));
      if (typeof market.tradingDate === "string") anchor = new Date(market.tradingDate);
    } catch {
      // fall back to system clock if market-latest.json is unavailable
    }
    endDate = anchor;
    startDate = addDays(anchor, -60);
  }

  const startStr = toTaifexDate(startDate);
  const endStr = toTaifexDate(endDate);

  console.log(`[backfill] Fetching TAIFEX data from ${startStr} to ${endStr}...`);

  // Fetch insti OI CSV (chunked to avoid server limit)
  const instiCsv = await fetchInstiOiAll(startDate, endDate);

  // Fetch total OI CSV (chunked to avoid server limit)
  const totalCsv = await fetchTotalOiAll(startDate, endDate);

  const instiMap = parseInstiOiCsv(instiCsv);
  const totalMap = parseTotalOiCsv(totalCsv);
  const series = computeRetailSeries(instiMap, totalMap);

  console.log(`[backfill] Parsed ${series.length} trading days`);

  if (series.length === 0) {
    console.log("[backfill] No data to merge. Done.");
    return;
  }

  // Load existing history
  let history: MarketHistoryEntry[] = [];
  if (existsSync(MARKET_HISTORY)) {
    try {
      history = JSON.parse(readFileSync(MARKET_HISTORY, "utf-8"));
    } catch {
      history = [];
    }
  }

  // Merge retailNetPct + retailNetLots (backfill is authoritative)
  let filled = 0;
  for (const { date, retailNetPct, retailNetLots } of series) {
    const existing = history.find((h) => h.date === date);
    const entry: MarketHistoryEntry = existing
      ? { ...existing, retailNetPct, retailNetLots }
      : { date, retailNetPct, retailNetLots };
    history = upsertMarketHistory(history, entry);
    filled++;
  }

  // ---- Backfill taiexClose from TWSE FMTQIK ----
  // Collect distinct year-months covered by startDate..endDate
  const months = new Set<string>();
  {
    const cur = new Date(startDate);
    cur.setDate(1);
    const end = new Date(endDate);
    end.setDate(1);
    while (cur <= end) {
      const y = cur.getFullYear();
      const mo = String(cur.getMonth() + 1).padStart(2, "0");
      months.add(`${y}${mo}01`);
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  console.log(`[backfill] Fetching TWSE taiexClose for ${months.size} month(s)...`);
  let taiexFilled = 0;
  for (const yyyymm01 of months) {
    try {
      const url = `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json&date=${yyyymm01}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[backfill] TWSE FMTQIK ${yyyymm01}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const taiexMap = parseFmtqikMonth(json);
      for (const [date, taiexClose] of taiexMap) {
        const existing = history.find((h) => h.date === date);
        if (!existing) continue; // only update dates we already have from TAIFEX
        if (existing.taiexClose !== null && existing.taiexClose !== undefined) continue; // already set
        existing.taiexClose = taiexClose;
        taiexFilled++;
      }
    } catch (err) {
      console.warn(`[backfill] TWSE FMTQIK ${yyyymm01} failed:`, err);
    }
  }
  console.log(`[backfill] taiexClose backfilled for ${taiexFilled} days`);

  writeFileSync(MARKET_HISTORY, JSON.stringify(history, null, 2), "utf-8");

  const dates = series.map((s) => s.date);
  const pcts = series.map((s) => s.retailNetPct);
  const earliest = dates[0];
  const latest = dates[dates.length - 1];
  const lastPct = pcts[pcts.length - 1];
  const lastLots = series[series.length - 1]?.retailNetLots;
  const latestEntry = history.find((h) => h.date === latest);
  console.log(`[backfill] Filled ${filled} days (${earliest} ~ ${latest})`);
  console.log(`[backfill] Latest retailNetPct: ${lastPct?.toFixed(2)}%`);
  console.log(`[backfill] Latest retailNetLots: ${lastLots}`);
  console.log(`[backfill] Latest taiexClose: ${latestEntry?.taiexClose}`);
  console.log(`[backfill] Range: min=${Math.min(...pcts).toFixed(2)}% max=${Math.max(...pcts).toFixed(2)}%`);
  console.log(`[backfill] Written to ${MARKET_HISTORY}`);
}

const isMain = process.argv[1]?.endsWith("backfill-micro-retail.ts") || process.argv[1]?.endsWith("backfill-micro-retail.js");
if (isMain) {
  main().catch((err) => {
    console.error("[backfill] Error:", err);
    process.exit(1);
  });
}
