import type { StockPanel } from "./wide-market-panel.ts";

export interface SessionReturnComponents {
  dayLogReturn: number;
  nightLogReturn: number;
  totalLogReturn: number;
}

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

function validQuote(stock: StockPanel, index: number): boolean {
  return stock.seen[index] === 1 && Number.isFinite(stock.volume[index]) && stock.volume[index] > 0 &&
    positive(stock.open[index]) && positive(stock.high[index]) && positive(stock.low[index]) && positive(stock.close[index]) &&
    positive(stock.adjustedOpen[index]) && positive(stock.adjustedClose[index]);
}

function validRange(stock: StockPanel, from: number, to: number): boolean {
  if (!stock.finalized || from < 0 || to >= stock.calendar.length || from > to) return false;
  const segment = stock.segmentId[from];
  if (segment < 0) return false;
  for (let i = from; i <= to; i++) {
    if (stock.segmentId[i] !== segment || !validQuote(stock, i)) return false;
  }
  return true;
}

/** Split close-to-close adjusted log return into close-to-open and open-to-close components. */
export function sessionReturnComponents(stock: StockPanel, index: number, lookback = 20): SessionReturnComponents | null {
  if (!Number.isInteger(index) || !Number.isInteger(lookback) || lookback < 1 || index < lookback ||
      !validRange(stock, index - lookback, index)) return null;
  let dayLogReturn = 0;
  let nightLogReturn = 0;
  for (let i = index - lookback + 1; i <= index; i++) {
    dayLogReturn += Math.log(stock.adjustedClose[i] / stock.adjustedOpen[i]);
    nightLogReturn += Math.log(stock.adjustedOpen[i] / stock.adjustedClose[i - 1]);
  }
  return { dayLogReturn, nightLogReturn, totalLogReturn: dayLogReturn + nightLogReturn };
}

export interface MarketResidualMomentum {
  score: number;
  beta: number;
  alpha: number;
  residualSd: number;
  residualLogReturn: number;
}

/**
 * Market-only proxy for residual momentum. This is not a full Fama-French residual
 * momentum replication: it removes only a fitted intercept and broad-market beta.
 */
export function marketResidualMomentum(
  stock: StockPanel,
  market: StockPanel,
  index: number,
  trainingSessions = 252,
  signalSessions = 20,
): MarketResidualMomentum | null {
  if (!Number.isInteger(index) || !Number.isInteger(trainingSessions) || !Number.isInteger(signalSessions) ||
      trainingSessions < 2 || signalSessions < 1 || index < trainingSessions + signalSessions) return null;
  const trainingStart = index - signalSessions - trainingSessions + 1;
  const quotesStart = trainingStart - 1;
  if (!validRange(stock, quotesStart, index) || !validRange(market, quotesStart, index)) return null;
  for (let i = quotesStart; i <= index; i++) {
    if (stock.calendar[i] !== market.calendar[i]) return null;
  }

  const stockReturns: number[] = [];
  const marketReturns: number[] = [];
  for (let i = trainingStart; i <= index; i++) {
    stockReturns.push(Math.log(stock.adjustedClose[i] / stock.adjustedClose[i - 1]));
    marketReturns.push(Math.log(market.adjustedClose[i] / market.adjustedClose[i - 1]));
  }
  const trainingStock = stockReturns.slice(0, trainingSessions);
  const trainingMarket = marketReturns.slice(0, trainingSessions);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanStock = mean(trainingStock);
  const meanMarket = mean(trainingMarket);
  let covariance = 0;
  let marketVariance = 0;
  for (let i = 0; i < trainingSessions; i++) {
    covariance += (trainingMarket[i] - meanMarket) * (trainingStock[i] - meanStock);
    marketVariance += (trainingMarket[i] - meanMarket) ** 2;
  }
  if (!(marketVariance > 0) || !Number.isFinite(marketVariance)) return null;
  const beta = covariance / marketVariance;
  const alpha = meanStock - beta * meanMarket;
  const trainingResiduals = trainingStock.map((value, i) => value - alpha - beta * trainingMarket[i]);
  const residualMean = mean(trainingResiduals);
  const residualSd = Math.sqrt(trainingResiduals.reduce((sum, value) => sum + (value - residualMean) ** 2, 0) / (trainingSessions - 1));
  if (!(residualSd > 1e-12) || !Number.isFinite(residualSd)) return null;
  let residualLogReturn = 0;
  for (let i = trainingSessions; i < stockReturns.length; i++) residualLogReturn += stockReturns[i] - alpha - beta * marketReturns[i];
  return { score: residualLogReturn / residualSd, beta, alpha, residualSd, residualLogReturn };
}
