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
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const FORCE = process.argv.includes("--force");

/** CB 日均量的取樣天數（交易日）。 */
const CB_VOLUME_DAYS = 15;
/** 流動性門檻：現股 20 日均量（張）與 CB 日均量（張）。低於就標為流動性陷阱。 */
const MIN_STOCK_LOTS = 500;
const MIN_CB_UNITS = 50;
/** Yahoo 併發上限，沿用 build-tw-rrg 的經驗值。 */
const FETCH_CONCURRENCY = 6;

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
  const j = await fetchJson(`https://www.tpex.org.tw/www/zh-tw/bond/cbDaily?fileCode=${fileCode}&response=json`);
  // data 列：[民國日期, csv 路徑, (xls 路徑)]
  return (j?.tables?.[0]?.data ?? []).map((r: string[]) => [r[0], r[1]] as [string, string]);
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
    return m ? JSON.parse(readFileSync(path.join(CACHE_DIR, `pledge-${m}.json`), "utf8")) : null;
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

  const today = now.toISOString().slice(0, 10).replace(/-/g, "/");
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
    if (!enriched.some((b) => b.inWindow)) flags.push("不在轉換期");
    if (p.pledgeRatio >= 50) flags.push("設質>50%");
    if (stockPx && s.ma20 && stockPx > s.ma20 && stockPx > main.conversionPrice) flags.push("突破轉換價+MA20");
    return {
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
  });

  // 排序：有新增設質的排最前（張數大→小），其餘用設質比例；被流動性/轉換期排除的沉底
  const dead = (c: Candidate) => c.flags.includes("不在轉換期") || c.flags.includes("CB已轉換>70%");
  candidates.sort((a, b) => {
    if (dead(a) !== dead(b)) return dead(a) ? 1 : -1;
    const an = a.newPledgeLots ?? -1;
    const bn = b.newPledgeLots ?? -1;
    if (an > 0 || bn > 0) return bn - an;
    return b.pledgeRatio - a.pledgeRatio;
  });

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
  const st: State = { lastRunAt: now.toISOString(), isoWeek: week, pledgeMonth: pledge.month, boardDate: board.boardDate };
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
  console.log(`寫出 ${path.relative(ROOT, OUT_FILE)}（${candidates.length} 檔）`);
  printSummary(out);
}

function printSummary(out: any) {
  const rows = (out.candidates as Candidate[]).filter(
    (c) => !c.flags.includes("不在轉換期") && !c.flags.includes("CB已轉換>70%"),
  );
  console.log(`\n設質資料 ${out.pledgeMonth}｜CB 看板 ${out.boardDate}｜月增設質${out.hasMonthOverMonth ? "已可比較" : "＝基線月，暫無"}`);
  console.log("代號   名稱      設質%  月增(張) 現價    vs轉換價  CB溢價%  已轉換%  旗標");
  for (const c of rows.slice(0, 30)) {
    const b = c.bonds.find((x) => x.inWindow) ?? c.bonds[0];
    console.log(
      [
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
