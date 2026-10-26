/** 持股籌碼檢查：npx tsx scripts/holdings-chip-check.ts 2303:多 3532:空 [--date YYYY-MM-DD] */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseT86, parseTpexInsti } from "./fetch-market-data";
import { recentTrigger, withMa10, withRecent5, isTriggered, type BrokerReport, type ReportItem } from "./fetch-broker-watch";

export type Holding = { code: string; direction: "多" | "空" };
export type Chips = { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number };
type DailyChips = Record<string, Chips>;
const emptyChips = (): Chips => ({ foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0 });

export function verdict(holding: Holding, pairs: ReportItem[], fiveDay: Chips | null, aboveMa10?: boolean): string[] {
  const sign = holding.direction === "多" ? 1 : -1;
  const messages: string[] = [];
  if (pairs.some((p) => (recentTrigger(p)?.net ?? 0) * sign > 0 || (p.net20 ?? 0) * sign > 0)) {
    messages.push("贏家分點同向（信心+）");
  }
  if (pairs.some((p) => (recentTrigger(p)?.net ?? 0) * sign < 0)) {
    const wrongSide = aboveMa10 !== undefined && (sign > 0 ? !aboveMa10 : aboveMa10);
    messages.push(wrongSide ? `分點反向＋${sign > 0 ? "跌破" : "站上"} 10 日線，出場警訊` : "贏家分點反向，留意出場");
  }
  if (fiveDay && fiveDay.totalNet !== 0) {
    const trust = fiveDay.trustNet !== 0 && Math.abs(fiveDay.trustNet) >= Math.max(Math.abs(fiveDay.foreignNet), Math.abs(fiveDay.dealerNet));
    messages.push(`法人${fiveDay.totalNet * sign > 0 ? "同向" : "反向"}${trust ? "（投信主導）" : ""}`);
  }
  return messages.length ? messages : ["無明顯籌碼訊號"];
}

/** 只快取兩市場都成功回覆的資料，避免失敗被當成休市或零買賣超。 */
export async function institutionsOn(date: string, root = process.cwd()): Promise<DailyChips> {
  const dir = resolve(root, "data/cache/insti");
  const compact = date.replace(/-/g, "");
  const path = resolve(dir, `${compact}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const slashed = date.replace(/-/g, "/");
  const urls = [
    `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${compact}&selectType=ALL`,
    `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&date=${slashed}&response=json`,
  ];
  const [tw, tp] = await Promise.all(urls.map(async (url) => {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  }));
  const twMap = parseT86(tw), tpMap = parseTpexInsti(tp);
  const holiday = (tw.stat?.includes("沒有符合") || tw.stat?.includes("查無")) && Array.isArray(tp.tables) && tpMap.size === 0;
  if (!(twMap.size && tpMap.size) && !holiday) throw new Error(`${date} 法人資料不完整（上市 ${twMap.size}／上櫃 ${tpMap.size}）`);
  const merged = Object.fromEntries([...twMap, ...tpMap]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(merged));
  return merged;
}

export function latestDate(root = process.cwd()): string {
  const candidates: string[] = [];
  const brokerPath = resolve(root, "data/broker-watch-latest.json");
  if (existsSync(brokerPath)) candidates.push(JSON.parse(readFileSync(brokerPath, "utf8")).tradingDate);
  const cache = resolve(root, "data/cache");
  if (existsSync(cache)) {
    for (const file of readdirSync(cache)) {
      const match = /^close-(\d{4})(\d{2})(\d{2})\.json$/.exec(file);
      if (match && Object.keys(JSON.parse(readFileSync(resolve(cache, file), "utf8"))).length > 500) {
        candidates.push(`${match[1]}-${match[2]}-${match[3]}`);
      }
    }
  }
  const date = candidates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? "")).sort().at(-1);
  if (!date) throw new Error("找不到可用交易日，請指定 --date YYYY-MM-DD");
  return date;
}

export async function checkHoldings(holdings: Holding[], date: string, broker: BrokerReport,
  lookup: (date: string) => Promise<DailyChips> = institutionsOn,
  priceLookup?: Parameters<typeof withMa10>[1]) {
  const sessions: { date: string; data: DailyChips }[] = [];
  const warnings: string[] = [];
  const cursor = new Date(`${date}T00:00:00Z`);
  for (let back = 0; back < 12 && sessions.length < 5; back++, cursor.setUTCDate(cursor.getUTCDate() - 1)) {
    const day = cursor.toISOString().slice(0, 10);
    try {
      const data = await lookup(day);
      if (Object.keys(data).length) sessions.push({ date: day, data });
    } catch (error) {
      warnings.push((error as Error).message);
      break; // 未知日期不能跳過，否則會把更早的資料誤當近五日。
    }
  }
  if (sessions.length < 5) warnings.push(`法人資料僅 ${sessions.length} 個交易日，無法計算完整近五日`);
  if (broker.tradingDate !== date) warnings.push(`分點報告日期 ${broker.tradingDate}，目標日期 ${date}；缺少的日期補零，請留意資料時效`);
  const items: ReportItem[] = holdings.map(({ code }) => ({
    pageId: "", title: code, stockCode: code, stockName: code, broker: "", brokerCode: "",
    threshold: 0, direction: "雙向", grade: "", note: "", lastTriggerDate: "", lastTriggerNet: null, status: "unresolved",
  }));
  const prices = await withMa10({ tradingDate: date, notion: false, items }, priceLookup);
  const pairs = withRecent5({ ...broker, tradingDate: date }).items;
  return { date, warnings, items: holdings.map((holding, index) => {
    const stockPairs = pairs.filter((p) => p.stockCode === holding.code);
    const daily = sessions.find((s) => s.date === date)?.data[holding.code] ?? null;
    const covered = sessions.filter((s) => s.data[holding.code]);
    const fiveDay = covered.length === 5 ? covered.reduce((sum, s) => {
      const chips = s.data[holding.code];
      for (const key of Object.keys(sum) as (keyof Chips)[]) sum[key] += chips[key];
      return sum;
    }, emptyChips()) : null;
    const price = prices.items[index];
    return { ...holding, name: stockPairs[0]?.stockName ?? holding.code,
      institutions: { daily, fiveDay, dates: sessions.map((s) => s.date), coveredDays: covered.length },
      brokers: stockPairs.map((p) => ({ broker: p.broker, grade: p.grade, geo: p.geo, threshold: p.threshold,
        direction: p.direction, recent5: p.recent5?.map((d) => ({ ...d, triggered: isTriggered(d.net, p.threshold, p.direction) })),
        latestTrigger: recentTrigger(p) ?? null, net20: p.net20, net20Days: p.net20Days, net20Partial: p.net20Partial })),
      brokerStatus: stockPairs.length ? "追蹤中" : "不在追蹤名單",
      price: { close: price.close ?? null, ma10: price.ma10 ?? null, aboveMa10: price.aboveMa10 ?? null, pct: price.ma10Pct ?? null },
      verdict: verdict(holding, stockPairs, fiveDay, price.aboveMa10) };
  }) };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--date");
  const date = at >= 0 ? args.splice(at, 2)[1] : latestDate();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("日期須為 YYYY-MM-DD");
  if (!args.length || args.some((arg) => !/^\d{4}:[多空]$/.test(arg))) throw new Error("用法：npx tsx scripts/holdings-chip-check.ts 2303:多 3532:空 [--date YYYY-MM-DD]");
  const holdings = args.map((arg) => { const [code, direction] = arg.split(":"); return { code, direction } as Holding; });
  const path = resolve("data/broker-watch-latest.json");
  const broker: BrokerReport = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { tradingDate: date, notion: false, items: [] };
  const result = await checkHoldings(holdings, date, broker);
  writeFileSync(resolve("data/holdings-chip-latest.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`持股籌碼檢查 ${date}（單位：張；法人依序為外資／投信／自營商／合計）`);
  for (const warning of result.warnings) console.warn(`[警告] ${warning}`);
  const nets = (chips: Chips | null) => chips ? [chips.foreignNet, chips.trustNet, chips.dealerNet, chips.totalNet].join("／") : "資料不足";
  for (const i of result.items) console.log(`${i.code} ${i.name} ${i.direction} | 法人當日 ${nets(i.institutions.daily)}；五日 ${nets(i.institutions.fiveDay)} | 分點 ${i.brokers.length || i.brokerStatus} | 10日線 ${i.price.ma10 === null ? "資料不足" : `${i.price.aboveMa10 ? "上" : "下"} ${i.price.pct}%`} | ${i.verdict.join("；")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
