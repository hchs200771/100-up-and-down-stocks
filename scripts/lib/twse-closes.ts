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
