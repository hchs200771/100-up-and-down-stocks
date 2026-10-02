import assert from "node:assert/strict";
import test from "node:test";
import { calculateDirectionalReturns, evaluateTrade, inclusiveExitDay, nextTradingDay, passesFilter, runBacktest, type FilterContext, type InstitutionalRow, type PriceRow } from "../scripts/backtest-pick-filters.ts";

const dates = ["2026-01-01", "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"];
function row(date: string, open: number, close: number, volume = 10): PriceRow { return { date, open, close, max: Math.max(open, close) + 1, min: Math.min(open, close) - 1, Trading_Volume: volume }; }
const pick = { code: "1234", close: 100 };
function trade(stock: PriceRow[], h = 5, extras: Partial<Parameters<typeof evaluateTrade>[0]> = {}) {
  const benchmark = dates.map((d) => row(d, 100, 101));
  return evaluateTrade({ pick, signalDate: dates[0], direction: "long", horizon: h, calendar: dates, stockRows: new Map(stock.map((r) => [r.date, r])), benchmarkRows: new Map(benchmark.map((r) => [r.date, r])), ...extras });
}

test("entry is the next TAIEX session and the signal day is never used as fill", () => {
  assert.equal(nextTradingDay(dates, dates[0]), dates[1]);
  assert.equal(nextTradingDay(dates, "2026-01-02"), dates[2]);
});

test("five day holding exits at entry index plus four (inclusive entry day)", () => {
  assert.equal(inclusiveExitDay(dates, dates[1], 5), dates[5]);
  const stock = [row(dates[0], 100, 100), row(dates[1], 110, 111), row(dates[5], 110, 121)];
  const result = trade(stock);
  assert.equal(result.observation?.entryDate, dates[1]);
  assert.equal(result.observation?.exitDate, dates[5]);
  assert.ok(Math.abs((result.observation?.grossReturnPct ?? 0) - 10) < 1e-9);
});

test("missing exact entry does not shift forward to the next stock quote", () => {
  const stock = [row(dates[0], 100, 100), row(dates[2], 110, 111), row(dates[5], 110, 121)];
  assert.equal(trade(stock).exclusion, `missing_price_row:${dates[1]}`);
});

test("zero volume and locked one-price entry rows are excluded with explicit reasons", () => {
  const base = [row(dates[0], 100, 100), row(dates[1], 100, 101), row(dates[5], 100, 101)];
  assert.equal(trade([base[0], { ...base[1], Trading_Volume: 0 }, base[2]]).exclusion, `missing_or_zero_volume:${dates[1]}`);
  assert.equal(trade([base[0], { ...base[1], open: 100, max: 100, min: 100 }, base[2]]).exclusion, `locked_one_price:${dates[1]}`);
});

test("both selection boards use long stock returns and the positive benchmark return", () => {
  const out = calculateDirectionalReturns(100, 110, 100, 105);
  assert.ok(Math.abs(out.grossReturnPct - 10) < 1e-9);
  assert.ok(Math.abs(out.netReturnPct - 9.415) < 1e-9);
  assert.ok(Math.abs(out.benchmarkReturnPct - 5) < 1e-9);
  assert.ok(Math.abs(out.netExcessPct - 4.415) < 1e-12);
  assert.ok(calculateDirectionalReturns(100, 90, 100, 95).netExcessPct < 0);
});

test("full backtest treats the short-term board as a stock purchase, identical to the long-term board", () => {
  const stock = dates.map((date) => row(date, 100, date === dates[5] ? 110 : 100));
  const benchmark = dates.map((date) => row(date, 100, date === dates[5] ? 105 : 100));
  const output = runBacktest([{ date: dates[0], long: [pick], short: [pick] }], {
    source: "fixture", startDate: dates[0], endDate: dates.at(-1)!,
    prices: { "1234": stock, TAIEX: benchmark },
    corporateActions: { "1234": [] }, corporateActionCoverage: { "1234": true },
  });
  const baseline = output.summaries.filter((summary) => summary.filter === "baseline" && summary.horizonTradingDays === 5);
  assert.equal(baseline.length, 2);
  for (const summary of baseline) {
    assert.equal(summary.maturedTrades, 1);
    assert.ok(Math.abs(Number(summary.meanNetExcessPct) - 4.415) < 1e-9);
  }
});

test("null execution inputs exclude; corporate action during holding excludes but entry-date event is allowed", () => {
  const rows = [row(dates[0], 100, 100), row(dates[1], 100, 100), row(dates[5], 100, 100)];
  assert.equal(trade([row(dates[0], 100, 100), { ...row(dates[1], 100, 100), open: null }, row(dates[5], 100, 100)]).exclusion, `missing_or_zero_open_close:${dates[1]}`);
  assert.equal(trade(rows, 5, { pick: { code: "1234", close: undefined } }).exclusion, "signal_close_mismatch_or_missing");
  assert.equal(trade(rows, 5, { corporateActionCoverage: { "1234": false } }).exclusion, "corporate_action_coverage_missing");
  assert.equal(trade(rows, 5, { corporateActionCoverage: {} }).exclusion, "corporate_action_coverage_missing");
  assert.equal(trade(rows, 5, { corporateActions: { "1234": [{ date: dates[2] }] } }).exclusion, "corporate_action_within_holding");
  assert.ok(trade(rows, 5, { corporateActions: { "1234": [{ date: dates[1] }] } }).observation);
});

function factorContext(signalDate: string, calendar: string[], trustRows: InstitutionalRow[], prices: PriceRow[] = []): FilterContext {
  return { signalDate, calendar, institutionalRows: trustRows, stockRows: new Map(prices.map((r) => [r.date, r])) };
}
const trustRow = (date: string, net: number): InstitutionalRow => ({ date, name: "Investment_Trust", buy: Math.max(net, 0), sell: Math.max(-net, 0) });

test("trust streak requires three positive daily net buys including signal date and ignores future rows", () => {
  const calendar = ["2026-01-01", "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
  const ctx = factorContext("2026-01-05", calendar, [trustRow("2026-01-01", 10), trustRow("2026-01-02", 20), trustRow("2026-01-05", 30), trustRow("2026-01-06", -1000)]);
  assert.equal(passesFilter("trust_streak3", { code: "1234" }, ctx), true);
  const brokenStreak = factorContext("2026-01-05", calendar, [trustRow("2026-01-01", 10), trustRow("2026-01-02", 0), trustRow("2026-01-05", 30)]);
  assert.equal(passesFilter("trust_streak3", { code: "1234" }, brokenStreak), false);
  assert.equal(passesFilter("trust_streak3", { code: "1234" }, factorContext("2026-01-05", calendar, [trustRow("2026-01-01", 10), trustRow("2026-01-05", 30)])), null);
});

test("five-session trust net and twenty-session liquidity use exact prior calendar windows only", () => {
  const dates20 = Array.from({ length: 21 }, (_, i) => `2026-02-${String(i + 1).padStart(2, "0")}`);
  const signalDate = dates20[19];
  const trust = dates20.slice(0, 20).map((date) => trustRow(date, 10));
  trust.push(trustRow(dates20[20], -10000));
  const trustCtx = factorContext(signalDate, dates20, trust);
  assert.equal(passesFilter("trust_net5_positive", { code: "1234" }, trustCtx), true);

  const lowLiquidity = dates20.slice(0, 20).map((date) => ({ ...row(date, 1, 1), Trading_money: 40_000_000 }));
  lowLiquidity.push({ ...row(dates20[20], 1, 1), Trading_money: 2_000_000_000 });
  assert.equal(passesFilter("liquidity20", { code: "1234" }, factorContext(signalDate, dates20, [], lowLiquidity)), false);
  const missingOne = lowLiquidity.slice(0, 19);
  assert.equal(passesFilter("liquidity20", { code: "1234" }, factorContext(signalDate, dates20, [], missingOne)), null);
  assert.equal(passesFilter("trust_net5_positive", { code: "1234" }, factorContext(signalDate, dates20, trust.slice(0, 18))), null);
});

test("zero trust and liquidity values are real observations, not missing inputs", () => {
  const shortCalendar = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"];
  const zeroTrust = shortCalendar.map((date) => trustRow(date, 0));
  assert.equal(passesFilter("trust_net5_positive", { code: "1234" }, factorContext(shortCalendar[4], shortCalendar, zeroTrust)), false);
  const dates20 = Array.from({ length: 20 }, (_, i) => `2026-04-${String(i + 1).padStart(2, "0")}`);
  const zeros = dates20.map((date) => ({ ...row(date, 1, 1), Trading_money: 0 }));
  assert.equal(passesFilter("liquidity20", { code: "1234" }, factorContext(dates20[19], dates20, [], zeros)), false);
});
