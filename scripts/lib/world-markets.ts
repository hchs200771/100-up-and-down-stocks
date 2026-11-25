export const US_MARKETS = [
  { symbol: "^DJI", name: "道瓊工業" },
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^SOX", name: "費城半導體" },
  { symbol: "^IXIC", name: "那斯達克" },
];

export const WORLD_MARKET_GROUPS = [
  { name: "美股", markets: US_MARKETS },
  { name: "台股與匯率", markets: [
    { symbol: "^TWII", name: "加權指數" },
    { symbol: "TPEX", name: "櫃買指數" },
    { symbol: "TWD=X", name: "美元兌台幣", note: "數字上升代表台幣貶值（1 美元可換更多台幣）。" },
  ] },
  { name: "陸港股", markets: [
    { symbol: "000001.SS", name: "上證指數" },
    { symbol: "^HSI", name: "恆生指數" },
  ] },
  { name: "日本", markets: [{ symbol: "^N225", name: "日經 225" }] },
  { name: "韓國", markets: [{ symbol: "^KS11", name: "KOSPI" }] },
  { name: "黃金與比特幣", markets: [
    { symbol: "GC=F", name: "黃金期貨" },
    { symbol: "BTC-USD", name: "比特幣（美元）" },
  ] },
];

export interface WorldMarketBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pct: number | null;
  ma20: number | null;
  ma60: number | null;
}

export interface WorldMarketsSnapshot {
  fetchedAt: string;
  series: Record<string, WorldMarketBar[]>;
}

export function buildWorldMarketSeries(bars: {
  d: string;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
}[]): WorldMarketBar[] {
  const closes: number[] = [];
  let previousClose: number | null = null;
  return bars.flatMap(({ d, o, h, l, c }) => {
    if (c === null || !Number.isFinite(c) || c <= 0) {
      previousClose = null;
      return [];
    }
    closes.push(c);
    const pct = previousClose === null ? null : (c / previousClose - 1) * 100;
    previousClose = c;
    // 有效收盤仍可計入均線及次日漲跌幅，即使當日缺少其他價格。
    if (o === null || h === null || l === null || ![o, h, l].every(Number.isFinite)) return [];
    const average = (days: number) => closes.length < days
      ? null
      : closes.slice(-days).reduce((sum, close) => sum + close, 0) / days;
    return [{
      date: d,
      open: o,
      high: h,
      low: l,
      close: c,
      pct,
      ma20: average(20),
      ma60: average(60),
    }];
  });
}
