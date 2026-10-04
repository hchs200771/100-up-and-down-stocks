import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const intlEventsPath = resolve(cwd, "data/tmp/intl-events.json");
const creditPath = resolve(cwd, "data/credit-spreads-latest.json");
const sectorPath = resolve(cwd, "data/sector-flows-latest.json");

/**
 * worker 產物（intl-brief / intl-events）只在本次有重寫時才可用。Codex 流程沒有國際 worker，
 * data/tmp 裡會留著幾週前 Claude 流程寫的舊檔；沒有這道檢查就會把舊判讀當成今天的發出去。
 * 以本次抓的 intl-market-latest.json 為基準，早於它 12 小時以上就視為過期。
 */
function isFresh(path: string): boolean {
  if (!existsSync(path)) return false;
  if (!existsSync(intlMarketPath)) return true;
  const fresh = statSync(path).mtimeMs >= statSync(intlMarketPath).mtimeMs - 12 * 3600 * 1000;
  if (!fresh) console.warn(`attach-intl: ${path} 過期（早於本次國際數字），略過`);
  return fresh;
}

const toTWPhrase = OpenCC.Converter({ from: "cn", to: "twp" });

/**
 * 簡轉繁 + 中國用語轉台灣用語，最後把「臺」統一回「台」。
 *
 * 為什麼要收尾改回「台」：twp 的異體字表會把落單的「台」轉成「臺」（台股、台積電
 * 這類詞在詞表裡的才會留著），結果同一段話裡「台積電」與「臺廠」並存，跟報告其他
 * 段落的用字也對不起來。專案通篇用「台」，所以最後一律轉回來。
 *
 * 事件的 cat 欄位刻意不走這裡：它是列舉值，twp 會把「數據」改寫成「資料」，
 * 一改就對不上渲染端的分類顏色表。
 */
function toTW(text: string): string {
  return toTWPhrase(text).replace(/臺/g, "台");
}

function main() {
  if (!existsSync(analysisPath)) {
    console.warn("attach-intl: analysis-latest.json not found, skip");
    return;
  }

  let indices: unknown[] = [];
  let movers: any[] = [];
  if (existsSync(intlMarketPath)) {
    try {
      const raw = JSON.parse(readFileSync(intlMarketPath, "utf8"));
      if (Array.isArray(raw?.indices)) indices = raw.indices;
      if (Array.isArray(raw?.movers)) movers = raw.movers;
    } catch {
      console.warn("attach-intl: intl-market-latest.json unreadable");
    }
  }

  // 信用利差（fetch-credit-spreads.ts）：跟國際數字一起掛在 intl 底下，缺了就不掛。
  let credit: unknown[] = [];
  if (existsSync(creditPath)) {
    try {
      const raw = JSON.parse(readFileSync(creditPath, "utf8"));
      if (Array.isArray(raw?.series)) credit = raw.series;
    } catch {
      console.warn("attach-intl: credit-spreads-latest.json unreadable");
    }
  }

  // 大事時間軸與指標股註解：worker 寫的 JSON。價格數字一律以 intl-market-latest.json
  // 為準，這裡只把 worker 的「為什麼動」用 symbol join 回去，避免 worker 憑印象寫錯價格。
  let events: any[] = [];
  let window = "";
  if (isFresh(intlEventsPath)) {
    try {
      const raw = JSON.parse(readFileSync(intlEventsPath, "utf8"));
      if (Array.isArray(raw?.events)) {
        events = raw.events.map((e: any) => ({
          when: toTW(String(e?.when ?? "")),
          cat: String(e?.cat ?? "").trim(),
          title: toTW(String(e?.title ?? "")),
          impact: toTW(String(e?.impact ?? "")),
          level: toTW(String(e?.level ?? "")),
          chain: toTW(String(e?.chain ?? "")),
        })).filter((e: any) => e.title);
      }
      if (typeof raw?.window === "string") window = toTW(raw.window);
      const notes = new Map<string, any>();
      if (Array.isArray(raw?.moverNotes)) {
        for (const n of raw.moverNotes) {
          if (n?.symbol) notes.set(String(n.symbol).toUpperCase(), n);
        }
      }
      movers = movers.map((m) => {
        const n = notes.get(String(m.symbol).toUpperCase());
        return n ? { ...m, why: toTW(String(n.why ?? "")), tw: toTW(String(n.tw ?? "")) } : m;
      });
    } catch {
      console.warn("attach-intl: intl-events.json unreadable");
    }
  }

  // 美股板塊資金流向（fetch-sector-flows.ts）：純數字，不經 worker，缺了就不掛。
  let sectors: unknown[] = [];
  if (existsSync(sectorPath)) {
    try {
      const raw = JSON.parse(readFileSync(sectorPath, "utf8"));
      if (Array.isArray(raw?.sectors)) sectors = raw.sectors;
    } catch {
      console.warn("attach-intl: sector-flows-latest.json unreadable");
    }
  }

  let summary = "";
  if (isFresh(intlBriefPath)) {
    const txt = readFileSync(intlBriefPath, "utf8").trim();
    if (txt) summary = toTW(txt);
  }

  if (!summary && indices.length === 0 && credit.length === 0 && events.length === 0 && movers.length === 0 && sectors.length === 0) {
    console.log("attach-intl: no intl data (no numbers, no brief), leaving analysis untouched");
    return;
  }

  const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
  analysis.intl = { summary, window, events, indices, credit, movers, sectors };
  writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  console.log(
    `attach-intl: merged intl into analysis-latest.json (${indices.length} idx, ${credit.length} credit, ${events.length} events, ${movers.length} movers, ${sectors.length} sectors, brief ${summary ? "set" : "EMPTY"})`,
  );
}

main();
