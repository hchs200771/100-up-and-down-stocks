/** FinMind OHLCV 快取與價量分布停損 CLI。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { twoYearsBefore, validOhlcv, volumeProfileStop, type Ohlcv } from "./lib/volume-profile-stop.ts";

export async function fetchOhlcv(code: string, asOf: string, root = process.cwd()): Promise<Ohlcv[] | null> {
  if (!/^\d{4,6}$/.test(code)) return null;
  const dir = resolve(root, "data/cache/finmind-ohlcv"), path = resolve(dir, `${code}-${asOf}.json`);
  try {
    let json: { data?: Ohlcv[]; status?: number };
    if (existsSync(path)) json = JSON.parse(readFileSync(path, "utf8"));
    else {
      const params = new URLSearchParams({ dataset: "TaiwanStockPrice", data_id: code, start_date: twoYearsBefore(asOf), end_date: asOf });
      const response = await fetch(`https://api.finmindtrade.com/api/v4/data?${params}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      json = await response.json();
    }
    if (json.status !== undefined && json.status !== 200 || !Array.isArray(json.data)) throw new Error("FinMind 回覆無有效資料");
    const rows = validOhlcv(json.data, asOf);
    if (!rows.length) return null;
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify({ data: rows }) + "\n");
    }
    return rows;
  } catch (error) {
    console.warn(`[警告] ${code} OHLCV 讀取失敗：${(error as Error).message}`);
    return null;
  }
}

export function parseArgs(args: string[]) {
  const [code, direction, price, ...flags] = args;
  if (!/^\d{4,6}$/.test(code ?? "") || !["多", "空"].includes(direction) || !Number.isFinite(Number(price)) || Number(price) <= 0) throw new Error("用法：npx tsx scripts/volume-profile-stop.ts <code> <多|空> <參考價> [--date YYYY-MM-DD] [--json]");
  let asOf = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }), json = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--json") json = true;
    else if (flags[i] === "--date") {
      asOf = flags[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? "") || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0, 10) !== asOf) throw new Error("日期須為 YYYY-MM-DD");
    } else throw new Error(`未知參數：${flags[i]}`);
  }
  return { code, direction: direction as "多" | "空", reference: Number(price), asOf, json };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = await fetchOhlcv(options.code, options.asOf);
  const result = rows ? volumeProfileStop({ ...options, rows }) : null;
  if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (!result) throw new Error("無 OHLCV 資料，無法計算價量分布停損");
  const fmt = (value: number | null) => value === null ? "資料不足" : value.toFixed(2);
  const band = (peak: { low: number; high: number } | null) => peak ? `${peak.low}–${peak.high}` : "無";
  console.log(`${options.code} ${options.direction}｜${options.asOf}｜參考價 ${options.reference}｜${result.historyDays} 日｜B=${result.binWidth}｜ATR14=${fmt(result.atr14)}`);
  console.log("價量直方圖（張；箱界 [下界, 上界)）：");
  const max = Math.max(...result.bins.map((b) => b.volume));
  for (const b of [...result.bins].reverse()) console.log(`${String(b.low).padStart(8)}–${String(b.high).padEnd(8)} ${"█".repeat(max > 0 ? Math.round(b.volume / max * 30) : 0)} ${b.volume.toFixed(1)}${options.reference >= b.low && options.reference < b.high ? " ← 參考價" : ""}`);
  console.log(`量峰：${result.peaks.map(band).join("、") || "無"}｜量谷：${result.valleys.map((v) => `${v.low}–${v.high}`).join("、") || "無"}`);
  console.log(`結構量峰 ${band(result.structuralPeak)}｜結構停損 ${result.structuralStop ?? "無"}｜距離 ${fmt(result.structuralDistancePct)}%`);
  console.log(`候選：${result.candidates.map((c) => `${c.kind}${c.date ? ` ${c.date}` : ""} ${c.level} → ${c.stop}（${fmt(c.distancePct)}%）`).join("；") || "無"}`);
  console.log(`最終停損 ${result.stop}｜${result.reason}｜距離 ${fmt(result.distancePct)}%｜ATR 倍數 ${fmt(result.atrMultiple)}｜tooFar=${result.tooFar}｜tooTight=${result.tooTight}`);
  console.log(`${options.direction === "多" ? "上" : "下"}方量峰目標 ${band(result.target)}｜目標價 ${result.targetPrice ?? "無"}｜報酬風險比 ${fmt(result.rewardRiskRatio)}`);
  console.log(result.explanation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
