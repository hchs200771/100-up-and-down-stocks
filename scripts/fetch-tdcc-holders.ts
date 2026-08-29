#!/usr/bin/env npx tsx
/**
 * 集保大戶持股週快照。
 *
 * TDCC 每週公布一次「集保戶股權分散表」，資料日是週五（遇假日則往前一個交易日），
 * 隔天（週六）才拿得到。這支把當週快照抓下來存成 data/tdcc-history/<YYYYMMDD>.json，
 * 之後 build-tdcc-divergence.ts 靠相鄰兩週的快照算「大戶比例週增減」。
 *
 * 為什麼要自己累積：TDCC 的批次端點**只回傳最新一週**，沒有歷史。逐檔查詢雖然能查
 * 52 週，但一個請求只能拿「一檔 × 一週」，全市場一年要 20 萬次請求，不可行
 * （見 backfill-tdcc-history.ts，只用於限定範圍的回補）。所以歷史只能自己存。
 *
 * 冪等：同一個資料日已經有檔案就直接跳過，不重抓。可以每天排程跑，週六自然會補上新的。
 *
 * 級距定義（TDCC 持股分級，單位：股）：
 *   級 11 = 200,001–400,000     （200–400 張）
 *   級 12 = 400,001–600,000     ┐
 *   級 13 = 600,001–800,000     ├ 400 張以上＝市場俗稱的「大戶」
 *   級 14 = 800,001–1,000,000   │
 *   級 15 = 1,000,001 以上      ┘
 *   級 16 = 差異數調整、級 17 = 合計（都不是持股級距，必須排除）
 *
 * 級 15 要單獨看：它混著外資保管銀行、政府基金、公司派長期持股，變動常常是保管帳戶
 * 移轉而不是「大股東買賣」。台積電 87.51% 的大戶比例裡有 84.75% 全在級 15 就是例子。
 * 所以快照把 400–1000 張（級 12–14）與 1000 張以上（級 15）分開存，兩者訊號品質不同。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const TDCC_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5";
const HISTORY_DIR = "data/tdcc-history";

/** 大戶＝400 張以上。級 12–14 是 400–1000 張，級 15 是 1000 張以上。 */
const MID_LEVELS = new Set(["12", "13", "14"]);
const TOP_LEVEL = "15";

/**
 * 要保留逐級明細的級距（張數區間）。存這些是為了讓下游可以自由切換門檻
 * （≥200 / ≥400 / ≥600 / ≥800 / ≥1000 張），而不是寫死一個「大戶」定義。
 *
 * ⚠️ 級 15 是 TDCC 的最高級距，**沒有更細的 4000 張以上分級**。想看「超大戶」
 * 只能用級 15 的「平均每人持股張數」（股數 ÷ 人數）當代理指標：這個數字大，
 * 代表這一級是少數幾個巨型持有人；小則代表是一群 1000~2000 張的散大戶。
 */
const KEEP_LEVELS = ["11", "12", "13", "14", "15"] as const;
export const LEVEL_LOTS: Record<string, number> = { "11": 200, "12": 400, "13": 600, "14": 800, "15": 1000 };

/** 單一級距：[占比%, 人數, 股數] */
export type LevelTuple = [number, number, number];

export interface HolderSnapshotStock {
  /** 證券名稱 */
  n: string;
  /** 市場別 */
  m: "twse" | "tpex";
  /** 400 張以上總比例（％）＝ mid + top */
  big: number;
  /** 400–1000 張比例（％）——訊號較乾淨的一段 */
  mid: number;
  /** 1000 張以上比例（％）——含外資保管、政府基金，變動未必是買賣 */
  top: number;
  /** 400 張以上的持有人數。真的有人進場，人數會動；只有股數動多半是帳戶移轉。 */
  h: number;
  /** 當日收盤價 */
  c: number;
  /** 當日成交股數 */
  v: number;
  /**
   * 級 11–15 的逐級明細，key 是 TDCC 級別字串。下游靠它組出任意門檻的累計比例，
   * 例如 ≥600 張 = 級 13+14+15。舊快照沒有這個欄位，讀取端要能容忍缺值。
   */
  lv?: Record<string, LevelTuple>;
}

export interface HolderSnapshot {
  dataDate: string; // YYYY-MM-DD
  isoWeek: string; // 2026-W35
  fetchedAt: string;
  coverage: { tdcc: number; priced: number };
  stocks: Record<string, HolderSnapshotStock>;
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, "").replace(/<[^>]*>/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

/** YYYYMMDD → ISO 週別字串，例如 2026-W35。跨年時 ISO 年可能與日曆年不同。 */
export function isoWeekOf(yyyymmdd: string): string {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // ISO：週四決定該週屬於哪一年
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function fetchText(url: string, label: string, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = await res.text();
      if (!t.trim()) throw new Error("empty body");
      return t;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  throw new Error(`${label} failed: ${(lastErr as Error)?.message}`);
}

/** 解析 TDCC CSV，回傳 資料日期 與 code → 各級距彙總。 */
export function parseTdcc(csv: string): {
  dataDate: string;
  byCode: Map<string, { mid: number; top: number; h: number; lv: Record<string, LevelTuple> }>;
} {
  const lines = csv.split(/\r?\n/);
  const byCode = new Map<string, { mid: number; top: number; h: number; lv: Record<string, LevelTuple> }>();
  let dataDate = "";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const [date, rawCode, level, people, shares, pct] = line.split(",");
    if (!date || !/^\d{8}$/.test(date.trim())) continue;
    if (!dataDate) dataDate = date.trim();
    const code = (rawCode ?? "").trim();
    // 只留 4 碼數字代號：排除 ETF（00xxx）、TDR（9xxxx）、興櫃與各種特殊代號
    if (!/^\d{4}$/.test(code)) continue;
    const lv = (level ?? "").trim();
    const isMid = MID_LEVELS.has(lv);
    const isTop = lv === TOP_LEVEL;
    // 級 16（差異數調整）、17（合計）不是持股級距，一定要排除
    if (!isMid && !isTop && !KEEP_LEVELS.includes(lv as any)) continue;
    const cur = byCode.get(code) ?? { mid: 0, top: 0, h: 0, lv: {} };
    const p = num(pct);
    if (KEEP_LEVELS.includes(lv as any)) cur.lv[lv] = [p, num(people), num(shares)];
    if (isMid) {
      cur.mid += p;
      cur.h += num(people);
    } else if (isTop) {
      cur.top += p;
      cur.h += num(people);
    }
    byCode.set(code, cur);
  }
  return { dataDate, byCode };
}

/** 抓指定日期的全市場收盤價與成交量（上市 + 上櫃）。 */
async function fetchPrices(yyyymmdd: string): Promise<Map<string, { name: string; market: "twse" | "tpex"; close: number; vol: number }>> {
  const out = new Map<string, { name: string; market: "twse" | "tpex"; close: number; vol: number }>();
  const slashed = `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;

  const [twseRaw, tpexRaw] = await Promise.all([
    fetchText(
      `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${yyyymmdd}&type=ALLBUT0999&response=json`,
      "TWSE MI_INDEX",
    ).catch((e) => {
      console.warn(`[warn] 上市價格抓取失敗：${e.message}`);
      return "";
    }),
    fetchText(
      `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(slashed)}&response=json`,
      "TPEx dailyQuotes",
    ).catch((e) => {
      console.warn(`[warn] 上櫃價格抓取失敗：${e.message}`);
      return "";
    }),
  ]);

  if (twseRaw) {
    const j = JSON.parse(twseRaw);
    // MI_INDEX 回傳多張表，個股那張以「證券代號」開頭
    const table = (j.tables ?? []).find((t: any) => Array.isArray(t?.fields) && t.fields[0] === "證券代號");
    for (const r of table?.data ?? []) {
      const code = String(r[0] ?? "").trim();
      if (!/^\d{4}$/.test(code)) continue;
      out.set(code, { name: String(r[1] ?? "").trim(), market: "twse", close: num(r[8]), vol: num(r[2]) });
    }
  }

  if (tpexRaw) {
    const j = JSON.parse(tpexRaw);
    const table = j.tables?.[0] ?? j;
    for (const r of table?.data ?? []) {
      const code = String(r[0] ?? "").trim();
      if (!/^\d{4}$/.test(code)) continue; // 上櫃那份混了大量權證（6 碼），必須濾掉
      out.set(code, { name: String(r[1] ?? "").trim(), market: "tpex", close: num(r[2]), vol: num(r[8]) });
    }
  }

  return out;
}

async function main() {
  const force = process.argv.includes("--force");
  const historyDir = resolve(process.cwd(), HISTORY_DIR);
  mkdirSync(historyDir, { recursive: true });

  const existing = existsSync(historyDir)
    ? readdirSync(historyDir).filter((f) => /^\d{8}\.json$/.test(f)).sort()
    : [];

  console.log(`已有快照 ${existing.length} 份${existing.length ? `（${existing[0].slice(0, 8)} ~ ${existing[existing.length - 1].slice(0, 8)}）` : ""}`);

  const csv = await fetchText(TDCC_URL, "TDCC OpenData");
  const { dataDate, byCode } = parseTdcc(csv);
  if (!dataDate) throw new Error("TDCC 回應沒有解析到資料日期");
  if (byCode.size === 0) throw new Error("TDCC 回應沒有解析到任何個股");

  const outPath = resolve(historyDir, `${dataDate}.json`);
  const week = isoWeekOf(dataDate);

  // 冪等：這一週已經存過就不做事。可以每天排程跑，週六新資料出來自然會補上。
  if (existsSync(outPath) && !force) {
    console.log(`資料日 ${dataDate}（${week}）的快照已存在，跳過。加 --force 可強制覆寫。`);
    return;
  }

  const prices = await fetchPrices(dataDate);
  console.log(`TDCC ${byCode.size} 檔 / 當日價格 ${prices.size} 檔（資料日 ${dataDate}）`);

  const stocks: Record<string, HolderSnapshotStock> = {};
  for (const [code, agg] of byCode) {
    const p = prices.get(code);
    if (!p || p.close <= 0) continue; // 沒有當日成交（停牌、下市）就不納入
    const mid = Number(agg.mid.toFixed(2));
    const top = Number(agg.top.toFixed(2));
    stocks[code] = {
      n: p.name,
      m: p.market,
      big: Number((mid + top).toFixed(2)),
      mid,
      top,
      h: agg.h,
      c: p.close,
      v: p.vol,
      lv: agg.lv,
    };
  }

  const snapshot: HolderSnapshot = {
    dataDate: `${dataDate.slice(0, 4)}-${dataDate.slice(4, 6)}-${dataDate.slice(6, 8)}`,
    isoWeek: week,
    fetchedAt: new Date().toISOString(),
    coverage: { tdcc: byCode.size, priced: Object.keys(stocks).length },
    stocks,
  };

  writeFileSync(outPath, `${JSON.stringify(snapshot)}\n`, "utf-8");
  console.log(
    `寫入 ${outPath}\n` +
      `  資料日 ${snapshot.dataDate}（${week}），納入 ${snapshot.coverage.priced} 檔（TDCC ${byCode.size} 檔中有當日收盤價者）`,
  );

  const after = readdirSync(historyDir).filter((f) => /^\d{8}\.json$/.test(f));
  if (after.length < 2) {
    console.log(
      `\n目前只有 ${after.length} 份快照，還算不出「週增減」（需要相鄰兩週）。\n` +
        `下週六 TDCC 更新後再跑一次就有第一份榜；或用 backfill-tdcc-history.ts 回補歷史。`,
    );
  }
}

// 只有直接執行時才跑；被 backfill-tdcc-history.ts import 時不該有副作用。
if (process.argv[1] && /fetch-tdcc-holders\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("fetch-tdcc-holders failed:", err.message);
    process.exit(1);
  });
}
