/** 週榜前 15 名是截斷觀測；未入榜不代表沒有交易，報酬使用快取週均價估算。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { E01_HOSTS, displayBrokerCode, parseBrokerList } from "./fetch-broker-watch";

export type Branch = { code: string; hq: string; name: string; buy: number; sell: number; net: number };
export type Week = { stock: string; monday: string; friday: string; fetchedAt: string; host: string; branches: Branch[] };
export type Price = { mean: number | null; days: number };
type Episode = {
  side: "long" | "short"; start: string; end: string; weeks: number; observedWeeks: number;
  unknownWeeks: number; missingPriceWeeks: string[]; status: "open" | "closed";
  bought: number; sold: number; qty: number; position: number; peakPosition: number;
  avgIn: number | null; avgOut: number | null; return: number | null;
  unrealizedReturn: number | null; churn: number; amount: number | null; amountYi: number | null;
};
export const MIN_FUT_VOLUME = 50;
export const WIN_RETURN = 0.15;
export const MIN_OBSERVED_WEEKS = 3;
export const MIN_DIRECTIONALITY = 0.6;
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new () => { window: { document: Document } } };
const textElement = new JSDOM().window.document.createElement("div");
// Decode named/numeric HTML entities with the HTML parser, including Big5 extension references.
export function clean(s: string): string {
  textElement.innerHTML = s;
  return (textElement.textContent ?? "").replace(/\u00a0/g, " ").replace(/\(牛牛牛\)/g, "犇").trim();
}

export function futuresUniverse(): string[] {
  const { futVolume } = JSON.parse(readFileSync(resolve("data/pullback-scan-latest.json"), "utf8"));
  if (!futVolume || typeof futVolume !== "object") throw new Error("缺少 futVolume");
  return Object.keys(futVolume).filter((code) => futVolume[code]?.avg >= MIN_FUT_VOLUME);
}

const dayMs = 86400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s) + n * dayMs));
const mondayOf = (s: string) => addDays(s, -((new Date(s).getUTCDay() + 6) % 7));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseRanking(html: string, stock: string): Branch[] {
  const branches = new Map<string, Branch>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length !== 10) continue;
    for (const offset of [0, 5]) {
      const link = cells[offset].match(/href\s*=\s*["']([^"']*zco0\.djhtm[^"']*)["']/i);
      if (!link) continue;
      const url = new URL(clean(link[1]), E01_HOSTS[0]);
      const code = url.searchParams.get("b");
      const hq = url.searchParams.get("BHID") ?? "";
      if (url.searchParams.get("a") !== stock || !code) throw new Error("券商連結缺少股票／分點代號");
      const values = cells.slice(offset + 1, offset + 4).map((s) => Number(clean(s).replace(/,/g, "")));
      if (!values.every(Number.isFinite)) throw new Error("券商張數無法解析");
      const [buy, sell] = values;
      const key = displayBrokerCode(code); // 大小寫是不同分點，不可 uppercase
      const branch = { code, hq, name: clean(cells[offset]), buy, sell, net: buy - sell };
      const old = branches.get(key);
      if (old && (old.buy !== buy || old.sell !== sell)) throw new Error(`兩側榜單數字不一致 ${code}`);
      branches.set(key, branch); // 同一分點在兩側只計一次
    }
  }
  return [...branches.values()];
}

// 每個 host 序列化，起始間距至少一秒；fallback 也共用同一把鎖。
const queues = E01_HOSTS.map(() => Promise.resolve());
const lastStart = E01_HOSTS.map(() => 0);
async function onHost<T>(index: number, work: () => Promise<T>): Promise<T> {
  const previous = queues[index];
  let release!: () => void;
  queues[index] = new Promise<void>((r) => { release = r; });
  await previous;
  try {
    await sleep(Math.max(0, lastStart[index] + 1000 - Date.now()));
    lastStart[index] = Date.now();
    return await work();
  } finally { release(); }
}

async function fetchWeek(stock: string, monday: string, index: number): Promise<Week> {
  const friday = addDays(monday, 4);
  const errors: string[] = [];
  for (let attempt = 0; attempt < E01_HOSTS.length; attempt++) {
    const hostIndex = (index + attempt) % E01_HOSTS.length;
    const host = E01_HOSTS[hostIndex];
    try {
      return await onHost(hostIndex, async () => {
        const response = await fetch(`${host}/z/zc/zco/zco.djhtm?a=${stock}&e=${monday}&f=${friday}`, {
          headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = new TextDecoder("big5").decode(await response.arrayBuffer());
        const start = html.match(/var\s+getYMD2\s*=\s*'([^']+)'/)?.[1]?.replaceAll("/", "-");
        const end = html.match(/var\s+getYMD1\s*=\s*'([^']+)'/)?.[1]?.replaceAll("/", "-");
        if (start !== monday || end !== friday) throw new Error(`區間不符 ${start}~${end}`);
        const branches = parseRanking(html, stock);
        if (!branches.length && !/無資料|查無|沒有資料/.test(html)) throw new Error("空白／非排名頁");
        return { stock, monday, friday, fetchedAt: new Date().toISOString(), host, branches };
      });
    } catch (error) {
      errors.push(`${host}: ${(error as Error).message}`);
      if (attempt === 0) console.warn(`[scan] ${stock} ${monday} ${errors[0]}，換站`);
    }
  }
  throw new Error(`${stock} ${monday} 全站失敗: ${errors.join("; ")}`);
}

export function analyzeEpisodes(weeks: Week[], code: string, prices: Map<string, Price>, mark: number | null): Episode[] {
  const episodes: Episode[] = [];
  let active: { episode: Episode; buyCost: number; sellValue: number; gross: number; net: number } | null = null;
  for (const week of weeks) {
    const branch = week.branches.find((b) => displayBrokerCode(b.code) === code);
    const net = branch?.net ?? 0;
    if (!active && !net) continue;
    if (!active) active = {
      episode: { side: net > 0 ? "long" : "short", start: week.monday, end: week.friday,
        weeks: 0, observedWeeks: 0, unknownWeeks: 0, missingPriceWeeks: [], status: "open",
        bought: 0, sold: 0, qty: 0, position: 0, peakPosition: 0, avgIn: null, avgOut: null,
        return: null, unrealizedReturn: null, churn: 0, amount: null, amountYi: null },
      buyCost: 0, sellValue: 0, gross: 0, net: 0,
    };
    const a = active;
    const e = a.episode;
    e.weeks++;
    e.end = week.friday;
    if (branch) e.observedWeeks++; else e.unknownWeeks++;
    a.gross += (branch?.buy ?? 0) + (branch?.sell ?? 0);
    a.net += net;
    const price = prices.get(week.monday)?.mean ?? null;
    if (net && price === null) e.missingPriceWeeks.push(week.monday);
    if (net > 0) { e.bought += net; a.buyCost += net * (price ?? 0); }
    if (net < 0) { e.sold -= net; a.sellValue -= net * (price ?? 0); }
    e.position = e.side === "long" ? e.bought - e.sold : e.sold - e.bought;
    e.peakPosition = Math.max(e.peakPosition, e.position);
    e.qty = e.side === "long" ? e.bought : e.sold;
    e.churn = a.gross ? Math.abs(a.net) / a.gross : 0;
    if (!e.missingPriceWeeks.length) {
      e.avgIn = e.side === "long" ? a.buyCost / e.bought : a.sellValue / e.sold;
      e.avgOut = e.side === "long" ? (e.sold ? a.sellValue / e.sold : null) : (e.bought ? a.buyCost / e.bought : null);
      e.amount = (e.side === "long" ? a.buyCost : a.sellValue) * 1000; // 張 → 股 → 元
      e.amountYi = e.amount / 1e8;
    } else {
      e.avgIn = null;
      e.avgOut = null;
      e.amount = null;
      e.amountYi = null;
    }
    const closed = e.side === "long" ? e.sold >= e.bought / 2 : e.bought >= e.sold / 2;
    if (closed) {
      e.status = "closed";
      if (e.avgIn !== null && e.avgOut !== null) e.return = e.side === "long" ? e.avgOut / e.avgIn - 1 : e.avgIn / e.avgOut - 1;
      episodes.push(e);
      active = null; // 半渡即結束，殘餘部位不帶入下一段
    }
  }
  if (active) {
    const e = active.episode;
    if (mark !== null && e.avgIn !== null) e.unrealizedReturn = e.side === "long" ? mark / e.avgIn - 1 : e.avgIn / mark - 1;
    episodes.push(e);
  }
  return episodes;
}

function dateArg(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || iso(new Date(value)) !== value) throw new Error(`日期無效: ${value}`);
  return value;
}

// Episode P&L is NT$; branch/candidate P&L below is 億 NT$.
export function episodePnl(e: Episode, mark: number | null): number | null {
  if (e.avgIn === null) return null;
  if (e.status === "closed") {
    if (e.avgOut === null) return null;
    return Math.min(e.bought, e.sold) * (e.side === "long" ? e.avgOut - e.avgIn : e.avgIn - e.avgOut) * 1000;
  }
  if (mark === null) return null;
  return Math.abs(e.position) * (e.side === "long" ? mark - e.avgIn : e.avgIn - mark) * 1000;
}

function compactEpisode(e: Episode, mark: number | null) {
  return { side: e.side, start: e.start, end: e.end, status: e.status,
    observedWeeks: e.observedWeeks, unknownWeeks: e.unknownWeeks, position: e.position,
    bought: e.bought, sold: e.sold, avgIn: e.avgIn, avgOut: e.avgOut,
    return: e.status === "closed" ? e.return : e.unrealizedReturn, pnl: episodePnl(e, mark) };
}

export async function loadBrokerNames(root: string, offline: boolean): Promise<Map<string, string>> {
  const path = resolve(root, "zbrokerjs.djjs");
  let js = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!js && !offline) {
    for (let i = 0; i < E01_HOSTS.length; i++) {
      try {
        js = await onHost(i, async () => {
          const response = await fetch(`${E01_HOSTS[i]}/z/js/zbrokerjs.djjs`, { signal: AbortSignal.timeout(20_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = new TextDecoder("big5").decode(await response.arrayBuffer());
          if (!parseBrokerList(body).size) throw new Error("空白券商名單");
          return body;
        });
        writeFileSync(path, js);
        break;
      } catch (error) { console.warn(`[scan] 券商名單 ${E01_HOSTS[i]}: ${(error as Error).message}，換站`); }
    }
  }
  const names = new Map<string, string>();
  // Iterate values: parseBrokerList's uppercase lookup keys collapse case-sensitive codes.
  for (const b of parseBrokerList(js).values()) names.set(displayBrokerCode(b.code), clean(b.name));
  if (!names.size) console.warn("[scan] 無券商名單快取；空白名稱無法補齊");
  return names;
}

/** mark must be a close available at cutoff; prices are keyed by week Monday. */
export function gradeBranches(
  inputWeeks: Week[], prices: Map<string, Price>, mark: number | null,
  brokerNames: Map<string, string>, options: { cutoff?: string; winReturn?: number } = {},
) {
  const weeks = options.cutoff ? inputWeeks.filter((w) => w.friday <= options.cutoff!) : inputWeeks;
  const winReturn = options.winReturn ?? WIN_RETURN;
  const raw = weeks.flatMap((w) => w.branches);
  const identities = new Map(raw.map((b) => [displayBrokerCode(b.code), b]));
  const totals = new Map<string, { net: number; gross: number }>();
  for (const b of raw) {
    const code = displayBrokerCode(b.code);
    const t = totals.get(code) ?? { net: 0, gross: 0 };
    t.net += Math.abs(b.net);
    t.gross += b.buy + b.sell;
    totals.set(code, t);
  }
  const filteredReasons = { directionality: 0, inactive: 0, nonPositivePnl: 0, noQualifyingEpisode: 0, missingPrice: 0 };
  const unresolvedNames: string[] = [];
  const branches = [...identities].flatMap(([code, b]) => {
    const resolvedName = clean(b.name) || brokerNames.get(code) || "";
    const name = resolvedName || `未命名分點(${code})`;
    const total = totals.get(code)!;
    const D = total.gross ? total.net / total.gross : 0;
    if (name.includes("(停)")) { filteredReasons.inactive++; return []; }
    if (D < MIN_DIRECTIONALITY) { filteredReasons.directionality++; return []; }
    const episodes = analyzeEpisodes(weeks, code, prices, mark);
    const wins = episodes.filter((e) => e.observedWeeks >= MIN_OBSERVED_WEEKS && e.status === "closed" && e.return !== null && e.return >= winReturn).length;
    const holdingWinner = episodes.some((e) => e.observedWeeks >= MIN_OBSERVED_WEEKS && e.status === "open" && e.unrealizedReturn !== null && e.unrealizedReturn >= winReturn);
    const pnls = episodes.map((e) => episodePnl(e, mark));
    // An unknown episode P&L makes the branch total unknown; never rank a partial sum.
    if (pnls.some((p) => p === null)) { filteredReasons.missingPrice++; return []; }
    const pnl = pnls.reduce((sum, p) => sum + p!, 0) / 1e8;
    if (pnl <= 0) { filteredReasons.nonPositivePnl++; return []; }
    const list = wins >= 2 ? "A" : wins === 1 ? "B" : holdingWinner ? "holding" : null;
    if (!list) { filteredReasons.noQualifyingEpisode++; return []; }
    if (!resolvedName) unresolvedNames.push(code);
    const open = [...episodes].reverse().find((e) => e.status === "open");
    return [{ name, displayCode: code, hq: b.hq, D, wins, pnl, list,
      latestOpen: open ? compactEpisode(open, mark) : null,
      episodes: episodes.map((e) => compactEpisode(e, mark)) }];
  });
  return { identities, filteredReasons, unresolvedNames, branches };
}

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  let offline = false;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--offline") { offline = true; i--; continue; }
    if (!["--stocks", "--universe", "--from", "--to"].includes(args[i]) || !args[i + 1]) throw new Error("用法: (--stocks 5347,6269 | --universe futures) [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--offline]");
    options.set(args[i], args[i + 1]);
  }
  if (options.has("--universe") && options.get("--universe") !== "futures") throw new Error("--universe 僅支援 futures");
  const stocks = [...new Set(options.has("--stocks") ? options.get("--stocks")!.split(",") : options.has("--universe") ? futuresUniverse() : [])];
  if (!stocks.length || !stocks.every((s) => /^\d{4,6}$/.test(s))) throw new Error("請指定 --stocks");
  const today = iso(new Date(Date.now() + 8 * 3600_000));
  const currentMonday = mondayOf(today);
  // 星期五盤後即為完成週；其餘平日使用前一週。
  const taipeiHour = new Date(Date.now() + 8 * 3600_000).getUTCHours();
  const weekday = new Date(today).getUTCDay();
  const defaultTo = (weekday === 5 && taipeiHour >= 15) || weekday === 6 || weekday === 0 ? addDays(currentMonday, 4) : addDays(currentMonday, -3);
  const from = mondayOf(dateArg(options.get("--from") ?? "2022-06-06"));
  const to = dateArg(options.get("--to") ?? defaultTo);
  if (to > today || from > to) throw new Error("日期區間無效或在未來");
  const mondays: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 7)) mondays.push(d);
  if (to !== addDays(mondays.at(-1)!, 4)) throw new Error("--to 請指定星期五（週榜以完整週區間查詢）");
  const root = resolve("data/broker-scan");
  mkdirSync(root, { recursive: true });
  const brokerNames = await loadBrokerNames(root, offline);
  const weeklyPrices = new Map<string, Map<string, Price>>();
  const latest = new Map<string, { date: string; close: number }>();
  const cacheFiles = readdirSync(resolve("data/cache")).filter((s) => /^close-\d{8}\.json$/.test(s)).sort();
  const days = new Map<string, Record<string, number>>();
  for (const file of cacheFiles) {
    const digits = file.slice(6, 14);
    const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
    if (date < from || date > to) continue;
    const closes = JSON.parse(readFileSync(resolve("data/cache", file), "utf8"));
    days.set(date, closes);
    for (const stock of stocks) if (Number.isFinite(closes[stock]) && closes[stock] > 0) latest.set(stock, { date, close: closes[stock] });
  }
  for (const stock of stocks) {
    const prices = new Map<string, Price>();
    for (const monday of mondays) {
      const closes = Array.from({ length: 5 }, (_, i) => days.get(addDays(monday, i))?.[stock]).filter((n): n is number => Number.isFinite(n) && n > 0);
      prices.set(monday, { mean: closes.length ? closes.reduce((a, b) => a + b, 0) / closes.length : null, days: closes.length });
    }
    weeklyPrices.set(stock, prices);
  }
  const tasks = stocks.flatMap((stock) => mondays.map((monday) => ({ stock, monday })));
  const results = new Map<string, Week>();
  const failures: string[] = [];
  const skipped = new Set<string>();
  const startedAt = Date.now();
  let next = 0, cached = 0, fetched = 0, done = 0;
  console.log(`[scan] universe ${stocks.length} 檔 ${from}~${to}，${mondays.length} 週／${tasks.length} 請求，${E01_HOSTS.length} hosts；價格僅讀快取`);
  const progress = () => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = done ? Math.ceil(elapsed / done * (tasks.length - done) / 60) : "?";
    console.log(`[scan] ${done}/${tasks.length}，快取 ${cached}，新抓 ${fetched}，失敗 ${failures.length}，ETA ${eta} 分`);
  };
  const heartbeat = setInterval(progress, 30_000);
  try {
    await Promise.all(E01_HOSTS.map(async (_, worker) => {
      while (next < tasks.length) {
        const { stock, monday } = tasks[next++];
        if (skipped.has(stock)) { done++; if (done % 200 === 0) progress(); continue; }
        const path = resolve(root, "raw", stock, `${monday}.json`);
        try {
          let week: Week;
          if (existsSync(path) && (monday !== currentMonday || to <= defaultTo)) { week = JSON.parse(readFileSync(path, "utf8")); cached++; }
          else {
            if (offline) throw new Error(`離線快取缺漏 ${stock}/${monday}`);
            week = await fetchWeek(stock, monday, worker);
            mkdirSync(resolve(root, "raw", stock), { recursive: true });
            writeFileSync(path, JSON.stringify(week, null, 2));
            fetched++;
          }
          results.set(`${stock}/${monday}`, week);
        } catch (error) {
          failures.push((error as Error).message);
          skipped.add(stock);
          console.warn(`[scan] 跳過 ${stock}（保留成功快取）: ${failures.at(-1)}`);
        }
        done++;
        if (done % 200 === 0) progress();
      }
    }));
  } finally { clearInterval(heartbeat); }
  const stockNames: Record<string, { name: string }> = JSON.parse(readFileSync(resolve("data/stock-futures-list.json"), "utf8")).stocks;
  const output = stocks.filter((stock) => !skipped.has(stock)).map((stock) => {
    const weeks = mondays.map((m) => results.get(`${stock}/${m}`)!);
    const prices = weeklyPrices.get(stock)!;
    const mark = latest.get(stock)?.close ?? null;
    const { identities, filteredReasons, unresolvedNames, branches } = gradeBranches(weeks, prices, mark, brokerNames);
    const sorted = (list: string) => branches.filter((b) => b.list === list).sort((a, b) => b.pnl - a.pnl || a.displayCode.localeCompare(b.displayCode));
    const A = sorted("A"), B = sorted("B"), holding = sorted("holding");
    const filtered = Object.values(filteredReasons).reduce((sum, n) => sum + n, 0);
    const top = (list: typeof A) => list[0] ? `${list[0].name}(${list[0].displayCode}) ${list[0].pnl.toFixed(2)}億` : "—";
    console.log(`[${stock}] ${identities.size} 分點 filtered ${filtered}；A ${A.length} #1 ${top(A)}；B ${B.length} #1 ${top(B)}；holding ${holding.length} #1 ${top(holding)}${unresolvedNames.length ? `；名單無名稱 ${unresolvedNames.join(",")}` : ""}`);
    return { stock, stockName: stockNames[stock]?.name ?? "", weekCount: weeks.length, filtered, filteredReasons, unresolvedNames,
      emptyRankingWeeks: weeks.filter((w) => !w.branches.length).map((w) => w.monday),
      missingPriceWeeks: mondays.filter((m) => prices.get(m)!.mean === null), latestClose: latest.get(stock) ?? null, A, B, holding };
  });
  const listOrder: Record<string, number> = { A: 0, B: 1, holding: 2 };
  const candidates = output.flatMap((s) => [...s.A, ...s.B, ...s.holding].map((b) => ({ stock: s.stock, stockName: s.stockName, ...b })))
    .sort((a, b) => listOrder[a.list] - listOrder[b.list] || b.pnl - a.pnl || a.stock.localeCompare(b.stock) || a.displayCode.localeCompare(b.displayCode));
  writeFileSync(resolve(root, `candidates-${to}.json`), JSON.stringify(candidates, null, 2));
  const path = resolve(root, `winners-${to}.json`);
  writeFileSync(path, JSON.stringify({ from, to, generatedAt: new Date().toISOString(), skippedStocks: [...skipped], thresholds: { MIN_FUT_VOLUME, WIN_RETURN, MIN_OBSERVED_WEEKS, MIN_DIRECTIONALITY }, pnlUnit: "億 NT$ (episodes: NT$)",
    caveats: ["週榜前15名截斷；缺席週以未知零量計，非實際無交易", "價格僅讀快取；週均價可能只有部分交易日，未還原除權息", "期初部位未知；半渡結束忽略殘餘；開放段以最新快取收盤價估算"], stocks: output }, null, 2));
  console.log(`\n[scan] 完成：快取 ${cached}，新抓 ${fetched}；${path}`);
  console.log("[scan] 跨股 top 30（A → B → holding；各榜依損益）");
  for (const b of candidates.slice(0, 30)) console.log(`  ${b.list} ${b.stock} ${b.stockName} ${b.name}(${b.displayCode}) D=${b.D.toFixed(3)} ${b.wins}勝 ${b.pnl.toFixed(2)}億`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error("[scan] failed:", error); process.exitCode = 1; });
}
