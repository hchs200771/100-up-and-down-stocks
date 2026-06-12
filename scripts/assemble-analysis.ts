import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as OpenCC from "opencc-js";

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
const toTW = OpenCC.Converter({ from: "cn", to: "twp" });

const cwd = process.cwd();
const classPath = resolve(cwd, "data/tmp/classification.json");
const storiesDir = resolve(cwd, "data/tmp/stories");
const outPath = resolve(cwd, "data/analysis-latest.json");

function fill(groups: Group[] | undefined): { category: string; stocks: string[]; story: string }[] {
  return (groups ?? []).map((g) => {
    let story = typeof g.story === "string" ? g.story : "";
    if (g.id) {
      const file = resolve(storiesDir, `${g.id}.txt`);
      if (existsSync(file)) {
        const txt = readFileSync(file, "utf8").trim();
        if (txt) story = txt;
      }
    }
    return { category: g.category, stocks: g.stocks ?? [], story: toTW(story) };
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

  const out = {
    timestamp: cls.timestamp,
    date: cls.date,
    gainers: fill(cls.gainers),
    losers: fill(cls.losers),
    summary: toTW(typeof cls.summary === "string" ? cls.summary : ""),
  };

  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  const gWithStory = out.gainers.filter((g) => g.story).length;
  const lWithStory = out.losers.filter((g) => g.story).length;
  console.log(
    `Assembled analysis-latest.json: ` +
      `${out.gainers.length} gainer (${gWithStory} with story) / ` +
      `${out.losers.length} loser (${lWithStory} with story) groups, ` +
      `summary ${out.summary ? "set" : "EMPTY"}`,
  );
}

main();
