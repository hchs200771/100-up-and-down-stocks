import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStrongCategoriesFromMemory,
  applyRetreatSignals,
  enrichMembersFromMarket,
} from "../scripts/refine-group-tasks.ts";

// ---------------------------------------------------------------------------
// Fixture taxonomy (minimal)
// ---------------------------------------------------------------------------

const TAXONOMY = {
  categories: [
    { canonical: "被動元件", aliases: ["被動元件(MLCC/電感/石英)", "被動元件(MLCC/電容/電阻/石英)"] },
    { canonical: "光通訊", aliases: ["光通訊/CPO"] },
    { canonical: "矽晶圓/半導體基板", aliases: ["矽晶圓/晶圓代工"] },
  ],
};

// ---------------------------------------------------------------------------
// parseStrongCategoriesFromMemory
// ---------------------------------------------------------------------------

const SAMPLE_MEMORY = `---
date: 2026-06-11
timestamp: 2026/06/11
---

## 盤後總結

some summary

## 強勢族群

- 類別: 被動元件: 8檔 — 禾伸堂(3026)
- 類別: 光通訊: 3檔 — 上詮(3148)
- 類別: 自行車: 2檔 — 巨大(9921)

## 弱勢族群

- 類別: 半導體封測: 6檔
`;

// Memory format used in real files (without "類別:" prefix)
const REAL_FORMAT_MEMORY = `---
date: 2026-06-11
timestamp: 2026/06/11
---

## 盤後總結

some summary

## 強勢族群

- 被動元件(MLCC/電感/石英): 8檔 — 禾伸堂(3026)
- 光通訊: 3檔 — 上詮(3148)
- 矽晶圓/晶圓代工: 2檔 — 台勝科(3532)

## 弱勢族群

- 半導體封測: 6檔
`;

test("parseStrongCategoriesFromMemory: parses 類別: prefix format", () => {
  const result = parseStrongCategoriesFromMemory(SAMPLE_MEMORY, TAXONOMY);
  assert.ok(result.has("被動元件"), "should contain 被動元件 (canonical)");
  assert.ok(result.has("光通訊"), "should contain 光通訊");
  assert.ok(!result.has("半導體封測"), "should NOT contain weak category");
});

test("parseStrongCategoriesFromMemory: parses real format (dash-line format)", () => {
  const result = parseStrongCategoriesFromMemory(REAL_FORMAT_MEMORY, TAXONOMY);
  assert.ok(result.has("被動元件"), "alias 被動元件(MLCC/電感/石英) → canonical 被動元件");
  assert.ok(result.has("光通訊"), "exact canonical 光通訊");
  assert.ok(result.has("矽晶圓/半導體基板"), "alias 矽晶圓/晶圓代工 → canonical 矽晶圓/半導體基板");
});

test("parseStrongCategoriesFromMemory: returns empty set for memory without 強勢族群 section", () => {
  const result = parseStrongCategoriesFromMemory("## 盤後總結\n\nsome content", TAXONOMY);
  assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// applyRetreatSignals
// ---------------------------------------------------------------------------

test("applyRetreatSignals: marks loser task that was recently strong", () => {
  const tasks: Parameters<typeof applyRetreatSignals>[0] = [
    { direction: "loser", category: "被動元件", tradingDate: "2026-06-12", timestamp: "2026/06/12", stocks: [], members: [] },
    { direction: "loser", category: "光通訊", tradingDate: "2026-06-12", timestamp: "2026/06/12", stocks: [], members: [] },
    { direction: "gainer", category: "被動元件", tradingDate: "2026-06-12", timestamp: "2026/06/12", stocks: [], members: [] },
  ];
  const recentStrong = [new Set(["被動元件"])];
  applyRetreatSignals(tasks, recentStrong);
  assert.equal(tasks[0].retreatSignal, true, "loser 被動元件 should be marked");
  assert.equal(tasks[1].retreatSignal, undefined, "loser 光通訊 should NOT be marked");
  assert.equal(tasks[2].retreatSignal, undefined, "gainer should never be marked");
});

test("applyRetreatSignals: no marks when recentStrong is empty", () => {
  const tasks: Parameters<typeof applyRetreatSignals>[0] = [
    { direction: "loser", category: "被動元件", tradingDate: "2026-06-12", timestamp: "2026/06/12", stocks: [], members: [] },
  ];
  applyRetreatSignals(tasks, []);
  assert.equal(tasks[0].retreatSignal, undefined);
});

// ---------------------------------------------------------------------------
// enrichMembersFromMarket
// ---------------------------------------------------------------------------

test("enrichMembersFromMarket: attaches chips/dayTradeRatio/flags to matching member", () => {
  const tasks: Parameters<typeof enrichMembersFromMarket>[0] = [
    {
      direction: "gainer",
      category: "被動元件",
      tradingDate: "2026-06-12",
      timestamp: "2026/06/12",
      stocks: [],
      members: [{ code: "2408", name: "南亞科", pct: 10 }],
    },
  ];
  const marketByCode = new Map([
    [
      "2408",
      {
        code: "2408",
        name: "南亞科",
        pct: 10,
        chips: { foreignNet: 25213, trustNet: 944, dealerNet: 1632, totalNet: 27789 },
        dayTradeRatio: 41.4,
        flags: undefined,
      },
    ],
  ]);
  enrichMembersFromMarket(tasks, marketByCode);
  const member = tasks[0].members[0];
  assert.deepEqual(member.chips, { foreignNet: 25213, trustNet: 944, dealerNet: 1632, totalNet: 27789 });
  assert.equal(member.dayTradeRatio, 41.4);
});

test("enrichMembersFromMarket: leaves member unchanged if no market entry", () => {
  const tasks: Parameters<typeof enrichMembersFromMarket>[0] = [
    {
      direction: "gainer",
      category: "測試",
      tradingDate: "2026-06-12",
      timestamp: "2026/06/12",
      stocks: [],
      members: [{ code: "9999", name: "未知股", pct: 5 }],
    },
  ];
  enrichMembersFromMarket(tasks, new Map());
  const member = tasks[0].members[0];
  assert.equal(member.chips, undefined);
  assert.equal(member.dayTradeRatio, undefined);
});

test("enrichMembersFromMarket: attaches flags (disposition)", () => {
  const tasks: Parameters<typeof enrichMembersFromMarket>[0] = [
    {
      direction: "gainer",
      category: "其他",
      tradingDate: "2026-06-12",
      timestamp: "2026/06/12",
      stocks: [],
      members: [{ code: "2302", name: "麗正", pct: 10 }],
    },
  ];
  const marketByCode = new Map([
    [
      "2302",
      {
        code: "2302",
        name: "麗正",
        pct: 10,
        chips: { foreignNet: 64, trustNet: 0, dealerNet: 34, totalNet: 98 },
        flags: { disposition: true },
      },
    ],
  ]);
  enrichMembersFromMarket(tasks, marketByCode);
  assert.deepEqual(tasks[0].members[0].flags, { disposition: true });
});
