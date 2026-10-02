import test from "node:test";
import assert from "node:assert/strict";
import {
  BUY_FEE,
  SELL_FEE,
  performanceStats,
  simulateCohort,
  type AdjustedRow,
  type CohortHolding,
} from "../scripts/lib/expanded-portfolio.ts";

const dates = Array.from({ length: 20 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
const row = (date: string, price: number, extra: Partial<AdjustedRow> = {}): AdjustedRow => ({
  date,
  adjustedOpen: price,
  adjustedClose: price,
  volume: 1000,
  open: price,
  close: price,
  high: price + 1,
  low: price - 1,
  ...extra,
});
const holding = (code: string, weight: number, rows: AdjustedRow[]): CohortHolding => ({
  code,
  weight,
  series: new Map(rows.map((r) => [r.date, r])),
});
const flatBenchmark = () => ({
  benchmarkRows: new Map(dates.map((date) => [date, { open: 100, close: 100 }])),
  benchmarkTR: new Map(dates.map((date) => [date, 100])),
});

test("charges entry and exit fees inside the fixed investment budget", () => {
  const stock = holding("2330", 1, [row(dates[0], 100), row(dates.at(-1)!, 110)]);
  const result = simulateCohort({ dates, holdings: [stock], ...flatBenchmark() });
  const expectedUnits = 1 / (1 + BUY_FEE) / 100;
  const expectedFinal = expectedUnits * 110 * (1 - SELL_FEE);
  assert.equal(result.valid, true);
  assert.equal(result.investedWeight, 1);
  assert.ok(Math.abs(result.portfolioDaily.at(-1)!.value - expectedFinal) < 1e-12);
  assert.ok(Math.abs(result.netReturnPct! - (expectedFinal - 1) * 100) < 1e-10);
});

test("supports a zero-holding cash cohort and marks the benchmark on the same dates", () => {
  const benchmarkRows = new Map(dates.map((date) => [date, { open: 100, close: 110 }]));
  const benchmarkTR = new Map(dates.map((date, i) => [date, i === 0 ? 110 : 121]));
  const result = simulateCohort({ dates, holdings: [], benchmarkRows, benchmarkTR });
  assert.equal(result.valid, true);
  assert.equal(result.portfolioDaily[0].value, 1);
  assert.equal(result.portfolioDaily.at(-1)!.value, 1);
  // Benchmark entry TR open = raw open * first-day TR close / raw close = 100.
  assert.ok(Math.abs(result.benchmarkReturnPct! - 21) < 1e-10);
});

test("invalid exit execution invalidates the selected stock instead of dropping it", () => {
  const stock = holding("2317", 0.5, [row(dates[0], 100), row(dates.at(-1)!, 120, { volume: 0 })]);
  const result = simulateCohort({ dates, holdings: [stock], ...flatBenchmark() });
  assert.equal(result.valid, false);
  assert.deepEqual(result.invalidCodes, ["2317"]);
  assert.equal(result.netReturnPct, null);
  assert.match(result.reason!, /2317: exit volume is missing or nonpositive/);
});

test("a zero-volume buy attempt keeps its allocation in cash without invalidating the cohort", () => {
  const stock = holding("2002", 0.4, [row(dates[0], 50, { volume: 0 }), row(dates.at(-1)!, 80)]);
  const result = simulateCohort({ dates, holdings: [stock], ...flatBenchmark() });
  assert.equal(result.valid, true);
  assert.deepEqual(result.failedEntryCodes, ["2002"]);
  assert.equal(result.portfolioDaily.at(-1)!.value, 1);
});

test("a one-price entry remains cash and is reported as a failed buy", () => {
  const onePrice = row(dates[0], 100, { open: 100, high: 100, low: 100 });
  const result = simulateCohort({ dates, holdings: [holding("2603", 0.5, [onePrice, row(dates.at(-1)!, 105)])], ...flatBenchmark() });
  assert.equal(result.valid, true);
  assert.deepEqual(result.failedEntryCodes, ["2603"]);
  assert.equal(result.invalidCodes.length, 0);
  assert.equal(result.portfolioDaily[0].value, 1);
  assert.equal(result.portfolioDaily.at(-1)!.value, 1);
});

test("carries the latest quote only for a missing middle mark and counts stale marks", () => {
  const stockRows = dates.filter((_, i) => i !== 2).map((date, i) => row(date, i < 2 ? 100 + i * 10 : 130 + i));
  const result = simulateCohort({ dates, holdings: [holding("2881", 1, stockRows)], ...flatBenchmark() });
  assert.equal(result.valid, true);
  assert.equal(result.staleMarkCount, 1);
  const afterFeesUnits = 1 / (1 + BUY_FEE) / 100;
  assert.ok(Math.abs(result.portfolioDaily[2].value - afterFeesUnits * 110) < 1e-12);
});

test("rejects invalid weights without redistributing capital", () => {
  const a = holding("1101", 0.7, [row(dates[0], 10), row(dates.at(-1)!, 10)]);
  const b = holding("1102", 0.31, [row(dates[0], 10), row(dates.at(-1)!, 10)]);
  const result = simulateCohort({ dates, holdings: [a, b], ...flatBenchmark() });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /weights sum to more than 1/);
});

test("reports CAGR and peak-to-trough drawdown from actual wealth values", () => {
  const stats = performanceStats([1, 1.1, 0.8, 1.2]);
  assert.equal(stats.observations, 4);
  assert.equal(stats.sessions, 3);
  assert.ok(Math.abs(stats.totalReturnPct! - 20) < 1e-12);
  assert.ok(Math.abs(stats.cagrPct! - (Math.pow(1.2, 252 / 3) - 1) * 100) < 1e-8);
  assert.ok(Math.abs(stats.maxDrawdownPct! - (1 - 0.8 / 1.1) * 100) < 1e-10);
});

test('an unresolved adjustment reset cannot become a trade return', () => {
  const stock = holding('RESET', 1, dates.map((date, i) => row(date, i < 8 ? 100 : 200, { segmentId: i < 8 ? 0 : 1 })));
  const result = simulateCohort({ dates, holdings: [stock], ...flatBenchmark() });
  assert.equal(result.valid, false);
  assert.equal(result.netReturnPct, null);
  assert.match(result.reason!, /unresolved price adjustment/);
});
