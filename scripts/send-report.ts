import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "dotenv/config";
import dotenv from "dotenv";
dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true });

interface CategoryGroup {
  category: string;
  stocks: string[];
  story?: string;
}

interface StockMeta {
  pct: string;
  futures?: { level: string; margin: string };
}

interface MarketStock {
  code: string;
  name: string;
}

interface Analysis {
  timestamp: string;
  date: string;
  stockMap?: Record<string, StockMeta>;
  gainers: CategoryGroup[];
  losers: CategoryGroup[];
  summary: string;
  longTermStrategy?: string;
}

interface HistoryRecord {
  date: string;
  summary: string;
  gainerCategories: string[];
  loserCategories: string[];
}

interface StockLookup {
  code: string;
  name: string;
  meta?: StockMeta;
}

const HISTORY_MAX = 5;
const EMAIL_SUBJECT = "📈 台股盤後資金流向與 AI 總結";
const EMAIL_TO = "hchs200771@gmail.com";

function buildStockLookup(market: { gainers?: MarketStock[]; losers?: MarketStock[] }): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const stock of [...(market.gainers ?? []), ...(market.losers ?? [])]) {
    lookup.set(stock.name, stock.code);
  }
  return lookup;
}

function resolveStock(stockStr: string, stockMap: Record<string, StockMeta>, codeByName: Map<string, string>): StockLookup {
  const match = stockStr.match(/\((.*?)\)/);
  const rawName = stockStr.replace(/\(.*?\)/, "").trim();
  const code = match?.[1] ?? codeByName.get(rawName) ?? "";
  return {
    code,
    name: rawName,
    meta: code ? stockMap[code] : undefined,
  };
}

function renderFuturesBadge(meta?: StockMeta): string {
  if (!meta?.futures) return "";
  const label = [meta.futures.level, meta.futures.margin].filter(Boolean).join(" ");
  return `<span style="font-size: 10px; background-color: #e0e7ff; color: #4338ca; padding: 2px 4px; border-radius: 4px; margin-left: 4px;">期貨(${label})</span>`;
}

function renderCategoryBlock(
  g: CategoryGroup,
  stockMap: Record<string, StockMeta>,
  codeByName: Map<string, string>,
  kind: "gainer" | "loser",
): string {
  const borderColor = kind === "gainer" ? "#fee2e2" : "#dcfce7";
  const bgColor = kind === "gainer" ? "#fef2f2" : "#f0fdf4";
  const headerColor = kind === "gainer" ? "#991b1b" : "#166534";
  const chipBg = kind === "gainer" ? "#fecaca" : "#bbf7d0";
  const stockBorder = kind === "gainer" ? "#fca5a5" : "#86efac";
  const pctColor = kind === "gainer" ? "#dc2626" : "#16a34a";
  const storyLabelColor = kind === "gainer" ? "#991b1b" : "#166534";
  const storyTextColor = kind === "gainer" ? "#b91c1c" : "#15803d";
  const storyBorder = kind === "gainer" ? "#fecaca" : "#bbf7d0";
  const storyLabel =
    kind === "gainer" ? "💡 產業故事與上漲原因：" : "💡 產業故事與下跌原因：";

  let stocksHtml = "";
  for (const stockStr of g.stocks) {
    const { code, name, meta } = resolveStock(stockStr, stockMap, codeByName);
    const pct = meta?.pct ?? "";
    const futuresHtml = renderFuturesBadge(meta);
    const href = code ? `https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis` : "#";
    const codeHtml = code ? `<span style="color: #6b7280; font-size: 12px;">${code}</span>` : "";
    stocksHtml += `<a href="${href}" target="_blank" style="text-decoration: none; display: inline-block; background-color: white; border: 1px solid ${stockBorder}; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
      <strong style="color: #1f2937;">${name}</strong> ${codeHtml}
      <span style="color: ${pctColor}; font-weight: bold; margin-left: 4px;">${pct}</span>
      ${futuresHtml}
    </a>`;
  }

  const storyHtml = g.story
    ? `<div style="background-color: ${bgColor}; padding: 10px; border-radius: 6px; border: 1px solid ${storyBorder};">
        <strong style="color: ${storyLabelColor}; font-size: 13px;">${storyLabel}</strong>
        <p style="margin: 5px 0 0 0; font-size: 13px; color: ${storyTextColor}; line-height: 1.5;">${g.story}</p>
      </div>`
    : "";

  return `<div style="border: 1px solid ${borderColor}; background-color: ${bgColor}; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
    <h4 style="margin-top: 0; color: ${headerColor}; display: flex; align-items: center;">
      <span style="background-color: ${chipBg}; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 8px;">${g.stocks.length}檔</span>
      ${g.category}
    </h4>
    <div style="margin-bottom: 10px;">${stocksHtml}</div>
    ${storyHtml}
  </div>`;
}

function renderHtml(a: Analysis, stockMap: Record<string, StockMeta>, codeByName: Map<string, string>): string {
  const gainersHtml = a.gainers.map((g) => renderCategoryBlock(g, stockMap, codeByName, "gainer")).join("");
  const losersHtml = a.losers.map((g) => renderCategoryBlock(g, stockMap, codeByName, "loser")).join("");
  const longTermStrategyHtml = a.longTermStrategy
    ? `<div style="background-color: #eef6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1d4ed8;">🧭 長線策略與進出場</h3>
      <p style="line-height: 1.7; margin-bottom: 0; color: #1e3a8a;">${a.longTermStrategy.replace(/\n/g, "<br>")}</p>
    </div>`
    : "";

  return `<div style="font-family: sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
    <h2 style="color: #4f46e5; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📈 台股盤後資金流向與 AI 總結 (${a.timestamp})</h2>
    <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1f2937;">📝 盤後總結</h3>
      <p style="line-height: 1.6; margin-bottom: 0;">${a.summary.replace(/\n/g, "<br>")}</p>
    </div>
    ${longTermStrategyHtml}
    <h3 style="color: #dc2626;">🔥 強勢焦點 (量大優先)</h3>
    ${gainersHtml}
    <h3 style="color: #16a34a; margin-top: 30px;">🧊 弱勢焦點 (量大優先)</h3>
    ${losersHtml}
    <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px;">
      Generated via Claude Code workflow
    </div>
  </div>`;
}

function updateHistory(a: Analysis): void {
  const historyPath = resolve(process.cwd(), "data/history.json");
  let history: HistoryRecord[] = [];
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(readFileSync(historyPath, "utf-8"));
    } catch (e) {
      console.warn("history.json unreadable, starting fresh");
    }
  }
  const record: HistoryRecord = {
    date: a.date,
    summary: a.summary,
    gainerCategories: a.gainers.map((g) => g.category),
    loserCategories: a.losers.map((g) => g.category),
  };
  const filtered = history.filter((h) => h.date !== a.date);
  filtered.unshift(record);
  const trimmed = filtered.slice(0, HISTORY_MAX);
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, JSON.stringify(trimmed, null, 2), "utf-8");
  console.log(`Updated history (${trimmed.length} records) at ${historyPath}`);
}

async function sendEmail(html: string): Promise<void> {
  const url = process.env.GAS_WEBHOOK_URL;
  if (!url) {
    throw new Error("GAS_WEBHOOK_URL env var is not set");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      to: EMAIL_TO,
      subject: EMAIL_SUBJECT,
      htmlBody: html,
    }),
  });
  if (!res.ok) {
    throw new Error(`GAS webhook returned ${res.status}: ${await res.text()}`);
  }
  console.log(`Email webhook responded ${res.status}`);
}

async function main() {
  const inputPath = process.argv[2] ?? "data/analysis-latest.json";
  const resolved = resolve(process.cwd(), inputPath);
  if (!existsSync(resolved)) {
    console.error(`Analysis file not found: ${resolved}`);
    process.exit(1);
  }
  const analysis: Analysis = JSON.parse(readFileSync(resolved, "utf-8"));

  const marketPath = resolve(process.cwd(), "data/market-latest.json");
  let stockMap: Record<string, StockMeta> = analysis.stockMap ?? {};
  let codeByName = new Map<string, string>();
  if (existsSync(marketPath)) {
    try {
      const market = JSON.parse(readFileSync(marketPath, "utf-8"));
      stockMap = market.stockMap ?? stockMap;
      codeByName = buildStockLookup(market);
    } catch {
      // fall back to analysis.stockMap
    }
  }

  const html = renderHtml(analysis, stockMap, codeByName);

  const htmlOutPath = resolve(process.cwd(), "data/report-latest.html");
  writeFileSync(htmlOutPath, html, "utf-8");
  console.log(`Wrote HTML preview to ${htmlOutPath}`);

  updateHistory(analysis);

  const shouldSend = !process.argv.includes("--no-email");
  if (shouldSend) {
    await sendEmail(html);
  } else {
    console.log("Skipped email (--no-email flag)");
  }
}

main().catch((err) => {
  console.error("send-report failed:", err);
  process.exit(1);
});
