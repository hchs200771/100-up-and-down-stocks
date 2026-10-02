export interface AdjustedRow {
  date: string;
  /** A changed segment means an unresolved action reset the price unit. */
  segmentId?: number | null;
  adjustedOpen: number | null;
  adjustedClose: number | null;
  volume: number | null;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
}

export interface CohortHolding {
  code: string;
  weight: number;
  series: Map<string, AdjustedRow>;
}

export interface BenchmarkRow { open: number; close: number }
export interface PortfolioDaily { date: string; value: number }

export interface CohortResult {
  valid: boolean;
  reason: string | null;
  invalidCodes: string[];
  failedEntryCodes: string[];
  portfolioDaily: PortfolioDaily[];
  netReturnPct: number | null;
  benchmarkReturnPct: number | null;
  investedWeight: number;
  staleMarkCount: number;
  stockCount: number;
  sessions: number;
}

export interface PerformanceStats {
  observations: number;
  sessions: number;
  totalReturnPct: number | null;
  cagrPct: number | null;
  maxDrawdownPct: number | null;
}

export const BUY_FEE = 0.001425;
export const SELL_FEE = 0.004425;
const WEIGHT_EPSILON = 1e-8;

function validPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function executionInvalid(row: AdjustedRow | undefined, side: "entry" | "exit"): string | null {
  if (!row) return `missing ${side} quote`;
  if (!validPositive(row.volume)) return `${side} volume is missing or nonpositive`;
  if (![row.open, row.close, row.high, row.low].every(validPositive)) return `${side} OHLC is missing or nonpositive`;
  if (row.open === row.high && row.high === row.low) return `${side} is a one-price bar`;
  if (side === "entry" && !validPositive(row.adjustedOpen)) return "entry adjustedOpen is missing or nonpositive";
  if (side === "exit" && !validPositive(row.adjustedClose)) return "exit adjustedClose is missing or nonpositive";
  return null;
}

/** Simulate one preselected cohort. Invalid executions invalidate the cohort; holdings are never substituted. */
export function simulateCohort(input: {
  dates: string[];
  holdings: CohortHolding[];
  benchmarkRows: Map<string, BenchmarkRow>;
  benchmarkTR: Map<string, number>;
}): CohortResult {
  const { dates, holdings, benchmarkRows, benchmarkTR } = input;
  const investedWeight = holdings.reduce((sum, h) => sum + h.weight, 0);
  const invalidCodes: string[] = [];
  const failedEntryCodes: string[] = [];
  const invalidReasons: string[] = [];
  const invalidate = (code: string, reason: string) => {
    invalidCodes.push(code);
    invalidReasons.push(`${code}: ${reason}`);
  };

  if (dates.length !== 20) invalidReasons.push(`exactly 20 session dates are required, got ${dates.length}`);
  if (new Set(dates).size !== dates.length || dates.some((d, i) => i > 0 && d <= dates[i - 1])) {
    invalidReasons.push("dates must be unique and strictly increasing");
  }
  if (holdings.some((h) => !Number.isFinite(h.weight) || h.weight < 0)) {
    invalidReasons.push("holding weights must be finite and nonnegative");
  }
  if (investedWeight > 1 + WEIGHT_EPSILON) invalidReasons.push("holding weights sum to more than 1");

  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const units = new Map<string, number>();
  for (const holding of holdings) {
    const entry = holding.series.get(firstDate);
    const exit = holding.series.get(lastDate);
    const entryIssue = executionInvalid(entry, "entry");
    if (entryIssue) {
      failedEntryCodes.push(holding.code);
      continue;
    }
    const exitIssue = executionInvalid(exit, "exit");
    if (exitIssue) invalidate(holding.code, exitIssue);
    if (entry && Number.isFinite(holding.weight) && holding.weight >= 0) {
      units.set(holding.code, holding.weight / (1 + BUY_FEE) / entry.adjustedOpen!);
      if (entry.segmentId !== undefined && dates.some((date) => {
        const row = holding.series.get(date);
        return row?.segmentId !== undefined && row.segmentId !== entry.segmentId;
      })) invalidate(holding.code, "unresolved price adjustment inside holding period");
    }
  }

  const portfolioDaily: PortfolioDaily[] = [];
  let staleMarkCount = 0;
  const failedEntryWeight = holdings.reduce((sum, h) => sum + (failedEntryCodes.includes(h.code) ? h.weight : 0), 0);
  const cash = 1 - investedWeight + failedEntryWeight;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    let value = cash;
    for (const holding of holdings) {
      if (failedEntryCodes.includes(holding.code)) continue;
      const row = holding.series.get(date);
      const close = row && validPositive(row.adjustedClose) ? row.adjustedClose : null;
      if (close !== null) {
        value += (units.get(holding.code) ?? 0) * close;
      } else if (i > 0 && i < dates.length - 1) {
        // Carry the most recent valid close only for daily mark-to-market, never for execution.
        let prior: number | null = null;
        for (let j = i - 1; j >= 0; j--) {
          const priorRow = holding.series.get(dates[j]);
          if (priorRow && validPositive(priorRow.adjustedClose)) {
            prior = priorRow.adjustedClose;
            break;
          }
        }
        if (prior !== null) {
          value += (units.get(holding.code) ?? 0) * prior;
          staleMarkCount++;
        } else {
          invalidate(holding.code, `no valid mark on ${date} and no prior valid close`);
        }
      } else {
        invalidate(holding.code, `missing or nonpositive adjustedClose on ${date}`);
      }
    }
    if (i === dates.length - 1) {
      for (const holding of holdings) value -= (units.get(holding.code) ?? 0) * (holding.series.get(date)?.adjustedClose ?? 0) * SELL_FEE;
    }
    portfolioDaily.push({ date, value });
  }

  const firstBenchmark = benchmarkRows.get(firstDate);
  const lastBenchmark = benchmarkTR.get(lastDate);
  const firstTRClose = benchmarkTR.get(firstDate);
  const benchmarkEntryTR = firstBenchmark && validPositive(firstBenchmark.open) && validPositive(firstBenchmark.close) && validPositive(firstTRClose)
    ? firstBenchmark.open * firstTRClose / firstBenchmark.close
    : null;
  let benchmarkReturnPct: number | null = null;
  if (benchmarkEntryTR === null || !validPositive(lastBenchmark)) {
    invalidReasons.push(`benchmark data missing or invalid on ${firstDate}/${lastDate}`);
  } else {
    benchmarkReturnPct = (lastBenchmark / benchmarkEntryTR - 1) * 100;
  }

  const valid = invalidReasons.length === 0;
  const finalValue = portfolioDaily.at(-1)?.value;
  return {
    valid,
    reason: valid ? null : [...new Set(invalidReasons)].join("; "),
    invalidCodes: [...new Set(invalidCodes)],
    failedEntryCodes: [...new Set(failedEntryCodes)],
    portfolioDaily,
    netReturnPct: valid && finalValue !== undefined ? (finalValue - 1) * 100 : null,
    benchmarkReturnPct,
    investedWeight: investedWeight - failedEntryWeight,
    staleMarkCount,
    stockCount: holdings.length,
    sessions: dates.length,
  };
}

/** Summarize a daily wealth series that includes its initial value of 1. */
export function performanceStats(values: number[], periodsPerYear = 252): PerformanceStats {
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) throw new Error("periodsPerYear must be positive and finite");
  if (!values.length || values.some((x) => !Number.isFinite(x) || x < 0)) {
    return { observations: values.length, sessions: Math.max(0, values.length - 1), totalReturnPct: null, cagrPct: null, maxDrawdownPct: null };
  }
  const initial = values[0];
  const final = values[values.length - 1];
  let peak = initial;
  let maxDrawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  const sessions = Math.max(0, values.length - 1);
  const cagr = sessions > 0 && initial > 0 && final > 0
    ? (Math.pow(final / initial, periodsPerYear / sessions) - 1) * 100
    : null;
  return {
    observations: values.length,
    sessions,
    totalReturnPct: initial > 0 ? (final / initial - 1) * 100 : null,
    cagrPct: cagr,
    maxDrawdownPct: maxDrawdown * 100,
  };
}
