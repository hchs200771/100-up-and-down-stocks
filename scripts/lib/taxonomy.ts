import { readFileSync, writeFileSync } from "node:fs";

export interface TaxonomyEntry {
  canonical: string;
  aliases: string[];
}

export interface Taxonomy {
  categories: TaxonomyEntry[];
}

export interface NormalizeResult {
  canonical: string;
  isNew: boolean;
}

/** Dynamic suffixes that should be stripped before matching */
const DYNAMIC_SUFFIX_RE = /[\(（][^)）]*(反轉|回神|分化|逆勢|弱勢端|修正|降溫|賣壓|調節|昨強今弱|跌深反彈|低基期反彈|续弱|部分续弱)[^)）]*[\)）]/g;

export function stripSuffixes(raw: string): string {
  return raw.replace(DYNAMIC_SUFFIX_RE, "").trim();
}

function normalizeStr(s: string): string {
  return s
    .replace(/\s+/g, "")            // remove whitespace
    .replace(/（/g, "(").replace(/）/g, ")")  // full-width brackets → half-width
    .toLowerCase();
}

export function loadTaxonomy(path: string): Taxonomy {
  const content = readFileSync(path, "utf8");
  return JSON.parse(content) as Taxonomy;
}

export function normalizeCategory(raw: string, taxonomy: Taxonomy): NormalizeResult {
  // 1. Exact match against canonical
  for (const entry of taxonomy.categories) {
    if (raw === entry.canonical) {
      return { canonical: entry.canonical, isNew: false };
    }
  }

  // 2. Exact match against aliases
  for (const entry of taxonomy.categories) {
    if (entry.aliases.includes(raw)) {
      return { canonical: entry.canonical, isNew: false };
    }
  }

  // 3. Normalized string match (strip suffixes + normalize)
  const stripped = stripSuffixes(raw);
  const normalizedRaw = normalizeStr(stripped);

  for (const entry of taxonomy.categories) {
    if (normalizeStr(entry.canonical) === normalizedRaw) {
      return { canonical: entry.canonical, isNew: false };
    }
    for (const alias of entry.aliases) {
      if (normalizeStr(stripSuffixes(alias)) === normalizedRaw) {
        return { canonical: entry.canonical, isNew: false };
      }
    }
  }

  // 4. No match — treat as new
  return { canonical: stripped || raw, isNew: true };
}

export function appendNewCategory(taxonomy: Taxonomy, rawName: string, canonicalName: string): void {
  // Check if canonical already exists (race condition guard)
  const existing = taxonomy.categories.find((e) => e.canonical === canonicalName);
  if (existing) {
    if (rawName !== canonicalName && !existing.aliases.includes(rawName)) {
      existing.aliases.push(rawName);
    }
    return;
  }
  const aliases = rawName !== canonicalName ? [rawName] : [];
  taxonomy.categories.push({ canonical: canonicalName, aliases });
}

export function saveTaxonomy(path: string, taxonomy: Taxonomy): void {
  writeFileSync(path, `${JSON.stringify(taxonomy, null, 2)}\n`, "utf8");
}
