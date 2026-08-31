#!/usr/bin/env npx tsx
/**
 * 「董監設質 + CB」公司派作價訊號 screener。
 *
 * 策略邏輯：公司有流通中 CB（動機：拉過轉換價才能套利）+ 董監近期新增設質
 * （壓力：質押維持率不能跌），兩者同時出現時股價易漲抗跌。本工具產出候選池，
 * 進場仍要等量價確認，這裡只做篩選與標註，不做買賣訊號。
 *
 * 資料源（全公開、免金鑰）：
 *   1. 董監持股/設質明細（月頻，MOPS 每月 15 日左右公布上月）
 *      - 上市 https://openapi.twse.com.tw/v1/opendata/t187ap11_L
 *      - 上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap11_O
 *   2. 轉換公司債資訊看板（日頻 CSV，Big5）：現行轉換價格、發行餘額（算已轉換比例）、
 *      轉債參考價格、轉換標的股票價格 —— 一檔全包
 *   3. 每日轉(交)換公司債行情 CSV（Big5）：近 N 日成交單位 → CB 日均量
 *   4. Yahoo Finance：候選股的 MA20 / 20 日均量（只抓進候選池的，不掃全市場）
 *
 * ── 執行週期與冪等 ────────────────────────────────────────────
 * 核心訊號（設質）是月頻，但 CB 價格與現股價位天天動，取每週跑一次的折衷：
 * 同一 ISO 週內重跑，直接印上次結果、不重抓（--force 覆蓋）。
 * 設質月快照存 data/cb-pledge-history/pledge-{年月}.json、永不重抓，
 * 累積兩個月後開始算得出「當月新增設質」；首次執行只能建基線，
 * 新增設質欄位為 null，排序退回用設質比例水位。
 *
 * ── 已知限制 ─────────────────────────────────────────────────
 * - 設質彙總只加總職稱含「本人」的列（含法人董事本身），避免把法人代表人
 *   個人持股跟法人持股重複計；跟官方 t187ap09 彙總表會有小差異，看趨勢用。
 * - 質押維持率推不出精確斷頭價（不知銀行成數與補擔保品），只給設質比例。
 * - 基本面過濾（近 3 季虧損擴大）未做：OpenAPI 只給最新一季，等快照累積。
 *
 * 用法：
 *   npx tsx scripts/screen-cb-pledge.ts          # 每週一次，同週跳過
 *   npx tsx scripts/screen-cb-pledge.ts --force  # 強制重跑
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "data", "cache", "cb-pledge");
/** 設質月快照。OpenAPI 只給最新一月、遺失補不回來，所以放在會進版控的 data/ 而不是 cache。 */
const SNAP_DIR = path.join(ROOT, "data", "cb-pledge-history");
const STATE_FILE = path.join(CACHE_DIR, "state.json");
const OUT_FILE = path.join(ROOT, "data", "cb-pledge-latest.json");
const OUT_HTML = path.join(ROOT, "data", "cb-pledge.html");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const FORCE = process.argv.includes("--force");

/** CB 日均量的取樣天數（交易日）。 */
const CB_VOLUME_DAYS = 15;
/** 流動性門檻：現股 20 日均量（張）與 CB 日均量（張）。低於就標為流動性陷阱。 */
const MIN_STOCK_LOTS = 500;
const MIN_CB_UNITS = 50;
/** Yahoo 併發上限，沿用 build-tw-rrg 的經驗值。 */
const FETCH_CONCURRENCY = 6;

/** 台灣時間的「現在」。TPEx 的「當月」以台灣日期為準，跨午夜時用 UTC 會差一個月。 */
const twNow = () => new Date(Date.now() + 8 * 3600 * 1000);

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** TPEx 的 CSV 是 Big5。Node 的 TextDecoder 需要 full-icu 才認得 big5，抓不到就退回系統 iconv。 */
async function fetchBig5(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return new TextDecoder("big5").decode(buf);
  } catch {
    return execFileSync("iconv", ["-f", "big5", "-t", "utf-8"], { input: buf, maxBuffer: 64 * 1024 * 1024 }).toString();
  }
}

/** 解析 TPEx 報表 CSV 的一行（有引號、引號內含逗號）。 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** 取 TPEx 報表 CSV 裡的 BODY 列。 */
function bodyRows(csv: string): string[][] {
  return csv
    .split(/\r?\n/)
    .filter((l) => l.startsWith("BODY,"))
    .map((l) => splitCsvLine(l.slice(5)));
}

// ── 週期控制 ─────────────────────────────────────────────────

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface State {
  lastRunAt: string;
  isoWeek: string;
  pledgeMonth: string;
  boardDate: string;
}

// ── 1) 董監設質（月頻）─────────────────────────────────────────

interface PledgeCompany {
  code: string;
  name: string;
  market: "twse" | "tpex";
  /** 董監（本人列）目前持股合計，股 */
  holdings: number;
  /** 董監（本人列）設質股數合計，股 */
  pledged: number;
  /** 設質比例 % */
  pledgeRatio: number;
}

async function fetchPledge(): Promise<{ month: string; companies: Record<string, PledgeCompany> }> {
  const [twse, tpex] = await Promise.all([
    fetchJson("https://openapi.twse.com.tw/v1/opendata/t187ap11_L"),
    fetchJson("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap11_O"),
  ]);
  const companies: Record<string, PledgeCompany> = {};
  let month = "";
  const ingest = (rows: any[], market: "twse" | "tpex") => {
    for (const r of rows) {
      const title = String(r["職稱"] ?? "");
      if (!title.includes("本人")) continue; // 避免法人代表人與法人重複計
      const code = String(r["公司代號"] ?? "").trim();
      if (!/^\d{4}$/.test(code)) continue;
      month ||= String(r["資料年月"] ?? "");
      const c = (companies[code] ??= {
        code,
        name: String(r["公司名稱"] ?? "").trim(),
        market,
        holdings: 0,
        pledged: 0,
        pledgeRatio: 0,
      });
      c.holdings += num(r["目前持股"]);
      c.pledged += num(r["設質股數"]);
    }
  };
  ingest(twse, "twse");
  ingest(tpex, "tpex");
  for (const c of Object.values(companies)) {
    c.pledgeRatio = c.holdings > 0 ? +(100 * c.pledged / c.holdings).toFixed(2) : 0;
  }
  return { month, companies };
}

// ── 2) CB 資訊看板 + 行情 ──────────────────────────────────────

interface CbInfo {
  bondCode: string;
  bondName: string;
  stockCode: string;
  /** 現行轉換價格 */
  conversionPrice: number;
  conversionStart: string;
  conversionEnd: string;
  /** 原始發行總額（元） */
  issueAmount: number;
  /** 上月底發行餘額（元） */
  outstanding: number;
  /** 已轉換比例 %（1 - 餘額/發行額） */
  convertedPct: number;
  /** 轉債參考價格 */
  cbPrice: number | null;
  /** 轉換標的股票價格（看板附的） */
  stockPrice: number | null;
  /** 近 N 個交易日的 CB 日均成交單位（張） */
  avgUnits: number | null;
}

async function fetchCbFileList(fileCode: string): Promise<[string, string][]> {
  const get = async (dateParam: string) => {
    const j = await fetchJson(
      `https://www.tpex.org.tw/www/zh-tw/bond/cbDaily?fileCode=${fileCode}${dateParam}&response=json`,
    );
    // data 列：[民國日期, csv 路徑, (xls 路徑)]
    return (j?.tables?.[0]?.data ?? []).map((r: string[]) => [r[0], r[1]] as [string, string]);
  };
  const cur = await get("");
  if (cur.length) return cur;
  // 不帶日期只回「當月」清單（以台灣日期為準）；月初第一個交易日收盤前當月
  // 還沒有檔，清單是空的。帶上個月最後一天（西元 yyyy/mm/dd）補抓上月清單。
  const prev = twNow();
  prev.setUTCDate(0); // 上個月最後一天
  const ym = `${prev.getUTCFullYear()}/${String(prev.getUTCMonth() + 1).padStart(2, "0")}/${String(prev.getUTCDate()).padStart(2, "0")}`;
  return get(`&date=${ym}`);
}

async function fetchCbBoard(): Promise<{ boardDate: string; bonds: CbInfo[] }> {
  const files = await fetchCbFileList("cbdrs001");
  if (!files.length) throw new Error("CB 資訊看板檔案清單是空的");
  const [boardDate, csvPath] = files[0];
  const csv = await fetchBig5(`https://www.tpex.org.tw${csvPath}`);
  const bonds: CbInfo[] = [];
  for (const f of bodyRows(csv)) {
    // HEADER: 債券代碼,債券簡稱,轉換起日,轉換迄日,轉換價格,下次轉換價格生效日期,最近賣回權起日,
    // 最近賣回權迄日,最近賣回權價格,強制贖回起日,強制贖回迄日,強制贖回價格,終止櫃檯買賣日,
    // 原始發行總額,上月底發行餘額,轉債參考價格,轉換標的股票價格,停止交易起日,停止交易迄日,票面利率
    const bondCode = f[0];
    const stockCode = bondCode.slice(0, 4);
    if (!/^\d{4}/.test(bondCode)) continue;
    const issueAmount = num(f[13]);
    const outstanding = num(f[14]);
    const conversionPrice = num(f[4]);
    if (!conversionPrice) continue;
    bonds.push({
      bondCode,
      bondName: f[1],
      stockCode,
      conversionPrice,
      conversionStart: f[2],
      conversionEnd: f[3],
      issueAmount,
      outstanding,
      convertedPct: issueAmount > 0 ? +(100 * (1 - outstanding / issueAmount)).toFixed(1) : 0,
      cbPrice: num(f[15]) || null,
      stockPrice: num(f[16]) || null,
      avgUnits: null,
    });
  }
  return { boardDate, bonds };
}

/** 近 N 個交易日行情表，彙總每檔 CB 的成交單位 → 日均量。等價與議價列都算。 */
async function fetchCbVolumes(): Promise<Record<string, number>> {
  const files = (await fetchCbFileList("rsta0113")).slice(0, CB_VOLUME_DAYS);
  const totals: Record<string, number> = {};
  await mapPool(files, 4, async ([, csvPath]) => {
    let csv: string;
    try {
      csv = await fetchBig5(`https://www.tpex.org.tw${csvPath}`);
    } catch {
      return; // 缺一天就少一天，均量容錯
    }
    let lastCode = "";
    for (const f of bodyRows(csv)) {
      // HEADER: 代號,名稱,交易,收市,漲跌,開市,最高,最低,筆數,單位,金額,均價,...
      if (f[0]) lastCode = f[0]; // 議價列的代號是空的，掛在上一列的債券
      if (!lastCode) continue;
      totals[lastCode] = (totals[lastCode] ?? 0) + num(f[9]);
    }
  });
  const days = Math.max(files.length, 1);
  const avg: Record<string, number> = {};
  for (const [code, t] of Object.entries(totals)) avg[code] = +(t / days).toFixed(1);
  return avg;
}

// ── 3) 候選股的現股量價（Yahoo）───────────────────────────────

interface StockStat {
  close: number | null;
  ma20: number | null;
  /** 20 日均量（張） */
  avgLots: number | null;
}

async function fetchStockStat(code: string, market: "twse" | "tpex"): Promise<StockStat> {
  const ticker = `${code}.${market === "twse" ? "TW" : "TWO"}`;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=3mo&interval=1d`;
    const j = await fetchJson(url);
    const r = j?.chart?.result?.[0];
    const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    const vols: (number | null)[] = r?.indicators?.quote?.[0]?.volume ?? [];
    const c = closes.filter((x): x is number => x != null);
    const v = vols.filter((x): x is number => x != null);
    if (!c.length) return { close: null, ma20: null, avgLots: null };
    const last20c = c.slice(-20);
    const last20v = v.slice(-20);
    return {
      close: +c[c.length - 1].toFixed(2),
      ma20: +(last20c.reduce((a, b) => a + b, 0) / last20c.length).toFixed(2),
      avgLots: last20v.length ? Math.round(last20v.reduce((a, b) => a + b, 0) / last20v.length / 1000) : null,
    };
  } catch {
    return { close: null, ma20: null, avgLots: null };
  }
}

// ── 4) 組合與輸出 ─────────────────────────────────────────────

interface Candidate {
  code: string;
  name: string;
  market: "twse" | "tpex";
  pledgeRatio: number;
  pledgedLots: number;
  /** 相對上月新增設質（張）；沒有上月快照時為 null */
  newPledgeLots: number | null;
  pledgeOver50: boolean;
  bonds: {
    bondCode: string;
    bondName: string;
    conversionPrice: number;
    conversionEnd: string;
    inWindow: boolean;
    convertedPct: number;
    cbPrice: number | null;
    cbAvgUnits: number | null;
    /** CB 溢價率 %：CB價 ÷ 轉換價值 - 1（轉換價值 = 股價/轉換價×100） */
    premiumPct: number | null;
  }[];
  close: number | null;
  ma20: number | null;
  avgLots: number | null;
  /** 現價 ÷ 轉換價 - 1（%），取最主要（餘額最大）一檔 CB */
  vsConversionPct: number | null;
  flags: string[];
  /** 優先度評分 0-100（見 scoreCandidate 的配分） */
  score: number;
  scoreBreakdown: { position: number; progress: number; pledge: number; tradable: number; bonus: number };
}

/**
 * 優先度評分 0-100：把「先看哪幾檔」的判斷收斂成一個數字。
 *
 *   位置分   0-35  vs轉換價在 -20%~+5% 滿分。**不對稱**：往上每 1% 扣 1 分（漲越多肉越薄），
 *                  往下每 1% 只扣 0.6（價外空間大、但劇本未證實，罰得輕）——同樣條件下
 *                  低於轉換價的排前面，反映「低於轉換價期望報酬較好」的判斷
 *   轉換進度 0-25  已轉換 ≤10% 滿分，往 70% 線性遞減（肉還剩多少）
 *   設質動能 0-25  有月增資料：月增 2000 張以上滿分、線性；解質為負分（拿回籌碼＝警訊）
 *                  基線月退回用設質比例水位：50% 滿分封頂（再高不加，斷頭風險也在升）
 *   可執行性 0-15  現股均量 ≥500 張給 10、CB 均量 ≥50 張給 5（買不進的訊號沒有意義）
 *   加分     +5    突破轉換價+MA20（策略一的進場確認已出現）
 *
 * 「轉換期已過」「CB已轉換>70%」直接 0 分沉底——戲演完了，分數再高都不用看。
 */
function scoreCandidate(c: Omit<Candidate, "score" | "scoreBreakdown">): Candidate["scoreBreakdown"] & { total: number } {
  const zero = { position: 0, progress: 0, pledge: 0, tradable: 0, bonus: 0, total: 0 };
  if (c.flags.includes("轉換期已過") || c.flags.includes("CB已轉換>70%")) return zero;

  const v = c.vsConversionPct;
  const position =
    v == null ? 0 : Math.round(Math.max(0, 35 - (v > 5 ? (v - 5) * 1.0 : v < -20 ? (-20 - v) * 0.6 : 0)));

  const conv = c.bonds.find((b) => b.inWindow)?.convertedPct ?? c.bonds[0]?.convertedPct ?? 0;
  const progress = Math.round(Math.max(0, Math.min(25, ((70 - conv) / 60) * 25)));

  let pledgeScore: number;
  if (c.newPledgeLots != null) {
    pledgeScore = c.newPledgeLots >= 0
      ? Math.round(Math.min(25, (c.newPledgeLots / 2000) * 25))
      : Math.max(-10, Math.round((c.newPledgeLots / 2000) * 25)); // 解質＝公司派拿回籌碼，扣分
  } else {
    pledgeScore = Math.round(Math.min(25, (c.pledgeRatio / 50) * 25));
  }

  const tradable =
    (c.avgLots != null && c.avgLots >= MIN_STOCK_LOTS ? 10 : 0) +
    (c.bonds.some((b) => (b.cbAvgUnits ?? 0) >= MIN_CB_UNITS) ? 5 : 0);

  const bonus = c.flags.includes("突破轉換價+MA20") ? 5 : 0;

  let total = Math.max(0, Math.min(100, position + progress + pledgeScore + tradable + bonus));
  // 設質是這個策略的前提之一：幾乎沒設質又沒有月增的，其他分數再高也只是
  // 「有 CB 的普通股票」，封頂在 🟡 以下，避免混進優先名單。
  if (c.pledgeRatio < 5 && !(c.newPledgeLots != null && c.newPledgeLots > 0)) total = Math.min(total, 59);
  return { position, progress, pledge: pledgeScore, tradable, bonus, total };
}

/** 分級：只是讓人一眼挑出該先看哪幾檔，跟報告的評分同一個精神。 */
function tierOf(score: number): string {
  return score >= 75 ? "🔴" : score >= 60 ? "🟠" : score >= 45 ? "🟡" : "⚪";
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const now = new Date();
  const week = isoWeek(now);

  if (!FORCE && existsSync(STATE_FILE) && existsSync(OUT_FILE)) {
    const st: State = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (st.isoWeek === week) {
      const prev = JSON.parse(readFileSync(OUT_FILE, "utf8"));
      console.log(`本週（${week}）已跑過（${st.lastRunAt}，設質資料 ${st.pledgeMonth}、看板 ${st.boardDate}），直接用上次結果；--force 可強制重跑。`);
      writeFileSync(OUT_HTML, renderHtml(prev)); // 樣板改版時不用等下週，重跑就更新網頁
      printSummary(prev);
      return;
    }
  }

  console.log("抓董監設質（上市+上櫃）與 CB 資訊看板…");
  const [pledge, board] = await Promise.all([fetchPledge(), fetchCbBoard()]);
  console.log(`  設質資料年月 ${pledge.month}、${Object.keys(pledge.companies).length} 家；CB 看板 ${board.boardDate}、${board.bonds.length} 檔`);

  // 月快照：同月只寫一次，供之後算「新增設質」
  mkdirSync(SNAP_DIR, { recursive: true });
  const snapFile = path.join(SNAP_DIR, `pledge-${pledge.month}.json`);
  if (!existsSync(snapFile)) writeFileSync(snapFile, JSON.stringify(pledge.companies));
  // 找最近一個「更早」的月快照
  const prevSnap = ((): Record<string, PledgeCompany> | null => {
    const months = readdirSync(SNAP_DIR)
      .map((f: string) => /^pledge-(\d+)\.json$/.exec(f)?.[1])
      .filter((m): m is string => !!m && m < pledge.month)
      .sort();
    const m = months[months.length - 1];
    return m ? JSON.parse(readFileSync(path.join(SNAP_DIR, `pledge-${m}.json`), "utf8")) : null;
  })();
  if (!prevSnap) console.log("  （沒有更早的月快照：本次建立基線，「新增設質」下個月開始才算得出來）");

  console.log(`抓近 ${CB_VOLUME_DAYS} 日 CB 行情算均量…`);
  const cbVol = await fetchCbVolumes();
  for (const b of board.bonds) b.avgUnits = cbVol[b.bondCode] ?? 0;

  // 候選池：有流通 CB 且查得到董監資料的公司
  const byStock: Record<string, CbInfo[]> = {};
  for (const b of board.bonds) (byStock[b.stockCode] ??= []).push(b);
  const pool = Object.entries(byStock).flatMap(([code, bonds]) => {
    const p = pledge.companies[code];
    return p ? [{ p, bonds }] : [];
  });
  console.log(`候選池 ${pool.length} 家，抓現股量價…`);

  const today = twNow().toISOString().slice(0, 10).replace(/-/g, "/");
  const stats = await mapPool(pool, FETCH_CONCURRENCY, ({ p }) => fetchStockStat(p.code, p.market));

  const candidates: Candidate[] = pool.map(({ p, bonds }, i) => {
    const s = stats[i];
    const prev = prevSnap?.[p.code];
    const newPledgeLots = prev ? Math.round((p.pledged - prev.pledged) / 1000) : null;
    const enriched = bonds.map((b) => {
      const stockPx = s.close ?? b.stockPrice;
      const inWindow = b.conversionStart <= today && today <= b.conversionEnd;
      const parity = stockPx && b.conversionPrice ? (stockPx / b.conversionPrice) * 100 : null;
      return {
        bondCode: b.bondCode,
        bondName: b.bondName,
        conversionPrice: b.conversionPrice,
        conversionEnd: b.conversionEnd,
        inWindow,
        convertedPct: b.convertedPct,
        cbPrice: b.cbPrice,
        cbAvgUnits: b.avgUnits,
        premiumPct: b.cbPrice && parity ? +((b.cbPrice / parity - 1) * 100).toFixed(1) : null,
      };
    });
    // 主 CB＝餘額最大那檔
    const main = bonds.reduce((a, b) => (b.outstanding > a.outstanding ? b : a), bonds[0]);
    const stockPx = s.close ?? main.stockPrice;
    const flags: string[] = [];
    if (s.avgLots != null && s.avgLots < MIN_STOCK_LOTS) flags.push("現股量低");
    if (enriched.every((b) => (b.cbAvgUnits ?? 0) < MIN_CB_UNITS)) flags.push("CB量低");
    if (enriched.every((b) => b.convertedPct > 70)) flags.push("CB已轉換>70%");
    // 轉換期「已結束」才是死訊號；「未開始」＝CB 剛發行、常是公司派吃貨階段，特別標出來
    if (bonds.every((b) => b.conversionEnd < today)) flags.push("轉換期已過");
    else if (!enriched.some((b) => b.inWindow)) flags.push("轉換期未開始");
    if (p.pledgeRatio >= 50) flags.push("設質>50%");
    else if (p.pledgeRatio < 5) flags.push("設質近零");
    if (stockPx && s.ma20 && stockPx > s.ma20 && stockPx > main.conversionPrice) flags.push("突破轉換價+MA20");
    const base = {
      code: p.code,
      name: p.name,
      market: p.market,
      pledgeRatio: p.pledgeRatio,
      pledgedLots: Math.round(p.pledged / 1000),
      newPledgeLots,
      pledgeOver50: p.pledgeRatio >= 50,
      bonds: enriched,
      close: s.close,
      ma20: s.ma20,
      avgLots: s.avgLots,
      vsConversionPct: stockPx && main.conversionPrice ? +((stockPx / main.conversionPrice - 1) * 100).toFixed(1) : null,
      flags,
    };
    const { total, ...breakdown } = scoreCandidate(base);
    return { ...base, score: total, scoreBreakdown: breakdown };
  });

  // 排序：優先度評分高→低；同分用設質比例。死訊號的（已過期/已轉換>70%）分數是 0，自然沉底。
  candidates.sort((a, b) => b.score - a.score || b.pledgeRatio - a.pledgeRatio);

  const out = {
    generatedAt: now.toISOString(),
    isoWeek: week,
    pledgeMonth: pledge.month,
    boardDate: board.boardDate,
    hasMonthOverMonth: !!prevSnap,
    thresholds: { MIN_STOCK_LOTS, MIN_CB_UNITS },
    candidates,
  };
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 1));
  writeFileSync(OUT_HTML, renderHtml(out));
  const st: State = { lastRunAt: now.toISOString(), isoWeek: week, pledgeMonth: pledge.month, boardDate: board.boardDate };
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
  console.log(`寫出 ${path.relative(ROOT, OUT_FILE)} 與 ${path.relative(ROOT, OUT_HTML)}（${candidates.length} 檔）`);
  printSummary(out);
}

/**
 * 自足單頁：可排序、可篩選的候選池表格，發佈到日報網站當子頁 /cb-pledge.html。
 * 資料直接內嵌（~300 檔很小），不打 API、不吃外部資源。
 */
function renderHtml(out: any): string {
  const cands = out.candidates as Candidate[];
  const rows = cands.map((c) => {
    // 展示用的主 CB：優先取轉換期內的，其次第一檔（通常是餘額最大）
    const b = c.bonds.find((x) => x.inWindow) ?? c.bonds[0];
    return {
      code: c.code,
      name: c.name,
      market: c.market,
      score: c.score,
      tier: tierOf(c.score),
      pledgeRatio: c.pledgeRatio,
      newPledgeLots: c.newPledgeLots,
      close: c.close,
      ma20: c.ma20,
      avgLots: c.avgLots,
      vsConv: c.vsConversionPct,
      convPrice: b?.conversionPrice ?? null,
      premium: b?.premiumPct ?? null,
      converted: b?.convertedPct ?? null,
      cbUnits: b?.cbAvgUnits ?? null,
      convEnd: b?.conversionEnd ?? "",
      bondName: b?.bondName ?? "",
      flags: c.flags,
    };
  });
  const note = out.hasMonthOverMonth
    ? ""
    : "<p class='note'>⚠️ 目前是基線月：OpenAPI 只提供最新一個月的設質資料，「月增設質」要等下個月中公布新資料後才算得出來。</p>";
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>董監設質 + CB 候選池</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">🔐</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.note{color:var(--up)}
.filters{display:flex;flex-wrap:wrap;gap:6px 14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}
.filters label{display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:980px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:nth-child(-n+2),td:nth-child(-n+2){text-align:left}
th{position:sticky;top:0;background:var(--card);cursor:pointer;user-select:none;color:var(--muted);font-weight:600}
th .arr{font-size:10px}
tr:hover td{background:color-mix(in srgb,var(--accent) 6%,transparent)}
a{color:var(--accent);text-decoration:none}
.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;margin:1px 2px;font-size:11px;color:var(--muted)}
.chip.hot{color:var(--up)}
.chip.go{color:var(--down)}
.pos{color:var(--up)}.neg{color:var(--down)}
.count{margin:8px 2px;color:var(--muted);font-size:13px}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;font-size:13px;color:var(--muted)}
details.howto summary{cursor:pointer;list-style:none;padding:10px 16px;font-size:14px;font-weight:600;color:var(--fg);user-select:none}
details.howto summary::-webkit-details-marker{display:none}
details.howto summary::before{content:"▸";display:inline-block;margin-right:8px;color:var(--accent);transition:transform .15s}
details.howto[open] summary::before{transform:rotate(90deg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto h4{margin:12px 0 4px;font-size:13px;color:var(--fg)}
details.howto ul{margin:4px 0;padding-left:18px}
details.howto li{margin:3px 0}
details.howto b{color:var(--fg)}
</style>
</head>
<body><div class="wrap">
<h1>🔐 董監設質 + CB 候選池</h1>
<p class="sub">設質資料年月 ${out.pledgeMonth}（民國）｜CB 看板 ${out.boardDate}｜產生於 ${String(out.generatedAt).slice(0, 16).replace("T", " ")} UTC｜每週更新</p>
${note}
<details class="howto">
<summary>📖 本頁說明與選股邏輯（點開）</summary>
<div class="body">
<h4>這個池子在找什麼</h4>
<p>公司派同時滿足兩個條件：<b>有流通中 CB</b>（動機——股價拉過轉換價、撐上轉換價 130% 觸發強制贖回，CB 才能全數轉換出貨）＋<b>董監設質</b>（壓力——質押維持率不能跌，跌到斷頭線反而要護盤）。兩者同時出現時，股價易漲抗跌的機率較高。</p>
<h4>評分怎麼算（0-100）</h4>
<p>🔴 ≥75 優先看｜🟠 60-74｜🟡 45-59｜⚪ &lt;45</p>
<ul>
<li><b>位置分 0-35</b>：vs轉換價在 <b>-20%~+5% 滿分</b>。不對稱設計：往上每 1% 扣 1 分（漲越多肉越薄），往下每 1% 只扣 0.6 分（價外空間大、但劇本未證實）——同條件下低於轉換價的排前面。</li>
<li><b>轉換進度 0-25</b>：已轉換 ≤10% 滿分、往 70% 線性遞減。已轉換越多，公司派出貨越接近完成。</li>
<li><b>設質動能 0-25</b>：有月增資料時用當月新增設質張數（2000 張滿分；<b>解質倒扣</b>——拿回籌碼是警訊）；基線月先用設質比例水位（50% 封頂）。</li>
<li><b>可執行性 0-15</b>：現股 20 日均量 ≥500 張給 10、CB 日均量 ≥50 張給 5。買不進出不掉的訊號沒有意義。</li>
<li><b>加分 +5</b>：突破轉換價＋站上 MA20（策略的進場確認訊號已出現）。</li>
</ul>
<p>「轉換期已過」或「已轉換&gt;70%」直接 0 分沉底——戲演完了。「設質近零」（&lt;5% 且無月增）封頂 59 分——沒設質就不構成這個策略。</p>
<h4>欄位怎麼讀</h4>
<ul>
<li><b>vs轉換價</b>：負＝還在轉換價下（空間大、待證實），正＝已站上（劇本執行中）。終點參考：轉換價 × 1.3 的強贖線。</li>
<li><b>CB溢價%</b>：低＝CB 貼著平價走；<b>已轉換%</b>：高＝戲近尾聲。</li>
<li><span class="chip go">突破轉換價+MA20</span>＝量價確認、進場觀察名單；<span class="chip hot">轉換期未開始</span>＝CB 剛發行、常是吃貨階段，先追蹤。</li>
</ul>
<p>此為候選池與優先排序，<b>不是買賣建議</b>；進場仍要等量價確認。資料：設質為月頻（每月中更新上月）、CB 看板日頻、本頁每週更新。</p>
</div>
</details>
<div class="filters">
  <label><input type="checkbox" id="fLiquid" checked> 排除流動性不足（現股&lt;${out.thresholds.MIN_STOCK_LOTS}張 或 CB&lt;${out.thresholds.MIN_CB_UNITS}張）</label>
  <label><input type="checkbox" id="fWindow"> 只看轉換期內</label>
  <label><input type="checkbox" id="fP50"> 只看設質&gt;50%</label>
  <label><input type="checkbox" id="fBreak"> 只看突破轉換價+MA20</label>
  <label><input type="checkbox" id="fAlive" checked> 隱藏已過期/已轉換&gt;70%</label>
</div>
<div class="count" id="count"></div>
<div class="tablebox"><table id="tbl">
<thead><tr>
<th data-k="score">評分</th>
<th data-k="code">代號</th><th data-k="name">名稱</th><th data-k="pledgeRatio">設質%</th><th data-k="newPledgeLots">月增(張)</th>
<th data-k="close">現價</th><th data-k="ma20">MA20</th><th data-k="avgLots">均量(張)</th>
<th data-k="convPrice">轉換價</th><th data-k="vsConv">vs轉換價</th><th data-k="premium">CB溢價%</th>
<th data-k="converted">已轉換%</th><th data-k="cbUnits">CB均量</th><th data-k="convEnd">轉換迄日</th><th>旗標</th>
</tr></thead><tbody></tbody></table></div>
<script>
const ROWS=${JSON.stringify(rows)};
const fmt=(v,suf)=>v==null?"—":v+(suf||"");
const cls=v=>v==null?"":v>0?" class=pos":v<0?" class=neg":"";
let sortK="score",sortDir=-1;
function dead(r){return r.flags.includes("轉換期已過")||r.flags.includes("CB已轉換>70%")}
function render(){
  const f={liquid:fLiquid.checked,win:fWindow.checked,p50:fP50.checked,brk:fBreak.checked,alive:fAlive.checked};
  let rs=ROWS.filter(r=>
    !(f.alive&&dead(r))&&
    !(f.liquid&&(r.flags.includes("現股量低")||r.flags.includes("CB量低")))&&
    !(f.win&&r.flags.includes("轉換期未開始"))&&
    !(f.p50&&!r.flags.includes("設質>50%"))&&
    !(f.brk&&!r.flags.includes("突破轉換價+MA20")));
  rs.sort((a,b)=>{const x=a[sortK],y=b[sortK];
    if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1;
    return(x<y?-1:x>y?1:0)*sortDir});
  document.querySelector("#tbl tbody").innerHTML=rs.map(r=>{
    const url="https://tw.stock.yahoo.com/quote/"+r.code+(r.market==="twse"?".TW":".TWO");
    const chips=r.flags.map(fl=>{
      const c=fl==="突破轉換價+MA20"?"chip go":fl==="轉換期未開始"||fl==="設質>50%"?"chip hot":"chip";
      return '<span class="'+c+'">'+fl+"</span>"}).join("");
    return "<tr><td>"+r.tier+" <b>"+r.score+"</b></td><td><a href='"+url+"' target='_blank'>"+r.code+"</a></td><td>"+r.name+
      "</td><td>"+fmt(r.pledgeRatio)+"</td><td"+cls(r.newPledgeLots)+">"+fmt(r.newPledgeLots)+
      "</td><td>"+fmt(r.close)+"</td><td>"+fmt(r.ma20)+"</td><td>"+fmt(r.avgLots)+
      "</td><td>"+fmt(r.convPrice)+"</td><td"+cls(r.vsConv)+">"+fmt(r.vsConv,"%")+"</td><td>"+fmt(r.premium)+
      "</td><td>"+fmt(r.converted)+"</td><td>"+fmt(r.cbUnits)+"</td><td>"+r.convEnd+"</td><td>"+chips+"</td></tr>"}).join("");
  count.textContent="顯示 "+rs.length+" / "+ROWS.length+" 檔";
  document.querySelectorAll("#tbl th").forEach(th=>{
    const a=th.querySelector(".arr");if(a)a.remove();
    if(th.dataset.k===sortK)th.insertAdjacentHTML("beforeend"," <span class='arr'>"+(sortDir<0?"▼":"▲")+"</span>")});
}
document.querySelectorAll("#tbl th[data-k]").forEach(th=>th.onclick=()=>{
  const k=th.dataset.k;
  if(k===sortK)sortDir*=-1;else{sortK=k;sortDir=-1}
  render()});
document.querySelectorAll(".filters input").forEach(i=>i.onchange=render);
render();
</script>
</div></body></html>`;
}

function printSummary(out: any) {
  const rows = (out.candidates as Candidate[]).filter(
    (c) => !c.flags.includes("轉換期已過") && !c.flags.includes("CB已轉換>70%"),
  );
  console.log(`\n設質資料 ${out.pledgeMonth}｜CB 看板 ${out.boardDate}｜月增設質${out.hasMonthOverMonth ? "已可比較" : "＝基線月，暫無"}`);
  console.log("     評分 代號   名稱      設質%  月增(張) 現價    vs轉換價  CB溢價%  已轉換%  旗標");
  for (const c of rows.slice(0, 30)) {
    const b = c.bonds.find((x) => x.inWindow) ?? c.bonds[0];
    console.log(
      [
        `${tierOf(c.score)}${String(c.score).padStart(4)}`,
        c.code.padEnd(6),
        c.name.padEnd(5, "　"),
        String(c.pledgeRatio).padStart(5),
        String(c.newPledgeLots ?? "—").padStart(7),
        String(c.close ?? "—").padStart(7),
        `${c.vsConversionPct ?? "—"}%`.padStart(8),
        `${b?.premiumPct ?? "—"}`.padStart(7),
        `${b?.convertedPct ?? "—"}`.padStart(7),
        " " + c.flags.join(","),
      ].join(" "),
    );
  }
  console.log(`（共 ${rows.length} 檔有效候選，完整資料在 data/cb-pledge-latest.json）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
