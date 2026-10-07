import assert from "node:assert/strict";
import test from "node:test";
import { parseFactset } from "../scripts/fetch-target-prices.ts";
import { buildNameIndex, extractTargetCall } from "../scripts/lib/target-news.ts";

const names = buildNameIndex({
  "2330": { name: "台積電" }, "2303": { name: "聯電" }, "1303": { name: "南亞" }, "2408": { name: "南亞科" },
  "8046": { name: "南電" }, "3105": { name: "穩懋" }, "2324": { name: "仁寶" }, "2882": { name: "國泰金" },
  "2885": { name: "元大金" }, "2383": { name: "台光電" }, "3008": { name: "大立光" }, "8150": { name: "南茂" },
});
const call = (t: string) => extractTargetCall(t, names);

test("FactSet EPS flash parses consensus target and EPS range", () => {
  const html = "&lt;p&gt;根據FactSet最新調查，共8位分析師，對臻鼎-KY(4958-TW)做出2026年EPS預估：中位數由14.05元下修至13.79元，其中最高估值16.18元，最低估值11.51元，預估目標價為644元。&lt;/p&gt;";
  const ev = parseFactset(1, 1791346236, html)!;
  assert.equal(ev.code, "4958");
  assert.equal(ev.name, "臻鼎-KY");
  assert.equal(ev.kind, "eps");
  assert.equal(ev.direction, "down");
  assert.equal(ev.target, 644);
  assert.equal(ev.epsLow, 11.51);
});

test("FactSet target flash parses median, high and low targets", () => {
  const html = "<p>根據FactSet最新調查，共6位分析師，對頎邦(6147-TW)提出目標價估值：中位數由260元上修至270元，調升幅度3.85%。其中最高估值290元，最低估值1,200.5元。</p>";
  const ev = parseFactset(2, 1791346236, html)!;
  assert.deepEqual([ev.kind, ev.direction, ev.targetPrev, ev.target, ev.targetHigh, ev.targetLow], ["target", "up", 260, 270, 290, 1200.5]);
});

test("named broker with old → new target", () => {
  assert.deepEqual(call("瑞銀：穩懋受惠於 SpaceX 星鏈 V3衛星升級 目標價從500元升到725元"), {
    code: "3105", name: "穩懋", brokers: ["瑞銀"], target: 725, prevTarget: 500, direction: "up",
  });
  const c = call("3100→3300！高盛調高台積電目標價6.5%  看好AI帶動業績強勁成長")!;
  assert.deepEqual([c.code, c.brokers, c.prevTarget, c.target, c.direction], ["2330", ["高盛"], 3100, 3300, "up"]);
});

test("alias, thousands separator and 萬", () => {
  const c = call("台積電法說倒數！大摩拋三問、率先升目標價至3,088元")!;
  assert.deepEqual([c.brokers, c.target], [["摩根士丹利"], 3088]);
  assert.equal(call("台光電受惠 Google TPU 高速成長 外資喊買 目標價上看1萬元")!.target, 10000);
});

test("由 A 元直衝 B 元 keeps both numbers", () => {
  const c = call("瑞銀上調南亞評等至「買進」 目標價由30元直衝300元看見了什麼？")!;
  assert.deepEqual([c.code, c.prevTarget, c.target], ["1303", 30, 300]);
});

test("longer name wins over its prefix; broker names are not stocks", () => {
  assert.equal(call("小摩看好南亞科 目標價調升至200元")!.code, "2408");
  const c = call("元大投顧指台積電先進製程近期無對手，維持買進給目標價到 3,500 元")!;
  assert.deepEqual([c.code, c.brokers, c.target], ["2330", ["元大"], 3500]);
});

test("vague referent keeps the stock but drops the number", () => {
  const c = call("AI轉型傳佳音！仁寶喜提獎卻遭小兒大砍「這檔」得大單助攻再升295元目標價也難逃")!;
  assert.equal(c.code, "2324");
  assert.equal(c.target, null);
});

test("multi-stock, US and FactSet titles are skipped", () => {
  assert.equal(call("ABF、CCL點火！台光電目標價喊1萬 南電上看2,460元"), null);
  assert.equal(call("《大行》高盛升台積電(TSM.US)目標價至660美元"), null);
  assert.equal(call("鉅亨速報 - Factset 最新調查：頎邦(6147-TW)目標價調升至270元，幅度約3.85%"), null);
  assert.equal(call("南茂(8150) 記憶體封測需求強勁！外資調升目標價")!.code, "8150");
});

test("stock-price ranges and 只差 distances are not targets", () => {
  const n = buildNameIndex({ "2303": { name: "聯電" }, "2344": { name: "華邦電" }, "2892": { name: "第一金" } });
  const a = extractTargetCall("聯電(2303)大跌原因？二哥股價卻從185➝147元，跌破月線可以買？最新目標價曝光", n)!;
  assert.deepEqual([a.prevTarget, a.target], [null, null]);
  assert.equal(extractTargetCall("離目標價只差8.5元！記憶體股遭出貨 華邦電失守180元", n)!.target, null);
  assert.deepEqual(extractTargetCall("第一金(2892)只剩一家券商看多，41元目標價撐得起嗎？", n)!.brokers, ["券商"]);
});
