import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendNewCategory, loadTaxonomy, normalizeCategory, saveTaxonomy, stripSuffixes } from "./lib/taxonomy.ts";

interface Member {
  code: string;
  name: string;
  pct: number;
  chips?: { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number };
  dayTradeRatio?: number;
  flags?: { attention?: boolean; disposition?: boolean; lowLiquidity?: boolean };
  overnightDump?: boolean;
  overnightDumpRepeat?: boolean;
}

export interface StageSignals {
  groupAvgPct: number;
  instNetDirection: "buy" | "sell" | "mixed" | "none";
  instVsPriceDivergence: boolean;
  avgDayTradeRatio: number | null;
  highDayTrade: boolean;
  leaderConcentration: "leader-only" | "broad";
  speculativeRatio: number;
  consecutiveDaysInStrong: number;
  memberCountDelta: number | null;
  retreatSignal: boolean;
}

interface GroupTask {
  tradingDate: string;
  timestamp: string;
  category: string;
  rawCategory?: string;
  direction: "gainer" | "loser";
  stocks: string[];
  members: Member[];
  preliminaryStory?: string;
  queryHints?: string[];
  retreatSignal?: boolean;
  stageSignals?: StageSignals;
}

interface MarketStockEntry {
  code: string;
  name: string;
  pct: number;
  chips?: Member["chips"];
  dayTradeRatio?: number;
  flags?: Member["flags"];
}

interface OverrideRule {
  category: string;
  queryHints: string[];
  preliminaryStory: string;
}

const taskDir = resolve(process.cwd(), process.argv[2] ?? "data/tmp/group-tasks");

const OVERRIDES: Record<string, OverrideRule> = {
  "2313": {
    category: "低軌衛星/HDI高階PCB",
    queryHints: ["華通 低軌衛星 HDI PCB 台股", "華通 衛星板 高階PCB"],
    preliminaryStory:
      "華通雖屬 PCB 廠，但盤面解讀應優先放在低軌衛星與高階 HDI 板題材，不宜與一般 PCB/CCL 下游混為同一組。",
  },
  "2367": {
    category: "低軌衛星/HDI高階PCB",
    queryHints: ["燿華 低軌衛星 HDI PCB 台股", "燿華 衛星板 高階PCB"],
    preliminaryStory:
      "燿華具低軌衛星與高階 HDI 板題材，若進入漲跌幅榜，應優先視為衛星板/高階板鏈，而不是一般 PCB 分類。",
  },
  "3491": {
    category: "低軌衛星/微波通訊",
    queryHints: ["昇達科 低軌衛星 微波通訊 台股", "昇達科 衛星通訊"],
    preliminaryStory:
      "昇達科的市場定位偏低軌衛星與微波通訊，分類時應優先獨立出衛星通訊題材，避免併入一般網通或光通訊。",
  },
  "8277": memoryRule(),
  "8299": memoryRule(),
  "3260": memoryRule(),
  "4967": memoryRule(),
  "4973": memoryRule(),
  "3006": memoryRule(),
  "8110": memoryRule(),
  "6488": {
    category: "矽晶圓/半導體基板",
    queryHints: ["環球晶 矽晶圓 台股", "矽晶圓 半導體基板 景氣"],
    preliminaryStory:
      "矽晶圓屬半導體基板供應鏈，和 DRAM/NAND 記憶體模組或控制 IC 的報價邏輯不同，應獨立觀察。",
  },
};

function memoryRule(): OverrideRule {
  return {
    category: "DRAM/NAND記憶體模組與控制IC",
    queryHints: ["DRAM NAND 記憶體模組 台股", "記憶體控制IC SSD 台股", "記憶體報價 模組廠"],
    preliminaryStory:
      "記憶體模組、NAND 控制 IC 與記憶體封測的核心變數是 DRAM/NAND 報價、SSD 需求與庫存循環，應和 RF、石英、矽晶圓或一般 IC 設計拆開。",
  };
}

function stockLabel(member: Member): string {
  return `${member.name}(${member.code})`;
}

function slugify(input: string): string {
  const aliases: Record<string, string> = {
    "低軌衛星/HDI高階PCB": "leo-satellite-hdi-pcb",
    "低軌衛星/微波通訊": "leo-satellite-microwave",
    "DRAM/NAND記憶體模組與控制IC": "dram-nand-memory-controller",
    "矽晶圓/半導體基板": "silicon-wafer-substrate",
  };
  if (aliases[input]) return aliases[input];

  return input
    .toLowerCase()
    .replace(/dram/g, "dram")
    .replace(/nand/g, "nand")
    .replace(/hdi/g, "hdi")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "group";
}

function mergeHints(...hints: Array<string[] | undefined>): string[] {
  return [...new Set(hints.flatMap((items) => items ?? []))].slice(0, 6);
}

function mergeStory(category: string, direction: GroupTask["direction"], stories: Array<string | undefined>): string {
  const usefulStories = stories.filter((story): story is string => Boolean(story?.trim()));
  if (usefulStories.length === 0) {
    return direction === "gainer"
      ? `${category}的交易重點在產業需求、規格升級、報價或代表股事件，後續可沿著成分股的接單、營收與法人資金尋找最有解釋力的催化。`
      : `${category}的賣壓多半要從前波漲多後籌碼調節、報價或庫存預期、法人資金收斂與代表股事件判讀，同時保留原本產業題材的中期亮點。`;
  }
  return usefulStories[0];
}

function normalizeTask(task: GroupTask): GroupTask {
  return {
    ...task,
    stocks: task.members.map(stockLabel),
    queryHints: mergeHints(task.queryHints, [`${task.category} 台股 盤後`]),
  };
}

function regroup(direction: GroupTask["direction"], tasks: GroupTask[]): GroupTask[] {
  const output = new Map<string, GroupTask>();

  function upsert(base: GroupTask, member: Member, rule?: OverrideRule) {
    const category = rule?.category ?? base.category;
    const key = `${direction}:${category}`;
    const existing = output.get(key);

    if (!existing) {
      output.set(key, {
        tradingDate: base.tradingDate,
        timestamp: base.timestamp,
        category,
        direction,
        stocks: [stockLabel(member)],
        members: [member],
        preliminaryStory: rule?.preliminaryStory ?? base.preliminaryStory ?? "",
        queryHints: mergeHints(rule?.queryHints, base.queryHints, [`${category} 台股 盤後`]),
      });
      return;
    }

    existing.members.push(member);
    existing.stocks = existing.members.map(stockLabel);
    existing.preliminaryStory = mergeStory(category, direction, [
      existing.preliminaryStory,
      rule?.preliminaryStory,
      base.preliminaryStory,
    ]);
    existing.queryHints = mergeHints(existing.queryHints, rule?.queryHints, base.queryHints, [`${category} 台股 盤後`]);
  }

  for (const task of tasks) {
    for (const member of task.members) {
      upsert(task, member, OVERRIDES[member.code]);
    }
  }

  return [...output.values()].map(normalizeTask);
}

// Resolve taxonomy path relative to the script file so it works regardless of cwd
const TAXONOMY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../data/taxonomy.json");

/** Parse `## 強勢族群` section from a memory .md and return canonical category set */
export function parseStrongCategoriesFromMemory(md: string, taxonomy: { categories: { canonical: string; aliases: string[] }[] }): Set<string> {
  const result = new Set<string>();
  const sectionMatch = md.match(/## 強勢族群\n([\s\S]*?)(?=\n## |$)/);
  if (!sectionMatch) return result;
  const lines = sectionMatch[1].split("\n");
  for (const line of lines) {
    const m = line.match(/^- 類別:\s*(.+?)[:：]/);
    const raw = m ? m[1].trim() : line.match(/^- ([^:：(（\n]+)/)?.[1]?.trim();
    if (!raw) continue;
    const stripped = stripSuffixes(raw);
    // Try normalizing against taxonomy if available
    const found = taxonomy.categories.find(
      (e) =>
        e.canonical === stripped ||
        e.aliases.includes(stripped) ||
        e.canonical === raw ||
        e.aliases.includes(raw),
    );
    result.add(found ? found.canonical : stripped);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Overnight dump detection
// ---------------------------------------------------------------------------

interface OvernightDumpTally {
  [code: string]: { count: number; lastDate: string; dates: string[] };
}

/** Returns sorted list of YYYY-MM-DD filenames (without .json) from priceHistoryDir */
export function findPrevTwoTradingDates(
  priceHistoryDir: string,
  tradingDate: string,
): [string, string] | null {
  if (!existsSync(priceHistoryDir)) return null;
  const dates = readdirSync(priceHistoryDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter((d) => d < tradingDate)
    .sort();
  if (dates.length < 2) return null;
  return [dates[dates.length - 2], dates[dates.length - 1]];
}

/** Returns true when stock satisfies the overnight-dump pattern */
export function detectOvernightDump(
  member: Member,
  prevDayClose: number | undefined,
  prevPrevDayClose: number | undefined,
): boolean {
  if (member.pct >= 0) return false;
  if ((member.dayTradeRatio ?? 0) < 40) return false;
  if (prevDayClose === undefined || prevPrevDayClose === undefined) return false;
  if (prevPrevDayClose === 0) return false;
  const limitUpPct = ((prevDayClose - prevPrevDayClose) / prevPrevDayClose) * 100;
  return limitUpPct >= 9.5;
}

/** Idempotent tally update — same date does not double-count */
export function updateTally(
  tally: OvernightDumpTally,
  code: string,
  date: string,
): OvernightDumpTally {
  const entry = tally[code];
  if (entry && entry.lastDate === date) return tally;
  if (!entry) {
    tally[code] = { count: 1, lastDate: date, dates: [date] };
  } else {
    entry.count += 1;
    entry.lastDate = date;
    entry.dates.push(date);
  }
  return tally;
}

/** Mark retreatSignal on loser tasks whose canonical category appeared in recent strong sets */
export function applyRetreatSignals(
  tasks: GroupTask[],
  recentStrongSets: Set<string>[],
): void {
  const allStrong = new Set<string>();
  for (const s of recentStrongSets) {
    for (const c of s) allStrong.add(c);
  }
  for (const task of tasks) {
    if (task.direction !== "loser") continue;
    if (allStrong.has(task.category)) {
      task.retreatSignal = true;
      console.log(`retreatSignal: ${task.category}`);
    }
  }
}

/** Enrich task members with chips/dayTradeRatio/flags from market-latest.json */
export function enrichMembersFromMarket(
  tasks: GroupTask[],
  marketByCode: Map<string, MarketStockEntry>,
): void {
  for (const task of tasks) {
    for (const member of task.members) {
      const entry = marketByCode.get(member.code);
      if (!entry) continue;
      if (entry.chips !== undefined) member.chips = entry.chips;
      if (entry.dayTradeRatio !== undefined) member.dayTradeRatio = entry.dayTradeRatio;
      if (entry.flags !== undefined) member.flags = entry.flags;
    }
  }
}

/**
 * Parse member counts for each category appearing in 強勢族群/弱勢族群 sections.
 * Returns a Map from canonical category → { strong?: number, weak?: number }.
 * Line format: `- 類別: N檔` or `- 類別名稱: N檔`
 */
export function parseCategoryMemberCounts(
  md: string,
  taxonomy: { categories: { canonical: string; aliases: string[] }[] },
): Map<string, { strong?: number; weak?: number }> {
  const result = new Map<string, { strong?: number; weak?: number }>();

  function parseSection(sectionMd: string, key: "strong" | "weak"): void {
    const lines = sectionMd.split("\n");
    for (const line of lines) {
      // Match patterns like:
      //   - 類別: 被動元件: 8檔 ...
      //   - 被動元件(MLCC/電感/石英): 8檔 ...
      const m = line.match(/^-\s+(?:類別:\s*)?(.+?)[:：]\s*(\d+)檔/);
      if (!m) continue;
      const rawCategory = m[1].trim();
      const count = parseInt(m[2], 10);
      const stripped = stripSuffixes(rawCategory);
      const found = taxonomy.categories.find(
        (e) =>
          e.canonical === stripped ||
          e.aliases.includes(stripped) ||
          e.canonical === rawCategory ||
          e.aliases.includes(rawCategory),
      );
      const canonical = found ? found.canonical : stripped;
      const existing = result.get(canonical) ?? {};
      existing[key] = count;
      result.set(canonical, existing);
    }
  }

  const strongMatch = md.match(/## 強勢族群\n([\s\S]*?)(?=\n## |$)/);
  if (strongMatch) parseSection(strongMatch[1], "strong");

  const weakMatch = md.match(/## 弱勢族群\n([\s\S]*?)(?=\n## |$)/);
  if (weakMatch) parseSection(weakMatch[1], "weak");

  return result;
}

/**
 * Compute objective stage signals for a task based on its members and recent memory files.
 * memoryMds: list of recent memory markdown strings, oldest first.
 * taxonomy: loaded taxonomy for canonical matching.
 */
export function computeStageSignals(
  task: GroupTask,
  memoryMds: string[],
  taxonomy: { categories: { canonical: string; aliases: string[] }[] },
): StageSignals {
  const members = task.members;
  const n = members.length;

  // groupAvgPct
  const groupAvgPct = n > 0 ? members.reduce((sum, m) => sum + m.pct, 0) / n : 0;

  // instNetDirection: sum foreignNet + trustNet across all members that have chips
  const membersWithChips = members.filter((m) => m.chips !== undefined);
  let instNetDirection: StageSignals["instNetDirection"] = "none";
  if (membersWithChips.length > 0) {
    const totalInst = membersWithChips.reduce(
      (sum, m) => sum + (m.chips!.foreignNet + m.chips!.trustNet),
      0,
    );
    const buyCount = membersWithChips.filter((m) => m.chips!.foreignNet + m.chips!.trustNet > 0).length;
    const sellCount = membersWithChips.filter((m) => m.chips!.foreignNet + m.chips!.trustNet < 0).length;
    if (buyCount > 0 && sellCount > 0) {
      instNetDirection = "mixed";
    } else if (totalInst > 0) {
      instNetDirection = "buy";
    } else if (totalInst < 0) {
      instNetDirection = "sell";
    } else {
      instNetDirection = "none";
    }
  }

  // instVsPriceDivergence: price up but inst selling, or price down but inst buying
  const priceUp = groupAvgPct > 0;
  const instSell = instNetDirection === "sell";
  const instBuy = instNetDirection === "buy";
  const instVsPriceDivergence = (priceUp && instSell) || (!priceUp && instBuy);

  // avgDayTradeRatio
  const membersWithDtr = members.filter((m) => m.dayTradeRatio !== undefined);
  const avgDayTradeRatio =
    membersWithDtr.length > 0
      ? membersWithDtr.reduce((sum, m) => sum + m.dayTradeRatio!, 0) / membersWithDtr.length
      : null;
  const highDayTrade = avgDayTradeRatio !== null && avgDayTradeRatio >= 40;

  // leaderConcentration
  let leaderConcentration: StageSignals["leaderConcentration"] = "leader-only";
  if (n >= 4) {
    const sorted = [...members].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    const topPct = Math.abs(sorted[0].pct);
    const restAvg =
      sorted.slice(1).reduce((sum, m) => sum + Math.abs(m.pct), 0) / (sorted.length - 1);
    // "broad" when top leader is not more than 2x the rest average
    if (topPct < restAvg * 2) {
      leaderConcentration = "broad";
    }
  }

  // speculativeRatio
  const speculativeCount = members.filter(
    (m) => m.flags?.lowLiquidity || m.flags?.disposition || m.flags?.attention,
  ).length;
  const speculativeRatio = n > 0 ? speculativeCount / n : 0;

  // consecutiveDaysInStrong: count how many trailing memory files contain this category in 強勢族群
  // memoryMds is oldest-first; we want trailing from most recent
  let consecutiveDaysInStrong = 0;
  for (let i = memoryMds.length - 1; i >= 0; i--) {
    const strongSet = parseStrongCategoriesFromMemory(memoryMds[i], taxonomy);
    if (strongSet.has(task.category)) {
      consecutiveDaysInStrong++;
    } else {
      break;
    }
  }

  // memberCountDelta: today's member count minus last memory's count for same category
  let memberCountDelta: number | null = null;
  if (memoryMds.length > 0) {
    const lastMemory = memoryMds[memoryMds.length - 1];
    const counts = parseCategoryMemberCounts(lastMemory, taxonomy);
    const entry = counts.get(task.category);
    if (entry?.strong !== undefined) {
      memberCountDelta = n - entry.strong;
    }
  }

  return {
    groupAvgPct,
    instNetDirection,
    instVsPriceDivergence,
    avgDayTradeRatio,
    highDayTrade,
    leaderConcentration,
    speculativeRatio,
    consecutiveDaysInStrong,
    memberCountDelta,
    retreatSignal: task.retreatSignal ?? false,
  };
}

const TALLY_PATH = resolve(process.cwd(), "data/overnight-dump-tally.json");

function loadTally(): OvernightDumpTally {
  if (!existsSync(TALLY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(TALLY_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveTally(tally: OvernightDumpTally): void {
  mkdirSync(dirname(TALLY_PATH), { recursive: true });
  writeFileSync(TALLY_PATH, `${JSON.stringify(tally, null, 2)}\n`, "utf8");
}

function applyOvernightDump(
  tasks: GroupTask[],
  tradingDate: string,
  priceHistoryDir: string,
  marketLatestPath: string,
): void {
  const prevTwo = findPrevTwoTradingDates(priceHistoryDir, tradingDate);
  if (!prevTwo) return; // not enough history

  const [prevPrevDate, prevDate] = prevTwo;

  // Load price history files
  let prevDayPrices: Record<string, number> = {};
  let prevPrevDayPrices: Record<string, number> = {};
  try {
    prevDayPrices = JSON.parse(readFileSync(join(priceHistoryDir, `${prevDate}.json`), "utf8"));
    prevPrevDayPrices = JSON.parse(readFileSync(join(priceHistoryDir, `${prevPrevDate}.json`), "utf8"));
  } catch {
    return;
  }

  const tally = loadTally();
  const hits: string[] = [];

  for (const task of tasks) {
    if (task.direction !== "loser") continue;
    for (const member of task.members) {
      if (
        detectOvernightDump(
          member,
          prevDayPrices[member.code],
          prevPrevDayPrices[member.code],
        )
      ) {
        member.overnightDump = true;
        updateTally(tally, member.code, tradingDate);
        if ((tally[member.code]?.count ?? 0) >= 2) {
          member.overnightDumpRepeat = true;
        }
        hits.push(`${member.name}(${member.code}) repeat=${member.overnightDumpRepeat ?? false}`);
      }
    }
  }

  if (hits.length > 0) {
    console.log(`overnightDump hits: ${hits.join(", ")}`);
    saveTally(tally);

    // Patch market-latest.json stockMap so send-report can read the flags
    if (existsSync(marketLatestPath)) {
      try {
        const market = JSON.parse(readFileSync(marketLatestPath, "utf8"));
        if (market.stockMap && typeof market.stockMap === "object") {
          for (const task of tasks) {
            for (const member of task.members) {
              if (!member.overnightDump) continue;
              if (!market.stockMap[member.code]) {
                market.stockMap[member.code] = { pct: member.pct };
              }
              market.stockMap[member.code].overnightDump = true;
              if (member.overnightDumpRepeat) {
                market.stockMap[member.code].overnightDumpRepeat = true;
              }
            }
          }
          writeFileSync(marketLatestPath, `${JSON.stringify(market, null, 2)}\n`, "utf8");
        }
      } catch {
        // market-latest unwritable — skip patch
      }
    }
  } else {
    console.log("overnightDump: no hits today");
  }
}

function main() {
  const files = readdirSync(taskDir).filter((file) => file.endsWith(".json")).sort();
  const tasks: GroupTask[] = files.map((file) => JSON.parse(readFileSync(join(taskDir, file), "utf8")));

  const refined = [
    ...regroup("gainer", tasks.filter((task) => task.direction === "gainer")),
    ...regroup("loser", tasks.filter((task) => task.direction === "loser")),
  ];

  // Taxonomy normalization (skipped gracefully if taxonomy file is absent)
  let recentMemoryMds: string[] = [];
  if (existsSync(TAXONOMY_PATH)) {
    const taxonomy = loadTaxonomy(TAXONOMY_PATH);
    let taxonomyDirty = false;
    for (const task of refined) {
      const result = normalizeCategory(task.category, taxonomy);
      if (result.isNew) {
        console.log(`new category: ${result.canonical}`);
        appendNewCategory(taxonomy, task.category, result.canonical);
        taxonomyDirty = true;
      }
      if (result.canonical !== task.category) {
        task.rawCategory = task.category;
        task.category = result.canonical;
      }
    }
    if (taxonomyDirty) {
      saveTaxonomy(TAXONOMY_PATH, taxonomy);
    }

    // Retreat signal: read last 3 memory files and mark loser tasks that were recently strong
    const memoryDir = resolve(process.cwd(), "data/memory");
    if (existsSync(memoryDir)) {
      const memFiles = readdirSync(memoryDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .slice(-3);
      recentMemoryMds = memFiles.map((f) => readFileSync(join(memoryDir, f), "utf8"));
      const recentStrongSets = recentMemoryMds.map((md) =>
        parseStrongCategoriesFromMemory(md, taxonomy),
      );
      applyRetreatSignals(refined, recentStrongSets);
    }
  }

  // Enrich members with chips/dayTradeRatio/flags from market-latest.json
  const marketPath = resolve(process.cwd(), "data/market-latest.json");
  let tradingDate = "";
  if (existsSync(marketPath)) {
    try {
      const market = JSON.parse(readFileSync(marketPath, "utf8"));
      tradingDate = market.tradingDate ?? "";
      const byCode = new Map<string, MarketStockEntry>();
      for (const entry of [...(market.gainers ?? []), ...(market.losers ?? [])]) {
        byCode.set(entry.code, entry as MarketStockEntry);
      }
      enrichMembersFromMarket(refined, byCode);
    } catch {
      // market file unreadable — skip enrichment
    }
  }

  // Detect overnight dump pattern on loser tasks
  if (tradingDate) {
    const priceHistoryDir = resolve(process.cwd(), "data/price-history");
    applyOvernightDump(refined, tradingDate, priceHistoryDir, marketPath);
  }

  // Compute stage signals for all tasks (requires enriched members + retreat signals)
  if (existsSync(TAXONOMY_PATH)) {
    const taxonomy = loadTaxonomy(TAXONOMY_PATH);
    for (const task of refined) {
      task.stageSignals = computeStageSignals(task, recentMemoryMds, taxonomy);
    }
  }

  rmSync(taskDir, { recursive: true, force: true });
  mkdirSync(taskDir, { recursive: true });

  refined.forEach((task, index) => {
    const number = String(index + 1).padStart(2, "0");
    const file = `${number}-${task.direction}-${slugify(task.category)}.json`;
    writeFileSync(join(taskDir, file), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  });

  console.log(`Refined ${files.length} task files into ${refined.length} task files in ${taskDir}`);
}

main();
