import assert from "node:assert/strict";
import test from "node:test";
import { buildAudit, extractComparisonTables, extractMonthlyRows, summarizeRows } from "../scripts/audit-factor-evidence.ts";

test("extracts monthly returns from first matching table and skips headers", () => {
  const html = `<table><tr><th>月</th><th>策略</th><th>大盤</th><th>超額</th></tr><tr><td>2024-01</td><td>+2.00%</td><td>1.00%</td><td>1%</td></tr></table><table><tr><td>2025-01</td></tr></table>`;
  assert.deepEqual(extractMonthlyRows(html), [{ month: "2024-01", strategyPct: 2, benchmarkPct: 1, excessPct: 1 }]);
});

test("preserves absent return fields as null and excludes incomplete rows", () => {
  const rows = extractMonthlyRows(`<table><tr><th>月</th></tr><tr><td>2024-01</td><td>2%</td><td></td><td>1%</td></tr></table>`);
  assert.deepEqual(rows[0], { month: "2024-01", strategyPct: 2, benchmarkPct: null, excessPct: 1 });
  assert.equal(summarizeRows(rows).overall.count, 0);
  assert.equal(summarizeRows(rows).overall.meanMonthlyStrategyPct, null);
});

test("costs are percentage points deducted per month from strategy and excess", () => {
  const m = summarizeRows([{ month: "2024-01", strategyPct: 2, benchmarkPct: 1, excessPct: 1 }]);
  assert.deepEqual(m.costSensitivity.map((x) => x.costPctPoints), [0, 0.3, 0.585, 1]);
  assert.equal(m.costSensitivity[1].meanMonthlyNetStrategyPct, 1.7);
  assert.ok(Math.abs(m.costSensitivity[2].meanMonthlyNetExcessPct! - 0.415) < 1e-12);
  assert.equal(m.costSensitivity[3].meanMonthlyNetExcessPct, 0);
});

test("annualized IR is null when monthly excess has zero standard deviation", () => {
  const rows = ["2024-01", "2024-02", "2024-03"].map((month) => ({ month, strategyPct: 2, benchmarkPct: 1, excessPct: 1 }));
  assert.equal(summarizeRows(rows).overall.annualizedInformationRatio, null);
});

test("extracts all comparison tables as text without interpreting script text", () => {
  const tables = extractComparisonTables(`<script>window.x = '<table><tr><td>fake</td></tr></table>'</script><table><tr><th>A</th></tr><tr><td><b>2</b></td></tr></table>`);
  assert.deepEqual(tables, [[ ["A"], ["2"] ]]);
});

test("audit recomputes excess from strategy minus benchmark instead of trusting a published excess", () => {
  const result = buildAudit(`<table><tr><td>2024-01</td><td>2%</td><td>1%</td><td>9%</td></tr></table>`, {});
  assert.equal(result.monthlyRows[0].excessPct, 9);
  assert.equal(result.metrics.overall.meanMonthlyExcessPct, 1);
});

test("empty or duplicate monthly evidence cannot produce a successful audit", () => {
  assert.throws(() => buildAudit("<table></table>", {}), /No published/);
  const row = `<tr><td>2024-01</td><td>2%</td><td>1%</td><td>1%</td></tr>`;
  assert.throws(() => buildAudit(`<table>${row}${row}</table>`, {}), /Duplicate/);
});
