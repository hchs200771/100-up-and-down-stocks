/** Offline event study. All returns are decimal, event-weighted and unadjusted for corporate actions. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { displayBrokerCode } from "./fetch-broker-watch";
import { clean, gradeBranches, loadBrokerNames, MIN_DIRECTIONALITY, MIN_OBSERVED_WEEKS, type Price, type Week } from "./scan-winner-brokers";

const ROOT = resolve("data/broker-scan");
const AS_OF = "2026-10-23", TRAIN_END = "2025-06-27", TEST_START = "2025-07-07";
const FOREIGN = /港商|美商|美林|摩根|高盛|瑞銀|花旗|匯豐|法銀|大和|野村|麥格理|瑞士|德意志|新加坡|星展|法國|里昂|巴克萊|富瑞|渣打/;
const DAY_MS = 86400_000;
type Side = "buy" | "sell";
type Event = {
  stock: string; code: string; side: Side; monday: string; friday: string; directionality: number;
  entryDate: string; end20: string; end60: string; return20: number; return60: number;
  benchmark20: number; benchmark60: number; benchmarkStocks20: number; benchmarkStocks60: number;
  excess20: number; excess60: number;
};
type Moments = { n: number; sum20: number; sum60: number; mean60: number; m260: number; hits60: number };
type Stats = { n: number; meanExcess20: number | null; meanExcess60: number | null; hitRate60: number | null; tStat60: number | null };
type Pair = {
  stock: string; code: string; hq: string; name: string; side: Side;
  train: Moments; trainAtCutoff: Moments; test: Moments; testEvents: Event[];
};
type Selection = { id: string; label: string; side: Side; pairs: number; testEvents: number; meanExcess20: number | null;
  meanExcess60: number | null; hitRate60: number | null; tStat60: number | null;
  differenceVsBaseline20: number | null; differenceVsBaseline60: number | null };
const empty = (): Moments => ({ n: 0, sum20: 0, sum60: 0, mean60: 0, m260: 0, hits60: 0 });
function add(a: Moments, b: Moments) {
  // Parallel Welford moments avoid cancellation for pairs with almost identical returns.
  if (b.n) {
    const delta = b.mean60 - a.mean60, n = a.n + b.n;
    a.m260 += b.m260 + delta * delta * a.n * b.n / n;
    a.mean60 += delta * b.n / n;
  }
  a.n += b.n; a.sum20 += b.sum20; a.sum60 += b.sum60; a.hits60 += b.hits60;
  return a;
}
function observe(a: Moments, e: Event) {
  return add(a, { n: 1, sum20: e.excess20, sum60: e.excess60, mean60: e.excess60, m260: 0, hits60: Number(e.excess60 > 0) });
}
export function stats(a: Moments): Stats {
  const mean = a.n ? a.sum60 / a.n : null;
  const variance = a.n > 1 ? Math.max(0, a.m260 / (a.n - 1)) : null;
  return { n: a.n, meanExcess20: a.n ? a.sum20 / a.n : null, meanExcess60: mean,
    hitRate60: a.n ? a.hits60 / a.n : null,
    tStat60: variance !== null && variance > 0 ? mean! / Math.sqrt(variance / a.n) : null };
}
const key = (stock: string, code: string, side: Side) => `${stock}/${code}/${side}`;
const qualify = (p: Pair) => p.train.n >= 3 && p.train.sum60 > 0 && p.train.hits60 / p.train.n >= 0.6;
const total = (pairs: Pair[]) => pairs.reduce((a, p) => add(a, p.test), empty());
const diff = (a: number | null, b: number | null) => a === null || b === null ? null : a - b;
const valid = (price: number) => Number.isFinite(price) && price > 0;
const addDays = (s: string, n: number) => new Date(Date.parse(s) + n * DAY_MS).toISOString().slice(0, 10);

function selection(id: string, label: string, side: Side, pairs: Pair[], baseline: Stats): Selection {
  const s = stats(total(pairs));
  return { id, label, side, pairs: pairs.length, testEvents: s.n, meanExcess20: s.meanExcess20, meanExcess60: s.meanExcess60,
    hitRate60: s.hitRate60, tStat60: s.tStat60, differenceVsBaseline20: diff(s.meanExcess20, baseline.meanExcess20),
    differenceVsBaseline60: diff(s.meanExcess60, baseline.meanExcess60) };
}
// Fixed PRNG seed makes the 1,000 pair bootstraps reproducible.
function randomGenerator(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed);
    x ^= x + Math.imul(x ^ x >>> 7, 61 | x); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const quantile = (p: number) => {
    const i = (values.length - 1) * p, lo = Math.floor(i);
    return values[lo] + (values[Math.ceil(i)] - values[lo]) * (i - lo);
  };
  return { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    interval95: values.length ? [quantile(0.025), quantile(0.975)] : null };
}
function bootstrap(population: Pair[], count: number, side: Side, baseline: Stats) {
  const seed = side === "buy" ? 20261023 : 20261024, random = randomGenerator(seed);
  const samples: Stats[] = [];
  if (count && population.length) for (let i = 0; i < 1000; i++) {
    const a = empty();
    for (let j = 0; j < count; j++) add(a, population[Math.floor(random() * population.length)].test);
    samples.push(stats(a));
  }
  const dist = (field: keyof Stats) => distribution(samples.flatMap((s) => s[field] === null ? [] : [s[field]!]));
  const excess20 = dist("meanExcess20"), excess60 = dist("meanExcess60");
  const row: Selection = { id: "random", label: "隨機配對×1000", side, pairs: count, testEvents: dist("n").mean ?? 0,
    meanExcess20: excess20.mean, meanExcess60: excess60.mean, hitRate60: dist("hitRate60").mean, tStat60: dist("tStat60").mean,
    differenceVsBaseline20: diff(excess20.mean, baseline.meanExcess20), differenceVsBaseline60: diff(excess60.mean, baseline.meanExcess60) };
  return { row, seed, draws: samples.length, populationPairs: population.length, nonemptySamples: samples.filter((s) => s.n > 0).length,
    meanExcess20: excess20, meanExcess60: excess60, testEventCount: dist("n"),
    note: "Uniform train-observed (stock,branch) pairs, with replacement; duplicates retain event multiplicity. Row metrics are replicate means; testEvents is expected count." };
}

function evaluate(
  allPairs: Pair[], oldGrades: Record<string, { stock: string; code: string; wins: number; D: number; pnl: number }[]>,
  trainIdentities: Map<string, { hq: string; name: string }>,
) {
  const tables: Selection[] = [], randomBaselines = [], selectedPairs: Record<string, unknown[]> = {};
  const branchTables: Record<string, unknown[]> = {}, pairTables: Record<string, unknown[]> = {};
  for (const side of ["buy", "sell"] as const) {
    const sidePairs = allPairs.filter((p) => p.side === side), trainPairs = sidePairs.filter((p) => p.train.n > 0);
    const eligible = trainPairs.filter(qualify).sort((a, b) => (stats(b.train).tStat60 ?? -Infinity) - (stats(a.train).tStat60 ?? -Infinity) || key(a.stock, a.code, side).localeCompare(key(b.stock, b.code, side)));
    const qualifyingBreadth = new Map<string, number>();
    for (const p of eligible) qualifyingBreadth.set(p.code, (qualifyingBreadth.get(p.code) ?? 0) + 1);
    const channelReasons = (p: Pair) => [FOREIGN.test(p.name) ? "foreign" : "", p.code === p.hq ? "hq" : "",
      p.name.includes("法人") ? "institutional" : "", (qualifyingBreadth.get(p.code) ?? 0) >= 15 ? "qualifyingBreadth>=15" : ""].filter(Boolean);
    const local = (p: Pair) => !channelReasons(p).length;
    const baseline = stats(total(sidePairs));
    tables.push(selection("baseline", "全部事件", side, sidePairs.filter((p) => p.test.n > 0), baseline));
    const random = bootstrap(trainPairs, eligible.length, side, baseline);
    randomBaselines.push({ side, ...random }); tables.push(random.row);
    const detail = (p: Pair) => ({ stock: p.stock, code: p.code, name: p.name, hq: p.hq, side,
      train: stats(p.train), test: stats(p.test), qualifyingBreadth: qualifyingBreadth.get(p.code) ?? 0, testEvents: p.testEvents });
    const localEligible = eligible.filter(local);
    // Filter channels before ranking, so top-N local variants can fill their N slots.
    for (const [id, label, pool] of [["score", "事件評分", eligible], ["localScore", "在地事件評分", localEligible]] as const) {
      for (const limit of [null, 50, 200]) {
        const chosen = limit === null ? pool : pool.slice(0, limit), suffix = limit === null ? "" : `Top${limit}`;
        const selectionId = `${id}${suffix}`;
        tables.push(selection(selectionId, `${label}${suffix}`, side, chosen, baseline));
        if (id === "localScore") selectedPairs[`${side}/${selectionId}`] = chosen.map(detail);
      }
    }
    for (const threshold of [0.15, 0.20, 0.30]) {
      const gradeMap = new Map(oldGrades[String(threshold)].map((g) => [`${g.stock}/${g.code}`, g]));
      // A grade is branch-level across long/short episodes, exactly as in the old scanner.
      // Include grade-A pairs even when that side has no valid train/test event.
      const chosen: Pair[] = [];
      for (const g of gradeMap.values()) {
        const existing = sidePairs.find((p) => p.stock === g.stock && p.code === g.code);
        // Resolve absent-event identities only from TRAIN rankings via the cached train identity map.
        const identity = trainIdentities.get(`${g.stock}/${g.code}`)!;
        const p: Pair = existing ?? { stock: g.stock, code: g.code, side, ...identity, train: empty(), trainAtCutoff: empty(), test: empty(), testEvents: [] };
        if (local({ ...p, ...identity })) chosen.push(p);
      }
      const id = `oldA${Math.round(threshold * 100)}`;
      tables.push(selection(id, `舊法A@${Math.round(threshold * 100)}%在地`, side, chosen, baseline));
      if (threshold === 0.30) selectedPairs[`${side}/${id}`] = chosen.map((p) => ({ ...detail(p), oldGrade: gradeMap.get(`${p.stock}/${p.code}`) }));
    }
    pairTables[side] = trainPairs.map((p) => ({ stock: p.stock, code: p.code, name: p.name, hq: p.hq,
      ...stats(p.train), qualifies: qualify(p), channelReasons: channelReasons(p) }));
    const branches = new Map<string, { name: string; stocks: Set<string>; moments: Moments }>();
    for (const p of trainPairs) {
      const b = branches.get(p.code) ?? { name: p.name, stocks: new Set<string>(), moments: empty() };
      b.stocks.add(p.stock); add(b.moments, p.train); branches.set(p.code, b);
    }
    branchTables[side] = [...branches].map(([code, b]) => ({ code, name: b.name, breadth: b.stocks.size,
      qualifyingBreadth: qualifyingBreadth.get(code) ?? 0, ...stats(b.moments) }));
  }
  return { tables, randomBaselines, trainPairStats: pairTables, trainBranchStats: branchTables, selectedPairs };
}

async function main() {
  // Use the frozen cached universe rather than today's potentially different futures universe.
  const stocks = readdirSync(resolve(ROOT, "raw"), { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4,6}$/.test(d.name)).map((d) => d.name).sort();
  if (stocks.length !== 191) throw new Error(`Expected 191 cached universe stocks, got ${stocks.length}`);
  const names = await loadBrokerNames(ROOT, true); // true forbids the name loader's network fallback
  const dates: string[] = [], closes: Record<string, number>[] = [];
  for (const file of readdirSync(resolve("data/cache")).filter((f) => /^close-\d{8}\.json$/.test(f)).sort()) {
    const d = file.slice(6, 14), date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
    if (date > AS_OF) continue;
    const prices: Record<string, number> = JSON.parse(readFileSync(resolve("data/cache", file), "utf8"));
    if (!Object.keys(prices).length) continue;
    dates.push(date); closes.push(prices);
  }
  if (!dates.length) throw new Error("No cached trading closes");
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const firstAfter = (date: string) => {
    let lo = 0, hi = dates.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (dates[mid] <= date) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const benchmarks = new Map<string, { mean: number; n: number }>();
  function benchmark(entry: number, horizon: number) {
    const k = `${entry}/${horizon}`;
    if (!benchmarks.has(k)) {
      let sum = 0, n = 0;
      for (const stock of stocks) if (valid(closes[entry][stock]) && valid(closes[entry + horizon][stock])) {
        sum += closes[entry + horizon][stock] / closes[entry][stock] - 1; n++;
      }
      if (!n) throw new Error(`Empty benchmark ${dates[entry]}`);
      benchmarks.set(k, { mean: sum / n, n });
    }
    return benchmarks.get(k)!;
  }
  const pairs = new Map<string, Pair>();
  const trainIdentities = new Map<string, { hq: string; name: string }>();
  const oldGrades: Record<string, { stock: string; code: string; wins: number; D: number; pnl: number }[]> = { "0.15": [], "0.2": [], "0.3": [] };
  const diagnostics = { weeks: 0, directionalSignals: 0, declustered: 0, droppedBeyondCache: 0,
    droppedMissingPrice: 0, trainPurgedUnmatured: 0, trainAvailableEvents: 0, trainEvents: 0, testEvents: 0, excludedSplitGap: 0 };
  console.log(`[events] 離線讀取 ${stocks.length} 檔；交易日 ${dates[0]}~${dates.at(-1)}`);
  for (const [stockIndex, stock] of stocks.entries()) {
    const weeks: Week[] = readdirSync(resolve(ROOT, "raw", stock)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
      .map((f) => JSON.parse(readFileSync(resolve(ROOT, "raw", stock, f), "utf8")) as Week).filter((w) => w.friday <= AS_OF);
    const trainWeeks = weeks.filter((w) => w.friday <= TRAIN_END);
    const identities = new Map(trainWeeks.flatMap((w) => w.branches).map((b) => [displayBrokerCode(b.code), b]));
    for (const [code, b] of identities) {
      trainIdentities.set(`${stock}/${code}`, { hq: displayBrokerCode(b.hq), name: clean(b.name) || names.get(code) || "" });
    }
    const previous = new Map<string, number>();
    for (const week of weeks) {
      diagnostics.weeks++;
      for (const b of week.branches) {
        const gross = b.buy + b.sell, directionality = gross > 0 ? Math.abs(b.net) / gross : 0;
        if (!b.net || directionality < MIN_DIRECTIONALITY) continue;
        diagnostics.directionalSignals++;
        const code = displayBrokerCode(b.code), side: Side = b.net > 0 ? "buy" : "sell", k = key(stock, code, side);
        const time = Date.parse(week.monday), last = previous.get(k);
        previous.set(k, time); // Every raw signal resets the quiet period, even if suppressed or missing a return.
        if (last !== undefined && time - last <= 28 * DAY_MS) { diagnostics.declustered++; continue; }
        const entry = firstAfter(week.friday);
        if (entry + 60 >= dates.length) { diagnostics.droppedBeyondCache++; continue; }
        if (![0, 20, 60].every((h) => valid(closes[entry + h][stock]))) { diagnostics.droppedMissingPrice++; continue; }
        const b20 = benchmark(entry, 20), b60 = benchmark(entry, 60);
        const r20 = closes[entry + 20][stock] / closes[entry][stock] - 1;
        const r60 = closes[entry + 60][stock] / closes[entry][stock] - 1;
        const sign = side === "buy" ? 1 : -1;
        const e: Event = { stock, code, side, monday: week.monday, friday: week.friday, directionality,
          entryDate: dates[entry], end20: dates[entry + 20], end60: dates[entry + 60], return20: r20, return60: r60,
          benchmark20: b20.mean, benchmark60: b60.mean, benchmarkStocks20: b20.n, benchmarkStocks60: b60.n,
          excess20: sign * (r20 - b20.mean), excess60: sign * (r60 - b60.mean) };
        // Identity used for selection is frozen at train time; test names cannot alter channel filtering.
        let p = pairs.get(k);
        if (!p) { p = { stock, code, ...(trainIdentities.get(`${stock}/${code}`) ?? { hq: displayBrokerCode(b.hq), name: clean(b.name) || names.get(code) || "" }), side,
          train: empty(), trainAtCutoff: empty(), test: empty(), testEvents: [] }; pairs.set(k, p); }
        if (week.friday <= TRAIN_END) {
          observe(p.train, e); diagnostics.trainEvents++;
          if (e.end60 > TRAIN_END) diagnostics.trainPurgedUnmatured++;
          else { observe(p.trainAtCutoff, e); diagnostics.trainAvailableEvents++; }
        } else if (week.monday >= TEST_START) {
          observe(p.test, e); p.testEvents.push(e); diagnostics.testEvents++;
        } else diagnostics.excludedSplitGap++;
      }
    }
    const weeklyPrices = new Map<string, Price>();
    for (const w of trainWeeks) {
      const values = Array.from({ length: 5 }, (_, i) => dateIndex.get(addDays(w.monday, i)))
        .flatMap((i) => i !== undefined && valid(closes[i][stock]) ? [closes[i][stock]] : []);
      weeklyPrices.set(w.monday, { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, days: values.length });
    }
    let mark: number | null = null;
    for (let i = firstAfter(TRAIN_END) - 1; i >= 0; i--) if (valid(closes[i][stock])) { mark = closes[i][stock]; break; }
    // Higher-threshold A grades are subsets of the 15% candidates. Reuse the same
    // state-machine episodes rather than parse and analyze every branch three times.
    const graded = gradeBranches(weeks, weeklyPrices, mark, names, { cutoff: TRAIN_END, winReturn: 0.15 });
    for (const threshold of [0.15, 0.20, 0.30]) {
      for (const b of graded.branches) {
        const wins = b.episodes.filter((e) => e.observedWeeks >= MIN_OBSERVED_WEEKS && e.status === "closed" && e.return !== null && e.return >= threshold).length;
        if (wins >= 2) oldGrades[String(threshold)].push({ stock, code: b.displayCode, wins, D: b.D, pnl: b.pnl });
      }
    }
    if ((stockIndex + 1) % 25 === 0 || stockIndex + 1 === stocks.length) console.log(`[events] ${stockIndex + 1}/${stocks.length} 檔；train ${diagnostics.trainEvents}／test ${diagnostics.testEvents}`);
  }
  const allPairs = [...pairs.values()];
  const evaluation = evaluate(allPairs, oldGrades, trainIdentities);
  const strictForwardValidation = evaluate(allPairs.map((p) => ({ ...p, train: p.trainAtCutoff })), oldGrades, trainIdentities);
  const { tables, randomBaselines } = evaluation;
  const output = { asOf: AS_OF, generatedAt: new Date().toISOString(), universe: stocks, trainEnd: TRAIN_END, testStart: TEST_START,
    closeRange: { first: dates[0], last: dates.at(-1), tradingDays: dates.length }, diagnostics,
    methodology: { offline: true, directionality: MIN_DIRECTIONALITY, quietWeeks: 4, entry: "First cached trading-day close strictly after Friday; horizon exit is entry index + 20/60",
      trainLabelAvailability: "Primary tables: event Friday <= trainEnd, exactly the requested split. strictForwardValidation additionally requires 60-day exit <= trainEnd.",
      benchmark: "Equal-weight endpoint returns of cached-universe stocks with positive prices at both endpoints; includes event stock",
      weighting: "Events; both horizons use the same complete-60-day event sample", topN: "Qualifying pairs ranked by train t-stat within side; local filter precedes local top-N",
      tStat: "Mean / (sample SD / sqrt(n)); null for n<2 or zero variance; naive descriptive statistic, overlapping windows are dependent",
      oldGrade: "Original state machine, directionality, positive total P&L and >=2 closed wins across both sides; train weeks and train mark only",
      channelBreadth: "Side-specific count of stocks qualifying under selection 3, threshold >=15",
      caveats: ["Top-15 truncated branch observations; absent weeks are unknown", "Cached closes are unadjusted: corporate actions can distort returns",
        "Current cached stock universe has survivorship/selection bias", "Many pairs tested and overlapping event windows: t-stats are not independent significance tests",
        "No fees, slippage or short-borrow costs; sell excess is a directional score, not a tradable short return",
        "Primary event-week split uses some labels unavailable at trainEnd and overlapping early TEST; use strictForwardValidation for as-of selection"] },
    ...evaluation, strictForwardValidation };
  const path = resolve(ROOT, `event-study-${AS_OF}.json`);
  writeFileSync(path, JSON.stringify(output, null, 2));
  const percent = (n: number | null) => n === null ? "—" : `${(100 * n).toFixed(2)}%`;
  console.table(tables.map((r) => ({ 方向: r.side === "buy" ? "買" : "賣", 選法: r.label, 配對: r.pairs,
    事件: Number(r.testEvents.toFixed(1)), 超額20: percent(r.meanExcess20), 超額60: percent(r.meanExcess60),
    勝率60: percent(r.hitRate60), t60: r.tStat60?.toFixed(2) ?? "—", 差基準60: percent(r.differenceVsBaseline60) })));
  for (const r of randomBaselines) console.log(`[random ${r.side}] 60日95%區間 ${r.meanExcess60.interval95?.map(percent).join(" ~ ") ?? "—"}`);
  console.log(`[events] 前瞻驗證另排除未成熟訓練事件 ${diagnostics.trainPurgedUnmatured}；輸出 ${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error("[events] failed:", error); process.exitCode = 1; });
}
