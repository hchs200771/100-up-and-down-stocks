import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTxCsv, parseAvailableDates } from "../scripts/fetch-tx-intraday.ts";

const header = "成交日期,商品代號,到期月份(週別),成交時間,成交價格,成交數量(B+S),近月價格,遠月價格,開盤集合競價";
const fixture = header + `\r\n20261112, TX ,202612,084500,99999,2,-,-,
20261112,TX,202611W2,084500,99999,2,-,-,
20261112,TX,202611/202612,084500,100,2,20000,20100,
20261112,MTX,202610,084500,99999,2,-,-,
20261112, TX   , 202611   ,084500,22000,10,-,-,*
20261112,TX,202611,084559,22003,4,-,-,
20261112,TX,202611,084510,21998,2,-,-,
20261112,TX,202611,084559,22001,2,-,-,
20261112,TX,202611,084600,22010,2,-,-,
20261112,TX,202611,000001,21900,6,-,-,
20261111,TX,202611,235959,21800,2,-,-,
20261111,TX,202611,150000,21700,8,-,-,*
20261112,TX,202611,134500,22005,2,-,-,
20261112,TX,202611,050000,21901,2,-,-,`;

test("selects nearest monthly TX, trims padding, excludes spreads/weekly and orders sessions", () => {
  const { bars, metadata } = aggregateTxCsv(fixture);
  assert.deepEqual(metadata, { contract: "202611", dayBars: 3, nightBars: 4, ticks: 10 });
  assert.deepEqual(bars.map(b => [b.session, b.time]), [
    ["night", "15:00"], ["night", "23:59"], ["night", "00:00"], ["night", "05:00"],
    ["day", "08:45"], ["day", "08:46"], ["day", "13:45"],
  ]);
  assert.deepEqual(bars[4], { session: "day", time: "08:45", open: 22000, high: 22003, low: 21998, close: 22001, volume: 9 });
  assert.equal(bars[0].volume, 4); // Auction executions retained, B+S converted to contracts.
  assert.equal(bars[2].close, 21900);
});

test("rejects unexpected format or corrupt selected-contract ticks instead of saving partial data", () => {
  assert.throws(() => aggregateTxCsv("bad\nTX,202611"), /header/);
  assert.throws(() => aggregateTxCsv(header + "\n20261112,TX,202611W2,084500,1,2,-,-,"), /monthly/);
  assert.throws(() => aggregateTxCsv(fixture.replace("22000,10", "-,10")), /price\/volume/);
  assert.throws(() => aggregateTxCsv(fixture.replace("084500,22000", "086000,22000")), /time/);
});

test("parses and deduplicates only CSV download dates in sorted order", () => {
  assert.deepEqual(parseAvailableDates(`
    onclick="window.open('https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_2026_11_13.zip')"
    DailydownloadCSV/Daily_2026_11_12.zip
    DailydownloadCSV/Daily_2026_11_13.zip
    Dailydownload/Daily_2020_01_01.zip`), ["2026-11-12", "2026-11-13"]);
  assert.deepEqual(parseAvailableDates("maintenance"), []);
});

// TAIFEX publishes the night-only file before updating it with the day session.
test("represents a night-only source as incomplete without fabricating day bars", () => {
  const { metadata } = aggregateTxCsv(header + "\n20261113,TX,202611,000001,22000,2,-,-,");
  assert.deepEqual(metadata, { contract: "202611", dayBars: 0, nightBars: 1, ticks: 1 });
});
