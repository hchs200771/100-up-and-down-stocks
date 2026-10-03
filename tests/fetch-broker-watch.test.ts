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
