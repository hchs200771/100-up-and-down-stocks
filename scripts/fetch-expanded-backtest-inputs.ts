/**
 * Freeze a point-in-time TWSE universe, then fetch public price/corporate-action
 * inputs for survivorship-aware expanded backtests. Network access is explicit
 * when this script is run; this file is not part of the daily report pipeline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const OUT_DIR = resolve(ROOT, "data/backtest/expanded");
const CACHE_DIR = resolve(OUT_DIR, "cache");
const UNIVERSE_DATE = "2020-01-02";
const START_DATE = "2019-01-01";
const END_DATE = "2026-09-30";
const TOP_N = 60;
const CONCURRENCY = 3;
const TWSE_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20200102&type=ALLBUT0999&response=json";
const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const STOCK_DATASETS = [
  "TaiwanStockPrice",
  "TaiwanStockDividendResult",
  "TaiwanStockCapitalReductionReferencePrice",
  "TaiwanStockSplitPrice",
] as const;
const BENCHMARK_DATASETS = ["TaiwanStockPrice", "TaiwanStockTotalReturnIndex"] as const;

type UniverseStock = { code: string; name: string; initialTurnover: number };
type Coverage = { requested: number; success: number; empty: number; failed: number; complete: boolean };
type ApiError = { dataset: string; code: string; message: string; httpStatus?: number };

const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const saveJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

function parseMoney(value: unknown): number | null {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw || raw === "--" || raw === "-") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function fetchUniverse(): Promise<{ snapshot: any; universe: UniverseStock[] }> {
  const response = await fetch(TWSE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`TWSE universe: HTTP ${response.status}`);
  const snapshot = await response.json();
  if (!Array.isArray(snapshot?.tables)) throw new Error("TWSE universe: response has no tables array");

  let found: UniverseStock[] | null = null;
  for (const table of snapshot.tables) {
    if (!Array.isArray(table?.fields) || !Array.isArray(table?.data)) continue;
    const codeCol = table.fields.findIndex((x: unknown) => String(x).trim() === "證券代號");
    const nameCol = table.fields.findIndex((x: unknown) => String(x).trim() === "證券名稱");
    const moneyCol = table.fields.findIndex((x: unknown) => String(x).trim() === "成交金額");
    if (codeCol < 0 || nameCol < 0 || moneyCol < 0) continue;
    found = table.data.flatMap((row: unknown[]) => {
      if (!Array.isArray(row)) return [];
      const code = String(row[codeCol] ?? "").trim();
      const name = String(row[nameCol] ?? "").trim();
      const initialTurnover = parseMoney(row[moneyCol]);
      if (!/^[1-9]\d{3}$/.test(code) || !name || initialTurnover === null) return [];
      return [{ code, name, initialTurnover }];
    });
    break;
  }
  if (!found) throw new Error("TWSE universe: could not locate columns 證券代號/證券名稱/成交金額");
  const deduped = [...new Map(found.map((row) => [row.code, row])).values()];
  deduped.sort((a, b) => b.initialTurnover - a.initialTurnover || a.code.localeCompare(b.code));
  const universe = deduped.slice(0, TOP_N);
  if (universe.length !== TOP_N) throw new Error(`TWSE universe: expected ${TOP_N} stocks, got ${universe.length}`);
  return { snapshot, universe };
}

function cachePath(dataset: string, code: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
  return resolve(CACHE_DIR, `${safe(dataset)}-${safe(code)}.json`);
}

function cachedRows(dataset: string, code: string): any[] | null {
  const path = cachePath(dataset, code);
  if (!existsSync(path)) return null;
  try {
    const cached = readJson(path);
    if (cached.dataset !== dataset || cached.code !== code || cached.startDate !== START_DATE || cached.endDate !== END_DATE || !Array.isArray(cached.data)) return null;
    return cached.data;
  } catch {
    return null;
  }
}

const stoppedApis = new Set<string>();
let rateLimited = false;
const errors: ApiError[] = [];
const coverage: Record<string, Coverage> = {};

async function fetchDataset(dataset: string, code: string): Promise<any[] | null> {
  const cached = cachedRows(dataset, code);
  if (cached !== null) return cached;
  if (rateLimited || stoppedApis.has(dataset)) {
    errors.push({ dataset, code, message: `not requested: ${dataset} was stopped after an earlier HTTP 400/429` });
    return null;
  }
  const query = new URLSearchParams({ dataset, data_id: code, start_date: START_DATE, end_date: END_DATE });
  try {
    const response = await fetch(`${FINMIND_URL}?${query}`, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) {
      const message = `HTTP ${response.status}`;
      errors.push({ dataset, code, message, httpStatus: response.status });
      if (response.status === 400 || response.status === 429) stoppedApis.add(dataset);
      if (response.status === 429) rateLimited = true;
      return null;
    }
    const payload = await response.json();
    if (payload?.status !== 200 || !Array.isArray(payload?.data)) {
      const apiStatus = Number(payload?.status);
      const message = `invalid FinMind response: status=${String(payload?.status)}, data=${Array.isArray(payload?.data) ? "array" : typeof payload?.data}`;
      errors.push({ dataset, code, message, ...(Number.isFinite(apiStatus) ? { httpStatus: apiStatus } : {}) });
      if (apiStatus === 400 || apiStatus === 429) stoppedApis.add(dataset);
      if (apiStatus === 429) rateLimited = true;
      return null;
    }
    const data = payload.data as any[];
    saveJson(cachePath(dataset, code), { dataset, code, startDate: START_DATE, endDate: END_DATE, fetchedAt: new Date().toISOString(), data });
    return data;
  } catch (error) {
    errors.push({ dataset, code, message: String(error) });
    return null;
  }
}

function recordCoverage(dataset: string, requested: number, results: Array<any[] | null>) {
  const success = results.filter((x) => x !== null).length;
  const empty = results.filter((x) => x !== null && x.length === 0).length;
  coverage[dataset] = { requested, success, empty, failed: requested - success, complete: success === requested };
}

async function runQueue<T>(items: T[], task: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await task(items[i]);
    }
  });
  await Promise.all(workers);
}

mkdirSync(CACHE_DIR, { recursive: true });
const { snapshot, universe } = await fetchUniverse();
const universeSnapshot = {
  source: TWSE_URL,
  asOf: UNIVERSE_DATE,
  selectedRule: `TWSE listed ordinary stocks matching /^[1-9]\\d{3}$/; sorted by initial-day Trading_money descending, then code ascending; top ${TOP_N}`,
  selectedColumns: ["證券代號", "證券名稱", "成交金額"],
  originalResponse: snapshot,
  universe,
};
saveJson(resolve(OUT_DIR, "universe-20200102.json"), universeSnapshot);

const prices: Record<string, any[]> = {};
const actions: Record<string, Array<{ dataset: string; original: any }>> = {};
const actionCoverage: Record<string, boolean> = {};
const datasetResults = new Map<string, Array<any[] | null>>();

for (const dataset of STOCK_DATASETS) {
  const results: Array<any[] | null> = new Array(universe.length).fill(null);
  await runQueue(universe.map((stock, index) => ({ stock, index })), async ({ stock, index }) => {
    results[index] = await fetchDataset(dataset, stock.code);
    if (dataset === "TaiwanStockPrice" && results[index] !== null) prices[stock.code] = results[index]!;
    if (dataset !== "TaiwanStockPrice" && results[index] !== null) {
      actions[stock.code] ??= [];
      for (const original of results[index]!) actions[stock.code].push({ dataset, original });
    }
  });
  datasetResults.set(dataset, results);
  recordCoverage(dataset, universe.length, results);
}

for (const stock of universe) {
  actionCoverage[stock.code] = ["TaiwanStockDividendResult", "TaiwanStockCapitalReductionReferencePrice", "TaiwanStockSplitPrice"]
    .every((dataset) => datasetResults.get(dataset)?.[universe.findIndex((x) => x.code === stock.code)] !== null);
  actions[stock.code] ??= [];
}

const benchmark: Record<string, any[]> = {};
for (const dataset of BENCHMARK_DATASETS) {
  const rows = await fetchDataset(dataset, "TAIEX");
  if (rows !== null) benchmark[dataset] = rows;
  recordCoverage(`${dataset}:TAIEX`, 1, [rows]);
}

const output = {
  source: "TWSE MI_INDEX + FinMind public v4 API",
  fetchedAt: new Date().toISOString(),
  startDate: START_DATE,
  endDate: END_DATE,
  universeDate: UNIVERSE_DATE,
  universe,
  prices,
  actions,
  benchmarkTotalReturn: {
    TaiwanStockPrice: benchmark.TaiwanStockPrice ?? [],
    TaiwanStockTotalReturnIndex: benchmark.TaiwanStockTotalReturnIndex ?? [],
  },
  coverage,
  actionCoverage,
  errors,
};
saveJson(resolve(OUT_DIR, "expanded-input.json"), output);
console.log(JSON.stringify({ requestedStocks: universe.length, coverage, errors: errors.length, output: resolve(OUT_DIR, "expanded-input.json") }, null, 2));
