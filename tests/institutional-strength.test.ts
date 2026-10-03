import assert from "node:assert/strict";
import test from "node:test";
import { computeInstitutionalStrength } from "../scripts/institutional-strength.ts";

const universe = (count: number, targetNet: number) =>
  Array.from({ length: count }, (_, index) => ({
    code: `S${index}`,
    chips: {
      foreignNet: index === 0 ? targetNet : 0,
      trustNet: index === 0 ? targetNet : 0,
      totalNet: index === 0 ? targetNet : 0,
    },
  }));

const sharesFor = (stocks: Array<{ code: string }>, shares = 10_000_000) =>
  new Map(stocks.map(({ code }) => [code, shares]));

test("capital ratio distinguishes equal net buying with equal z scores", () => {
  const stocks = universe(20, 10_000);
  const shares = sharesFor(stocks);
  shares.set("S0", 25_000_000_000);

  const result = computeInstitutionalStrength(stocks, shares);
  const largeCap = result.get("S0")!;
  const baselineShares = sharesFor(stocks);
  const baseline = computeInstitutionalStrength(stocks, baselineShares).get(
    "S0",
  )!;
  assert.equal(largeCap.foreign.zScore, baseline.foreign.zScore);
  assert.ok(largeCap.foreign.zScore !== null && largeCap.foreign.zScore >= 2);
  assert.equal(largeCap.foreign.capitalRatio, 0.04);
  assert.equal(largeCap.foreign.significantBuy, false);

  shares.set("S0", 100_000_000);
  const smallCap = computeInstitutionalStrength(stocks, shares).get("S0")!;
  assert.equal(smallCap.foreign.zScore, largeCap.foreign.zScore);
  assert.equal(smallCap.foreign.capitalRatio, 10);
  assert.equal(smallCap.foreign.significantBuy, true);
});

test("significant buying requires both the z score and capital ratio gates", () => {
  const stocks = universe(20, 10_000);
  const shares = sharesFor(stocks, 25_000_000);
  const ratioPass = computeInstitutionalStrength(stocks, shares, {
    zThreshold: 5,
  }).get("S0")!;
  assert.equal(ratioPass.foreign.capitalRatio, 40);
  assert.equal(ratioPass.foreign.significantBuy, false);

  const zPass = computeInstitutionalStrength(stocks, shares, {
    foreignMinRatio: 41,
  }).get("S0")!;
  assert.ok(zPass.foreign.zScore !== null && zPass.foreign.zScore >= 2);
  assert.equal(zPass.foreign.significantBuy, false);
});

test("missing, zero, and nonfinite shares or net values fail safely", () => {
  const stocks = universe(20, 10_000);
  const shares = sharesFor(stocks, 10_000_000);
  shares.delete("S0");
  shares.set("S1", 0);
  shares.set("S2", Number.NaN);
  shares.set("S3", Number.POSITIVE_INFINITY);
  stocks[4].chips!.foreignNet = Number.NaN;
  stocks[5].chips!.trustNet = Number.POSITIVE_INFINITY;
  stocks[6].chips!.totalNet = Number.NEGATIVE_INFINITY;

  const result = computeInstitutionalStrength(stocks, shares);
  for (const code of ["S0", "S1", "S2", "S3"]) {
    for (const channel of ["foreign", "trust", "total"] as const) {
      assert.equal(result.get(code)![channel].zScore, null);
      assert.equal(result.get(code)![channel].capitalRatio, null);
      assert.equal(result.get(code)![channel].significantBuy, false);
    }
  }
  assert.equal(result.get("S4")!.foreign.zScore, null);
  assert.equal(result.get("S4")!.foreign.capitalRatio, null);
  assert.equal(result.get("S5")!.trust.zScore, null);
  assert.equal(result.get("S5")!.trust.capitalRatio, null);
  assert.equal(result.get("S6")!.total.zScore, null);
  assert.equal(result.get("S6")!.total.capitalRatio, null);
});

test("missing chips creates no entry", () => {
  const stocks: Array<{
    code: string;
    chips?: { foreignNet: number; trustNet: number; totalNet: number };
  }> = universe(20, 10_000);
  stocks[0] = { code: "S0" };
  assert.equal(
    computeInstitutionalStrength(stocks, sharesFor(stocks)).has("S0"),
    false,
  );
});

test("zero variance and an undersized universe have null z scores", () => {
  const flat = Array.from({ length: 20 }, (_, index) => ({
    code: `F${index}`,
    chips: { foreignNet: 12, trustNet: 12, totalNet: 12 },
  }));
  const flatResult = computeInstitutionalStrength(flat, sharesFor(flat));
  assert.equal(flatResult.get("F0")!.foreign.zScore, null);
  assert.equal(flatResult.get("F0")!.foreign.capitalRatio, 0.12);
  assert.equal(flatResult.get("F0")!.foreign.significantBuy, false);

  const small = universe(19, 10_000);
  const smallResult = computeInstitutionalStrength(
    small,
    sharesFor(small, 1_000_000),
  );
  assert.equal(smallResult.get("S0")!.foreign.zScore, null);
  assert.equal(smallResult.get("S0")!.foreign.capitalRatio, 1_000);
  assert.equal(smallResult.get("S0")!.foreign.significantBuy, false);
});

test("z score uses the whole supplied universe", () => {
  const stocks = universe(121, 1_000);
  const result = computeInstitutionalStrength(
    stocks,
    sharesFor(stocks, 1_000_000),
  );
  const expected = Math.sqrt(120);
  assert.ok(Math.abs(result.get("S0")!.foreign.zScore! - expected) < 1e-12);
  assert.ok(result.get("S0")!.foreign.significantBuy);
});

test("foreign, trust, and total channels calculate independently", () => {
  const stocks = Array.from({ length: 20 }, (_, index) => ({
    code: `C${index}`,
    chips: {
      foreignNet: index === 0 ? 10_000 : 0,
      trustNet: index === 1 ? 10_000 : 0,
      totalNet: index === 2 ? 10_000 : 0,
    },
  }));
  const result = computeInstitutionalStrength(
    stocks,
    sharesFor(stocks, 25_000_000),
  );
  assert.equal(result.get("C0")!.foreign.significantBuy, true);
  assert.equal(result.get("C0")!.trust.significantBuy, false);
  assert.equal(result.get("C0")!.total.significantBuy, false);
  assert.equal(result.get("C1")!.trust.significantBuy, true);
  assert.equal(result.get("C2")!.total.significantBuy, true);
});

test("ratio threshold is applied before display rounding", () => {
  const stocks = universe(20, 10_000);
  const shares = sharesFor(stocks, 10_000_000);
  // Exact ratio is 99.999%; its rounded display could read 100.00%.
  shares.set("S0", 10_000_100);
  const result = computeInstitutionalStrength(stocks, shares, {
    foreignMinRatio: 100,
  });
  assert.ok(
    Math.abs(result.get("S0")!.foreign.capitalRatio! - 99.9990000099999) <
      1e-10,
  );
  assert.equal(result.get("S0")!.foreign.significantBuy, false);
});

test("a relative outlier that is still selling cannot become a buy signal", () => {
  const stocks = universe(20, -1);
  for (const stock of stocks.slice(1)) stock.chips.foreignNet = -100;
  const strength = computeInstitutionalStrength(stocks, sharesFor(stocks), { foreignMinRatio: 0 }).get("S0")!;
  assert.ok(strength.foreign.zScore! > 2);
  assert.equal(strength.foreign.significantBuy, false);
});
