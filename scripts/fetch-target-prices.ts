#!/usr/bin/env npx tsx
/**
 * 法人目標價追蹤 — 純規則、零 LLM。
 *
 * 資料源：鉅亨網台股新聞列表 API（免金鑰，列表本身就帶全文）＋ Google News RSS（只有標題）。
 *
 * 1. 「鉅亨速報 - Factset 最新調查」：FactSet 分析師共識有變動時才發，格式固定只有兩種：
 *    - EPS 版：「共 N 位分析師，對 X 做出 YYYY 年 EPS 預估：中位數由 a 元上修至 b 元，
 *      其中最高估值 h 元，最低估值 l 元，預估目標價為 T 元。」
 *    - 目標價版：「共 N 位分析師，對 X 提出目標價估值：中位數由 a 元上修至 b 元，
 *      調升幅度 p%。其中最高估值 h 元，最低估值 l 元。」← 有最高／最低目標價
 *    regex 解析，解不出來的會列出來，不會默默丟掉。
 * 2. 個別券商目標價新聞：鉅亨台股分類裡標題含「目標價」的，加上 Google News RSS 搜尋
 *    （涵蓋經濟日報、工商、Yahoo 等）。只存標題，計算時才用 lib/target-news.ts 抽出
 *    股票／券商／目標價，所以改良抽取規則後，歷史標題也會套用新規則。
 *
 * 因為速報只在「有變動」時才發，一檔股票的共識目標價 = 歷史裡最新的那一則，
 * 用最新收盤價算空間。超過 STALE_DAYS 天沒更新的共識視為過期，不列入名單。
 *
 * 讀：data/cache/close-*.json（lib/twse-closes.ts，沒有就抓）
 * 寫：data/target-price-history/<YYYY-MM>.json — 原始事件，依新聞 id 去重
 *     data/target-price-latest.json — 每檔最新共識 + 空間，≥ 門檻的名單與首次進榜日
 *     data/target-price.html — 發佈到日報網站的子頁 /target-price.html
 *
 * 用法：
 *   npx tsx scripts/fetch-target-prices.ts              # 抓最近 3 天
 *   npx tsx scripts/fetch-target-prices.ts --days 60    # 回補
 *   npx tsx scripts/fetch-target-prices.ts --from 2024-01-01 [--to 2024-06-30]   # 回補（速報 2024 年才開始有）
 *   npx tsx scripts/fetch-target-prices.ts --offline    # 不抓新聞，只用歷史重算
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { twDate, twIso } from "./lib/time";
import { closesOn, isTradingDay } from "./lib/twse-closes";
import { renderTargetPricePage } from "./lib/target-price-page";
import { GOOGLE_QUERIES, buildNameIndex, extractTargetCall, fetchGoogleNews, isUnnamedBroker, type NameIndex, type TargetCall } from "./lib/target-news";

const ROOT = process.cwd();
const HISTORY_DIR = resolve(ROOT, "data/target-price-history");
const OUT_LATEST = resolve(ROOT, "data/target-price-latest.json");
const OUT_HTML = resolve(ROOT, "data/target-price.html");
const GATE = Number(process.env.TARGET_UPSIDE_GATE ?? 0.2);
const STALE_DAYS = Number(process.env.TARGET_STALE_DAYS ?? 90);
const WINDOW_DAYS = 2; // 鉅亨列表一次查詢最多翻 30 頁（約 900 則）；台股分類一天約 70~450 則，2 天一窗留足餘裕
const DAY_MS = 86_400_000;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DAYS = Number(arg("--days") ?? 3);
const FROM = arg("--from");
const TO = arg("--to");
const OFFLINE = process.argv.includes("--offline");

export interface FactsetEvent {
  id: number;
  date: string; // 台北日期
  publishedAt: string;
  code: string;
  name: string;
  kind: "eps" | "target";
  direction: "up" | "down";
  analysts: number;
  /** EPS 版：預估年度與中位數前後值、最高最低 */
  epsYear?: number;
  epsPrev?: number;
  eps?: number;
  epsHigh?: number;
  epsLow?: number;
  /** 兩種都有：共識目標價（中位數） */
  target: number;
  /** 目標價版才有 */
  targetPrev?: number;
  targetHigh?: number;
  targetLow?: number;
  url: string;
}

/** 原始標題。id：鉅亨是新聞編號、Google 是 "g:" + 標題雜湊（同一標題多家轉載只留一則） */
export interface Headline {
  id: number | string;
  date: string;
  title: string;
  source?: string;
  url: string;
}

/** 從標題抽出、而且有目標價數字的個別券商意見 */
export interface BrokerCall extends TargetCall {
  date: string;
  title: string;
  url: string;
  sources: string[];
  close: number | null;
  upside: number | null;
}

interface MonthFile {
  factset: Record<string, FactsetEvent>;
  headlines: Record<string, Headline>;
}

/** 32-bit FNV-1a，只拿來當標題去重的 key */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
const newsUrl = (id: number) => `https://news.cnyes.com/news/id/${id}`;
const num = (s: string) => Number(s.replace(/,/g, ""));
const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const firstParagraph = (content: string) => decode(decode(content).split("</p>")[0]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const N = String.raw`(-?[\d,]+(?:\.\d+)?)`;
const HEAD = String.raw`共(\d+)位分析師，對(.+?)\((\w+)-TW\)`;
const RE_EPS = new RegExp(
  `${HEAD}做出(\\d{4})年EPS預估：中位數由${N}元(上修|下修)至${N}元，其中最高估值${N}元，最低估值${N}元，預估目標價為${N}元`,
);
const RE_TARGET = new RegExp(
  `${HEAD}提出目標價估值：中位數由${N}元(上修|下修)至${N}元，調[升降]幅度${N}%。其中最高估值${N}元，最低估值${N}元`,
);

export function parseFactset(id: number, publishAt: number, content: string): FactsetEvent | null {
  const p = firstParagraph(content);
  const base = { id, date: twDate(new Date(publishAt * 1000)), publishedAt: twIso(new Date(publishAt * 1000)), url: newsUrl(id) };
  let m = p.match(RE_EPS);
  if (m) {
    return {
      ...base, analysts: +m[1], name: m[2], code: m[3], kind: "eps",
      epsYear: +m[4], epsPrev: num(m[5]), direction: m[6] === "上修" ? "up" : "down", eps: num(m[7]),
      epsHigh: num(m[8]), epsLow: num(m[9]), target: num(m[10]),
    };
  }
  m = p.match(RE_TARGET);
  if (m) {
    return {
      ...base, analysts: +m[1], name: m[2], code: m[3], kind: "target",
      targetPrev: num(m[4]), direction: m[5] === "上修" ? "up" : "down", target: num(m[6]),
      targetHigh: num(m[8]), targetLow: num(m[9]),
    };
  }
  return null;
}

async function getJson(url: string, attempts = 4): Promise<any> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`${url}: ${(last as Error)?.message}`);
}

/** 依台北日期切窗抓鉅亨台股新聞，回傳原始項目 */
async function fetchCnyes(fromDate: string, toDate: string): Promise<any[]> {
  const out: any[] = [];
  const tw = (d: string) => Date.parse(`${d}T00:00:00+08:00`) / 1000;
  for (let s = tw(fromDate); s <= tw(toDate); s += WINDOW_DAYS * 86400) {
    const e = Math.min(s + WINDOW_DAYS * 86400, tw(toDate) + 86400) - 1;
    for (let page = 1; ; page++) {
      const j = await getJson(
        `https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?startAt=${s}&endAt=${e}&limit=30&page=${page}`,
      );
      const items = j.items;
      out.push(...(items.data ?? []));
      if (page >= items.last_page) break;
      if (page >= 30) {
        console.warn(`⚠️ ${twDate(new Date(s * 1000))} 起的視窗超過 30 頁上限，可能漏抓`);
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return out;
}

const monthPath = (ym: string) => resolve(HISTORY_DIR, `${ym}.json`);
function loadMonth(ym: string): MonthFile {
  const p = monthPath(ym);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : { factset: {}, headlines: {} };
}

function loadAllEvents(): FactsetEvent[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .flatMap((f) => Object.values((JSON.parse(readFileSync(resolve(HISTORY_DIR, f), "utf-8")) as MonthFile).factset));
}

/**
 * 最近一個有開盤日的收盤價。上櫃收盤比上市晚出來，盤中或剛收盤時當天只有上市，
 * 缺的代號用前一個交易日補，並記下每檔用的是哪天的收盤。
 */
type Closes = Record<string, { close: number; date: string }>;
async function latestCloses(): Promise<{ date: string; closes: Closes }> {
  const out: Closes = {};
  let date = "";
  let days = 0;
  for (let back = 0; back < 12 && days < 3; back++) {
    const d = twDate(new Date(Date.now() - back * DAY_MS));
    const closes = await closesOn(d.replace(/-/g, ""), ROOT);
    if (!isTradingDay(closes)) continue;
    date ||= d;
    days++;
    for (const [code, close] of Object.entries(closes)) out[code] ??= { close, date: d };
  }
  if (!date) throw new Error("最近 12 天都抓不到收盤價");
  return { date, closes: out };
}

async function main() {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const today = twDate();

  if (!OFFLINE) {
    const from = FROM ?? twDate(new Date(Date.now() - (DAYS - 1) * DAY_MS));
    const to = TO ?? today;
    console.log(`抓鉅亨台股新聞 ${from} ~ ${to}`);
    const raw = await fetchCnyes(from, to);
    const months = new Map<string, MonthFile>();
    const month = (d: string) => {
      const ym = d.slice(0, 7);
      if (!months.has(ym)) months.set(ym, loadMonth(ym));
      return months.get(ym)!;
    };
    let fs = 0;
    let hl = 0;
    const unparsed: string[] = [];
    for (const it of raw) {
      const title: string = it.title ?? "";
      const date = twDate(new Date(it.publishAt * 1000));
      if (/factset/i.test(title)) {
        if (!/-TW\)/.test(title)) continue;
        const ev = parseFactset(it.newsId, it.publishAt, it.content ?? "");
        if (ev) {
          month(date).factset[ev.id] = ev;
          fs++;
        } else unparsed.push(`${date} ${title}`);
      } else if (title.includes("目標價")) {
        month(date).headlines[it.newsId] = { id: it.newsId, date, title, source: "鉅亨網", url: newsUrl(it.newsId) };
        hl++;
      }
    }
    // Google News 只回近幾天（when:Nd，上限 100 則／查詢），回補長區間時沒有意義，只在日常模式抓
    let gn = 0;
    if (!FROM) {
      const seen = new Set<string>();
      for (const q of GOOGLE_QUERIES) {
        try {
          for (const it of await fetchGoogleNews(q, Math.min(DAYS + 1, 30))) {
            if (!it.title.includes("目標價") || seen.has(it.title)) continue;
            seen.add(it.title);
            const date = twDate(new Date(it.publishedAt));
            const id = `g:${hash(it.title)}`;
            month(date).headlines[id] ??= { id, date, title: it.title, source: it.source, url: it.url };
            gn++;
          }
        } catch (e) {
          console.warn(`⚠️ Google News「${q}」失敗：${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    for (const [ym, data] of months) writeFileSync(monthPath(ym), JSON.stringify(data, null, 1));
    console.log(`新聞 ${raw.length} 則 → FactSet 速報 ${fs} 則、鉅亨目標價新聞 ${hl} 則、Google News 目標價標題 ${gn} 則`);
    if (unparsed.length) {
      console.warn(`⚠️ ${unparsed.length} 則 FactSet 速報格式解不出來：`);
      for (const u of unparsed.slice(0, 10)) console.warn(`   ${u}`);
    }
  }

  const { closeDate, closes, rows, firstSeen } = await buildRows();
  const qualified = rows.filter((r) => r.qualified);
  const { calls, related } = buildBrokerCalls(closeDate, closes, rows);

  const result: TargetPriceLatest = {
    generatedAt: twIso(),
    closeDate,
    gate: GATE,
    staleDays: STALE_DAYS,
    coverage: { stocks: rows.length, fresh: rows.filter((r) => !r.stale).length, noClose: rows.filter((r) => r.close === null).length },
    firstSeen,
    rows,
    brokerCalls: calls,
    relatedNews: related,
  };
  writeFileSync(OUT_LATEST, JSON.stringify(result, null, 1));
  writeFileSync(OUT_HTML, renderTargetPricePage(result));

  const pct = (v: number | null) => (v === null ? "  —  " : `${(v * 100).toFixed(1).padStart(5)}%`);
  console.log(
    `[target-price] 收盤日 ${closeDate}｜有共識 ${rows.length} 檔（${STALE_DAYS} 天內更新 ${result.coverage.fresh} 檔）` +
      `｜空間 ≥ ${GATE * 100}%：${qualified.length} 檔（新進榜 ${qualified.filter((r) => r.isNew).length}）`,
  );
  for (const r of qualified.filter((r) => r.isNew)) {
    console.log(`  🆕 ${r.code} ${r.name} 收 ${r.close} 目標 ${r.target} 空間 ${pct(r.upside)} 最樂觀 ${pct(r.upsideHigh)}`);
  }
  console.log(`[target-price] 近 ${NEWS_DAYS} 天個別券商目標價 ${calls.length} 則（空間 ≥ ${GATE * 100}%：${calls.filter((c) => (c.upside ?? -1) >= GATE).length}），其他相關標題 ${related.length} 則`);
}

const NEWS_DAYS = 14;

function loadNameIndex(rows: TargetRow[]): NameIndex {
  const map: Record<string, { name: string }> = {};
  for (const r of rows) map[r.code] = { name: r.name };
  const market = resolve(ROOT, "data/market-latest.json");
  if (existsSync(market)) Object.assign(map, JSON.parse(readFileSync(market, "utf-8")).stockMap ?? {});
  else console.warn("⚠️ 沒有 data/market-latest.json，股票名稱只認得有 FactSet 共識的那些");
  return buildNameIndex(map);
}

/**
 * 近 NEWS_DAYS 天的標題 → 個別券商意見。同一檔、同一目標價在 3 天內，券商相同或其中一則
 * 沒寫是哪家（「外資」「美系外資」），視為同一份報告的轉載，合併成一則：保留最早那則的標題與
 * 連結、券商換成有具名的、媒體名稱累加。
 *
 * 目標價跟收盤差太多（< 0.4 倍或 > 3 倍）的通常是抽錯（「EPS 挑戰 40 元」、數字其實屬於
 * 標題裡沒寫名字的另一檔），降級成相關標題。
 */
function buildBrokerCalls(closeDate: string, closes: Closes, rows: TargetRow[]) {
  const names = loadNameIndex(rows);
  const since = twDate(new Date(Date.parse(`${closeDate}T00:00:00+08:00`) - NEWS_DAYS * DAY_MS));
  const heads = loadAllHeadlines().filter((h) => h.date >= since).sort((a, b) => a.date.localeCompare(b.date));
  const calls: BrokerCall[] = [];
  const related: (Headline & { code: string; name: string })[] = [];
  for (const h of heads) {
    const c = extractTargetCall(h.title, names);
    if (!c) continue;
    const close = closes[c.code]?.close ?? null;
    const implausible = c.target !== null && close !== null && (c.target / close < 0.4 || c.target / close > 3);
    if (c.target === null || implausible) {
      if (!related.some((r) => r.title === h.title)) related.push({ ...h, code: c.code, name: c.name });
      continue;
    }
    const dup = calls.find(
      (x) => x.code === c.code && x.target === c.target && Date.parse(h.date) - Date.parse(x.date) <= 3 * DAY_MS &&
        (x.brokers[0] === c.brokers[0] || isUnnamedBroker(x.brokers[0]) || isUnnamedBroker(c.brokers[0])),
    );
    if (dup) {
      if (isUnnamedBroker(dup.brokers[0]) && !isUnnamedBroker(c.brokers[0])) dup.brokers = c.brokers;
      if (h.source && !dup.sources.includes(h.source)) dup.sources.push(h.source);
      dup.prevTarget ??= c.prevTarget;
      dup.direction ??= c.direction;
      continue;
    }
    calls.push({ ...c, date: h.date, title: h.title, url: h.url, sources: h.source ? [h.source] : [], close, upside: close ? c.target / close - 1 : null });
  }
  calls.sort((a, b) => b.date.localeCompare(a.date) || (b.upside ?? -9) - (a.upside ?? -9));
  related.sort((a, b) => b.date.localeCompare(a.date));
  return { calls, related };
}

export interface TargetRow {
  code: string;
  name: string;
  close: number | null;
  /** 收盤不是 closeDate 那天的（上櫃收盤還沒出來，用前一個交易日）才有 */
  closeDate?: string;
  target: number;
  upside: number | null;
  targetHigh: number | null;
  upsideHigh: number | null;
  targetLow: number | null;
  analysts: number;
  /** 約 30 天前的共識目標價（那之前最後一則速報）；沒有就 null */
  target30d: number | null;
  lastEvent: { date: string; kind: "eps" | "target"; direction: "up" | "down"; url: string };
  stale: boolean;
  qualified: boolean;
  firstSeen: string | null;
  isNew: boolean;
}

export interface TargetPriceLatest {
  generatedAt: string;
  closeDate: string;
  gate: number;
  staleDays: number;
  coverage: { stocks: number; fresh: number; noClose: number };
  /** 代號 → 這次連續在榜的第一天；掉出名單就移除，下次再進來重新算 */
  firstSeen: Record<string, string>;
  rows: TargetRow[];
  brokerCalls: BrokerCall[];
  /** 認得出股票、但標題裡沒有目標價數字（或有「這檔」之類代稱）的相關新聞 */
  relatedNews: (Headline & { code: string; name: string })[];
}

function loadAllHeadlines(): Headline[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .flatMap((f) => Object.values((JSON.parse(readFileSync(resolve(HISTORY_DIR, f), "utf-8")) as MonthFile).headlines))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** 每檔取最新共識、算空間、維護首次進榜日 */
async function buildRows(): Promise<{ closeDate: string; closes: Closes; rows: TargetRow[]; firstSeen: Record<string, string> }> {
  const events = loadAllEvents().sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const { date: closeDate, closes } = await latestCloses();
  const closeMs = Date.parse(`${closeDate}T00:00:00+08:00`);
  const staleBefore = twDate(new Date(closeMs - STALE_DAYS * DAY_MS));
  const ago30 = twDate(new Date(closeMs - 30 * DAY_MS));

  const latest = new Map<string, FactsetEvent>();
  // 最高／最低目標價只有「目標價版」速報才有，往回找最近一則
  const latestTargetKind = new Map<string, FactsetEvent>();
  const before30 = new Map<string, FactsetEvent>();
  for (const ev of events) {
    if (ev.date > closeDate) continue;
    latest.set(ev.code, ev);
    if (ev.kind === "target") latestTargetKind.set(ev.code, ev);
    if (ev.date <= ago30) before30.set(ev.code, ev);
  }

  const prev: Partial<TargetPriceLatest> = existsSync(OUT_LATEST) ? JSON.parse(readFileSync(OUT_LATEST, "utf-8")) : {};
  const prevFirstSeen = prev.firstSeen ?? {};
  const firstSeen: Record<string, string> = {};

  const rows: TargetRow[] = [...latest.values()].map((ev) => {
    const c = closes[ev.code];
    const close = c?.close ?? null;
    const t = latestTargetKind.get(ev.code);
    // 目標價版的高低值只在之後沒有新的共識目標價時才和現在的中位數對得上
    const range = t && t.target === ev.target ? t : null;
    const upside = close ? ev.target / close - 1 : null;
    const stale = ev.date < staleBefore;
    const qualified = !stale && upside !== null && upside >= GATE;
    // 同一天重跑時 prev 已經含今天，沿用即可；只有不在 prev 的才是今天新進
    if (qualified) firstSeen[ev.code] = prevFirstSeen[ev.code] ?? closeDate;
    return {
      code: ev.code,
      name: ev.name,
      close,
      closeDate: c && c.date !== closeDate ? c.date : undefined,
      target: ev.target,
      upside,
      targetHigh: range?.targetHigh ?? null,
      upsideHigh: close && range?.targetHigh ? range.targetHigh / close - 1 : null,
      targetLow: range?.targetLow ?? null,
      analysts: ev.analysts,
      target30d: before30.get(ev.code)?.target ?? null,
      lastEvent: { date: ev.date, kind: ev.kind, direction: ev.direction, url: ev.url },
      stale,
      qualified,
      firstSeen: firstSeen[ev.code] ?? null,
      isNew: qualified && firstSeen[ev.code] === closeDate,
    };
  });
  rows.sort((a, b) => (b.upside ?? -9) - (a.upside ?? -9));
  return { closeDate, closes, rows, firstSeen };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
