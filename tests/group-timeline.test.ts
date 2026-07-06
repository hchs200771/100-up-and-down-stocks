import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroupTimeline,
  consecutiveStrongDays,
  mechanicalStage,
} from "../scripts/lib/group-timeline.ts";

const TAXONOMY = {
  categories: [
    { canonical: "被動元件", aliases: ["被動元件(MLCC/電感/石英)"] },
    { canonical: "光通訊", aliases: [] },
  ],
};

const SNAPSHOTS = [
  {
    date: "2026-06-29",
    gainers: [{ category: "被動元件(MLCC/電感/石英)" }, { category: "光通訊" }],
    losers: [],
  },
  {
    date: "2026-06-30",
    gainers: [{ category: "被動元件" }],
    losers: [{ category: "光通訊" }],
  },
  {
    date: "2026-07-01",
    gainers: [{ category: "被動元件" }, { category: "光通訊" }],
    losers: [],
  },
];

const DATES = ["2026-06-29", "2026-06-30", "2026-07-01"];

test("buildGroupTimeline resolves aliases to canonical and collects dates", () => {
  const tl = buildGroupTimeline(SNAPSHOTS, TAXONOMY);
  assert.deepEqual(tl.get("被動元件")?.strongDates, DATES);
  assert.deepEqual(tl.get("光通訊")?.strongDates, ["2026-06-29", "2026-07-01"]);
  assert.deepEqual(tl.get("光通訊")?.weakDates, ["2026-06-30"]);
});

test("consecutiveStrongDays counts trailing streak ending at baseDate", () => {
  assert.equal(consecutiveStrongDays(DATES, DATES, "2026-07-01"), 3);
  assert.equal(consecutiveStrongDays(["2026-06-29", "2026-07-01"], DATES, "2026-07-01"), 1);
  assert.equal(consecutiveStrongDays(["2026-06-29"], DATES, "2026-07-01"), 0);
  assert.equal(consecutiveStrongDays(DATES, DATES, "unknown-date"), 0);
});

test("mechanicalStage labels streaks", () => {
  assert.equal(mechanicalStage(DATES, DATES, "2026-07-01"), "連3日+");
  assert.equal(mechanicalStage(["2026-06-30", "2026-07-01"], DATES, "2026-07-01"), "連2日");
  // first-ever appearance
  assert.equal(mechanicalStage(["2026-07-01"], DATES, "2026-07-01"), "連1日");
  // reappearance after a gap within lookback → 回歸
  assert.equal(mechanicalStage(["2026-06-29", "2026-07-01"], DATES, "2026-07-01"), "回歸");
  // not in strong list that day
  assert.equal(mechanicalStage(["2026-06-29"], DATES, "2026-07-01"), null);
});
