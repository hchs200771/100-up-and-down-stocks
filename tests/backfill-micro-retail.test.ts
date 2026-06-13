import assert from "node:assert/strict";
import test from "node:test";

import {
  parseInstiOiCsv,
  parseTotalOiCsv,
  computeRetailSeries,
} from "../scripts/backfill-micro-retail.ts";

import { upsertMarketHistory, type MarketHistoryEntry } from "../scripts/score-report.ts";

// ---------------------------------------------------------------------------
// parseInstiOiCsv
// ---------------------------------------------------------------------------

test("parseInstiOiCsv sums 3 identity rows per date", () => {
  // Header-like first line is skipped (no date pattern match)
  const csv = [
    "日期,商品名稱,身份別,多方交易口數,多方交易契約金額,空方交易口數,空方交易契約金額,多空交易口數淨額,多空交易契約金額淨額,多方未平倉口數,多方未平倉契約金額,空方未平倉口數,空方未平倉契約金額,多空未平倉口數淨額,多空未平倉契約金額淨額",
    "2026/01/02,微型臺指期貨,自營商,100,0,200,0,0,0,1000,0,2000,0,0,0",
    "2026/01/02,微型臺指期貨,投信,50,0,100,0,0,0,500,0,1000,0,0,0",
    "2026/01/02,微型臺指期貨,外資及陸資,200,0,400,0,0,0,2000,0,4000,0,0,0",
  ].join("\n");

  const result = parseInstiOiCsv(csv);
  assert.ok(result.has("2026-01-02"));
  const entry = result.get("2026-01-02")!;
  // instLong = 1000+500+2000 = 3500
  assert.equal(entry.instLong, 3500);
  // instShort = 2000+1000+4000 = 7000
  assert.equal(entry.instShort, 7000);
});

test("parseInstiOiCsv skips non-date rows", () => {
  const csv = [
    "這是標題列,不含日期",
    "2026/01/03,微型臺指期貨,外資及陸資,0,0,0,0,0,0,100,0,200,0,0,0",
  ].join("\n");

  const result = parseInstiOiCsv(csv);
  assert.equal(result.size, 1);
  assert.ok(result.has("2026-01-03"));
});

test("parseInstiOiCsv handles multiple dates", () => {
  const csv = [
    "2026/01/02,X,A,0,0,0,0,0,0,100,0,200,0,0,0",
    "2026/01/03,X,A,0,0,0,0,0,0,300,0,400,0,0,0",
  ].join("\n");

  const result = parseInstiOiCsv(csv);
  assert.equal(result.size, 2);
  assert.equal(result.get("2026-01-02")!.instLong, 100);
  assert.equal(result.get("2026-01-03")!.instLong, 300);
});

// ---------------------------------------------------------------------------
// parseTotalOiCsv
// ---------------------------------------------------------------------------

test("parseTotalOiCsv only sums 一般 session rows", () => {
  // cols: date(0)...oi(11)...session(17)... (20 cols total matching TAIFEX format)
  const makeRow = (date: string, oi: string, session: string) => {
    // 20 columns; oi at 11, session at 17
    const cols = [date, "TMF", "202601", "0", "0", "0", "0", "0", "0", "0", "0", oi, "0", "0", "0", "0", "", session, "", ""];
    return cols.join(",");
  };

  const csv = [
    makeRow("2026/01/02", "5000", "一般"),
    makeRow("2026/01/02", "3000", "盤後"),
    makeRow("2026/01/02", "2000", "一般"),
  ].join("\n");

  const result = parseTotalOiCsv(csv);
  assert.ok(result.has("2026-01-02"));
  // Only 一般 rows: 5000+2000 = 7000
  assert.equal(result.get("2026-01-02"), 7000);
});

test("parseTotalOiCsv skips rows with dash OI", () => {
  const makeRow = (date: string, oi: string, session: string) => {
    const cols = [date, "TMF", "202601", "0", "0", "0", "0", "0", "0", "0", "0", oi, "0", "0", "0", "0", "", session, "", ""];
    return cols.join(",");
  };

  const csv = [
    makeRow("2026/01/03", "-", "一般"),
    makeRow("2026/01/03", "4000", "一般"),
  ].join("\n");

  const result = parseTotalOiCsv(csv);
  assert.equal(result.get("2026-01-03"), 4000);
});

// ---------------------------------------------------------------------------
// computeRetailSeries
// ---------------------------------------------------------------------------

test("computeRetailSeries computes retailNetPct and retailNetLots correctly", () => {
  const instiMap = new Map([
    ["2026-01-02", { instLong: 1000, instShort: 3000 }],
  ]);
  const totalMap = new Map([["2026-01-02", 10000]]);

  const series = computeRetailSeries(instiMap, totalMap);
  assert.equal(series.length, 1);
  // (3000-1000)/10000 * 100 = 20.00
  assert.equal(series[0].retailNetPct, 20.00);
  // retailNetLots = instShort - instLong = 3000 - 1000 = 2000
  assert.equal(series[0].retailNetLots, 2000);
  assert.equal(series[0].date, "2026-01-02");
});

test("computeRetailSeries skips dates missing from totalMap", () => {
  const instiMap = new Map([
    ["2026-01-02", { instLong: 1000, instShort: 2000 }],
    ["2026-01-03", { instLong: 500, instShort: 1000 }],
  ]);
  const totalMap = new Map([["2026-01-02", 5000]]);

  const series = computeRetailSeries(instiMap, totalMap);
  assert.equal(series.length, 1);
  assert.equal(series[0].date, "2026-01-02");
  // retailNetLots present on surviving row
  assert.equal(series[0].retailNetLots, 1000);
});

test("computeRetailSeries returns sorted by date ascending", () => {
  const instiMap = new Map([
    ["2026-01-05", { instLong: 100, instShort: 200 }],
    ["2026-01-02", { instLong: 100, instShort: 200 }],
  ]);
  const totalMap = new Map([
    ["2026-01-05", 1000],
    ["2026-01-02", 1000],
  ]);

  const series = computeRetailSeries(instiMap, totalMap);
  assert.equal(series[0].date, "2026-01-02");
  assert.equal(series[1].date, "2026-01-05");
  // Both rows should have retailNetLots = 200 - 100 = 100
  assert.equal(series[0].retailNetLots, 100);
  assert.equal(series[1].retailNetLots, 100);
});

// ---------------------------------------------------------------------------
// upsertMarketHistory (from score-report)
// ---------------------------------------------------------------------------

test("upsertMarketHistory inserts new entry sorted", () => {
  const history: MarketHistoryEntry[] = [
    { date: "2026-01-01", retailNetPct: 5 },
    { date: "2026-01-05", retailNetPct: -3 },
  ];
  const result = upsertMarketHistory(history, { date: "2026-01-03", retailNetPct: 10 });
  assert.equal(result.length, 3);
  assert.equal(result[0].date, "2026-01-01");
  assert.equal(result[1].date, "2026-01-03");
  assert.equal(result[2].date, "2026-01-05");
});

test("upsertMarketHistory overwrites same date", () => {
  const history: MarketHistoryEntry[] = [
    { date: "2026-01-01", retailNetPct: 5 },
  ];
  const result = upsertMarketHistory(history, { date: "2026-01-01", retailNetPct: -7 });
  assert.equal(result.length, 1);
  assert.equal(result[0].retailNetPct, -7);
});

test("upsertMarketHistory handles empty history", () => {
  const result = upsertMarketHistory([], { date: "2026-01-01", retailNetPct: 1.23 });
  assert.equal(result.length, 1);
  assert.equal(result[0].date, "2026-01-01");
});
