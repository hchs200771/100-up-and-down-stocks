import assert from "node:assert/strict";
import test from "node:test";

import { computeStockPickRisk } from "../scripts/lib/stock-pick-risk.ts";

test("stock-pick risk reads liquidity and trading flags from the full stock map", () => {
  const result = computeStockPickRisk({
    dayTrade: null,
    pctToday: 0,
    flags: { lowLiquidity: true, attention: true, disposition: true },
  });
  assert.equal(result.deduction, -27);
  assert.deepEqual(result.signals.map((signal) => signal.label), ["流動性低", "注意股", "處置股"]);
});

test("high pledge is a risk flag rather than a positive company-action signal", () => {
  const result = computeStockPickRisk({
    dayTrade: 46,
    pctToday: 9.7,
    flags: {},
    pledgeRatio: 62,
  });
  assert.equal(result.deduction, -26);
  assert.deepEqual(result.signals.map((signal) => signal.label), ["當沖過熱", "高設質風險", "今日漲停"]);
});
