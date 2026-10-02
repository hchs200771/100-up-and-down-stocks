import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanel, addDayQuotes, finalizePanel, featuresAt } from '../scripts/lib/wide-market-panel.ts';
import { eligibleCandidates, filterCandidates, stressReturn } from '../scripts/backtest-wide-market.ts';
import type { ExperimentCohort } from '../scripts/backtest-price-market-events.ts';

const dates = Array.from({ length: 62 }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
function candidates() {
  const p = createPanel(dates);
  for (let i = 0; i < dates.length; i++) {
    addDayQuotes(p, i, [ ['LOW', 50000, 100 + i * 2], ['HIGH', 100000, 100 + i] ].map(([code, volume, close]) => ({ code: String(code), name: String(code), market: 'twse', open: Number(close), high: Number(close) + 1, low: Number(close) - 1, close: Number(close), volume: Number(volume), money: 1000000, change: null, changeLabel: '', nextReference: null })));
  }
  finalizePanel(p);
  return [...p.values()].map((stock) => ({ stock, feature: featuresAt(stock, 61)! }));
}
test('50/100 lots changes contemporaneous candidates and still selects historical strength', () => {
  const c = candidates();
  assert.deepEqual(eligibleCandidates(c, 61, 50000).map((x) => x.stock.code), ['LOW', 'HIGH']);
  assert.deepEqual(eligibleCandidates(c, 61, 100000).map((x) => x.stock.code), ['HIGH']);
  assert.equal(c[0].stock.volume[0], 50000);
});
test('market/calendar filter cash decisions do not consult future event dates', () => {
  const c = candidates(); const market = { ...c[0].feature, closeAboveMa20: false };
  assert.equal(filterCandidates('market_ma20', c, c, market, 61, dates[61]).length, 0);
  assert.equal(filterCandidates('event_quarter_half', c, c, market, 61, '2020-03-14').length, 0);
  assert.equal(filterCandidates('event_quarter_half', c, c, market, 61, '2020-03-15').length, 2);
  assert.equal(filterCandidates('event_post_adjustment5', c, c, market, 61, dates[61]).length, 0);
  assert.equal(filterCandidates('event_avoid_adjustment5', c, c, market, 61, dates[61]).length, 2);
});
test('slippage charges only invested sleeve and leaves cash intact', () => {
  const cohort = { result: { valid: true, netReturnPct: 0, investedWeight: .5 } } as ExperimentCohort;
  assert.ok(Math.abs(stressReturn(cohort)! - (.5 + .5 * .995 / 1.005 - 1) * 100) < 1e-10);
  cohort.result.investedWeight = 0;
  assert.equal(stressReturn(cohort), 0);
  cohort.result.valid = false;
  assert.equal(stressReturn(cohort), null);
});

test('bootstrap never reports an exact zero Monte Carlo p-value', async () => {
  const { pairedBlockInterval } = await import('../scripts/backtest-price-market-events.ts');
  const positive = pairedBlockInterval(Array(24).fill(1), 1729, 32);
  assert.ok(positive.adjustedP! > 0);
  assert.equal(pairedBlockInterval(Array(24).fill(0), 1729, 32).adjustedP, 1);
});
