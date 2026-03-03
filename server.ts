import express from "express";
import { createServer as createViteServer } from "vite";

let cachedMarketData: any = null;
let lastFetchTime: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

async function fetchMarketData() {
  const now = Date.now();
  if (cachedMarketData && (now - lastFetchTime < CACHE_TTL)) {
    console.log("Using cached market data");
    return cachedMarketData;
  }

  console.log("Fetching fresh market data...");
  const [twseRes, tpexRes, futuresRes] = await Promise.all([
    fetch("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json"),
    fetch("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?response=json"),
    fetch("https://openapi.taifex.com.tw/v1/SingleStockFuturesMargining")
  ]);

  const twseData = await twseRes.json();
  const tpexData = await tpexRes.json();
  const futuresData = await futuresRes.json().catch(() => []);

  const futuresMap: Record<string, { level: string, margin: string }> = {};
  if (Array.isArray(futuresData)) {
    futuresData.forEach((f: any) => {
      if (f.UnderlyingSecurityCode) {
        futuresMap[f.UnderlyingSecurityCode] = {
          level: f.GroupLevel,
          margin: f.InitialMarginRate
        };
      }
    });
  }

  const twseStocks = processTwseData(twseData);
  const tpexStocks = processTpexData(tpexData);
  const allStocks = [...twseStocks, ...tpexStocks].map(s => {
    if (futuresMap[s.code]) {
      return { ...s, futures: futuresMap[s.code] };
    }
    return s;
  });

  if (allStocks.length === 0) {
    throw new Error("No market data available today.");
  }

  const stockMap: Record<string, any> = {};
  allStocks.forEach(s => {
    const sign = s.pct > 0 ? "+" : "";
    stockMap[s.code] = {
      pct: `${sign}${s.pct.toFixed(2)}%`,
      futures: s.futures
    };
  });

  const gainers = [...allStocks].sort((a, b) => b.pct - a.pct).slice(0, 100);
  const losers = [...allStocks].sort((a, b) => a.pct - b.pct).slice(0, 100);

  const result = {
    gainers,
    losers,
    stockMap,
    timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })
  };

  cachedMarketData = result;
  lastFetchTime = now;

  return result;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get("/api/market-data", async (req, res) => {
    try {
      const data = await fetchMarketData();
      res.json(data);
    } catch (error: any) {
      console.error("Error fetching market data:", error);
      if (error.message === "No market data available today.") {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Failed to fetch market data" });
      }
    }
  });

  app.get("/api/cron-report", async (req, res) => {
    const token = req.query.token;
    const expectedToken = process.env.CRON_SECRET || "my-secret-token";
    
    if (token !== expectedToken) {
      return res.status(401).send("Unauthorized");
    }

    try {
      const data = await fetchMarketData();
      
      const { classifyStocks, fetchCategoryStory, generateSummary } = await import("./src/services/aiService.js");
      
      const [gainers, losers] = await Promise.all([
        classifyStocks(data.gainers, '強勢股'),
        classifyStocks(data.losers, '弱勢股')
      ]);

      const gainersWithStoriesPromise = Promise.all(
        gainers.map(async (g) => {
          if (g.stocks.length >= 2) {
            try {
              const story = await fetchCategoryStory(g.category, g.stocks, '上漲');
              return { ...g, story };
            } catch (e) {
              return g;
            }
          }
          return g;
        })
      );

      const losersWithStoriesPromise = Promise.all(
        losers.map(async (g) => {
          if (g.stocks.length >= 3) {
            try {
              const story = await fetchCategoryStory(g.category, g.stocks, '下跌');
              return { ...g, story };
            } catch (e) {
              return g;
            }
          }
          return g;
        })
      );

      const [gainersWithStories, losersWithStories] = await Promise.all([
        gainersWithStoriesPromise,
        losersWithStoriesPromise
      ]);

      const marketSummary = await generateSummary(gainersWithStories, losersWithStories);

      // Generate HTML
      let html = `
        <div style="font-family: sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
          <h2 style="color: #4f46e5; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📈 台股盤後資金流向與 AI 總結 (${data.timestamp})</h2>
          
          <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="margin-top: 0; color: #1f2937;">📝 盤後總結</h3>
            <p style="line-height: 1.6; margin-bottom: 0;">${marketSummary.replace(/\n/g, '<br>')}</p>
          </div>

          <h3 style="color: #dc2626;">🔥 強勢焦點 (量大優先)</h3>
      `;

      gainersWithStories.forEach(g => {
        html += `
          <div style="border: 1px solid #fee2e2; background-color: #fff5f5; padding: 16px; border-radius: 12px; margin-bottom: 16px;">
            <h4 style="margin-top: 0; margin-bottom: 12px; color: #111827; font-size: 16px; display: flex; align-items: center;">
              <span style="background-color: #fecaca; color: #991b1b; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 8px; font-weight: normal;">${g.stocks.length}檔</span>
              ${g.category}
            </h4>
            <div style="margin-bottom: 0;">
        `;
        
        g.stocks.forEach(stockStr => {
          const match = stockStr.match(/\((.*?)\)/);
          let code = '';
          let pct = '';
          let futuresInfo = null;
          if (match) {
            code = match[1];
            const stockData = data.stockMap[code];
            if (stockData) {
              pct = stockData.pct;
              futuresInfo = stockData.futures;
            }
          }
          
          const cleanName = stockStr.replace(/\(.*?\)/, '');
          const futuresHtml = futuresInfo ? `<span style="font-size: 10px; background-color: #e0e7ff; color: #4338ca; padding: 2px 4px; border-radius: 4px; margin-left: 4px;">期貨(${futuresInfo.margin})</span>` : '';
          
          html += `<a href="https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis" target="_blank" style="text-decoration: none; display: inline-block; background-color: #ffffff; border: 1px solid #e5e7eb; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
            <strong style="color: #1f2937; font-weight: 500;">${cleanName}</strong> <span style="color: #6b7280; font-size: 12px;">${code}</span> 
            <span style="color: #dc2626; font-weight: bold; margin-left: 4px;">${pct}</span>
            ${futuresHtml}
          </a>`;
        });

        html += `</div>`;

        if (g.story) {
          html += `
            <div style="background-color: transparent; padding: 12px; border-radius: 8px; border: 1px solid #fca5a5; margin-top: 12px;">
              <strong style="color: #991b1b; font-size: 13px; display: block; margin-bottom: 4px;">💡 產業故事與上漲原因：</strong>
              <p style="margin: 0; font-size: 13px; color: #374151; line-height: 1.6;">${g.story}</p>
            </div>
          `;
        }

        html += `</div>`;
      });

      html += `
          <h3 style="color: #16a34a; margin-top: 30px;">🧊 弱勢焦點 (量大優先)</h3>
      `;

      losersWithStories.forEach(g => {
        html += `
          <div style="border: 1px solid #dcfce7; background-color: #f0fdf4; padding: 16px; border-radius: 12px; margin-bottom: 16px;">
            <h4 style="margin-top: 0; margin-bottom: 12px; color: #111827; font-size: 16px; display: flex; align-items: center;">
              <span style="background-color: #bbf7d0; color: #166534; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 8px; font-weight: normal;">${g.stocks.length}檔</span>
              ${g.category}
            </h4>
            <div style="margin-bottom: 0;">
        `;
        
        g.stocks.forEach(stockStr => {
          const match = stockStr.match(/\((.*?)\)/);
          let code = '';
          let pct = '';
          let futuresInfo = null;
          if (match) {
            code = match[1];
            const stockData = data.stockMap[code];
            if (stockData) {
              pct = stockData.pct;
              futuresInfo = stockData.futures;
            }
          }
          
          const cleanName = stockStr.replace(/\(.*?\)/, '');
          const futuresHtml = futuresInfo ? `<span style="font-size: 10px; background-color: #e0e7ff; color: #4338ca; padding: 2px 4px; border-radius: 4px; margin-left: 4px;">期貨(${futuresInfo.margin})</span>` : '';
          
          html += `<a href="https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis" target="_blank" style="text-decoration: none; display: inline-block; background-color: #ffffff; border: 1px solid #e5e7eb; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
            <strong style="color: #1f2937; font-weight: 500;">${cleanName}</strong> <span style="color: #6b7280; font-size: 12px;">${code}</span> 
            <span style="color: #16a34a; font-weight: bold; margin-left: 4px;">${pct}</span>
            ${futuresHtml}
          </a>`;
        });

        html += `</div>`;

        if (g.story) {
          html += `
            <div style="background-color: transparent; padding: 12px; border-radius: 8px; border: 1px solid #86efac; margin-top: 12px;">
              <strong style="color: #166534; font-size: 13px; display: block; margin-bottom: 4px;">💡 產業故事與下跌原因：</strong>
              <p style="margin: 0; font-size: 13px; color: #374151; line-height: 1.6;">${g.story}</p>
            </div>
          `;
        }

        html += `</div>`;
      });

      html += `
          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px;">
            Generated by AI Studio • Gemini 3.1 Pro & 2.5 Flash
          </div>
        </div>
      `;

      res.send(html);
    } catch (error: any) {
      console.error("Error generating cron report:", error);
      res.status(500).send("Failed to generate report: " + error.message);
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
