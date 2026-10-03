import assert from "node:assert/strict";
import test from "node:test";
import { addDayQuotes, addReferenceEvent, createPanel, featuresAt, finalizePanel, historyRows, type NormalizedQuote } from "../scripts/lib/wide-market-panel.ts";

function makeDates(count: number): string[] {
  const start = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}
function quote(code: string, close: number, extras: Partial<NormalizedQuote> = {}): NormalizedQuote {
  return { code, name: code, market: "twse", open: close, high: close + 1, low: close - 1, close, volume: 100, money: 50_000_000, change: null, changeLabel: null, nextReference: null, ...extras };
}
function buildDaily(dates: string[], buildQuote: (i: number) => NormalizedQuote | null) {
  const panel = createPanel(dates);
  dates.forEach((_, i) => { const q = buildQuote(i); if (q) addDayQuotes(panel, i, [q]); });
  return finalizePanel(panel);
}

test("TPEx ex-date uses official event reference despite an unchanged previous nextReference", () => {
  const dates = makeDates(3);
  const panel = buildDaily(dates, (i) => i === 0
    ? quote("2330", 65.3, { market: "tpex", nextReference: 65.3 })
    : i === 1
      ? quote("2330", 63.3, { market: "tpex", change: -2, changeLabel: "除息", explicitReference: 63.3 })
      : quote("2330", 64.3, { market: "tpex", change: 1 }));
  const stock = panel.get("2330")!;
  assert.equal(stock.adjustmentFactor[0], 1);
  assert.ok(Math.abs(stock.adjustedClose[0] - 65.3) < 1e-10);
  assert.ok(Math.abs(stock.adjustedClose[1] - 65.3) < 1e-10);
  assert.ok(Math.abs(stock.adjustedClose[2] - 64.3 * 65.3 / 63.3) < 1e-10);
  assert.deepEqual(stock.observedAdjustmentIndices, [1]);
});

test("ordinary numeric change derives the reference factor; unknown action starts a new price segment", () => {
  const dates = makeDates(4);
  const known = buildDaily(dates.slice(0, 2), (i) => i === 0 ? quote("K", 100) : quote("K", 90, { change: 10 }));
  assert.ok(Math.abs(known.get("K")!.adjustedClose[1] - 112.5) < 1e-10);
  const unknown = buildDaily(dates, (i) => i === 0 ? quote("U", 100) : quote("U", 99 + i, { changeLabel: i === 1 ? "除權息" : null }));
  const stock = unknown.get("U")!;
  assert.deepEqual(stock.unresolvedAdjustmentIndices, [1]);
  assert.ok(Number.isNaN(stock.adjustedClose[1]));
  assert.equal(stock.adjustedClose[2], 101);
  assert.equal(stock.segmentId[0], 0);
  assert.equal(stock.segmentId[1], -1);
  assert.equal(stock.segmentId[2], 1);
});

test("TWSE X no-comparison sign never treats zero spread as a reference; official reference repairs it", () => {
  const dates = makeDates(3);
  const unresolved = buildDaily(dates.slice(0, 2), (i) => i === 0 ? quote("X1", 100) : quote("X1", 95, { change: 0, changeLabel: "X0.00" }));
  assert.deepEqual(unresolved.get("X1")!.unresolvedAdjustmentIndices, [1]);
  assert.ok(Number.isNaN(unresolved.get("X1")!.adjustedClose[1]));
  const repaired = buildDaily(dates.slice(0, 2), (i) => i === 0 ? quote("X2", 100) : quote("X2", 95, { change: 0, changeLabel: "X0.00", explicitReference: 90 }));
  assert.equal(repaired.get("X2")!.unresolvedAdjustmentIndices.length, 0);
  assert.ok(Math.abs(repaired.get("X2")!.adjustedClose[1] - 95 * 100 / 90) < 1e-10);
  const firstObservation = buildDaily(dates, (i) => i === 0 ? quote("IPO", 50, { change: 0, changeLabel: "X0.00" }) : quote("IPO", 50 + i, { change: 1 }));
  assert.equal(firstObservation.get("IPO")!.adjustmentFactor[0], 1);
  assert.equal(firstObservation.get("IPO")!.unresolvedAdjustmentIndices.length, 0);
  assert.equal(firstObservation.get("IPO")!.adjustedClose[0], 50);
});

test("official reference on a no-quote session carries into the next quote without double-adjustment", () => {
  const dates = makeDates(4);
  const panel = createPanel(dates);
  addDayQuotes(panel, 0, [quote("GAP", 100)]);
  addReferenceEvent(panel, 1, "GAP", 90);
  // No quote on the reference date (for example, zero volume or a suspension).
  addDayQuotes(panel, 2, [quote("GAP", 91, { change: 1 })]);
  addDayQuotes(panel, 3, [quote("GAP", 92, { change: 1 })]);
  finalizePanel(panel);
  const stock = panel.get("GAP")!;
  assert.deepEqual(stock.observedAdjustmentIndices, [1]);
  assert.equal(stock.adjustmentFactor[1], 100 / 90);
  // The no-quote indicator value stays continuous; execution OHLC remains missing.
  assert.equal(stock.adjustedClose[1], 100);
  assert.ok(Number.isNaN(stock.close[1]));
  // The first resumed day compares against official reference=90, so its +1 is real,
  // not another application of 100/90.
  assert.ok(Math.abs(stock.adjustedClose[2] - 91 * 100 / 90) < 1e-10);
  assert.ok(Math.abs(stock.adjustedClose[3] - 92 * 100 / 90) < 1e-10);
});

test("unknown reference event on a missing quote creates a new segment at the next quote", () => {
  const dates = makeDates(3);
  const panel = createPanel(dates);
  addDayQuotes(panel, 0, [quote("UNKNOWN", 100)]);
  addReferenceEvent(panel, 1, "UNKNOWN", null);
  addDayQuotes(panel, 2, [quote("UNKNOWN", 101, { change: 1 })]);
  finalizePanel(panel);
  const stock = panel.get("UNKNOWN")!;
  assert.deepEqual(stock.unresolvedAdjustmentIndices, [1]);
  assert.equal(stock.segmentId[1], -1);
  assert.equal(stock.adjustedClose[2], 101);
  assert.equal(stock.segmentId[2], 1);
  const rows = historyRows(stock, [0, 1, 2]);
  assert.equal(rows.get(dates[0])?.segmentId, 0);
  assert.equal(rows.get(dates[1])?.segmentId, null);
  assert.equal(rows.get(dates[2])?.segmentId, 1);
});

test("unknown-action reset requires 61 complete sessions before features return", () => {
  const dates = makeDates(125);
  const panel = buildDaily(dates, (i) => quote("WARM", 100 + i, {
    change: i ? 1 : null,
    changeLabel: i === 61 ? "X0.00" : null,
  }));
  const stock = panel.get("WARM")!;
  assert.equal(featuresAt(stock, 121), null); // only 60 sessions in the new segment
  assert.ok(featuresAt(stock, 122)); // 61 consecutive sessions from index 62
  assert.equal(stock.segmentId[60], 0);
  assert.equal(stock.segmentId[61], -1);
  assert.equal(stock.segmentId[62], 1);
});

test("future quotes and adjustments do not affect features as of an earlier index", () => {
  const dates = makeDates(64);
  const quoteAt = (i: number) => quote("2330", 100 + i, {
    change: i === 0 ? null : 1,
    ...(i === 62 ? { market: "tpex", changeLabel: "除息", explicitReference: 160 } : {}),
    ...(i === 61 ? { market: "tpex", nextReference: 160 } : {}),
  });
  const all = buildDaily(dates, quoteAt);
  const withoutFuture = buildDaily(dates.slice(0, 62), quoteAt);
  const featuresAll = featuresAt(all.get("2330")!, 61);
  const featuresPrior = featuresAt(withoutFuture.get("2330")!, 61);
  assert.deepEqual(featuresAll, featuresPrior);
  assert.equal(featuresAll?.observedAdjustmentAge, null);
  assert.equal(featuresAt(all.get("2330")!, 63)?.observedAdjustmentAge, 1);
});

test("panel keeps IPO history empty, carries missing-session indicators, and preserves raw execution gaps", () => {
  const dates = makeDates(5);
  const panel = buildDaily(dates, (i) => i === 2 || i === 4 ? quote("IPO", 10 + i) : null);
  const stock = panel.get("IPO")!;
  assert.ok(Number.isNaN(stock.adjustedClose[0]));
  assert.ok(Number.isNaN(stock.close[1]));
  assert.equal(stock.adjustedClose[3], stock.adjustedClose[2]);
  assert.ok(Number.isNaN(stock.close[3]));
  assert.equal(stock.volume[3], 0);
  assert.equal(stock.money[3], 0);
  const rows = historyRows(stock, [2, 3]);
  assert.equal(rows.get(dates[3])?.close, null);
  assert.equal(rows.get(dates[3])?.adjustedClose, null);
  assert.equal(rows.get(dates[3])?.volume, 0);
});

test("feature calculation requires current raw quote and positive volume, while zero prior volume remains observed", () => {
  const dates = makeDates(63);
  const panel = buildDaily(dates, (i) => quote("AAA", 100 + i, { change: i ? 1 : null, volume: i < 62 ? 0 : 100 }));
  const stock = panel.get("AAA")!;
  assert.equal(featuresAt(stock, 61), null);
  const result = featuresAt(stock, 62);
  assert.ok(result);
  assert.equal(result?.volumeMultiple, null);
  assert.ok(Number.isFinite(result?.adjustedMa60));
});

test("same code from TWSE and TPEx on one day is rejected", () => {
  const dates = makeDates(1);
  const panel = createPanel(dates);
  addDayQuotes(panel, 0, [quote("1234", 10, { market: "twse" })]);
  assert.throws(() => addDayQuotes(panel, 0, [quote("1234", 10, { market: "tpex" })]), /Duplicate quote.*1234/);
});


test("TPEx nextReference alone cannot repair an unknown ex-rights reference", () => {
  const dates = makeDates(3);
  const p = buildDaily(dates, (i) => i === 0 ? quote("5324", 9.80, { market: "tpex", nextReference: 9.80 }) : quote("5324", 9.71, { market: "tpex", changeLabel: i === 1 ? "除權" : "0.00", change: i === 1 ? null : 0 }));
  assert.ok(Number.isNaN(p.get("5324")!.adjustedClose[1]));
  assert.deepEqual(p.get("5324")!.unresolvedAdjustmentIndices, [1]);
});
