import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Stock {
  code: string;
  name: string;
  pct: number;
  close: number;
  amount: string;
  volume?: number;
  futures?: { level: string; margin: string };
  chips?: { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number; foreignRatio?: number; trustRatio?: number; foreignBuyStreak?: number; trustBuyStreak?: number };
  dayTradeRatio?: number;
  flags?: { attention?: boolean; disposition?: boolean; lowLiquidity?: boolean };
}

interface MarketIndex {
  close: number;
  change: number;
  amount: number;
}

interface Breadth {
  up: number;
  down: number;
  flat: number;
  limitUp: number;
  limitDown: number;
}

interface MicroRetail {
  dataDate: string;
  totalOI: number;
  instLong: number;
  instShort: number;
  retailLong: number;
  retailShort: number;
  retailNetPct: number;
}

// ---------------------------------------------------------------------------
// Pure parser functions (exported for testing)
// ---------------------------------------------------------------------------

/** Parse ROC date in format "115/06/13" or "1150613" or "115/06/13～115/06/29" start */
export function parseRocDate(rocStr: string): Date | null {
  // "115/06/13" style
  const slashMatch = rocStr.match(/^(\d+)\/(\d{2})\/(\d{2})/);
  if (slashMatch) {
    const year = parseInt(slashMatch[1]) + 1911;
    const month = parseInt(slashMatch[2]) - 1;
    const day = parseInt(slashMatch[3]);
    return new Date(year, month, day);
  }
  // "1150613" compressed style
  const compactMatch = rocStr.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (compactMatch) {
    const year = parseInt(compactMatch[1]) + 1911;
    const month = parseInt(compactMatch[2]) - 1;
    const day = parseInt(compactMatch[3]);
    return new Date(year, month, day);
  }
  return null;
}

/** Parse a TWSE DispositionPeriod like "115/06/02～115/06/15" → {start, end} */
export function parseDispositionPeriod(
  period: string,
  style: "slash" | "compact",
): { start: Date; end: Date } | null {
  const sep = style === "slash" ? "～" : "~";
  const parts = period.split(sep);
  if (parts.length !== 2) return null;
  const start = parseRocDate(parts[0].trim());
  const end = parseRocDate(parts[1].trim());
  if (!start || !end) return null;
  return { start, end };
}

/** Parse TWSE T86 institutional data → map code → chips (張) */
export function parseT86(json: any): Map<string, { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number }> {
  const map = new Map<string, { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number }>();
  if (!json || json.stat !== "OK" || !Array.isArray(json.data)) return map;
  for (const row of json.data) {
    if (!Array.isArray(row) || row.length < 19) continue;
    const code = (row[0] as string).trim();
    const parse = (s: string) => parseInt((s || "0").replace(/,/g, ""), 10) || 0;
    const idx4 = parse(row[4]);
    const idx7 = parse(row[7]);
    const idx10 = parse(row[10]);
    const idx11 = parse(row[11]);
    const idx18 = parse(row[18]);
    map.set(code, {
      foreignNet: Math.round((idx4 + idx7) / 1000),
      trustNet: Math.round(idx10 / 1000),
      dealerNet: Math.round(idx11 / 1000),
      totalNet: Math.round(idx18 / 1000),
    });
  }
  return map;
}

/**
 * Parse TWSE BFI82U（上市三大法人買賣超）→ 各類別買賣差額（億元）。
 * fields: ["單位名稱","買進金額","賣出金額","買賣差額"]，金額單位為元。
 */
export function parseBFI82U(
  json: any,
): { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number } | null {
  if (!json || json.stat !== "OK" || !Array.isArray(json.data)) return null;
  const toYi = (s: string) => (parseInt((s || "0").replace(/,/g, ""), 10) || 0) / 1e8;
  let foreign = 0, trust = 0, dealer = 0, total = 0;
  let matched = false;
  for (const row of json.data) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const name = String(row[0] || "");
    const net = toYi(row[3]);
    if (name.includes("合計")) { total = net; matched = true; }
    else if (name.includes("外資")) { foreign += net; matched = true; }
    else if (name.includes("投信")) { trust += net; matched = true; }
    else if (name.includes("自營商")) { dealer += net; matched = true; }
  }
  if (!matched) return null;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return { foreignNet: r1(foreign), trustNet: r1(trust), dealerNet: r1(dealer), totalNet: r1(total) };
}

/** Parse TPEx insti dailyTrade → map code → chips (張) */
export function parseTpexInsti(json: any): Map<string, { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number }> {
  const map = new Map<string, { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number }>();
  const rows: any[][] = json?.tables?.[0]?.data ?? [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 24) continue;
    const code = (row[0] as string).trim();
    const parse = (s: string) => parseInt((s || "0").replace(/,/g, ""), 10) || 0;
    map.set(code, {
      foreignNet: Math.round(parse(row[10]) / 1000),
      trustNet: Math.round(parse(row[13]) / 1000),
      dealerNet: Math.round(parse(row[22]) / 1000),
      totalNet: Math.round(parse(row[23]) / 1000),
    });
  }
  return map;
}

/**
 * Parse issued shares from TWSE and TPEx opendata endpoints.
 * TWSE: https://openapi.twse.com.tw/v1/opendata/t187ap03_L
 *   each item: { "公司代號": "2330", "已發行普通股數或TDR原股發行股數": "25932370067" }
 * TPEx: https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O
 *   each item: { SecuritiesCompanyCode: "3105", IssueShares: "423940384" }
 * Returns Map<code, shares(股)>
 */
export function parseIssuedShares(twseBasicJson: any, tpexBasicJson: any): Map<string, number> {
  const map = new Map<string, number>();
  const parseNum = (s: string) => parseInt((s || "0").replace(/,/g, ""), 10) || 0;

  if (Array.isArray(twseBasicJson)) {
    for (const item of twseBasicJson) {
      const code = (item?.["公司代號"] ?? "").trim();
      const shares = parseNum(item?.["已發行普通股數或TDR原股發行股數"] ?? "0");
      if (code && shares > 0) map.set(code, shares);
    }
  }

  if (Array.isArray(tpexBasicJson)) {
    for (const item of tpexBasicJson) {
      const code = (item?.SecuritiesCompanyCode ?? "").trim();
      const shares = parseNum(item?.IssueShares ?? "0");
      if (code && shares > 0) map.set(code, shares);
    }
  }

  return map;
}

/** Parse TWTB4U day trade data:
 *  returns { twseVolumePct, perStock: Map<code, shares> }
 */
export function parseDayTrade(json: any): { twseVolumePct: number | null; perStock: Map<string, number> } {
  const perStock = new Map<string, number>();
  let twseVolumePct: number | null = null;

  const tables: any[] = json?.tables ?? [];
  if (tables.length < 1) return { twseVolumePct, perStock };

  // table[0].data[0] = [總成交股數, 占市場比重%, ...]
  const summaryRows: any[][] = tables[0]?.data ?? [];
  if (summaryRows.length > 0 && summaryRows[0].length >= 2) {
    twseVolumePct = parseFloat(summaryRows[0][1]);
  }

  // table[1].data = per-stock rows: [代號, 名稱, 註記, 當沖成交股數, ...]
  const stockRows: any[][] = tables[1]?.data ?? [];
  for (const row of stockRows) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const code = (row[0] as string).trim();
    const shares = parseInt((row[3] || "0").toString().replace(/,/g, ""), 10) || 0;
    if (code && shares > 0) perStock.set(code, shares);
  }

  return { twseVolumePct, perStock };
}

/** Compute micro futures retail long/short from institutional OI + total OI data */
export function computeMicroRetail(
  instiRows: any[],
  totalOIRows: any[],
): MicroRetail | null {
  if (!Array.isArray(instiRows) || !Array.isArray(totalOIRows)) return null;

  const micro = instiRows.filter((r) => r?.ContractCode === "微型臺指期貨");
  if (micro.length === 0) return null;

  let instLong = 0;
  let instShort = 0;
  let dataDate = "";
  for (const r of micro) {
    const l = parseInt(r["OpenInterest(Long)"] || "0", 10) || 0;
    const s = parseInt(r["OpenInterest(Short)"] || "0", 10) || 0;
    instLong += l;
    instShort += s;
    if (!dataDate && r.Date) dataDate = r.Date;
  }

  const tmf = totalOIRows.filter(
    (r) => r?.Contract === "TMF" && r?.TradingSession === "一般",
  );
  let totalOI = 0;
  for (const r of tmf) {
    const oi = parseInt(r.OpenInterest || "0", 10) || 0;
    totalOI += oi;
  }

  if (totalOI === 0) return null;

  // Retail = total market minus the three institutional groups.
  const retailLong = totalOI - instLong;
  const retailShort = totalOI - instShort;
  const retailNetPct = ((retailLong - retailShort) / totalOI) * 100;

  return { dataDate, totalOI, instLong, instShort, retailLong, retailShort, retailNetPct };
}

/**
 * Compute consecutive buy streak for a single stock.
 * @param perDayNet Array of {date, net} sorted newest-first (date=YYYY-MM-DD)
 * Returns count of consecutive days (from index 0) where net > 0.
 * If perDayNet[0].net <= 0, returns 0 (today not a buy day → no streak).
 */
export function computeBuyStreak(perDayNet: Array<{ date: string; net: number }>): number {
  let streak = 0;
  for (const entry of perDayNet) {
    if (entry.net > 0) streak++;
    else break;
  }
  return streak;
}

/** Compute breadth stats from allStocks */
export function computeBreadth(stocks: Stock[]): Breadth {
  let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
  for (const s of stocks) {
    if (s.pct > 0) up++;
    else if (s.pct < 0) down++;
    else flat++;
    if (s.pct >= 9.8) limitUp++;
    if (s.pct <= -9.8) limitDown++;
  }
  return { up, down, flat, limitUp, limitDown };
}

// ---------------------------------------------------------------------------
// Existing parsers (unchanged)
// ---------------------------------------------------------------------------

function processTwseData(json: any): Stock[] {
  if (!json.data) return [];
  return json.data
    .map((row: any) => {
      const code = row[0];
      const name = row[1];
      const amountRaw = row[3].replace(/,/g, "");
      const volumeRaw = parseInt(row[2].replace(/,/g, ""), 10) || 0;
      const close = parseFloat(row[7].replace(/,/g, ""));
      const changeStr = row[8].replace(/<[^>]*>?/gm, "").replace(/,/g, "");
      const change = changeStr.includes("+")
        ? parseFloat(changeStr.replace("+", ""))
        : parseFloat(changeStr);
      if (isNaN(close) || isNaN(change) || close === 0) return null;
      const prevClose = close - change;
      const pct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
      return { code, name, pct, close, amount: amountRaw, volume: volumeRaw };
    })
    .filter((s: Stock | null): s is Stock => s !== null);
}

function processTpexData(json: any): Stock[] {
  let data: any[] = [];
  if (json.tables && json.tables.length > 0) data = json.tables[0].data;
  else if (json.data) data = json.data;
  else if (json.aaData) data = json.aaData;
  if (!data || data.length === 0) return [];

  return data
    .map((row: any) => {
      const code = row[0];
      const name = row[1];
      if (code.length >= 6) return null;
      const closeStr = (row[2] || "0").toString().replace(/,/g, "");
      const changeStr = (row[3] || "0").toString().replace(/,/g, "");
      const amountStr = (row[8] || "0").toString().replace(/,/g, "");
      // row[7] is 成交股數 (千股 unit based on inspection: "283,529" for ETF — treat as shares directly)
      const volumeRaw = parseInt((row[7] || "0").toString().replace(/,/g, ""), 10) || 0;
      const close = parseFloat(closeStr);
      const change = parseFloat(changeStr);
      if (isNaN(close) || isNaN(change) || close === 0) return null;
      const prevClose = close - change;
      const pct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
      return { code, name, pct, close, amount: amountStr, volume: volumeRaw };
    })
    .filter((s: Stock | null): s is Stock => s !== null);
}

function deriveTradingDate(twseData: any, tpexData: any): { tradingDate: string; timestamp: string; rawDate: string } {
  const rawDate: string = twseData.date || tpexData.date || "";
  if (!/^\d{8}$/.test(rawDate)) {
    throw new Error("Market data response did not include a valid trading date.");
  }

  const y = rawDate.slice(0, 4);
  const m = rawDate.slice(4, 6);
  const d = rawDate.slice(6, 8);
  return {
    tradingDate: `${y}-${m}-${d}`,
    timestamp: `${y}/${m}/${d}`,
    rawDate,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Step 1: fetch base data
  const [twseRes, tpexRes, futuresRes] = await Promise.all([
    fetch("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json"),
    fetch("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?response=json"),
    fetch("https://openapi.taifex.com.tw/v1/SingleStockFuturesMargining"),
  ]);

  const [twseData, tpexData, futuresData] = await Promise.all([
    twseRes.json(),
    tpexRes.json(),
    futuresRes.json().catch(() => []),
  ]);

  const futuresMap: Record<string, { level: string; margin: string }> = {};
  if (Array.isArray(futuresData)) {
    for (const f of futuresData) {
      if (f.UnderlyingSecurityCode) {
        futuresMap[f.UnderlyingSecurityCode] = {
          level: f.GroupLevel,
          margin: f.InitialMarginRate,
        };
      }
    }
  }

  const twseStocks = processTwseData(twseData);
  const tpexStocks = processTpexData(tpexData);

  if (twseStocks.length === 0 && tpexStocks.length === 0) {
    console.error("No market data available today.");
    process.exit(1);
  }

  const { tradingDate, timestamp, rawDate } = deriveTradingDate(twseData, tpexData);

  // tradingDate as Date for comparison
  const tradingDateObj = new Date(`${tradingDate}T00:00:00+08:00`);

  // Step 2: parallel fetch of all enrichment sources
  const [
    t86Raw,
    tpexInstiRaw,
    twseDayTradeRaw,
    tpexDayTradeRaw,
    twseNoticeRaw,
    twsePunishRaw,
    tpexNoticeRaw,
    tpexDisposalRaw,
    microInstiRaw,
    microTotalOIRaw,
    taiexRaw,
    tpexIndexRaw,
    twseIssuedSharesRaw,
    tpexIssuedSharesRaw,
    bfi82uRaw,
  ] = await Promise.all([
    fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${rawDate}&selectType=ALL`)
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] T86 failed:", e.message); return null; }),
    fetch("https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&response=json")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TPEx insti failed:", e.message); return null; }),
    fetch(`https://www.twse.com.tw/exchangeReport/TWTB4U?response=json&date=${rawDate}&selectType=All`)
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TWTB4U failed:", e.message); return null; }),
    fetch("https://www.tpex.org.tw/openapi/v1/tpex_intraday_trading_statistics")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TPEx day trade stat failed:", e.message); return null; }),
    fetch("https://openapi.twse.com.tw/v1/announcement/notice")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TWSE notice failed:", e.message); return null; }),
    fetch("https://openapi.twse.com.tw/v1/announcement/punish")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TWSE punish failed:", e.message); return null; }),
    fetch("https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TPEx notice failed:", e.message); return null; }),
    fetch("https://www.tpex.org.tw/openapi/v1/tpex_disposal_information")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TPEx disposal failed:", e.message); return null; }),
    fetch("https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] Micro insti OI failed:", e.message); return null; }),
    fetch("https://openapi.taifex.com.tw/v1/DailyMarketReportFut")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] DailyMarketReportFut failed:", e.message); return null; }),
    fetch("https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] FMTQIK failed:", e.message); return null; }),
    fetch("https://www.tpex.org.tw/openapi/v1/tpex_daily_trading_index")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TPEx daily index failed:", e.message); return null; }),
    fetch("https://openapi.twse.com.tw/v1/opendata/t187ap03_L")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TWSE issued shares failed:", e.message); return null; }),
    fetch("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] TPEx issued shares failed:", e.message); return null; }),
    fetch("https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&type=day")
      .then((r) => r.json())
      .catch((e) => { console.warn("[warn] BFI82U failed:", e.message); return null; }),
  ]);

  // ---------------------------------------------------------------------------
  // Parse enrichment data
  // ---------------------------------------------------------------------------

  // Institutional chips
  const twseInstiMap = t86Raw ? parseT86(t86Raw) : new Map();
  const tpexInstiMap = tpexInstiRaw ? parseTpexInsti(tpexInstiRaw) : new Map();
  console.log(`法人資料：TWSE ${twseInstiMap.size} 筆，TPEx ${tpexInstiMap.size} 筆`);

  // Issued shares (for foreignRatio computation)
  const issuedSharesMap = parseIssuedShares(twseIssuedSharesRaw, tpexIssuedSharesRaw);
  console.log(`已發行股數：共 ${issuedSharesMap.size} 檔`);

  // Day trade
  const { twseVolumePct, perStock: dayTradeMap } = twseDayTradeRaw
    ? parseDayTrade(twseDayTradeRaw)
    : { twseVolumePct: null, perStock: new Map<string, number>() };

  let tpexVolumePct: number | null = null;
  if (Array.isArray(tpexDayTradeRaw) && tpexDayTradeRaw.length > 0) {
    const last = tpexDayTradeRaw[tpexDayTradeRaw.length - 1];
    const pctStr = last?.DayTradingVolumeOfTheMarket;
    if (pctStr) tpexVolumePct = parseFloat(pctStr.replace("%", ""));
  }
  console.log(`當沖比重：TWSE ${twseVolumePct ?? "N/A"}%，TPEx ${tpexVolumePct ?? "N/A"}%`);

  // TWSE attention stocks
  const twseAttentionSet = new Set<string>();
  if (Array.isArray(twseNoticeRaw)) {
    for (const item of twseNoticeRaw) {
      const code = (item?.Code || "").trim();
      if (code) twseAttentionSet.add(code);
    }
  }

  // TWSE disposition stocks (check if tradingDate is in period)
  const twseDispositionSet = new Set<string>();
  if (Array.isArray(twsePunishRaw)) {
    for (const item of twsePunishRaw) {
      const code = (item?.Code || "").trim();
      const period = item?.DispositionPeriod || "";
      if (!code || !period) continue;
      const parsed = parseDispositionPeriod(period, "slash");
      if (!parsed) continue;
      if (tradingDateObj >= parsed.start && tradingDateObj <= parsed.end) {
        twseDispositionSet.add(code);
      }
    }
  }

  // TPEx attention stocks
  const tpexAttentionSet = new Set<string>();
  if (Array.isArray(tpexNoticeRaw)) {
    for (const item of tpexNoticeRaw) {
      const code = (item?.SecuritiesCompanyCode || "").trim();
      if (code) tpexAttentionSet.add(code);
    }
  }

  // TPEx disposition stocks
  const tpexDispositionSet = new Set<string>();
  if (Array.isArray(tpexDisposalRaw)) {
    for (const item of tpexDisposalRaw) {
      const code = (item?.SecuritiesCompanyCode || "").trim();
      const period = item?.DispositionPeriod || "";
      if (!code || !period) continue;
      const parsed = parseDispositionPeriod(period, "compact");
      if (!parsed) continue;
      if (tradingDateObj >= parsed.start && tradingDateObj <= parsed.end) {
        tpexDispositionSet.add(code);
      }
    }
  }

  // Micro futures retail
  const microRetail: MicroRetail | null =
    microInstiRaw && microTotalOIRaw
      ? computeMicroRetail(microInstiRaw, microTotalOIRaw)
      : null;
  if (microRetail) {
    console.log(
      `微臺散戶淨比：${microRetail.retailNetPct.toFixed(2)}% (totalOI=${microRetail.totalOI}, dataDate=${microRetail.dataDate})`,
    );
  } else {
    console.warn("[warn] 微臺散戶資料不可用");
  }

  // Market indices
  let taiex: MarketIndex | null = null;
  if (taiexRaw?.data && Array.isArray(taiexRaw.data) && taiexRaw.data.length > 0) {
    const last = taiexRaw.data[taiexRaw.data.length - 1];
    const close = parseFloat((last[4] || "").replace(/,/g, ""));
    const change = parseFloat((last[5] || "").replace(/,/g, ""));
    const amount = parseFloat((last[2] || "").replace(/,/g, ""));
    if (!isNaN(close) && !isNaN(change)) {
      taiex = { close, change, amount: isNaN(amount) ? 0 : amount };
    }
  }

  let tpexIndex: MarketIndex | null = null;
  if (Array.isArray(tpexIndexRaw) && tpexIndexRaw.length > 0) {
    const last = tpexIndexRaw[tpexIndexRaw.length - 1];
    const close = parseFloat(last?.TPExIndex || "");
    const change = parseFloat(last?.Change || "");
    const amount = parseFloat((last?.TradeAmount || "").replace(/,/g, ""));
    if (!isNaN(close) && !isNaN(change)) {
      tpexIndex = { close, change, amount: isNaN(amount) ? 0 : amount };
    }
  }

  // ---------------------------------------------------------------------------
  // Build volume map from TWSE (row[2] = shares)
  const twseVolumeMap = new Map<string, number>();
  for (const s of twseStocks) {
    if (s.volume !== undefined) twseVolumeMap.set(s.code, s.volume);
  }

  // Enrich each stock
  function enrichStocks(stocks: Stock[], isTwse: boolean): Stock[] {
    return stocks.map((s) => {
      const enriched: Stock = { ...s };

      // chips
      const chips = isTwse ? twseInstiMap.get(s.code) : tpexInstiMap.get(s.code);
      if (chips) {
        const issuedShares = issuedSharesMap.get(s.code);
        if (issuedShares && issuedShares > 0) {
          const foreignRatio = Math.round(chips.foreignNet * 1000 / issuedShares * 100 * 100) / 100;
          const trustRatio = Math.round(chips.trustNet * 1000 / issuedShares * 100 * 100) / 100;
          enriched.chips = { ...chips, foreignRatio, trustRatio };
        } else {
          enriched.chips = chips;
        }
      }

      // day trade ratio (TWSE only)
      if (isTwse) {
        const dtShares = dayTradeMap.get(s.code);
        const totalShares = s.volume;
        if (dtShares !== undefined && totalShares && totalShares > 0) {
          enriched.dayTradeRatio = (dtShares / totalShares) * 100;
        }
      }

      // flags
      const attention = isTwse ? twseAttentionSet.has(s.code) : tpexAttentionSet.has(s.code);
      const disposition = isTwse ? twseDispositionSet.has(s.code) : tpexDispositionSet.has(s.code);
      const amountNum = parseFloat(s.amount);
      const lowLiquidity = !isNaN(amountNum) && amountNum < 50_000_000;

      if (attention || disposition || lowLiquidity) {
        enriched.flags = {};
        if (attention) enriched.flags.attention = true;
        if (disposition) enriched.flags.disposition = true;
        if (lowLiquidity) enriched.flags.lowLiquidity = true;
      }

      return enriched;
    });
  }

  const enrichedTwse = enrichStocks(twseStocks, true);
  const enrichedTpex = enrichStocks(tpexStocks, false);

  const allStocksEnriched = [...enrichedTwse, ...enrichedTpex].map((s) =>
    futuresMap[s.code] ? { ...s, futures: futuresMap[s.code] } : s,
  );

  if (allStocksEnriched.length === 0) {
    console.error("No market data available today.");
    process.exit(1);
  }

  // Breadth
  const breadth = computeBreadth(allStocksEnriched);
  console.log(
    `Breadth：漲${breadth.up} 跌${breadth.down} 平${breadth.flat} 漲停${breadth.limitUp} 跌停${breadth.limitDown}`,
  );

  // ---------------------------------------------------------------------------
  // Compute buy streaks: fetch past 4 trading days (today already in hand)
  // and combine to get 5-day history per stock.
  // ---------------------------------------------------------------------------
  {
    // Generate candidate calendar dates going back from tradingDate
    const [ty, tm, td] = tradingDate.split("-").map(Number);
    const todayMs = new Date(ty, tm - 1, td).getTime();
    const oneDayMs = 86400_000;
    const candidateDates: string[] = [];
    for (let i = 1; i <= 12 && candidateDates.length < 4; i++) {
      const d = new Date(todayMs - i * oneDayMs);
      const yy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      candidateDates.push(`${yy}-${mm}-${dd}`);
    }

    // Fetch TWSE T86 and TPEx insti for each candidate date in parallel
    type InstiDayResult = { date: string; twse: Map<string, { foreignNet: number; trustNet: number }>; tpex: Map<string, { foreignNet: number; trustNet: number }> } | null;
    const historicalFetches: Promise<InstiDayResult>[] = candidateDates.map((isoDate) => {
      const compact = isoDate.replace(/-/g, "");
      const tpexFmt = `${isoDate.slice(0, 4)}/${isoDate.slice(5, 7)}/${isoDate.slice(8, 10)}`;
      return Promise.all([
        fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${compact}&selectType=ALL`)
          .then((r) => r.json())
          .catch(() => null),
        fetch(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&date=${tpexFmt}&response=json`)
          .then((r) => r.json())
          .catch(() => null),
      ]).then(([twseJson, tpexJson]): InstiDayResult => {
        const twseMap = twseJson ? parseT86(twseJson) : new Map();
        const tpexMap = tpexJson ? parseTpexInsti(tpexJson) : new Map();
        if (twseMap.size === 0 && tpexMap.size === 0) return null; // non-trading day
        return { date: isoDate, twse: twseMap, tpex: tpexMap };
      }).catch(() => null);
    });

    const historicalResults = await Promise.all(historicalFetches);
    // Keep only valid trading days, sorted newest→oldest (index 0 = day before tradingDate)
    const validHistorical = historicalResults.filter((r): r is NonNullable<InstiDayResult> => r !== null);
    console.log(`連買史料：抓到 ${validHistorical.length} 個歷史交易日（最多 4 日）`);

    // Build per-stock per-day nets: day[0]=tradingDate, day[1]=most recent past, ...
    // Today's data is already in twseInstiMap / tpexInstiMap
    const allDayMaps: Array<{ date: string; twse: Map<string, { foreignNet: number; trustNet: number }>; tpex: Map<string, { foreignNet: number; trustNet: number }> }> = [
      { date: tradingDate, twse: twseInstiMap, tpex: tpexInstiMap },
      ...validHistorical,
    ];

    // For each stock, compute streaks
    for (const s of allStocksEnriched) {
      if (!s.chips) continue;
      const isTwse = twseInstiMap.has(s.code);
      const foreignPerDay = allDayMaps.map((day) => ({
        date: day.date,
        net: (isTwse ? day.twse : day.tpex).get(s.code)?.foreignNet ?? 0,
      }));
      const trustPerDay = allDayMaps.map((day) => ({
        date: day.date,
        net: (isTwse ? day.twse : day.tpex).get(s.code)?.trustNet ?? 0,
      }));
      const foreignBuyStreak = computeBuyStreak(foreignPerDay);
      const trustBuyStreak = computeBuyStreak(trustPerDay);
      if (foreignBuyStreak > 0 || trustBuyStreak > 0) {
        s.chips = { ...s.chips, foreignBuyStreak, trustBuyStreak };
      }
    }

    // Print a sample streak for verification
    const streakSamples = allStocksEnriched
      .filter((s) => s.chips && ((s.chips.foreignBuyStreak ?? 0) >= 3 || (s.chips.trustBuyStreak ?? 0) >= 3))
      .slice(0, 3);
    for (const s of streakSamples) {
      console.log(`連買範例：${s.name}(${s.code}) 外資連買${s.chips!.foreignBuyStreak ?? 0}日 投信連買${s.chips!.trustBuyStreak ?? 0}日 trustRatio=${s.chips!.trustRatio ?? "N/A"}%`);
    }
  }

  const stockMap: Record<string, { pct: string; futures?: { level: string; margin: string }; chips?: Stock["chips"]; flags?: Stock["flags"]; dayTradeRatio?: number }> = {};
  for (const s of allStocksEnriched) {
    const sign = s.pct > 0 ? "+" : "";
    stockMap[s.code] = {
      pct: `${sign}${s.pct.toFixed(2)}%`,
      futures: s.futures,
      chips: s.chips,
      flags: s.flags,
      dayTradeRatio: s.dayTradeRatio,
    };
  }

  const gainers = [...allStocksEnriched].sort((a, b) => b.pct - a.pct).slice(0, 100);
  const losers = [...allStocksEnriched].sort((a, b) => a.pct - b.pct).slice(0, 100);

  const closeMap: Record<string, number> = {};
  for (const s of allStocksEnriched) {
    closeMap[s.code] = s.close;
  }

  const result = {
    gainers,
    losers,
    stockMap,
    closeMap,
    timestamp,
    tradingDate,
    market: {
      taiex,
      tpex: tpexIndex,
      breadth,
      dayTrade: { twseVolumePct, tpexVolumePct },
      microFuturesRetail: microRetail,
      institutional: bfi82uRaw ? parseBFI82U(bfi82uRaw) : null,
    },
  };

  const outPath = resolve(process.cwd(), "data/market-latest.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`Wrote ${allStocksEnriched.length} stocks to ${outPath}`);
  console.log(`Trading date: ${tradingDate} (timestamp: ${timestamp})`);
  console.log(`Top gainer: ${gainers[0].name}(${gainers[0].code}) ${gainers[0].pct.toFixed(2)}%`);
  console.log(`Top loser:  ${losers[0].name}(${losers[0].code}) ${losers[0].pct.toFixed(2)}%`);
}

main().catch((err) => {
  console.error("Fetch failed:", err);
  process.exit(1);
});
