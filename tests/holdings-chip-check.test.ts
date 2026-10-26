import assert from "node:assert/strict";
import test from "node:test";
import { checkHoldings, verdict, type Chips } from "../scripts/holdings-chip-check.ts";
import type { ReportItem } from "../scripts/fetch-broker-watch.ts";

const pair = (net: number, net20 = 0): ReportItem => ({
  pageId: "", title: "", stockCode: "2303", stockName: "聯電", broker: "測試分點", brokerCode: "test",
  threshold: 100, direction: "雙向", grade: "A", geo: "地緣", note: "", lastTriggerDate: "", lastTriggerNet: null,
  status: "ok", recent: [{ date: "2099-01-06", close: 10, net }], recent5: [{ date: "2099-01-06", net }], net20,
});
const chips: Chips = { foreignNet: 10, trustNet: -100, dealerNet: 5, totalNet: -85 };

test("verdict: long/short triggers, net20 agreement and MA10 exit alerts", () => {
  assert.deepEqual(verdict({ code: "2303", direction: "多" }, [pair(100)], null), ["贏家分點同向（信心+）"]);
  assert.deepEqual(verdict({ code: "2303", direction: "空" }, [pair(-100)], null), ["贏家分點同向（信心+）"]);
  assert.deepEqual(verdict({ code: "2303", direction: "多" }, [pair(0, 500)], null), ["贏家分點同向（信心+）"]);
  assert.deepEqual(verdict({ code: "2303", direction: "多" }, [pair(-100)], null, false), ["分點反向＋跌破 10 日線，出場警訊"]);
  assert.deepEqual(verdict({ code: "2303", direction: "空" }, [pair(100)], null, true), ["分點反向＋站上 10 日線，出場警訊"]);
  assert.deepEqual(verdict({ code: "2303", direction: "空" }, [pair(100)], null), ["贏家分點反向，留意出場"]);
});

test("verdict: institutions, trust dominance, neutral and conflicting evidence", () => {
  assert.deepEqual(verdict({ code: "2303", direction: "空" }, [], chips), ["法人同向（投信主導）"]);
  assert.deepEqual(verdict({ code: "2303", direction: "多" }, [], chips), ["法人反向（投信主導）"]);
  assert.deepEqual(verdict({ code: "2303", direction: "多" }, [], null), ["無明顯籌碼訊號"]);
  assert.deepEqual(verdict({ code: "2303", direction: "多" }, [pair(0, -500)], null), ["無明顯籌碼訊號"]);
  assert.equal(verdict({ code: "2303", direction: "多" }, [pair(-100, 500)], chips).length, 3);
});

test("injected check: holidays, missing stock data, marked triggers and no network", async () => {
  const calls: string[] = [];
  const market = Object.fromEntries(Array.from({ length: 501 }, (_, n) => [`market${n}`, 10]));
  const result = await checkHoldings([{ code: "2303", direction: "多" }, { code: "5347", direction: "空" }],
    "2099-01-06", { tradingDate: "2099-01-06", notion: false, items: [pair(-100)] },
    async (date) => { calls.push(date); return date === "2099-01-05" ? {} : { "2303": chips }; },
    () => ({ ...market, "2303": 10, "5347": 20 }));
  assert.equal(calls.length, 6);
  assert.equal(result.items[0].institutions.fiveDay?.totalNet, -425);
  assert.equal(result.items[0].brokers[0].recent5?.at(-1)?.triggered, true);
  assert.equal(result.items[0].price.ma10, 10);
  assert.equal(result.items[1].institutions.fiveDay, null);
  assert.equal(result.items[1].brokerStatus, "不在追蹤名單");
});

test("injected check: failed session is unknown, never backfills a misleading five-day sum", async () => {
  const result = await checkHoldings([{ code: "2303", direction: "多" }], "2099-01-06",
    { tradingDate: "2099-01-06", notion: false, items: [] },
    async () => { throw new Error("來源失敗"); }, () => undefined);
  assert.equal(result.items[0].institutions.daily, null);
  assert.equal(result.items[0].institutions.fiveDay, null);
  assert.equal(result.items[0].price.ma10, null);
  assert.deepEqual(result.items[0].verdict, ["無明顯籌碼訊號"]);
  assert.match(result.warnings.join("；"), /來源失敗.*僅 0 個交易日/);
});
