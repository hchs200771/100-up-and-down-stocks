import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStockCode,
  computeGroupReturn,
  findForwardDates,
  buildAggregates,
} from "../scripts/score-report.ts";

// ---------------------------------------------------------------------------
// parseStockCode
// ---------------------------------------------------------------------------

test("parseStockCode extracts code from 名稱(代號) format", () => {
  assert.equal(parseStockCode("華通(2313)"), "2313");
  assert.equal(parseStockCode("第一金太空衛星(00910)"), "00910");
  assert.equal(parseStockCode("鼎炫-KY(8499)"), "8499");
});

test("parseStockCode returns null when no parentheses", () => {
  assert.equal(parseStockCode("無括號"), null);
  assert.equal(parseStockCode(""), null);
});

// ---------------------------------------------------------------------------
// computeGroupReturn
// ---------------------------------------------------------------------------

test("computeGroupReturn returns equal-weight average return", () => {
  const stocks = ["華通(2313)", "南亞科(2408)"];
  const t0 = { "2313": 100, "2408": 200 };
  const tN = { "2313": 110, "2408": 220 };
  // 2313: (110-100)/100*100 = 10%; 2408: (220-200)/200*100 = 10%
  const result = computeGroupReturn(stocks, t0, tN);
  assert.equal(result, 10);
});

test("computeGroupReturn skips members missing from either snapshot", () => {
  const stocks = ["有價格(1111)", "無T0(2222)", "無TN(3333)"];
  const t0 = { "1111": 50, "3333": 80 };
  const tN = { "1111": 60, "2222": 70 };
  // only 1111 has both: (60-50)/50*100 = 20%
  const result = computeGroupReturn(stocks, t0, tN);
  assert.equal(result, 20);
});

test("computeGroupReturn returns null when no members have both prices", () => {
  const stocks = ["無資料(9999)"];
  const result = computeGroupReturn(stocks, {}, {});
  assert.equal(result, null);
});

test("computeGroupReturn handles mixed positive/negative returns", () => {
  const stocks = ["漲(1001)", "跌(1002)"];
  const t0 = { "1001": 100, "1002": 100 };
  const tN = { "1001": 120, "1002": 80 };
  // +20% and -20% → avg 0
  const result = computeGroupReturn(stocks, t0, tN);
  assert.equal(result, 0);
});

// ---------------------------------------------------------------------------
// findForwardDates
// ---------------------------------------------------------------------------

test("findForwardDates returns T+1 and T+5 from sorted date list", () => {
  // index: 0           1           2           3           4           5
  const dates = ["2026-01-01", "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
  const [t1, t5] = findForwardDates(dates, "2026-01-01");
  assert.equal(t1, "2026-01-02"); // idx 0+1 = 1
  assert.equal(t5, "2026-01-08"); // idx 0+5 = 5
});

test("findForwardDates returns undefined when baseDate not in list", () => {
  const dates = ["2026-01-01", "2026-01-02"];
  const [t1, t5] = findForwardDates(dates, "2026-01-03");
  assert.equal(t1, undefined);
  assert.equal(t5, undefined);
});

test("findForwardDates returns undefined T5 when fewer than 5 days after base", () => {
  const dates = ["2026-01-01", "2026-01-02", "2026-01-03"];
  const [t1, t5] = findForwardDates(dates, "2026-01-01");
  assert.equal(t1, "2026-01-02");
  assert.equal(t5, undefined);
});

// ---------------------------------------------------------------------------
// buildAggregates
// ---------------------------------------------------------------------------

test("buildAggregates returns zeros when no records", () => {
  const agg = buildAggregates([]);
  assert.equal(agg.byDirection.gainer.n, 0);
  assert.equal(agg.byDirection.loser.n, 0);
  assert.deepEqual(agg.byStage, {});
});

test("buildAggregates computes gainer win rate (return > 0 = win)", () => {
  const records = [
    { date: "2026-01-01", category: "A", direction: "gainer" as const, members: 3, t1: 5 },
    { date: "2026-01-01", category: "B", direction: "gainer" as const, members: 3, t1: -2 },
  ];
  const agg = buildAggregates(records);
  assert.equal(agg.byDirection.gainer.n, 2);
  assert.equal(agg.byDirection.gainer.winRateT1, 50);
  assert.equal(agg.byDirection.gainer.avgT1, 1.5);
});

test("buildAggregates computes loser win rate (return < 0 = win)", () => {
  const records = [
    { date: "2026-01-01", category: "X", direction: "loser" as const, members: 2, t1: -3 },
    { date: "2026-01-01", category: "Y", direction: "loser" as const, members: 2, t1: 1 },
  ];
  const agg = buildAggregates(records);
  assert.equal(agg.byDirection.loser.winRateT1, 50);
  assert.equal(agg.byDirection.loser.avgT1, -1);
});

test("buildAggregates groups by stage", () => {
  const records = [
    { date: "2026-01-01", category: "A", direction: "gainer" as const, members: 3, stage: "啟動", t1: 10 },
    { date: "2026-01-01", category: "B", direction: "gainer" as const, members: 2, stage: "啟動", t1: 20 },
  ];
  const agg = buildAggregates(records);
  assert.ok(agg.byStage["啟動"]);
  assert.equal(agg.byStage["啟動"].n, 2);
  assert.equal(agg.byStage["啟動"].avgT1, 15);
});
