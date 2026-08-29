#!/usr/bin/env npx tsx
/**
 * 大戶籌碼多視角榜單。
 *
 * 讀 data/tdcc-history/ 相鄰兩週的快照，算各級距持股比例的週增減，對照同期股價與
 * 短線技術位置，產出兩種視角 × 五種門檻的榜單，供「🏦 大戶籌碼」分頁切換。
 *
 * ── 兩種視角 ────────────────────────────────────────────────────
 * 「背離」：大戶增加、但股價還沒反映（週漲跌壓在 -15% ~ +8%）。找還沒發動的。
 * 「同向」：大戶增加、股價也漲、且站上 20 日均線。找籌碼與技術同步、正在走趨勢的。
 *
 * 兩者不是誰優誰劣，是兩個不同的問題。背離勝在賠率、輸在等待成本與「大戶也會看錯」；
 * 同向勝在確認度、輸在追價成本。同一週的兩張榜單常常沒有交集，那是正常的。
 *
 * ── 門檻可切換的理由 ──────────────────────────────────────────
 * 「大戶」沒有唯一定義。400 張以上是市場慣例，但一個 900 張的持有人加碼到 1100 張
 * 會跨級，只看某一級會誤判方向（實測 corr(dMid, dTop) = -0.43）。所以一律用**累計
 * 門檻**：≥200 / ≥400 / ≥600 / ≥800 / ≥1000 張，每個門檻是「該級以上全部加總」，
 * 跨級移動在門檻內部相消，不會製造假訊號。
 *
 * ⚠️ TDCC 最高只到級 15（1000 張以上），**沒有 4000 張分級**。想看「超大戶」只能看
 * 級 15 的「平均每人持股張數」（股數 ÷ 人數）：這個數字變大，代表這一級的持有人
 * 在集中化。輸出裡是 avgTop / dAvgTop。
 *
 * ── 四種假訊號與對應處理 ────────────────────────────────────────
 * 1. 級距跨越 → 用累計門檻，見上。
 * 2. 除權息／現增／可轉債轉換會讓比例變動但不是買賣 → 用「大戶人數」交叉驗證，
 *    比例升但人數不動的標 dilutionRisk，排序降權（不剔除，讓人自己判斷）。
 * 3. 小型股幾百張就能推動比例好幾個百分點 → 流動性門檻 + z-score 標準化，
 *    不用絕對門檻（絕對門檻會讓榜單被小型股洗版）。
 * 4. 快照涵蓋範圍不同（回補的 partial 快照只有數百檔）→ 只比較兩份都有的個股，
 *    並在輸出標明 universe 大小。
 *
 * ⚠️ 這是**觀察名單產生器，不是買賣訊號**。大戶增加不必然領先股價。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HolderSnapshot, HolderSnapshotStock } from "./fetch-tdcc-holders";

const HISTORY_DIR = "data/tdcc-history";
const PRICE_DIR = "data/price-history";
const TOP_N = 20;

/** 流動性門檻：資料日當天成交張數。低於這個數，大戶比例的變動雜訊遠大於訊號。 */
const MIN_LOTS = 500;
/** 股價門檻：雞蛋水餃股的比例變動不具參考性 */
const MIN_PRICE = 8;

/** 「背離」視角的股價區間：已經噴上去的不叫背離，崩掉的多半是基本面出事 */
const DIVERGE_MAX_GAIN = 8;
const DIVERGE_MIN_CHANGE = -15;

/** 可切換的累計門檻（張）→ 對應要加總的 TDCC 級別 */
const CUTOFFS: { key: string; lots: number; label: string; levels: string[] }[] = [
  { key: "200", lots: 200, label: "200 張以上", levels: ["11", "12", "13", "14", "15"] },
  { key: "400", lots: 400, label: "400 張以上", levels: ["12", "13", "14", "15"] },
  { key: "600", lots: 600, label: "600 張以上", levels: ["13", "14", "15"] },
  { key: "800", lots: 800, label: "800 張以上", levels: ["14", "15"] },
  { key: "1000", lots: 1000, label: "1000 張以上", levels: ["15"] },
];

export interface DivergenceRow {
  code: string;
  name: string;
  market: "twse" | "tpex";
  /** 該門檻的累計持股比例（％），本週值 */
  cum: number;
  /** 該門檻累計比例的週增減（百分點）——主訊號 */
  dCum: number;
  /** 該門檻涵蓋級距的持有人數週增減 */
  dHolders: number;
  /** 同期（週）股價漲跌幅（％） */
  pricePct: number;
  /** 近 20 個交易日漲跌幅（％）；資料不足為 null */
  price20: number | null;
  /** 收盤是否站上 20 日均線；資料不足為 null */
  aboveMa20: boolean | null;
  /** 級 15 平均每人持股張數（超大戶集中度代理指標） */
  avgTop: number;
  /** 級 15 平均每人持股張數的週增減 */
  dAvgTop: number;
  /** 各級距比例週增減（百分點），key 是 TDCC 級別 */
  byLevel: Record<string, number>;
  score: number;
  lots: number;
  close: number;
  /** 比例動但人數沒動 → 可能是除權息/現增造成的股數變動，不是買賣 */
  dilutionRisk: boolean;
  /** 連續幾週該門檻比例增加（含本週）；需要 3 份以上快照才算得出來 */
  streak: number;
}

export interface DivergenceReport {
  generatedAt: string;
  curDate: string;
  prevDate: string;
  curWeek: string;
  prevWeek: string;
  universe: number;
  partial: boolean;
  /** 舊快照沒有逐級明細時，只有 400 張門檻可用 */
  hasLevels: boolean;
  filters: { minLots: number; minPrice: number; divergeMaxGain: number; divergeMinChange: number };
  cutoffs: { key: string; lots: number; label: string }[];
  views: {
    key: "diverge" | "converge";
    label: string;
    desc: string;
    /** cutoff key → 榜單 */
    byCutoff: Record<string, DivergenceRow[]>;
  }[];
  /** 預設顯示哪個視角／門檻（Email 版沒有 JS，只呈現這一組） */
  defaults: { view: string; cutoff: string };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[], m: number) =>
  Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)) || 1;

function loadSnapshots(dir: string): (HolderSnapshot & { partial?: boolean })[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{8}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf-8")));
}

/**
 * 從 data/price-history/ 算 20 日漲幅與 20 日均線。
 * 快照只存週五收盤，看不出中間走勢；「同向」視角需要知道「是不是真的在趨勢上」，
 * 光看一週漲跌會把單日跳空誤判成趨勢。資料不足 20 天就回傳 null，不硬算。
 */
function loadTechnicals(curDate: string): Map<string, { ret20: number; ma20: number; close: number }> {
  const out = new Map<string, { ret20: number; ma20: number; close: number }>();
  const dir = resolve(process.cwd(), PRICE_DIR);
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) <= curDate)
    .sort()
    .slice(-20);
  if (files.length < 20) return out;
  const days = files.map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as Record<string, number>);
  const last = days[days.length - 1];
  for (const code of Object.keys(last)) {
    const series = days.map((d) => d[code]).filter((v) => typeof v === "number" && v > 0);
    if (series.length < 20) continue; // 中途才上市或停牌過久的，不給技術指標
    const close = series[series.length - 1];
    out.set(code, {
      close,
      ret20: ((close - series[0]) / series[0]) * 100,
      ma20: mean(series),
    });
  }
  return out;
}

/** 把某個門檻涵蓋的級距加總成 [比例, 人數]。缺逐級明細時退回 big/h。 */
function cumulate(s: HolderSnapshotStock, levels: string[]): [number, number] | null {
  if (!s.lv) return levels.length === 4 && levels[0] === "12" ? [s.big, s.h] : null;
  let pct = 0;
  let people = 0;
  for (const lv of levels) {
    const t = s.lv[lv];
    if (!t) continue;
    pct += t[0];
    people += t[1];
  }
  return [Number(pct.toFixed(2)), people];
}

/** 級 15 平均每人持股張數。人數為 0（沒有千張大戶）時回 0。 */
function avgTopLots(s: HolderSnapshotStock): number {
  const t = s.lv?.["15"];
  if (!t || t[1] <= 0) return 0;
  return Number((t[2] / t[1] / 1000).toFixed(1));
}

function buildRows(
  cur: HolderSnapshot,
  prev: HolderSnapshot,
  older: HolderSnapshot[],
  tech: Map<string, { ret20: number; ma20: number; close: number }>,
  cutoff: (typeof CUTOFFS)[number],
): DivergenceRow[] {
  const rows: DivergenceRow[] = [];
  for (const [code, c] of Object.entries(cur.stocks)) {
    const p = prev.stocks[code];
    if (!p) continue; // 只比兩份都有的（回補快照涵蓋範圍較小）
    const lots = Math.round(c.v / 1000);
    if (lots < MIN_LOTS || c.c < MIN_PRICE || p.c <= 0) continue;

    const a = cumulate(c, cutoff.levels);
    const b = cumulate(p, cutoff.levels);
    if (!a || !b) continue;

    const dCum = Number((a[0] - b[0]).toFixed(2));
    const dHolders = a[1] - b[1];
    const pricePct = Number((((c.c - p.c) / p.c) * 100).toFixed(2));

    const byLevel: Record<string, number> = {};
    if (c.lv && p.lv) {
      for (const lv of ["11", "12", "13", "14", "15"]) {
        if (c.lv[lv] && p.lv[lv]) byLevel[lv] = Number((c.lv[lv][0] - p.lv[lv][0]).toFixed(2));
      }
    }

    // 比例增加但人數沒增加 → 較可能是股數變動（除權息、現增、可轉債轉換）而非買進
    const dilutionRisk = dCum > 0.3 && dHolders <= 0;

    let streak = dCum > 0 ? 1 : 0;
    if (dCum > 0) {
      let ref = p;
      for (const o of older) {
        const q = o.stocks[code];
        if (!q) break;
        const rc = cumulate(ref, cutoff.levels);
        const qc = cumulate(q, cutoff.levels);
        if (rc && qc && rc[0] - qc[0] > 0) {
          streak++;
          ref = q;
        } else break;
      }
    }

    const t = tech.get(code);
    rows.push({
      code,
      name: c.n,
      market: c.m,
      cum: a[0],
      dCum,
      dHolders,
      pricePct,
      price20: t ? Number(t.ret20.toFixed(2)) : null,
      aboveMa20: t ? t.close >= t.ma20 : null,
      avgTop: avgTopLots(c),
      dAvgTop: Number((avgTopLots(c) - avgTopLots(p)).toFixed(1)),
      byLevel,
      score: 0,
      lots,
      close: c.c,
      dilutionRisk,
      streak,
    });
  }
  return rows;
}

/** 背離：大戶增加、股價還沒反映。 */
function rankDiverge(all: DivergenceRow[]): DivergenceRow[] {
  // 硬條件放在 z-score 之前，避免極端值把標準差撐大、壓縮真正候選之間的差異
  const pool = all.filter(
    (r) => r.dCum > 0 && r.pricePct <= DIVERGE_MAX_GAIN && r.pricePct >= DIVERGE_MIN_CHANGE,
  );
  if (pool.length === 0) return [];
  const mC = mean(pool.map((r) => r.dCum));
  const sC = std(pool.map((r) => r.dCum), mC);
  const mP = mean(pool.map((r) => r.pricePct));
  const sP = std(pool.map((r) => r.pricePct), mP);
  for (const r of pool) {
    let s = (r.dCum - mC) / sC - ((r.pricePct - mP) / sP) * 0.9;
    if (r.dHolders > 0) s += 0.25; // 真的有新的人進場，不是帳戶移轉
    if (r.dilutionRisk) s -= 0.8;
    if (r.streak >= 2) s += Math.min(0.5, (r.streak - 1) * 0.25);
    r.score = Number(s.toFixed(3));
  }
  return pool.sort((x, y) => y.score - x.score).slice(0, TOP_N);
}

/** 同向：大戶增加、股價也漲、且站上 20 日均線。 */
function rankConverge(all: DivergenceRow[]): DivergenceRow[] {
  // aboveMa20 為 null（技術資料不足）時放行，只靠週漲幅判斷，不因缺資料把個股整個丟掉
  const pool = all.filter((r) => r.dCum > 0 && r.pricePct > 0 && r.aboveMa20 !== false);
  if (pool.length === 0) return [];
  const mC = mean(pool.map((r) => r.dCum));
  const sC = std(pool.map((r) => r.dCum), mC);
  const mP = mean(pool.map((r) => r.pricePct));
  const sP = std(pool.map((r) => r.pricePct), mP);
  for (const r of pool) {
    // 籌碼與價格同權重相加：兩邊都強才排得上來，只有單邊突出的排不到前面
    let s = (r.dCum - mC) / sC + ((r.pricePct - mP) / sP) * 0.7;
    if (r.dHolders > 0) s += 0.25;
    if (r.dilutionRisk) s -= 0.8;
    if (r.streak >= 2) s += Math.min(0.6, (r.streak - 1) * 0.3); // 連續加碼在趨勢單上更值錢
    if (r.aboveMa20 && r.price20 !== null && r.price20 > 0) s += 0.3; // 20 日也是正的＝短中期同步
    r.score = Number(s.toFixed(3));
  }
  return pool.sort((x, y) => y.score - x.score).slice(0, TOP_N);
}

function main() {
  const dir = resolve(process.cwd(), HISTORY_DIR);
  const snaps = loadSnapshots(dir);
  if (snaps.length < 2) {
    console.error(
      `快照只有 ${snaps.length} 份，至少要 2 份才算得出週增減。\n` +
        `  先跑：npx tsx scripts/fetch-tdcc-holders.ts\n` +
        `  或回補：npx tsx scripts/backfill-tdcc-history.ts <YYYYMMDD>`,
    );
    process.exit(1);
  }

  const cur = snaps[snaps.length - 1];
  const prev = snaps[snaps.length - 2];
  const older = snaps.slice(0, -2).reverse();
  const tech = loadTechnicals(cur.dataDate);

  const sampleCur = Object.values(cur.stocks)[0];
  const samplePrev = Object.values(prev.stocks)[0];
  const hasLevels = Boolean(sampleCur?.lv && samplePrev?.lv);
  // 沒有逐級明細的舊快照只能算 400 張門檻（big 欄位就是它）
  const cutoffs = hasLevels ? CUTOFFS : CUTOFFS.filter((c) => c.key === "400");

  const diverge: Record<string, DivergenceRow[]> = {};
  const converge: Record<string, DivergenceRow[]> = {};
  let universe = 0;
  for (const cutoff of cutoffs) {
    const all = buildRows(cur, prev, older, tech, cutoff);
    if (cutoff.key === "400") universe = all.length;
    diverge[cutoff.key] = rankDiverge(all);
    converge[cutoff.key] = rankConverge(all);
  }
  if (universe === 0) {
    console.error("沒有任何個股同時存在於兩份快照且通過門檻，無法產生榜單");
    process.exit(1);
  }

  const report: DivergenceReport = {
    generatedAt: new Date().toISOString(),
    curDate: cur.dataDate,
    prevDate: prev.dataDate,
    curWeek: cur.isoWeek,
    prevWeek: prev.isoWeek,
    universe,
    partial: Boolean((cur as any).partial || (prev as any).partial),
    hasLevels,
    filters: {
      minLots: MIN_LOTS,
      minPrice: MIN_PRICE,
      divergeMaxGain: DIVERGE_MAX_GAIN,
      divergeMinChange: DIVERGE_MIN_CHANGE,
    },
    cutoffs: cutoffs.map(({ key, lots, label }) => ({ key, lots, label })),
    views: [
      {
        key: "diverge",
        label: "背離（還沒發動）",
        desc: `大戶持股增加，但同期股價壓在 ${DIVERGE_MIN_CHANGE}% ~ +${DIVERGE_MAX_GAIN}%——籌碼先動、價格還沒反映。賠率較好，但要等，而且大戶也會看錯。`,
        byCutoff: diverge,
      },
      {
        key: "converge",
        label: "同向（趨勢確認）",
        desc: "大戶持股增加、股價同步上漲、且站上 20 日均線——籌碼與技術面同方向。確認度較高，但已經付出追價成本。",
        byCutoff: converge,
      },
    ],
    defaults: { view: "diverge", cutoff: "400" },
  };

  const outPath = resolve(process.cwd(), "data/tdcc-divergence-latest.json");
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  console.log(
    `大戶籌碼：${prev.dataDate}（${prev.isoWeek}） → ${cur.dataDate}（${cur.isoWeek}）\n` +
      `  比較範圍 ${universe} 檔（兩份快照都有、成交 ≥${MIN_LOTS} 張、股價 ≥${MIN_PRICE} 元）` +
      `${report.partial ? "，⚠️ 含回補的 partial 快照" : ""}\n` +
      `  逐級明細 ${hasLevels ? "有" : "無（只提供 400 張門檻）"}，技術指標涵蓋 ${tech.size} 檔\n` +
      `  門檻：${cutoffs.map((c) => c.label).join("、")}\n` +
      `  寫入 ${outPath}`,
  );
  for (const v of report.views) {
    console.log(`\n  【${v.label}】各門檻檔數：${cutoffs.map((c) => `${c.lots}張 ${v.byCutoff[c.key].length}`).join(" / ")}`);
    for (const r of v.byCutoff["400"].slice(0, 5)) {
      console.log(
        `    ${r.code} ${r.name.padEnd(6, "　")} 大戶${r.dCum >= 0 ? "+" : ""}${r.dCum.toFixed(2)}pp` +
          `  週價${r.pricePct >= 0 ? "+" : ""}${r.pricePct.toFixed(1)}%` +
          `  20日${r.price20 === null ? "—" : (r.price20 >= 0 ? "+" : "") + r.price20.toFixed(1) + "%"}` +
          `  人數${r.dHolders >= 0 ? "+" : ""}${r.dHolders}` +
          `${r.streak >= 2 ? `  連${r.streak}週` : ""}${r.dilutionRisk ? "  ⚠️股數變動" : ""}`,
      );
    }
  }
}

main();
