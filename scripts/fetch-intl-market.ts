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
 * 一律以「最近一個已經收完的交易時段」為準，不看盤中即時價——就像台股報告不看夜盤。
 * 各市場收盤時間不同：對台股晚上跑的盤後報告而言，亞股是當日收盤，美股 / 費半 /
 * 原油 / 殖利率是隔夜前一個交易日；報告晚於 21:30（美股開盤）跑時美股正在交易，
 * 這時要的仍然是隔夜那根已收完的 K，不是正在跳動的盤中價。
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
const SYMBOLS: { symbol: string; key: string; name: string; region: string; digits?: number }[] = [
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
  // 美元/台幣不走 Yahoo：TWD=X 是 24 小時的國際盤報價，晚上跑報告時抓到的是紐約盤
  // 還在跳的價，跟新聞講的「台北匯市收盤」對不起來。改抓央行公布的「新臺幣對美元
  // 銀行間成交之收盤匯率」（fetchCbcUsdTwd），symbol 只在 CBC 掛掉時當後備。
  { symbol: "TWD=X", key: "usdtwd", name: "美元/台幣", region: "匯率", digits: 3 },
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

async function fetchChart(symbol: string, query: string): Promise<Chart | null> {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
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

// 日 K 陣列轉成 {當地日期, 收盤, epoch}，保留資料源給 null 的那幾根（c 為 null），依日期遞增。
// null 的那幾根不能直接丟掉：丟掉之後看起來像連續兩個交易日，會把兩天漲跌算成一天。
function dailyBars(chart: Chart, off: number): { d: string; c: number | null; t: number }[] {
  const bars = chart.timestamps.map((t, i) => {
    const c = chart.closes[i];
    return { d: localDate(t, off), c: typeof c === "number" && isFinite(c) ? c : null, t };
  });
  bars.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return bars;
}

/**
 * 補回日 K 為 null 的那個交易日收盤。
 *
 * Yahoo 對美股指數實測會整天給 null（2026-08-28 的 ^GSPC / ^DJI / ^IXIC / ^SOX
 * 連 open / volume 都是 null），但同一天的小時線是有資料的。用該日最後一根小時 K 當收盤，
 * 與官方收盤有零點零幾個百分點的誤差（收盤競價不在小時 K 裡），仍遠好過拿再前一天當基準
 * 把兩天漲跌算成一天（實測 S&P500 會從 -0.33% 變成 -0.58%）。
 */
async function fillGapClose(symbol: string, gapDate: string, from: number, to: number, off: number): Promise<number | null> {
  const c = await fetchChart(symbol, `interval=1h&period1=${Math.floor(from)}&period2=${Math.ceil(to)}`);
  if (!c) return null;
  let last: number | null = null;
  for (let i = 0; i < c.timestamps.length; i++) {
    const v = c.closes[i];
    if (typeof v !== "number" || !isFinite(v)) continue;
    if (localDate(c.timestamps[i], off) === gapDate) last = v;
  }
  return last;
}

/**
 * 取「最近一根已收完的日 K 收盤」與其「前一交易日收盤」算單日漲跌幅。
 *
 * 一律從 range=1mo 的日 K 陣列取最後兩根已收完的 K，不用 meta.chartPreviousClose。
 * 那個欄位實測不可靠：range=1d 與 range=2d 會回傳同一個值（於是盤中分支算出
 * close - prev = 0，整排美股顯示 +0.00%），指定 period1/period2 時它又變成整段
 * 視窗起點之前的舊收盤（^SOX 給 12621，實際前一交易日是 11882）。
 *
 * 「已收完」的判定分兩種，靠 currentTradingPeriod.regular 判斷該標的此刻是否盤中：
 *  - 盤中（報告晚於 21:30 跑時，美股 / 原油 / 匯率多半在交易）：陣列最後一根是還在
 *    形成的今天，丟掉當地日期 >= 今天的 K，剩下最後一根就是隔夜已收完那根。
 *  - 已收盤（亞股，或美股收盤後才跑）：以 regularMarketTime 的當地日期為準，丟掉比它
 *    更新的 K（擋掉盤前形成中的那根）；若陣列還沒補上剛收完的那一天（日經實測會落後
 *    一天），用 regularMarketPrice 補上去。
 */
async function fetchOne(symbol: string): Promise<{ close: number; prevClose: number; epoch: number | null } | null> {
  // 一個月足夠跨過連假，也讓資料源缺幾根 null 時仍湊得出兩根已收完的 K。
  const chart = await fetchChart(symbol, "interval=1d&range=1mo");
  if (!chart) return null;
  const meta = chart.meta;
  const off = typeof meta.gmtoffset === "number" ? meta.gmtoffset : 0;

  const reg = meta?.currentTradingPeriod?.regular;
  const nowSec = Date.now() / 1000;
  const isLive =
    reg &&
    typeof reg.start === "number" &&
    typeof reg.end === "number" &&
    nowSec >= reg.start &&
    nowSec < reg.end;

  let bars = dailyBars(chart, off);
  const epoch = typeof meta.regularMarketTime === "number" ? meta.regularMarketTime : null;

  if (isLive) {
    const today = localDate(nowSec, off);
    bars = bars.filter((b) => b.d < today);
  } else if (epoch !== null) {
    const lastSession = localDate(epoch, off);
    bars = bars.filter((b) => b.d <= lastSession);
    // 剛收完那天，日 K 陣列可能還沒補上（日經實測落後一天），也可能只有一個 close 為 null
    // 的佔位。兩種情況都用 regularMarketPrice 補；只看陣列最後一根會被 null 佔位擋住。
    const price = Number(meta.regularMarketPrice);
    if (isFinite(price) && !bars.some((b) => b.d === lastSession && b.c !== null)) {
      bars = bars.filter((b) => b.d !== lastSession);
      bars.push({ d: lastSession, c: price, t: epoch });
    }
  }

  // 最後一根有收盤的 K 就是「剛結束的交易日」
  let li = bars.length - 1;
  while (li >= 0 && bars[li].c === null) li--;
  if (li < 0) return null;
  const close = bars[li].c as number;

  let pi = li - 1;
  while (pi >= 0 && bars[pi].c === null) pi--;

  let prevClose: number;
  if (pi >= 0 && pi === li - 1) {
    prevClose = bars[pi].c as number;
  } else if (pi >= 0) {
    // 中間夾了資料源給 null 的交易日，用小時線把最靠近的那天補回來
    const gap = bars[li - 1];
    const filled = await fillGapClose(symbol, gap.d, bars[pi].t, bars[li].t, off);
    if (filled !== null) {
      prevClose = filled;
    } else {
      console.warn(`[warn] ${symbol}: ${gap.d} 日K與小時線都沒資料，改用 ${bars[pi].d} 當基準，漲跌幅可能跨多日`);
      prevClose = bars[pi].c as number;
    }
  } else if (!isLive) {
    // 滬深300 實測不論 range 都只回傳 1 根日 K，湊不出前一交易日。這種資料源殘缺的標的
    // 退回 meta.chartPreviousClose：在「已收盤」情境下它就是這根 K 的前一交易日收盤。
    // 盤中不能這樣退——那時它指的正是我們挑出來的這根，相減會得到 0，也就是整排美股
    // 顯示 +0.00% 的原因；寧可讓這個標的缺一天也不要送出假數字。
    prevClose = Number(meta.chartPreviousClose);
  } else {
    return null;
  }
  if (!isFinite(close) || !isFinite(prevClose) || prevClose === 0) return null;
  // 盤中時回傳的是隔夜那根，regularMarketTime 指的是今天的盤中，貼上去會誤導新鮮度判斷。
  return { close, prevClose, epoch: isLive ? null : epoch };
}

/**
 * 央行「新臺幣對美元銀行間成交之收盤匯率」日資料（台北匯市當日收盤）。
 *
 * 頁面是一張日期 / NTD/USD 的表格，最新的一天在最上面，約當日 16:00 收盤後公布，
 * 報告在 21:00 之後跑一定拿得到當天。取最上面兩列算單日漲跌。
 */
const CBC_USDTWD_URL = "https://www.cbc.gov.tw/tw/lp-645-1.html";

async function fetchCbcUsdTwd(): Promise<{ close: number; prevClose: number; epoch: number | null; date: string } | null> {
  try {
    const res = await fetch(CBC_USDTWD_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const rows: { date: string; rate: number }[] = [];
    const re = /<td[^>]*>\s*<span>\s*(\d{4})\/(\d{2})\/(\d{2})\s*<\/span>\s*<\/td>\s*<td[^>]*>\s*<span>\s*([\d.]+)\s*<\/span>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const rate = Number(m[4]);
      if (isFinite(rate) && rate > 0) rows.push({ date: `${m[1]}-${m[2]}-${m[3]}`, rate });
    }
    if (rows.length < 2) return null;
    return { close: rows[0].rate, prevClose: rows[1].rate, epoch: null, date: rows[0].date };
  } catch {
    return null;
  }
}

async function main() {
  const results = await Promise.all(
    SYMBOLS.map(async (s) => {
      let r: { close: number; prevClose: number; epoch: number | null } | null = null;
      if (s.key === "usdtwd") {
        const cbc = await fetchCbcUsdTwd();
        if (cbc) {
          r = cbc;
          const today = taipeiDate();
          if (cbc.date !== today) {
            console.warn(`[warn] 央行收盤匯率最新為 ${cbc.date}，非今日 ${today}（尚未公布或非交易日）`);
          }
        } else {
          console.warn("[warn] 央行收盤匯率抓取失敗，改用 Yahoo TWD=X 國際盤報價");
        }
      }
      if (!r) r = await fetchOne(s.symbol);
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
        close: round(r.close, s.digits),
        change: round(change, s.digits),
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

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// 台北當地日期（YYYY-MM-DD），用來判斷央行那張表最上面一列是不是今天。
function taipeiDate(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

main();
