import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Stock {
  code: string;
  name: string;
  pct: number;
  close: number;
  amount: string;
  futures?: { level: string; margin: string };
}

function processTwseData(json: any): Stock[] {
  if (!json.data) return [];
  return json.data
    .map((row: any) => {
      const code = row[0];
      const name = row[1];
      const amountRaw = row[3].replace(/,/g, "");
      const close = parseFloat(row[7].replace(/,/g, ""));
      const changeStr = row[8].replace(/<[^>]*>?/gm, "").replace(/,/g, "");
      const change = changeStr.includes("+")
        ? parseFloat(changeStr.replace("+", ""))
        : parseFloat(changeStr);
      if (isNaN(close) || isNaN(change) || close === 0) return null;
      const prevClose = close - change;
      const pct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
      return { code, name, pct, close, amount: amountRaw };
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
      const close = parseFloat(closeStr);
      const change = parseFloat(changeStr);
      if (isNaN(close) || isNaN(change) || close === 0) return null;
      const prevClose = close - change;
      const pct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
      return { code, name, pct, close, amount: amountStr };
    })
    .filter((s: Stock | null): s is Stock => s !== null);
}

function deriveTradingDate(twseData: any, tpexData: any): { tradingDate: string; timestamp: string } {
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
  };
}

async function main() {
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
  const allStocks = [...twseStocks, ...tpexStocks].map((s) =>
    futuresMap[s.code] ? { ...s, futures: futuresMap[s.code] } : s,
  );

  if (allStocks.length === 0) {
    console.error("No market data available today.");
    process.exit(1);
  }

  const stockMap: Record<string, { pct: string; futures?: { level: string; margin: string } }> = {};
  for (const s of allStocks) {
    const sign = s.pct > 0 ? "+" : "";
    stockMap[s.code] = { pct: `${sign}${s.pct.toFixed(2)}%`, futures: s.futures };
  }

  const gainers = [...allStocks].sort((a, b) => b.pct - a.pct).slice(0, 100);
  const losers = [...allStocks].sort((a, b) => a.pct - b.pct).slice(0, 100);

  // Derive trading date from API response (handles holidays — TWSE/TPEx return latest trading day)
  const { tradingDate, timestamp } = deriveTradingDate(twseData, tpexData);
  const result = { gainers, losers, stockMap, timestamp, tradingDate };

  const outPath = resolve(process.cwd(), "data/market-latest.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`Wrote ${allStocks.length} stocks to ${outPath}`);
  console.log(`Trading date: ${tradingDate} (timestamp: ${timestamp})`);
  console.log(`Top gainer: ${gainers[0].name}(${gainers[0].code}) ${gainers[0].pct.toFixed(2)}%`);
  console.log(`Top loser:  ${losers[0].name}(${losers[0].code}) ${losers[0].pct.toFixed(2)}%`);
}

main().catch((err) => {
  console.error("Fetch failed:", err);
  process.exit(1);
});
