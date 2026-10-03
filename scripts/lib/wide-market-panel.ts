import type { AdjustedSeriesRow } from "./expanded-backtest-features.ts";

export interface NormalizedQuote {
  code: string;
  name: string;
  market: "twse" | "tpex" | string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  money: number | null;
  change: number | null;
  changeLabel: string | null;
  nextReference: number | null;
  explicitReference?: number | null;
}

export interface StockPanel {
  code: string;
  calendar: string[];
  nameByIndex: string[];
  marketByIndex: string[];
  changeLabel: string[];
  seen: Uint8Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  money: Float64Array;
  change: Float64Array;
  nextReference: Float64Array;
  explicitReference: Float64Array;
  referenceEvent: Uint8Array;
  adjustedOpen: Float64Array;
  adjustedHigh: Float64Array;
  adjustedLow: Float64Array;
  adjustedClose: Float64Array;
  adjustmentFactor: Float64Array;
  segmentId: Int32Array;
  unresolvedAdjustmentIndices: number[];
  observedAdjustmentIndices: number[];
  finalized: boolean;
}

export class WideMarketPanel extends Map<string, StockPanel> {
  readonly calendar: string[];
  constructor(calendar: string[]) {
    super();
    this.calendar = [...calendar];
  }
}

const nanArray = (length: number) => new Float64Array(length).fill(Number.NaN);
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
const actionLabel = (label: string): boolean => /^(?:X|Ｘ)/iu.test(label.trim()) || /(除|權|減資|分割|現增)/u.test(label);

function createStock(code: string, calendar: string[]): StockPanel {
  const n = calendar.length;
  return {
    code,
    calendar,
    nameByIndex: Array(n).fill(""),
    marketByIndex: Array(n).fill(""),
    changeLabel: Array(n).fill(""),
    seen: new Uint8Array(n),
    open: nanArray(n), high: nanArray(n), low: nanArray(n), close: nanArray(n),
    volume: nanArray(n), money: nanArray(n), change: nanArray(n), nextReference: nanArray(n), explicitReference: nanArray(n), referenceEvent: new Uint8Array(n),
    adjustedOpen: nanArray(n), adjustedHigh: nanArray(n), adjustedLow: nanArray(n), adjustedClose: nanArray(n),
    adjustmentFactor: nanArray(n), segmentId: new Int32Array(n).fill(-1), unresolvedAdjustmentIndices: [], observedAdjustmentIndices: [], finalized: false,
  };
}

/** Attach an official reference even when the security had no quote row on that session. */
export function addReferenceEvent(panel: WideMarketPanel, dateIndex: number, code: string, reference: number | null): void {
  if (dateIndex < 0 || dateIndex >= panel.calendar.length || !Number.isInteger(dateIndex)) throw new Error(`Invalid panel date index ${dateIndex}.`);
  if (!code) throw new Error(`Reference event at ${panel.calendar[dateIndex]} has no stock code.`);
  let stock = panel.get(code);
  if (!stock) {
    stock = createStock(code, panel.calendar);
    panel.set(code, stock);
  }
  if (stock.finalized) throw new Error(`Cannot add reference event for ${code}; panel is already finalized.`);
  if (stock.referenceEvent[dateIndex]) throw new Error(`Duplicate reference event for ${code} on ${panel.calendar[dateIndex]}.`);
  stock.referenceEvent[dateIndex] = 1;
  stock.explicitReference[dateIndex] = positive(reference ?? Number.NaN) ? reference! : Number.NaN;
}

export function createPanel(calendar: string[]): WideMarketPanel {
  if (new Set(calendar).size !== calendar.length) throw new Error("TAIEX calendar contains duplicate dates.");
  for (let i = 1; i < calendar.length; i++) if (calendar[i - 1] >= calendar[i]) throw new Error("TAIEX calendar must be sorted ascending.");
  return new WideMarketPanel(calendar);
}

export function addDayQuotes(panel: WideMarketPanel, dateIndex: number, quotes: NormalizedQuote[]): void {
  if (dateIndex < 0 || dateIndex >= panel.calendar.length || !Number.isInteger(dateIndex)) throw new Error(`Invalid panel date index ${dateIndex}.`);
  for (const quote of quotes) {
    if (!quote.code) throw new Error(`Quote at ${panel.calendar[dateIndex]} has no stock code.`);
    let stock = panel.get(quote.code);
    if (!stock) {
      stock = createStock(quote.code, panel.calendar);
      panel.set(quote.code, stock);
    }
    if (stock.finalized) throw new Error(`Cannot add quote for ${quote.code}; panel is already finalized.`);
    if (stock.seen[dateIndex]) throw new Error(`Duplicate quote for ${quote.code} on ${panel.calendar[dateIndex]} (possible TWSE/TPEx duplicate).`);
    stock.seen[dateIndex] = 1;
    stock.nameByIndex[dateIndex] = quote.name ?? "";
    stock.marketByIndex[dateIndex] = quote.market ?? "";
    stock.changeLabel[dateIndex] = quote.changeLabel ?? "";
    stock.open[dateIndex] = finite(quote.open) ? quote.open : Number.NaN;
    stock.high[dateIndex] = finite(quote.high) ? quote.high : Number.NaN;
    stock.low[dateIndex] = finite(quote.low) ? quote.low : Number.NaN;
    stock.close[dateIndex] = finite(quote.close) ? quote.close : Number.NaN;
    stock.volume[dateIndex] = finite(quote.volume) ? quote.volume : Number.NaN;
    stock.money[dateIndex] = finite(quote.money) ? quote.money : Number.NaN;
    stock.change[dateIndex] = finite(quote.change) ? quote.change : Number.NaN;
    stock.nextReference[dateIndex] = finite(quote.nextReference) ? quote.nextReference : Number.NaN;
    stock.explicitReference[dateIndex] = finite(quote.explicitReference) ? quote.explicitReference : Number.NaN;
  }
}

function rawOHLCValid(stock: StockPanel, i: number): boolean {
  return positive(stock.open[i]) && positive(stock.high[i]) && positive(stock.low[i]) && positive(stock.close[i]);
}

export function finalizePanel(panel: WideMarketPanel): WideMarketPanel {
  for (const stock of panel.values()) {
    if (stock.finalized) continue;
    let previousValidIndex = -1;
    let referenceAnchor = Number.NaN;
    let factor = 1;
    let awaitingSegmentAnchor = false;
    let currentSegment = -1;
    let lastAdjusted: { open: number; high: number; low: number; close: number } | null = null;
    for (let i = 0; i < panel.calendar.length; i++) {
      const hasPositiveClose = positive(stock.close[i]);
      if (!hasPositiveClose) {
        if (stock.referenceEvent[i] && !awaitingSegmentAnchor) {
          const reference = stock.explicitReference[i];
          if (positive(reference) && positive(referenceAnchor)) {
            const stepFactor = referenceAnchor / reference;
            factor *= stepFactor;
            if (positive(factor)) {
              referenceAnchor = reference;
              stock.observedAdjustmentIndices.push(i);
            } else {
              awaitingSegmentAnchor = true;
              stock.unresolvedAdjustmentIndices.push(i);
            }
          } else if (previousValidIndex >= 0) {
            awaitingSegmentAnchor = true;
            stock.unresolvedAdjustmentIndices.push(i);
          }
        }
        if (previousValidIndex >= 0) {
          if (!stock.seen[i]) { stock.volume[i] = 0; stock.money[i] = 0; }
          if (!awaitingSegmentAnchor && lastAdjusted) {
            stock.adjustedOpen[i] = lastAdjusted.open;
            stock.adjustedHigh[i] = lastAdjusted.high;
            stock.adjustedLow[i] = lastAdjusted.low;
            stock.adjustedClose[i] = lastAdjusted.close;
            stock.adjustmentFactor[i] = factor;
            stock.segmentId[i] = currentSegment;
          }
        }
        continue;
      }

      const label = stock.changeLabel[i];
      const isAction = actionLabel(label);
      if (awaitingSegmentAnchor) {
        // An unresolved reference ends the old return series. Re-anchor only at
        // the next actual quote; never interpret the reset as an investment return.
        currentSegment++;
        factor = 1;
        awaitingSegmentAnchor = false;
        referenceAnchor = stock.close[i];
        stock.adjustmentFactor[i] = factor;
        stock.adjustedOpen[i] = finite(stock.open[i]) ? stock.open[i] : Number.NaN;
        stock.adjustedHigh[i] = finite(stock.high[i]) ? stock.high[i] : Number.NaN;
        stock.adjustedLow[i] = finite(stock.low[i]) ? stock.low[i] : Number.NaN;
        stock.adjustedClose[i] = stock.close[i];
        stock.segmentId[i] = currentSegment;
        lastAdjusted = { open: stock.adjustedOpen[i], high: stock.adjustedHigh[i], low: stock.adjustedLow[i], close: stock.adjustedClose[i] };
        previousValidIndex = i;
        continue;
      }

      if (previousValidIndex >= 0) {
        const rawClose = stock.close[i];
        let reference = stock.explicitReference[i];
        // TPEx's previous nextReference can remain the prior trading basis on
        // ex-rights days. Use the official effective-date event reference instead.
        // TWSE's X sign means "not comparable". Its parsed numeric spread is often 0,
        // which must not be mistaken for an official reference price equal to the close.
        const noComparison = /^(?:X|Ｘ)/iu.test(label.trim());
        if (!positive(reference) && !noComparison && finite(stock.change[i])) reference = rawClose - stock.change[i];
        if (positive(reference)) {
          const stepFactor = (positive(referenceAnchor) ? referenceAnchor : stock.close[previousValidIndex]) / reference;
          if (positive(stepFactor)) {
            factor *= stepFactor;
            if (!Number.isFinite(factor) || factor <= 0) {
              awaitingSegmentAnchor = true;
              stock.unresolvedAdjustmentIndices.push(i);
            } else if (isAction || Math.abs(stepFactor - 1) > 0.005) {
              stock.observedAdjustmentIndices.push(i);
            }
          } else if (isAction) {
            awaitingSegmentAnchor = true;
            stock.unresolvedAdjustmentIndices.push(i);
          }
        } else if (isAction) {
          awaitingSegmentAnchor = true;
          stock.unresolvedAdjustmentIndices.push(i);
        }
      } else if (previousValidIndex < 0 && isAction) {
        // With no earlier in-panel quote there is no prior return to adjust. Establish
        // the first valid print as factor-1 anchor; later X events with history remain unresolved.
        factor = 1;
      }

      if (awaitingSegmentAnchor) {
        stock.adjustedOpen[i] = Number.NaN;
        stock.adjustedHigh[i] = Number.NaN;
        stock.adjustedLow[i] = Number.NaN;
        stock.adjustedClose[i] = Number.NaN;
        stock.adjustmentFactor[i] = Number.NaN;
        stock.segmentId[i] = -1;
      } else {
        if (currentSegment < 0) currentSegment = 0;
        stock.adjustmentFactor[i] = factor;
        stock.adjustedOpen[i] = finite(stock.open[i]) ? stock.open[i] * factor : Number.NaN;
        stock.adjustedHigh[i] = finite(stock.high[i]) ? stock.high[i] * factor : Number.NaN;
        stock.adjustedLow[i] = finite(stock.low[i]) ? stock.low[i] * factor : Number.NaN;
        stock.adjustedClose[i] = stock.close[i] * factor;
        stock.segmentId[i] = currentSegment;
        lastAdjusted = { open: stock.adjustedOpen[i], high: stock.adjustedHigh[i], low: stock.adjustedLow[i], close: stock.adjustedClose[i] };
      }
      referenceAnchor = stock.close[i];
      previousValidIndex = i;
    }
    stock.finalized = true;
  }
  return panel;
}

export interface WideMarketFeatures {
  adjustedMa20: number;
  adjustedMa60: number;
  r20: number;
  annualized20LogReturnVol: number;
  prior20AdjustedHigh: number;
  volumeMultiple: number | null;
  avgTurnover20: number;
  closeAboveMa20: boolean;
  closeAboveMa60: boolean;
  ma20AboveMa60: boolean;
  observedAdjustmentAge: number | null;
}

export function featuresAt(stock: StockPanel, index: number): WideMarketFeatures | null {
  if (!stock.finalized || !Number.isInteger(index) || index < 60 || index >= stock.calendar.length) return null;
  const first = index - 60;
  const segment = stock.segmentId[index];
  if (segment < 0) return null;
  for (let i = first; i <= index; i++) {
    if (stock.segmentId[i] !== segment || !positive(stock.adjustedClose[i]) || !positive(stock.adjustedHigh[i]) ||
        !Number.isFinite(stock.volume[i]) || stock.volume[i] < 0 ||
        !Number.isFinite(stock.money[i]) || stock.money[i] < 0) return null;
  }
  if (!rawOHLCValid(stock, index) || !Number.isFinite(stock.volume[index]) || stock.volume[index] <= 0) return null;
  const mean = (array: Float64Array, from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += array[i];
    return sum / (to - from);
  };
  const ma20 = mean(stock.adjustedClose, index - 19, index + 1);
  const ma60 = mean(stock.adjustedClose, index - 59, index + 1);
  const returns: number[] = [];
  for (let i = index - 19; i <= index; i++) returns.push(Math.log(stock.adjustedClose[i] / stock.adjustedClose[i - 1]));
  const meanReturn = returns.reduce((sum, x) => sum + x, 0) / returns.length;
  const sampleSd = Math.sqrt(returns.reduce((sum, x) => sum + (x - meanReturn) ** 2, 0) / (returns.length - 1));
  let priorHigh = Number.NEGATIVE_INFINITY;
  let previousVolume = 0;
  for (let i = index - 20; i < index; i++) {
    priorHigh = Math.max(priorHigh, stock.adjustedHigh[i]);
    previousVolume += stock.volume[i];
  }
  let lower = 0;
  let upper = stock.observedAdjustmentIndices.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (stock.observedAdjustmentIndices[middle] <= index) lower = middle + 1;
    else upper = middle;
  }
  const latestAdjustment = lower > 0 ? stock.observedAdjustmentIndices[lower - 1] : undefined;
  return {
    adjustedMa20: ma20,
    adjustedMa60: ma60,
    r20: (stock.adjustedClose[index] / stock.adjustedClose[index - 20] - 1) * 100,
    annualized20LogReturnVol: sampleSd * Math.sqrt(252),
    prior20AdjustedHigh: priorHigh,
    volumeMultiple: previousVolume > 0 ? stock.volume[index] / (previousVolume / 20) : null,
    avgTurnover20: mean(stock.money, index - 19, index + 1),
    closeAboveMa20: stock.adjustedClose[index] > ma20,
    closeAboveMa60: stock.adjustedClose[index] > ma60,
    ma20AboveMa60: ma20 > ma60,
    observedAdjustmentAge: latestAdjustment === undefined ? null : index - latestAdjustment,
  };
}

/** Materialize only selected sessions for the existing map-based portfolio simulator. */
export function historyRows(stock: StockPanel, indices: number[]): Map<string, AdjustedSeriesRow> {
  const result = new Map<string, AdjustedSeriesRow>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= stock.calendar.length) continue;
    const rawExists = positive(stock.close[index]);
    const nullable = (value: number): number | null => Number.isFinite(value) ? value : null;
    result.set(stock.calendar[index], {
      date: stock.calendar[index],
      segmentId: stock.segmentId[index] >= 0 ? stock.segmentId[index] : null,
      open: nullable(stock.open[index]), close: nullable(stock.close[index]), high: nullable(stock.high[index]), low: nullable(stock.low[index]),
      money: nullable(stock.money[index]), volume: nullable(stock.volume[index]), adjustmentFactor: nullable(stock.adjustmentFactor[index]) ?? 1,
      adjustedOpen: rawExists ? nullable(stock.adjustedOpen[index]) : null,
      adjustedClose: rawExists ? nullable(stock.adjustedClose[index]) : null,
      adjustedHigh: rawExists ? nullable(stock.adjustedHigh[index]) : null,
      adjustedLow: rawExists ? nullable(stock.adjustedLow[index]) : null,
      cashExDate: false,
    });
  }
  return result;
}
