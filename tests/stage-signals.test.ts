import assert from "node:assert/strict";
import test from "node:test";
import {
  computeStageSignals,
  parseCategoryMemberCounts,
} from "../scripts/refine-group-tasks.ts";

// ---------------------------------------------------------------------------
// Fixture taxonomy
// ---------------------------------------------------------------------------

const TAXONOMY = {
  categories: [
    { canonical: "被動元件", aliases: ["被動元件(MLCC/電感/石英)"] },
    { canonical: "光通訊", aliases: ["光通訊/CPO"] },
    { canonical: "矽晶圓/半導體基板", aliases: ["矽晶圓/晶圓代工"] },
    { canonical: "低軌衛星/微波通訊", aliases: [] },
  ],
};

// ---------------------------------------------------------------------------
// parseCategoryMemberCounts
// ---------------------------------------------------------------------------

const MEMORY_WITH_COUNTS = `---
date: 2026-06-11
---

## 強勢族群

- 被動元件(MLCC/電感/石英): 8檔 — 禾伸堂(3026)
- 光通訊: 3檔 — 上詮(3148)
- 矽晶圓/晶圓代工: 4檔 — 台勝科(3532)

## 弱勢族群

- 光通訊: 2檔 — 華星光(4979)
- 半導體封測: 6檔
`;

test("parseCategoryMemberCounts: strong counts resolved to canonical", () => {
  const result = parseCategoryMemberCounts(MEMORY_WITH_COUNTS, TAXONOMY);
  assert.equal(result.get("被動元件")?.strong, 8, "alias → canonical 被動元件 strong=8");
  assert.equal(result.get("光通訊")?.strong, 3, "光通訊 strong=3");
  assert.equal(result.get("矽晶圓/半導體基板")?.strong, 4, "alias → canonical 矽晶圓 strong=4");
});

test("parseCategoryMemberCounts: weak section parsed separately", () => {
  const result = parseCategoryMemberCounts(MEMORY_WITH_COUNTS, TAXONOMY);
  assert.equal(result.get("光通訊")?.weak, 2, "光通訊 also appears in weak with 2");
  // 半導體封測 is unknown in taxonomy — stored as-is
  assert.equal(result.get("半導體封測")?.weak, 6);
});

test("parseCategoryMemberCounts: returns empty map for missing sections", () => {
  const result = parseCategoryMemberCounts("## 盤後總結\n\nsome content", TAXONOMY);
  assert.equal(result.size, 0);
});

test("parseCategoryMemberCounts: 類別: prefix format", () => {
  const md = `## 強勢族群\n\n- 類別: 被動元件: 5檔 — some stock\n`;
  const result = parseCategoryMemberCounts(md, TAXONOMY);
  assert.equal(result.get("被動元件")?.strong, 5);
});

// ---------------------------------------------------------------------------
// Helpers to build minimal GroupTask fixtures
// ---------------------------------------------------------------------------

function makeTask(
  overrides: Partial<Parameters<typeof computeStageSignals>[0]> & {
    members?: Parameters<typeof computeStageSignals>[0]["members"];
  },
): Parameters<typeof computeStageSignals>[0] {
  return {
    tradingDate: "2026-06-12",
    timestamp: "2026/06/12",
    category: "被動元件",
    direction: "gainer",
    stocks: [],
    members: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeStageSignals: groupAvgPct
// ---------------------------------------------------------------------------

test("computeStageSignals: groupAvgPct is average of member pcts", () => {
  const task = makeTask({ members: [{ code: "A", name: "A", pct: 10 }, { code: "B", name: "B", pct: 6 }] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.groupAvgPct, 8);
});

test("computeStageSignals: groupAvgPct = 0 for empty members", () => {
  const task = makeTask({ members: [] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.groupAvgPct, 0);
});

// ---------------------------------------------------------------------------
// instNetDirection
// ---------------------------------------------------------------------------

test("computeStageSignals: instNetDirection=buy when all members net buy", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 5, chips: { foreignNet: 100, trustNet: 50, dealerNet: 10, totalNet: 160 } },
      { code: "B", name: "B", pct: 3, chips: { foreignNet: 200, trustNet: 0, dealerNet: 5, totalNet: 205 } },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.instNetDirection, "buy");
});

test("computeStageSignals: instNetDirection=sell when all net sell", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 5, chips: { foreignNet: -100, trustNet: -50, dealerNet: 0, totalNet: -150 } },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.instNetDirection, "sell");
});

test("computeStageSignals: instNetDirection=mixed when some buy some sell", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 5, chips: { foreignNet: 100, trustNet: 0, dealerNet: 0, totalNet: 100 } },
      { code: "B", name: "B", pct: 2, chips: { foreignNet: -200, trustNet: 0, dealerNet: 0, totalNet: -200 } },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.instNetDirection, "mixed");
});

test("computeStageSignals: instNetDirection=none when no chips data", () => {
  const task = makeTask({ members: [{ code: "A", name: "A", pct: 5 }] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.instNetDirection, "none");
});

// ---------------------------------------------------------------------------
// instVsPriceDivergence
// ---------------------------------------------------------------------------

test("computeStageSignals: divergence=true when price up but inst sell", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 5, chips: { foreignNet: -100, trustNet: -50, dealerNet: 0, totalNet: -150 } },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.groupAvgPct, 5);
  assert.equal(s.instNetDirection, "sell");
  assert.equal(s.instVsPriceDivergence, true);
});

test("computeStageSignals: divergence=true when price down but inst buy", () => {
  const task = makeTask({
    direction: "loser",
    members: [
      { code: "A", name: "A", pct: -3, chips: { foreignNet: 200, trustNet: 100, dealerNet: 0, totalNet: 300 } },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.instVsPriceDivergence, true);
});

test("computeStageSignals: divergence=false when price up and inst buy", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 5, chips: { foreignNet: 100, trustNet: 50, dealerNet: 0, totalNet: 150 } },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.instVsPriceDivergence, false);
});

// ---------------------------------------------------------------------------
// highDayTrade
// ---------------------------------------------------------------------------

test("computeStageSignals: highDayTrade=true when avgDayTradeRatio>=40", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 5, dayTradeRatio: 45 },
      { code: "B", name: "B", pct: 3, dayTradeRatio: 40 },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.avgDayTradeRatio, 42.5);
  assert.equal(s.highDayTrade, true);
});

test("computeStageSignals: highDayTrade=false when below 40", () => {
  const task = makeTask({
    members: [{ code: "A", name: "A", pct: 5, dayTradeRatio: 20 }],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.highDayTrade, false);
});

test("computeStageSignals: avgDayTradeRatio=null when no member has data", () => {
  const task = makeTask({ members: [{ code: "A", name: "A", pct: 5 }] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.avgDayTradeRatio, null);
  assert.equal(s.highDayTrade, false);
});

// ---------------------------------------------------------------------------
// leaderConcentration
// ---------------------------------------------------------------------------

test("computeStageSignals: leader-only when n<=2", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 9.9 },
      { code: "B", name: "B", pct: 5 },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.leaderConcentration, "leader-only");
});

test("computeStageSignals: broad when n>=4 and pcts are similar", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 7 },
      { code: "B", name: "B", pct: 6 },
      { code: "C", name: "C", pct: 6 },
      { code: "D", name: "D", pct: 5 },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.leaderConcentration, "broad");
});

test("computeStageSignals: leader-only when n>=4 but top pct dominates", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 9.9 },
      { code: "B", name: "B", pct: 2 },
      { code: "C", name: "C", pct: 2 },
      { code: "D", name: "D", pct: 2 },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.leaderConcentration, "leader-only");
});

// ---------------------------------------------------------------------------
// speculativeRatio
// ---------------------------------------------------------------------------

test("computeStageSignals: speculativeRatio counts flagged members", () => {
  const task = makeTask({
    members: [
      { code: "A", name: "A", pct: 5, flags: { lowLiquidity: true } },
      { code: "B", name: "B", pct: 3, flags: { disposition: true } },
      { code: "C", name: "C", pct: 2 }, // no flags
      { code: "D", name: "D", pct: 4, flags: { attention: true } },
    ],
  });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.speculativeRatio, 0.75); // 3 of 4
});

test("computeStageSignals: speculativeRatio=0 when no flags", () => {
  const task = makeTask({ members: [{ code: "A", name: "A", pct: 5 }] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.speculativeRatio, 0);
});

// ---------------------------------------------------------------------------
// consecutiveDaysInStrong
// ---------------------------------------------------------------------------

const MEM_DAY1 = `## 強勢族群\n\n- 被動元件(MLCC/電感/石英): 8檔 — 禾伸堂(3026)\n`;
const MEM_DAY2 = `## 強勢族群\n\n- 被動元件(MLCC/電感/石英): 6檔 — 禾伸堂(3026)\n- 光通訊: 3檔\n`;
const MEM_DAY3_NO_PASSIVE = `## 強勢族群\n\n- 光通訊: 3檔\n`;

test("computeStageSignals: consecutiveDaysInStrong=2 when last 2 mems contain category", () => {
  const task = makeTask({ category: "被動元件", members: [{ code: "A", name: "A", pct: 5 }] });
  // memoryMds oldest-first: day1 has it, day2 has it, day3 does not
  const s = computeStageSignals(task, [MEM_DAY3_NO_PASSIVE, MEM_DAY1, MEM_DAY2], TAXONOMY);
  // Trailing from most recent: day2=yes(1), day1=yes(2), day3_no_passive=no → stop → 2
  assert.equal(s.consecutiveDaysInStrong, 2);
});

test("computeStageSignals: consecutiveDaysInStrong=0 when most recent mem lacks category", () => {
  const task = makeTask({ category: "被動元件", members: [{ code: "A", name: "A", pct: 5 }] });
  const s = computeStageSignals(task, [MEM_DAY1, MEM_DAY3_NO_PASSIVE], TAXONOMY);
  // Most recent is MEM_DAY3_NO_PASSIVE which lacks 被動元件 → 0
  assert.equal(s.consecutiveDaysInStrong, 0);
});

test("computeStageSignals: consecutiveDaysInStrong=0 with no memory files", () => {
  const task = makeTask({ category: "被動元件", members: [{ code: "A", name: "A", pct: 5 }] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.consecutiveDaysInStrong, 0);
});

// ---------------------------------------------------------------------------
// memberCountDelta
// ---------------------------------------------------------------------------

test("computeStageSignals: memberCountDelta = today - last memory count", () => {
  const task = makeTask({
    category: "被動元件",
    members: [
      { code: "A", name: "A", pct: 5 },
      { code: "B", name: "B", pct: 3 },
      { code: "C", name: "C", pct: 2 },
      { code: "D", name: "D", pct: 4 },
    ],
  });
  // Last memory has 被動元件: 8檔 (via alias)
  const s = computeStageSignals(task, [MEM_DAY1], TAXONOMY);
  assert.equal(s.memberCountDelta, 4 - 8); // -4
});

test("computeStageSignals: memberCountDelta=null when category not in last memory", () => {
  const task = makeTask({
    category: "低軌衛星/微波通訊",
    members: [{ code: "A", name: "A", pct: 5 }],
  });
  const s = computeStageSignals(task, [MEM_DAY1], TAXONOMY);
  assert.equal(s.memberCountDelta, null);
});

test("computeStageSignals: memberCountDelta=null when no memory", () => {
  const task = makeTask({ members: [{ code: "A", name: "A", pct: 5 }] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.memberCountDelta, null);
});

// ---------------------------------------------------------------------------
// retreatSignal passthrough
// ---------------------------------------------------------------------------

test("computeStageSignals: retreatSignal=true propagated from task", () => {
  const task = makeTask({ retreatSignal: true, members: [{ code: "A", name: "A", pct: -3 }] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.retreatSignal, true);
});

test("computeStageSignals: retreatSignal=false when task has no retreatSignal", () => {
  const task = makeTask({ members: [{ code: "A", name: "A", pct: 5 }] });
  const s = computeStageSignals(task, [], TAXONOMY);
  assert.equal(s.retreatSignal, false);
});
