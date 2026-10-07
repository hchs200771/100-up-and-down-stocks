/**
 * 贏家分點追蹤：讀 Notion「分點追蹤名單」中已啟用的「股票 × 分點」，
 * 到富邦 e01（MoneyDJ）抓該分點在該股的每日買賣超，超過門檻就標為觸發。
 *
 * 必要環境變數（放在 .env.local，勿提交）：
 *   NOTION_TOKEN                          —— integration 需被加到「贏家分點」頁
 *   NOTION_BROKER_WATCH_DATA_SOURCE_ID    —— 可省略，預設為目前的名單資料庫
 *
 * 產出：
 *   data/broker-watch-latest.json         —— 當日結果，send-report 用
 *   data/broker-watch-history/<股票>-<分點>.json —— 每日買賣超累積（e01 只保留約 45 個交易日）
 *   data/broker-watch-config.json         —— 上次成功讀到的名單；Notion 讀不到時沿用
 *
 * 回寫 Notion：只寫「最近觸發日」「最近買賣超張數」「分點代號」（名單只填分點名稱時自動補上）。
 */
import "dotenv/config";
import dotenv from "dotenv";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderSubpageNav } from "./lib/nav";
import { yahooUrl } from "./lib/stock-links";

dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true, quiet: true });

const NOTION_VERSION = "2025-09-03";
const DEFAULT_DATA_SOURCE_ID = "f5774c39-be43-426c-8b02-85657137f35e";
const E01 = "https://fubon-ebrokerdj.fbs.com.tw";
const UA = { "User-Agent": "Mozilla/5.0" };

export type Direction = "雙向" | "買超" | "賣超";

export type WatchItem = {
  pageId: string;
  title: string;
  stockCode: string;
  stockName: string;
  broker: string;
  brokerCode: string;
  threshold: number;
  direction: Direction;
  grade: string;
  note: string;
  lastTriggerDate: string;
  lastTriggerNet: number | null;
};

export type DayNet = { date: string; close: number; net: number };

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * zco0 頁把近 ~45 日資料寫在 GetBcdData('MMDD,... 收盤,... 買賣超,...')。
 * 日期只有月日：比交易日的月日還大就是去年（跨年時）。
 */
export function parseBcdData(html: string, tradingDate: string): DayNet[] {
  const match = html.match(/GetBcdData\('([^']*)'\)/);
  if (!match || match[1] === "無資料") return [];
  const [dates, closes, nets] = match[1].split(" ").map((part) => part.split(","));
  if (!dates || !closes || !nets) return [];
  const year = Number(tradingDate.slice(0, 4));
  const todayMd = tradingDate.slice(5, 7) + tradingDate.slice(8, 10);
  return dates
    .map((md, i) => ({
      date: `${md > todayMd ? year - 1 : year}-${md.slice(0, 2)}-${md.slice(2, 4)}`,
      close: Number(closes[i]),
      net: Number(nets[i]),
    }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && Number.isFinite(d.net));
}

/**
 * zbrokerjs.djjs 的 g_BrokerList：各券商以 ';' 分隔，券商內各分點以 '!' 分隔，
 * 每個分點是「代號,名稱」，第一筆是總公司（會重複出現一次）。
 */
export function parseBrokerList(js: string): Map<string, { code: string; name: string; hq: string }> {
  const list = js.match(/g_BrokerList\s*=\s*'([^']*)'/)?.[1] ?? "";
  const byKey = new Map<string, { code: string; name: string; hq: string }>();
  for (const group of list.split(";")) {
    const entries = group.split("!").map((e) => e.split(","));
    const hq = entries[0]?.[0];
    if (!hq) continue;
    for (const [code, name] of entries) {
      if (!code || !name) continue;
      const item = { code, name, hq };
      byKey.set(code.toUpperCase(), item);
      byKey.set(normalizeBrokerName(name), item);
    }
  }
  return byKey;
}

/** 「富邦建國」「富邦-建國」「中國信託（總公司）」都對得上 e01 的名稱。 */
export function normalizeBrokerName(name: string): string {
  return name.replace(/[（(].*?[)）]/g, "").replace(/[-－\s]/g, "").trim();
}

export function isTriggered(net: number, threshold: number, direction: Direction): boolean {
  if (!(threshold > 0)) return false;
  if (direction === "買超") return net >= threshold;
  if (direction === "賣超") return -net >= threshold;
  return Math.abs(net) >= threshold;
}

/** 合併新舊歷史，同一天以新抓的為準，依日期排序。 */
export function mergeHistory(old: DayNet[], fresh: DayNet[]): DayNet[] {
  const byDate = new Map(old.map((d) => [d.date, d]));
  for (const d of fresh) byDate.set(d.date, d);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

function text(property: any): string {
  if (!property) return "";
  if (property.type === "title" || property.type === "rich_text") return (property[property.type] ?? []).map((x: any) => x.plain_text ?? "").join("").trim();
  if (property.type === "select") return property.select?.name ?? "";
  return "";
}

async function notion(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`Notion API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function loadWatchlist(dataSourceId: string): Promise<WatchItem[]> {
  const items: WatchItem[] = [];
  let cursor: string | undefined;
  do {
    const data = await notion(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, start_cursor: cursor, filter: { property: "啟用", checkbox: { equals: true } } }),
    });
    for (const page of data.results ?? []) {
      const p = page.properties ?? {};
      items.push({
        pageId: page.id,
        title: text(p["名稱"]),
        stockCode: text(p["股票代號"]),
        stockName: text(p["股票名稱"]),
        broker: text(p["分點"]),
        brokerCode: text(p["分點代號"]),
        threshold: p["門檻張數"]?.number ?? 0,
        direction: (text(p["觸發方向"]) || "雙向") as Direction,
        grade: text(p["等級"]),
        note: text(p["備註"]),
        lastTriggerDate: p["最近觸發日"]?.date?.start ?? "",
        lastTriggerNet: p["最近買賣超張數"]?.number ?? null,
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return items;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function tradingDate(): string {
  const path = resolve(process.cwd(), "data/market-latest.json");
  if (!existsSync(path)) throw new Error("找不到 data/market-latest.json，無法判定本次交易日。");
  const date = JSON.parse(readFileSync(path, "utf8")).tradingDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("market-latest.json 缺少有效 tradingDate。");
  return date;
}

async function fetchBig5(url: string): Promise<string> {
  const response = await fetch(url, { headers: UA });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return new TextDecoder("big5").decode(await response.arrayBuffer());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 子頁 HTML（data/broker-watch.html → 網站的 broker-watch.html）
// ---------------------------------------------------------------------------

type ReportItem = WatchItem & {
  brokerHq?: string;
  status: "ok" | "stale" | "unresolved";
  net?: number | null;
  triggered?: boolean;
  lastTrigger?: DayNet | null;
  recent?: DayNet[];
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString()}`;
const netCell = (n: number, strong = false) => `<span class="${n > 0 ? "pos" : n < 0 ? "neg" : ""}"${strong ? ' style="font-weight:700"' : ""}>${signed(n)}</span>`;

export function renderHtml(report: { tradingDate: string; notion: boolean; items: ReportItem[] }): string {
  const items = [...report.items].sort((a, b) => Number(!!b.triggered) - Number(!!a.triggered) || a.stockCode.localeCompare(b.stockCode));
  const hits = items.filter((i) => i.triggered).length;
  const rows = items.map((i) => {
    const today = i.status === "ok" && typeof i.net === "number"
      ? netCell(i.net, i.triggered)
      : `<span class="muted">${i.status === "unresolved" ? "找不到分點" : "e01 未更新"}</span>`;
    const recent = (i.recent ?? []).map((d) => `<span class="day" title="${d.date}">${d.date.slice(5)} ${netCell(d.net)}</span>`).join("");
    const link = `https://fubon-ebrokerdj.fbs.com.tw/z/zc/zco/zco0/zco0.djhtm?a=${i.stockCode}&BHID=${i.brokerHq ?? i.brokerCode}&b=${i.brokerCode}`;
    return `<tr class="${i.triggered ? "hit" : ""}">
<td>${i.triggered ? "🚨 " : ""}<a href="${yahooUrl(i.stockCode)}" target="_blank" rel="noopener">${esc(i.stockName)}</a> <span class="muted">${esc(i.stockCode)}</span></td>
<td><a href="${link}" target="_blank" rel="noopener">${esc(i.broker)}</a></td>
<td>${i.grade && i.grade !== "未分級" ? `<span class="chip">${esc(i.grade)}</span>` : '<span class="muted">—</span>'}</td>
<td>${today}</td>
<td class="muted">${i.threshold || "未設"}（${esc(i.direction)}）</td>
<td class="muted">${i.lastTrigger ? `${i.lastTrigger.date.slice(5)} ${netCell(i.lastTrigger.net)}` : "—"}</td>
<td class="recent">${recent}</td>
<td class="note">${esc(i.note ?? "")}</td>
</tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>贏家分點追蹤</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">🕵️</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7;--hit:#fef3c7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42;--hit:#3a2f12}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
.sub{color:var(--muted);font-size:13px;margin:2px 0}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;margin-top:12px}
table{border-collapse:collapse;width:100%;min-width:980px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;vertical-align:top}
th{color:var(--muted);font-weight:600}
tr.hit td{background:var(--hit)}
td.note{white-space:normal;min-width:180px;color:var(--muted);font-size:12px}
.recent .day{display:inline-block;margin-right:8px;font-size:12px;color:var(--muted)}
a{color:var(--accent);text-decoration:none}
.muted{color:var(--muted)}
.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;font-size:11px;color:var(--up);font-weight:700}
.pos{color:var(--up)}.neg{color:var(--down)}
.nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.nav a{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:700;background:var(--card);color:var(--fg)}
.nav a:hover{border-color:var(--accent);color:var(--accent)}
.nav a.here{background:var(--accent);border-color:var(--accent);color:#fff}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;font-size:13px;color:var(--muted)}
details.howto summary{cursor:pointer;padding:10px 16px;font-size:14px;font-weight:600;color:var(--fg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto li{margin:3px 0}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("broker-watch.html")}
<h1>🕵️ 贏家分點追蹤</h1>
<p class="sub">交易日 ${report.tradingDate}｜追蹤 ${items.length} 組｜${hits ? `<b class="pos">今日 ${hits} 組觸發</b>` : "今日無觸發"}｜單位：張，正為買超、負為賣超${report.notion ? "" : "｜名單沿用本機快取"}</p>
<details class="howto">
<summary>📖 本頁說明（點開）</summary>
<div class="body"><ul>
<li>名單維護在 Notion「投資 / 台股 / 贏家分點 / 分點追蹤名單」，每列一組「股票 × 分點」，取消「啟用」即停止追蹤。</li>
<li>觸發條件：當日買超（或賣超，依觸發方向）張數達到門檻。「最近觸發」取近期歷史中最後一次達標的日子。</li>
<li>資料來源：富邦 e01 券商分點進出（約 45 個交易日滾動），每天累積存檔，時間越久歷史越長。</li>
<li>分點不代表特定人，僅作籌碼參考；點分點名稱可到 e01 看完整走勢。</li>
</ul></div>
</details>
<div class="tablebox"><table>
<tr><th>股票</th><th>分點</th><th>等級</th><th>今日</th><th>門檻</th><th>最近觸發</th><th>近 5 日</th><th>備註</th></tr>
${rows}
</table></div>
</div></body></html>
`;
}

async function main() {
  const date = tradingDate();
  const configPath = resolve(process.cwd(), "data/broker-watch-config.json");
  const dataSourceId = process.env.NOTION_BROKER_WATCH_DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID;

  let watchlist: WatchItem[];
  let notionOk = false;
  try {
    if (!process.env.NOTION_TOKEN) throw new Error("缺少 NOTION_TOKEN");
    watchlist = await loadWatchlist(dataSourceId);
    notionOk = true;
    writeFileSync(configPath, JSON.stringify({ fetchedAt: new Date().toISOString(), items: watchlist }, null, 2));
  } catch (error) {
    if (!existsSync(configPath)) throw new Error(`讀不到 Notion 分點名單，也沒有本機快取：${(error as Error).message}`);
    console.warn(`[broker-watch] [warn] 讀不到 Notion 名單（${(error as Error).message}），沿用 data/broker-watch-config.json`);
    watchlist = JSON.parse(readFileSync(configPath, "utf8")).items;
  }

  const brokers = parseBrokerList(await fetchBig5(`${E01}/z/js/zbrokerjs.djjs`));
  const historyDir = resolve(process.cwd(), "data/broker-watch-history");
  mkdirSync(historyDir, { recursive: true });

  const results = [];
  for (const item of watchlist) {
    const broker = brokers.get(item.brokerCode.toUpperCase()) ?? brokers.get(normalizeBrokerName(item.broker));
    if (!item.stockCode || !broker) {
      console.warn(`[broker-watch] [warn] ${item.title}：${!item.stockCode ? "缺股票代號" : `找不到分點「${item.brokerCode || item.broker}」`}，略過`);
      results.push({ ...item, status: "unresolved" as const });
      continue;
    }

    let fresh: DayNet[] = [];
    try {
      fresh = parseBcdData(await fetchBig5(`${E01}/z/zc/zco/zco0/zco0.djhtm?a=${item.stockCode}&BHID=${broker.hq}&b=${broker.code}`), date);
    } catch (error) {
      console.warn(`[broker-watch] [warn] ${item.title} 抓取失敗：${(error as Error).message}`);
    }
    await sleep(300);

    const historyPath = resolve(historyDir, `${item.stockCode}-${broker.code}.json`);
    const old: DayNet[] = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")).days : [];
    const days = mergeHistory(old, fresh);
    writeFileSync(historyPath, JSON.stringify({ stockCode: item.stockCode, broker: broker.name, brokerCode: broker.code, days }, null, 2));

    const today = days.find((d) => d.date === date) ?? null;
    const lastTrigger = [...days].reverse().find((d) => isTriggered(d.net, item.threshold, item.direction)) ?? null;
    results.push({
      ...item,
      broker: broker.name,
      brokerCode: broker.code,
      brokerHq: broker.hq,
      status: today ? ("ok" as const) : ("stale" as const),
      net: today?.net ?? null,
      close: today?.close ?? null,
      triggered: today ? isTriggered(today.net, item.threshold, item.direction) : false,
      lastTrigger,
      recent: days.slice(-5),
    });

    // 回寫：最近觸發以歷史推算，重跑冪等；只在值有變時 PATCH。
    if (!notionOk) continue;
    const props: Record<string, unknown> = {};
    if (!item.brokerCode) props["分點代號"] = { rich_text: [{ type: "text", text: { content: broker.code } }] };
    if (lastTrigger && (lastTrigger.date !== item.lastTriggerDate || lastTrigger.net !== item.lastTriggerNet)) {
      props["最近觸發日"] = { date: { start: lastTrigger.date } };
      props["最近買賣超張數"] = { number: lastTrigger.net };
    }
    if (Object.keys(props).length) {
      try {
        await notion(`/pages/${item.pageId}`, { method: "PATCH", body: JSON.stringify({ properties: props }) });
      } catch (error) {
        console.warn(`[broker-watch] [warn] ${item.title} 回寫 Notion 失敗：${(error as Error).message}`);
      }
    }
  }

  const report = { tradingDate: date, notion: notionOk, items: results };
  writeFileSync(resolve(process.cwd(), "data/broker-watch-latest.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(process.cwd(), "data/broker-watch.html"), renderHtml(report as any));
  const hits = results.filter((r: any) => r.triggered);
  const stale = results.filter((r) => r.status === "stale").length;
  console.log(`[broker-watch] ${date}：追蹤 ${results.length} 組，觸發 ${hits.length} 組${stale ? `，${stale} 組 e01 尚未更新到當日` : ""}`);
  for (const r of hits as any[]) console.log(`[broker-watch]   ${r.stockName}(${r.stockCode}) × ${r.broker}：${r.net > 0 ? "買超" : "賣超"} ${Math.abs(r.net)} 張（門檻 ${r.threshold}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error("[broker-watch] failed:", error); process.exitCode = 1; });
}
