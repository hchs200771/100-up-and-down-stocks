import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { volumeProfileStop, validOhlcv, twoYearsBefore, type Ohlcv } from "../scripts/lib/volume-profile-stop.ts";
import { fetchOhlcv, parseArgs as parseCli } from "../scripts/volume-profile-stop.ts";
import { checkHolding, parseArgs } from "../scripts/holdings-tech-check.ts";

const fixture: Ohlcv[] = JSON.parse(readFileSync(new URL("./fixtures/finmind-7792-20261112.json", import.meta.url), "utf8")).data;
const input = { rows: fixture, asOf: "2026-11-12", reference: 289.5, direction: "多" as const, code: "7792" };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const row = (date: string, low: number, high = low, volume = 1000): Ohlcv => ({ date, open: low, min: low, max: high, close: high, Trading_Volume: volume });
const days = (count: number, low = 100, high = low, volume = 1000) => Array.from({ length: count }, (_, i) => row(`2026-10-${String(i + 1).padStart(2, "0")}`, low, high, volume));

test("7792: ATR, structural peak, unfilled gap and final stop match acceptance", () => {
  const result = volumeProfileStop(input)!;
  assert.equal(result.binWidth, 5);
  near(result.atr14!, 23.571428571428573);
  assert.deepEqual([result.structuralPeak!.peakLow, result.structuralPeak!.peakHigh, result.structuralPeak!.low], [250, 255, 245]);
  assert.equal(result.structuralStop, 243);
  near(result.structuralDistancePct!, 16.06217616580311);
  assert.equal(result.selected!.kind, "未回補跳空");
  assert.equal(result.selected!.date, "2026-11-10");
  assert.equal(result.selected!.level, 264);
  assert.equal(result.stop, 262);
  near(result.distancePct, 9.499136442141623);
  assert.equal(result.tooFar, false);
  assert.equal(result.tooTight, false);
  near(result.atrMultiple!, 27.5 / result.atr14!);
  // 按文字規格單向延伸半峰值群：不是驗收預估的雙向 295–320。
  assert.deepEqual([result.target!.low, result.target!.high], [305, 375]);
  near(result.rewardRiskRatio!, (305 - 289.5) / (289.5 - 262));
  assert.match(result.explanation, /收盤價跌破/);
});

test("profile conserves volume, uses overlap and half-open bins; flat bars have one bin", () => {
  const rows = [row("2026-10-01", 90, 96, 6000), row("2026-10-02", 95, 95, 2000)];
  const result = volumeProfileStop({ rows, asOf: "2026-10-02", reference: 100, direction: "多" })!;
  near(result.bins.reduce((sum, b) => sum + b.volume, 0), 8);
  near(result.bins.find((b) => b.low === 90)!.volume, 2.5);
  near(result.bins.find((b) => b.low === 92.5)!.volume, 2.5);
  near(result.bins.find((b) => b.low === 95)!.volume, 3);
  assert.equal(result.atr14, null);
  assert.equal(result.atrMultiple, null);
  assert.equal(result.target, null);
});

test("asOf/two-year cutoff, invalid early rows and input immutability", () => {
  const rows = [...fixture, row("2026-11-13", 1000), row("2024-11-11", 5), row("2026-11-01", 0, 0), row("2026-11-02", 20, 10)];
  const before = JSON.stringify(rows);
  assert.deepEqual(volumeProfileStop({ ...input, rows }), volumeProfileStop(input));
  assert.equal(JSON.stringify(rows), before);
  assert.equal(volumeProfileStop({ ...input, rows: [] }), null);
  assert.throws(() => volumeProfileStop({ ...input, reference: 0 }));
  assert.equal(twoYearsBefore("2024-02-29"), "2022-02-28");
  assert.equal(validOhlcv([row("2024-11-12", 5), row("2024-11-11", 5)], input.asOf).length, 1);
});

test("primary peak stop and short mirror use opposite group edges and buffers", () => {
  const rows = [...days(15, 92.6, 92.6, 100000), row("2026-10-16", 101.25)];
  const long = volumeProfileStop({ rows, asOf: "2026-10-16", reference: 101.25, direction: "多" })!;
  assert.equal(long.selected!.kind, "量峰下緣");
  assert.equal(long.selected!.level, 92.5);
  assert.equal(long.stop, 91.8);
  const mirrored = rows.map((r) => ({ ...r, min: 202.5 - r.max, max: 202.5 - r.min, open: 202.5 - r.open, close: 202.5 - r.close }));
  const short = volumeProfileStop({ rows: mirrored, asOf: "2026-10-16", reference: 101.25, direction: "空" })!;
  assert.equal(short.selected!.kind, "量峰上緣");
  assert.equal(short.selected!.level, 110);
  assert.equal(short.stop, 111);
  assert.ok(short.distancePct > 0);
  assert.match(short.explanation, /收盤價站上/);
});

test("no structure gives 10% cap; wide daily ranges flag tight stops", () => {
  const emptyVolume = volumeProfileStop({ rows: days(20, 100, 100, 0), asOf: "2026-10-20", reference: 100, direction: "多" })!;
  assert.equal(emptyVolume.stop, 90);
  assert.equal(emptyVolume.tooFar, true);
  assert.match(emptyVolume.reason, /結構支撐太遠，建議減碼或不進場/);
  assert.equal(volumeProfileStop({ rows: days(20, 100, 100, 0), asOf: "2026-10-20", reference: 100, direction: "空" })!.stop, 110);
  const wide = volumeProfileStop({ rows: days(20, 90, 110), asOf: "2026-10-20", reference: 100, direction: "多" })!;
  assert.equal(wide.atr14, 20);
  assert.equal(wide.tooTight, true);
});

test("gap candidates require unfilled gaps; short gaps mirror long; cap includes buffer", () => {
  const rows = [row("2026-10-01", 90, 90, 0), row("2026-10-02", 95, 95, 0), row("2026-10-03", 96, 96, 0)];
  const calc = (rows: Ohlcv[], direction: "多" | "空" = "多") => volumeProfileStop({ rows, asOf: "2026-10-03", reference: 100, direction })!;
  const r = calc(rows);
  assert.ok(!r.candidates.some((c) => c.level === 90)); // 90 加緩衝後超過 10%
  assert.equal(r.stop, 94.3);
  assert.equal(r.selected!.level, 95);
  assert.equal(calc([...rows.slice(0, 2), row("2026-10-03", 95)]).candidates.some((c) => c.level === 95), false);
  const short = calc(rows.map((r) => ({ ...r, min: 200 - r.max, max: 200 - r.min, close: 200 - r.close })), "空");
  assert.equal(short.selected!.kind, "未回補跳空");
  assert.equal(short.selected!.level, 105);
  assert.equal(short.stop, 106);
});

test("swing candidate needs three sessions on either side and chooses lowest eligible level", () => {
  const rows = days(12, 100, 101, 0);
  rows[4].min = 95;
  rows[8].min = 93;
  rows[10].min = 91;
  const result = volumeProfileStop({ rows, asOf: "2026-10-12", reference: 100, direction: "多" })!;
  assert.equal(result.selected!.kind, "波段低點");
  assert.equal(result.selected!.level, 95); // 93 被後三日的 91 否決，91 尚未確認
  assert.equal(result.stop, 94.3);
});

test("smaller peak without 1.5x valley contrast can replace a distant structural peak", () => {
  const rows = [row("2026-10-01", 100, 100, 1000), row("2026-10-02", 97.5, 97.5, 1000),
    row("2026-10-03", 95, 95, 1200), row("2026-10-04", 70, 70, 10000)];
  const result = volumeProfileStop({ rows, asOf: "2026-10-04", reference: 100, direction: "多" })!;
  assert.equal(result.structuralPeak!.low, 70);
  assert.equal(result.selected!.kind, "較小量峰");
  assert.equal(result.selected!.level, 95);
  assert.equal(result.stop, 94.3);
});

test("holdings accept average in any order, default to cost −10% with VP as reference, preserve explicit stops and fallback", () => {
  for (const arg of ["7792:多~289.5:260@0.2", "7792:多@0.2~289.5:260", "7792:多:260@0.2~289.5"]) {
    assert.deepEqual(parseArgs([arg]).holdings[0], { code: "7792", direction: "多", stop: 260, weight: 0.2, averagePrice: 289.5 });
  }
  for (const arg of ["7792:多~0", "7792:多~100~200", "7792:多@0.1@0.2", "7792:多~abc"]) assert.throws(() => parseArgs([arg]));
  const prices = fixture.map((r) => ({ date: r.date, close: r.close }));
  const holding = { code: "7792", direction: "多" as const, averagePrice: 289.5 };
  const result = checkHolding(holding, prices, fixture, input.asOf);
  assert.equal(result.suggestedStop, 260.5);
  assert.equal(result.suggestedStopRule, "fixed-10");
  assert.equal(result.volumeProfileStop, 262);
  assert.match(result.volumeProfileStopReason!, /未回補跳空 264/);
  assert.equal(checkHolding(holding, prices, null).suggestedStopRule, "fixed-10");
  assert.equal(checkHolding({ ...holding, stop: 250 }, prices, fixture).suggestedStop, undefined);
  assert.equal(checkHolding({ code: "7792", direction: "多" }, prices, fixture, input.asOf).suggestedStopRule, "fallback-20d");
  assert.equal(checkHolding({ ...holding, code: "TAIEX" }, prices, fixture).suggestedStopRule, "fallback-20d");
});

test("CLI validates input and date", () => {
  assert.deepEqual(parseCli(["7792", "多", "289.5", "--date", "2026-11-12", "--json"]), { code: "7792", direction: "多", reference: 289.5, asOf: "2026-11-12", json: true });
  for (const args of [[], ["../7792", "多", "100"], ["7792", "空", "0"], ["7792", "多", "100", "--date", "2026-02-30"], ["7792", "多", "100", "--bad"]]) assert.throws(() => parseCli(args));
});

test("FinMind loader caches same-date requests and returns null on failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "vp-stop-")), original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls++;
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get("start_date"), "2024-11-12");
      assert.equal(parsed.searchParams.get("end_date"), "2026-11-12");
      assert.equal(parsed.searchParams.get("dataset"), "TaiwanStockPrice");
      assert.ok(init?.signal);
      return Response.json({ status: 200, data: fixture });
    };
    const first = await fetchOhlcv("7792", input.asOf, root);
    assert.ok(first!.length > 0);
    assert.deepEqual(await fetchOhlcv("7792", input.asOf, root), first);
    assert.equal(calls, 1);
    globalThis.fetch = async () => { throw new Error("timeout"); };
    assert.equal(await fetchOhlcv("2330", input.asOf, root), null);
    assert.equal(await fetchOhlcv("TAIEX", input.asOf, root), null);
    globalThis.fetch = async () => Response.json({ status: 402, data: [] });
    assert.equal(await fetchOhlcv("2330", input.asOf, root), null);
    mkdirSync(join(root, "data/cache/finmind-ohlcv"), { recursive: true });
    writeFileSync(join(root, "data/cache/finmind-ohlcv/2330-2026-11-12.json"), "invalid json");
    assert.equal(await fetchOhlcv("2330", input.asOf, root), null);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
