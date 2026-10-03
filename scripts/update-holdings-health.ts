/**
 * 可選的獨立持股健檢工具：透過 Notion API 讀取「目前持股」、檢索近三日新聞並回寫。
 * 互動式每日任務改由代理使用 Notion connector 執行，本工具不在 report/launchd runner 內。
 *
 * 必要環境變數（放在 .env.local，勿提交）：
 *   NOTION_TOKEN
 *   NOTION_HOLDINGS_DATA_SOURCE_ID
 *
 * 此程式只更新「最新健檢」與「最後檢視」。它不讀取或輸出張數、成本或交易流水。
 */
import "dotenv/config";
import dotenv from "dotenv";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true });

const NOTION_VERSION = "2025-09-03";
const notionToken = process.env.NOTION_TOKEN;
const dataSourceId = process.env.NOTION_HOLDINGS_DATA_SOURCE_ID;

type Holding = {
  id: string;
  name: string;
  status: string;
  direction: string;
  thesis: string;
  stop: string;
  exitPlan: string;
};

function text(property: any): string {
  if (!property) return "";
  if (property.type === "title" || property.type === "rich_text") return (property[property.type] ?? []).map((x: any) => x.plain_text ?? x.text?.content ?? "").join("").trim();
  if (property.type === "select") return property.select?.name ?? "";
  return "";
}

function tradingDate(): string {
  const path = resolve(process.cwd(), "data/market-latest.json");
  if (!existsSync(path)) throw new Error("找不到 data/market-latest.json，無法判定本次交易日。");
  const date = JSON.parse(readFileSync(path, "utf8")).tradingDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("market-latest.json 缺少有效 tradingDate。");
  return date;
}

async function notion(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`Notion API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function loadHoldings(): Promise<Holding[]> {
  const data = await notion(`/data_sources/${dataSourceId}/query`, { method: "POST", body: JSON.stringify({ page_size: 100 }) });
  return (data.results ?? [])
    .map((page: any) => ({
      id: page.id,
      name: text(page.properties?.["標的"]),
      status: text(page.properties?.["狀態"]),
      direction: text(page.properties?.["方向"]),
      thesis: text(page.properties?.["持有理由"]),
      stop: text(page.properties?.["停損／失效條件"]),
      exitPlan: text(page.properties?.["出場計畫"]),
    }))
    .filter((holding: Holding) => holding.name && holding.status === "持有中");
}

function newsQueryName(name: string) {
  if (name.includes("國巨")) return "國巨";
  if (name.includes("聯電")) return "聯電";
  if (/AXT/i.test(name)) return "AXT AXTI";
  if (/Intel/i.test(name)) return "Intel";
  if (/Solaris|SEI/i.test(name)) return "Solaris Energy Infrastructure";
  return name.replace(/期貨/g, "").trim();
}

function xml(value: string) { return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").trim(); }

async function recentNews(name: string, date: string): Promise<string[]> {
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 2);
  const after = start.toISOString().slice(0, 10);
  const query = encodeURIComponent(`${newsQueryName(name)} after:${after}`);
  try {
    const response = await fetch(`https://news.google.com/rss/search?q=${query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) return [];
    const rss = await response.text();
    return [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 2).map((match) => {
      const title = match[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
      const source = match[1].match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "";
      return [xml(title), xml(source)].filter(Boolean).join("｜");
    }).filter(Boolean);
  } catch { return []; }
}

function quoteSymbol(name: string) {
  if (name.includes("期貨")) return null; // 不以現貨價格錯誤判定期貨的停損或目標價
  if (/AXT/i.test(name)) return "AXTI";
  if (/Intel/i.test(name)) return "INTC";
  if (/Solaris|SEI/i.test(name)) return "SEI";
  if (name.includes("國巨")) return "2327.TW";
  if (name.includes("聯電")) return "2303.TW";
  return null;
}

async function latestClose(name: string): Promise<number | null> {
  const symbol = quoteSymbol(name);
  if (!symbol) return null;
  try {
    const data = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`).then((response) => response.ok ? response.json() : null);
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    return [...closes].reverse().find((value) => typeof value === "number" && Number.isFinite(value)) ?? null;
  } catch { return null; }
}

function numericTrigger(condition: string): { operator: "<=" | ">="; price: number } | null {
  const match = condition.match(/(?:跌破|低於|下破|停損|止損|突破|高於|站上|達到|目標)[^\d]{0,12}(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const operator = /跌破|低於|下破|停損|止損/.test(match[0]) ? "<=" : ">=";
  return { operator, price: Number(match[1]) };
}

async function planCheck(holding: Holding) {
  const lines: string[] = [];
  const close = await latestClose(holding.name);
  const evaluate = (label: string, condition: string, missing: string) => {
    if (!condition) return lines.push(`${label}：${missing}`);
    const trigger = numericTrigger(condition);
    if (!trigger) return lines.push(`${label}：已記錄，但非明確價格條件，需人工判讀。`);
    if (close === null) return lines.push(`${label}：已記錄；沒有可對應的現貨收盤價，未自動判定。`);
    const hit = trigger.operator === "<=" ? close <= trigger.price : close >= trigger.price;
    lines.push(`${label}：最新收盤價 ${close}，${hit ? "已符合" : "尚未符合"} ${trigger.operator} ${trigger.price} 的條件。`);
  };
  evaluate("停損／失效條件", holding.stop, "未提供，無法判斷是否觸發。");
  evaluate("出場計畫", holding.exitPlan, "未提供，無法判斷是否達標。");
  return lines;
}

async function updateHolding(holding: Holding, date: string) {
  const headlines = await recentNews(holding.name, date);
  const insight = [
    `健檢日：${date}。`,
    holding.thesis ? `原持有理由：${holding.thesis}` : "原持有理由：未提供。",
    headlines.length ? `近 3 天消息：${headlines.join("；")}` : "近 3 天消息：未找到可驗證的重大更新。",
    ...(await planCheck(holding)),
  ].join("\n").slice(0, 1900);
  await notion(`/pages/${holding.id}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: {
      "最新健檢": { rich_text: [{ type: "text", text: { content: insight } }] },
      "最後檢視": { date: { start: date } },
    } }),
  });
  return { name: holding.name, insight };
}

async function main() {
  if (!notionToken || !dataSourceId) {
    throw new Error("缺少 NOTION_TOKEN 或 NOTION_HOLDINGS_DATA_SOURCE_ID，未執行 Notion 持股健檢。");
  }
  const date = tradingDate();
  const holdings = await loadHoldings();
  const results = [];
  for (const holding of holdings) results.push(await updateHolding(holding, date));
  const output = resolve(process.cwd(), "data/holding-health-latest.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ tradingDate: date, results }, null, 2));
  console.log(`[holdings-health] 已更新 ${results.length} 筆 Notion 持股健檢。`);
}

main().catch((error) => { console.error("[holdings-health] failed:", error); process.exitCode = 1; });
