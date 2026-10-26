import assert from "node:assert/strict";
import test from "node:test";

import { parseBcdData, parseBrokerList, normalizeBrokerName, isTriggered, mergeHistory } from "../scripts/fetch-broker-watch.ts";

test("parseBcdData: 解析日期、收盤、買賣超，跨年的月日歸到去年", () => {
  const html = `GetBcdData('1230,0102 50,51.5 -12,400');`;
  assert.deepEqual(parseBcdData(html, "2027-01-02"), [
    { date: "2026-12-30", close: 50, net: -12 },
    { date: "2027-01-02", close: 51.5, net: 400 },
  ]);
});

test("parseBcdData: 無資料或找不到回傳空陣列", () => {
  assert.deepEqual(parseBcdData(`GetBcdData('無資料')`, "2026-09-29"), []);
  assert.deepEqual(parseBcdData("<html></html>", "2026-09-29"), []);
});

test("parseBrokerList: 以代號或名稱都能找到分點，並帶出總公司代號", () => {
  const js = `var g_BrokerList = '9600,富邦!9600,富邦!9658,富邦-建國;6160,中國信託!6160,中國信託!6161,中國信託-三重';`;
  const map = parseBrokerList(js);
  assert.equal(map.get("9658")?.hq, "9600");
  assert.equal(map.get(normalizeBrokerName("富邦建國"))?.code, "9658");
  assert.equal(map.get(normalizeBrokerName("中國信託（總公司）"))?.code, "6160");
});

test("isTriggered: 依方向判斷門檻", () => {
  assert.equal(isTriggered(400, 400, "雙向"), true);
  assert.equal(isTriggered(-401, 400, "雙向"), true);
  assert.equal(isTriggered(-500, 400, "買超"), false);
  assert.equal(isTriggered(-500, 400, "賣超"), true);
  assert.equal(isTriggered(999, 0, "雙向"), false);
});

test("mergeHistory: 同日以新資料覆蓋並排序", () => {
  const merged = mergeHistory(
    [{ date: "2026-09-02", close: 1, net: 1 }, { date: "2026-09-01", close: 1, net: 1 }],
    [{ date: "2026-09-02", close: 2, net: 5 }],
  );
  assert.deepEqual(merged.map((d) => [d.date, d.net]), [["2026-09-01", 1], ["2026-09-02", 5]]);
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { withRecent5, withMa10, triggeredPairs, renderHtml, type ReportItem } from "../scripts/fetch-broker-watch.ts";

const pair = (stockCode: string, direction: ReportItem["direction"] = "雙向"): ReportItem => ({
  pageId: stockCode, title: stockCode, stockCode, stockName: stockCode, broker: "測試分點",
  brokerCode: "0035003800350051", brokerHq: "5850", threshold: 100, direction, grade: "A",
  note: '<備註 & "內容">', lastTriggerDate: "", lastTriggerNet: null, status: "stale",
});

test("MA10: shared ten-session window, above/below/equal chips, table and missing stock data", async () => {
  const calls: string[] = [];
  // Sufficient market breadth for isTradingDay; all prices are injected, including holidays.
  const market = Object.fromEntries(Array.from({ length: 501 }, (_, n) => [`market${n}`, 1]));
  const lookup = (date: string) => {
    calls.push(date);
    if (["20270101", "20270102", "20270103", "20261225", "20261226", "20261227"].includes(date)) return {};
    return { ...market, above: date === "20270108" ? 110 : 100,
      below: date === "20270108" ? 90 : 100, equal: 100,
      ...(date === "20270107" ? {} : { missing: 100 }) };
  };
  const hit = (code: string): ReportItem => ({ ...pair(code), triggered5: true, recent5: [{ date: "2027-01-08", net: 100 }] });
  const input = { tradingDate: "2027-01-08", notion: false, items: [
    hit("above"), hit("below"), hit("missing"), pair("equal"), pair("above"),
  ] };
  const report = await withMa10(input, lookup);
  assert.equal(new Set(calls).size, calls.length);
  assert.equal(calls.at(-1), "20261224");
  assert.deepEqual(report.items.slice(0, 2).map((i) => [i.close, i.ma10, i.aboveMa10, i.ma10Pct]), [
    [110, 101, true, 8.9], [90, 99, false, -9.1],
  ]);
  assert.equal(report.items[4].ma10, report.items[0].ma10);
  assert.equal(report.items[2].ma10, undefined);
  assert.equal(input.items[0].ma10, undefined);
  const doc = new JSDOM(renderHtml(report)).window.document;
  assert.deepEqual([...doc.querySelectorAll(".stock-header .ma10")].map((n) => n.textContent), ["10日線上 +8.9%", "10日線下 -9.1%"]);
  assert.equal(doc.querySelector(".stock-header .ma10.pos")?.getAttribute("title"), "收盤 110／10 日均 101");
  assert.equal(doc.querySelectorAll(".stock-header .ma10.neg").length, 1);
  assert.equal(doc.querySelectorAll(".stock-group")[2].querySelector(".ma10"), null);
  assert.deepEqual([...doc.querySelectorAll(".others .ma10")].map((n) => n.textContent), ["上 +8.9%", "上 +0.0%"]);
  assert.equal(doc.querySelector(".others th:last-child")?.textContent, "10日線");
  const row = doc.querySelector(".watch-row")!;
  assert.deepEqual([...row.children].map((n) => n.getAttribute("class")), ["broker", "row-main", "row-note", "bars"]);
  assert.ok(row.querySelector(".row-main > .meta"));
  assert.ok(row.querySelector(".row-main > .latest-trigger"));
});

test("MA10: unknown dates, failed lookup and absent report-day closes clear stale indicators", async () => {
  const stale = { ...pair("stock"), close: 110, ma10: 100, aboveMa10: true, ma10Pct: 10 };
  const input = { tradingDate: "2027-01-08", notion: false, items: [stale] };
  for (const lookup of [() => undefined, () => ({}), () => { throw new Error("offline"); }]) {
    const report = await withMa10(input, lookup);
    assert.equal(report.items[0].ma10, undefined);
    assert.equal(report.items[0].aboveMa10, undefined);
    assert.equal(new JSDOM(renderHtml(report)).window.document.querySelector(".ma10"), null);
  }
});

test("recent5: shared trading dates, zero filling, holidays/year boundary, inclusive direction thresholds and future exclusion", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-watch-"));
  try {
    const calendar = ["2026-12-24", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-04", "2027-01-05"];
    writeFileSync(join(dir, "calendar.json"), JSON.stringify({ days: calendar.map((date) => ({ date, net: 0 })) }));
    const sparse = pair("sparse");
    writeFileSync(join(dir, `${sparse.stockCode}-${sparse.brokerCode}.json`), JSON.stringify({ days: [
      { date: "2026-12-24", net: 900 }, // sixth trading day: excluded
      { date: "2026-12-29", net: -100 },
      { date: "2027-01-05", net: 9999 }, // after report date: excluded
    ] }));
    const buy = { ...pair("buy", "買超"), recent: [{ date: "2027-01-04", net: -900, close: 1 }] };
    const sell = { ...pair("sell", "賣超"), recent: [{ date: "2027-01-04", net: -100, close: 1 }] };
    const disabled = { ...sell, stockCode: "disabled", threshold: 0 };
    const report = withRecent5({ tradingDate: "2027-01-04", notion: false, items: [sparse, buy, sell, disabled] }, dir);
    assert.deepEqual(report.items[0].recent5, [
      { date: "2026-12-28", net: 0 }, { date: "2026-12-29", net: -100 },
      { date: "2026-12-30", net: 0 }, { date: "2026-12-31", net: 0 }, { date: "2027-01-04", net: 0 },
    ]);
    assert.equal(report.items[0].recent5?.length, 5);
    assert.deepEqual(report.items.map((i) => i.triggered5), [true, false, true, false]);
    assert.equal(report.items[0].recent5?.at(-1)?.date, "2027-01-04");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("triggered stock groups: compact rows, collapsed table, SVG axes, links, tooltips and escaping", () => {
  const item = (name: string, date: string, net: number): ReportItem => ({
    ...pair(name), triggered5: true, recent5: [
      { date: "2026-12-28", net: 0 }, { date: "2026-12-29", net: 0 },
      { date: "2026-12-30", net: 0 }, { date: "2026-12-31", net: 0 }, { date: "2027-01-04", net: 0 },
    ].map((d) => d.date === date ? { ...d, net } : d),
  });
  const items = [item("older", "2026-12-31", 900), item("smaller", "2027-01-04", -100), item("larger", "2027-01-04", 200), pair("quiet")];
  assert.deepEqual(triggeredPairs(items).map((i) => i.stockCode), ["larger", "smaller", "older"]);
  const dom = new JSDOM(renderHtml({ tradingDate: "2027-01-04", notion: false, items }), { runScripts: "dangerously" });
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll("article.stock-group").length, 3);
  assert.equal(doc.querySelector("details.others")?.hasAttribute("open"), false);
  assert.match(doc.querySelector("details.others summary")!.textContent!, /其餘 1 組/);
  assert.equal(doc.querySelectorAll("details.others table tr").length, 2);
  const card = doc.querySelector("article")!;
  assert.equal(card.querySelectorAll("svg rect.bar").length, 5);
  assert.equal(card.querySelectorAll("svg .threshold").length, 2);
  assert.match(card.querySelector("svg")!.textContent!, /01\/04/);
  assert.match(card.querySelector("svg")!.textContent!, /張/);
  assert.equal(card.querySelector(".row-note")!.textContent, '備註：<備註 & "內容">');
  assert.equal(card.querySelector(".row-note")!.getAttribute("title"), '<備註 & "內容">');
  assert.equal(card.querySelectorAll(".watch-row").length, 1);
  assert.equal(card.querySelectorAll(".geo-reason").length, 0);
  assert.doesNotMatch(card.querySelector(".meta")!.textContent!, /雙向/);
  assert.doesNotMatch(doc.querySelector("details.others td:nth-child(6)")!.textContent!, /雙向/);
  assert.equal(doc.querySelector("details.others .broker-type")!.textContent, "分點");
  assert.equal(card.querySelector("svg")!.getAttribute("viewBox"), "0 0 210 106");
  const bars = [...card.querySelectorAll("[data-tip]")];
  assert.equal(bars.length, 5);
  assert.ok(bars.every((bar) => bar.getAttribute("height") === "70" && bar.querySelector("title")));
  const tooltip = doc.querySelector<HTMLElement>(".bar-tooltip")!;
  bars[4].dispatchEvent(new dom.window.MouseEvent("pointerenter", { clientX: 100, clientY: 100 }));
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, "01/04 買超 +200 張");
  bars[4].dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 120, clientY: 110 }));
  assert.equal(tooltip.style.left, "130px");
  bars[4].dispatchEvent(new dom.window.MouseEvent("pointerleave"));
  assert.equal(tooltip.hidden, true);
  bars[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, "12/28 0 張");
  bars[0].dispatchEvent(new dom.window.MouseEvent("pointerleave"));
  assert.equal(tooltip.hidden, false);
  bars[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(tooltip.hidden, true);
  const links = [card.querySelector(".broker a")!, card.querySelector(".stock-header > a")!] as HTMLAnchorElement[];
  assert.equal(links.length, 2);
  assert.ok(links.every((a) => a.target === "_blank"));
  assert.equal(new URL(links[0].href).searchParams.get("b"), "0035003800350051");
  assert.match(links[1].href, /zco\.djhtm\?a=larger/);

  const groupedItems: ReportItem[] = [
    { ...item("mixed", "2027-01-04", 300), broker: "最新分點", geo: "未知" },
    { ...item("mixed", "2026-12-31", 900), broker: "舊地緣", geo: "地緣", geoReason: '<在地 "理由">' },
    { ...item("local", "2027-01-04", -200), brokerCode: "5850", geo: "地緣", direction: "賣超" },
    { ...item("circle", "2027-01-04", 999), geo: "同生活圈" },
    { ...item("older", "2026-12-31", 9999), geo: "地緣" },
    { ...pair("hq"), broker: "總行", brokerHq: undefined },
    { ...pair("branch"), broker: "總行-分行", brokerHq: undefined, direction: "買超" },
  ];
  const grouped = new JSDOM(renderHtml({ tradingDate: "2027-01-04", notion: false, items: groupedItems })).window.document;
  const groups = [...grouped.querySelectorAll(".stock-group")];
  assert.deepEqual(groups.map((g) => g.querySelector("h2")!.textContent), ["mixed mixed", "circle circle", "older older", "local local"]);
  assert.deepEqual([...groups[0].querySelectorAll(".broker a")].map((a) => a.textContent), ["最新分點", "舊地緣"]);
  assert.equal(groups[0].querySelector(".geo-local")!.getAttribute("title"), '<在地 "理由">');
  assert.equal(groups[3].querySelector(".broker-type")!.textContent, "總公司");
  assert.match(groups[3].querySelector(".meta")!.textContent!, /賣超/);
  assert.equal(groups[3].querySelectorAll(".threshold").length, 1);
  assert.equal(groups[3].querySelector('[data-tip="01/04 賣超 -200 張"]')?.querySelector("title")!.textContent, "01/04 賣超 -200 張");
  assert.deepEqual([...grouped.querySelectorAll("details.others .broker-type")].map((n) => n.textContent), ["分點", "總公司"]);
  assert.match(grouped.querySelector("details.others td:nth-child(6)")!.textContent!, /買超/);
});

test("main report broker summary uses recent5 instead of today's trigger and links to all pairs", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const ts = await import("typescript");
  const source = readFileSync(new URL("../scripts/send-report.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("send-report.ts", source, ts.ScriptTarget.Latest, true);
  const wanted = new Set(["renderHome", "escHtml"]);
  const functions = ast.statements.filter((n) => ts.isFunctionDeclaration(n) && wanted.has(n.name?.text ?? ""));
  const js = ts.transpileModule(functions.map((n) => n.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const pastHit = { ...pair("past-hit"), triggered: false, recent: [{ date: "2026-10-22", net: 100, close: 1 }] };
  const quiet = { ...pair("quiet"), triggered: false };
  const render = runInNewContext(`${js}\nrenderHome`, {
    triggeredPairs, withRecent5,
    renderMarketRegime: () => "", renderHoldingLevel: () => "",
    readDataJson: (path: string) => path === "data/broker-watch-latest.json"
      ? { tradingDate: "2026-10-22", notion: false, items: [pastHit, quiet] } : null,
  });
  const html = render({ a: { date: "2026-10-22", timestamp: "2026-10-22", summary: "摘要" }, tabs: [] });
  assert.match(html, /近 5 日觸發 1 組：past-hit/);
  assert.doesNotMatch(html, /quiet/);
  assert.match(html, /href="broker-watch.html">查看全部分點/);
});

test("net20: shared window excludes old/future trades, counts coverage, renders both sections", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-net20-"));
  try {
    const calendar = Array.from({ length: 23 }, (_, n) => `2099-01-${String(n + 1).padStart(2, "0")}`);
    writeFileSync(join(dir, "calendar.json"), JSON.stringify({ days: calendar.map((date) => ({ date, net: 0 })) }));
    const full = pair("full");
    writeFileSync(join(dir, `full-${full.brokerCode}.json`), JSON.stringify({ days: [
      { date: calendar[0], net: 9999 }, { date: calendar[2], net: 1234 },
      { date: calendar[21], net: 100 }, { date: calendar[22], net: 9999 },
    ] }));
    const partial = { ...pair("partial"), recent: [{ date: calendar[20], close: 1, net: -20 }] };
    const report = withRecent5({ tradingDate: calendar[21], notion: false, items: [full, partial, pair("empty")] }, dir);
    assert.deepEqual(report.items.map((i) => [i.net20, i.net20Days, i.net20Partial]), [
      [1334, 20, false], [-20, 2, true], [0, 0, true],
    ]);
    const doc = new JSDOM(renderHtml(report)).window.document;
    assert.match(doc.querySelector(".latest-trigger")!.textContent!, /近20日 \+1,334 張/);
    assert.ok(doc.querySelector('.latest-trigger [title="近 20 個交易日累計淨買賣超"] .pos'));
    assert.match(doc.querySelector(".others")!.textContent!, /資料僅 2 日/);
    assert.ok(doc.querySelector('.others [title="近 20 個交易日累計淨買賣超"] .neg'));
    assert.ok([...doc.querySelectorAll("th")].some((n) => n.textContent === "近20日"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
