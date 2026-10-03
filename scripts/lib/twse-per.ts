/**
 * 單日全市場本益比（PER）。
 *
 * ⚠️ **只有上市（TWSE）拿得到歷史**。TWSE 的 BWIBBU_d 可以指定任意日期回溯，
 * 但 TPEx 只有 openapi 的「最新一天」，沒有歷史端點。所以：
 *   - 回測：只能用上市股票，結論不涵蓋上櫃（約佔全市場一半家數）。
 *   - 每日顯示：上市走 BWIBBU_d、上櫃走 openapi 當日檔，兩邊都拿得到。
 *
 * 本益比為「-」代表虧損或無法計算，一律當作 null，不要當成 0。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_DIR = "data/cache";

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

const num = (v: unknown): number | null => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  if (!t || t === "-" || t === "N/A") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 某一天的上市本益比。非交易日回傳空物件。結果會快取。 */
export async function perOn(date: string, root = process.cwd()): Promise<Record<string, number>> {
  mkdirSync(resolve(root, CACHE_DIR), { recursive: true });
  const cache = resolve(root, CACHE_DIR, `per-${date}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf-8"));

  const out: Record<string, number> = {};
  const raw = await fetchText(
    `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=${date}&selectType=ALL&response=json`,
  ).catch(() => "");
  if (raw) {
    try {
      const j = JSON.parse(raw);
      // 欄序：證券代號 / 證券名稱 / 收盤價 / 殖利率 / 股利年度 / 本益比 / 股價淨值比 / 財報年季
      for (const r of j.data ?? []) {
        const code = String(r[0] ?? "").trim();
        const per = num(r[5]);
        if (/^\d{4}$/.test(code) && per !== null) out[code] = per;
      }
    } catch { /* 假日回非 JSON */ }
  }
  writeFileSync(cache, JSON.stringify(out));
  await new Promise((r) => setTimeout(r, 400));
  return out;
}

/** 上櫃當日本益比（openapi，只有最新一天，沒有歷史）。 */
export async function perTpexLatest(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const raw = await fetchText("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis").catch(() => "");
  if (!raw) return out;
  try {
    for (const r of JSON.parse(raw) as any[]) {
      const code = String(r.SecuritiesCompanyCode ?? "").trim();
      const per = num(r.PriceEarningRatio);
      if (/^\d{4}$/.test(code) && per !== null) out[code] = per;
    }
  } catch { /* 格式變了就當作沒有 */ }
  return out;
}
