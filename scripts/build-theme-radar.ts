#!/usr/bin/env npx tsx
/** 手動擷取 RSS 並保存當日題材快照。歷史快照首次寫入後不覆蓋。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scoreThemes, type ThemeArticle, type ThemeDefinition } from "./lib/theme-radar";
import { parseThemeFeed } from "./lib/theme-feed";
import { renderThemePage } from "./lib/theme-page";
import { twIso } from "./lib/time";

const root = process.cwd();
const config = JSON.parse(readFileSync(resolve(root, "config/theme-radar.json"), "utf8")) as {
  feeds: Array<{ name: string; url: string }>;
  themes: ThemeDefinition[];
};
const market = JSON.parse(readFileSync(resolve(root, "data/market-latest.json"), "utf8")) as { tradingDate: string };
const date = market.tradingDate;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("market-latest.json 缺少有效交易日");

const articlePath = resolve(root, "data/theme-radar/articles.json");
const latestPath = resolve(root, "data/theme-radar/latest.json");
const historyPath = resolve(root, `data/theme-radar/history/${date}.json`);
const previous: ThemeArticle[] = existsSync(articlePath)
  ? JSON.parse(readFileSync(articlePath, "utf8")) as ThemeArticle[] : [];

async function main() {
  const results = await Promise.allSettled(config.feeds.map(async (feed) => {
    const response = await fetch(feed.url, {
      headers: { "User-Agent": "ThemeRadar/1.0 (personal research)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    if (xml.length > 10_000_000) throw new Error("RSS 超過 10 MB");
    return parseThemeFeed(xml, feed.name);
  }));
  const warnings: string[] = [];
  const incoming: ThemeArticle[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      incoming.push(...result.value);
      console.log(`[theme-radar] ${config.feeds[index].name}: ${result.value.length} 篇`);
      if (result.value.length === 0) warnings.push(`${config.feeds[index].name}: RSS 沒有文章`);
    } else {
      warnings.push(`${config.feeds[index].name}: ${String(result.reason)}`);
      console.warn(`[theme-radar] ${warnings.at(-1)}`);
    }
  });
  if (results.every((result) => result.status === "rejected")) {
    throw new Error("所有 RSS 來源都抓取失敗，未更新題材資料");
  }
  const byId = new Map(previous.map((article) => [article.id, article]));
  for (const article of incoming) if (!byId.has(article.id)) byId.set(article.id, article);
  const articles = [...byId.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const signals = scoreThemes(articles, config.themes, date);
  // 來源缺漏會扭曲題材提及占比；保留原始分數，但這次不發加速訊號。
  if (warnings.length) for (const signal of signals) signal.accelerating = false;
  const output = { date, generatedAt: twIso(), completedWeeks: 16,
    articles: articles.length, warnings, signals };
  mkdirSync(resolve(root, "data/theme-radar/history"), { recursive: true });
  writeFileSync(articlePath, `${JSON.stringify(articles)}\n`);
  if (!existsSync(historyPath)) writeFileSync(historyPath, `${JSON.stringify(output, null, 2)}\n`);
  writeFileSync(latestPath, readFileSync(historyPath));
  const latest = JSON.parse(readFileSync(latestPath, "utf8")) as typeof output;
  writeFileSync(resolve(root, "data/theme-radar.html"), renderThemePage({
    ...latest, generatedAt: twIso(), articles: articles.length,
  }, articles, config.themes));
  console.log(`[theme-radar] ${date}: ${signals.filter((signal) => signal.accelerating).length} 個加速題材；歷史文章 ${articles.length} 篇`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
