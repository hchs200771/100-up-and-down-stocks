import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { backAdjustCloses, buildBreadthHistory, computeBreadth } from "../scripts/build-breadth-history.ts";
import { parseRefPrices, refPricesOn } from "../scripts/lib/twse-closes.ts";

const twFields = ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差"];
const twRow = (code: string, close: string, sign: string, change: string) => [code, "測試", "", "", "", "", "", "", close, sign, change];
const twPayload = { tables: [{ fields: twFields, data: [twRow("2330", "100.50", '<p style= color:red>+</p>', "0.50")] }] };
const tpPayload = { tables: [{ fields: ["代號", "名稱", "收盤", "漲跌"], data: [["6488", "測試", "98.80", "-1.20"]] }] };

test("TWSE references parse HTML signs, zero change and commas; skip non-comparable and invalid rows", () => {
  const payload = { tables: [{ fields: twFields, data: [
    ...twPayload.tables[0].data,
    twRow("2317", "98.80", "<p>-</p>", "1.20"),
    twRow("2454", "1,000.00", " ", "0.00"),
    twRow("1111", "90", "X", "10"), twRow("2222", "90", "<p>Ｘ</p>", "10"),
    twRow("3333", "0", "+", "1"), twRow("4444", "100", "", "---"),
    twRow("5555", "100", "", "1"), twRow("006208", "100", "+", "1"),
  ] }] };
  assert.deepEqual(parseRefPrices(payload, "twse"), { "2330": 100, "2317": 100, "2454": 1000 });
  // Keep the endpoint's required code-first table selector, but reorder the numeric columns.
  const order = [0, 10, 9, 8, 1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(parseRefPrices({ tables: [{ fields: order.map(i => twFields[i]), data: payload.tables[0].data.map(r => order.map(i => r[i])) }] }, "twse"),
    parseRefPrices(payload, "twse"));
});

test("TPEx references locate fields and reject ex-dividend labels and placeholders", () => {
  const data = [["+0.50", "100.50", "6488"], ["-1.20", "98.80", "5347"], ["0.00", "100", "6666"],
    ["除息", "90", "1111"], ["---", "90", "2222"], ["", "90", "3333"], ["0", "0", "4444"]];
  assert.deepEqual(parseRefPrices({ tables: [{ fields: ["漲跌", "收盤", "代號"], data }] }, "tpex"),
    { "6488": 100, "5347": 100, "6666": 100 });
  assert.throws(() => parseRefPrices({ fields: ["代號", "名稱"], data: [["6488", "測試"]] }, "tpex"), /Missing tpex field/);
});

test("dividend adjustment scales only earlier closes and changes MA breadth", () => {
  const window = Array.from({ length: 60 }, (_, i) => ({ "2330": i === 59 ? 96 : 100, "6488": 100 }));
  const refs = Array.from({ length: 60 }, (_, i) => ({ "2330": i === 59 ? 95 : 100, "6488": 100 }));
  const adjusted = backAdjustCloses(window, refs);
  assert.equal(adjusted[0]!["2330"], 95);
  assert.equal(adjusted[58]!["2330"], 95);
  assert.equal(adjusted[59]!["2330"], 96);
  assert.ok(adjusted.every(p => p!["6488"] === 100));
  assert.equal(window[0]["2330"], 100, "input remains raw");
  assert.deepEqual(computeBreadth("2026-09-24", adjusted), { date: "2026-09-24", pctAboveMa60: 50, pctAboveMa20: 50, n: 2 });
  assert.equal(computeBreadth("2026-09-24", window)?.pctAboveMa60, 0);
});

test("adjustments compound backwards and ignore missing, tiny or out-of-range factors", () => {
  const window = [{ "2330": 100 }, { "2330": 96 }, { "2330": 87 }];
  const adjusted = backAdjustCloses(window, [null, { "2330": 95 }, { "2330": 86.4 }]);
  assert.ok(Math.abs(adjusted[0]!["2330"] - 85.5) < 1e-10);
  assert.ok(Math.abs(adjusted[1]!["2330"] - 86.4) < 1e-10);
  assert.equal(adjusted[2]!["2330"], 87);
  for (const ref of [undefined, 0, NaN, 30, 170, 100.04, 99.96]) {
    assert.deepEqual(backAdjustCloses(window.slice(0, 2), [null, ref === undefined ? null : { "2330": ref }]), window.slice(0, 2));
  }
  assert.ok(Math.abs(backAdjustCloses([{ "2330": 100 }, { "2330": 120 }], [null, { "2330": 110 }])[0]!["2330"] - 110) < 1e-10);
  assert.deepEqual(backAdjustCloses(window, []), window);
  assert.equal(computeBreadth("2026-09-24", [...Array(59).fill({ "2330": 100 }), null]), null);
});

test("refPricesOn caches complete markets only (mock fetch, no network)", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "breadth-ref-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let partial = false;
  globalThis.fetch = (async (url: string) => {
    calls++;
    return new Response(JSON.stringify(url.includes("twse.com.tw") ? twPayload : partial ? { tables: [] } : tpPayload));
  }) as typeof fetch;
  try {
    const refs = await refPricesOn("20260924", root);
    assert.deepEqual(refs, { "2330": 100, "6488": 100 });
    assert.deepEqual(JSON.parse(readFileSync(resolve(root, "data/cache/ref-20260924.json"), "utf8")), refs);
    await refPricesOn("20260924", root);
    assert.equal(calls, 2, "second read uses cache");
    partial = true;
    await assert.rejects(refPricesOn("20260925", root), /Incomplete reference prices/);
    assert.equal(existsSync(resolve(root, "data/cache/ref-20260925.json")), false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("--no-fetch builds from local refs and falls back on missing days without network", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "breadth-cli-"));
  const cwd = process.cwd(), argv = process.argv;
  const originalFetch = globalThis.fetch, originalWarn = console.warn;
  const warnings: string[] = [];
  let networkAttempts = 0;
  try {
    mkdirSync(resolve(root, "data/price-history"), { recursive: true });
    mkdirSync(resolve(root, "data/price-ref"));
    for (let i = 0; i < 60; i++) {
      const date = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
      writeFileSync(resolve(root, `data/price-history/${date}.json`), JSON.stringify({ "2330": i === 59 ? 96 : 100, "6488": 100 }));
      if (i === 59) writeFileSync(resolve(root, `data/price-ref/${date}.json`), JSON.stringify({ "2330": 95, "6488": 100 }));
    }
    process.chdir(root);
    process.argv = [...argv, "--no-fetch"];
    globalThis.fetch = (async () => { networkAttempts++; throw new Error("NETWORK ATTEMPT"); }) as typeof fetch;
    console.warn = message => warnings.push(String(message));
    await buildBreadthHistory();
    assert.equal(networkAttempts, 0);
    assert.ok(warnings.some(w => w.includes("unavailable; no adjustment for this day")));
    const history = JSON.parse(readFileSync(resolve(root, "data/breadth-history.json"), "utf8"));
    assert.equal(history.length, 1);
    assert.equal(history[0].pctAboveMa60, 50);
    assert.equal(history[0].pctAboveMa20, 50);
  } finally {
    process.chdir(cwd);
    process.argv = argv;
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
});
