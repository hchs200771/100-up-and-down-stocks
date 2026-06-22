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
  { symbol: "TWD=X", key: "usdtwd", name: "美元/台幣", region: "匯率" },
];

const HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

interface Chart {
  meta: any;
  timestamps: number[];
  closes: (number | null)[];
}

async function fetchChart(symbol: string, range: string): Promise<Chart | null> {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + path, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result?.meta) continue;
      return {
        meta: result.meta,
        timestamps: Array.isArray(result.timestamp) ? result.timestamp : [],
        closes: Array.isArray(result.indicators?.quote?.[0]?.close) ? result.indicators.quote[0].close : [],
      };
    } catch (e) {
      // try next host
    }
  }
  return null;
}

// 用各標的交易所時區把 epoch 轉成當地日期字串（YYYY-MM-DD），判斷某根 K 屬於哪一天。
function localDate(epochSec: number, gmtoffsetSec: number): string {
  return new Date((epochSec + gmtoffsetSec) * 1000).toISOString().slice(0, 10);
}

// 從日 K 陣列取「當地日期 < beforeDate」的已收完收盤（日期遞增），最後一根即最近前一交易日。
function settledBarsBefore(chart: Chart, beforeDate: string, off: number): { d: string; c: number }[] {
  const bars: { d: string; c: number }[] = [];
  for (let i = 0; i < chart.timestamps.length; i++) {
    const c = chart.closes[i];
    if (typeof c !== "number" || !isFinite(c)) continue;
    const d = localDate(chart.timestamps[i], off);
    if (d < beforeDate) bars.push({ d, c });
  }
  bars.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return bars;
}

/**
 * 決定前一交易日收盤。chartPreviousClose 多數時候就是對的（含資料源陣列裡為 null 的
 * 假日後缺口日，如 06-15），但偶爾資料源會給到更舊的一根（如上證給到 06-11、跳過 06-12）。
 * 對策：跟日 K 陣列裡「今天之前最近一根已收完收盤」交叉比對——若 chartPreviousClose
 * 對得上某根「比陣列最近一根更舊」的 K，判定為錯位，改用陣列最近一根；否則沿用
 * chartPreviousClose（它是缺口日或就等於陣列最近一根）。
 */
function resolvePrevClose(cpc: number, array: Chart | null, todayDate: string, off: number): number {
  if (!array) return cpc;
  const bars = settledBarsBefore(array, todayDate, off);
  if (bars.length === 0) return cpc;
  const arrayPrev = bars[bars.length - 1];
  const eq = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-5);
  for (const b of bars) {
    if (b.d < arrayPrev.d && eq(cpc, b.c)) return arrayPrev.c; // chartPreviousClose 錯位到更舊的一根
  }
  return cpc;
}

/**
 * 取「最近一根已收完的日 K 收盤」與其「前一交易日收盤」算單日漲跌幅。
 *
 * 前一交易日收盤主要用 range=1d 的 meta.chartPreviousClose——它是「回傳的那根日 K
 * 之前一根的收盤」，即真正的前一交易日收盤（已驗證對得上前一日報告數字）。
 * 不要用多日 range 的 chartPreviousClose（那是整段區間起點之前、約 N 天前），
 * 也不要用日 K 陣列逐根相減——此資料源某些交易日（如假日後）在陣列裡是 null，
 * 逐根相減會跨過缺口、把數日漲跌誤算成單日。
 *
 * 兩種情況（以「該標的目前是否在 regular session 盤中」區分）：
 *  - 已收盤（亞股對台股傍晚是當日收盤）：close=regularMarketPrice，prev=chartPreviousClose@1d。
 *    但有時 range=1d 回傳的那根 K 不是今天（資料源不一致，如上證），此時 chartPreviousClose
 *    會對到錯誤基準；用「range=1d 那根 K 的當地日期是否等於今天」判斷，不等於就改用
 *    日 K 陣列裡今天之前最後一根已收完收盤當 prev。
 *  - 盤中（美股/原油對台股傍晚多在盤中、即時非收盤）：抓隔夜最後收完那一根，
 *    close=chartPreviousClose@1d（昨夜已收盤），prev=chartPreviousClose@2d（昨夜的前一交易日）。
 */
async function fetchOne(symbol: string): Promise<{ close: number; prevClose: number; epoch: number | null } | null> {
  const c1 = await fetchChart(symbol, "1d");
  if (!c1) return null;
  const meta = c1.meta;
  const off = typeof meta.gmtoffset === "number" ? meta.gmtoffset : 0;

  const reg = meta?.currentTradingPeriod?.regular;
  const nowSec = Date.now() / 1000;
  const isLive =
    reg &&
    typeof reg.start === "number" &&
    typeof reg.end === "number" &&
    nowSec >= reg.start &&
    nowSec < reg.end;

  let close: number;
  let prevClose: number;
  let epoch: number | null;

  if (!isLive) {
    close = Number(meta.regularMarketPrice);
    epoch = typeof meta.regularMarketTime === "number" ? meta.regularMarketTime : null;

    const cpc = Number(meta.chartPreviousClose);
    const todayDate = epoch !== null ? localDate(epoch, off) : null;
    // 跟日 K 陣列交叉比對，擋掉 chartPreviousClose 偶爾錯位到更舊一根的情況。
    const c10 = todayDate ? await fetchChart(symbol, "10d") : null;
    prevClose = todayDate ? resolvePrevClose(cpc, c10, todayDate, off) : cpc;
  } else {
    const c2 = await fetchChart(symbol, "2d");
    if (!c2) return null;
    close = Number(meta.chartPreviousClose);
    prevClose = Number(c2.meta.chartPreviousClose);
    epoch = null; // 隔夜已收盤那一根，時間戳意義不大
  }

  if (!isFinite(close) || !isFinite(prevClose) || prevClose === 0) return null;
  return { close, prevClose, epoch };
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
