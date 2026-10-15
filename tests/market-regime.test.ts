import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { computeMa20, computeMarketRegime, type MarketRegimeIndex } from "../scripts/lib/market-regime.ts";

test("MA20 uses the last 20 finite closes and exposes four-decimal precision", () => {
  const result = computeMa20([null, ...Array.from({ length: 19 }, (_, i) => i + 1), NaN, 20]);
  assert.equal(result.ma20, 10.5);
  assert.equal(result.aboveMa20, true);
  assert.equal(result.ma20GapPct, Number(((20 / 10.5 - 1) * 100).toFixed(2)));
  assert.equal(result.ma20Slope, undefined);
});

test("MA20 requires 20 valid closes and compares the latest with the MA five valid bars earlier", () => {
  assert.deepEqual(computeMa20(Array(19).fill(100)), {});
  assert.equal(computeMa20(Array.from({ length: 20 }, (_, i) => i + 1)).ma20Slope, undefined);
  assert.equal(computeMa20(Array.from({ length: 25 }, (_, i) => i + 1)).ma20Slope, "up");
  assert.equal(computeMa20([...Array.from({ length: 20 }, () => 100), ...Array.from({ length: 5 }, () => 100)]).ma20Slope, "flat");
  assert.equal(computeMa20([...Array.from({ length: 20 }, () => 110), ...Array.from({ length: 5 }, () => 100)]).ma20Slope, "down");
});

test("MA20 ignores non-finite values", () => {
  const result = computeMa20([NaN, Infinity, -Infinity, ...Array.from({ length: 20 }, () => 8)]);
  assert.equal(result.ma20, 8);
  assert.equal(result.aboveMa20, false);
});

test("market regime handles no data and reports every missing expected key", () => {
  const result = computeMarketRegime();
  assert.equal(result.score, 50);
  assert.equal(result.signal, "yellow");
  assert.equal(result.missing.length, 11);
  assert.match(result.conclusion, /資料/);
  assert.ok(result.reasons.every((reason) => reason.includes("資料缺")));
});

test("market regime applies US breadth bonuses and downside caps", () => {
  const allUs: MarketRegimeIndex[] = ["sp500", "nasdaq", "dji", "sox"].map((key) => ({ key, aboveMa20: true, ma20GapPct: 1 }));
  const complete = [...allUs, ...["us10y", "wti", "dxy", "nikkei", "kospi", "hsi", "china_adr"].map((key) => ({ key, aboveMa20: false, ma20GapPct: -1 }))];
  assert.equal(computeMarketRegime(complete).score, 93.57);
  assert.equal(computeMarketRegime(complete).signal, "green");

  const twoDown = [
    ...allUs.map((item, i) => ({ ...item, aboveMa20: i >= 2 })),
    ...["us10y", "wti", "dxy"].map((key) => ({ key, aboveMa20: false, ma20Slope: "down" as const })),
    ...["nikkei", "kospi", "hsi", "china_adr"].map((key) => ({ key, aboveMa20: true })),
  ];
  assert.equal(computeMarketRegime(twoDown).signal, "yellow");
  const allDown: MarketRegimeIndex[] = complete.map((item) => ({ ...item, aboveMa20: false }));
  allDown.find((item) => item.key === "us10y")!.aboveMa20 = true;
  allDown.find((item) => item.key === "us10y")!.ma20Slope = "up";
  assert.ok(computeMarketRegime(allDown).score <= 39);
  assert.equal(computeMarketRegime(allDown).signal, "red");
});

test("macro scoring favors below or falling indicators and caps stressed tech with rising yields", () => {
  const indices: MarketRegimeIndex[] = [
    { key: "sp500", aboveMa20: true }, { key: "nasdaq", aboveMa20: false },
    { key: "dji", aboveMa20: true }, { key: "sox", aboveMa20: false },
    { key: "us10y", aboveMa20: true, ma20Slope: "up" },
  ];
  const result = computeMarketRegime(indices);
  assert.equal(result.signal, "red");
  assert.ok(result.score <= 39);
  assert.match(result.reasons[4], /月線上彎/);
});

test("regional equity strength is favorable and macro slopes use their separate rule", () => {
  const regionalBelow: MarketRegimeIndex[] = ["nikkei", "kospi", "hsi", "china_adr"].map((key) => ({ key, aboveMa20: false }));
  const regionalAbove = regionalBelow.map((item) => ({ ...item, aboveMa20: true }));
  assert.ok(computeMarketRegime(regionalAbove).score > computeMarketRegime(regionalBelow).score);

  const macroNeutral = computeMarketRegime([{ key: "us10y", aboveMa20: true }]);
  const macroFalling = computeMarketRegime([{ key: "us10y", aboveMa20: true, ma20Slope: "down" }]);
  assert.equal(macroNeutral.score, 50);
  assert.ok(macroFalling.score > macroNeutral.score);
});

test("fetchOne excludes today's live spike and appends the official price after close", async () => {
  const source = ts.createSourceFile("fetch-intl-market.ts", readFileSync(new URL("../scripts/fetch-intl-market.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wanted = new Set(["localDate", "dailyBars", "fetchOne"]);
  const declarations = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && wanted.has(node.name.text));
  assert.equal(declarations.length, wanted.size);
  const extracted = declarations.map((node) => node.getFullText(source)).join("\n");
  const js = ts.transpileModule(`${extracted}\nfetchOne`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const now = Date.parse("2026-03-30T12:00:00Z");
  const FixedDate = class extends Date { static now() { return now; } };
  const env = vm.createContext({ Date: FixedDate, console: { warn() {} }, fetchChart: async () => fixture, computeMa20, fillGapClose: async () => { throw new Error("fillGapClose should not run"); } });
  const fetchOne = vm.runInContext(js, env) as (symbol: string) => Promise<{ close: number; ma20?: number } | null>;
  const day = 86_400;
  const today = now / 1000;
  const fixture = { meta: { gmtoffset: 0, currentTradingPeriod: { regular: { start: today - 3600, end: today + 8 * 3600 } }, regularMarketTime: today, regularMarketPrice: 2000 }, timestamps: Array.from({ length: 26 }, (_, i) => today - (25 - i) * day), closes: [...Array(25).fill(100), 999] };
  const live = await fetchOne("^GSPC");
  assert.equal(live?.close, 100);
  assert.equal(live?.ma20, 100);

  fixture.meta.currentTradingPeriod.regular.start = today - 24 * 3600;
  fixture.meta.currentTradingPeriod.regular.end = today - 12 * 3600;
  fixture.timestamps = fixture.timestamps.slice(0, 25);
  fixture.closes = fixture.closes.slice(0, 25);
  const closed = await fetchOne("^N225");
  assert.equal(closed?.close, 2000);
  assert.equal(closed?.ma20, 195);
});
