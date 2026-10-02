/** Public research inputs only. Does not alter daily-report market snapshots. */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const startDate = "2026-07-01";
const endDate = "2026-09-30";
const codes = new Set<string>(["TAIEX"]);
for (const file of readdirSync("data/stock-picks-history").filter((f) => f.endsWith(".json"))) {
  const snapshot = JSON.parse(readFileSync(resolve("data/stock-picks-history", file), "utf8"));
  for (const board of ["long", "short"]) {
    for (const pick of snapshot[board] ?? []) codes.add(pick.code);
  }
}

async function request(dataset: string, code: string): Promise<any[]> {
  const query = new URLSearchParams({ dataset, data_id: code, start_date: startDate, end_date: endDate });
  const response = await fetch(`https://api.finmindtrade.com/api/v4/data?${query}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${dataset}/${code}: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.status !== 200 || !Array.isArray(payload.data)) {
    throw new Error(`${dataset}/${code}: invalid or unsuccessful API response`);
  }
  return payload.data;
}

const cachePath = "data/backtest/price-input.json";
const cached = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : null;
const matchingCache = cached?.startDate === startDate && cached?.endDate === endDate;
const prices: Record<string, any[]> = matchingCache ? cached.prices ?? {} : {};
const corporateActions: Record<string, any[]> = matchingCache ? cached.corporateActions ?? {} : {};
const corporateActionCoverage: Record<string, boolean> = matchingCache ? cached.corporateActionCoverage ?? {} : {};
const institutional: Record<string, any[]> = matchingCache ? cached.institutional ?? {} : {};
const errors: string[] = [];
const queue = [...codes];
let completed = 0;
async function worker() {
  while (queue.length) {
    const code = queue.shift()!;
    try {
      if (!prices[code]?.length) prices[code] = await request("TaiwanStockPrice", code);
    } catch (error) {
      errors.push(String(error));
      continue;
    }
    if (code !== "TAIEX") {
      try {
        if (!institutional[code]) institutional[code] = await request("TaiwanStockInstitutionalInvestorsBuySell", code);
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (code !== "TAIEX" && corporateActionCoverage[code] !== true) {
      const datasets = ["TaiwanStockDividendResult", "TaiwanStockCapitalReductionReferencePrice", "TaiwanStockSplitPrice"];
      corporateActions[code] = [];
      corporateActionCoverage[code] = true;
      for (const dataset of datasets) {
        try {
          const events = await request(dataset, code);
          for (const event of events) {
            // Do not guess an effective date if the provider's response changes.
            if (typeof event.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
              throw new Error(`${dataset}/${code}: event has no normalized date`);
            }
            corporateActions[code].push({ ...event, dataset });
          }
        } catch (error) {
          corporateActionCoverage[code] = false;
          errors.push(String(error));
        }
      }
    }
    completed++;
    if (completed % 10 === 0) console.log(`Fetched ${completed}/${codes.size} instruments`);
  }
}
await Promise.all([worker(), worker(), worker()]);
mkdirSync("data/backtest", { recursive: true });
writeFileSync("data/backtest/price-input.json", JSON.stringify({
  source: "FinMind public v4 API", fetchedAt: new Date().toISOString(), startDate, endDate,
  prices, institutional, corporateActions, corporateActionCoverage, errors,
}, null, 2) + "\n");
console.log(JSON.stringify({ instruments: Object.keys(prices).length, requested: codes.size, errors }));
if (!prices.TAIEX?.length) process.exitCode = 1;
