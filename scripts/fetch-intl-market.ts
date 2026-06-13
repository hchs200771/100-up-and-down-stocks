import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 盤後國際市場快照。
 *
 * 用 Yahoo Finance chart API（免費、無金鑰）抓主要國際指數 / 原物料 / 利率的
 * 最新收盤與漲跌幅，寫到 data/intl-market-latest.json。
 *
 * 用途：
 * 1. 報告裡的「🌐 國際情勢」數字表（renderIntl in send-report.ts）。
 * 2. 餵給「國際情勢 worker」當判讀依據（搭配 macromicro-analyst 框架）。
 *
 * 注意：各市場收盤時間不同。對台股傍晚跑的盤後報告而言，亞股（日經/上證/恒生/
 * KOSPI）是「當日」收盤，美股 / 費半 / 原油 / 殖利率是「隔夜」前一個交易日。
 * asOfEpoch 保留各標的最後成交時間，需要時可判斷新鮮度。
 */

interface IntlIndex {
  key: string;
  name: string;
  region: string;
  close: number;
  change: number;
  pct: number;
  asOfEpoch: number | null;
}

// region 排序即為報告呈現順序。
const SYMBOLS: { symbol: string; key: string; name: string; region: string }[] = [
  { symbol: "^GSPC", key: "sp500", name: "標普500", region: "美股" },
  { symbol: "^DJI", key: "dji", name: "道瓊工業", region: "美股" },
  { symbol: "^IXIC", key: "nasdaq", name: "那斯達克", region: "美股" },
  { symbol: "^SOX", key: "sox", name: "費城半導體", region: "美股" },
  { symbol: "000001.SS", key: "sse", name: "上證指數", region: "中國" },
  { symbol: "000300.SS", key: "csi300", name: "滬深300", region: "中國" },
  { symbol: "^HSI", key: "hsi", name: "恒生指數", region: "中國" },
  { symbol: "^N225", key: "nikkei", name: "日經225", region: "日韓" },
  { symbol: "^KS11", key: "kospi", name: "韓國KOSPI", region: "日韓" },
  { symbol: "CL=F", key: "wti", name: "西德州原油", region: "原物料/利率" },
  { symbol: "GC=F", key: "gold", name: "黃金", region: "原物料/利率" },
  { symbol: "DX-Y.NYB", key: "dxy", name: "美元指數", region: "原物料/利率" },
  { symbol: "^TNX", key: "us10y", name: "美10年期殖利率", region: "原物料/利率" },
];

const HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

async function fetchOne(symbol: string): Promise<{ close: number; prevClose: number; epoch: number | null } | null> {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + path, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) continue;
      const close = Number(meta.regularMarketPrice);
      const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose);
      if (!isFinite(close) || !isFinite(prevClose) || prevClose === 0) continue;
      return { close, prevClose, epoch: typeof meta.regularMarketTime === "number" ? meta.regularMarketTime : null };
    } catch (e) {
      // try next host
    }
  }
  return null;
}

async function main() {
  const results = await Promise.all(
    SYMBOLS.map(async (s) => {
      const r = await fetchOne(s.symbol);
      if (!r) {
        console.warn(`[warn] intl fetch failed: ${s.symbol} (${s.name})`);
        return null;
      }
      const change = r.close - r.prevClose;
      const pct = (change / r.prevClose) * 100;
      const idx: IntlIndex = {
        key: s.key,
        name: s.name,
        region: s.region,
        close: round(r.close),
        change: round(change),
        pct: Number(pct.toFixed(2)),
        asOfEpoch: r.epoch,
      };
      return idx;
    }),
  );

  const indices = results.filter((x): x is IntlIndex => x !== null);
  if (indices.length === 0) {
    console.error("No intl market data available.");
    process.exit(1);
  }

  const now = new Date();
  const tradingDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const out = {
    timestamp: now.toISOString(),
    tradingDate,
    indices,
  };

  const outPath = resolve(process.cwd(), "data/intl-market-latest.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
  console.log(`Wrote ${indices.length}/${SYMBOLS.length} intl indices to ${outPath}`);
  for (const i of indices) {
    console.log(`  ${i.region.padEnd(8)} ${i.name}  ${i.close}  ${i.pct >= 0 ? "+" : ""}${i.pct}%`);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

main();
