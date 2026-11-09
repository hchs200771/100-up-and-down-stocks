/**
 * 單日全市場收盤價（上市 + 上櫃）。
 *
 * data/price-history/ 原本只由 score-report.ts 在「盤後報告有跑的那天」寫入，
 * 所以只要哪天沒跑報告，那個交易日就永久缺一格。實測 2026-06-29~09-04 之間
 * 38 個檔案卻缺了 12 個交易日——下游用 arr.slice(-20) 當「20 根 K 棒」時，
 * 實際橫跨的是約 24 個交易日，MA20 與 20 日報酬全部失真。
 *
 * 這支把抓取獨立出來，讓 backfill-price-history.ts 可以事後補洞，
 * 回測腳本也共用同一份（原本各寫一份）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_DIR = "data/cache";
/** 一天的全市場收盤是固定不變的歷史資料，抓過就不用再抓 */
const cachePath = (root: string, date: string) => resolve(root, CACHE_DIR, `close-${date}.json`);

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, "").replace(/<[^>]*>/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

async function fetchText(url: string, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`${url}: ${(lastErr as Error)?.message}`);
}

/**
 * 某一天的全市場收盤。**非交易日回傳空物件**（呼叫端要自己判斷），
 * 空結果也會寫進快取，避免每次執行都重打一次假日。
 */
export async function closesOn(date: string, root = process.cwd()): Promise<Record<string, number>> {
  mkdirSync(resolve(root, CACHE_DIR), { recursive: true });
  const cache = cachePath(root, date);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf-8"));

  const out: Record<string, number> = {};
  let twN = 0;
  let tpN = 0;
  const slashed = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`;
  const [tw, tp] = await Promise.all([
    fetchText(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=ALLBUT0999&response=json`).catch(() => ""),
    fetchText(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slashed)}&response=json`).catch(() => ""),
  ]);
  if (tw) {
    try {
      const j = JSON.parse(tw);
      const t = (j.tables ?? []).find((x: any) => Array.isArray(x?.fields) && x.fields[0] === "證券代號");
      for (const r of t?.data ?? []) {
        const code = String(r[0] ?? "").trim();
        if (/^\d{4}$/.test(code) && num(r[8]) > 0) { out[code] = num(r[8]); twN++; }
      }
    } catch { /* 假日會回非 JSON，當作沒資料 */ }
  }
  if (tp) {
    try {
      const j = JSON.parse(tp);
      const t = j.tables?.[0] ?? j;
      for (const r of t?.data ?? []) {
        const code = String(r[0] ?? "").trim();
        if (/^\d{4}$/.test(code) && num(r[2]) > 0) { out[code] = num(r[2]); tpN++; }
      }
    } catch { /* 同上 */ }
  }
  // 只快取「完整」的結果：兩邊都有資料（交易日），或兩邊都有回應且都沒資料、日期已過（假日）。
  // 單邊抓失敗或日期還沒到就不寫，否則會永久存成缺上市／假日，之前真的發生過。
  const past = date < new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  if ((twN > 0 && tpN > 0) || (tw && tp && twN === 0 && tpN === 0 && past)) writeFileSync(cache, JSON.stringify(out));
  await new Promise((r) => setTimeout(r, 400));
  return out;
}

/** 收到幾檔以上才算「這天有開盤」 */
export const isTradingDay = (closes: Record<string, number>) => Object.keys(closes).length > 500;

/** Official TWSE ex-rights/dividend references; MI_INDEX marks these days as X. */
export function parseTwt49u(payload: any): { date: string; code: string; reference: number }[] {
  if (!payload?.data?.length) return [];
  const fields: string[] = payload.fields ?? [];
  const index = (name: string) => {
    const i = fields.findIndex(f => String(f).trim() === name);
    if (i < 0) throw new Error(`Missing TWT49U field: ${name}`);
    return i;
  };
  const dateIndex = index("資料日期"), codeIndex = index("股票代號"), refIndex = index("除權息參考價");
  const out: { date: string; code: string; reference: number }[] = [];
  for (const row of payload.data) {
    const match = String(row[dateIndex] ?? "").trim().match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日$/);
    const code = String(row[codeIndex] ?? "").trim();
    const reference = num(row[refIndex]);
    if (!match || !/^\d{4}$/.test(code) || reference <= 0) continue;
    const year = Number(match[1]) + 1911, month = Number(match[2]), day = Number(match[3]);
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.toISOString().slice(0, 10) !== date) continue;
    out.push({ date, code, reference });
  }
  return out;
}

/** One YYYYMMDD range request covers all TWSE ex-rights/dividend events. */
export async function exRightRefs(startYmd: string, endYmd: string) {
  const url = `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${startYmd}&endDate=${endYmd}&response=json`;
  return parseTwt49u(JSON.parse(await fetchText(url)));
}

/** Official TPEx ex-rights/dividend references; dailyQuotes marks changes as 除權/除息. */
export function parseTpexExDaily(payload: any): { date: string; code: string; reference: number }[] {
  const out: { date: string; code: string; reference: number }[] = [];
  for (const table of payload?.tables ?? []) {
    if (!table?.data?.length) continue;
    const fields: string[] = table.fields ?? [];
    const index = (name: string) => {
      const i = fields.findIndex(f => String(f).trim() === name);
      if (i < 0) throw new Error(`Missing TPEx exDailyQ field: ${name}`);
      return i;
    };
    const dateIndex = index("除權息日期"), codeIndex = index("代號"), refIndex = index("除權息參考價");
    for (const row of table.data) {
      const match = String(row[dateIndex] ?? "").trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
      const code = String(row[codeIndex] ?? "").trim();
      const reference = num(row[refIndex]);
      if (!match || !/^\d{4}$/.test(code) || reference <= 0) continue;
      const year = Number(match[1]) + 1911, month = Number(match[2]), day = Number(match[3]);
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (parsed.toISOString().slice(0, 10) !== date) continue;
      out.push({ date, code, reference });
    }
  }
  return out;
}

/** One YYYYMMDD range request covers all TPEx ex-rights/dividend events. */
export async function tpexExRightRefs(startYmd: string, endYmd: string) {
  const slashed = (ymd: string) => encodeURIComponent(`${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`);
  const url = `https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${slashed(startYmd)}&endDate=${slashed(endYmd)}&response=json`;
  return parseTpexExDaily(JSON.parse(await fetchText(url)));
}

/** Parse 平盤參考價 without I/O; field names take precedence over endpoint column order. */
export function parseRefPrices(payload: any, market: "twse" | "tpex"): Record<string, number> {
  const table = market === "twse"
    ? (payload.tables ?? []).find((t: any) => t?.fields?.[0] === "證券代號")
    : payload.tables?.[0] ?? payload;
  if (!table?.data?.length) return {};
  const fields: string[] = table.fields ?? [];
  const index = (names: string[], fallback: number) => {
    if (!fields.length) return fallback;
    const i = fields.findIndex(f => names.includes(String(f).trim()));
    if (i < 0) throw new Error(`Missing ${market} field: ${names.join("/")}`);
    return i;
  };
  const codeIndex = index(["證券代號", "代號"], 0);
  const closeIndex = index(["收盤價", "收盤"], market === "twse" ? 8 : 2);
  const changeIndex = index(["漲跌價差", "漲跌"], market === "twse" ? 10 : 3);
  const signIndex = market === "twse" ? index(["漲跌(+/-)"], 9) : -1;
  const plain = (v: unknown) => String(v ?? "").replace(/<[^>]*>/g, "").replace(/,/g, "").trim();
  const numeric = (s: string) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s);
  const out: Record<string, number> = {};
  for (const row of table.data) {
    const code = plain(row[codeIndex]);
    const close = plain(row[closeIndex]), change = plain(row[changeIndex]);
    if (!/^\d{4}$/.test(code) || !numeric(close) || Number(close) <= 0 || !numeric(change)) continue;
    let signedChange = Number(change);
    if (market === "twse") {
      const sign = plain(row[signIndex]);
      if (/[XＸ]/i.test(sign) || !["+", "-", ""].includes(sign)) continue;
      if (!sign && signedChange !== 0) continue;
      signedChange = (sign === "-" ? -1 : 1) * Math.abs(signedChange);
    }
    const ref = Number((Number(close) - signedChange).toFixed(8));
    if (Number.isFinite(ref) && ref > 0) out[code] = ref;
  }
  return out;
}

/** YYYYMMDD reference prices; incomplete market responses are never cached or returned. */
export async function refPricesOn(date: string, root = process.cwd()): Promise<Record<string, number>> {
  mkdirSync(resolve(root, CACHE_DIR), { recursive: true });
  const cache = resolve(root, CACHE_DIR, `ref-${date}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf-8"));
  const slashed = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`;
  const [tw, tp] = await Promise.all([
    fetchText(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=ALLBUT0999&response=json`),
    fetchText(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slashed)}&response=json`),
  ]);
  const twRefs = parseRefPrices(JSON.parse(tw), "twse");
  const tpRefs = parseRefPrices(JSON.parse(tp), "tpex");
  const twN = Object.keys(twRefs).length, tpN = Object.keys(tpRefs).length;
  const past = date < new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  if ((twN > 0) !== (tpN > 0)) throw new Error(`Incomplete reference prices ${date}: TWSE=${twN}, TPEx=${tpN}`);
  const out = { ...twRefs, ...tpRefs };
  if ((twN > 0 && tpN > 0) || (twN === 0 && tpN === 0 && past)) writeFileSync(cache, JSON.stringify(out));
  await new Promise((r) => setTimeout(r, 400));
  return out;
}
