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

interface Analysis {
  timestamp: string;
  date: string;
  stockMap?: Record<string, StockMeta>;
  gainers: CategoryGroup[];
  losers: CategoryGroup[];
  summary: string;
}

interface HistoryRecord {
  date: string;
  summary: string;
  gainerCategories: string[];
  loserCategories: string[];
}

const HISTORY_MAX = 5;
const EMAIL_SUBJECT = "📈 台股盤後資金流向與 AI 總結";
const EMAIL_TO = "hchs200771@gmail.com";

function renderCategoryBlock(
  g: CategoryGroup,
  stockMap: Record<string, StockMeta>,
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
    const match = stockStr.match(/\((.*?)\)/);
    const code = match ? match[1] : "";
    const meta = code ? stockMap[code] : undefined;
    const pct = meta?.pct ?? "";
    const futuresHtml = meta?.futures
      ? `<span style="font-size: 10px; background-color: #e0e7ff; color: #4338ca; padding: 2px 4px; border-radius: 4px; margin-left: 4px;">期貨(${meta.futures.margin})</span>`
      : "";
    const cleanName = stockStr.replace(/\(.*?\)/, "");
    stocksHtml += `<a href="https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis" target="_blank" style="text-decoration: none; display: inline-block; background-color: white; border: 1px solid ${stockBorder}; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
      <strong style="color: #1f2937;">${cleanName}</strong> <span style="color: #6b7280; font-size: 12px;">${code}</span>
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

function renderHtml(a: Analysis, stockMap: Record<string, StockMeta>): string {
  const gainersHtml = a.gainers.map((g) => renderCategoryBlock(g, stockMap, "gainer")).join("");
  const losersHtml = a.losers.map((g) => renderCategoryBlock(g, stockMap, "loser")).join("");

  return `<div style="font-family: sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
    <h2 style="color: #4f46e5; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📈 台股盤後資金流向與 AI 總結 (${a.timestamp})</h2>
    <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1f2937;">📝 盤後總結</h3>
      <p style="line-height: 1.6; margin-bottom: 0;">${a.summary.replace(/\n/g, "<br>")}</p>
    </div>
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
  if (existsSync(marketPath)) {
    try {
      const market = JSON.parse(readFileSync(marketPath, "utf-8"));
      stockMap = market.stockMap ?? stockMap;
    } catch {
      // fall back to analysis.stockMap
    }
  }

  const html = renderHtml(analysis, stockMap);

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
