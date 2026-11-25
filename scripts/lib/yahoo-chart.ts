const HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

interface Chart {
  meta: any;
  timestamps: number[];
  closes: (number | null)[];
  opens?: (number | null)[];
  highs?: (number | null)[];
  lows?: (number | null)[];
}

export async function fetchChart(symbol: string, query: string): Promise<Chart | null> {
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
      const quote = result.indicators?.quote?.[0];
      return {
        meta: result.meta,
        timestamps: Array.isArray(result.timestamp) ? result.timestamp : [],
        closes: Array.isArray(quote?.close) ? quote.close : [],
        opens: Array.isArray(quote?.open) ? quote.open : [],
        highs: Array.isArray(quote?.high) ? quote.high : [],
        lows: Array.isArray(quote?.low) ? quote.low : [],
      };
    } catch (e) {
      // try next host
      console.warn(`[warn] Yahoo chart ${symbol} via ${host} failed: ${(e as Error).message}`);
    }
  }
  return null;
}

// 用各標的交易所時區把 epoch 轉成當地日期字串（YYYY-MM-DD），判斷某根 K 屬於哪一天。
export function localDate(epochSec: number, gmtoffsetSec: number): string {
  return new Date((epochSec + gmtoffsetSec) * 1000).toISOString().slice(0, 10);
}

// 日 K 依交易所當地日期排序，保留資料源給 null 的那幾根（c 為 null）。
// null 的那幾根不能直接丟掉：丟掉之後看起來像連續兩個交易日，會把兩天漲跌算成一天。
function dailyBars(chart: Chart, off: number) {
  const price = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const bars = chart.timestamps.map((t, i) => ({
    d: localDate(t, off),
    t,
    o: price(chart.opens?.[i]),
    h: price(chart.highs?.[i]),
    l: price(chart.lows?.[i]),
    c: price(chart.closes[i]),
  }));
  bars.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return bars;
}

// 共用國際盤後快照的收盤判定，盤中保留到上一個已收完的交易日。
export function completedDailyBars(chart: Chart, nowSec = Date.now() / 1000) {
  const meta = chart.meta;
  const off = typeof meta.gmtoffset === "number" ? meta.gmtoffset : 0;

  const reg = meta?.currentTradingPeriod?.regular;
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
      bars.push({ d: lastSession, c: price, t: epoch, o: null, h: null, l: null });
    }
  }

  return { bars, off, epoch, isLive };
}
