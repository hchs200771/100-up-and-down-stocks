import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildWorldMarketSeries, WORLD_MARKET_GROUPS, type WorldMarketsSnapshot } from "./lib/world-markets";
import { completedDailyBars, fetchChart } from "./lib/yahoo-chart";

async function main() {
  const markets = WORLD_MARKET_GROUPS.flatMap((group) => group.markets);
  const snapshot: WorldMarketsSnapshot = { fetchedAt: new Date().toISOString(), series: {} };
  const results = await Promise.allSettled(markets.map(async ({ symbol }) => {
    const chart = await fetchChart(symbol, "interval=1d&range=2y");
    if (!chart) throw new Error("Yahoo 無回應");
    const series = buildWorldMarketSeries(completedDailyBars(chart).bars);
    if (series.at(-1)?.ma60 == null) throw new Error("有效日線不足 60 根");
    return series;
  }));
  results.forEach((result, index) => {
    const { symbol } = markets[index];
    if (result.status === "fulfilled") snapshot.series[symbol] = result.value;
    else console.warn(`[warn] ${symbol} 資料暫缺：${result.reason.message}`);
  });

  const out = resolve("data/world-markets-latest.json");
  const tmp = `${out}.${process.pid}.tmp`;
  mkdirSync(dirname(out), { recursive: true });
  try {
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, "utf-8");
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
  const count = Object.keys(snapshot.series).length;
  console.log(`[world-markets] ${count}/${markets.length} 個標的，寫入 ${out}`);
  if (!count) process.exitCode = 1;
}

main().catch((error) => {
  console.warn("[warn] 各國股市日線抓取失敗", error);
  process.exitCode = 1;
});
