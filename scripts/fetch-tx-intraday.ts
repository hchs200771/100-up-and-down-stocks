/**
 * Archive TAIFEX's rolling 30 trading days of TX ticks as Taipei-clock minute bars.
 * File date is the trading date, not the calendar date of the preceding night.
 * Keep opening-auction (*) executions: they are real trades, not indicative quotes.
 * Volume is contracts (成交數量(B+S) / 2). Keep exact closing-time executions in
 * 13:45 / 05:00 bars when present; do not fabricate or forward-fill empty minutes.
 * TAIFEX may publish night-only ZIPs before the day session is available; retry
 * those incomplete dates on the next run instead of freezing the partial archive.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIST_URL = "https://www.taifex.com.tw/cht/3/dlFutPrevious30DaysSalesData";
const ZIP_BASE = "https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/";
const HISTORY = resolve("data/tx-intraday-history");
type Session = "night" | "day";
export interface Bar {
  session: Session;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
interface Metadata { contract: string; dayBars: number; nightBars: number; ticks: number }

// TAIFEX's tick CSV has unquoted scalar fields, with fixed-width space padding.
function* rows(csv: string): Generator<string[]> {
  let start = csv.indexOf("\n") + 1;
  while (start > 0 && start < csv.length) {
    const end = csv.indexOf("\n", start);
    const line = csv.slice(start, end < 0 ? undefined : end).trim();
    if (line) yield line.split(",").map(v => v.trim());
    if (end < 0) break;
    start = end + 1;
  }
}

export function aggregateTxCsv(csv: string): { bars: Bar[]; metadata: Metadata } {
  const header = csv.slice(0, csv.indexOf("\n")).replace(/^\uFEFF/, "").trim().split(",").map(v => v.trim());
  const required = ["成交日期", "商品代號", "到期月份(週別)", "成交時間", "成交價格", "成交數量(B+S)", "近月價格", "遠月價格", "開盤集合競價"];
  if (required.some((v, i) => header[i] !== v)) throw new Error("Unexpected TAIFEX CSV header");
  let contract = "";
  for (const row of rows(csv)) {
    if (row[1] === "TX" && /^\d{6}$/.test(row[2]) && (!contract || row[2] < contract)) contract = row[2];
  }
  if (!contract) throw new Error("No monthly TX contract in CSV");
  const minutes = new Map<number, { bar: Bar; first: number; last: number }>();
  let ticks = 0;
  for (const row of rows(csv)) {
    if (row[1] !== "TX" || row[2] !== contract) continue;
    const [date, , , time, rawPrice, rawVolume] = row;
    if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) throw new Error("Invalid TX date/time");
    const hour = Number(time.slice(0, 2)), minute = Number(time.slice(2, 4)), second = Number(time.slice(4));
    if (hour > 23 || minute > 59 || second > 59) throw new Error(`Invalid TX time ${time}`);
    const seconds = hour * 3600 + minute * 60 + second;
    let session: Session;
    if (seconds >= 15 * 3600 || seconds <= 5 * 3600) session = "night";
    else if (seconds >= 8 * 3600 + 45 * 60 && seconds <= 13 * 3600 + 45 * 60) session = "day";
    else throw new Error(`TX tick outside sessions: ${time}`);
    const price = Number(rawPrice), volume = Number(rawVolume) / 2;
    if (!rawPrice || !rawVolume || !Number.isFinite(price) || price <= 0 || !Number.isFinite(volume) || volume <= 0) throw new Error("Invalid TX price/volume");
    // Night order is 15:00 ... 23:59, 00:00 ... 05:00, followed by day.
    const order = session === "day" ? seconds + 86400 : seconds < 15 * 3600 ? seconds + 86400 : seconds;
    const key = Math.floor(order / 60);
    const item = minutes.get(key);
    if (!item) minutes.set(key, { bar: { session, time: `${time.slice(0, 2)}:${time.slice(2, 4)}`, open: price, high: price, low: price, close: price, volume }, first: order, last: order });
    else {
      item.bar.high = Math.max(item.bar.high, price);
      item.bar.low = Math.min(item.bar.low, price);
      item.bar.volume += volume;
      if (order < item.first) { item.first = order; item.bar.open = price; }
      if (order >= item.last) { item.last = order; item.bar.close = price; }
    }
    ticks++;
  }
  const bars = [...minutes.entries()].sort(([a], [b]) => a - b).map(([, v]) => v.bar);
  if (!bars.length) throw new Error("No TX ticks aggregated");
  return { bars, metadata: { contract, dayBars: bars.filter(b => b.session === "day").length, nightBars: bars.filter(b => b.session === "night").length, ticks } };
}

export function parseAvailableDates(html: string): string[] {
  return [...new Set([...html.matchAll(/DailydownloadCSV\/Daily_(\d{4})_(\d{2})_(\d{2})\.zip/gi)].map(m => `${m[1]}-${m[2]}-${m[3]}`))].sort();
}

async function request(url: string): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(90_000) });
}

async function main() {
  mkdirSync(HISTORY, { recursive: true });
  const indexPath = join(HISTORY, "index.json");
  // Do not replace a corrupt index with an empty one.
  const index: Record<string, Metadata> = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : {};
  let dates: string[] = [], probing = false;
  try {
    const res = await request(LIST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dates = parseAvailableDates(await res.text());
    if (!dates.length) throw new Error("No download dates found");
  } catch (error) {
    console.warn(`[tx-intraday] warn: date list failed (${error}); probing 45 calendar days`);
    probing = true;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
    dates = Array.from({ length: 45 }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - i * 86400_000).toISOString().slice(0, 10)).sort();
  }
  let added = 0, skipped = 0, checked = 0;
  for (const date of dates) {
    const target = join(HISTORY, `${date}.csv`);
    if (existsSync(target) && index[date]?.dayBars !== 0 && !process.argv.includes("--force")) { skipped++; checked++; continue; }
    try {
      const res = await request(`${ZIP_BASE}Daily_${date.replaceAll("-", "_")}.zip`);
      if (probing && res.status === 404) { checked++; continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const zip = Buffer.from(await res.arrayBuffer());
      if (zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error("Response is not a ZIP");
      checked++;
      const temp = mkdtempSync(join(tmpdir(), "tx-intraday-"));
      try {
        const zipPath = join(temp, "ticks.zip");
        writeFileSync(zipPath, zip);
        const csv = execFileSync("unzip", ["-p", zipPath, `Daily_${date.replaceAll("-", "_")}.csv`], { maxBuffer: 512 * 1024 * 1024 });
        const { bars, metadata } = aggregateTxCsv(new TextDecoder("big5", { fatal: true }).decode(csv));
        if (!metadata.dayBars) console.warn(`[tx-intraday] warn: ${date}: night-only source; will retry this incomplete date next run`);
        const content = "session,time,open,high,low,close,volume\n" + bars.map(b => [b.session, b.time, b.open, b.high, b.low, b.close, b.volume].join(",")).join("\n") + "\n";
        // Complete parsing before replacing anything, including on --force.
        const staged = join(HISTORY, `.${date}.tmp`);
        writeFileSync(staged, content);
        renameSync(staged, target);
        index[date] = metadata;
        const stagedIndex = join(HISTORY, ".index.tmp");
        writeFileSync(stagedIndex, JSON.stringify(Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
        renameSync(stagedIndex, indexPath);
        added++;
        console.log(`[tx-intraday] ${date}: ${metadata.contract}, day=${metadata.dayBars}, night=${metadata.nightBars}, ticks=${metadata.ticks}`);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    } catch (error) { console.warn(`[tx-intraday] warn: ${date}: ${error}`); }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  const latest = readdirSync(HISTORY).filter(f => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().at(-1)?.slice(0, 10) ?? "none";
  console.log(`[tx-intraday] dates added=${added}, dates skipped=${skipped}, latest date=${latest}`);
  if (!checked) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`[tx-intraday] ${error}`); process.exitCode = 1; });
}
