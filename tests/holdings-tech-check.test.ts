import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beta, checkHolding, checkPortfolio, correlation, loadPrices, marketRegime, parseArgs,
  defaultStop, roundToTick, suggestedStop, verdict, weeklyCloses, type Price } from "../scripts/holdings-tech-check.ts";

const near = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-8, `${actual} != ${expected}`);
};
function series(returns: number[], start = 100): Price[] {
  const rows: Price[] = [];
  const cursor = new Date("2025-01-01T00:00:00Z");
  let close = start;
  for (let i = 0; i <= returns.length; i++) {
    while ([0, 6].includes(cursor.getUTCDay())) cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (i) close *= 1 + returns[i - 1];
    rows.push({ date: cursor.toISOString().slice(0, 10), close });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}
const returns = Array.from({ length: 259 }, (_, i) => ((i % 9) - 4) / 1000);
const market = series(returns), twice = series(returns.map((r) => r * 2)), inverse = series(returns.map((r) => -r));

test("verdict: stop priority, mirrored sides, MA20 before MA10, equality neutral", () => {
  for (const [side, close, ma10, ma20, stop, expected] of [
    ["多", 90, 80, 70, 90, "出場"], ["空", 110, 120, 130, 110, "出場"],
    ["多", 90, 80, 100, undefined, "出場警訊"], ["空", 110, 120, 100, undefined, "出場警訊"],
    ["多", 100, 110, 90, undefined, "警戒"], ["空", 100, 90, 110, undefined, "警戒"],
    ["多", 120, 110, 100, undefined, "續抱"], ["空", 80, 90, 100, undefined, "續抱"],
    ["多", 100, 100, 100, undefined, "續抱"], ["空", 100, 100, 100, undefined, "續抱"],
  ] as const) assert.equal(verdict(side, close, ma10, ma20, stop), expected);
});

test("suggested stop: 20-day extreme or 8% cap, mirrored; all stock tick tiers and TAIEX", () => {
  assert.equal(suggestedStop("多", 100, 95.2, 120).suggestedStop, 95.2);
  assert.equal(suggestedStop("多", 100, 80, 120).suggestedStop, 92);
  assert.equal(suggestedStop("空", 100, 80, 105).suggestedStop, 105);
  assert.equal(suggestedStop("空", 100, 80, 120).suggestedStop, 108);
  assert.equal(suggestedStop("多", 100, 100, 120).suggestedStop, 92);
  assert.equal(suggestedStop("空", 100, 80, 100).suggestedStop, 108);
  assert.match(suggestedStop("空", 100, 80, 120).suggestedStopReason, /最高收盤/);
  for (const [input, expected] of [[9.994, 9.99], [9.999, 10], [10.027, 10.05], [49.99, 50],
    [50.06, 50.1], [99.99, 100], [100.26, 100.5], [499.9, 500], [500.6, 501], [999.9, 1000], [1002.6, 1005]]) {
    assert.equal(roundToTick(input), expected);
  }
  assert.equal(roundToTick(23456.6, "TAIEX"), 23457);
  assert.equal(suggestedStop("多", 23456.7, 20000, 24000, "TAIEX").suggestedStop, 21580);
});

test("weekly closes: Monday boundaries, year boundary, holiday-shortened and partial weeks", () => {
  const rows = ["2025-12-26", "2025-12-29", "2025-12-31", "2026-01-02", "2026-01-05", "2026-01-06"]
    .map((date, i) => ({ date, close: 100 + i }));
  assert.deepEqual(weeklyCloses([...rows].reverse()), [rows[0], rows[3], rows[5]]);
  assert.deepEqual(weeklyCloses([]), []);
});

test("technical metrics: SMA, weekly SMA, extremes, sample volatility, signed stop distance", () => {
  const rows = series(Array(259).fill(0)).map((r, i) => ({ ...r, close: i + 1 }));
  const h = checkHolding({ code: "2330", direction: "多", stop: 250 }, rows);
  assert.equal(h.status, "ok");
  assert.equal(h.close, 260);
  assert.equal(h.ma10, 255.5);
  assert.equal(h.ma20, 250.5);
  assert.equal(h.ma60, 230.5);
  assert.equal(h.support.low20, 241);
  assert.equal(h.resistance.high60, 260);
  assert.equal(h.trend, "多頭排列");
  assert.equal(h.aboveWma10, true);
  assert.equal(h.aboveWma30, true);
  near(h.wma30, h.weeklyCloses.slice(-30).reduce((sum, r) => sum + r.close, 0) / 30);
  assert.equal(h.stopDistancePct, 3.8462);
  assert.equal(h.stopStatus, "距 3.8%");
  assert.equal(checkHolding({ code: "2330", direction: "空", stop: 250 }, rows).stopStatus, "已觸發");
  assert.equal(checkHolding({ code: "2330", direction: "空", stop: 270 }, rows).stopDistancePct, 3.8462);
  assert.equal(checkHolding({ code: "2330", direction: "多" }, series(Array(259).fill(0.01))).vol20, 0);
  const changes = Array.from({ length: 20 }, (_, i) => i % 2 ? -0.01 : 0.01);
  assert.equal(checkHolding({ code: "2330", direction: "多" }, series(changes)).vol20, 1.026);
  const missing = checkHolding({ code: "AAPL", direction: "多" }, []);
  assert.equal(missing.status, "資料不足");
  assert.equal(missing.verdict, "資料不足");
  assert.equal(missing.close, null);
  assert.equal(checkHolding({ code: "2330", direction: "多", stop: 100 }, [{ date: "2026-01-01", close: 90 }]).verdict, "出場");
});

test("beta and correlation: known synthetic exposure, inverse, constant, insufficient and missing intervals", () => {
  near(beta(twice, market), 2);
  near(beta(market, market), 1);
  near(beta(inverse, market), -1);
  near(correlation(twice, market), 1);
  near(correlation(inverse, market), -1);
  assert.equal(beta(twice.slice(-120), market), null);
  assert.equal(correlation(twice.slice(-60), market), null);
  assert.equal(beta(twice, series(Array(259).fill(0))), null);
  assert.equal(correlation(twice, series(Array(259).fill(0))), null);
  // A gap creates a two-day return; only the 118 genuine matching one-day intervals remain.
  const short = twice.slice(-121).filter((_, i) => i !== 60);
  assert.equal(beta(short, market), null);
  assert.equal(beta(short, market, 119), null);
  near(beta(short, market, 118), 2);
});

test("portfolio: signed weights, stress loss ranking, concentration and independent hedge lots", () => {
  const p = checkPortfolio([{ code: "TAIEX", direction: "多", weight: 0.3 }, { code: "2330", direction: "多", weight: 0.25 },
    { code: "3016", direction: "空", weight: 0.1 }], { TAIEX: market, "2330": twice, "3016": twice }, market, 5000000);
  near(p.betaWeightedNetExposure, 0.6);
  near(p.stress!.estimatedPortfolioMovePct, -12);
  assert.equal(p.stress!.estimatedPnlTwd, -600000);
  assert.deepEqual(p.stress!.topLossContributors.map((h) => h.code), ["2330", "TAIEX"]);
  assert.equal(p.hiddenCorrelation.length, 3);
  assert.equal(p.concentrationFlags.length, 3);
  assert.equal(p.hedge!.direction, "空");
  assert.equal(p.hedge!.neutralize.microLots, Math.round(3000000 / (market.at(-1)!.close * 10)));
  assert.equal(p.hedge!.halve.miniLots, Math.round(1500000 / (market.at(-1)!.close * 50)));
  const short = checkPortfolio([{ code: "TAIEX", direction: "空", weight: 0.2 }], { TAIEX: market }, market, 5000000);
  assert.equal(short.stress!.estimatedPortfolioMovePct, 4);
  assert.deepEqual(short.stress!.topLossContributors, []);
  assert.equal(short.hedge!.direction, "多");
});

test("portfolio: no guessed beta or normalized weights; partial coverage explicitly flagged", () => {
  const noWeights = checkPortfolio([{ code: "TAIEX", direction: "多" }], { TAIEX: market }, market, 1000);
  assert.equal(noWeights.stress, null);
  assert.equal(noWeights.hedge, null);
  const unknown = checkPortfolio([{ code: "AAPL", direction: "多", weight: 0.2 }], {}, market, 1000);
  assert.equal(unknown.betaWeightedNetExposure, null);
  assert.match(unknown.warnings.join(""), /缺少/);
  const partial = checkPortfolio([{ code: "TAIEX", direction: "多", weight: 0.21 }, { code: "2330", direction: "多" }],
    { TAIEX: market, "2330": twice }, market);
  assert.equal(partial.betaWeightedNetExposure, 0.21);
  assert.match(partial.warnings.join(""), /部分持股/);
  assert.equal(partial.hedge, null);
});

test("regime: four fixed rules, MA60 five sessions ago, latest month and insufficient data", () => {
  const rising = series(Array(259).fill(0.01));
  const r = marketRegime(rising);
  assert.equal(r.level, 100);
  assert.deepEqual(Object.values(r.conditions), [true, true, true, true]);
  const summer = rising.slice(0, 150);
  assert.equal(marketRegime(summer).level, 75);
  assert.equal(marketRegime(series(Array(259).fill(-0.01))).level, 25);
  assert.equal(marketRegime(rising.slice(0, 64)).level, null);
  assert.equal(marketRegime([]).level, null);
});

test("CLI parsing: full grammar, foreign ticker kept, invalid input rejected", () => {
  assert.deepEqual(parseArgs(["TAIEX:多@0.21", "2330:多:1000@0.1", "AAPL:空", "--date", "2026-11-02", "--notional", "5000000"]), {
    holdings: [{ code: "TAIEX", direction: "多", weight: 0.21 }, { code: "2330", direction: "多", stop: 1000, weight: 0.1 }, { code: "AAPL", direction: "空" }],
    date: "2026-11-02", notional: 5000000,
  });
  for (const args of [[], ["2330:多@1.1"], ["2330:多:0"], ["2330:多", "--date", "2026-02-30"],
    ["2330:多", "--notional"], ["2330:多", "--date"], ["2330:多", "--unknown"]]) assert.throws(() => parseArgs(args));
});

test("local loader: date cutoff, empty caches, missing/foreign codes and no future leakage", () => {
  const root = mkdtempSync(join(tmpdir(), "holdings-tech-"));
  try {
    mkdirSync(join(root, "data/cache"), { recursive: true });
    mkdirSync(join(root, "data/backtest/taiex"), { recursive: true });
    for (const [day, data] of [["20260102", { "2330": 100 }], ["20260103", {}], ["20260105", { "2330": 110 }], ["20260106", { "2330": 120 }]] as const) {
      writeFileSync(join(root, `data/cache/close-${day}.json`), JSON.stringify(data));
    }
    writeFileSync(join(root, "data/backtest/taiex/taiex-daily.json"), JSON.stringify([
      { date: "2026-01-02", close: 20000 }, { date: "2026-01-06", close: 22000 },
    ]));
    const { prices, market } = loadPrices(["2330", "TAIEX", "AAPL", "9999"], "2026-01-05", root);
    assert.deepEqual(prices["2330"].map((r) => r.close), [100, 110]);
    assert.deepEqual(prices.AAPL, []);
    assert.deepEqual(prices["9999"], []);
    assert.deepEqual(prices.TAIEX, market);
    assert.equal(market.length, 1);
    assert.match(checkPortfolio([{ code: "2330", direction: "多" }], prices, market).warnings.join(""), /資料落後/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default stop: cost ±10% rounded to tick", () => {
  assert.equal(defaultStop("多", 289.5, "7792").suggestedStop, 260.5);
  assert.equal(defaultStop("空", 100, "2330").suggestedStop, 110);
  assert.equal(defaultStop("多", 289.5).suggestedStopRule, "fixed-10");
});
