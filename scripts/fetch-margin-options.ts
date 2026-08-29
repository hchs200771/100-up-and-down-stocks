#!/usr/bin/env npx tsx
/**
 * 融資餘額／融資維持率 + 外資臺指選擇權部位。
 *
 * 輸出 data/margin-options-latest.json（當日快照）與 data/margin-history.json
 * （逐日序列，供「市場總覽」的互動圖表疊圖）。跟盤後主流程沒有相依，可以與
 * fetch-intl-market / fetch-credit-spreads / build-index-contribution 同批平行跑。
 *
 * ── 融資維持率是自己算的，不是官方數字 ──────────────────────────
 * 交易所只公布融資「餘額張數」與「餘額金額」，沒有公布整體維持率。
 * 這裡用標準定義自己算：
 *
 *     維持率 = 融資擔保品市值 ÷ 融資金額
 *            = Σ(個股融資餘額張數 × 當日收盤價 × 1000) ÷ 融資餘額金額
 *
 * 券商公布的「整體維持率」算法相同，但各家的成分（是否含上櫃、是否含處置股）
 * 略有差異，所以數字會有零點幾個百分點的出入，**不要拿去跟券商報價逐位比對**。
 * 看的是趨勢與 166%／140% 這兩條線：低於 166% 融資開始有追繳壓力，130% 是斷頭線。
 *
 * ⚠️ 只算**上市**。上櫃只公布融資餘額張數、不公布融資金額，分母湊不出來，
 * 硬用上市的金額配上櫃的張數會算出假的數字。上櫃張數另外列出當參考。
 *
 * ── 外資選擇權用「未平倉」不是「當日交易」 ────────────────────
 * 當日交易口數含大量價差單與隔日沖，方向性意義弱；未平倉才是「現在押在哪邊」。
 * 選擇權的多空要四個象限一起看，不能只看買方：
 *
 *     看多 = 買進買權（Call 買方） + 賣出賣權（Put 賣方）
 *     看空 = 賣出買權（Call 賣方） + 買進賣權（Put 買方）
 *
 * 賣方是收權利金、賭「不會漲過去／不會跌破」，所以 Put 賣方是偏多而不是偏空。
 * 只看「外資買了多少 Call」會把避險部位讀成看多，這是最常見的誤讀。
 *
 * 用法：
 *   npx tsx scripts/fetch-margin-options.ts              # 抓最新
 *   npx tsx scripts/fetch-margin-options.ts --backfill 60 # 回補近 60 個日曆日的融資序列
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT_LATEST = "data/margin-options-latest.json";
const OUT_HISTORY = "data/margin-history.json";
const TXO = "臺指選擇權";
const FOREIGN = "外資及陸資";

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

export interface MarginSnapshot {
  /** 上市融資餘額（交易單位／張） */
  twseLots: number;
  /** 上市融資餘額金額（億元） */
  twseAmount: number;
  /** 前一交易日的上市融資餘額金額（億元） */
  twsePrevAmount: number;
  /** 上市融資餘額金額日增減（億元） */
  dAmount: number;
  /** 上市融券餘額（張） */
  twseShortLots: number;
  /** 上櫃融資餘額（張）；上櫃不公布金額，只能給張數 */
  tpexLots: number | null;
  /** 自算的上市整體融資維持率（％）。逐檔資料湊不齊時為 null */
  maintenance: number | null;
  /** 維持率計算涵蓋的個股數與擔保品市值（億元），用來判斷數字可不可信 */
  maintenanceCoverage: { stocks: number; collateral: number } | null;
}

export interface OptionSide {
  /** 未平倉口數 */
  lots: number;
  /** 未平倉契約金額（億元） */
  amount: number;
  /** 未平倉口數的日增減 */
  dLots: number;
  /** 未平倉契約金額的日增減（億元） */
  dAmount: number;
}

export interface OptionsSnapshot {
  dataDate: string;
  prevDate: string;
  /** 買權（Call）的買方／賣方 */
  call: { buy: OptionSide; sell: OptionSide };
  /** 賣權（Put）的買方／賣方 */
  put: { buy: OptionSide; sell: OptionSide };
  /** 看多 = Call 買方 + Put 賣方；看空 = Call 賣方 + Put 買方 */
  bull: { lots: number; dLots: number; amount: number; dAmount: number };
  bear: { lots: number; dLots: number; amount: number; dAmount: number };
}

export interface MarginOptionsReport {
  generatedAt: string;
  tradingDate: string;
  margin: MarginSnapshot | null;
  options: OptionsSnapshot | null;
}

export interface MarginHistoryEntry {
  date: string;
  /** 上市融資餘額金額（億元） */
  marginAmount: number | null;
  /** 上市整體融資維持率（％） */
  maintenance: number | null;
}

async function fetchText(url: string, label: string, init?: RequestInit, big5 = false): Promise<string> {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, ...init });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // TAIFEX 的 CSV 是 Big5，直接 res.text() 會整份變亂碼
      const t = big5 ? new TextDecoder("big5").decode(await res.arrayBuffer()) : await res.text();
      if (!t.trim()) throw new Error("empty body");
      return t;
    } catch (e) {
      if (i === 3) throw new Error(`${label} failed: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  return "";
}

/** 民國日期 "115/08/28" → "2026-08-28" */
export function rocToIso(roc: string): string | null {
  const m = roc.trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  return m ? `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}` : null;
}

/** 抓某日上市收盤價（算擔保品市值用） */
async function fetchCloses(yyyymmdd: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const raw = await fetchText(
    `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${yyyymmdd}&type=ALLBUT0999&response=json`,
    "TWSE MI_INDEX",
  ).catch(() => "");
  if (!raw) return out;
  const j = JSON.parse(raw);
  const t = (j.tables ?? []).find((x: any) => Array.isArray(x?.fields) && x.fields[0] === "證券代號");
  for (const r of t?.data ?? []) {
    const code = String(r[0] ?? "").trim();
    const close = num(r[8]);
    if (code && close > 0) out.set(code, close);
  }
  return out;
}

/**
 * 抓某日融資餘額。回傳 null 代表當日沒有資料（假日／尚未落檔）。
 * `withMaintenance=false` 時跳過逐檔與收盤價的抓取，回補歷史時用得上（快很多）。
 */
export async function fetchMargin(yyyymmdd: string, withMaintenance = true): Promise<{ date: string; snap: MarginSnapshot } | null> {
  const raw = await fetchText(
    `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${yyyymmdd}&selectType=${withMaintenance ? "ALL" : "MS"}&response=json`,
    "TWSE MI_MARGN",
  ).catch(() => "");
  if (!raw) return null;
  const j = JSON.parse(raw);
  if (j.stat !== "OK") return null;

  // table 0 = 信用交易統計（三列：融資張數／融券張數／融資金額仟元）
  const stat = (j.tables ?? [])[0];
  const rowOf = (kw: string) => (stat?.data ?? []).find((r: any[]) => String(r[0]).includes(kw));
  const marginLotsRow = rowOf("融資(交易單位)");
  const shortLotsRow = rowOf("融券(交易單位)");
  const marginAmtRow = rowOf("融資金額");
  if (!marginLotsRow || !marginAmtRow) return null;

  const twseLots = num(marginLotsRow[5]);
  const twseShortLots = shortLotsRow ? num(shortLotsRow[5]) : 0;
  // 仟元 → 億元
  const twseAmount = Number((num(marginAmtRow[5]) / 1e5).toFixed(1));
  const twsePrevAmount = Number((num(marginAmtRow[4]) / 1e5).toFixed(1));

  let maintenance: number | null = null;
  let maintenanceCoverage: MarginSnapshot["maintenanceCoverage"] = null;
  if (withMaintenance) {
    // table 1 = 逐檔融資融券彙總；欄位 6 是融資今日餘額（張）
    const per = (j.tables ?? [])[1];
    const closes = await fetchCloses(yyyymmdd);
    if (per?.data?.length && closes.size) {
      let collateral = 0; // 元
      let counted = 0;
      for (const r of per.data) {
        const code = String(r[0] ?? "").trim();
        const lots = num(r[6]);
        const close = closes.get(code);
        if (!close || lots <= 0) continue;
        collateral += lots * close * 1000;
        counted++;
      }
      const amountYuan = num(marginAmtRow[5]) * 1000;
      if (collateral > 0 && amountYuan > 0) {
        maintenance = Number(((collateral / amountYuan) * 100).toFixed(1));
        maintenanceCoverage = { stocks: counted, collateral: Number((collateral / 1e8).toFixed(0)) };
      }
    }
  }

  const iso = rocToIso(String(stat?.title ?? "").match(/(\d{2,3})年(\d{2})月(\d{2})日/)?.slice(1).join("/") ?? "")
    ?? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

  return {
    date: iso,
    snap: {
      twseLots,
      twseAmount,
      twsePrevAmount,
      dAmount: Number((twseAmount - twsePrevAmount).toFixed(1)),
      twseShortLots,
      tpexLots: null,
      maintenance,
      maintenanceCoverage,
    },
  };
}

/** 上櫃只公布逐檔融資餘額張數，加總起來當參考。 */
async function fetchTpexMarginLots(yyyymmdd: string): Promise<number | null> {
  const slashed = `${yyyymmdd.slice(0, 4)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
  const raw = await fetchText(
    `https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${encodeURIComponent(slashed)}&response=json`,
    "TPEx margin",
  ).catch(() => "");
  if (!raw) return null;
  const j = JSON.parse(raw);
  const t = j.tables?.[0];
  const idx = (t?.fields ?? []).indexOf("資餘額");
  if (!t?.data || idx < 0) return null;
  let sum = 0;
  for (const r of t.data) sum += num(r[idx]);
  return sum;
}

/**
 * 抓 TAIFEX「三大法人-選擇權買賣權分計」，取外資的臺指選擇權未平倉。
 *
 * ⚠️ `callsAndPutsDateDown` **只吃單日查詢**：起訖日不同會回一個 alert 的 HTML 頁面
 * 而不是 CSV（實測 08/21~08/28、08/27~08/28 都失敗，08/28~08/28 才成功）。
 * 所以只能從最近日期往回一天一天問，湊到兩個有資料的交易日為止。
 *
 * CSV 是 Big5，欄位：
 *   0 日期 / 1 商品 / 2 買賣權 / 3 身份別 / 4,5 買方交易口數,金額 / 6,7 賣方交易口數,金額
 *   / 8,9 交易淨額 / 10,11 買方未平倉口數,金額 / 12,13 賣方未平倉口數,金額 / 14,15 未平倉淨額
 */
type OptCell = { buyLots: number; buyAmt: number; sellLots: number; sellAmt: number };

async function fetchOptionDay(ymd: string): Promise<{ date: string; CALL: OptCell; PUT: OptCell } | null> {
  const slashed = `${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`;
  const csv = await fetchText(
    "https://www.taifex.com.tw/cht/3/callsAndPutsDateDown",
    "TAIFEX 選擇權買賣權分計",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ down_type: "1", queryStartDate: slashed, queryEndDate: slashed, commodityId: "" }),
    },
    true,
  ).catch(() => "");
  // 查無資料時回的是 HTML 頁而不是 CSV
  if (!csv || csv.trimStart().startsWith("<")) return null;

  const out: any = { date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` };
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const c = line.split(",");
    if (c.length < 14) continue;
    if (c[1].trim() !== TXO || c[3].trim() !== FOREIGN) continue;
    const kind = c[2].trim().toUpperCase();
    if (kind !== "CALL" && kind !== "PUT") continue;
    out[kind] = {
      buyLots: num(c[10]),
      buyAmt: num(c[11]) / 1e5, // 千元 → 億元
      sellLots: num(c[12]),
      sellAmt: num(c[13]) / 1e5,
    };
  }
  return out.CALL && out.PUT ? out : null;
}

async function fetchForeignOptions(endYmd: string): Promise<OptionsSnapshot | null> {
  const end = new Date(
    Date.UTC(+endYmd.slice(0, 4), +endYmd.slice(4, 6) - 1, +endYmd.slice(6, 8)),
  );
  const days: NonNullable<Awaited<ReturnType<typeof fetchOptionDay>>>[] = [];
  for (let k = 0; k < 12 && days.length < 2; k++) {
    const d = new Date(end.getTime() - k * 86400000);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const r = await fetchOptionDay(ymd);
    if (r) days.push(r);
    await new Promise((res) => setTimeout(res, 300));
  }
  if (days.length < 2) return null;
  const [cur, prv] = days; // days[0] 是最新的

  const side = (lots: number, amt: number, pLots: number, pAmt: number): OptionSide => ({
    lots,
    amount: Number(amt.toFixed(1)),
    dLots: lots - pLots,
    dAmount: Number((amt - pAmt).toFixed(1)),
  });

  const call = {
    buy: side(cur.CALL.buyLots, cur.CALL.buyAmt, prv.CALL.buyLots, prv.CALL.buyAmt),
    sell: side(cur.CALL.sellLots, cur.CALL.sellAmt, prv.CALL.sellLots, prv.CALL.sellAmt),
  };
  const put = {
    buy: side(cur.PUT.buyLots, cur.PUT.buyAmt, prv.PUT.buyLots, prv.PUT.buyAmt),
    sell: side(cur.PUT.sellLots, cur.PUT.sellAmt, prv.PUT.sellLots, prv.PUT.sellAmt),
  };

  // 看多 = Call 買方 + Put 賣方；看空 = Call 賣方 + Put 買方（見檔頭說明）
  const agg = (a: OptionSide, b: OptionSide) => ({
    lots: a.lots + b.lots,
    dLots: a.dLots + b.dLots,
    amount: Number((a.amount + b.amount).toFixed(1)),
    dAmount: Number((a.dAmount + b.dAmount).toFixed(1)),
  });

  return { dataDate: cur.date, prevDate: prv.date, call, put, bull: agg(call.buy, put.sell), bear: agg(call.sell, put.buy) };
}

function loadHistory(): MarginHistoryEntry[] {
  const p = resolve(process.cwd(), OUT_HISTORY);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function saveHistory(entries: MarginHistoryEntry[]) {
  const p = resolve(process.cwd(), OUT_HISTORY);
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  entries.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(p, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
}

function upsert(list: MarginHistoryEntry[], e: MarginHistoryEntry): MarginHistoryEntry[] {
  const i = list.findIndex((x) => x.date === e.date);
  if (i >= 0) list[i] = e;
  else list.push(e);
  return list;
}

async function backfill(days: number) {
  const history = loadHistory();
  const have = new Set(history.map((h) => h.date));
  const today = new Date();
  let added = 0;
  for (let k = 0; k < days; k++) {
    const d = new Date(today.getTime() - k * 86400000);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue; // 週末不用試
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    if (have.has(iso)) continue;
    const r = await fetchMargin(ymd, true).catch(() => null);
    if (!r) {
      process.stdout.write(`\r  ${iso} 無資料（假日或尚未落檔）        `);
    } else {
      upsert(history, { date: r.date, marginAmount: r.snap.twseAmount, maintenance: r.snap.maintenance });
      added++;
      process.stdout.write(`\r  ${r.date} 融資 ${r.snap.twseAmount} 億、維持率 ${r.snap.maintenance ?? "—"}%（已補 ${added}）`);
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  saveHistory(history);
  console.log(`\n回補完成，新增 ${added} 天，序列共 ${history.length} 天 → ${OUT_HISTORY}`);
}

async function main() {
  const bfIdx = process.argv.indexOf("--backfill");
  if (bfIdx > 0) {
    await backfill(parseInt(process.argv[bfIdx + 1], 10) || 60);
    return;
  }

  const arg = process.argv.find((a) => /^\d{8}$/.test(a));
  const now = new Date();
  const ymdOf = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  /**
   * MI_MARGN 只回「當天」的資料，假日或收盤前查會回空——不像其他端點會自動退到
   * 上一個交易日。所以要自己往回找，最多 7 天（涵蓋連假）。
   */
  let marginRes: Awaited<ReturnType<typeof fetchMargin>> = null;
  let probed = "";
  for (let k = 0; k < 7; k++) {
    const ymd = arg ?? ymdOf(new Date(now.getTime() - k * 86400000));
    probed = ymd;
    marginRes = await fetchMargin(ymd, true).catch(() => null);
    if (marginRes || arg) break;
  }
  if (!marginRes) console.warn(`[warn] 融資資料抓不到（往回試到 ${probed}）`);

  const options = await fetchForeignOptions(arg ?? ymdOf(now)).catch((e) => {
    console.warn(`[warn] 選擇權資料抓取失敗：${e.message}`);
    return null;
  });

  const margin = marginRes?.snap ?? null;
  const tradingDate = marginRes?.date ?? options?.dataDate ?? "";
  if (margin && marginRes) {
    margin.tpexLots = await fetchTpexMarginLots(marginRes.date.replace(/-/g, "")).catch(() => null);
  }

  if (!margin && !options) {
    console.error("融資與選擇權都抓不到，不寫出檔案");
    process.exit(1);
  }

  const report: MarginOptionsReport = {
    generatedAt: new Date().toISOString(),
    tradingDate,
    margin,
    options,
  };
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeFileSync(resolve(process.cwd(), OUT_LATEST), `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  if (margin && marginRes) {
    saveHistory(upsert(loadHistory(), { date: marginRes.date, marginAmount: margin.twseAmount, maintenance: margin.maintenance }));
  }

  console.log(`交易日 ${tradingDate} → ${OUT_LATEST}`);
  if (margin) {
    console.log(
      `  融資餘額（上市）${margin.twseAmount} 億元（${margin.dAmount >= 0 ? "+" : ""}${margin.dAmount}）、${margin.twseLots.toLocaleString()} 張\n` +
        `  融資維持率 ${margin.maintenance ?? "—"}%（自算，涵蓋 ${margin.maintenanceCoverage?.stocks ?? 0} 檔、擔保品 ${margin.maintenanceCoverage?.collateral ?? 0} 億）\n` +
        `  融券餘額 ${margin.twseShortLots.toLocaleString()} 張、上櫃融資 ${margin.tpexLots?.toLocaleString() ?? "—"} 張`,
    );
  }
  if (options) {
    const f = (s: OptionSide) => `${s.lots.toLocaleString()}口(${s.dLots >= 0 ? "+" : ""}${s.dLots.toLocaleString()}) ${s.amount}億(${s.dAmount >= 0 ? "+" : ""}${s.dAmount})`;
    console.log(
      `  外資臺指選擇權未平倉（${options.prevDate} → ${options.dataDate}）\n` +
        `    Call 買方 ${f(options.call.buy)}\n` +
        `    Call 賣方 ${f(options.call.sell)}\n` +
        `    Put  買方 ${f(options.put.buy)}\n` +
        `    Put  賣方 ${f(options.put.sell)}\n` +
        `    看多合計 ${options.bull.lots.toLocaleString()}口(${options.bull.dLots >= 0 ? "+" : ""}${options.bull.dLots.toLocaleString()})　` +
        `看空合計 ${options.bear.lots.toLocaleString()}口(${options.bear.dLots >= 0 ? "+" : ""}${options.bear.dLots.toLocaleString()})`,
    );
  }
}

main().catch((err) => {
  console.error("fetch-margin-options failed:", err.message);
  process.exit(1);
});
