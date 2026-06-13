import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as OpenCC from "opencc-js";

/**
 * 把國際情勢併進 data/analysis-latest.json 的 `intl` 欄位。
 *
 * 為什麼需要這支：自動排程路徑（run-daily-report-claude.sh + group-finalizer.md）
 * 的 finalizer 是「直接寫」analysis-latest.json，不走 assemble-analysis.ts，
 * 所以那條路徑不會自帶 intl。這支在 finalizer 之後跑一次，把
 * data/intl-market-latest.json（數字）+ data/tmp/intl-brief.txt（worker 判讀）
 * deterministic 併進去。idempotent，可重跑。
 *
 * 兩份來源皆可缺：都缺就不動 analysis-latest.json（不寫 intl）。
 */

const cwd = process.cwd();
const analysisPath = resolve(cwd, "data/analysis-latest.json");
const intlMarketPath = resolve(cwd, "data/intl-market-latest.json");
const intlBriefPath = resolve(cwd, "data/tmp/intl-brief.txt");

const toTW = OpenCC.Converter({ from: "cn", to: "twp" });

function main() {
  if (!existsSync(analysisPath)) {
    console.warn("attach-intl: analysis-latest.json not found, skip");
    return;
  }

  let indices: unknown[] = [];
  if (existsSync(intlMarketPath)) {
    try {
      const raw = JSON.parse(readFileSync(intlMarketPath, "utf8"));
      if (Array.isArray(raw?.indices)) indices = raw.indices;
    } catch {
      console.warn("attach-intl: intl-market-latest.json unreadable");
    }
  }

  let summary = "";
  if (existsSync(intlBriefPath)) {
    const txt = readFileSync(intlBriefPath, "utf8").trim();
    if (txt) summary = toTW(txt);
  }

  if (!summary && indices.length === 0) {
    console.log("attach-intl: no intl data (no numbers, no brief), leaving analysis untouched");
    return;
  }

  const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
  analysis.intl = { summary, indices };
  writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  console.log(
    `attach-intl: merged intl into analysis-latest.json (${indices.length} idx, brief ${summary ? "set" : "EMPTY"})`,
  );
}

main();
