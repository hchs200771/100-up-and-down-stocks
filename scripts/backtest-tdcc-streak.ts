#!/usr/bin/env npx tsx
/**
 * 大戶籌碼「連續加碼」的回測——回答「連續兩週增加是不是比只看一週好」。
 *
 * 前提：data/tdcc-history/ 要有連續多週的快照
 *      （npx tsx scripts/backfill-tdcc-history.ts <YYYYMMDD> --top 300 逐週回補）
 *
 * ## 進出場：TDCC 有發布時滯，不能在資料日進場
 *
 * 快照的 dataDate 是週五，但 TDCC 不是當天就放出來——實測 2026-08-28 的資料
 * 隔天（8/29 週六）拿得到，2026-09-04 的資料在 9/07 03:03 還沒有、03:49 才有。
 * 所以**資料日當天的收盤是拿不到的價格**，用它進場等於偷看未來。
 *
 * 這裡一律取「資料日 + ENTRY_LAG_DAYS 天之後的第一個交易日收盤」進場，
 * 持有到下一週的同一個進場日。預設 4 天（週五 → 下週二），比實測的最壞情況
 * （3 天）再多留一天緩衝。
 *
 * ## 分桶
 *
 * 對每個累計門檻（200/400/600/800/1000 張），把當週通過流動性與股價過濾的個股
 * 依「該門檻累計比例的週增減」分桶：
 *
 *   減碼      dCum <= 0        對照組
 *   連1週     dCum > 0 且上週沒增加
 *   連2週     連續兩次公布都增加
 *   連3週以上  連續三次以上
 *
 * 再依兩個視角各自重跑一次：
 *   背離  股價週漲跌壓在 -15% ~ +8%（籌碼先動、價還沒動）
 *   同向  股價上漲且站上 20 日均線（籌碼與技術同步）
 *
 * 兩個視角的**延遲成本完全不同**——同向榜的標的當週常常已經噴 20~35%，多等一週
 * 確認等於追高；背離榜還沒發動，等待成本低。所以一定要分開看，合在一起會互相抵銷。
 *
 * ## 為什麼看配對 t 值不看各桶的 IR
 *
 * 跟 backtest-revenue-streak.ts 同一個理由：IR 的分母是該桶等權組合的波動，桶越大
 * 越分散、IR 越高，量到的是分散程度不是訊號強度。主要結論一律看同一週相減的配對檢定。
 *
 * 用法：
 *   npx tsx scripts/backtest-tdcc-streak.ts
 *   npx tsx scripts/backtest-tdcc-streak.ts --cutoff 400
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HolderSnapshot, HolderSnapshotStock } from "./fetch-tdcc-holders";
import { twIso } from "./lib/time";

const ROOT = process.cwd();
const HISTORY_DIR = "data/tdcc-history";
const PRICE_DIR = "data/price-history";

/** 與 build-tdcc-divergence.ts 對齊，否則回測的母體跟榜單的母體不是同一個 */
const MIN_LOTS = 500;
const MIN_PRICE = 8;
const DIVERGE_MAX_GAIN = 8;
const DIVERGE_MIN_CHANGE = -15;

/** 發布時滯緩衝：資料日（週五）之後幾天才假設拿得到資料 */
const ENTRY_LAG_DAYS = 4;
/** 一個桶當週至少要有幾檔才算數 */
const MIN_BUCKET = 5;

const CUTOFFS = [
  { key: "200", levels: ["11", "12", "13", "14", "15"] },
  { key: "400", levels: ["12", "13", "14", "15"] },
  { key: "600", levels: ["13", "14", "15"] },
  { key: "800", levels: ["14", "15"] },
  { key: "1000", levels: ["15"] },
];

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const F = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

/** 把某個門檻涵蓋的級距加總成比例。缺逐級明細時退回 big（只有 400 張門檻對得上）。 */
function cumulate(s: HolderSnapshotStock, levels: string[]): number | null {
  if (!s.lv) return levels.length === 4 && levels[0] === "12" ? s.big : null;
  let pct = 0;
  for (const lv of levels) {
    const t = s.lv[lv];
    if (t) pct += t[0];
  }
  return pct;
}

/** 逐日收盤：data/price-history/<YYYY-MM-DD>.json → code -> close */
function loadPriceDays(): { date: string; closes: Record<string, number> }[] {
  const dir = resolve(ROOT, PRICE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => ({ date: f.slice(0, 10), closes: JSON.parse(readFileSync(resolve(dir, f), "utf-8")) }));
}

const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 一檔個股在某一週的觀測值 */
interface Obs {
  code: string;
  dCum: number;
  streak: number;
  pricePct: number;
  aboveMa20: boolean | null;
  ret: number;
}

function main() {
  const cutIdx = process.argv.indexOf("--cutoff");
  const only = cutIdx > 0 ? process.argv[cutIdx + 1] : null;

  const dir = resolve(ROOT, HISTORY_DIR);
  const snaps: HolderSnapshot[] = readdirSync(dir)
    .filter((f) => /^\d{8}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf-8")));
  if (snaps.length < 4) {
    console.error(`快照只有 ${snaps.length} 份，至少要 4 份才算得出連續週`);
    process.exit(1);
  }
  const days = loadPriceDays();
  if (!days.length) {
    console.error("data/price-history 是空的");
    process.exit(1);
  }

  /** 資料日 → 進場日索引（資料日 + 緩衝之後的第一個有價格的交易日） */
  const entryIdxOf = (dataDate: string): number => {
    const want = plusDays(dataDate, ENTRY_LAG_DAYS);
    return days.findIndex((d) => d.date >= want);
  };

  /** 20 日均線：用進場日之前（含）的 20 個交易日 */
  const ma20At = (idx: number, code: string): { close: number; ma: number } | null => {
    if (idx < 19) return null;
    const series: number[] = [];
    for (let i = idx - 19; i <= idx; i++) {
      const v = days[i].closes[code];
      if (typeof v !== "number" || !(v > 0)) return null;
      series.push(v);
    }
    return { close: series[series.length - 1], ma: avg(series) };
  };

  const cutoffs = only ? CUTOFFS.filter((c) => c.key === only) : CUTOFFS;
  const results: Record<string, any> = {};

  for (const cut of cutoffs) {
    /** 視角 → 桶 → 逐週報酬 */
    const rets: Record<string, Record<string, number[]>> = {};
    const cnts: Record<string, Record<string, number[]>> = {};
    const BUCKETS = ["減碼", "連1週", "連2週", "連3週以上", "連2週以上", "全部增加"];
    for (const v of ["全部", "背離", "同向"]) {
      rets[v] = {};
      cnts[v] = {};
      for (const b of BUCKETS) {
        rets[v][b] = [];
        cnts[v][b] = [];
      }
    }
    const base: number[] = [];
    const weeks: string[] = [];

    // i 從 1 開始（要有上一週算 dCum），實際還要往前找 streak
    for (let i = 1; i < snaps.length - 1; i++) {
      const cur = snaps[i];
      const prev = snaps[i - 1];
      const eIdx = entryIdxOf(cur.dataDate);
      const xIdx = entryIdxOf(snaps[i + 1].dataDate);
      if (eIdx < 0 || xIdx < 0 || xIdx <= eIdx) continue;

      const obs: Obs[] = [];
      for (const [code, c] of Object.entries(cur.stocks)) {
        const p = prev.stocks[code];
        if (!p) continue;
        const lots = Math.round(c.v / 1000);
        if (lots < MIN_LOTS || c.c < MIN_PRICE || p.c <= 0) continue;
        const a = cumulate(c, cut.levels);
        const b = cumulate(p, cut.levels);
        if (a === null || b === null) continue;

        const entry = days[eIdx].closes[code];
        const exit = days[xIdx].closes[code];
        if (!(entry > 0 && exit > 0)) continue;

        const dCum = Number((a - b).toFixed(2));
        // 連續幾週增加：往回一路比，斷了就停
        let streak = dCum > 0 ? 1 : 0;
        if (dCum > 0) {
          let ref = p;
          for (let k = i - 2; k >= 0; k--) {
            const q = snaps[k].stocks[code];
            if (!q) break;
            const rc = cumulate(ref, cut.levels);
            const qc = cumulate(q, cut.levels);
            if (rc !== null && qc !== null && rc - qc > 0) {
              streak++;
              ref = q;
            } else break;
          }
        }
        const t = ma20At(eIdx, code);
        obs.push({
          code,
          dCum,
          streak,
          pricePct: Number((((c.c - p.c) / p.c) * 100).toFixed(2)),
          aboveMa20: t ? t.close >= t.ma : null,
          ret: exit / entry - 1,
        });
      }
      if (obs.length < 30) continue;

      const views: Record<string, Obs[]> = {
        全部: obs,
        背離: obs.filter((o) => o.pricePct <= DIVERGE_MAX_GAIN && o.pricePct >= DIVERGE_MIN_CHANGE),
        同向: obs.filter((o) => o.pricePct > 0 && o.aboveMa20 === true),
      };
      const sel: Record<string, (o: Obs) => boolean> = {
        減碼: (o) => o.streak === 0,
        連1週: (o) => o.streak === 1,
        連2週: (o) => o.streak === 2,
        連3週以上: (o) => o.streak >= 3,
        連2週以上: (o) => o.streak >= 2,
        全部增加: (o) => o.streak >= 1,
      };
      for (const [v, pool] of Object.entries(views)) {
        for (const b of BUCKETS) {
          const g = pool.filter(sel[b]);
          cnts[v][b].push(g.length);
          rets[v][b].push(g.length >= MIN_BUCKET ? avg(g.map((o) => o.ret)) : NaN);
        }
      }
      // 基準＝當週所有通過流動性過濾的個股等權（不是大盤——大戶榜本來就只在這個母體裡選）
      base.push(avg(obs.map((o) => o.ret)));
      weeks.push(cur.dataDate);
    }

    if (weeks.length < 10) {
      console.log(`\n門檻 ${cut.key} 張：可回測週數只有 ${weeks.length}，跳過`);
      continue;
    }

    const summarize = (r: number[], c: number[]) => {
      const idx = r.map((_, j) => j).filter((j) => Number.isFinite(r[j]) && Number.isFinite(base[j]));
      if (idx.length < 6) return null;
      const ex = idx.map((j) => r[j] - base[j]);
      const me = avg(ex);
      const sd = Math.sqrt(avg(ex.map((z) => (z - me) ** 2)));
      return { n: idx.length, size: avg(c.filter(Number.isFinite)), mean: avg(idx.map((j) => r[j])), ex: me, win: ex.filter((z) => z > 0).length / ex.length, ir: (me / sd) * Math.sqrt(52) };
    };
    const pairT = (a: number[], b: number[]) => {
      const d: number[] = [];
      for (let j = 0; j < a.length; j++) if (Number.isFinite(a[j]) && Number.isFinite(b[j])) d.push(a[j] - b[j]);
      if (d.length < 6) return null;
      const m = avg(d);
      const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1));
      return { n: d.length, diff: m, t: m / (sd / Math.sqrt(d.length)), win: d.filter((x) => x > 0).length / d.length };
    };

    console.log(`\n${"=".repeat(78)}\n門檻 ${cut.key} 張以上　${weeks.length} 週（${weeks[0]} ~ ${weeks[weeks.length - 1]}）　資料日+${ENTRY_LAG_DAYS}天進場、持有一週`);
    for (const v of ["全部", "背離", "同向"]) {
      console.log(`\n  【${v}】桶名          平均檔數  週均報酬    超額   勝率  年化IR  有效週`);
      for (const b of BUCKETS) {
        const s = summarize(rets[v][b], cnts[v][b]);
        if (!s) {
          console.log(`    ${b.padEnd(12)} 樣本不足`);
          continue;
        }
        console.log(
          `    ${b.padEnd(12)} ${s.size.toFixed(0).padStart(6)}  ${F(s.mean).padStart(8)} ${F(s.ex).padStart(8)} ${(s.win * 100).toFixed(0).padStart(4)}%  ${s.ir.toFixed(2).padStart(6)}  ${String(s.n).padStart(5)}`,
        );
      }
      console.log(`    ${"（基準）全母體".padEnd(12)} ${"".padStart(6)}  ${F(avg(base)).padStart(8)}`);
      console.log(`    ── 配對檢定（同一週相減）`);
      for (const [x, y] of [["連2週以上", "連1週"], ["連2週", "連1週"], ["連3週以上", "連2週"], ["全部增加", "減碼"], ["連2週以上", "全部增加"]] as [string, string][]) {
        const r = pairT(rets[v][x], rets[v][y]);
        console.log(`    ${`${x} − ${y}`.padEnd(22)} ${r ? `${String(r.n).padStart(3)}週  ${F(r.diff).padStart(8)}  t=${r.t.toFixed(2).padStart(5)}  勝${(r.win * 100).toFixed(0)}%` : "重疊週數不足"}`);
      }
    }
    results[cut.key] = { weeks, base, rets, cnts };
  }

  writeFileSync(resolve(ROOT, "data/tdcc-streak-backtest.json"), JSON.stringify({ generatedAt: twIso(), entryLagDays: ENTRY_LAG_DAYS, minBucket: MIN_BUCKET, results }, null, 2));
  console.log(`\n  ⚠️ 回補快照只涵蓋流動性前 300 檔，母體比正規快照小；下市個股拿不到出場價會被排除。`);
  console.log(`  ⚠️ 沒扣交易成本。週頻換手的成本遠高於月頻，這一點對「要不要多等一週」的結論影響很大。`);
}

main();
