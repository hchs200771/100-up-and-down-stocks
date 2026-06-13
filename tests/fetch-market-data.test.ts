import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRocDate,
  parseDispositionPeriod,
  parseT86,
  parseTpexInsti,
  parseDayTrade,
  computeMicroRetail,
  computeBreadth,
  parseIssuedShares,
  computeBuyStreak,
} from "../scripts/fetch-market-data.ts";

// ---------------------------------------------------------------------------
// parseRocDate
// ---------------------------------------------------------------------------

test("parseRocDate parses slash format 115/06/13", () => {
  const d = parseRocDate("115/06/13");
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5); // 0-based June
  assert.equal(d.getDate(), 13);
});

test("parseRocDate parses compact format 1150613", () => {
  const d = parseRocDate("1150613");
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5);
  assert.equal(d.getDate(), 13);
});

test("parseRocDate returns null for garbage input", () => {
  assert.equal(parseRocDate("not-a-date"), null);
  assert.equal(parseRocDate(""), null);
});

// ---------------------------------------------------------------------------
// parseDispositionPeriod
// ---------------------------------------------------------------------------

test("parseDispositionPeriod parses TWSE slash format", () => {
  const result = parseDispositionPeriod("115/06/02～115/06/15", "slash");
  assert.ok(result !== null);
  assert.equal(result!.start.getFullYear(), 2026);
  assert.equal(result!.start.getDate(), 2);
  assert.equal(result!.end.getDate(), 15);
});

test("parseDispositionPeriod parses TPEx compact format", () => {
  const result = parseDispositionPeriod("1150615~1150629", "compact");
  assert.ok(result !== null);
  assert.equal(result!.start.getDate(), 15);
  assert.equal(result!.end.getDate(), 29);
});

test("parseDispositionPeriod returns null for malformed input", () => {
  assert.equal(parseDispositionPeriod("115/06/02", "slash"), null);
  assert.equal(parseDispositionPeriod("", "compact"), null);
});

// ---------------------------------------------------------------------------
// parseT86
// ---------------------------------------------------------------------------

test("parseT86 returns empty map for non-OK stat", () => {
  const result = parseT86({ stat: "FAIL", data: [] });
  assert.equal(result.size, 0);
});

test("parseT86 converts shares to 張 and combines foreign indices", () => {
  // idx0=code, idx4=外陸資買(不含自營), idx7=外資自營, idx10=投信, idx11=自營, idx18=合計
  const row = new Array(19).fill("0");
  row[0] = "2330";
  row[4] = "10,000";   // foreignNet partial (shares)
  row[7] = "5,000";    // foreignNet partial (shares)
  row[10] = "3,000";   // trustNet (shares)
  row[11] = "2,000";   // dealerNet (shares)
  row[18] = "20,000";  // totalNet (shares)

  const map = parseT86({ stat: "OK", data: [row] });
  assert.equal(map.size, 1);
  const chips = map.get("2330")!;
  assert.equal(chips.foreignNet, 15);   // (10000+5000)/1000
  assert.equal(chips.trustNet, 3);      // 3000/1000
  assert.equal(chips.dealerNet, 2);     // 2000/1000
  assert.equal(chips.totalNet, 20);     // 20000/1000
});

test("parseT86 rounds fractional張", () => {
  const row = new Array(19).fill("0");
  row[0] = "1234";
  row[4] = "1500"; // 1.5 張
  row[7] = "0";
  row[10] = "0";
  row[11] = "0";
  row[18] = "1500";

  const map = parseT86({ stat: "OK", data: [row] });
  const chips = map.get("1234")!;
  assert.equal(chips.foreignNet, 2);  // Math.round(1.5)
});

// ---------------------------------------------------------------------------
// parseTpexInsti
// ---------------------------------------------------------------------------

test("parseTpexInsti returns empty map for missing tables", () => {
  assert.equal(parseTpexInsti(null).size, 0);
  assert.equal(parseTpexInsti({}).size, 0);
});

test("parseTpexInsti maps correct column indices", () => {
  // 24-col row: 0=code, 10=foreignNet, 13=trustNet, 22=dealerNet, 23=totalNet
  const row = new Array(24).fill("0");
  row[0] = "6488";
  row[10] = "6,000";  // foreignNet shares
  row[13] = "2,000";  // trustNet shares
  row[22] = "1,000";  // dealerNet shares
  row[23] = "9,000";  // totalNet shares

  const map = parseTpexInsti({ tables: [{ data: [row] }] });
  assert.equal(map.size, 1);
  const chips = map.get("6488")!;
  assert.equal(chips.foreignNet, 6);
  assert.equal(chips.trustNet, 2);
  assert.equal(chips.dealerNet, 1);
  assert.equal(chips.totalNet, 9);
});

// ---------------------------------------------------------------------------
// parseDayTrade
// ---------------------------------------------------------------------------

test("parseDayTrade returns nulls for missing data", () => {
  const result = parseDayTrade(null);
  assert.equal(result.twseVolumePct, null);
  assert.equal(result.perStock.size, 0);
});

test("parseDayTrade extracts market pct and per-stock shares", () => {
  const fixture = {
    tables: [
      { data: [["3,073,728,000", "24.91", "461,660,672,500", "39.48", "461,899,489,600", "39.50"]] },
      { data: [["2330", "台積電", "", "5,000", "100,000", "100,000"]] },
    ],
  };

  const result = parseDayTrade(fixture);
  assert.equal(result.twseVolumePct, 24.91);
  assert.equal(result.perStock.get("2330"), 5000);
});

test("parseDayTrade skips rows with zero shares", () => {
  const fixture = {
    tables: [
      { data: [["0", "0.00", "0", "0", "0", "0"]] },
      { data: [["9999", "test", "", "0", "0", "0"]] },
    ],
  };
  const result = parseDayTrade(fixture);
  assert.equal(result.perStock.size, 0);
});

// ---------------------------------------------------------------------------
// computeMicroRetail
// ---------------------------------------------------------------------------

test("computeMicroRetail returns null for empty inputs", () => {
  assert.equal(computeMicroRetail([], []), null);
  assert.equal(computeMicroRetail(null as any, null as any), null);
});

test("computeMicroRetail computes retail long/short/netPct", () => {
  const instiRows = [
    { ContractCode: "微型臺指期貨", Item: "自營商", "OpenInterest(Long)": "100", "OpenInterest(Short)": "200", Date: "20260611" },
    { ContractCode: "微型臺指期貨", Item: "投信", "OpenInterest(Long)": "50", "OpenInterest(Short)": "100", Date: "20260611" },
    { ContractCode: "微型臺指期貨", Item: "外資及陸資", "OpenInterest(Long)": "150", "OpenInterest(Short)": "300", Date: "20260611" },
    { ContractCode: "OTHER", Item: "外資及陸資", "OpenInterest(Long)": "9999", "OpenInterest(Short)": "9999", Date: "20260611" },
  ];
  // instLong=300, instShort=600
  const totalOIRows = [
    { Contract: "TMF", TradingSession: "一般", OpenInterest: "1000" },
    { Contract: "TMF", TradingSession: "一般", OpenInterest: "500" },
    { Contract: "OTHER", TradingSession: "一般", OpenInterest: "9999" },
  ];
  // totalOI=1500, retailLong=1500-300=1200, retailShort=1500-600=900
  const result = computeMicroRetail(instiRows, totalOIRows);
  assert.ok(result !== null);
  assert.equal(result!.dataDate, "20260611");
  assert.equal(result!.totalOI, 1500);
  assert.equal(result!.instLong, 300);
  assert.equal(result!.instShort, 600);
  assert.equal(result!.retailLong, 1200);
  assert.equal(result!.retailShort, 900);
  // institutions net short 300 → retail net long: (1200-900)/1500 * 100 = +20
  assert.ok(Math.abs(result!.retailNetPct - 20) < 0.001);
});

// ---------------------------------------------------------------------------
// computeBreadth
// ---------------------------------------------------------------------------

test("computeBreadth counts up/down/flat/limitUp/limitDown", () => {
  const stocks = [
    { code: "A", name: "A", pct: 10, close: 10, amount: "0" },
    { code: "B", name: "B", pct: 9.9, close: 10, amount: "0" },
    { code: "C", name: "C", pct: 5, close: 10, amount: "0" },
    { code: "D", name: "D", pct: 0, close: 10, amount: "0" },
    { code: "E", name: "E", pct: -5, close: 10, amount: "0" },
    { code: "F", name: "F", pct: -9.9, close: 10, amount: "0" },
    { code: "G", name: "G", pct: -10, close: 10, amount: "0" },
  ];

  const b = computeBreadth(stocks);
  assert.equal(b.up, 3);
  assert.equal(b.down, 3);
  assert.equal(b.flat, 1);
  assert.equal(b.limitUp, 2);   // 10 and 9.9 (>=9.8)
  assert.equal(b.limitDown, 2); // -9.9 and -10 (<=-9.8)
});

// ---------------------------------------------------------------------------
// parseIssuedShares
// ---------------------------------------------------------------------------

test("parseIssuedShares parses TWSE items", () => {
  const twse = [
    { "公司代號": "2330", "已發行普通股數或TDR原股發行股數": "25932370067" },
    { "公司代號": "2317", "已發行普通股數或TDR原股發行股數": "13864329123" },
  ];
  const map = parseIssuedShares(twse, null);
  assert.equal(map.get("2330"), 25932370067);
  assert.equal(map.get("2317"), 13864329123);
});

test("parseIssuedShares parses TPEx items", () => {
  const tpex = [
    { SecuritiesCompanyCode: "3105", IssueShares: "423940384" },
  ];
  const map = parseIssuedShares(null, tpex);
  assert.equal(map.get("3105"), 423940384);
});

test("parseIssuedShares strips commas from share counts", () => {
  const twse = [
    { "公司代號": "2330", "已發行普通股數或TDR原股發行股數": "25,932,370,067" },
  ];
  const map = parseIssuedShares(twse, null);
  assert.equal(map.get("2330"), 25932370067);
});

test("parseIssuedShares merges TWSE and TPEx", () => {
  const twse = [{ "公司代號": "2330", "已發行普通股數或TDR原股發行股數": "25932370067" }];
  const tpex = [{ SecuritiesCompanyCode: "3105", IssueShares: "423940384" }];
  const map = parseIssuedShares(twse, tpex);
  assert.equal(map.size, 2);
  assert.equal(map.get("2330"), 25932370067);
  assert.equal(map.get("3105"), 423940384);
});

test("parseIssuedShares skips items with zero or missing shares", () => {
  const twse = [
    { "公司代號": "9999", "已發行普通股數或TDR原股發行股數": "0" },
    { "公司代號": "8888", "已發行普通股數或TDR原股發行股數": "" },
    { "公司代號": "7777" },
  ];
  const map = parseIssuedShares(twse, null);
  assert.equal(map.size, 0);
});

test("parseIssuedShares handles null inputs gracefully", () => {
  const map = parseIssuedShares(null, null);
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// foreignRatio calculation (boundary tests)
// ---------------------------------------------------------------------------

test("foreignRatio boundary: exactly 0.3% threshold", () => {
  // foreignNet=300張, issuedShares=100,000,000股
  // ratio = 300*1000/100000000*100 = 0.30
  const issuedShares = 100_000_000;
  const foreignNet = 300; // 張
  const foreignRatio = Math.round(foreignNet * 1000 / issuedShares * 100 * 100) / 100;
  assert.equal(foreignRatio, 0.3);
});

test("foreignRatio: positive foreignNet yields positive ratio", () => {
  const issuedShares = 25_932_370_067;
  const foreignNet = 10000; // 張
  const foreignRatio = Math.round(foreignNet * 1000 / issuedShares * 100 * 100) / 100;
  assert.ok(foreignRatio > 0);
});

test("foreignRatio: negative foreignNet yields negative ratio", () => {
  const issuedShares = 25_932_370_067;
  const foreignNet = -5000; // 張
  const foreignRatio = Math.round(foreignNet * 1000 / issuedShares * 100 * 100) / 100;
  assert.ok(foreignRatio < 0);
});

test("foreignRatio: 2330 verification (10000張 buy)", () => {
  const issuedShares = 25_932_370_067;
  const foreignNet = 10000;
  const foreignRatio = Math.round(foreignNet * 1000 / issuedShares * 100 * 100) / 100;
  // 10000*1000/25932370067*100 ≈ 0.04%
  assert.ok(foreignRatio > 0 && foreignRatio < 1);
});

// ---------------------------------------------------------------------------
// trustRatio calculation
// ---------------------------------------------------------------------------

test("trustRatio: same formula as foreignRatio, 0.1% threshold", () => {
  // trustNet=100張, issuedShares=100,000,000股
  // ratio = 100*1000/100000000*100 = 0.10
  const issuedShares = 100_000_000;
  const trustNet = 100;
  const trustRatio = Math.round(trustNet * 1000 / issuedShares * 100 * 100) / 100;
  assert.equal(trustRatio, 0.1);
});

test("trustRatio: negative trustNet yields negative ratio", () => {
  const issuedShares = 100_000_000;
  const trustNet = -200;
  const trustRatio = Math.round(trustNet * 1000 / issuedShares * 100 * 100) / 100;
  assert.ok(trustRatio < 0);
});

// ---------------------------------------------------------------------------
// computeBuyStreak
// ---------------------------------------------------------------------------

test("computeBuyStreak: empty array returns 0", () => {
  assert.equal(computeBuyStreak([]), 0);
});

test("computeBuyStreak: today not a buy day returns 0", () => {
  const data = [
    { date: "2026-06-12", net: -100 },
    { date: "2026-06-11", net: 200 },
    { date: "2026-06-10", net: 300 },
  ];
  assert.equal(computeBuyStreak(data), 0);
});

test("computeBuyStreak: all buy days returns full count", () => {
  const data = [
    { date: "2026-06-12", net: 100 },
    { date: "2026-06-11", net: 200 },
    { date: "2026-06-10", net: 50 },
  ];
  assert.equal(computeBuyStreak(data), 3);
});

test("computeBuyStreak: streak breaks in the middle", () => {
  const data = [
    { date: "2026-06-12", net: 100 },
    { date: "2026-06-11", net: 200 },
    { date: "2026-06-10", net: -50 },  // sold
    { date: "2026-06-09", net: 400 },
  ];
  assert.equal(computeBuyStreak(data), 2);
});

test("computeBuyStreak: zero net is not a buy day (streak breaks)", () => {
  const data = [
    { date: "2026-06-12", net: 100 },
    { date: "2026-06-11", net: 0 },   // zero = not buy
    { date: "2026-06-10", net: 300 },
  ];
  assert.equal(computeBuyStreak(data), 1);
});
