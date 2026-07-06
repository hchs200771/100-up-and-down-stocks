import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as OpenCC from "opencc-js";
import { loadTaxonomy, normalizeCategory, type Taxonomy } from "./lib/taxonomy.ts";

/**
 * 把 data/tmp/classification.json（族群結構 + summary）與
 * data/tmp/stories/<id>.txt（各 subagent 寫出的族群故事純文字）
 * 合併成 data/analysis-latest.json，供 send-report.ts 使用。
 *
 * 設計目的：族群故事的長文字完全不經過主對話（Opus）的 output，
 * 由 subagent 各自寫檔、本 script 純機械合併，省 token 也省生成時間。
 *
 * classification.json 結構：
 * {
 *   "timestamp": "2026/06/01",
 *   "date": "2026-06-01",
 *   "summary": "...",            // 可選；checkpoint 階段可為空字串或缺省
 *   "gainers": [
 *     {"id":"g01","category":"...","stocks":["名稱(代號)"],"story":""},
 *     ...
 *   ],
 *   "losers": [ ... ]
 * }
 *
 * 每個 group：
 * - 若 data/tmp/stories/<id>.txt 存在且非空 → 用該檔內容當 story（優先）。
 * - 否則沿用 classification.json 裡寫好的 story（通常是 <3 檔族群的一句話判讀，或空字串）。
 */

interface Group {
  id?: string;
  category: string;
  stocks: string[];
  story?: string;
  stage?: string;
  call?: string;
}

interface Classification {
  timestamp: string;
  date: string;
  summary?: string;
  gainers?: Group[];
  losers?: Group[];
}

// 簡轉繁（台灣用語）保險。即使 subagent 不小心寫出簡體或中國用語
// （例：内存→記憶體、服务器→伺服器、双→雙），組裝時一律轉成台灣繁體。
const toTWraw = OpenCC.Converter({ from: "cn", to: "twp" });
// s2twp 會把「台」正規化成「臺」（台積電→臺積電、台半→臺半、台股→臺股），
// 但台股／財經寫作一律用「台」，故轉換後再把「臺」一律還原成「台」，避免公司名被改壞。
const toTW = (s: string): string => toTWraw(s).replace(/臺/g, "台");

const cwd = process.cwd();
const classPath = resolve(cwd, "data/tmp/classification.json");
const timelinePath = resolve(cwd, "data/group-timeline.json");
const taxonomyPath = resolve(cwd, "data/taxonomy.json");
const storiesDir = resolve(cwd, "data/tmp/stories");
const intlMarketPath = resolve(cwd, "data/intl-market-latest.json");
const intlBriefPath = resolve(cwd, "data/tmp/intl-brief.txt");
const playbookPath = resolve(cwd, "data/tmp/playbook.txt");
const outPath = resolve(cwd, "data/analysis-latest.json");

interface IntlIndex {
  key: string;
  name: string;
  region: string;
  close: number;
  change: number;
  pct: number;
}

/**
 * 國際情勢區塊：數字（intl-market-latest.json）+ worker 寫的判讀（intl-brief.txt）。
 * 兩者皆可缺；都缺就不附 intl 欄位，send-report 會自動略過該區塊。
 */
function buildIntl(): { summary: string; indices: IntlIndex[] } | undefined {
  let indices: IntlIndex[] = [];
  if (existsSync(intlMarketPath)) {
    try {
      const raw = JSON.parse(readFileSync(intlMarketPath, "utf8"));
      if (Array.isArray(raw?.indices)) indices = raw.indices as IntlIndex[];
    } catch {
      console.warn("intl-market-latest.json unreadable, skipping intl numbers");
    }
  }
  let summary = "";
  if (existsSync(intlBriefPath)) {
    const txt = readFileSync(intlBriefPath, "utf8").trim();
    if (txt) summary = toTW(txt);
  }
  if (!summary && indices.length === 0) return undefined;
  return { summary, indices };
}

/**
 * 用 group-timeline.json（score-report 產出、asOf 為前一交易日）機械推算今日強勢族群的連續天數標籤。
 * - 昨日 streak > 0（連續至昨日）→ 今日續強 = 連(streak+1)日
 * - 昨日不連續、但近 10 個交易日曾在強勢榜 → 回歸（休息後二波）
 * - 都不是 → 今日新進榜，不標（報告 legend 說明「無標籤＝今日新進榜」）
 */
function buildStreakLookup(reportDate: string): (category: string) => string | undefined {
  if (!existsSync(timelinePath)) return () => undefined;
  let taxonomy: Taxonomy = { categories: [] };
  if (existsSync(taxonomyPath)) {
    try {
      taxonomy = loadTaxonomy(taxonomyPath);
    } catch {
      /* taxonomy unreadable → match raw names */
    }
  }
  try {
    const tl = JSON.parse(readFileSync(timelinePath, "utf8")) as {
      asOf?: string | null;
      tradingDates?: string[];
      categories?: Array<{ canonical: string; strongDates: string[]; streak: number }>;
    };
    // timeline 已含今日快照（重跑情境）時，昨日 streak 要剔除今日再算
    const dates = (tl.tradingDates ?? []).filter((d) => d < reportDate);
    const recentDates = new Set(dates.slice(-10));
    const byCanonical = new Map((tl.categories ?? []).map((c) => [c.canonical, c]));
    return (category: string) => {
      const { canonical } = normalizeCategory(category, taxonomy);
      const entry = byCanonical.get(canonical);
      if (!entry) return undefined;
      const strong = new Set(entry.strongDates);
      let streak = 0;
      for (let i = dates.length - 1; i >= 0; i--) {
        if (strong.has(dates[i])) streak++;
        else break;
      }
      if (streak > 0) return `連${streak + 1}日`;
      if (entry.strongDates.some((d) => recentDates.has(d))) return "回歸";
      return undefined;
    };
  } catch {
    console.warn("group-timeline.json unreadable, skipping streak badges");
    return () => undefined;
  }
}

// stage / call 標籤翻成人話，開頭一句寫進 story，讓評論本文也讀得到
// badge 的意思（badge 只在 HTML 呈現，純文字轉貼時會消失）。
const STAGE_DESC: Record<string, string> = {
  啟動: "行情處於啟動階段",
  擴散: "行情正向族群內擴散",
  高潮: "行情進入高潮段，追價風險升高",
  退潮: "行情已在退潮",
  回歸: "休息數日後重回強勢榜（二波）",
};
const CALL_DESC: Record<string, string> = {
  順勢: "操盤判斷順勢：主流具連續性或法人認養，可加碼續抱",
  觀察: "操盤判斷觀察：今日新進榜或訊號矛盾，先看一天再決定",
  反轉: "操盤判斷反轉：過熱或題材鬆散，不建議追價",
};

/** 例：「已連3日上強勢榜；操盤判斷順勢：…。」story 已提過的標籤不重複。 */
function labelLead(story: string, stage?: string, call?: string): string {
  const parts: string[] = [];
  if (stage && !story.includes(stage)) {
    const m = /^連(\d+)日/.exec(stage);
    if (m) parts.push(`已連${m[1]}日上強勢榜`);
    else if (STAGE_DESC[stage]) parts.push(STAGE_DESC[stage]);
  }
  if (call && !story.includes(call) && CALL_DESC[call]) parts.push(CALL_DESC[call]);
  return parts.length ? `${parts.join("；")}。` : "";
}

function fill(
  groups: Group[] | undefined,
  streakFor?: (category: string) => string | undefined,
): { category: string; stocks: string[]; story: string; stage?: string; call?: string }[] {
  return (groups ?? []).map((g) => {
    let story = typeof g.story === "string" ? g.story : "";
    if (g.id) {
      const file = resolve(storiesDir, `${g.id}.txt`);
      if (existsSync(file)) {
        const txt = readFileSync(file, "utf8").trim();
        if (txt) story = txt;
      }
    }
    // stage 優先用 classification 明確標的；否則用時間軸機械推算（連N日/回歸）
    const stage = g.stage ?? streakFor?.(g.category);
    // story 為空的族群（如「其他弱勢」規則要求空字串）保持空，不硬加標籤句
    if (story) story = labelLead(story, stage, g.call) + story;
    return {
      category: g.category,
      stocks: g.stocks ?? [],
      story: toTW(story),
      // stage/call 穿透到 analysis-latest.json：send-report 渲染 badge，
      // score-report 用 call 打分（byCall 勝率）驗證當日判斷。
      ...(stage ? { stage } : {}),
      ...(g.call ? { call: g.call } : {}),
    };
  });
}

function main() {
  if (!existsSync(classPath)) {
    throw new Error(`classification.json not found: ${classPath}`);
  }
  const cls: Classification = JSON.parse(readFileSync(classPath, "utf8"));
  if (!cls.timestamp || !cls.date) {
    throw new Error("classification.json missing timestamp/date");
  }

  const intl = buildIntl();

  // 操作建議（🎯 操作建議 分頁）：由 finalizer 寫到 data/tmp/playbook.txt，純文字。
  // 檔案不存在或空 → 不附 playbook 欄位，send-report 自動略過該分頁。
  let playbook = "";
  if (existsSync(playbookPath)) {
    const txt = readFileSync(playbookPath, "utf8").trim();
    if (txt) playbook = toTW(txt);
  }

  const streakFor = buildStreakLookup(cls.date);

  const out = {
    timestamp: cls.timestamp,
    date: cls.date,
    gainers: fill(cls.gainers, streakFor),
    losers: fill(cls.losers),
    summary: toTW(typeof cls.summary === "string" ? cls.summary : ""),
    ...(intl ? { intl } : {}),
    ...(playbook ? { playbook } : {}),
  };

  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  const gWithStory = out.gainers.filter((g) => g.story).length;
  const lWithStory = out.losers.filter((g) => g.story).length;
  console.log(
    `Assembled analysis-latest.json: ` +
      `${out.gainers.length} gainer (${gWithStory} with story) / ` +
      `${out.losers.length} loser (${lWithStory} with story) groups, ` +
      `summary ${out.summary ? "set" : "EMPTY"}, ` +
      `intl ${intl ? `${intl.indices.length} idx / brief ${intl.summary ? "set" : "EMPTY"}` : "none"}, ` +
      `playbook ${playbook ? "set" : "none"}`,
  );
}

main();
