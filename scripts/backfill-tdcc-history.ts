#!/usr/bin/env npx tsx
/**
 * 集保大戶持股「限定範圍」歷史回補。
 *
 * 為什麼要限定範圍：TDCC 的批次端點只給最新一週，歷史只能走逐檔查詢，而逐檔查詢
 * 一個請求只能拿「一檔 × 一週」。全市場一年 = 4000 × 52 ≈ 20.8 萬次請求，不可行也
 * 不禮貌。所以這支只回補「流動性前 N 檔」，用來讓第一份榜單不必等下週。
 *
 * 用法：
 *   npx tsx scripts/backfill-tdcc-history.ts 20260821            # 預設前 400 檔
 *   npx tsx scripts/backfill-tdcc-history.ts 20260821 --top 200
 *
 * 產出與 fetch-tdcc-holders.ts 相同格式的 data/tdcc-history/<date>.json，但會標記
 * partial=true 與 universe 大小——**回補的快照涵蓋範圍比正規快照小**，下游算排行時
 * 必須知道這件事，否則會把「沒回補到的股票」誤當成「沒有大戶異動」。
 *
 * 可中斷續跑：已抓到的個股會寫進 data/tdcc-history/.partial-<date>.json，重跑會沿用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HolderSnapshot, HolderSnapshotStock, LevelTuple } from "./fetch-tdcc-holders";
import { isoWeekOf } from "./fetch-tdcc-holders";

/** 與 fetch-tdcc-holders 一致：保留級 11–15 的逐級明細，讓下游能自由切換門檻 */
const KEEP_LEVELS = new Set(["11", "12", "13", "14", "15"]);

const FORM_URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock";
const HISTORY_DIR = "data/tdcc-history";
/**
 * 必須串行：SYNCHRONIZER_TOKEN 是一次性的，每次回應會帶一個新 token，下一個請求
 * 得用它。並發會讓多條 worker 互相把對方的 token 作廢（實測 12 檔只成功 1 檔）。
 */
const GAP_MS = 260;

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

interface Session {
  /** 一次性 CSRF token，每次查詢後要換成回應裡的新值 */
  token: string;
  uri: string;
  cookie: string;
}

/** 取得表單的 CSRF token 與 session cookie。TDCC 沒有 token 會直接回表單頁而不是資料。 */
async function openSession(): Promise<Session> {
  const res = await fetch(FORM_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await res.text();
  const token = html.match(/name="SYNCHRONIZER_TOKEN"[^>]*value="([^"]*)"/)?.[1] ?? "";
  const uri = html.match(/name="SYNCHRONIZER_URI"[^>]*value="([^"]*)"/)?.[1] ?? "";
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!token) throw new Error("拿不到 SYNCHRONIZER_TOKEN，TDCC 表單可能改版了");
  return { token, uri, cookie };
}

/**
 * 查單一個股在指定日期的持股分級表。
 * 回傳 400–1000 張（級 12–14）與 1000 張以上（級 15）的比例與人數。
 */
async function queryStock(
  s: Session,
  code: string,
  date: string,
): Promise<{ mid: number; top: number; h: number; lv: Record<string, LevelTuple> } | null> {
  // s.token 會在函式尾端被就地換成回應帶回的新 token（見下方註解）
  const body = new URLSearchParams({
    SYNCHRONIZER_TOKEN: s.token,
    SYNCHRONIZER_URI: s.uri,
    method: "submit",
    sqlMethod: "StockNo",
    stockNo: code,
    stockName: "",
    firDate: date,
    scaDate: date,
  });
  const res = await fetch(FORM_URL, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: FORM_URL,
      ...(s.cookie ? { Cookie: s.cookie } : {}),
    },
    body,
  });
  if (!res.ok) return null;
  const html = await res.text();

  // 換 token：不換的話下一次查詢一定失敗。就地改 session 物件，呼叫端不必管。
  const nextToken = html.match(/name="SYNCHRONIZER_TOKEN"[^>]*value="([^"]*)"/)?.[1];
  if (nextToken) s.token = nextToken;
  const nextUri = html.match(/name="SYNCHRONIZER_URI"[^>]*value="([^"]*)"/)?.[1];
  if (nextUri) s.uri = nextUri;

  // 表格列：級別 / 級距文字 / 人數 / 股數 / 比例
  const rows = [
    ...html.matchAll(
      /<td[^>]*>\s*(\d{1,2})\s*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>([\d,]+)<\/td>\s*<td[^>]*>([\d,]+)<\/td>\s*<td[^>]*>([\d.]+)<\/td>/g,
    ),
  ];
  if (rows.length === 0) return null;

  let mid = 0;
  let top = 0;
  let h = 0;
  const lvMap: Record<string, LevelTuple> = {};
  for (const m of rows) {
    const lv = m[1];
    const people = num(m[2]);
    const shares = num(m[3]);
    const pct = num(m[4]);
    if (KEEP_LEVELS.has(lv)) lvMap[lv] = [pct, people, shares];
    if (lv === "12" || lv === "13" || lv === "14") {
      mid += pct;
      h += people;
    } else if (lv === "15") {
      top += pct;
      h += people;
    }
  }
  // 全 0 代表這檔當週沒資料（新上市、下市），視為查無
  if (mid === 0 && top === 0) return null;
  return { mid, top, h, lv: lvMap };
}

async function fetchPricesFor(yyyymmdd: string) {
  const slashed = `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
  const out = new Map<string, { name: string; market: "twse" | "tpex"; close: number; vol: number }>();
  const get = async (url: string) => {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    return r.ok ? r.text() : "";
  };
  const [a, b] = await Promise.all([
    get(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${yyyymmdd}&type=ALLBUT0999&response=json`).catch(() => ""),
    get(`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slashed)}&response=json`).catch(() => ""),
  ]);
  if (a) {
    const j = JSON.parse(a);
    const t = (j.tables ?? []).find((x: any) => Array.isArray(x?.fields) && x.fields[0] === "證券代號");
    for (const r of t?.data ?? []) {
      const code = String(r[0] ?? "").trim();
      if (/^\d{4}$/.test(code)) out.set(code, { name: String(r[1]).trim(), market: "twse", close: num(r[8]), vol: num(r[2]) });
    }
  }
  if (b) {
    const j = JSON.parse(b);
    const t = j.tables?.[0] ?? j;
    for (const r of t?.data ?? []) {
      const code = String(r[0] ?? "").trim();
      if (/^\d{4}$/.test(code)) out.set(code, { name: String(r[1]).trim(), market: "tpex", close: num(r[2]), vol: num(r[8]) });
    }
  }
  return out;
}

async function main() {
  const date = process.argv[2];
  if (!date || !/^\d{8}$/.test(date)) {
    console.error("用法：npx tsx scripts/backfill-tdcc-history.ts <YYYYMMDD> [--top N]");
    process.exit(1);
  }
  const topIdx = process.argv.indexOf("--top");
  const TOP_N = topIdx > 0 ? parseInt(process.argv[topIdx + 1], 10) || 400 : 400;

  const historyDir = resolve(process.cwd(), HISTORY_DIR);
  mkdirSync(historyDir, { recursive: true });
  const outPath = resolve(historyDir, `${date}.json`);
  if (existsSync(outPath)) {
    console.log(`${date} 快照已存在，不重複回補。要重來請先刪除 ${outPath}`);
    return;
  }

  // universe 取自最新的正規快照：用成交量排序，只回補流動性夠的部分。
  // 小型股用大戶比例做訊號本來雜訊就大，回補它們的邊際效益低。
  const snaps = (await import("node:fs")).readdirSync(historyDir).filter((f) => /^\d{8}\.json$/.test(f)).sort();
  if (snaps.length === 0) {
    console.error("還沒有任何正規快照，請先跑 fetch-tdcc-holders.ts 決定 universe");
    process.exit(1);
  }
  const base: HolderSnapshot = JSON.parse(readFileSync(resolve(historyDir, snaps[snaps.length - 1]), "utf-8"));
  const universe = Object.entries(base.stocks)
    .sort((a, b) => b[1].v - a[1].v)
    .slice(0, TOP_N)
    .map(([code]) => code);

  console.log(`回補 ${date}（${isoWeekOf(date)}）：universe = 流動性前 ${universe.length} 檔（基準快照 ${base.dataDate}）`);

  const partialPath = resolve(historyDir, `.partial-${date}.json`);
  const done: Record<string, { mid: number; top: number; h: number; lv: Record<string, LevelTuple> }> = existsSync(partialPath)
    ? JSON.parse(readFileSync(partialPath, "utf-8"))
    : {};
  if (Object.keys(done).length) console.log(`  沿用上次進度 ${Object.keys(done).length} 檔`);

  const [prices, session] = await Promise.all([fetchPricesFor(date), openSession()]);
  console.log(`  當日價格 ${prices.size} 檔，session 就緒`);

  const todo = universe.filter((c) => !done[c]);
  const total = todo.length;
  let failed = 0;
  let consecutiveFail = 0;

  for (let i = 0; i < todo.length; i++) {
    const code = todo[i];
    try {
      const r = await queryStock(session, code, date);
      if (r) {
        done[code] = r;
        consecutiveFail = 0;
      } else {
        failed++;
        consecutiveFail++;
      }
    } catch {
      failed++;
      consecutiveFail++;
    }
    // 連續失敗多半是 token 鏈斷了（session 逾時、被擋），重開一次比繼續空轉好
    if (consecutiveFail >= 5) {
      const fresh = await openSession();
      session.token = fresh.token;
      session.uri = fresh.uri;
      session.cookie = fresh.cookie;
      consecutiveFail = 0;
      console.log(`\n  [info] 連續失敗，已重開 session`);
    }
    if ((i + 1) % 20 === 0 || i === todo.length - 1) {
      writeFileSync(partialPath, JSON.stringify(done), "utf-8");
      process.stdout.write(`\r  進度 ${i + 1}/${total}（成功 ${Object.keys(done).length}，查無 ${failed}）`);
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  writeFileSync(partialPath, JSON.stringify(done), "utf-8");
  console.log(`\n  查詢完成：成功 ${Object.keys(done).length}，查無 ${failed}`);

  const stocks: Record<string, HolderSnapshotStock> = {};
  for (const [code, agg] of Object.entries(done)) {
    const p = prices.get(code);
    if (!p || p.close <= 0) continue;
    const mid = Number(agg.mid.toFixed(2));
    const top = Number(agg.top.toFixed(2));
    stocks[code] = { n: p.name, m: p.market, big: Number((mid + top).toFixed(2)), mid, top, h: agg.h, c: p.close, v: p.vol, lv: agg.lv };
  }

  const snapshot: HolderSnapshot & { partial: true; universe: number } = {
    dataDate: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    isoWeek: isoWeekOf(date),
    fetchedAt: new Date().toISOString(),
    coverage: { tdcc: Object.keys(done).length, priced: Object.keys(stocks).length },
    stocks,
    partial: true,
    universe: universe.length,
  };
  writeFileSync(outPath, `${JSON.stringify(snapshot)}\n`, "utf-8");
  console.log(`寫入 ${outPath}（partial，涵蓋 ${Object.keys(stocks).length} 檔）`);
}

main().catch((err) => {
  console.error("backfill-tdcc-history failed:", err.message);
  process.exit(1);
});
