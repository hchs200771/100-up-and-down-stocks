import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderWorldMarketsPanel } from "../scripts/lib/world-markets-panel";
import { buildWorldMarketSeries } from "../scripts/lib/world-markets";
import { completedDailyBars } from "../scripts/lib/yahoo-chart";

test("日 K 略過缺值和補出的收盤價，保留有效收盤供均線及日漲跌幅計算", () => {
  const timestamps = [1, 2, 3, 4, 5, 6].map((day) => Date.UTC(2026, 10, day) / 1000);
  const { bars } = completedDailyBars({
    meta: { regularMarketTime: timestamps[5], regularMarketPrice: 123 },
    timestamps: timestamps.slice(0, 5),
    opens: [100, null, 110, 111, 119],
    highs: [111, 123, 113, 123, 125],
    lows: [99, 109, 109, 110, 118],
    closes: [110, 120, 111, null, 121],
  });
  assert.equal(bars.at(-1)?.c, 123);
  const series = buildWorldMarketSeries(bars);
  assert.deepEqual(series.map(({ date }) => date), ["2026-11-01", "2026-11-03", "2026-11-05"]);
  assert.deepEqual(series[0], {
    date: "2026-11-01", open: 100, high: 111, low: 99, close: 110, pct: null, ma20: null, ma60: null,
  });
  assert.ok(Math.abs(series[1].pct! + 7.5) < 0.000001);
  assert.equal(series[2].pct, null);

  const history = Array.from({ length: 60 }, (_, i) => ({
    d: new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10),
    o: i === 0 ? null : 100, h: 111, l: 99, c: i === 0 ? 110 : 100,
  }));
  assert.equal(buildWorldMarketSeries(history).at(-1)?.ma60, (59 * 100 + 110) / 60);
});

test("首頁各國股市專區展開後才載入資料，顯示近一年綠漲紅跌日 K", async () => {
  // 開收方向與前收漲跌幅刻意相反，驗證兩者各用自己的基準。
  const points = [
    { date: "2025-11-03", open: 100, high: 140, low: 65, close: 100, pct: null, ma20: 101, ma60: 102 },
    { date: "2025-11-04", open: 100, high: 112, low: 98, close: 110, pct: -1, ma20: 101, ma60: 102 },
    { date: "2026-11-03", open: 110, high: 111, low: 99, close: 100, pct: 1, ma20: 101, ma60: 102 },
    { date: "2026-11-04", open: 105, high: 108, low: 97, close: 105, pct: 5, ma20: 101.25, ma60: 101.75 },
  ];
  const requests: string[] = [];
  const html = renderWorldMarketsPanel();
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = async (url: string) => {
        requests.push(url);
        return { ok: true, json: async () => ({ series: { "^DJI": points } }) };
      };
      window.ResizeObserver = class {
        observe() {}
      } as unknown as typeof ResizeObserver;
      Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 500 });
    },
  });
  try {
    const { Event, KeyboardEvent } = dom.window;
    const document: Document = dom.window.document;
    const world = document.querySelector<HTMLDetailsElement>("details.wm-world")!;
    const order = ["^DJI", "^GSPC", "^SOX", "^IXIC"];
    const symbols = (area: Element) =>
      Array.from(area.querySelectorAll<HTMLElement>(".wm-chart"), (chart) => chart.dataset.symbol);
    assert.deepEqual(Array.from(document.querySelectorAll("#world-markets summary"), (summary) => summary.textContent),
      ["各國股市專區"]);
    assert.equal(world.open, false);
    assert.deepEqual(symbols(world).slice(0, 4), order);
    assert.equal(world.querySelector("select, svg"), null);
    assert.deepEqual(requests, []);

    world.open = true;
    world.dispatchEvent(new Event("toggle"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, ["./world-markets-latest.json"]);
    const svg = world.querySelector("svg")!;
    assert.deepEqual(Array.from(svg.querySelectorAll("g"), (candle) => candle.getAttribute("class")),
      ["wm-up", "wm-down", "wm-up"]);
    assert.equal(svg.querySelectorAll("g > line.wm-wick").length, 3);
    assert.equal(svg.querySelectorAll("g > rect.wm-body").length, 3);
    const lines = [...svg.querySelectorAll(".wm-ma20-line, .wm-ma60-line")];
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const style = dom.window.getComputedStyle(line);
      assert.equal(style.strokeDasharray, "none");
      assert.equal(style.strokeWidth, "1.5");
      assert.match(line.getAttribute("d")!, /^M[^ML]+L[^ML]+L[^ML]+$/);
    }
    assert.equal(world.querySelector(".wm-legend .wm-ma20")!.textContent, "MA20 101.25 ▲");
    assert.equal(world.querySelector(".wm-legend .wm-ma60")!.textContent, "MA60 101.75 ▼");
    const wicks = svg.querySelectorAll(".wm-wick");
    const high = svg.querySelector(".wm-high")!;
    const low = svg.querySelector(".wm-low")!;
    assert.equal(high.textContent, "112");
    assert.equal(low.textContent, "97");
    assert.equal(high.getAttribute("x"), wicks[0].getAttribute("x1"));
    assert.equal(low.getAttribute("x"), wicks[2].getAttribute("x1"));
    assert.ok(Number(high.getAttribute("y")) < Number(wicks[0].getAttribute("y1")));
    assert.ok(Number(low.getAttribute("y")) > Number(wicks[2].getAttribute("y2")));
    assert.match(world.querySelector('[data-symbol="^GSPC"]')!.textContent!, /資料暫缺/);
    svg.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    assert.match(world.querySelector(".wm-readout")!.textContent!, /2025-11-04.*開 100.*高 112.*低 98.*收 110.*漲跌幅 −1.00%/);
    assert.equal(world.querySelector(".wm-legend .wm-ma20")!.textContent, "MA20 101.25 ▲");
  } finally {
    dom.window.close();
  }
});
