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
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderSubpageNav } from "./lib/nav";
import { yahooUrl } from "./lib/stock-links";
import { closesOn, isTradingDay } from "./lib/twse-closes";

dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true, quiet: true });

const NOTION_VERSION = "2025-09-03";
const DEFAULT_DATA_SOURCE_ID = "f5774c39-be43-426c-8b02-85657137f35e";
export const E01_HOSTS = [
  "https://fubon-ebrokerdj.fbs.com.tw",
  "https://jdata.yuanta.com.tw",
  "https://newjust.masterlink.com.tw",
  "https://concords.moneydj.com",
  "https://justdata.moneydj.com",
  "https://stock.capital.com.tw",
  "https://kgieworld.moneydj.com",
];
const UA = { "User-Agent": "Mozilla/5.0" };

export type Direction = "雙向" | "買超" | "賣超";
type Geo = "地緣" | "同生活圈" | "否" | "未知";

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
  geo?: Geo;
  geoReason?: string;
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
      // 4 碼代號區分大小寫（700b 兆豐-中壢 ≠ 700B 兆豐-板橋）：精確鍵優先，大寫鍵只當後備
      for (const key of [code, displayBrokerCode(code)]) {
        byKey.set(key, item);
        if (!byKey.has(key.toUpperCase())) byKey.set(key.toUpperCase(), item);
      }
      byKey.set(normalizeBrokerName(name), item);
    }
  }
  return byKey;
}

/** e01 分點代號常寫成 UTF-16 hex（0035003800350051 = 585Q），轉回 4 碼給人看、存 Notion。 */
export function displayBrokerCode(code: string): string {
  return /^(00[0-9a-f]{2}){4}$/i.test(code) ? code.match(/.{4}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join("") : code;
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

async function fetchE01(path: string, index: number): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < E01_HOSTS.length; attempt++) {
    const host = E01_HOSTS[(index + attempt) % E01_HOSTS.length];
    try {
      const body = await fetchBig5(`${host}${path}`);
      const valid = path === "/z/js/zbrokerjs.djjs"
        ? parseBrokerList(body).size > 0
        : /GetBcdData\('/.test(body); // 「無資料」是正常回應（近期沒進出），不換站
      if (!valid) throw new Error(`空白或無法解析的 e01 資料 ${host}${path}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < E01_HOSTS.length) {
        const nextHost = E01_HOSTS[(index + attempt + 1) % E01_HOSTS.length];
        console.warn(`[broker-watch] [warn] ${host} 抓取失敗（${(error as Error).message}），改用 ${nextHost}`);
      }
    }
  }
  throw lastError;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 子頁 HTML（data/broker-watch.html → 網站的 broker-watch.html）
// ---------------------------------------------------------------------------

export type ReportItem = WatchItem & {
  brokerHq?: string;
  status: "ok" | "stale" | "unresolved";
  net?: number | null;
  triggered?: boolean;
  lastTrigger?: DayNet | null;
  recent?: DayNet[];
  recent5?: { date: string; net: number }[];
  triggered5?: boolean;
  net20?: number;
  net20Days?: number;
  net20Partial?: boolean;
  close?: number | null;
  ma10?: number;
  aboveMa10?: boolean;
  ma10Pct?: number;
};

export type BrokerReport = { tradingDate: string; notion: boolean; items: ReportItem[] };

type ClosesLookup = (date: string) => Record<string, number> | undefined | Promise<Record<string, number> | undefined>;

/** Use a shared ten-session window; never bridge missing dates or suspended stocks. */
export async function withMa10(report: BrokerReport, lookup: ClosesLookup = closesOn): Promise<BrokerReport> {
  const sessions: Record<string, number>[] = [];
  const date = new Date(`${report.tradingDate}T00:00:00Z`);
  for (let back = 0; back < 60 && sessions.length < 10; back++, date.setUTCDate(date.getUTCDate() - 1)) {
    let closes: Record<string, number> | undefined;
    try { closes = await lookup(date.toISOString().slice(0, 10).replace(/-/g, "")); }
    catch { break; }
    // An absent cache is unknown, unlike a cached empty holiday. Do not skip it.
    if (!closes) break;
    if (isTradingDay(closes)) sessions.push(closes);
    else if (back === 0) break; // The displayed close must belong to the report date.
  }
  const byStock = new Map<string, Pick<ReportItem, "close" | "ma10" | "aboveMa10" | "ma10Pct">>();
  for (const { stockCode } of report.items) {
    if (byStock.has(stockCode)) continue;
    const values = sessions.map((closes) => closes[stockCode]);
    if (values.length !== 10 || values.some((n) => !Number.isFinite(n) || n <= 0)) {
      byStock.set(stockCode, { close: undefined, ma10: undefined, aboveMa10: undefined, ma10Pct: undefined });
      continue;
    }
    const close = values[0];
    const ma10 = values.reduce((sum, n) => sum + n, 0) / 10;
    byStock.set(stockCode, { close, ma10, aboveMa10: close >= ma10, ma10Pct: Math.round((close / ma10 - 1) * 1000) / 10 });
  }
  return { ...report, items: report.items.map((item) => ({ ...item, ...byStock.get(item.stockCode) })) };
}

/** One shared trading calendar, so sparse branches cannot pull older trades into the window. */
export function withRecent5(report: BrokerReport, historyDir = resolve(process.cwd(), "data/broker-watch-history")): BrokerReport {
  const histories = new Map<string, DayNet[]>();
  const dates = new Set<string>([report.tradingDate]);
  const marketPath = resolve(process.cwd(), "data/market-history.json");
  if (existsSync(marketPath)) {
    for (const day of JSON.parse(readFileSync(marketPath, "utf8"))) dates.add(day.date);
  }
  if (existsSync(historyDir)) {
    for (const file of readdirSync(historyDir).filter((f) => f.endsWith(".json"))) {
      const days: DayNet[] = JSON.parse(readFileSync(resolve(historyDir, file), "utf8")).days ?? [];
      histories.set(file.slice(0, -5), days);
      for (const day of days) dates.add(day.date);
    }
  }
  for (const item of report.items) {
    for (const day of [...(item.recent ?? []), ...(item.recent5 ?? [])]) dates.add(day.date);
  }
  const window20 = [...dates].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= report.tradingDate).sort().slice(-20);
  const window = window20.slice(-5);
  return { ...report, items: report.items.map((item) => {
    // History is authoritative; embedded observations support reports without a local history file.
    const days = new Map([...(item.recent ?? []), ...(item.recent5 ?? []),
      ...(histories.get(`${item.stockCode}-${item.brokerCode}`) ?? [])].map((d) => [d.date, d.net]));
    const observations = new Map([...(item.recent ?? []),
      ...(histories.get(`${item.stockCode}-${item.brokerCode}`) ?? [])]
      .filter((d) => d.date <= report.tradingDate).map((d) => [d.date, d.net]));
    const earliest = [...observations.keys()].sort()[0];
    const net20Days = earliest ? window20.filter((date) => date >= earliest).length : 0;
    const net20 = window20.reduce((sum, date) => sum + (observations.get(date) ?? 0), 0);
    const recent5 = window.map((date) => ({ date, net: days.get(date) ?? 0 }));
    return { ...item, net20, net20Days, net20Partial: net20Days < 20, geo: item.geo ?? "未知", geoReason: item.geoReason ?? "", recent5, triggered5: recent5.some((d) => isTriggered(d.net, item.threshold, item.direction)) };
  }) };
}

export function recentTrigger(item: ReportItem): { date: string; net: number } | undefined {
  return [...(item.recent5 ?? [])].reverse().find((d) => isTriggered(d.net, item.threshold, item.direction));
}

const geoRank = (geo: Geo | undefined) => geo === "地緣" ? 0 : geo === "同生活圈" ? 1 : 2;

export function triggeredPairs(items: ReportItem[]): ReportItem[] {
  return items.filter((i) => i.triggered5).sort((a, b) => {
    const x = recentTrigger(a)!;
    const y = recentTrigger(b)!;
    return y.date.localeCompare(x.date) || geoRank(a.geo) - geoRank(b.geo) || Math.abs(y.net) - Math.abs(x.net) || a.stockCode.localeCompare(b.stockCode);
  });
}

function detailUrl(i: ReportItem): string {
  // Keep the e01 wire code (including UTF-16 hex codes) intact.
  return `https://fubon-ebrokerdj.fbs.com.tw/z/zc/zco/zco0/zco0.djhtm?a=${encodeURIComponent(i.stockCode)}&BHID=${encodeURIComponent(i.brokerHq ?? i.brokerCode)}&b=${encodeURIComponent(i.brokerCode)}`;
}

function renderBars(i: ReportItem): string {
  const days = i.recent5 ?? [];
  const thresholds = i.threshold > 0
    ? (i.direction === "買超" ? [i.threshold] : i.direction === "賣超" ? [-i.threshold] : [i.threshold, -i.threshold]) : [];
  const values = [0, ...days.map((d) => d.net), ...thresholds];
  const extent = Math.max(1, ...values.map(Math.abs));
  // Round to readable ticks; include threshold lines even when bars are much smaller.
  const magnitude = 10 ** Math.floor(Math.log10(extent));
  const limit = Math.ceil(extent / magnitude) * magnitude;
  const left = 43, right = 207, top = 12, bottom = 82;
  const y = (net: number) => bottom - (net + limit) / (2 * limit) * (bottom - top);
  const step = (right - left) / Math.max(1, days.length);
  const ticks = [-limit, 0, limit];
  return `<svg class="bars" viewBox="0 0 210 106" width="100%" role="img" aria-label="${esc(i.stockName)} ${esc(i.broker)} 近五日買賣超（張）">
<title>${esc(days.map((d) => `${d.date}：${signed(d.net)} 張`).join("；"))}</title>
<text x="2" y="9" class="axis-label">張</text>
${ticks.map((n) => `<line x1="${left}" x2="${right}" y1="${y(n)}" y2="${y(n)}" class="${n === 0 ? "zero" : "grid"}"/><text x="${left - 4}" y="${y(n) + 3}" text-anchor="end" class="axis-label">${signed(n)}</text>`).join("")}
<line x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" class="zero"/>
${days.map((d, n) => {
    const x = left + step * (n + .5);
    return `<rect class="bar" x="${x - step * .22}" y="${Math.min(y(0), y(d.net))}" width="${step * .44}" height="${Math.abs(y(d.net) - y(0))}" fill="var(${d.net >= 0 ? "--up" : "--down"})"><title>${d.date}：${signed(d.net)} 張</title></rect>
<line x1="${x}" x2="${x}" y1="${bottom}" y2="${bottom + 4}" class="zero"/>
<text x="${x}" y="${bottom + 14}" text-anchor="middle" class="axis-label">${d.date.slice(5).replace("-", "/")}</text>`;
  }).join("")}
${thresholds.map((n) => `<line x1="${left}" x2="${right}" y1="${y(n)}" y2="${y(n)}" class="threshold"><title>門檻 ${signed(n)} 張</title></line>`).join("")}
${days.map((d, n) => {
    const tip = `${d.date.slice(5).replace("-", "/")} ${d.net > 0 ? "買超 " : d.net < 0 ? "賣超 " : ""}${signed(d.net)} 張`;
    return `<rect x="${left + step * n}" y="${top}" width="${step}" height="${bottom - top}" fill="transparent" pointer-events="all" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
  }).join("")}
</svg>`;
}

const brokerType = (i: ReportItem) => displayBrokerCode(i.brokerCode) === i.brokerHq || (!i.brokerHq && !i.broker.includes("-")) ? "總公司" : "分點";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString()}`;
const netCell = (n: number, strong = false) => `<span class="${n > 0 ? "pos" : n < 0 ? "neg" : ""}"${strong ? ' style="font-weight:700"' : ""}>${signed(n)}</span>`;
const ma10Chip = (i: ReportItem, full = true) => typeof i.aboveMa10 === "boolean" && i.close != null && i.ma10 != null && i.ma10Pct != null
  ? `<span class="chip ma10 ${i.aboveMa10 ? "pos" : "neg"}" title="收盤 ${i.close}／10 日均 ${Number(i.ma10.toFixed(2))}">${full ? "10日線" : ""}${i.aboveMa10 ? "上" : "下"} ${i.ma10Pct >= 0 ? "+" : ""}${i.ma10Pct.toFixed(1)}%</span>` : "";

function net20Cell(item: ReportItem): string {
  const partial = item.net20Partial ? `（資料僅 ${item.net20Days ?? 0} 日）` : "";
  return `<span title="近 20 個交易日累計淨買賣超">${typeof item.net20 === "number" ? `${netCell(item.net20)} 張${partial}` : "—"}</span>`;
}

export function renderHtml(report: BrokerReport): string {
  const items = report.items;
  const triggered = triggeredPairs(items);
  const hits = triggered.length;
  // 依最近一次觸發的方向分成多（買超）、空（賣超）兩區
  const longs = triggered.filter((i) => recentTrigger(i)!.net > 0);
  const shorts = triggered.filter((i) => recentTrigger(i)!.net < 0);
  const renderGroups = (list: ReportItem[]) => {
  const byStock = new Map<string, ReportItem[]>();
  for (const item of list) {
    const group = byStock.get(item.stockCode) ?? [];
    group.push(item);
    byStock.set(item.stockCode, group);
  }
  const groups = [...byStock.values()].map((pairs) => {
    const date = recentTrigger(pairs[0])!.date;
    return { pairs, date, rank: Math.min(...pairs.map((i) => geoRank(i.geo))),
      net: Math.max(...pairs.filter((i) => recentTrigger(i)!.date === date).map((i) => Math.abs(recentTrigger(i)!.net))) };
  }).sort((a, b) => b.date.localeCompare(a.date) || a.rank - b.rank || b.net - a.net || a.pairs[0].stockCode.localeCompare(b.pairs[0].stockCode));
  return groups.map(({ pairs }) => {
    const stock = pairs[0];
    const brokerRows = pairs.map((i) => {
      const hit = recentTrigger(i)!;
      const geoBadge = i.geo === "地緣" || i.geo === "同生活圈"
        ? `<span class="chip geo-badge${i.geo === "地緣" ? " geo-local" : ""}" title="${esc(i.geoReason ?? "")}">${i.geo}</span>` : "";
      return `<div class="watch-row">
<div class="broker"><a href="${esc(detailUrl(i))}" target="_blank" rel="noopener">${esc(i.broker)}</a> <span class="broker-type muted">${brokerType(i)}</span></div>
<div class="row-main">
<div class="meta">${geoBadge} <span class="chip">等級：${esc(i.grade || "未分級")}</span> <span>門檻 ${i.threshold.toLocaleString()} 張${i.direction === "雙向" ? "" : ` · ${esc(i.direction)}`}</span></div>
<div class="latest-trigger">最近觸發：${hit.date.slice(5).replace("-", "/")} ${netCell(hit.net, true)} 張 · 近20日 ${net20Cell(i)}</div>
</div>
<p class="row-note" title="${esc(i.note || "—")}">備註：${esc(i.note || "—")}</p>
${renderBars(i)}
</div>`;
    }).join("\n");
    return `<article class="stock-group">
<header class="stock-header"><h2><a href="${yahooUrl(stock.stockCode)}" target="_blank" rel="noopener">${esc(stock.stockName)} ${esc(stock.stockCode)}</a></h2>${ma10Chip(stock)}<a class="ext-link" href="https://fubon-ebrokerdj.fbs.com.tw/z/zc/zco/zco.djhtm?a=${encodeURIComponent(stock.stockCode)}" target="_blank" rel="noopener">個股主力進出 ↗</a>${pairs.map((i) => `<a class="ext-link" href="${esc(detailUrl(i))}" target="_blank" rel="noopener">${pairs.length > 1 ? `${esc(i.broker)} ` : ""}分點進出明細 ↗</a>`).join("")}</header>
${brokerRows}
</article>`;
  }).join("\n");
  };
  const section = (title: string, cls: string, list: ReportItem[]) => list.length
    ? `<h2 class="side-title ${cls}">${title}（${list.length} 組）</h2>\n<section class="stock-groups side-${cls}" aria-label="近五日${title}">${renderGroups(list)}</section>` : "";
  const others = items.filter((i) => !i.triggered5).sort((a, b) => a.stockCode.localeCompare(b.stockCode));
  const rows = others.map((i) => {
    const today = i.status === "ok" && typeof i.net === "number"
      ? netCell(i.net, i.triggered)
      : `<span class="muted">${i.status === "unresolved" ? "找不到分點" : "e01 未更新"}</span>`;
    const recent = (i.recent5 ?? []).map((d) => `<span class="day" title="${d.date}">${d.date.slice(5)} ${netCell(d.net)}</span>`).join("");
    const link = esc(detailUrl(i));
    return `<tr class="${i.triggered ? "hit" : ""}">
<td>${i.triggered ? "🚨 " : ""}<a href="${yahooUrl(i.stockCode)}" target="_blank" rel="noopener">${esc(i.stockName)}</a> <span class="muted">${esc(i.stockCode)}</span></td>
<td><a href="${link}" target="_blank" rel="noopener">${esc(i.broker)}</a> <span class="broker-type muted">${brokerType(i)}</span></td>
<td>${i.grade && i.grade !== "未分級" ? `<span class="chip">${esc(i.grade)}</span>` : '<span class="muted">—</span>'}</td>
<td>${i.geo === "地緣" || i.geo === "同生活圈" ? esc(i.geo) : ""}</td>
<td>${today}</td>
<td class="muted">${i.threshold || "未設"}${i.direction === "雙向" ? "" : `（${esc(i.direction)}）`}</td>
<td class="muted">${i.lastTrigger ? `${i.lastTrigger.date.slice(5)} ${netCell(i.lastTrigger.net)}` : "—"}</td>
<td>${net20Cell(i)}</td>
<td class="recent">${recent}</td>
<td class="note">${esc(i.note ?? "")}</td>
<td>${ma10Chip(i, false)}</td>
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
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#dc2626;--down:#15803d;--chip:#eef2f7;--hit:#fef3c7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#f87171;--down:#4ade80;--chip:#222c42;--hit:#3a2f12}}
*{box-sizing:border-box}
.stock-groups{display:grid;gap:12px;margin:8px 0 16px;min-width:0}
.side-title{font-size:16px;margin:18px 0 0}
.stock-group{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.stock-header{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;padding:8px 12px;background:var(--chip);font-size:12px}
.stock-header h2{font-size:16px;margin:0;overflow-wrap:anywhere}
.side-pos .stock-header h2 a{color:var(--up)}.side-neg .stock-header h2 a{color:var(--down)}
.ext-link{color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:1px 8px;font-size:11px;white-space:nowrap}.ext-link:hover{color:var(--fg)}
.watch-row{display:grid;grid-template-columns:minmax(0,1fr) 210px;grid-template-rows:auto auto 1fr;gap:4px 16px;align-items:start;padding:5px 12px;border-top:1px solid var(--line);min-width:0}
.watch-row>.broker,.row-main,.row-note{grid-column:1}
.row-main{display:flex;align-items:center;flex-wrap:wrap;gap:4px 16px;min-width:0}
.broker{flex:1;min-width:0;overflow-wrap:anywhere;font-weight:600}
.broker-type{font-size:11px;font-weight:400;white-space:nowrap}
.meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;font-size:12px;min-width:0}
.latest-trigger{font-size:12px;white-space:nowrap}
.row-note{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap;color:var(--muted);font-size:12px;margin:0 0 3px}
.bars{display:block;grid-column:2;grid-row:1 / -1;align-self:start;width:210px;max-width:100%;height:auto;font-family:inherit}
.axis-label{fill:var(--muted);font-size:8px}.grid{stroke:var(--line)}.zero{stroke:var(--muted)}
.bar-tooltip{position:absolute;z-index:10;pointer-events:none;max-width:calc(100vw - 16px);padding:4px 8px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:5px;box-shadow:0 2px 8px #0002;font-size:12px}
@media(max-width:480px){html body{padding:10px}.watch-row{grid-template-columns:minmax(0,1fr);grid-template-rows:none;gap:5px}.row-main{gap:5px 10px}.meta{flex-basis:100%;overflow-wrap:anywhere}.latest-trigger{white-space:normal;min-width:0}.bars{grid-column:1;grid-row:auto}.stock-header{gap:2px 10px}}
.threshold{stroke:var(--accent);stroke-width:1.5;stroke-dasharray:5 4}
details.others>summary{cursor:pointer;padding:12px 0;font-weight:600}
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
.geo-badge{color:var(--muted)}.geo-local{color:var(--up);border:1px solid var(--up)}
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
<p class="sub">交易日 ${report.tradingDate}｜追蹤 ${items.length} 組｜${hits ? `<b class="pos">近 5 日 ${hits} 組觸發</b>` : "近 5 日無觸發"}｜單位：張，正為買超、負為賣超${report.notion ? "" : "｜名單沿用本機快取"}</p>
<details class="howto">
<summary>📖 本頁說明（點開）</summary>
<div class="body"><ul>
<li>名單維護在 Notion「投資 / 台股 / 贏家分點 / 分點追蹤名單」，每列一組「股票 × 分點」，取消「啟用」即停止追蹤。</li>
<li>近 20 日累計 = 該分點近 20 個交易日買賣超加總，用來判斷分點目前偏多（仍在場上）或偏空（已出貨）；單日觸發看動作，累計看態度。</li>
<li>觸發條件：截至報告交易日（含當日）的最近 5 個交易日，任一天買超／賣超依方向達到門檻；雙向採絕對值。未設門檻不觸發，無交易日補零。觸發分點依最近一次觸發方向分成多方（買超）、空方（賣超）兩區，區內依股票分組，每個分點一列；股票依組內最近觸發日期遞減，同日依組內最佳地緣（地緣、同生活圈、其餘），再依該日最大觸發張數絕對值遞減排序。組內依最近觸發日期、地緣、該次張數絕對值排序。</li>
<li>資料來源：富邦 e01 券商分點進出（約 45 個交易日滾動），每天累積存檔，時間越久歷史越長。</li>
<li>10 日線 = 近 10 個交易日收盤平均（未還原），報告日收盤在其上為「線上」。</li>
<li>分點不代表特定人，僅作籌碼參考；點分點名稱可到 e01 看完整走勢。</li>
</ul></div>
</details>
${hits ? `${section("多方：最近觸發為買超", "pos", longs)}\n${section("空方：最近觸發為賣超", "neg", shorts)}` :'<p class="muted">近 5 個交易日沒有達門檻的分點。</p>'}
<details class="others"><summary>其餘 ${others.length} 組（近 5 日未達門檻）</summary>
<div class="tablebox"><table>
<tr><th>股票</th><th>分點</th><th>等級</th><th>地緣</th><th>今日</th><th>門檻</th><th>最近觸發</th><th>近20日</th><th>近 5 日</th><th>備註</th><th>10日線</th></tr>
${rows}
</table></div></details>
</div>
<div class="bar-tooltip" role="tooltip" hidden></div>
<script>
(() => {
  const tip = document.querySelector('.bar-tooltip');
  let pinned = null;
  const target = (event) => event.target instanceof Element ? event.target.closest('[data-tip]') : null;
  const hide = () => { tip.hidden = true; };
  const show = (bar, event) => {
    tip.textContent = bar.dataset.tip;
    tip.hidden = false;
    const left = Math.max(8, Math.min(event.clientX + 10, window.innerWidth - tip.offsetWidth - 8));
    const top = event.clientY + 12 + tip.offsetHeight > window.innerHeight
      ? Math.max(8, event.clientY - tip.offsetHeight - 12) : event.clientY + 12;
    tip.style.left = (left + window.scrollX) + 'px';
    tip.style.top = (top + window.scrollY) + 'px';
  };
  document.addEventListener('pointerenter', (event) => {
    const bar = target(event);
    if (bar && !pinned && event.pointerType !== 'touch') show(bar, event);
  }, true);
  document.addEventListener('pointermove', (event) => {
    const bar = target(event);
    if (bar && !pinned && event.pointerType !== 'touch') show(bar, event);
  });
  document.addEventListener('pointerleave', (event) => {
    if (target(event) && !pinned) hide();
  }, true);
  document.addEventListener('click', (event) => {
    const bar = target(event);
    if (!bar || pinned === bar) { pinned = null; hide(); }
    else { pinned = bar; show(bar, event); }
  });
  window.addEventListener('scroll', () => { pinned = null; hide(); }, true);
})();
</script>
</body></html>
`;
}

async function main() {
  if (process.argv.includes("--render-only")) {
    const path = resolve(process.cwd(), "data/broker-watch-latest.json");
    const latest: BrokerReport = JSON.parse(readFileSync(path, "utf8"));
    const configPath = resolve(process.cwd(), "data/broker-watch-config.json");
    const config: WatchItem[] = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")).items : [];
    const byPageId = new Map(config.filter((i) => i.pageId).map((i) => [i.pageId, i]));
    const byPair = new Map(config.map((i) => [`${i.stockCode}-${i.brokerCode}`, i]));
    const report = await withMa10(withRecent5({ ...latest, items: latest.items.map((item) => {
      const cached = byPageId.get(item.pageId) ?? byPair.get(`${item.stockCode}-${item.brokerCode}`);
      return { ...item, geo: item.geo ?? cached?.geo ?? "未知", geoReason: item.geoReason ?? cached?.geoReason ?? "" };
    }) }), (date) => {
      const cache = resolve(process.cwd(), `data/cache/close-${date}.json`);
      return existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : undefined;
    });
    writeFileSync(path, JSON.stringify(report, null, 2));
    writeFileSync(resolve(process.cwd(), "data/broker-watch.html"), renderHtml(report));
    console.log(`[broker-watch] render-only ${report.tradingDate}：追蹤 ${report.items.length} 組，近 5 日觸發 ${triggeredPairs(report.items).length} 組（無網路抓取）`);
    return;
  }
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

  const brokers = parseBrokerList(await fetchE01("/z/js/zbrokerjs.djjs", 0));
  const historyDir = resolve(process.cwd(), "data/broker-watch-history");
  mkdirSync(historyDir, { recursive: true });

  const results = [];
  for (const [index, item] of watchlist.entries()) {
    const broker = brokers.get(item.brokerCode) ?? brokers.get(item.brokerCode.toUpperCase()) ?? brokers.get(normalizeBrokerName(item.broker));
    if (!item.stockCode || !broker) {
      console.warn(`[broker-watch] [warn] ${item.title}：${!item.stockCode ? "缺股票代號" : `找不到分點「${item.brokerCode || item.broker}」`}，略過`);
      results.push({ ...item, status: "unresolved" as const });
      continue;
    }

    let fresh: DayNet[] = [];
    try {
      fresh = parseBcdData(await fetchE01(`/z/zc/zco/zco0/zco0.djhtm?a=${item.stockCode}&BHID=${broker.hq}&b=${broker.code}`, index), date);
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
    if (!item.brokerCode) props["分點代號"] = { rich_text: [{ type: "text", text: { content: displayBrokerCode(broker.code) } }] };
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

  const report = await withMa10(withRecent5({ tradingDate: date, notion: notionOk, items: results }));
  writeFileSync(resolve(process.cwd(), "data/broker-watch-latest.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(process.cwd(), "data/broker-watch.html"), renderHtml(report));
  const hits = triggeredPairs(report.items);
  const stale = results.filter((r) => r.status === "stale").length;
  console.log(`[broker-watch] ${date}：追蹤 ${results.length} 組，近 5 日觸發 ${hits.length} 組${stale ? `，${stale} 組 e01 尚未更新到當日` : ""}`);
  for (const item of hits) {
    const r = { ...item, ...recentTrigger(item) };
    console.log(`[broker-watch]   ${r.stockName}(${r.stockCode}) × ${r.broker}：${r.net > 0 ? "買超" : "賣超"} ${Math.abs(r.net)} 張（門檻 ${r.threshold}，${r.date}）`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error("[broker-watch] failed:", error); process.exitCode = 1; });
}
