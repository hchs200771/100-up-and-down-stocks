import assert from "node:assert/strict";
import test from "node:test";
import { buildAdjustedSeries, cappedInverseVolWeights, featuresAt, type AdjustedSeriesRow, type RawOHLC } from "../scripts/lib/expanded-backtest-features.ts";

function datesFrom(start: string, count: number): string[] {
  const first = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(first + i * 86_400_000).toISOString().slice(0, 10));
}
function rawRows(dates: string[], close: (i: number) => number = (i) => 100 + i): RawOHLC[] {
  return dates.map((date, i) => ({ date, open: close(i), max: close(i) + 1, min: close(i) - 1, close: close(i), Trading_money: 50_000_000, Trading_Volume: 100 }));
}
const asMap = (rows: AdjustedSeriesRow[]) => new Map(rows.map((row) => [row.date, row]));

test("cash dividend reference-price factor applies on ex-date and later, never earlier", () => {
  const dates = datesFrom("2026-01-01", 3);
  const series = buildAdjustedSeries(rawRows(dates, () => 90), [{ dataset: "TaiwanStockDividendResult", date: dates[1], before_price: 100, after_price: 90, kind: "除息" }], dates);
  assert.equal(series[0].adjustmentFactor, 1);
  assert.equal(series[0].adjustedClose, 90);
  assert.ok(Math.abs(series[1].adjustedClose! - 100) < 1e-10);
  assert.ok(Math.abs(series[2].adjustedClose! - 100) < 1e-10);
  assert.equal(series[1].cashExDate, true);
  assert.equal(series[2].cashExDate, false);
});

test("a factor for a date absent from raw rows applies on the first following row", () => {
  const dates = datesFrom("2026-01-01", 3);
  const series = buildAdjustedSeries(rawRows([dates[0], dates[2]], () => 90), [{ dataset: "DividendResult", date: dates[1], before_price: 100, after_price: 90, kind: "除息" }], dates);
  assert.equal(series[0].adjustmentFactor, 1);
  assert.ok(Math.abs(series[1].adjustedClose! - 100) < 1e-10);
  assert.equal(series[1].cashExDate, false);
});

test("future corporate action does not change any already-known adjusted features", () => {
  const dates = datesFrom("2026-01-01", 63);
  const rows = rawRows(dates);
  const noFutureEvent = buildAdjustedSeries(rows, [], dates);
  const withFutureEvent = buildAdjustedSeries(rows, [{ dataset: "TaiwanStockDividendResult", date: dates[61], before_price: 200, after_price: 100, kind: "除息" }], dates);
  const signalDate = dates[60];
  assert.deepEqual(featuresAt(asMap(withFutureEvent), signalDate, dates), featuresAt(asMap(noFutureEvent), signalDate, dates));
  assert.equal(featuresAt(asMap(withFutureEvent), signalDate, dates)?.cashExAge, null);
});

test("features use exact prior 20 and 60 session windows and return null for missing required rows", () => {
  const dates = datesFrom("2026-01-01", 61);
  const raws = rawRows(dates);
  raws[60].Trading_Volume = 200;
  raws.forEach((row, i) => { row.Trading_money = i === 60 ? 100_000_000 : 50_000_000; });
  const series = buildAdjustedSeries(raws, [], dates);
  const features = featuresAt(asMap(series), dates[60], dates)!;
  assert.equal(features.adjustedMa20, 150.5);
  assert.equal(features.adjustedMa60, 130.5);
  assert.ok(Math.abs(features.r20 - (160 / 140 - 1) * 100) < 1e-10);
  assert.equal(features.prior20AdjustedHigh, 160);
  assert.equal(features.volumeMultiple, 2);
  assert.equal(features.avgTurnover20, 52_500_000);
  const incomplete = asMap(series);
  incomplete.delete(dates[12]);
  assert.equal(featuresAt(incomplete, dates[60], dates), null);
  assert.equal(featuresAt(asMap(series), dates[59], dates), null);
});

test("feature windows accept zero activity as observed data and null volume multiple for zero denominator", () => {
  const dates = datesFrom("2026-01-01", 61);
  const raws = rawRows(dates);
  raws.forEach((row, i) => { row.Trading_Volume = i < 60 ? 0 : 50; row.Trading_money = i < 60 ? 0 : 25; });
  const series = buildAdjustedSeries(raws, [], dates);
  const result = featuresAt(asMap(series), dates[60], dates);
  assert.ok(result);
  assert.equal(result?.volumeMultiple, null);
  assert.equal(result?.avgTurnover20, 1.25);
});

test("cash ex age is measured in TAIEX sessions and ignores events after as-of", () => {
  const dates = datesFrom("2026-01-01", 64);
  const actions = [{ dataset: "TaiwanStockDividendResult", date: dates[60], before_price: 101, after_price: 100, kind: "除息" }, { dataset: "TaiwanStockDividendResult", date: dates[63], before_price: 101, after_price: 100, kind: "除息" }];
  const series = buildAdjustedSeries(rawRows(dates), actions, dates);
  assert.equal(featuresAt(asMap(series), dates[60], dates)?.cashExAge, 0);
  assert.equal(featuresAt(asMap(series), dates[62], dates)?.cashExAge, 2);
  assert.equal(featuresAt(asMap(series.slice(0, 60)), dates[59], dates), null);
});

test("unsupported or invalid actions and duplicate same-date events fail loudly", () => {
  const dates = datesFrom("2026-01-01", 2);
  assert.throws(() => buildAdjustedSeries(rawRows(dates), [{ dataset: "UnknownMerger", date: dates[0] }], dates), /Unsupported corporate action/);
  assert.throws(() => buildAdjustedSeries(rawRows(dates), [{ dataset: "DividendResult", date: dates[0], before_price: 100, after_price: 0 }], dates), /finite positive/);
  assert.throws(() => buildAdjustedSeries(rawRows(dates), [
    { dataset: "TaiwanStockDividendResult", date: dates[0], before_price: 100, after_price: 99 },
    { dataset: "SplitPrice", date: dates[0], before_price: 99, after_price: 98 },
  ], dates), /Duplicate same-date/);
});

test("capped inverse-volatility weights redistribute around cap and preserve residual cash", () => {
  const redistributed = cappedInverseVolWeights([1, 2, 4], 0.5);
  assert.ok(Math.abs(redistributed[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(redistributed[1] - 1 / 3) < 1e-12);
  assert.ok(Math.abs(redistributed[2] - 1 / 6) < 1e-12);
  const cash = cappedInverseVolWeights([1, 2, 3], 0.2);
  assert.deepEqual(cash, [0.2, 0.2, 0.2]);
  assert.ok(cash.reduce((a, b) => a + b, 0) <= 1);
  assert.throws(() => cappedInverseVolWeights([1, 0], 0.2), /finite positive/);
});
