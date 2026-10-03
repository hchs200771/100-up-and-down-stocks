/**
 * 月營收因子計算的共用核心。
 *
 * 被兩支腳本共用：
 *  - build-revenue-momentum.ts  完整月份的正式榜（用當月自己的橫斷面百分位）
 *  - build-revenue-early.ts     公布中的搶先榜（用上個完整月份的切點當尺規）
 *
 * 因子定義、濾網、1/2 月合併規則全部集中在這裡，兩邊才不會各寫一份而慢慢走鐘。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RevenueSnapshot, RevenueRow } from "../fetch-monthly-revenue";
import { monthsBack } from "../fetch-monthly-revenue";

export const HISTORY_DIR = "data/revenue-history";
/** 一份月報要收錄到幾家才算「公布完了」，可以拿來做橫斷面排名 */
export const MIN_COVERAGE = 1200;
/** 每檔至少要有幾個月的歷史才評分（季節性中位數 + 創新高都要吃歷史） */
export const MIN_MONTHS = 15;
/** 月營收下限（千元）＝ 1 億。再小的公司 YoY 是雜訊 */
export const MIN_REV = 100_000;
/** 去年同月營收下限（千元）＝ 3000 萬。分母太小會讓 YoY 破千% */
export const MIN_BASE = 30_000;
/** 完工認列、月營收本質跳動的產業。金融保險本來就不申報月營收，不在資料裡 */
export const SKIP_INDUSTRIES = new Set(["建材營造"]);
/**
 * 「歷史新高」看幾個月。固定 60 個月（5 年）而不是「有多少看多少」——
 * 資料庫會隨著時間變長，若用全歷史，同一句「創歷史新高」的門檻會逐年變嚴，
 * 跨年份就不能比。釘死 5 年，標籤永遠是同一個意思。
 */
export const HIGH_LOOKBACK_MONTHS = 60;
/**
 * 進榜的硬門檻：單月營收 YoY ≥ 20%。
 * 這是策略的核心判斷——市場上隨時有好幾百家 YoY 20% 以上的公司，成長沒到這個水準
 * 的公司不值得占用部位，不管它其他因子多漂亮。2 月用 1+2 月合併值過門檻。
 */
export const GATE_YOY = 0.20;

/**
 * 創新板（公司名稱以 -創 結尾）：只有合格投資人能買、成交極稀，進榜也沒用。
 * 名稱裡的 `*` 不是問題（那是「無面額或面額非 10 元」的註記），照留。
 */
export const isTib = (name: string) => /-創$/.test(name);

export function loadSnapshots(root = process.cwd()): Map<string, RevenueSnapshot> {
  const dir = resolve(root, HISTORY_DIR);
  const snaps = new Map<string, RevenueSnapshot>();
  if (!existsSync(dir)) return snaps;
  for (const f of readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort()) {
    const s: RevenueSnapshot = JSON.parse(readFileSync(resolve(dir, f), "utf-8"));
    snaps.set(s.month, s);
  }
  return snaps;
}

export const coverageOf = (snaps: Map<string, RevenueSnapshot>, m: string) => {
  const c = snaps.get(m)?.coverage;
  return c ? c.twse + c.tpex : 0;
};

/** 最新一個「已經公布完」的月份，找不到回空字串 */
export const lastCompleteMonth = (snaps: Map<string, RevenueSnapshot>) =>
  [...snaps.keys()].sort().reverse().find((m) => coverageOf(snaps, m) >= MIN_COVERAGE) ?? "";

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** 線性映射到 [0, max]：v <= lo 得 0，v >= hi 得滿分 */
export const ramp = (v: number | null, lo: number, hi: number, max: number): number => {
  if (v === null || !Number.isFinite(v)) return 0;
  if (v <= lo) return 0;
  if (v >= hi) return max;
  return ((v - lo) / (hi - lo)) * max;
};

/**
 * 百分位 → 分數。只有中位數（0.5）以上才給分，1.0 給滿分。
 * 「衰退得比別人少」不是買進理由，所以中位數以下一律 0。
 */
export const rankPts = (rank: number | null, max: number): number =>
  rank === null || rank <= 0.5 ? 0 : ((rank - 0.5) / 0.5) * max;

/** 某檔在某月的原始因子，還沒轉成分數 */
export interface RevFactors {
  code: string;
  row: RevenueRow;
  rev: number;
  yoy: number;
  accel: number | null;
  priorYoyAvg: number | null;
  mom: number | null;
  season: number | null;
  momSa: number | null;
  streak: number;
  highMonths: number;
  /**
   * 年初至今的累計營收 YoY。⚠️ 這是 YTD——1 月的「累計」就等於 1 月當月，
   * 所以每年 1 月這個數字跟 yoy 完全相同、沒有額外資訊，2 月起才慢慢有意義。
   */
  cumYoy: number | null;
  /**
   * 近 12 個月營收合計 vs 前 12 個月合計的年增率（TTM）。
   * 比 cumYoy 好用的兩個地方：不會在 1 月歸零重來；而且任何 12 個月區間都剛好
   * 含一次農曆年，天生免疫於 1/2 月的工作天數錯位。
   */
  ttmYoy: number | null;
  /**
   * 連續 MoM 為正的月數（含當月）。
   * ⚠️ 用的是原始單月 MoM，沒有做季節調整——1 月通常比 12 月低、農曆年那個月也會掉，
   * 所以每年年初 streak 幾乎必然斷。這是季節性造成的，不是基本面轉壞。
   */
  momStreak: number;
  /** 單月營收是否為**近 5 年**新高 */
  allTimeHigh: boolean;
  /** 單月營收是否為**同一個日曆月**的近 5 年新高（例：今年 8 月 vs 過去 5 個 8 月） */
  sameMonthHigh: boolean;
  /** 這檔在 5 年視窗內實際有幾個月的資料——不足就不敢說「新高」 */
  historyMonths: number;
}

export type SkipReason = "small" | "base" | "industry" | "short";

/**
 * 綁定一組快照與目標月份，回傳可重複呼叫的因子計算器。
 * 兩支腳本都靠它，差別只在「拿什麼分布把因子轉成分數」。
 */
export function createFactorCalc(snaps: Map<string, RevenueSnapshot>, target: string) {
  const rowOf = (code: string, month: string): RevenueRow | null => snaps.get(month)?.stocks[code] ?? null;

  /**
   * 目標月是 1 月時，1+2 合併值要等 2 月公布才算得出來，所以**當月自己**只能用單月數字。
   * 這份 1 月名單是暫定的：農曆年落在 1 月或 2 月每年不同，工作天數會整組錯位。
   * 但「整個 1 月沒名單可看」比「有一份標了警語的名單」更糟，所以照出，用旗標標示。
   *
   * 注意這只影響**目標月自己**。往回看歷史（streak、加速度）時 1、2 月仍然用合併值，
   * 那是比較乾淨的可比序列。同一個 1 月因此會有兩個值：當月看到的暫定單月值，
   * 與事後回頭看的合併值——這是刻意的取捨，不是 bug。
   */
  const targetIsJan = +target.slice(5, 7) === 1;

  /**
   * 某檔在某個月的「可比營收點」。
   * 1 月與 2 月都回傳 1+2 月合併值——兩個月共用同一個資料點，因為農曆年落在哪一個月
   * 每年不同，單看任何一個月都會得到假的 YoY。
   */
  const point = (code: string, month: string, standalone = false): { rev: number; prevY: number } | null => {
    const mn = +month.slice(5, 7);
    if ((mn === 1 || mn === 2) && !standalone) {
      const y = month.slice(0, 4);
      const a = rowOf(code, `${y}-01`);
      const b = rowOf(code, `${y}-02`);
      if (!a || !b) return null;
      return { rev: a.rev + b.rev, prevY: a.prevY + b.prevY };
    }
    const r = rowOf(code, month);
    return r ? { rev: r.rev, prevY: r.prevY } : null;
  };

  const yoyOf = (code: string, month: string, standalone = false): number | null => {
    const p = point(code, month, standalone);
    if (!p || p.prevY < MIN_BASE) return null;
    return p.rev / p.prevY - 1;
  };

  const momOf = (code: string, m: string): number | null => {
    const cur = rowOf(code, m);
    const prev = rowOf(code, monthsBack(m, 1));
    if (!cur || !prev || prev.rev < MIN_BASE) return null;
    return cur.rev / prev.rev - 1;
  };

  /** 目標月往回 24 個月裡真的有檔案的月份 */
  const window24 = Array.from({ length: 24 }, (_, i) => monthsBack(target, i)).filter((m) => snaps.has(m));
  /** 目標月（含）往回 60 個月裡有資料的月份，由新到舊。「5 年新高」的比較範圍 */
  const allMonths = Array.from({ length: HIGH_LOOKBACK_MONTHS }, (_, i) => monthsBack(target, i)).filter((m) => snaps.has(m));
  /** 跟目標月同一個日曆月的所有歷史月份（含目標月），例：目標 2026-08 → 2026-08, 2025-08, ... */
  const sameMonths = allMonths.filter((m) => m.slice(5, 7) === target.slice(5, 7));

  function factorsFor(code: string, row: RevenueRow): RevFactors | SkipReason {
    if (SKIP_INDUSTRIES.has(row.ind) || isTib(row.n)) return "industry";
    const p = point(code, target, targetIsJan);
    if (!p) return "short";
    if (p.rev < MIN_REV) return "small";
    if (p.prevY < MIN_BASE) return "base";
    if (window24.filter((m) => rowOf(code, m)).length < MIN_MONTHS) return "short";

    const yoy = yoyOf(code, target, targetIsJan)!;

    // 加速度：本月 YoY − 前 3 個月 YoY 均值。前 3 個月遇到 1/2 月會自動換成 1+2
    // 合併值（point() 處理），那兩個月會拿到同一個數字——農曆年讓它們本來就只有
    // 一個可比資料點。
    const priorYoy = [1, 2, 3].map((i) => yoyOf(code, monthsBack(target, i))).filter((v): v is number => v !== null);
    const priorYoyAvg = priorYoy.length >= 2 ? priorYoy.reduce((a, b) => a + b, 0) / priorYoy.length : null;
    const accel = priorYoyAvg === null ? null : yoy - priorYoyAvg;

    // 季節調整後 MoM：基準是過去各年「同一個日曆月」的 MoM 中位數
    const mom = momOf(code, target);
    const seasonSamples = [12, 24].map((k) => momOf(code, monthsBack(target, k))).filter((v): v is number => v !== null);
    const season = seasonSamples.length >= 2 ? median(seasonSamples) : null;
    const momSa = mom !== null && season !== null ? mom - season : null;

    // 持續性：連續 YoY > 0 的月數
    let streak = 0;
    for (let i = 0; i < 12; i++) {
      const v = yoyOf(code, monthsBack(target, i));
      if (v === null || v <= 0) break;
      streak++;
    }

    // 創新高
    const revAt = (m: string) => rowOf(code, m)?.rev ?? null;
    const past = (n: number) =>
      Array.from({ length: n }, (_, i) => revAt(monthsBack(target, i + 1))).filter((v): v is number => v !== null);
    const p23 = past(23);
    const p11 = past(11);
    let highMonths = 0;
    if (p23.length >= 20 && p.rev > Math.max(...p23)) highMonths = 24;
    else if (p11.length >= 10 && row.rev > Math.max(...p11)) highMonths = 12;

    const cumYoy = row.cumPrevY >= MIN_BASE ? row.cum / row.cumPrevY - 1 : null;

    // TTM：近 12 個月 vs 前 12 個月。任一段缺月就不算，寧可留白也不要拿殘缺的區間比
    const window12 = (from: number) => {
      const xs: number[] = [];
      for (let i = from; i < from + 12; i++) {
        const r = rowOf(code, monthsBack(target, i));
        if (!r) return null;
        xs.push(r.rev);
      }
      return xs.reduce((a, b) => a + b, 0);
    };
    const ttmCur = window12(0);
    const ttmPrev = window12(12);
    const ttmYoy = ttmCur !== null && ttmPrev !== null && ttmPrev >= MIN_BASE ? ttmCur / ttmPrev - 1 : null;

    // 連續 MoM 為正的月數。用原始單月營收，不合併 1/2 月——使用者要看的就是逐月的動能，
    // 季節性造成的年初斷檔是這個指標的本質，不是要修掉的東西。
    let momStreak = 0;
    for (let i = 0; i < 24; i++) {
      const v = momOf(code, monthsBack(target, i));
      if (v === null || v <= 0) break;
      momStreak++;
    }

    // 5 年新高：比的是近 60 個月，不是只比 24 個月
    const hist = allMonths.map((m) => rowOf(code, m)?.rev ?? null).filter((v): v is number => v !== null);
    const historyMonths = hist.length;
    // 至少要有 4 年資料才敢說「5 年新高」，不然新上市的公司每個月都在創新高
    const allTimeHigh = historyMonths >= 48 && row.rev >= Math.max(...hist);
    // 同期歷史新高：只跟歷年的同一個月比。這條對旺季/淡季明顯的公司比全歷史新高更有意義
    // ——一家 Q4 旺季的公司，8 月營收永遠打不過去年 11 月，但它可能是史上最強的 8 月。
    const sameHist = sameMonths.map((m) => rowOf(code, m)?.rev ?? null).filter((v): v is number => v !== null);
    // 同期至少要有 4 個年度樣本（含今年）才算數
    const sameMonthHigh = sameHist.length >= 4 && row.rev >= Math.max(...sameHist);

    return {
      code, row, rev: p.rev, yoy, accel, priorYoyAvg, mom, season, momSa, streak, highMonths, cumYoy, ttmYoy,
      momStreak, allTimeHigh, sameMonthHigh, historyMonths,
    };
  }

  return { rowOf, point, yoyOf, momOf, window24, factorsFor, targetIsJan };
}

// ---------- 篩選 ----------

/**
 * 絕對門檻 + 兩個獨立標記——**刻意不做任何排名**。
 *
 * 為什麼不排名：回測（每月 11 日進場持有一個月）比過五種排序法，門檻內隨機取 15 檔
 * 打敗所有排序法。門檻內部的名次沒有資訊，硬要排名還會主動傷害績效——按 YoY 排序會
 * 把「去年基期崩掉」的一次性暴衝推到最前面，正是基期陷阱。alpha 全部來自門檻本身，
 * 不是選股。細節見 backtest-revenue-momentum.ts。
 *
 * 另一個好處是**絕對門檻不需要同儕母體**：某家公司 3 號公布，當天就能用跟 11 號
 * 完全相同的標準判定，不必等同業到齊。搶先榜因此不需要任何特殊邏輯。
 *
 * ## 為什麼是「核心 + 動能」兩個獨立標記，不是一層包一層
 *
 * 舊版是巢狀漏斗：門檻 ⊃ 觀察（連 3 月 YoY 為正）⊃ 核心（再加 24 月新高）。
 * 65 個月回測（2020-08 ~ 2026-06，訓練 2020-08~2023-12 / 保留 2024-02~2026-06，
 * 見 backtest-revenue-streak.ts）拆掉了中間那層：
 *
 *   對照組（同月份配對相減）        全期間          保留樣本
 *   YoY連3月 − 門檻全部            +0.20pp t=2.75   +0.26pp t=2.46
 *   MoM連3月 − 門檻全部            +1.71pp t=3.78   +1.58pp t=2.41
 *   MoM連3月 − YoY連3月            +1.45pp t=3.31   +1.32pp t=2.17
 *
 * 「連 3 月 YoY 為正」在 263 檔的池子裡有 206 檔（78%）過得了，等於沒篩，所以
 * **觀察層被刪掉**。真正有篩選力的是 momStreak——而且它是獨立的一軸，不是核心的
 * 上位或下位條件：
 *
 *   MoM連3月 − 核心(YoY連3月+24新高)  +0.78pp t=1.66   +0.37pp t=0.61（勝月比 48%）
 *   核心+MoM連3月 − 核心              +0.94pp t=1.83   +0.64pp t=1.25
 *
 * 兩者在統計上分不出高下，疊起來也沒有可證實的增量。所以它們是**兩個平行標記**，
 * 不排先後、可以重疊，重疊的那群只在顯示上標出來，不進分層邏輯。
 *
 * 保留樣本的月超額：核心 +3.01pp（106 檔）、動能 +3.38pp（54 檔）、
 * 兩者皆中 +3.91pp（32 檔）、門檻全部 +1.80pp（329 檔）。
 *
 * ⚠️ 已否定：MoM 連 1 月與連 2 月**沒有資訊**。保留樣本裡 MoM=2 相對 MoM=0 是
 * −0.05pp（t=−0.08）、MoM=1 相對 MoM=0 是 −0.26pp（t=−0.39）。資訊集中在 ≥3，
 * 是懸崖不是斜坡，所以門檻設 3 而不是 2。
 *
 * 2026-09-29 修正股價快取（舊快取有 265 天缺上市股）後 66 個月全期間重跑，結論不變：
 *   YoY連3月 − 門檻全部 +0.15pp t=2.21；MoM連3月 − 門檻全部 +1.52pp t=3.85；
 *   MoM連3月 − YoY連3月 +1.36pp t=3.53；MoM=2 − MoM=0 +0.24pp t=0.63。
 *
 * ⚠️ momStreak 沒做季節調整，每年 2、3 月會系統性斷檔（2022-03 全市場只有 1 檔
 * 達標）。動能群在年初縮水是日曆造成的，不是市場轉壞。
 */
export type Tier = "核心" | "門檻";

/**
 * 1 月的門檻平移量。
 *
 * 農曆年落在 1 月或 2 月每年不同，會讓 1 月的工作天數整組錯位——去年年假在 2 月、
 * 今年在 1 月的話，今年 1 月少好幾個工作天，全市場的 YoY 一起變難看，反之亦然。
 * 實測 1 月全市場 YoY 中位數：2024-01 +19.4%、2025-01 +0.8%、2026-01 +14.1%，
 * 而鄰近的 12 月與 3 月都落在 1~11%。**近 19pp 的擺盪跟公司經營完全無關。**
 *
 * 固定 20% 門檻在 1 月因此是壞的：好年份 561 家過關、壞年份只有 234 家。
 * 這裡把門檻整條平移「當月中位數 − 常態中位數」，讓 1 月的鬆緊回到跟其他月份一致。
 *
 * 這是**全市場一起的日曆效應**，減掉共同項不等於做相對排名——每檔仍然面對一個
 * 絕對門檻，只是那條線在 1 月被校正過。⚠️ 只有 3 個 1 月樣本，這個校正**沒有回測驗證**，
 * 是原理上的修正而非實證結果。
 */
export function janGateShift(
  targetMedianYoy: number | null,
  baselineMedianYoy: number | null,
): number {
  if (targetMedianYoy === null || baselineMedianYoy === null) return 0;
  // 夾在 ±15pp，避免資料異常時把門檻推到荒謬的位置
  return Math.max(-0.15, Math.min(0.15, targetMedianYoy - baselineMedianYoy));
}

/** 動能標記的門檻：連續 MoM 為正的月數。設 3 的理由見上面 screen() 的註解。 */
export const MOM_STREAK_GATE = 3;

export interface Screened {
  tier: Tier;
  /** 動能標記：連 3 個月 MoM 為正。與 tier 平行、可重疊，不是核心的上下位條件 */
  momentum: boolean;
  /** 人看的旗標，例如「連8月成長」「24月新高」 */
  flags: string[];
}

export function screen(f: RevFactors, gate: number = GATE_YOY): Screened | null {
  if (f.yoy < gate) return null;
  const flags = [`YoY ${(f.yoy * 100).toFixed(0)}%`];
  if (f.streak >= 3) flags.push(`連${f.streak}月YoY成長`);
  if (f.momStreak >= MOM_STREAK_GATE) flags.push(`MoM連${f.momStreak}月正成長`);
  if (f.allTimeHigh) flags.push("5年新高");
  else if (f.sameMonthHigh) flags.push("同期歷史新高");
  else if (f.highMonths) flags.push(`${f.highMonths}月營收新高`);
  if (f.accel !== null && f.accel > 0) flags.push(`比前三月加速 ${(f.accel * 100).toFixed(0)}pp`);

  return {
    // 核心＝門檻 + 連 3 月 YoY 為正 + 24 月新高。保留樣本沒有任何變體贏得了它，所以不動。
    tier: f.streak >= 3 && f.highMonths === 24 ? "核心" : "門檻",
    momentum: f.momStreak >= MOM_STREAK_GATE,
    flags,
  };
}

export const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
export const pp = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`);
