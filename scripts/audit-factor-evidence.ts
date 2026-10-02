#!/usr/bin/env npx tsx
/** Reproducible audit of published monthly strategy summaries (not a stock-level backtest). */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MonthlyRow { month: string; strategyPct: number | null; benchmarkPct: number | null; excessPct: number | null }
const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const parsePct = (s: string): number | null => {
  const m = s.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*%$/);
  return m ? Number(m[1]) : null;
};
const withoutScripts = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

/** Parses the first HTML table with YYYY-MM first-column data rows; absent cells remain null. */
export function extractMonthlyRows(html: string): MonthlyRow[] {
  const tables = [...withoutScripts(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  for (const table of tables) {
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1])));
    const monthly = rows.filter((r) => /^\d{4}-\d{2}$/.test(r[0] ?? ""));
    if (monthly.length) return monthly.map((r) => ({ month: r[0], strategyPct: parsePct(r[1] ?? ""), benchmarkPct: parsePct(r[2] ?? ""), excessPct: parsePct(r[3] ?? "") }));
  }
  return [];
}

/** Extract all comparison tables as plain-text cells; embedded scripts are never evaluated. */
export function extractComparisonTables(html: string): string[][][] {
  return [...withoutScripts(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((table) =>
    [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1]))));
}

function mean(xs: number[]): number | null { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function sampleSd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
export function summarizeRows(rows: MonthlyRow[]) {
  const complete = rows.filter((r) => r.strategyPct !== null && r.benchmarkPct !== null && r.excessPct !== null);
  const calc = (rs: MonthlyRow[]) => {
    const strat = rs.map((r) => r.strategyPct!); const excess = rs.map((r) => r.excessPct!);
    const avgExcess = mean(excess); const sd = sampleSd(excess);
    return { count: rs.length, meanMonthlyStrategyPct: mean(strat), meanMonthlyExcessPct: avgExcess,
      strategyWinRatePct: rs.length ? 100 * strat.filter((x) => x > 0).length / rs.length : null,
      excessWinRatePct: rs.length ? 100 * excess.filter((x) => x > 0).length / rs.length : null,
      sampleSdMonthlyExcessPct: sd, annualizedInformationRatio: sd && avgExcess !== null ? avgExcess / sd * Math.sqrt(12) : null };
  };
  const costs = [0, 0.3, 0.585, 1.0].map((costPctPoints) => ({ costPctPoints, meanMonthlyNetStrategyPct: mean(complete.map((r) => r.strategyPct! - costPctPoints)), meanMonthlyNetExcessPct: mean(complete.map((r) => r.excessPct! - costPctPoints)), netExcessWinRatePct: complete.length ? 100 * complete.filter((r) => r.excessPct! - costPctPoints > 0).length / complete.length : null }));
  return { overall: calc(complete), periods: { through2023_12: calc(complete.filter((r) => r.month <= "2023-12")), from2024_01: calc(complete.filter((r) => r.month >= "2024-01")) }, costSensitivity: costs };
}

function inventory(dir: string) {
  if (!existsSync(dir)) return { path: dir, exists: false, fileCount: 0, dateRange: null as { first: string; last: string } | null };
  const allFiles = readdirSync(dir, { withFileTypes: true }).filter((x) => x.isFile()).map((x) => x.name);
  const files = allFiles.filter((name) => !name.startsWith(".") && name.endsWith(".json"));
  const dates = files.map((f) => f.match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/)?.slice(1).join("-")).filter((x): x is string => Boolean(x)).sort();
  return { path: dir, exists: true, fileCount: files.length, ignoredFileCount: allFiles.length - files.length, dateRange: dates.length ? { first: dates[0], last: dates.at(-1)! } : null };
}
export function buildAudit(html: string, inventories: Record<string, ReturnType<typeof inventory>>) {
  const rows = extractMonthlyRows(html);
  if (!rows.length) throw new Error("No published monthly return rows found; cannot audit an empty table");
  if (new Set(rows.map((row) => row.month)).size !== rows.length) {
    throw new Error("Duplicate published monthly return rows");
  }
  const derived = rows.map((r) => ({ ...r, recomputedExcessPct: r.strategyPct !== null && r.benchmarkPct !== null ? r.strategyPct - r.benchmarkPct : null }));
  const metricsRows = derived.map((r) => ({ ...r, excessPct: r.recomputedExcessPct }));
  return { generatedAt: new Date().toISOString(), evidenceType: "published_summary_reanalysis_only", newRevenueBaselineFilterBacktest: "blocked_missing_point_in_time_inputs", limitation: "Raw revenue baseline data and source backtest script are absent; results below reanalyze the published monthly summary only. Daily pick-filter experiments are separate and do not test the revenue baseline. Cost sensitivity deducts the stated cost from strategy only, assumes monthly full turnover, and applies no benchmark costs. Arithmetic monthly returns are not compounded CAGR.", source: "data/site/revenue.html", monthlyRows: derived, metrics: summarizeRows(metricsRows), comparisonTables: extractComparisonTables(html), inventories };
}

export function main() {
  const root = resolve(process.cwd()); const html = readFileSync(resolve(root, "data/site/revenue.html"), "utf8");
  const dirs = ["data/price-history", "data/price-history-open", "data/factor-panel", "data/stock-picks-history", "data/tdcc-history", "data/cb-pledge-history"];
  const audit = buildAudit(html, Object.fromEntries(dirs.map((d) => [d, inventory(resolve(root, d))])));
  const output = resolve(root, "data/backtest/factor-evidence-audit.json"); mkdirSync(resolve(root, "data/backtest"), { recursive: true }); writeFileSync(output, `${JSON.stringify(audit, null, 2)}\n`);
  console.log(JSON.stringify({ output: "data/backtest/factor-evidence-audit.json", status: audit.newRevenueBaselineFilterBacktest, metrics: audit.metrics }, null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
