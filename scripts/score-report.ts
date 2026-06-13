import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Market history types
// ---------------------------------------------------------------------------

export interface MarketHistoryEntry {
  date: string;
  retailNetPct: number | null;
  retailNetLots?: number | null;
  twseDayTradePct?: number | null;
  tpexDayTradePct?: number | null;
  taiexClose?: number | null;
  taiexChange?: number | null;
  tpexClose?: number | null;
  tpexChange?: number | null;
  up?: number | null;
  down?: number | null;
  limitUp?: number | null;
  limitDown?: number | null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalysisGroup {
  category: string;
  stocks: string[];
  story?: string;
  stage?: string;
}

interface AnalysisSnapshot {
  date: string;
  gainers: AnalysisGroup[];
  losers: AnalysisGroup[];
  [key: string]: unknown;
}

interface MarketLatest {
  tradingDate: string;
  closeMap?: Record<string, number>;
  gainers: Array<{ code: string; close: number }>;
  losers: Array<{ code: string; close: number }>;
}

interface ScorecardRecord {
  date: string;
  category: string;
  direction: "gainer" | "loser";
  stage?: string;
  members: number;
  t1?: number;
  t5?: number;
}

interface DirectionStats {
  n: number;
  avgT1: number;
  avgT5: number;
  winRateT1: number;
  winRateT5: number;
}

interface StageStats {
  n: number;
  avgT1: number;
  avgT5: number;
}

interface Scorecard {
  updatedAt: string;
  records: ScorecardRecord[];
  aggregates: {
    byDirection: {
      gainer: DirectionStats;
      loser: DirectionStats;
    };
    byStage: Record<string, StageStats>;
  };
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/** Extract stock code from strings like "華通(2313)" → "2313" */
export function parseStockCode(entry: string): string | null {
  const m = entry.match(/\(([^)]+)\)/);
  return m ? m[1] : null;
}

/**
 * Compute equal-weight average return for a group.
 * Returns null if no members have prices in both snapshots.
 */
export function computeGroupReturn(
  stocks: string[],
  t0Prices: Record<string, number>,
  tNPrices: Record<string, number>,
): number | null {
  let sum = 0;
  let count = 0;
  for (const entry of stocks) {
    const code = parseStockCode(entry);
    if (!code) continue;
    const t0 = t0Prices[code];
    const tN = tNPrices[code];
    if (t0 === undefined || tN === undefined || t0 === 0) continue;
    sum += ((tN - t0) / t0) * 100;
    count++;
  }
  return count > 0 ? sum / count : null;
}

/**
 * Given a sorted list of trading-date strings and a base date,
 * find the filenames at offset +1 and +5 trading days after baseDate.
 * Returns [t1Date, t5Date] (either may be undefined if not enough history).
 */
export function findForwardDates(
  sortedDates: string[],
  baseDate: string,
): [string | undefined, string | undefined] {
  const idx = sortedDates.indexOf(baseDate);
  if (idx === -1) return [undefined, undefined];
  const t1 = sortedDates[idx + 1];
  const t5 = sortedDates[idx + 5];
  return [t1, t5];
}

/**
 * Upsert a MarketHistoryEntry into a history array (sorted ascending by date).
 * Same date replaces existing entry. Exported for testing.
 */
export function upsertMarketHistory(
  history: MarketHistoryEntry[],
  entry: MarketHistoryEntry,
): MarketHistoryEntry[] {
  const idx = history.findIndex((h) => h.date === entry.date);
  if (idx >= 0) {
    history[idx] = entry;
  } else {
    history.push(entry);
    history.sort((a, b) => a.date.localeCompare(b.date));
  }
  return history;
}

/** Build aggregates from records */
export function buildAggregates(records: ScorecardRecord[]): Scorecard["aggregates"] {
  function emptyDir(): DirectionStats {
    return { n: 0, avgT1: 0, avgT5: 0, winRateT1: 0, winRateT5: 0 };
  }

  const byDirection: Record<"gainer" | "loser", DirectionStats> = {
    gainer: emptyDir(),
    loser: emptyDir(),
  };
  const byStage: Record<string, StageStats> = {};

  // Accumulators
  type DirAcc = {
    t1s: number[]; t5s: number[];
    t1Wins: number; t1Total: number;
    t5Wins: number; t5Total: number;
  };
  const dirAcc: Record<"gainer" | "loser", DirAcc> = {
    gainer: { t1s: [], t5s: [], t1Wins: 0, t1Total: 0, t5Wins: 0, t5Total: 0 },
    loser:  { t1s: [], t5s: [], t1Wins: 0, t1Total: 0, t5Wins: 0, t5Total: 0 },
  };
  type StageAcc = { t1s: number[]; t5s: number[] };
  const stageAcc: Record<string, StageAcc> = {};

  for (const r of records) {
    const dir = r.direction;
    const acc = dirAcc[dir];

    if (r.t1 !== undefined) {
      acc.t1s.push(r.t1);
      acc.t1Total++;
      // gainer win = return > 0; loser win = return < 0
      if (dir === "gainer" && r.t1 > 0) acc.t1Wins++;
      if (dir === "loser" && r.t1 < 0) acc.t1Wins++;
    }
    if (r.t5 !== undefined) {
      acc.t5s.push(r.t5);
      acc.t5Total++;
      if (dir === "gainer" && r.t5 > 0) acc.t5Wins++;
      if (dir === "loser" && r.t5 < 0) acc.t5Wins++;
    }

    if (r.stage) {
      if (!stageAcc[r.stage]) stageAcc[r.stage] = { t1s: [], t5s: [] };
      if (r.t1 !== undefined) stageAcc[r.stage].t1s.push(r.t1);
      if (r.t5 !== undefined) stageAcc[r.stage].t5s.push(r.t5);
    }
  }

  function avg(arr: number[]): number {
    if (arr.length === 0) return 0;
    return parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
  }
  function rate(wins: number, total: number): number {
    if (total === 0) return 0;
    return parseFloat(((wins / total) * 100).toFixed(2));
  }

  for (const dir of ["gainer", "loser"] as const) {
    const acc = dirAcc[dir];
    byDirection[dir] = {
      n: acc.t1s.length + (acc.t5s.length > acc.t1s.length ? acc.t5s.length - acc.t1s.length : 0),
      avgT1: avg(acc.t1s),
      avgT5: avg(acc.t5s),
      winRateT1: rate(acc.t1Wins, acc.t1Total),
      winRateT5: rate(acc.t5Wins, acc.t5Total),
    };
    // n = number of records that have at least t1
    byDirection[dir].n = acc.t1Total || acc.t5Total;
  }

  for (const [stage, acc] of Object.entries(stageAcc)) {
    byStage[stage] = {
      n: Math.max(acc.t1s.length, acc.t5s.length),
      avgT1: avg(acc.t1s),
      avgT5: avg(acc.t5s),
    };
  }

  return { byDirection, byStage };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ROOT = resolve(process.cwd());
const DATA = resolve(ROOT, "data");
const PRICE_HISTORY_DIR = resolve(DATA, "price-history");
const ANALYSIS_HISTORY_DIR = resolve(DATA, "analysis-history");
const MARKET_LATEST = resolve(DATA, "market-latest.json");
const ANALYSIS_LATEST = resolve(DATA, "analysis-latest.json");
const SCORECARD = resolve(DATA, "scorecard.json");
const MARKET_HISTORY = resolve(DATA, "market-history.json");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main() {
  mkdirSync(PRICE_HISTORY_DIR, { recursive: true });
  mkdirSync(ANALYSIS_HISTORY_DIR, { recursive: true });

  // ---- Step 1: Snapshot prices ----
  const market = readJson<MarketLatest>(MARKET_LATEST);
  const { tradingDate } = market;

  const priceHistoryFile = resolve(PRICE_HISTORY_DIR, `${tradingDate}.json`);
  if (!existsSync(priceHistoryFile)) {
    let closeMap: Record<string, number>;
    if (market.closeMap) {
      closeMap = market.closeMap;
    } else {
      // Fallback: derive from gainers/losers only
      closeMap = {};
      for (const s of [...market.gainers, ...market.losers]) {
        closeMap[s.code] = s.close;
      }
    }
    writeFileSync(priceHistoryFile, JSON.stringify(closeMap, null, 2), "utf-8");
    console.log(`[score] Saved price snapshot: ${priceHistoryFile}`);
  } else {
    console.log(`[score] Price snapshot already exists for ${tradingDate}, skipping.`);
  }

  // ---- Step 2: Snapshot analysis ----
  const analysis = readJson<AnalysisSnapshot>(ANALYSIS_LATEST);
  const analysisHistoryFile = resolve(ANALYSIS_HISTORY_DIR, `${analysis.date}.json`);
  if (!existsSync(analysisHistoryFile)) {
    writeFileSync(analysisHistoryFile, JSON.stringify(analysis, null, 2), "utf-8");
    console.log(`[score] Saved analysis snapshot: ${analysisHistoryFile}`);
  } else {
    console.log(`[score] Analysis snapshot already exists for ${analysis.date}, skipping.`);
  }

  // ---- Step 3: Compute forward returns ----
  // Load all price-history dates (sorted)
  const priceDates = readdirSync(PRICE_HISTORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .sort();

  // Load all analysis snapshots
  const analysisFiles = readdirSync(ANALYSIS_HISTORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const records: ScorecardRecord[] = [];

  for (const file of analysisFiles) {
    const snap = readJson<AnalysisSnapshot>(resolve(ANALYSIS_HISTORY_DIR, file));
    const baseDate = snap.date;

    // Load T0 prices
    const t0File = resolve(PRICE_HISTORY_DIR, `${baseDate}.json`);
    if (!existsSync(t0File)) continue;
    const t0Prices = readJson<Record<string, number>>(t0File);

    const [t1Date, t5Date] = findForwardDates(priceDates, baseDate);

    const t1Prices = t1Date ? readJson<Record<string, number>>(resolve(PRICE_HISTORY_DIR, `${t1Date}.json`)) : null;
    const t5Prices = t5Date ? readJson<Record<string, number>>(resolve(PRICE_HISTORY_DIR, `${t5Date}.json`)) : null;

    for (const direction of ["gainers", "losers"] as const) {
      const groups: AnalysisGroup[] = snap[direction] ?? [];
      for (const group of groups) {
        const t1 = t1Prices ? computeGroupReturn(group.stocks, t0Prices, t1Prices) : undefined;
        const t5 = t5Prices ? computeGroupReturn(group.stocks, t0Prices, t5Prices) : undefined;

        if (t1 === null && t5 === null) continue;

        const record: ScorecardRecord = {
          date: baseDate,
          category: group.category,
          direction: direction === "gainers" ? "gainer" : "loser",
          members: group.stocks.length,
        };
        if (group.stage) record.stage = group.stage;
        if (t1 !== null && t1 !== undefined) record.t1 = parseFloat(t1.toFixed(2));
        if (t5 !== null && t5 !== undefined) record.t5 = parseFloat(t5.toFixed(2));

        records.push(record);
      }
    }
  }

  // ---- Step 4: Write scorecard ----
  const aggregates = buildAggregates(records);
  const scorecard: Scorecard = {
    updatedAt: new Date().toISOString(),
    records,
    aggregates,
  };

  writeFileSync(SCORECARD, JSON.stringify(scorecard, null, 2), "utf-8");
  console.log(`[score] Wrote scorecard: ${SCORECARD}`);

  // Summary
  const scorable = records.filter((r) => r.t1 !== undefined || r.t5 !== undefined).length;
  console.log(`[score] Analysis snapshots: ${analysisFiles.length}`);
  console.log(`[score] Scorable records: ${scorable}`);
  console.log(`[score] byDirection gainer: n=${aggregates.byDirection.gainer.n} avgT1=${aggregates.byDirection.gainer.avgT1} avgT5=${aggregates.byDirection.gainer.avgT5} winT1=${aggregates.byDirection.gainer.winRateT1}% winT5=${aggregates.byDirection.gainer.winRateT5}%`);
  console.log(`[score] byDirection loser:  n=${aggregates.byDirection.loser.n} avgT1=${aggregates.byDirection.loser.avgT1} avgT5=${aggregates.byDirection.loser.avgT5} winT1=${aggregates.byDirection.loser.winRateT1}% winT5=${aggregates.byDirection.loser.winRateT5}%`);

  // ---- Step 5: Upsert market history ----
  const mktRaw = readJson<{ tradingDate?: string; market?: Record<string, unknown> }>(MARKET_LATEST);
  if (mktRaw.tradingDate && mktRaw.market) {
    const mkt = mktRaw.market as {
      microFuturesRetail?: { retailNetPct?: number; retailLong?: number; retailShort?: number };
      dayTrade?: { twseVolumePct?: number; tpexVolumePct?: number };
      taiex?: { close?: number; change?: number };
      tpex?: { close?: number; change?: number };
      breadth?: { up?: number; down?: number; limitUp?: number; limitDown?: number };
    };
    const mfr = mkt.microFuturesRetail;
    const retailNetLots =
      mfr && mfr.retailLong !== undefined && mfr.retailShort !== undefined
        ? mfr.retailLong - mfr.retailShort
        : null;
    const entry: MarketHistoryEntry = {
      date: mktRaw.tradingDate,
      retailNetPct: mfr?.retailNetPct ?? null,
      retailNetLots,
      twseDayTradePct: mkt.dayTrade?.twseVolumePct ?? null,
      tpexDayTradePct: mkt.dayTrade?.tpexVolumePct ?? null,
      taiexClose: mkt.taiex?.close ?? null,
      taiexChange: mkt.taiex?.change ?? null,
      tpexClose: mkt.tpex?.close ?? null,
      tpexChange: mkt.tpex?.change ?? null,
      up: mkt.breadth?.up ?? null,
      down: mkt.breadth?.down ?? null,
      limitUp: mkt.breadth?.limitUp ?? null,
      limitDown: mkt.breadth?.limitDown ?? null,
    };
    let history: MarketHistoryEntry[] = [];
    if (existsSync(MARKET_HISTORY)) {
      try {
        history = JSON.parse(readFileSync(MARKET_HISTORY, "utf-8"));
      } catch {
        history = [];
      }
    }
    history = upsertMarketHistory(history, entry);
    writeFileSync(MARKET_HISTORY, JSON.stringify(history, null, 2), "utf-8");
    console.log(`[score] Upserted market history for ${entry.date} → ${MARKET_HISTORY}`);
  }
}

// Only run when this script is the entry point (not when imported by other scripts)
const isMain = process.argv[1]?.endsWith("score-report.ts") || process.argv[1]?.endsWith("score-report.js");
if (isMain) main();
