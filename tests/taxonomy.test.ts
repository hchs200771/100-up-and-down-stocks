import assert from "node:assert/strict";
import test from "node:test";
import {
  appendNewCategory,
  loadTaxonomy,
  normalizeCategory,
  stripSuffixes,
  type Taxonomy,
} from "../scripts/lib/taxonomy.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE: Taxonomy = {
  categories: [
    {
      canonical: "被動元件",
      aliases: [
        "被動元件(MLCC/電感/石英)",
        "被動元件/MLCC電阻電感與磁性材料",
        "被動元件（MLCC/電阻/電容/電感）",
      ],
    },
    {
      canonical: "低軌衛星/HDI高階PCB",
      aliases: ["AI伺服器/HDI高階PCB", "AI伺服器/HDI高階PCB與板廠"],
    },
    {
      canonical: "矽晶圓/半導體基板",
      aliases: ["矽晶圓/半導體材料", "矽晶圓/封測"],
    },
    {
      canonical: "DRAM/NAND記憶體模組與控制IC",
      aliases: ["DRAM/NAND記憶體模組與儲存通路"],
    },
  ],
};

// ---------------------------------------------------------------------------
// stripSuffixes
// ---------------------------------------------------------------------------

test("stripSuffixes removes (反轉) suffix", () => {
  assert.equal(stripSuffixes("被動元件(反轉)"), "被動元件");
});

test("stripSuffixes removes （回神） full-width suffix", () => {
  assert.equal(stripSuffixes("連接器（回神）"), "連接器");
});

test("stripSuffixes removes (分化) suffix", () => {
  assert.equal(stripSuffixes("LED/顯示模組(分化)"), "LED/顯示模組");
});

test("stripSuffixes leaves plain names untouched", () => {
  assert.equal(stripSuffixes("矽晶圓/半導體基板"), "矽晶圓/半導體基板");
});

// ---------------------------------------------------------------------------
// normalizeCategory — exact canonical match
// ---------------------------------------------------------------------------

test("normalizeCategory: exact canonical match", () => {
  const result = normalizeCategory("被動元件", FIXTURE);
  assert.equal(result.canonical, "被動元件");
  assert.equal(result.isNew, false);
});

// ---------------------------------------------------------------------------
// normalizeCategory — alias match
// ---------------------------------------------------------------------------

test("normalizeCategory: alias exact match", () => {
  const result = normalizeCategory("被動元件(MLCC/電感/石英)", FIXTURE);
  assert.equal(result.canonical, "被動元件");
  assert.equal(result.isNew, false);
});

test("normalizeCategory: alias match for HDI PCB", () => {
  const result = normalizeCategory("AI伺服器/HDI高階PCB與板廠", FIXTURE);
  assert.equal(result.canonical, "低軌衛星/HDI高階PCB");
  assert.equal(result.isNew, false);
});

// ---------------------------------------------------------------------------
// normalizeCategory — suffix stripping + normalized match
// ---------------------------------------------------------------------------

test("normalizeCategory: strips (反轉) then matches canonical", () => {
  const result = normalizeCategory("被動元件(反轉)", FIXTURE);
  assert.equal(result.canonical, "被動元件");
  assert.equal(result.isNew, false);
});

test("normalizeCategory: strips （弱勢端） then matches alias", () => {
  // "矽晶圓/封測" is an alias; stripping "（弱勢端）" from "矽晶圓/封測（弱勢端）" should resolve
  const result = normalizeCategory("矽晶圓/封測（弱勢端）", FIXTURE);
  assert.equal(result.canonical, "矽晶圓/半導體基板");
  assert.equal(result.isNew, false);
});

// ---------------------------------------------------------------------------
// normalizeCategory — full-width bracket normalization
// ---------------------------------------------------------------------------

test("normalizeCategory: full-width brackets in alias match", () => {
  // Fixture has "被動元件（MLCC/電阻/電容/電感）" (full-width brackets)
  // Query uses half-width: "被動元件(MLCC/電阻/電容/電感)"
  const result = normalizeCategory("被動元件(MLCC/電阻/電容/電感)", FIXTURE);
  assert.equal(result.canonical, "被動元件");
  assert.equal(result.isNew, false);
});

// ---------------------------------------------------------------------------
// normalizeCategory — new category
// ---------------------------------------------------------------------------

test("normalizeCategory: returns isNew=true for unknown category", () => {
  const result = normalizeCategory("量子運算/冷卻材料", FIXTURE);
  assert.equal(result.isNew, true);
  assert.equal(result.canonical, "量子運算/冷卻材料");
});

test("normalizeCategory: new category canonical is stripped version of raw", () => {
  const result = normalizeCategory("量子運算(反轉)", FIXTURE);
  assert.equal(result.isNew, true);
  assert.equal(result.canonical, "量子運算");
});

// ---------------------------------------------------------------------------
// appendNewCategory
// ---------------------------------------------------------------------------

test("appendNewCategory: adds new entry to taxonomy", () => {
  const tx: Taxonomy = { categories: [] };
  appendNewCategory(tx, "量子運算(反轉)", "量子運算");
  assert.equal(tx.categories.length, 1);
  assert.equal(tx.categories[0].canonical, "量子運算");
  assert.deepEqual(tx.categories[0].aliases, ["量子運算(反轉)"]);
});

test("appendNewCategory: does not duplicate if canonical already exists", () => {
  const tx: Taxonomy = {
    categories: [{ canonical: "量子運算", aliases: [] }],
  };
  appendNewCategory(tx, "量子運算", "量子運算");
  assert.equal(tx.categories.length, 1);
  assert.equal(tx.categories[0].aliases.length, 0);
});

test("appendNewCategory: appends raw alias when canonical exists but raw differs", () => {
  const tx: Taxonomy = {
    categories: [{ canonical: "量子運算", aliases: [] }],
  };
  appendNewCategory(tx, "量子運算(反轉)", "量子運算");
  assert.deepEqual(tx.categories[0].aliases, ["量子運算(反轉)"]);
});

// ---------------------------------------------------------------------------
// loadTaxonomy round-trip
// ---------------------------------------------------------------------------

test("loadTaxonomy reads and parses JSON file", () => {
  const dir = mkdtempSync(join(tmpdir(), "taxonomy-test-"));
  const path = join(dir, "taxonomy.json");
  writeFileSync(path, JSON.stringify(FIXTURE, null, 2), "utf8");

  const loaded = loadTaxonomy(path);
  assert.equal(loaded.categories.length, FIXTURE.categories.length);
  assert.equal(loaded.categories[0].canonical, "被動元件");

  rmSync(dir, { recursive: true });
});
