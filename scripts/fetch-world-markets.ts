import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildWorldMarketSeries, WORLD_MARKET_GROUPS, type WorldMarketsSnapshot } from "./lib/world-markets";
import { completedDailyBars, fetchChart } from "./lib/yahoo-chart";

/**
 * 櫃買指數：Yahoo 沒有日 K，改抓櫃買中心「櫃買指數(月查詢)」，一個月一個請求，抓 25 個月（畫一年＋算 60 日線）。
 * 欄位：日期(YYYY/MM/DD)、開市、最高、最低、收市、漲跌。
 */
async function fetchTpexBars() {
  const num = (v: string) => { const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
  const now = new Date(Date.now() + 8 * 3600_000);
  const bars: { d: string; o: number | null; h: number | null; l: number | null; c: number | null }[] = [];
  for (let back = 24; back >= 0; back--) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const date = `${m.getUTCFullYear()}/${String(m.getUTCMonth() + 1).padStart(2, "0")}/01`;
    let rows: string[][] | null = null;
    for (let attempt = 1; attempt <= 3 && !rows; attempt++) {
      try {
        const res = await fetch(`https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${encodeURIComponent(date)}&response=json`, {
          headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000),
        });
        if (res.ok) rows = ((await res.json()) as { tables?: { data?: string[][] }[] }).tables?.[0]?.data ?? [];
      } catch { /* 重試 */ }
      if (!rows) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    if (!rows) throw new Error(`櫃買指數 ${date.slice(0, 7)} 抓不到`);
    for (const r of rows) if (/^\d{4}\/\d{2}\/\d{2}$/.test(r[0])) bars.push({ d: r[0].replaceAll("/", "-"), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]) });
    await new Promise((r) => setTimeout(r, 300));
  }
  return bars.sort((a, b) => a.d.localeCompare(b.d));
}

async function main() {
  const markets = WORLD_MARKET_GROUPS.flatMap((group) => group.markets);
  const snapshot: WorldMarketsSnapshot = { fetchedAt: new Date().toISOString(), series: {} };
  const results = await Promise.allSettled(markets.map(async ({ symbol }) => {
    let bars;
    if (symbol === "TPEX") bars = await fetchTpexBars();
    else {
      const chart = await fetchChart(symbol, "interval=1d&range=2y");
      if (!chart) throw new Error("Yahoo 無回應");
      bars = completedDailyBars(chart).bars;
    }
    const series = buildWorldMarketSeries(bars);
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
