import assert from "node:assert/strict";
import test from "node:test";
import { selectFactorCandidates, percentileRanks, type FactorCandidate } from "../scripts/backtest-novel-factors.ts";
import { BUY_FEE, SELL_FEE, simulateCohort, type AdjustedRow } from "../scripts/lib/expanded-portfolio.ts";
import { pairedBlockInterval } from "../scripts/backtest-price-market-events.ts";

function candidate(code: string, values: Omit<FactorCandidate, "stock">): FactorCandidate {
  return { stock: { code } as FactorCandidate["stock"], ...values };
}

const pool = [
  candidate("C", { total: 3, day: 1, negativeNight: 3, residual: 3 }),
  candidate("A", { total: 2, day: 3, negativeNight: 2, residual: 2 }),
  candidate("B", { total: 1, day: 2, negativeNight: 1, residual: 1 }),
];

test("percentile ranks give ties their midrank and selection breaks ties by code", () => {
  const tied = [candidate("B", { total: 1, day: 4, negativeNight: 0, residual: 1 }),
    candidate("A", { total: 1, day: 4, negativeNight: 0, residual: 1 }),
    candidate("C", { total: 2, day: 1, negativeNight: 0, residual: 2 })];
  const ranks = percentileRanks(tied, (c) => c.day);
  assert.equal(ranks.get("A"), 0.75);
  assert.equal(ranks.get("B"), 0.75);
  assert.equal(ranks.get("C"), 0);
  assert.deepEqual(selectFactorCandidates("day_momentum", tied, 3).map((c) => c.stock.code), ["A", "B", "C"]);
});

test("factor rules select day momentum, negative-night reversal, and equal-rank combination", () => {
  assert.deepEqual(selectFactorCandidates("day_momentum", pool, 1).map((c) => c.stock.code), ["A"]);
  assert.deepEqual(selectFactorCandidates("night_reversal", pool, 1).map((c) => c.stock.code), ["C"]);
  const combined = [
    candidate("A", { total: 0, day: 3, negativeNight: 1, residual: 0 }),
    candidate("B", { total: 0, day: 2, negativeNight: 2, residual: 0 }),
    candidate("C", { total: 0, day: 1, negativeNight: 3, residual: 0 }),
  ];
  assert.deepEqual(selectFactorCandidates("split_combination", combined, 3).map((c) => c.stock.code), ["A", "B", "C"]);
});

test("residual rules reject a null residual pool and unknown rules fail", () => {
  const incomplete = [pool[0], candidate("MISSING", { total: 0, day: 0, negativeNight: 0, residual: null })];
  assert.throws(() => selectFactorCandidates("market_residual", incomplete, 1), /complete residual data/);
  assert.throws(() => selectFactorCandidates("residual_combination", incomplete, 1), /complete residual data/);
  assert.throws(() => selectFactorCandidates("invented", pool, 1), /Unknown factor rule invented/);
});

test("short holding horizons can bootstrap a longer dependence block without changing the legacy default", () => {
  const deltas = Array.from({ length: 180 }, (_, i) => Math.sin(i / 20));
  assert.equal(pairedBlockInterval(deltas, 1729, 90).blockLength, 3);
  assert.equal(pairedBlockInterval(deltas, 1729, 90, undefined, 30).blockLength, 30);
  assert.throws(() => pairedBlockInterval(deltas, 1729, 90, undefined, 0), /positive integer/);
});

const row = (date: string, open: number, close: number, extra: Partial<AdjustedRow> = {}): AdjustedRow => ({
  date, adjustedOpen: open, adjustedClose: close, volume: 100,
  open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, ...extra,
});
const twoDates = ["2026-01-05", "2026-01-06"];
const benchmark = () => ({
  benchmarkRows: new Map(twoDates.map((date) => [date, { open: 100, close: 100 }])),
  benchmarkTR: new Map(twoDates.map((date) => [date, 100])),
});

test("two-session cohort enters at first date open, exits at last date close, and charges both fees", () => {
  const series = new Map(twoDates.map((date, i) => [date, i === 0 ? row(date, 100, 101) : row(date, 110, 120)]));
  const result = simulateCohort({ dates: twoDates, holdings: [{ code: "AAA", weight: 1, series }], ...benchmark(), holdingSessions: 2 });
  const expected = 120 / 100 / (1 + BUY_FEE) * (1 - SELL_FEE);
  assert.equal(result.valid, true);
  assert.equal(result.portfolioDaily[0].value, 1 / (1 + BUY_FEE) * 101 / 100);
  assert.ok(Math.abs(result.portfolioDaily.at(-1)!.value - expected) < 1e-12);
  assert.equal(result.sessions, 2);
  assert.equal(simulateCohort({ dates: twoDates, holdings: [], ...benchmark() }).valid, false);
});

test("two-session failed buys stay in cash and one-price exits invalidate", () => {
  const failedBuy = new Map(twoDates.map((date, i) => [date, row(date, 100, 100, i === 0 ? { volume: 0 } : {})]));
  const cashResult = simulateCohort({ dates: twoDates, holdings: [{ code: "CASH", weight: 0.6, series: failedBuy }], ...benchmark(), holdingSessions: 2 });
  assert.equal(cashResult.valid, true);
  assert.deepEqual(cashResult.failedEntryCodes, ["CASH"]);
  assert.equal(cashResult.portfolioDaily.at(-1)!.value, 1);

  const onePriceExit = new Map(twoDates.map((date, i) => [date, i === 0 ? row(date, 100, 100) : row(date, 110, 110, { high: 110, low: 110 })]));
  const invalidExit = simulateCohort({ dates: twoDates, holdings: [{ code: "LIMIT", weight: 0.5, series: onePriceExit }], ...benchmark(), holdingSessions: 2 });
  assert.equal(invalidExit.valid, false);
  assert.deepEqual(invalidExit.invalidCodes, ["LIMIT"]);
  assert.match(invalidExit.reason!, /one-price bar/);
});
