/** 持股技術／組合風險檢查（缺停損時補 OHLCV；加權指數落後時連證交所補資料）；百分比欄位為百分點，weight、beta、correlation 為小數。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validOhlcv, volumeProfileStop, type Ohlcv } from "./lib/volume-profile-stop.ts";

export type Holding = { code: string; direction: "多" | "空"; stop?: number; weight?: number; averagePrice?: number };
export type Price = { date: string; close: number };
type Return = { date: string; from: string; value: number };
const sign = (direction: Holding["direction"]) => direction === "多" ? 1 : -1;
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const average = (rows: Price[], days: number): number | null => rows.length >= days ? mean(rows.slice(-days).map((r) => r.close)) : null;
const distance = (close: number | null, ma: number | null) => close !== null && ma !== null ? round((close / ma - 1) * 100) : null;

/** Monday–Sunday weeks; include the latest available close of the current partial week. */
export function weeklyCloses(rows: Price[]): Price[] {
  const weeks = new Map<string, Price>();
  for (const row of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const monday = new Date(`${row.date}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    weeks.set(monday.toISOString().slice(0, 10), row);
  }
  return [...weeks.values()];
}

/** Nearest valid Taiwan stock tick (ties upwards); TAIEX uses whole points. */
export function roundToTick(price: number, code = ""): number {
  const tick = code === "TAIEX" ? 1 : price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.1 : price < 500 ? 0.5 : price < 1000 ? 1 : 5;
  return round(Math.round((price + 1e-9) / tick) * tick, 2);
}

export function suggestedStop(direction: Holding["direction"], close: number, low20: number, high20: number, code = "") {
  // 收在 20 日極值時（新低／新高），極值就是收盤價，當停損沒意義，改用 8% 上限。
  const atExtreme = direction === "多" ? low20 >= close : high20 <= close;
  const level = direction === "多" ? (atExtreme ? close * 0.92 : Math.max(low20, close * 0.92)) : (atExtreme ? close * 1.08 : Math.min(high20, close * 1.08));
  return {
    suggestedStop: roundToTick(level, code),
    suggestedStopReason: atExtreme ? `收盤即 20 日${direction === "多" ? "最低" : "最高"}，沒有更近的支撐壓力，用 8% 上限` : direction === "多" ? "20 日最低收盤與收盤價 × 0.92 取較高者，依跳動單位四捨五入" : "20 日最高收盤與收盤價 × 1.08 取較低者，依跳動單位四捨五入",
  };
}

/** 沒設停損時的預設：收盤跌破成本 −10%（空單 +10%），依跳動單位四捨五入。 */
export function defaultStop(direction: Holding["direction"], averagePrice: number, code = "") {
  return {
    suggestedStop: roundToTick(averagePrice * (1 - sign(direction) * 0.1), code),
    suggestedStopReason: `預設停損：收盤${direction === "多" ? "跌破成本 −10%" : "站上成本 +10%"}`,
    suggestedStopRule: "fixed-10" as const,
  };
}

/** Positive distance means room before stop; zero/negative means triggered. Equality to an MA is neutral. */
export function verdict(direction: Holding["direction"], close: number, ma10: number, ma20: number, stop?: number): string {
  const side = sign(direction);
  if (stop !== undefined && (close - stop) * side <= 0) return "出場";
  if ((close - ma20) * side < 0) return "出場警訊";
  if ((close - ma10) * side < 0) return "警戒";
  return "續抱";
}

export function dailyReturns(rows: Price[]): Return[] {
  return rows.slice(1).map((row, i) => ({ date: row.date, from: rows[i].date, value: row.close / rows[i].close - 1 }));
}

/** Match BOTH ends of each return interval, never bridge a missing session against a one-day return. */
function alignedReturns(a: Price[], b: Price[], days: number) {
  const other = new Map(dailyReturns(b).map((r) => [`${r.from}/${r.date}`, r.value]));
  return dailyReturns(a).filter((r) => other.has(`${r.from}/${r.date}`)).slice(-days)
    .map((r) => ({ date: r.date, a: r.value, b: other.get(`${r.from}/${r.date}`)! }));
}

export function beta(a: Price[], market: Price[], days = 120): number | null {
  const pairs = alignedReturns(a, market, days);
  if (pairs.length < days) return null;
  const am = mean(pairs.map((p) => p.a)), bm = mean(pairs.map((p) => p.b));
  const variance = pairs.reduce((sum, p) => sum + (p.b - bm) ** 2, 0);
  return variance > 0 ? pairs.reduce((sum, p) => sum + (p.a - am) * (p.b - bm), 0) / variance : null;
}

export function correlation(a: Price[], b: Price[], days = 60): number | null {
  const pairs = alignedReturns(a, b, days);
  if (pairs.length < days) return null;
  const am = mean(pairs.map((p) => p.a)), bm = mean(pairs.map((p) => p.b));
  const av = pairs.reduce((sum, p) => sum + (p.a - am) ** 2, 0), bv = pairs.reduce((sum, p) => sum + (p.b - bm) ** 2, 0);
  return av > 0 && bv > 0 ? Math.max(-1, Math.min(1, pairs.reduce((sum, p) => sum + (p.a - am) * (p.b - bm), 0) / Math.sqrt(av * bv))) : null;
}

export function checkHolding(holding: Holding, rows: Price[], ohlcv?: Ohlcv[] | null, asOf = rows.at(-1)?.date) {
  const close = rows.at(-1)?.close ?? null;
  const ma10 = average(rows, 10), ma20 = average(rows, 20), ma60 = average(rows, 60);
  const weeks = weeklyCloses(rows), wma10 = average(weeks, 10), wma30 = average(weeks, 30);
  const extreme = (days: number, fn: (...values: number[]) => number) => rows.length >= days ? fn(...rows.slice(-days).map((r) => r.close)) : null;
  const low20 = extreme(20, Math.min), high20 = extreme(20, Math.max);
  const changes = dailyReturns(rows).slice(-20).map((r) => r.value * 100);
  const vol20 = changes.length === 20 ? round(Math.sqrt(changes.reduce((sum, x) => sum + (x - mean(changes)) ** 2, 0) / 19)) : null;
  const stopDistancePct = holding.stop !== undefined && close !== null ? (close - holding.stop) / close * 100 * sign(holding.direction) : null;
  const sufficient = ma60 !== null && wma30 !== null;
  const vpRows = ohlcv && asOf ? validOhlcv(ohlcv, asOf) : [];
  const vp = holding.stop === undefined && holding.code !== "TAIEX" && vpRows.length && asOf
    ? volumeProfileStop({ rows: vpRows, asOf, reference: holding.averagePrice ?? vpRows.at(-1)!.close, direction: holding.direction, code: holding.code }) : null;
  // 預設停損＝成本 ±10%（2026-11-13 回測：價量停損沒贏固定 −10%）；價量停損只留作參考。
  const suggestion: { suggestedStop?: number; suggestedStopReason?: string; suggestedStopRule?: "fixed-10" | "fallback-20d"; volumeProfileStop?: number; volumeProfileStopReason?: string } = holding.stop !== undefined ? {} : holding.averagePrice !== undefined && holding.code !== "TAIEX" ? {
    ...defaultStop(holding.direction, holding.averagePrice, holding.code),
    ...(vp ? { volumeProfileStop: vp.stop, volumeProfileStopReason: vp.reason } : {}),
  } : low20 !== null && high20 !== null ? {
    ...suggestedStop(holding.direction, close!, low20, high20, holding.code), suggestedStopRule: "fallback-20d" as const,
  } : {};
  return {
    ...holding, date: rows.at(-1)?.date ?? null, status: sufficient ? "ok" : "資料不足", historyDays: rows.length,
    close, ma10, ma20, ma60, ma10Pct: distance(close, ma10), ma20Pct: distance(close, ma20), ma60Pct: distance(close, ma60),
    weeklyCloses: weeks, wma10, wma30, aboveWma10: wma10 !== null ? close! > wma10 : null, aboveWma30: wma30 !== null ? close! > wma30 : null,
    trend: ma20 === null || ma60 === null ? "資料不足" : close! > ma20 && ma20 > ma60 ? "多頭排列" : close! < ma20 && ma20 < ma60 ? "空頭排列" : "整理",
    support: { low20, low60: extreme(60, Math.min) }, resistance: { high20, high60: extreme(60, Math.max) }, vol20,
    stopDistancePct: stopDistancePct !== null ? round(stopDistancePct) : null,
    stopStatus: holding.stop === undefined ? "未設停損" : stopDistancePct === null ? "資料不足" : stopDistancePct <= 0 ? "已觸發" : `距 ${stopDistancePct.toFixed(1)}%`,
    ...suggestion,
    verdict: close !== null && holding.stop !== undefined && (close - holding.stop) * sign(holding.direction) <= 0 ? "出場"
      : ma10 !== null && ma20 !== null ? verdict(holding.direction, close!, ma10, ma20, holding.stop) : "資料不足",
  };
}

export function marketRegime(rows: Price[]) {
  const ma20 = average(rows, 20), ma60 = average(rows, 60), previousMa60 = average(rows.slice(0, -5), 60);
  const date = rows.at(-1)?.date ?? null, month = Number(date?.slice(5, 7));
  const conditions = {
    closeAboveMa20: ma20 === null ? null : rows.at(-1)!.close > ma20,
    ma20AboveMa60: ma20 === null || ma60 === null ? null : ma20 > ma60,
    ma60Rising: ma60 === null || previousMa60 === null ? null : ma60 > previousMa60,
    novemberToApril: date === null ? null : month >= 11 || month <= 4,
  };
  const complete = Object.values(conditions).every((v) => v !== null);
  const count = Object.values(conditions).filter((v) => v === true).length;
  return { date, status: complete ? "ok" : "資料不足", conditions, count: complete ? count : null, level: complete ? count * 25 : null };
}

export function checkPortfolio(holdings: Holding[], prices: Record<string, Price[]>, market: Price[], notional?: number) {
  const items = holdings.map((h, index) => {
    const rows = prices[h.code] ?? [], pairs = alignedReturns(rows, market, 120);
    return { ...h, index, beta: beta(rows, market), betaDays: pairs.length, betaDate: pairs.at(-1)?.date ?? null };
  });
  const correlations = items.flatMap((a, i) => items.slice(i + 1).map((b) => {
    const pairs = alignedReturns(prices[a.code] ?? [], prices[b.code] ?? [], 60);
    return { codes: [a.code, b.code], indices: [a.index, b.index], correlation: correlation(prices[a.code] ?? [], prices[b.code] ?? []), days: pairs.length, date: pairs.at(-1)?.date ?? null };
  }));
  const weighted = items.filter((h) => h.weight !== undefined);
  // 缺序列的持股（例如美股）不算進曝險、也不重新分配權重；未涵蓋的比例另外列出。
  const covered = weighted.filter((h) => h.beta !== null);
  const uncoveredWeight = round(weighted.filter((h) => h.beta === null).reduce((sum, h) => sum + h.weight!, 0));
  const exposure = covered.length ? covered.reduce((sum, h) => sum + h.weight! * h.beta! * sign(h.direction), 0) : null;
  const weights = new Map<string, number>();
  for (const h of weighted) weights.set(h.code, (weights.get(h.code) ?? 0) + h.weight!);
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const concentrationFlags = ranked.filter(([, weight]) => weight > 0.2).map(([code, weight]) => `${code} 單一持股 ${(weight * 100).toFixed(1)}% > 20%`);
  if (ranked.length >= 2 && ranked[0][1] + ranked[1][1] > 0.4) concentrationFlags.push(`前兩大 ${((ranked[0][1] + ranked[1][1]) * 100).toFixed(1)}% > 40%`);
  const warnings: string[] = [];
  if (weighted.length && weighted.length < holdings.length) warnings.push("部分持股未提供 weight，曝險／壓力／集中度只涵蓋有權重的持股");
  if (uncoveredWeight > 0) warnings.push(`${weighted.filter((h) => h.beta === null).map((h) => h.code).join("、")} 缺少配對報酬（佔 ${(uncoveredWeight * 100).toFixed(1)}%），曝險／壓力／避險未含這些部位`);
  if (market.at(-1)?.date && holdings.some((h) => (prices[h.code]?.at(-1)?.date ?? "") > market.at(-1)!.date)) warnings.push(`TAIEX 資料落後持股；Beta／避險／水位基準日 ${market.at(-1)!.date}`);
  const taiexClose = market.at(-1)?.close ?? null;
  const hedge = notional !== undefined && exposure !== null && taiexClose !== null ? {
    date: market.at(-1)!.date, taiexClose, notional,
    direction: exposure >= 0 ? "空" : "多",
    // Each contract type is an alternative, not a combined order; nearest integer minimizes residual exposure.
    rounding: "各契約獨立替代方案；四捨五入至整口，0 口代表不足半口；負曝險以多單避險",
    neutralize: { microLots: Math.round(Math.abs(notional * exposure) / (10 * taiexClose)), miniLots: Math.round(Math.abs(notional * exposure) / (50 * taiexClose)) },
    halve: { microLots: Math.round(Math.abs(notional * exposure) / (20 * taiexClose)), miniLots: Math.round(Math.abs(notional * exposure) / (100 * taiexClose)) },
  } : null;
  return {
    betas: items, correlations, hiddenCorrelation: correlations.filter((p) => p.codes[0] !== p.codes[1] && p.correlation !== null && p.correlation >= 0.7),
    weightedHoldings: weighted.length, uncoveredWeight, suppliedWeight: round(weighted.reduce((sum, h) => sum + h.weight!, 0)),
    betaWeightedNetExposure: exposure === null ? null : round(exposure),
    stress: exposure === null ? null : {
      taiexMovePct: -20, estimatedPortfolioMovePct: round(-20 * exposure),
      estimatedPnlTwd: notional === undefined ? null : round(-0.2 * exposure * notional, 0),
      topLossContributors: covered.map((h) => ({ code: h.code, direction: h.direction, index: h.index,
        movePct: -20 * h.weight! * h.beta! * sign(h.direction) })).filter((h) => h.movePct < 0)
        .sort((a, b) => a.movePct - b.movePct).slice(0, 3).map((h) => ({ ...h, movePct: round(h.movePct) })),
    }, concentrationFlags, hedge, warnings,
  };
}

/** Local files only. Keep ~260 actual sessions per code; empty weekend caches contribute no observations. */
export function loadPrices(codes: string[], date: string, root = process.cwd()) {
  const prices: Record<string, Price[]> = Object.fromEntries(codes.map((code) => [code, []]));
  const cache = resolve(root, "data/cache");
  const stocks = [...new Set(codes.filter((code) => /^\d{4,6}$/.test(code)))];
  if (existsSync(cache) && stocks.length) {
    const files = readdirSync(cache).filter((file) => /^close-\d{8}\.json$/.test(file) && file.slice(6, 14) <= date.replace(/-/g, "")).sort().reverse();
    for (const file of files) {
      const data = JSON.parse(readFileSync(resolve(cache, file), "utf8"));
      const day = `${file.slice(6, 10)}-${file.slice(10, 12)}-${file.slice(12, 14)}`;
      for (const code of stocks) if (prices[code].length < 260 && Number.isFinite(data[code]) && data[code] > 0) prices[code].push({ date: day, close: data[code] });
      if (stocks.every((code) => prices[code].length >= 260)) break;
    }
    for (const code of stocks) prices[code].reverse();
  }
  const marketPath = resolve(root, "data/backtest/taiex/taiex-daily.json");
  const market: Price[] = existsSync(marketPath) ? (JSON.parse(readFileSync(marketPath, "utf8")) as Price[])
    .filter((r) => r.date <= date && Number.isFinite(r.close) && r.close > 0).sort((a, b) => a.date.localeCompare(b.date)).slice(-260)
    .map(({ date, close }) => ({ date, close })) : [];
  if (codes.includes("TAIEX")) prices.TAIEX = market;
  return { prices, market };
}

/** taiex-daily.json 是回測檔、不會每天更新；落後時用證交所 FMTQIK 補到 date，已結束的月份快取。 */
export async function fillMarket(market: Price[], date: string, root = process.cwd()): Promise<Price[]> {
  const last = market.at(-1)?.date;
  if (!last || last >= date) return market;
  const dir = resolve(root, "data/cache/taiex-fmtqik");
  const rows = new Map(market.map((r) => [r.date, r.close]));
  for (let m = new Date(`${last.slice(0, 7)}-01T00:00:00Z`); m.toISOString().slice(0, 7) <= date.slice(0, 7); m.setUTCMonth(m.getUTCMonth() + 1)) {
    const ym = m.toISOString().slice(0, 7).replace("-", ""), path = resolve(dir, `${ym}.json`);
    let month: Price[];
    if (existsSync(path)) month = JSON.parse(readFileSync(path, "utf8"));
    else {
      const response = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json&date=${ym}01`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`FMTQIK ${ym} HTTP ${response.status}`);
      const json = (await response.json()) as { stat: string; data?: string[][] };
      month = json.stat === "OK" && json.data ? json.data.map((r) => {
        const [y, mm, d] = r[0].split("/");
        return { date: `${Number(y) + 1911}-${mm}-${d}`, close: Number(r[4].replace(/,/g, "")) };
      }) : [];
      if (`${ym.slice(0, 4)}-${ym.slice(4)}` < date.slice(0, 7) && month.length) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(month));
      }
      await new Promise((r) => setTimeout(r, 400)); // 證交所對連續請求很敏感
    }
    for (const r of month) if (r.date <= date && Number.isFinite(r.close) && r.close > 0) rows.set(r.date, r.close);
  }
  return [...rows].sort((a, b) => a[0].localeCompare(b[0])).slice(-260).map(([date, close]) => ({ date, close }));
}

export function parseArgs(args: string[]) {
  const holdings: Holding[] = [];
  let date: string | undefined, notional: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--date") {
      date = args[++i];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("日期須為 YYYY-MM-DD");
    } else if (arg === "--notional") {
      notional = Number(args[++i]);
      if (!Number.isFinite(notional) || notional <= 0) throw new Error("--notional 須為正數 TWD");
    } else {
      const match = /^([^:@~\s]+):([多空])((?:[:@~]\d+(?:\.\d+)?)*)$/.exec(arg);
      if (!match) throw new Error("用法：npx tsx scripts/holdings-tech-check.ts <code>:<多|空>[:<stop>][@<weight>][~<averagePrice>] ... [--date YYYY-MM-DD] [--notional TWD]");
      const values = new Map<string, number>();
      for (const token of match[3].matchAll(/([:@~])(\d+(?:\.\d+)?)/g)) {
        if (values.has(token[1])) throw new Error("持股參數不可重複");
        values.set(token[1], Number(token[2]));
      }
      const stop = values.get(":"), weight = values.get("@"), averagePrice = values.get("~");
      if (stop !== undefined && (!Number.isFinite(stop) || stop <= 0)) throw new Error("stop 須為正數");
      if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 1)) throw new Error("weight 須介於 0 與 1");
      if (averagePrice !== undefined && (!Number.isFinite(averagePrice) || averagePrice <= 0)) throw new Error("averagePrice 須為正數");
      holdings.push({ code: match[1], direction: match[2] as Holding["direction"], ...(stop === undefined ? {} : { stop }),
        ...(weight === undefined ? {} : { weight }), ...(averagePrice === undefined ? {} : { averagePrice }) });
    }
  }
  if (!holdings.length) throw new Error("請提供至少一筆持股");
  return { holdings, date, notional };
}

async function main() {
  // CLI 依賴延後載入，重用 roundToTick 時不讀取環境設定。
  const [{ latestDate, stockNames }, { fetchOhlcv }] = await Promise.all([import("./holdings-chip-check.ts"), import("./volume-profile-stop.ts")]);
  const options = parseArgs(process.argv.slice(2)), date = options.date ?? latestDate();
  const { prices, market: stale } = loadPrices(options.holdings.map((h) => h.code), date);
  let market = stale;
  try { market = await fillMarket(stale, date); } catch (error) { console.warn(`[警告] 加權指數補資料失敗：${(error as Error).message}`); }
  if ("TAIEX" in prices) prices.TAIEX = market;
  const names = stockNames();
  const ohlcv = new Map(await Promise.all([...new Set(options.holdings.filter((h) => h.stop === undefined && h.code !== "TAIEX").map((h) => h.code))]
    .map(async (code) => [code, await fetchOhlcv(code, date)] as const)));
  const result = { date, generatedBy: "scripts/holdings-tech-check.ts",
    holdings: options.holdings.map((h) => ({ ...checkHolding(h, prices[h.code], ohlcv.get(h.code), date), name: h.code === "TAIEX" ? "加權指數" : names[h.code] ?? h.code })),
    portfolio: checkPortfolio(options.holdings, prices, market, options.notional), regime: marketRegime(market) };
  mkdirSync(resolve("data"), { recursive: true });
  writeFileSync(resolve("data/holdings-tech-latest.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`持股技術／組合風險檢查 ${date}（vol20 為日報酬樣本標準差 %）`);
  for (const h of result.holdings) console.log(`${h.code} ${h.name} ${h.direction} | ${h.date ?? "無日期"} 收 ${h.close ?? "資料不足"} | MA10/20/60 ${[h.ma10, h.ma20, h.ma60].map((v) => v === null ? "—" : v.toFixed(2)).join("/")} | ${h.trend} | ${h.stopStatus}${h.suggestedStop === undefined ? "" : `；建議停損 ${h.suggestedStop}`} | ${h.verdict}${h.status === "ok" ? "" : "（資料不足）"}`);
  const p = result.portfolio;
  console.log(`組合 | Beta 淨曝險 ${p.betaWeightedNetExposure ?? "資料不足／未提供權重"} | 大盤 -20% → ${p.stress ? `${p.stress.estimatedPortfolioMovePct}%` : "無法估算"} | 高相關 ${p.hiddenCorrelation.length} 組 | 抱股水位 ${result.regime.level ?? "資料不足"}%（${result.regime.date ?? "無日期"}）`);
  if (p.hedge) console.log(`避險 ${p.hedge.direction} | 中和：微台 ${p.hedge.neutralize.microLots}／小台 ${p.hedge.neutralize.miniLots} 口；減半：微台 ${p.hedge.halve.microLots}／小台 ${p.hedge.halve.miniLots} 口（各自擇一）`);
  for (const warning of [...p.warnings, ...p.concentrationFlags]) console.warn(`[警告] ${warning}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
