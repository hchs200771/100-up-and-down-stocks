import assert from "node:assert/strict";
import test from "node:test";
import { addDayQuotes, createPanel, finalizePanel, type StockPanel } from "../scripts/lib/wide-market-panel.ts";
import { marketResidualMomentum, sessionReturnComponents } from "../scripts/lib/novel-price-factors.ts";

function panelFromReturns(code: string, dailyReturns: number[], nightReturns: number[] = dailyReturns.map(() => 0)): StockPanel {
  const calendar = dailyReturns.map((_, i) => `2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String(i % 28 + 1).padStart(2, "0")}`);
  const panel = createPanel(calendar);
  let previousClose = 100;
  for (let i = 0; i < dailyReturns.length; i++) {
    const open = previousClose * Math.exp(nightReturns[i]);
    const close = open * Math.exp(dailyReturns[i]);
    addDayQuotes(panel, i, [{ code, name: code, market: "twse", open, high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999, close, volume: 100, money: 100_000, change: close - previousClose,
      changeLabel: "", nextReference: previousClose, explicitReference: null }]);
    previousClose = close;
  }
  finalizePanel(panel);
  return panel.get(code)!;
}

test("session components telescope to the adjusted close-to-close return", () => {
  const daily = Array.from({ length: 30 }, (_, i) => (i - 13) * 0.001);
  const night = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 0.002);
  const stock = panelFromReturns("AAA", daily, night);
  const result = sessionReturnComponents(stock, 29, 20)!;
  assert.ok(Math.abs(result.totalLogReturn - Math.log(stock.adjustedClose[29] / stock.adjustedClose[9])) < 1e-12);
  assert.ok(Math.abs(result.totalLogReturn - result.dayLogReturn - result.nightLogReturn) < 1e-12);
  assert.ok(Math.abs(result.dayLogReturn - result.nightLogReturn) > 1e-4);
});

test("session factors reject missing activity, stale/unobserved dates, short history, and segment resets", () => {
  const returns = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 0.01);
  const stale = panelFromReturns("AAA", returns);
  stale.volume[20] = 0;
  assert.equal(sessionReturnComponents(stale, 29, 20), null);
  stale.volume[20] = 100;
  stale.seen[20] = 0;
  assert.equal(sessionReturnComponents(stale, 29, 20), null);
  assert.equal(sessionReturnComponents(stale, 19, 20), null);

  const resetPanel = createPanel(Array.from({ length: 30 }, (_, i) => `2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String(i % 28 + 1).padStart(2, "0")}`));
  let previousClose = 100;
  for (let i = 0; i < 30; i++) {
    const close = previousClose * Math.exp(returns[i]);
    addDayQuotes(resetPanel, i, [{ code: "AAA", name: "AAA", market: "twse", open: previousClose, high: close * 1.01,
      low: previousClose * 0.99, close, volume: 100, money: 100, change: 0,
      changeLabel: i === 16 ? "X" : "", nextReference: null }]);
    previousClose = close;
  }
  finalizePanel(resetPanel);
  assert.equal(sessionReturnComponents(resetPanel.get("AAA")!, 29, 20), null);
});

test("historical factors are unchanged by mutations to future observations", () => {
  const stock = panelFromReturns("AAA", Array.from({ length: 35 }, (_, i) => Math.cos(i) * 0.005), Array.from({ length: 35 }, (_, i) => i * 0.0001));
  const historical = sessionReturnComponents(stock, 25, 20);
  stock.adjustedClose[34] *= 20;
  stock.adjustedOpen[34] *= 20;
  stock.close[34] *= 20;
  assert.deepEqual(sessionReturnComponents(stock, 25, 20), historical);
});

test("market residual momentum estimates training beta and captures later residual signal", () => {
  const count = 80;
  const marketReturns = Array.from({ length: count }, (_, i) => Math.sin(i * 0.37) * 0.012 + Math.cos(i * 0.11) * 0.004);
  const trainingMeanMarket = marketReturns.slice(20, 60).reduce((sum, value) => sum + value, 0) / 40;
  const rawNoise = Array.from({ length: 40 }, (_, i) => Math.sin(i * 1.7) * 0.002);
  const noiseMean = rawNoise.reduce((sum, value) => sum + value, 0) / rawNoise.length;
  const noiseSlope = rawNoise.reduce((sum, value, i) => sum + (marketReturns[i + 20] - trainingMeanMarket) * (value - noiseMean), 0) /
    marketReturns.slice(20, 60).reduce((sum, value) => sum + (value - trainingMeanMarket) ** 2, 0);
  const stockReturns = marketReturns.map((value, i) => 0.0003 + 1.4 * value + (i >= 20 && i < 60
    ? rawNoise[i - 20] - noiseMean - noiseSlope * (value - trainingMeanMarket) : i >= 60 ? 0.004 : 0));
  const market = panelFromReturns("MKT", marketReturns);
  const stock = panelFromReturns("AAA", stockReturns);
  const result = marketResidualMomentum(stock, market, 79, 40, 20)!;
  assert.ok(Math.abs(result.beta - 1.4) < 1e-10);
  assert.ok(Math.abs(result.alpha - 0.0003) < 1e-10);
  assert.ok(result.residualLogReturn > 0.07);
  assert.ok(result.score > 10);
});

test("future training and signal observations do not change a historical residual signal", () => {
  const marketReturns = Array.from({ length: 80 }, (_, i) => Math.sin(i * 0.37) * 0.01 + Math.cos(i * 0.15) * 0.003);
  const stockReturns = marketReturns.map((value, i) => 0.0002 + 1.2 * value + Math.sin(i * 1.31) * 0.0015);
  const market = panelFromReturns("MKT", marketReturns);
  const stock = panelFromReturns("AAA", stockReturns);
  const before = marketResidualMomentum(stock, market, 59, 30, 10);
  assert.ok(before);
  for (const series of [stock, market]) {
    for (let i = 60; i < series.calendar.length; i++) {
      series.adjustedClose[i] *= 1.7;
      series.adjustedOpen[i] *= 1.7;
      series.close[i] *= 1.7;
      series.open[i] *= 1.7;
    }
  }
  assert.deepEqual(marketResidualMomentum(stock, market, 59, 30, 10), before);
});

test("market residual momentum rejects incomplete history and degenerate regression", () => {
  const varying = Array.from({ length: 50 }, (_, i) => Math.sin(i * 0.4) * 0.01);
  const stock = panelFromReturns("AAA", varying);
  const market = panelFromReturns("MKT", varying);
  assert.equal(marketResidualMomentum(stock, market, 49, 30, 10), null); // perfectly fitted residuals have zero SD
  const constantMarket = panelFromReturns("MKT", Array.from({ length: 50 }, () => 0));
  assert.equal(marketResidualMomentum(stock, constantMarket, 49, 30, 10), null);
  assert.equal(marketResidualMomentum(stock, market, 20, 30, 10), null);

  const stockWithStaleWindow = panelFromReturns("STALE", varying);
  stockWithStaleWindow.volume[30] = 0;
  assert.equal(marketResidualMomentum(stockWithStaleWindow, market, 49, 30, 10), null);
  const stockWithReset = panelFromReturns("RESET", varying);
  stockWithReset.segmentId[30] = stockWithReset.segmentId[29] + 1;
  assert.equal(marketResidualMomentum(stockWithReset, market, 49, 30, 10), null);
  const mismatchedCalendar = panelFromReturns("OTHER", varying);
  mismatchedCalendar.calendar[30] = "2030-01-01";
  assert.equal(marketResidualMomentum(stock, mismatchedCalendar, 49, 30, 10), null);
});
