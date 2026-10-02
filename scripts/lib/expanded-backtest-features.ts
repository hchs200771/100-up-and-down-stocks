export interface RawOHLC {
  date: string;
  open?: number | null;
  max?: number | null;
  min?: number | null;
  close?: number | null;
  Trading_money?: number | null;
  Trading_Volume?: number | null;
}

export interface CorporateAction {
  dataset: string;
  date: string;
  before_price?: number | null;
  after_price?: number | null;
  kind?: string | null;
  [key: string]: unknown;
}

export interface AdjustedSeriesRow {
  date: string;
  /** Unadjusted source values, normalized to readable field names. */
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  money: number | null;
  volume: number | null;
  adjustmentFactor: number;
  /** Price-basis segment; null marks an unresolved corporate-action session. */
  segmentId?: number | null;
  adjustedOpen: number | null;
  adjustedClose: number | null;
  adjustedHigh: number | null;
  adjustedLow: number | null;
  cashExDate: boolean;
}

const numericOrNull = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function dividendPriceFactor(action: CorporateAction): number {
  if (!action.dataset.includes("DividendResult") && !action.dataset.includes("SplitPrice") &&
      !action.dataset.includes("CapitalReductionReferencePrice")) {
    throw new Error(`Unsupported corporate action adjustment dataset '${action.dataset}' on ${action.date}; refusing to guess adjustment fields.`);
  }
  const before = action.before_price;
  const after = action.after_price;
  if (typeof before !== "number" || !Number.isFinite(before) || before <= 0 ||
      typeof after !== "number" || !Number.isFinite(after) || after <= 0) {
    throw new Error(`Invalid ${action.dataset} before_price/after_price on ${action.date}; both must be finite positive numbers.`);
  }
  const factor = before / after;
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`Invalid DividendResult adjustment factor on ${action.date}.`);
  }
  return factor;
}

function isCashExDate(action: CorporateAction): boolean {
  return action.dataset.includes("DividendResult") && typeof action.kind === "string" &&
    action.kind.includes("息") && !action.kind.includes("權");
}

/**
 * Apply known cash-dividend reference-price ratios forward from their effective date.
 * This is a reference-price dividend reinvestment proxy, not an audited cash total return.
 */
export function buildAdjustedSeries(
  rawRows: RawOHLC[],
  actions: CorporateAction[],
  _calendar: string[],
): AdjustedSeriesRow[] {
  const rows = [...rawRows].sort((a, b) => a.date.localeCompare(b.date));
  const sortedActions = [...actions].sort((a, b) => a.date.localeCompare(b.date) || a.dataset.localeCompare(b.dataset));
  for (let i = 0; i < sortedActions.length; i++) {
    const action = sortedActions[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(action.date)) {
      throw new Error(`Invalid corporate action date '${action.date}' for dataset '${action.dataset}'.`);
    }
    if (i > 0 && sortedActions[i - 1].date === action.date) {
      throw new Error(`Duplicate same-date corporate actions on ${action.date} (${sortedActions[i - 1].dataset}, ${action.dataset}); refusing to double-adjust.`);
    }
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].date === rows[i].date) throw new Error(`Duplicate raw OHLC rows on ${rows[i].date}.`);
  }

  let actionIndex = 0;
  let adjustmentFactor = 1;
  return rows.map((row) => {
    let cashExDate = false;
    while (actionIndex < sortedActions.length && sortedActions[actionIndex].date <= row.date) {
      const action = sortedActions[actionIndex++];
      adjustmentFactor *= dividendPriceFactor(action);
      if (!Number.isFinite(adjustmentFactor) || adjustmentFactor <= 0) {
        throw new Error(`Cumulative corporate action factor became invalid on ${action.date}.`);
      }
      if (action.date === row.date && isCashExDate(action)) cashExDate = true;
    }
    const open = numericOrNull(row.open);
    const close = numericOrNull(row.close);
    const high = numericOrNull(row.max);
    const low = numericOrNull(row.min);
    const adjust = (value: number | null) => value === null ? null : value * adjustmentFactor;
    return {
      date: row.date,
      open,
      close,
      high,
      low,
      money: numericOrNull(row.Trading_money),
      volume: numericOrNull(row.Trading_Volume),
      adjustmentFactor,
      adjustedOpen: adjust(open),
      adjustedClose: adjust(close),
      adjustedHigh: adjust(high),
      adjustedLow: adjust(low),
      cashExDate,
    };
  });
}

export interface ExpandedFeatures {
  date: string;
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
  cashExAge: number | null;
}

function validFeatureRow(row: AdjustedSeriesRow | undefined): row is AdjustedSeriesRow {
  return Boolean(row && [row.adjustedOpen, row.adjustedClose, row.adjustedHigh, row.adjustedLow]
    .every((x) => typeof x === "number" && Number.isFinite(x) && x > 0) &&
    typeof row.volume === "number" && Number.isFinite(row.volume) && row.volume >= 0 &&
    typeof row.money === "number" && Number.isFinite(row.money) && row.money >= 0);
}

/** Calculate features from exactly the 61 TAIEX sessions ending on `date`; incomplete windows return null. */
export function featuresAt(
  series: Map<string, AdjustedSeriesRow>,
  date: string,
  calendar: string[],
): ExpandedFeatures | null {
  const uniqueCalendar = [...new Set(calendar)].sort();
  const endIndex = uniqueCalendar.indexOf(date);
  if (endIndex < 0 || endIndex < 60) return null;
  const dates = uniqueCalendar.slice(endIndex - 60, endIndex + 1);
  const window = dates.map((d) => series.get(d));
  if (window.some((row) => !validFeatureRow(row))) return null;
  const rows = window as AdjustedSeriesRow[];
  const closes = rows.map((row) => row.adjustedClose!);
  const highs = rows.map((row) => row.adjustedHigh!);
  const volumes = rows.map((row) => row.volume!);
  const money = rows.map((row) => row.money!);
  const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const last20Closes = closes.slice(-20);
  const last60Closes = closes.slice(-60);
  const returns = closes.slice(-21).slice(1).map((close, i) => Math.log(close / closes.slice(-21)[i]));
  const meanReturn = mean(returns);
  const sampleSd = Math.sqrt(returns.reduce((sum, x) => sum + (x - meanReturn) ** 2, 0) / (returns.length - 1));
  const previous20Volumes = volumes.slice(-21, -1);
  const previous20MeanVolume = mean(previous20Volumes);
  const latestClose = closes.at(-1)!;
  const adjustedMa20 = mean(last20Closes);
  const adjustedMa60 = mean(last60Closes);
  const lastCashEx = [...series.values()].filter((row) => row.date <= date && row.cashExDate)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const cashExAge = lastCashEx ? uniqueCalendar.filter((d) => d > lastCashEx.date && d <= date).length : null;
  return {
    date,
    adjustedMa20,
    adjustedMa60,
    r20: (latestClose / closes[40] - 1) * 100,
    annualized20LogReturnVol: sampleSd * Math.sqrt(252),
    prior20AdjustedHigh: Math.max(...highs.slice(-21, -1)),
    volumeMultiple: previous20MeanVolume > 0 ? volumes.at(-1)! / previous20MeanVolume : null,
    avgTurnover20: mean(money.slice(-20)),
    closeAboveMa20: latestClose > adjustedMa20,
    closeAboveMa60: latestClose > adjustedMa60,
    ma20AboveMa60: adjustedMa20 > adjustedMa60,
    cashExAge,
  };
}

/** Inverse-volatility allocation with an iterative per-name cap and residual cash if cap capacity is insufficient. */
export function cappedInverseVolWeights(vols: number[], cap = 0.2): number[] {
  if (!Number.isFinite(cap) || cap <= 0 || cap > 1) throw new Error("cap must be finite and in (0, 1].");
  if (vols.some((vol) => !Number.isFinite(vol) || vol <= 0)) throw new Error("volatilities must be finite positive numbers.");
  if (!vols.length) return [];
  const weights = Array(vols.length).fill(0) as number[];
  let active = vols.map((_, i) => i);
  let remaining = 1;
  while (active.length && remaining > 1e-12) {
    const inverseSum = active.reduce((sum, i) => sum + 1 / vols[i], 0);
    const proposed = new Map(active.map((i) => [i, remaining * (1 / vols[i]) / inverseSum]));
    const capped = active.filter((i) => proposed.get(i)! > cap + 1e-12);
    if (!capped.length) {
      for (const i of active) weights[i] = proposed.get(i)!;
      remaining = 0;
      break;
    }
    for (const i of capped) {
      weights[i] = cap;
      remaining -= cap;
    }
    active = active.filter((i) => !capped.includes(i));
  }
  return weights;
}
