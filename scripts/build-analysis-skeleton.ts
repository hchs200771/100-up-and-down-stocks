import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 把 data/tmp/group-tasks/*.json 與 data/tmp/group-results/*.json 機械合併成
 * data/tmp/analysis-skeleton.json，供 finalizer 接手。
 *
 * 設計目的：finalizer 實測 688s（佔全流程 34%），其中絕大部分是在做「讀 150 個檔、
 * 按規則搬字串、算四軸加總」這種完全不需要模型的工作，每個 Read 都是一次 API round-trip。
 * 這裡把可機械化的部分全部搬到腳本：
 *
 *   - task + result 依 direction|category 配對，story 三層 fallback
 *   - 弱勢族群「前 3 大 ∪ retreatSignal」出 story，其餘併成「其他弱勢」
 *   - stage 依 prompt 的客觀規則判定
 *   - entryScore 四軸中的 timing / chips / risk 三軸（規則已經是查表）
 *   - 標出含模板廢話、需要改寫的 story
 *
 * 留給 finalizer 的只剩真正需要判斷的：trend 軸、entryRationale、summary、
 * longTermStrategy、以及改寫被標記的 story。它讀 1 個檔就夠，不用讀 150 個。
 *
 * stage 與三軸都可被 finalizer 覆寫，這裡給的是有依據的預設值，不是最終答案。
 */

// runner 在 finalizer 前會把 snapshot 還原回 group-tasks，所以預設值通常就對；
// 但保留 argv 覆寫，讓斷點續跑時可以直接指到 group-tasks-backup。
const TASK_DIR = resolve(process.argv[2] ?? "data/tmp/group-tasks");
const RESULT_DIR = resolve(process.argv[3] ?? "data/tmp/group-results");
const MARKET_PATH = resolve("data/market-latest.json");
const OUT_PATH = resolve("data/tmp/analysis-skeleton.json");

/** 弱勢族群中，除 retreatSignal 之外還要寫完整 story 的組數（依成員數由大到小） */
const LOSER_ANALYZE_TOP = 3;

/**
 * speculativeRatio 這種「成員裡有幾成是投機股」的比例，在 1-2 檔的族群會退化成 0 / 0.5 / 1，
 * 完全不帶資訊（實測 42 組強勢族群裡有 21 組只有 1 檔，其中 12 組 spec 剛好等於 1）。
 * 少於這個成員數就不採用比例類訊號。
 */
const MIN_MEMBERS_FOR_RATIO = 3;

/** finalizer prompt 明令禁止出現在 story 裡的模板句，命中就標記 needsRewrite */
const BANNED_PHRASES = [
  "最近 2 天沒有",
  "最近 3 天沒有",
  "沒有查到",
  "沒有看到",
  "族群性較弱",
  "較偏個股事件整理",
  "同步轉強",
  "同步轉弱",
  "初步看",
  "若缺乏",
  "報告應",
  "fallback",
];

type Direction = "gainer" | "loser";

interface MemberChips {
  foreignNet?: number;
  trustNet?: number;
  dealerNet?: number;
  totalNet?: number;
}

interface Member {
  code: string;
  name: string;
  pct: number;
  chips?: MemberChips;
  dayTradeRatio?: number;
  flags?: Record<string, boolean>;
}

interface StageSignals {
  groupAvgPct?: number;
  instNetDirection?: "buy" | "sell" | "mixed" | null;
  instVsPriceDivergence?: boolean;
  avgDayTradeRatio?: number;
  highDayTrade?: boolean;
  leaderConcentration?: "leader-only" | "broad" | "mixed" | null;
  speculativeRatio?: number;
  consecutiveDaysInStrong?: number;
  memberCountDelta?: number | null;
  retreatSignal?: boolean;
}

interface Task {
  category: string;
  direction: Direction;
  stocks: string[];
  members: Member[];
  preliminaryStory?: string;
  stageSignals?: StageSignals;
}

interface Result {
  category: string;
  direction: Direction;
  story?: string;
  confidence?: "high" | "medium" | "low";
}

type Stage = "啟動" | "擴散" | "高潮" | "退潮";

/** 成員太少時比例訊號沒有意義，回 0 當作「沒有這個訊號」而不是「投機成分低」 */
function usableSpec(s: StageSignals, memberCount: number): number {
  if (memberCount < MIN_MEMBERS_FOR_RATIO) return 0;
  return s.speculativeRatio ?? 0;
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as T);
}

const key = (direction: string, category: string) => `${direction}|${category}`;

/**
 * 依 finalizer prompt 的客觀規則判 stage。訊號不足或互相矛盾就回 undefined，
 * 不硬標——prompt 的「維持省略原則」。
 *
 * 判定順序是 退潮 → 高潮 → 擴散 → 啟動：prompt 沒有寫明重疊時誰優先，
 * 這裡採風險優先，因為 entryScore 量的是 risk/reward，寧可低估不可高估。
 */
function decideStage(
  s: StageSignals | undefined,
  memberCount: number,
  alsoInLosers = false,
): Stage | undefined {
  if (!s) return undefined;
  const avg = s.groupAvgPct ?? 0;
  const spec = usableSpec(s, memberCount);

  // 同時出現在強弱兩邊，prompt 說可能是「換手／分化／退潮」三者之一，不是必然退潮。
  // 實測直接當退潮會讓 stage 一致度從 31/42 掉到 22/42，所以只當作加重條件：
  // 要再配上法人賣超才算退潮，單純兩邊都上榜就留給 finalizer 用產業知識判斷。
  if (s.retreatSignal || (avg < 0 && s.instNetDirection === "sell")) return "退潮";
  if (alsoInLosers && s.instNetDirection === "sell") return "退潮";
  // prompt 的原文是「任一成立即可『考慮』標高潮」，不是必定。照字面把 spec > 0.5 單獨當觸發條件，
  // 42 組會標出 22 組高潮，而 timing 軸吃 stage，等於系統性壓低整份報告的分數。
  // 實測誤標幾乎全來自小族群的退化 spec，所以改成：法人與股價背離是唯一夠硬的單獨證據，
  // 投機成分要配上當沖確實偏高才算。訊號不足就不硬標，符合 prompt 的「維持省略原則」。
  if (s.instVsPriceDivergence || (s.highDayTrade && spec > 0.3)) return "高潮";
  if (
    (s.consecutiveDaysInStrong ?? 0) >= 2 &&
    ((s.memberCountDelta ?? 0) > 0 || s.leaderConcentration === "broad") &&
    s.instNetDirection !== "sell"
  ) {
    return "擴散";
  }
  if (
    (s.consecutiveDaysInStrong ?? 0) <= 1 &&
    s.instNetDirection === "buy" &&
    s.leaderConcentration === "leader-only" &&
    !s.highDayTrade
  ) {
    return "啟動";
  }
  return undefined;
}

/** B. 進場時機（0-35）：優先吃 stage，沒 stage 就用連續天數與擴散訊號抓級距 */
function timingScore(stage: Stage | undefined, s: StageSignals | undefined): number {
  switch (stage) {
    case "啟動":
      return 32;
    case "擴散":
      return 24;
    case "高潮":
      return 8;
    case "退潮":
      return 2;
    default:
      break;
  }
  if (!s) return 18;
  if (s.instVsPriceDivergence) return 10;
  const days = s.consecutiveDaysInStrong ?? 0;
  if (days === 0) return 26; // 今天才進榜，偏啟動側
  if (days >= 3) return 14; // 連強多日，上檔開始收斂
  return 20;
}

/** C. 籌碼確認（0-25）：看族群整體外資/投信方向與龍頭集中度 */
function chipsScore(members: Member[], s: StageSignals | undefined): number {
  let foreign = 0;
  let trust = 0;
  for (const m of members) {
    foreign += m.chips?.foreignNet ?? 0;
    trust += m.chips?.trustNet ?? 0;
  }
  if (s?.instNetDirection === "sell" || foreign + trust <= 0) return 3;
  if (foreign > 0 && trust > 0) return s?.leaderConcentration === "leader-only" ? 23 : 20;
  if (foreign > 0 || trust > 0) return 13;
  return 3;
}

/** D. 風險扣分（-30-0）：逐項累減，下限 -30 */
function riskScore(members: Member[], s: StageSignals | undefined): number {
  let risk = 0;
  // avgDayTradeRatio 實測有 38% 的族群是 null（資料缺失），?? 0 會讓它安靜地當成「當沖很低」。
  // 缺資料就不扣分，但也別誤判成乾淨。
  if ((s?.avgDayTradeRatio ?? 0) > 40) risk -= 10;

  const spec = s ? usableSpec(s, members.length) : 0;
  if (spec > 0.5) risk -= 10;
  else if (spec > 0.3) risk -= 5;

  const hasFlag = (name: string) => members.some((m) => m.flags?.[name]);
  if (hasFlag("attention") || hasFlag("disposition") || hasFlag("lowLiquidity")) risk -= 5;
  if (hasFlag("overnightDump")) risk -= 10;

  return Math.max(-30, risk);
}

interface SkeletonGroup {
  category: string;
  stocks: string[];
  story: string;
  storySource: "worker" | "preliminary" | "none";
  needsRewrite: boolean;
  confidence: "high" | "medium" | "low";
  stage?: Stage;
  retreatSignal?: boolean;
  /** 同一族群也出現在弱勢名單：summary 要交代這是換手、分化還是退潮 */
  alsoInLosers?: boolean;
  scoreBreakdown?: { trend: null; timing: number; chips: number; risk: number };
  signals?: StageSignals;
}

/** story 三層 fallback：worker result → task.preliminaryStory → 空 */
function pickStory(
  task: Task,
  result: Result | undefined,
): Pick<SkeletonGroup, "story" | "storySource" | "needsRewrite" | "confidence"> {
  const workerStory = (result?.story ?? "").trim();
  if (workerStory) {
    return {
      story: workerStory,
      storySource: "worker",
      needsRewrite: BANNED_PHRASES.some((p) => workerStory.includes(p)),
      confidence: result?.confidence ?? "medium",
    };
  }
  const prelim = (task.preliminaryStory ?? "").trim();
  if (prelim) {
    // preliminaryStory 是分類階段的草稿，一律要求 finalizer 改寫成完整分析
    return { story: prelim, storySource: "preliminary", needsRewrite: true, confidence: "low" };
  }
  // 走到這裡代表 worker 掛了、task 也沒有草稿。這種族群是被「需要分析」的規則挑進來的
  // （強勢全部，弱勢前 3 大 ∪ retreatSignal），不能留空白，一定要 finalizer 自己寫。
  // 「其他弱勢」不經過這個函式，它的空 story 是刻意的。
  return { story: "", storySource: "none", needsRewrite: true, confidence: "low" };
}

function main() {
  if (!existsSync(MARKET_PATH)) throw new Error(`market-latest.json not found: ${MARKET_PATH}`);
  const market = JSON.parse(readFileSync(MARKET_PATH, "utf8"));

  const tasks = readJsonDir<Task>(TASK_DIR);
  if (!tasks.length) throw new Error(`no task files in ${TASK_DIR}`);
  const results = readJsonDir<Result>(RESULT_DIR);
  const resultBy = new Map(results.map((r) => [key(r.direction, r.category), r]));

  const gainerTasks = tasks.filter((t) => t.direction === "gainer");
  const loserTasks = tasks.filter((t) => t.direction === "loser");

  // 同時出現在弱勢名單的族群 → 換手/分化/退潮警訊，強勢側也要標出來
  const alsoInLosers = new Set(loserTasks.map((t) => t.category));

  const gainers: SkeletonGroup[] = gainerTasks.map((t) => {
    const both = alsoInLosers.has(t.category);
    const stage = decideStage(t.stageSignals, t.members.length, both);
    return {
      category: t.category,
      stocks: t.stocks,
      ...pickStory(t, resultBy.get(key("gainer", t.category))),
      ...(stage ? { stage } : {}),
      ...(both ? { alsoInLosers: true } : {}),
      scoreBreakdown: {
        trend: null, // 唯一需要產業判斷的一軸，留給 finalizer
        timing: timingScore(stage, t.stageSignals),
        chips: chipsScore(t.members, t.stageSignals),
        risk: riskScore(t.members, t.stageSignals),
      },
      signals: t.stageSignals,
    };
  });

  // 弱勢：前 N 大（依成員數）∪ 任何 retreatSignal 要寫完整 story，其餘併成「其他弱勢」。
  // 成員數相同時維持 task 檔原順序，所以用 index 當 tie-breaker。
  // controller 自己就會產一個 catch-all task（「其他弱勢個股事件整理」之類），它成員最多、
  // 會擠進前 3 名，但它本來就是雜項集合，要直接併走而不是給它一段 story。
  const isCatchAll = (t: Task) => t.category.includes("其他弱勢");
  const rankedIdx = loserTasks
    .map((t, i) => ({ i, n: isCatchAll(t) ? -1 : t.members.length }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, LOSER_ANALYZE_TOP)
    .map((x) => x.i);
  const topIdx = new Set(rankedIdx);

  const losers: SkeletonGroup[] = [];
  const mergedStocks: string[] = [];
  loserTasks.forEach((t, i) => {
    const retreat = t.stageSignals?.retreatSignal === true;
    if (isCatchAll(t) || (!topIdx.has(i) && !retreat)) {
      mergedStocks.push(...t.stocks);
      return;
    }
    losers.push({
      category: t.category,
      stocks: t.stocks,
      ...pickStory(t, resultBy.get(key("loser", t.category))),
      ...(retreat ? { retreatSignal: true } : {}),
      signals: t.stageSignals,
    });
  });
  if (mergedStocks.length) {
    // 其他弱勢的 story 必須是空字串，不補原因、註解或風險提示
    losers.push({
      category: "其他弱勢",
      stocks: mergedStocks,
      story: "",
      storySource: "none",
      needsRewrite: false,
      confidence: "low",
    });
  }

  const out = {
    timestamp: market.timestamp,
    date: market.tradingDate,
    gainers,
    losers,
    summary: "",
    longTermStrategy: "",
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  const missing = tasks.filter((t) => !resultBy.has(key(t.direction, t.category)));
  const rewrite = [...gainers, ...losers].filter((g) => g.needsRewrite);
  console.log(
    `analysis-skeleton.json: ${gainers.length} gainer / ${losers.length} loser groups ` +
      `(${mergedStocks.length} 檔併入其他弱勢), 交易日 ${out.date}`,
  );
  console.log(
    `  stage 已判定 ${gainers.filter((g) => g.stage).length}/${gainers.length}, ` +
      `待改寫 story ${rewrite.length}, 缺 worker result ${missing.length}`,
  );
  if (missing.length) {
    console.log(`  缺 result: ${missing.map((t) => `${t.direction}|${t.category}`).join(", ")}`);
  }
}

main();
