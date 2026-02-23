import express from "express";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get("/api/market-data", async (req, res) => {
    try {
      const [twseRes, tpexRes] = await Promise.all([
        fetch("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json"),
        fetch("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?response=json")
      ]);

      const twseData = await twseRes.json();
      const tpexData = await tpexRes.json();

      const twseStocks = processTwseData(twseData);
      const tpexStocks = processTpexData(tpexData);
      const allStocks = [...twseStocks, ...tpexStocks];

      if (allStocks.length === 0) {
        return res.status(404).json({ error: "No market data available today." });
      }

      const stockMap: Record<string, string> = {};
      allStocks.forEach(s => {
        const sign = s.pct > 0 ? "+" : "";
        stockMap[s.code] = `${sign}${s.pct.toFixed(2)}%`;
      });

      const gainers = [...allStocks].sort((a, b) => b.pct - a.pct).slice(0, 100);
      const losers = [...allStocks].sort((a, b) => a.pct - b.pct).slice(0, 100);

      res.json({
        gainers,
        losers,
        stockMap,
        timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })
      });
    } catch (error) {
      console.error("Error fetching market data:", error);
      res.status(500).json({ error: "Failed to fetch market data" });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

function processTwseData(json: any) {
  if (!json.data) return [];
  return json.data.map((row: any) => {
    const code = row[0];
    const name = row[1];
    const amountRaw = row[3].replace(/,/g, ""); 
    const close = parseFloat(row[7].replace(/,/g, ""));
    
    let changeStr = row[8].replace(/<[^>]*>?/gm, '').replace(/,/g, "");
    let change = changeStr.includes("+") ? parseFloat(changeStr.replace("+", "")) : parseFloat(changeStr);

    if (isNaN(close) || isNaN(change) || close === 0) return null;

    const prevClose = close - change;
    const pct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return { code, name, pct, close, amount: amountRaw }; 
  }).filter((s: any) => s !== null);
}

function processTpexData(json: any) {
  let data = [];
  if (json.tables && json.tables.length > 0) data = json.tables[0].data;
  else if (json.data) data = json.data;
  else if (json.aaData) data = json.aaData;

  if (!data || data.length === 0) return [];

  return data.map((row: any) => {
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
  }).filter((s: any) => s !== null);
}

startServer();
