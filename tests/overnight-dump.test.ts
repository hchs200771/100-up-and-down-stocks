import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectOvernightDump,
  findPrevTwoTradingDates,
  updateTally,
} from "../scripts/refine-group-tasks.ts";

// ---------------------------------------------------------------------------
// detectOvernightDump
// ---------------------------------------------------------------------------

const baseMember = {
  code: "1234",
  name: "測試股",
  pct: -1,
  dayTradeRatio: 40,
};

test("detectOvernightDump: fires when all three conditions met", () => {
  assert.equal(detectOvernightDump({ ...baseMember }, 109.5, 100), true);
});

test("detectOvernightDump: limit-up boundary exactly 9.5% → true", () => {
  // (109.5 - 100) / 100 * 100 = 9.5
  assert.equal(detectOvernightDump({ ...baseMember }, 109.5, 100), true);
});

test("detectOvernightDump: limit-up below 9.5% → false", () => {
  // (109.4 - 100) / 100 * 100 = 9.4
  assert.equal(detectOvernightDump({ ...baseMember }, 109.4, 100), false);
});

test("detectOvernightDump: dayTradeRatio exactly 40 → true", () => {
  assert.equal(detectOvernightDump({ ...baseMember, dayTradeRatio: 40 }, 109.5, 100), true);
});

test("detectOvernightDump: dayTradeRatio 39.9 → false", () => {
  assert.equal(detectOvernightDump({ ...baseMember, dayTradeRatio: 39.9 }, 109.5, 100), false);
});

test("detectOvernightDump: dayTradeRatio undefined → false", () => {
  const m = { code: "1234", name: "測試股", pct: -1 };
  assert.equal(detectOvernightDump(m, 109.5, 100), false);
});

test("detectOvernightDump: pct = 0 (not negative) → false", () => {
  assert.equal(detectOvernightDump({ ...baseMember, pct: 0 }, 109.5, 100), false);
});

test("detectOvernightDump: pct = -0.1 → true (all conditions met)", () => {
  assert.equal(detectOvernightDump({ ...baseMember, pct: -0.1 }, 109.5, 100), true);
});

test("detectOvernightDump: prevDayClose undefined → false", () => {
  assert.equal(detectOvernightDump({ ...baseMember }, undefined, 100), false);
});

test("detectOvernightDump: prevPrevDayClose undefined → false", () => {
  assert.equal(detectOvernightDump({ ...baseMember }, 109.5, undefined), false);
});

test("detectOvernightDump: prevPrevDayClose = 0 → false (div-by-zero guard)", () => {
  assert.equal(detectOvernightDump({ ...baseMember }, 109.5, 0), false);
});

// ---------------------------------------------------------------------------
// findPrevTwoTradingDates
// ---------------------------------------------------------------------------

function makePriceHistoryDir(dates: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ph-"));
  for (const d of dates) {
    writeFileSync(join(dir, `${d}.json`), "{}");
  }
  return dir;
}

test("findPrevTwoTradingDates: returns two dates before tradingDate", () => {
  const dir = makePriceHistoryDir(["2026-06-10", "2026-06-11", "2026-06-12"]);
  const result = findPrevTwoTradingDates(dir, "2026-06-12");
  assert.deepEqual(result, ["2026-06-10", "2026-06-11"]);
});

test("findPrevTwoTradingDates: only 1 date before → null", () => {
  const dir = makePriceHistoryDir(["2026-06-11", "2026-06-12"]);
  const result = findPrevTwoTradingDates(dir, "2026-06-12");
  assert.equal(result, null);
});

test("findPrevTwoTradingDates: no dates before → null", () => {
  const dir = makePriceHistoryDir(["2026-06-12"]);
  const result = findPrevTwoTradingDates(dir, "2026-06-12");
  assert.equal(result, null);
});

test("findPrevTwoTradingDates: non-existent dir → null", () => {
  const result = findPrevTwoTradingDates("/tmp/no-such-ph-dir-xyz", "2026-06-12");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// updateTally
// ---------------------------------------------------------------------------

test("updateTally: first occurrence sets count=1", () => {
  const tally = updateTally({}, "1234", "2026-06-12");
  assert.deepEqual(tally["1234"], { count: 1, lastDate: "2026-06-12", dates: ["2026-06-12"] });
});

test("updateTally: idempotent — same date does not double-count", () => {
  let tally = updateTally({}, "1234", "2026-06-12");
  tally = updateTally(tally, "1234", "2026-06-12");
  assert.equal(tally["1234"].count, 1);
  assert.equal(tally["1234"].dates.length, 1);
});

test("updateTally: different date increments count", () => {
  let tally = updateTally({}, "1234", "2026-06-11");
  tally = updateTally(tally, "1234", "2026-06-12");
  assert.equal(tally["1234"].count, 2);
  assert.equal(tally["1234"].lastDate, "2026-06-12");
  assert.deepEqual(tally["1234"].dates, ["2026-06-11", "2026-06-12"]);
});

test("updateTally: count >= 2 after two different dates (triggers repeat)", () => {
  let tally = updateTally({}, "1234", "2026-06-10");
  tally = updateTally(tally, "1234", "2026-06-12");
  assert.equal(tally["1234"].count >= 2, true);
});
