#!/usr/bin/env npx tsx
/**
 * 放空因子回測：月營收衰退 ＋ 毛利率下滑，未來一個月會不會跑輸大盤？
 *
 * 前提（三份資料都要先備齊）：
 *   npx tsx scripts/fetch-monthly-revenue.ts --months 107      # 2017-11 起，才算得出 2019 的 3 個月 YoY
 *   npx tsx scripts/fetch-quarterly-financials.ts --quarters 35
 *   python3 scripts/fetch-wide-market-history.py               # 全市場日線（含除權息還原參考價）
 *
 * ## 時間軸（不偷看未來）
 *
 *   月營收 M 依規定 M+1 月 10 日前公布 → 訊號日定在 M+1 月 11 日，
 *   隔一個交易日（≥ 11 日的第一個交易日）開盤進場，持有到下個月同一個進場日開盤出場。
 *   毛利率只用「申報期限已過」的那一季（lib/gross-margin.ts 的 latestPublishedQuarter），
 *   所以 5/11 進場時用的仍是去年 Q4，不是 5/15 才到期的 Q1。
 *   ⚠️ 月營收用的是現在抓到的最終版（含事後更正），和當時看到的可能有些微差異。
 *
 * ## 比較基準
 *
 *   同月份、同一個流動性母體的等權平均報酬。訊號組合減母體平均＝「放空訊號股、
 *   作多整個母體（或用期貨避險）」的超額報酬。放空賺錢 ⇔ 超額為負。
 *
 * ## 成本
 *
 *   融券一來一回：賣出手續費 0.1425% ＋ 證交稅 0.3% ＋ 融券手續費 0.08% ＋ 買回手續費 0.1425%
 *   ＝ 0.665%／每次換股。這裡假設每月全換（上限），實際有留倉的話會更低。
 *   沒算：借券費率差異、強制回補（股東會、除權息）、平盤以下限制、軋空。
 *
 * 用法：
 *   npx tsx scripts/backtest-revenue-short.ts
 *   npx tsx scripts/backtest-revenue-short.ts --min-turnover 50   # 20 日均成交額門檻（百萬元），預設 20
 *
 * 產出：data/backtest/revenue-short/results.json，摘要印在 stdout。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadSnapshots, SKIP_INDUSTRIES, isTib, MIN_BASE } from "./lib/revenue-factors";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadFinancials, latestPublishedQuarter, marginOf, prevQuarter } from "./lib/gross-margin";
import { addDayQuotes, addReferenceEvent, createPanel, finalizePanel, type StockPanel } from "./lib/wide-market-panel";

const OUT_DIR = "data/backtest/revenue-short";
const SHORT_COST = 0.00665;
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]
  ?? (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const MIN_TURNOVER = Number(arg("min-turnover") ?? 20) * 1e6;
/** 敏感度：排除金融保險（金控營收含投資收益，YoY 波動和本業無關） */
const EX_FIN = process.argv.includes("--ex-fin");
/** 一個訊號當月至少要有幾檔，少於這個數那個月不算（單檔運氣太大） */
const MIN_NAMES = 3;
const SPLIT = "2023-01";

// ---------- 價格面板（同 backtest-wide-market.ts 的讀法） ----------
function loadPanel() {
  const bench = JSON.parse(readFileSync("research/wide-market/benchmark-input.json", "utf8")).benchmarkTotalReturn;
  const calendar: string[] = bench.TaiwanStockPrice.map((r: { date: string }) => r.date).sort();
  const tr = new Map<string, number>(bench.TaiwanStockTotalReturnIndex.map((r: { date: string; price: number }) => [r.date, r.price]));
  const panel = createPanel(calendar);
  const refs = JSON.parse(readFileSync("data/backtest/wide/actions/twse-ex-references.json", "utf8")).rows as { code: string; date: string; reference: number; kind: string }[];
  const actionByKey = new Map(refs.map((a) => [`${a.date}/${a.code}`, a]));
  const missing: string[] = [];
  for (let i = 0; i < calendar.length; i++) {
    for (const source of ["twse", "tpex"] as const) {
      const file = `data/backtest/wide/daily/${source}/${calendar[i]}.json.gz`;
      if (!existsSync(file)) { missing.push(`${source}/${calendar[i]}`); continue; }
      const cached = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
      addDayQuotes(panel, i, cached.rows.map((q: Record<string, any>) => {
        const a = actionByKey.get(`${calendar[i]}/${q.code}`);
        return a ? { ...q, explicitReference: a.reference, changeLabel: a.kind } : q;
      }));
    }
  }
  const idx = new Map(calendar.map((d, i) => [d, i]));
  for (const [key, a] of actionByKey) {
    const i = idx.get(key.split("/")[0]);
    if (i !== undefined) addReferenceEvent(panel, i, a.code, a.reference);
  }
  finalizePanel(panel);
  return { calendar, panel, tr, missing: new Set(missing) };
}

const ok = (v: number) => Number.isFinite(v) && v > 0;

/**
 * 進場開盤 → 出場開盤的還原報酬。出場日沒報價（下市、停牌）就用持有期內最後一個收盤；
 * 期間遇到無法還原的除權（segment 斷掉）就整筆丟掉，不硬算。
 */
function holdReturn(s: StockPanel, entry: number, exit: number): number | null {
  if (!ok(s.adjustedOpen[entry]) || s.segmentId[entry] < 0) return null;
  const seg = s.segmentId[entry];
  if (ok(s.adjustedOpen[exit]) && s.segmentId[exit] === seg && ok(s.close[exit])) return s.adjustedOpen[exit] / s.adjustedOpen[entry] - 1;
  for (let i = exit - 1; i > entry; i--) {
    if (s.segmentId[i] !== seg) return null;
    if (ok(s.close[i]) && ok(s.adjustedClose[i])) return s.adjustedClose[i] / s.adjustedOpen[entry] - 1;
  }
  return null;
}

/** 進場前 60 個交易日的還原報酬（訊號前一天收盤 vs 61 天前收盤）；跨過無法還原的除權就 null */
function priorReturn(s: StockPanel, entry: number): number | null {
  const a = entry - 61, b = entry - 1;
  if (a < 0 || !ok(s.adjustedClose[a]) || !ok(s.adjustedClose[b]) || s.segmentId[a] < 0 || s.segmentId[a] !== s.segmentId[b]) return null;
  return s.adjustedClose[b] / s.adjustedClose[a] - 1;
}

/** 前 20 個交易日的平均成交額；整個市場缺檔的日子不算進分母（缺檔≠沒成交） */
function avgTurnover(s: StockPanel, before: number, marketOk: (i: number) => boolean): number {
  let sum = 0, n = 0;
  for (let i = before - 20; i < before; i++) {
    if (!marketOk(i)) continue;
    n++;
    if (s.seen[i] && Number.isFinite(s.money[i])) sum += s.money[i];
  }
  return n >= 10 ? sum / n : 0;
}

// ---------- 因子 ----------
interface Feat {
  code: string;
  ret: number;
  ret3: number | null;
  yoy: number;            // 單月 YoY
  yoys: (number | null)[]; // 近 3 個月單月 YoY，新到舊
  moms: (number | null)[]; // 近 3 個月單月 MoM，新到舊
  yoy3m: number | null;   // 近 3 個月合計 YoY（抗農曆年）
  gmYoy: number | null;   // 最新已公布季 毛利率 − 去年同季（pp，小數）
  gmQoq: number | null;
  prior: number | null;
}

type Rule = { id: string; label: string; test: (f: Feat) => boolean };
const allLe = (xs: (number | null)[], t: number) => xs.every((x) => x !== null && x <= t);
const RULES: Rule[] = [
  { id: "yoy1_m20", label: "單月 YoY ≤ −20%", test: (f) => f.yoy <= -0.2 },
  { id: "yoy3each_m10", label: "連 3 月 YoY 都 ≤ −10%", test: (f) => allLe(f.yoys, -0.1) },
  { id: "yoy3each_m20", label: "連 3 月 YoY 都 ≤ −20%", test: (f) => allLe(f.yoys, -0.2) },
  { id: "yoy3m_m20", label: "近 3 月合計 YoY ≤ −20%", test: (f) => f.yoy3m !== null && f.yoy3m <= -0.2 },
  { id: "mom3each_m10", label: "連 3 月 MoM 都 ≤ −10%（字面解讀）", test: (f) => allLe(f.moms, -0.1) },
  // 2026-10-07 追加（寬鬆版）：連 3 月「有衰退」就算，不設幅度
  { id: "yoy3each_neg", label: "＋ 連 3 月 YoY 都 < 0", test: (f) => allLe(f.yoys, -1e-9) },
  { id: "mom3each_neg", label: "＋ 連 3 月 MoM 都 < 0", test: (f) => allLe(f.moms, -1e-9) },
  { id: "yoy_mom3_neg", label: "＋ 連 3 月 YoY 與 MoM 都 < 0", test: (f) => allLe(f.yoys, -1e-9) && allLe(f.moms, -1e-9) },
  { id: "yoy20_mom3_neg", label: "＋ 單月 YoY ≤ −20% ＋ 連 3 月 MoM 都 < 0", test: (f) => f.yoy <= -0.2 && allLe(f.moms, -1e-9) },
  { id: "gm_yoy_down", label: "毛利率年減（任何幅度）", test: (f) => f.gmYoy !== null && f.gmYoy < 0 },
  { id: "gm_yoy_m3", label: "毛利率年減 ≥ 3pp", test: (f) => f.gmYoy !== null && f.gmYoy <= -0.03 },
  { id: "gm_both_down", label: "毛利率年減且季減", test: (f) => f.gmYoy !== null && f.gmQoq !== null && f.gmYoy < 0 && f.gmQoq < 0 },
  { id: "c_each10_gm", label: "★ 連 3 月 YoY ≤ −10% ＋ 毛利率年減", test: (f) => allLe(f.yoys, -0.1) && f.gmYoy !== null && f.gmYoy < 0 },
  { id: "c_each20_gm", label: "★ 連 3 月 YoY ≤ −20% ＋ 毛利率年減", test: (f) => allLe(f.yoys, -0.2) && f.gmYoy !== null && f.gmYoy < 0 },
  { id: "c_3m20_gm3", label: "★ 3 月合計 YoY ≤ −20% ＋ 毛利率年減 ≥ 3pp", test: (f) => f.yoy3m !== null && f.yoy3m <= -0.2 && f.gmYoy !== null && f.gmYoy <= -0.03 },
  { id: "c_each20_gmboth", label: "★ 連 3 月 YoY ≤ −20% ＋ 毛利率年減且季減", test: (f) => allLe(f.yoys, -0.2) && f.gmYoy !== null && f.gmQoq !== null && f.gmYoy < 0 && f.gmQoq < 0 },
];

// ---------- 統計 ----------
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function tstat(xs: number[]) {
  if (xs.length < 3) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return m / (sd / Math.sqrt(xs.length));
}
function summarize(rows: { month: string; excess: number; n: number }[]) {
  if (!rows.length) return null;
  const ex = rows.map((r) => r.excess);
  const shortNet = ex.map((x) => -x - SHORT_COST);
  let eq = 1, peak = 1, mdd = 0;
  for (const x of shortNet) { eq *= 1 + x; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
  return {
    months: rows.length,
    avgNames: +mean(rows.map((r) => r.n)).toFixed(1),
    meanExcessPct: +(mean(ex) * 100).toFixed(2),
    t: tstat(ex) === null ? null : +tstat(ex)!.toFixed(2),
    underperformRate: +(ex.filter((x) => x < 0).length / ex.length * 100).toFixed(1),
    shortNetMeanPct: +(mean(shortNet) * 100).toFixed(2),
    shortNetAnnualPct: +((eq ** (12 / rows.length) - 1) * 100).toFixed(1),
    shortMaxDrawdownPct: +(mdd * 100).toFixed(1),
    worstMonthForShortPct: +(Math.min(...shortNet) * 100).toFixed(1),
  };
}

function main() {
  const snaps = loadSnapshots();
  const fin = loadFinancials();
  if (!snaps.size || !fin.size) throw new Error("缺 data/revenue-history 或 data/financials-history，先跑檔頭的抓取指令");
  console.error(`載入價格面板…`);
  const { calendar, panel, tr, missing } = loadPanel();
  console.error(`面板 ${panel.size} 檔、${calendar.length} 日；缺檔 ${missing.size}`);

  // 每個營收月份 → 進場 index
  const months = [...snaps.keys()].filter((m) => m >= "2019-01").sort();
  const entryOf = (m: string) => {
    const nx = monthsBack(m, -1);
    const target = `${nx}-11`;
    const i = calendar.findIndex((d) => d >= target);
    return i > 20 ? i : -1;
  };
  const cohorts: { month: string; entry: number; exit: number; exit3: number | null }[] = [];
  for (let k = 0; k < months.length; k++) {
    const entry = entryOf(months[k]);
    const nextM = monthsBack(months[k], -1);
    const exit = entryOf(nextM);
    if (entry < 0 || exit < 0 || exit <= entry || calendar[exit].slice(0, 7) !== monthsBack(nextM, -1)) continue;
    const e3 = entryOf(monthsBack(months[k], -3));
    cohorts.push({ month: months[k], entry, exit, exit3: e3 > entry && calendar[e3].slice(0, 7) === monthsBack(months[k], -4) ? e3 : null });
  }

  const perRule: Record<string, { month: string; excess: number; n: number; excess3: number | null; names: string[] }[]> = Object.fromEntries(RULES.map((r) => [r.id, []]));
  const quint: Record<string, number[][]> = { yoy3m: [[], [], [], [], []], gmYoy: [[], [], [], [], []] };
  const universeLog: { month: string; entryDate: string; universe: number; ewPct: number; taiexTrPct: number | null }[] = [];
  let missingWindow = 0;
  const PRIOR_SPLIT_RULES = ["yoy1_m20", "yoy3each_m20", "yoy3each_neg", "yoy_mom3_neg"];
  const priorSplit: Record<string, { excess: number; n: number }[][]> = Object.fromEntries(PRIOR_SPLIT_RULES.map((id) => [id, [[], [], []]]));
  const priorWithin: Record<string, number[][]> = Object.fromEntries(PRIOR_SPLIT_RULES.map((id) => [id, [[], [], []]]));
  const priorBase: number[][] = [[], [], []];

  for (const c of cohorts) {
    // TWSE 歷史日檔有缺（2021–2025 被擋過），只要求進出場那兩天兩個市場都在；
    // 中間缺的日子不影響開盤對開盤的報酬，除權息靠 twse-ex-references 的官方參考價還原
    const present = (i: number) => !missing.has(`twse/${calendar[i]}`) && !missing.has(`tpex/${calendar[i]}`);
    if (!present(c.entry) || !present(c.exit)) { missingWindow++; continue; }
    if (c.exit3 !== null && !present(c.exit3)) c.exit3 = null;
    const marketOk = (i: number) => present(i);
    const snap = snaps.get(c.month)!;
    const quarter = latestPublishedQuarter(new Date(`${calendar[c.entry]}T00:00:00Z`), fin);
    const feats: Feat[] = [];
    for (const [code, row] of Object.entries(snap.stocks)) {
      if (SKIP_INDUSTRIES.has(row.ind) || isTib(row.n) || row.ind === "存託憑證") continue;
      if (EX_FIN && /金融|保險/.test(row.ind)) continue;
      if (!(row.prevY >= MIN_BASE) || !(row.rev > 0)) continue;
      const s = panel.get(code);
      if (!s) continue;
      if (avgTurnover(s, c.entry, marketOk) < MIN_TURNOVER) continue;
      const ret = holdReturn(s, c.entry, c.exit);
      if (ret === null) continue;
      const yoys: (number | null)[] = [];
      const moms: (number | null)[] = [];
      let sum = 0, sumPrev = 0, ok3 = true;
      for (let j = 0; j < 3; j++) {
        const r = snaps.get(monthsBack(c.month, j))?.stocks[code];
        const p = snaps.get(monthsBack(c.month, j + 1))?.stocks[code];
        yoys.push(r && r.prevY >= MIN_BASE ? r.rev / r.prevY - 1 : null);
        moms.push(r && p && p.rev > 0 ? r.rev / p.rev - 1 : null);
        if (r && r.prevY > 0) { sum += r.rev; sumPrev += r.prevY; } else ok3 = false;
      }
      let gmYoy: number | null = null, gmQoq: number | null = null;
      if (quarter) {
        const g = marginOf(code, quarter, fin);
        const gy = marginOf(code, prevQuarter(prevQuarter(prevQuarter(prevQuarter(quarter)))), fin);
        const gq = marginOf(code, prevQuarter(quarter), fin);
        if (g !== null && gy !== null) gmYoy = g - gy;
        if (g !== null && gq !== null) gmQoq = g - gq;
      }
      feats.push({
        code, ret, ret3: c.exit3 !== null ? holdReturn(s, c.entry, c.exit3) : null,
        yoy: row.rev / row.prevY - 1, yoys, moms,
        yoy3m: ok3 && sumPrev >= MIN_BASE * 3 ? sum / sumPrev - 1 : null, gmYoy, gmQoq, prior: priorReturn(s, c.entry),
      });
    }
    if (feats.length < 200) continue;
    const ew = mean(feats.map((f) => f.ret));
    const r3s = feats.filter((f) => f.ret3 !== null).map((f) => f.ret3!);
    const ew3 = r3s.length ? mean(r3s) : null;
    const t0 = tr.get(calendar[c.entry - 1]), t1 = tr.get(calendar[c.exit - 1]);
    universeLog.push({ month: c.month, entryDate: calendar[c.entry], universe: feats.length, ewPct: +(ew * 100).toFixed(2), taiexTrPct: t0 && t1 ? +((t1 / t0 - 1) * 100).toFixed(2) : null });

    for (const rule of RULES) {
      const hit = feats.filter(rule.test);
      if (hit.length < MIN_NAMES) continue;
      const h3 = hit.filter((f) => f.ret3 !== null);
      perRule[rule.id].push({
        month: c.month, n: hit.length, excess: mean(hit.map((f) => f.ret)) - ew,
        excess3: ew3 !== null && h3.length >= MIN_NAMES ? mean(h3.map((f) => f.ret3!)) - ew3 : null,
        names: hit.map((f) => f.code),
      });
    }
    // 「股價是不是已經跌完了」：依進場前 60 日報酬在當月母體的三分位，把命中股拆三組，
    // 各組跟母體平均比。低＝已經跌最多的那 1/3。
    const priors = feats.filter((f) => f.prior !== null).map((f) => f.prior!).sort((a, b) => a - b);
    if (priors.length >= 100) {
      const t1 = priors[Math.floor(priors.length / 3)], t2 = priors[Math.floor(priors.length * 2 / 3)];
      const bucketOf = (p: number) => (p < t1 ? 0 : p < t2 ? 1 : 2);
      for (const id of PRIOR_SPLIT_RULES) {
        const rule = RULES.find((r) => r.id === id)!;
        const hit = feats.filter((f) => f.prior !== null && rule.test(f));
        for (let b = 0; b < 3; b++) {
          const part = hit.filter((f) => bucketOf(f.prior!) === b);
          if (part.length >= MIN_NAMES) priorSplit[id][b].push({ excess: mean(part.map((f) => f.ret)) - ew, n: part.length });
        }
        // 母體本身各三分位的超額（不看營收），用來扣掉「跌深反彈／動能」本身的效果
        if (id === PRIOR_SPLIT_RULES[0]) for (let b = 0; b < 3; b++) {
          const part = feats.filter((f) => f.prior !== null && bucketOf(f.prior!) === b);
          priorBase[b].push(mean(part.map((f) => f.ret)) - ew);
        }
        // 同一個價格三分位內，命中 vs 沒命中（最乾淨的比較）
        for (let b = 0; b < 3; b++) {
          const inB = feats.filter((f) => f.prior !== null && bucketOf(f.prior!) === b);
          const h = inB.filter(rule.test), nh = inB.filter((f) => !rule.test(f));
          if (h.length >= MIN_NAMES && nh.length >= MIN_NAMES) priorWithin[id][b].push(mean(h.map((f) => f.ret)) - mean(nh.map((f) => f.ret)));
        }
      }
    }
    // 五分位：看是不是「越差越差」的單調關係，而不是只有門檻那一刀
    for (const key of ["yoy3m", "gmYoy"] as const) {
      const xs = feats.filter((f) => f[key] !== null).sort((a, b) => a[key]! - b[key]!);
      if (xs.length < 100) continue;
      const m = mean(xs.map((f) => f.ret));
      for (let q = 0; q < 5; q++) {
        const part = xs.slice(Math.floor(q * xs.length / 5), Math.floor((q + 1) * xs.length / 5));
        quint[key][q].push(mean(part.map((f) => f.ret)) - m);
      }
    }
  }

  const results = RULES.map((r) => {
    const rows = perRule[r.id];
    const ex3 = rows.filter((x) => x.excess3 !== null).map((x) => x.excess3!);
    return {
      id: r.id, label: r.label,
      all: summarize(rows),
      before: summarize(rows.filter((x) => x.month < SPLIT)),
      after: summarize(rows.filter((x) => x.month >= SPLIT)),
      excess3mMeanPct: ex3.length ? +(mean(ex3) * 100).toFixed(2) : null,
      monthly: rows.map(({ month, n, excess, names }) => ({ month, n, excessPct: +(excess * 100).toFixed(2), names })),
    };
  });
  const quintiles = Object.fromEntries(Object.entries(quint).map(([k, qs]) => [k, qs.map((xs, i) => ({
    quintile: i + 1, months: xs.length, meanExcessPct: xs.length ? +(mean(xs) * 100).toFixed(2) : null, t: tstat(xs) === null ? null : +tstat(xs)!.toFixed(2),
  }))]));

  const BUCKET = ["前60日跌最多 1/3", "中間 1/3", "前60日漲最多 1/3"];
  const fmtT = (xs: number[]) => (tstat(xs) === null ? "—" : tstat(xs)!.toFixed(2));
  const priorTable = PRIOR_SPLIT_RULES.map((id) => ({
    id, label: RULES.find((r) => r.id === id)!.label,
    buckets: [0, 1, 2].map((b) => {
      const xs = priorSplit[id][b].map((x) => x.excess), w = priorWithin[id][b];
      return { bucket: BUCKET[b], months: xs.length, avgNames: xs.length ? +mean(priorSplit[id][b].map((x) => x.n)).toFixed(1) : null,
        meanExcessPct: xs.length ? +(mean(xs) * 100).toFixed(2) : null, t: xs.length ? +fmtT(xs) : null,
        withinBucketPct: w.length ? +(mean(w) * 100).toFixed(2) : null, withinT: w.length ? +fmtT(w) : null, withinMonths: w.length };
    }),
  }));
  const priorBaseline = [0, 1, 2].map((b) => ({ bucket: BUCKET[b], meanExcessPct: priorBase[b].length ? +(mean(priorBase[b]) * 100).toFixed(2) : null, t: priorBase[b].length ? +fmtT(priorBase[b]) : null }));

  mkdirSync(OUT_DIR, { recursive: true });
  const out = { generatedAt: new Date().toISOString(), minTurnoverNtd: MIN_TURNOVER, shortCostPerMonth: SHORT_COST, split: SPLIT,
    cohorts: universeLog.length, skippedForMissingData: missingWindow, firstMonth: universeLog[0]?.month, lastMonth: universeLog.at(-1)?.month,
    universe: universeLog, rules: results, quintiles, priorBaseline, priorTable, exFin: EX_FIN };
  writeFileSync(`${OUT_DIR}/results${MIN_TURNOVER === 20e6 ? "" : `-t${MIN_TURNOVER / 1e6}`}${EX_FIN ? "-exfin" : ""}.json`, JSON.stringify(out, null, 2));

  console.log(`期數 ${universeLog.length}（${out.firstMonth}～${out.lastMonth}，缺資料略過 ${missingWindow}），平均母體 ${Math.round(mean(universeLog.map((u) => u.universe)))} 檔，流動性門檻 ${MIN_TURNOVER / 1e6}M`);
  console.log("規則 | 月數 | 平均檔數 | 月超額% | t | 跑輸率% | 放空淨月報% | 放空年化% | 放空MDD% | 前段超額% | 後段超額% | 3月超額%");
  for (const r of results) {
    const a = r.all;
    if (!a) { console.log(`${r.label} | 無樣本`); continue; }
    console.log([r.label, a.months, a.avgNames, a.meanExcessPct, a.t, a.underperformRate, a.shortNetMeanPct, a.shortNetAnnualPct, a.shortMaxDrawdownPct,
      r.before?.meanExcessPct ?? "—", r.after?.meanExcessPct ?? "—", r.excess3mMeanPct ?? "—"].join(" | "));
  }
  console.log("母體依前60日報酬三分位（不看營收）: " + priorBaseline.map((b) => `${b.bucket} ${b.meanExcessPct}% (t ${b.t})`).join("  "));
  for (const r of priorTable) {
    console.log(`${r.label}｜依前60日報酬拆組：` + r.buckets.map((b) => `${b.bucket}: 對母體 ${b.meanExcessPct}% (t ${b.t}, ${b.months}月, ${b.avgNames}檔)／同組內命中−未命中 ${b.withinBucketPct}% (t ${b.withinT})`).join("  ||  "));
  }
  for (const [k, qs] of Object.entries(quintiles)) console.log(`${k} 五分位（1=最差）: ` + (qs as any[]).map((q) => `Q${q.quintile} ${q.meanExcessPct}% (t ${q.t})`).join("  "));
}

main();
