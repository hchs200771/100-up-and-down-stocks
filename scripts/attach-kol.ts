import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as OpenCC from "opencc-js";

/**
 * 把財經 KOL 新節目的判讀併進 data/analysis-latest.json 的 `kol` 欄位，並把這批節目標記成「已讀」。
 *
 * 來源：
 * - data/tmp/kol-items.json：fetch-kol-feeds.ts 抓到的新節目（標題、連結、日期都以這份為準，
 *   不信任 LLM 回填的 URL）
 * - data/tmp/kol-brief.json：kol-brief-worker 寫的 overview + 每集 insight
 *
 * 已讀狀態存在 data/kol/seen.json（id → 第一次被處理的交易日）。同一交易日重跑時，
 * fetch 端會把當天標記的節目視為仍然是新的，所以重跑不會讓 KOL 區塊消失。
 * 另外每天留一份 data/kol/history/YYYY-MM-DD.json，給 worker 比對「看法有沒有轉向」。
 *
 * 任何一份缺席就不動 analysis-latest.json；idempotent，可重跑。
 */

const cwd = process.cwd();
const analysisPath = resolve(cwd, "data/analysis-latest.json");
const itemsPath = resolve(cwd, "data/tmp/kol-items.json");
const briefPath = resolve(cwd, "data/tmp/kol-brief.json");
const kolDir = resolve(cwd, "data/kol");
const seenPath = resolve(kolDir, "seen.json");
const historyDir = resolve(kolDir, "history");

const toTW = OpenCC.Converter({ from: "cn", to: "twp" });

interface FetchedItem {
  id: string;
  source: string;
  platform: string;
  title: string;
  url: string;
  publishedAt: string;
  basis: string;
  deferred?: boolean;
}

interface BriefItem {
  id: string;
  insight: string;
  tickers?: string[];
  stance?: string;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    console.warn(`attach-kol: ${path} unreadable`);
    return null;
  }
}

function main() {
  const analysis = readJson<Record<string, unknown>>(analysisPath);
  const fetched = readJson<{ tradingDate?: string; items: FetchedItem[] }>(itemsPath);
  const brief = readJson<{ overview?: string; items?: BriefItem[] }>(briefPath);
  if (!analysis || !fetched || !brief) {
    console.log("attach-kol: missing analysis / kol-items / kol-brief, leaving analysis untouched");
    return;
  }

  const byId = new Map(fetched.items.map((it) => [it.id, it]));
  const stances = new Set(["偏多", "偏空", "中性"]);
  const items = (brief.items ?? [])
    .filter((b) => byId.has(b.id) && b.insight?.trim())
    .map((b) => {
      const src = byId.get(b.id)!;
      return {
        source: src.source,
        platform: src.platform,
        title: src.title,
        url: src.url,
        publishedAt: src.publishedAt,
        basis: src.basis,
        insight: toTW(b.insight.trim()),
        ...(b.tickers && b.tickers.length > 0 ? { tickers: b.tickers.slice(0, 8) } : {}),
        ...(b.stance && stances.has(b.stance) ? { stance: b.stance } : {}),
      };
    });

  const day = fetched.tradingDate || String(analysis.date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  mkdirSync(historyDir, { recursive: true });
  const seen = readJson<Record<string, string>>(seenPath) ?? {};
  // 只標記「上了報告」或「已有逐字稿仍被判定無料」的節目。只有節目說明而被跳過的
  // （常見是 YouTube 字幕還沒生出來）留著，lookback 期間內隔天再試一次。
  // 轉文字額度用完而延後的（deferred）即使上了報告也先不標，下次有逐字稿再重新判讀。
  const used = new Set(items.map((it) => it.url));
  for (const it of fetched.items) {
    if (!seen[it.id] && !it.deferred && (used.has(it.url) || it.basis === "transcript")) seen[it.id] = day;
  }
  writeFileSync(seenPath, `${JSON.stringify(seen, null, 2)}\n`, "utf8");

  if (items.length === 0) {
    console.log("attach-kol: no new KOL insight, KOL section omitted");
    delete analysis.kol;
    writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
    return;
  }

  analysis.kol = { overview: toTW((brief.overview ?? "").trim()), items };
  writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  writeFileSync(resolve(historyDir, `${day}.json`), `${JSON.stringify(analysis.kol, null, 2)}\n`, "utf8");

  console.log(`attach-kol: merged ${items.length} KOL item(s) into analysis-latest.json, seen=${Object.keys(seen).length}`);
}

main();
