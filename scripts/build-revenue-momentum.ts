#!/usr/bin/env npx tsx
/**
 * 月營收動能篩選 — 純基本面、純規則、零 LLM、**不排名**。
 *
 * 讀：data/revenue-history/<YYYY-MM>.json（fetch-monthly-revenue.ts 的產出）
 *     data/price-history/*.json（只拿來附註價格位置，不影響篩選）
 *     data/financials-history/*.json（季報毛利率，附註用，不影響核心／動能標記）
 * 寫：data/revenue-momentum-latest.json ＋ data/revenue-momentum-history/<YYYY-MM>.json
 *     data/revenue.html — 發佈到日報網站的子頁 /revenue.html（自足單頁，資料內嵌）
 *
 * ## 規則
 *
 * 核心是一道絕對門檻：**單月營收 YoY ≥ 20%**。市場上隨時有三百多家公司達標，
 * 成長沒到這個水準就不值得占用部位。門檻內再標兩個**平行、可重疊**的記號：
 *
 *   門檻 = YoY≥20%（及格線，表格裡的全部公司）
 *   核心 = 門檻 + 連 3 個月 YoY 為正 + 單月營收創 24 個月新高
 *   動能 = 門檻 + 連 3 個月 MoM 為正
 *
 * ⚠️ 核心與動能**不是一層包一層**，一檔可以同時中、也可以只中一個。舊版有一層
 * 「觀察 = 門檻 + 連 3 月 YoY 為正」，66 個月回測顯示它 339 檔裡放行 269 檔、
 * 相對門檻全部只有 +0.15pp，等於沒篩，已經刪掉。理由詳見 lib/revenue-factors.ts
 * 的 screen() 註解與 backtest-revenue-streak.ts。
 *
 * 頁面預設另外勾「站上月線」（收盤 > MA20，只在前端篩、不影響標記）：66 個月回測
 * 跌破月線那批只多 +0.20pp、勝率 55%；核心×毛利率成長 再疊月線 +3.00→+3.49pp。
 * 乖離「上限」（避開漲多）反而變差，沒做。見 backtest-bias-layers.ts、backtest-filter-grid.ts。
 *
 * 為什麼不給分數、不排名，見 lib/revenue-factors.ts 的 screen() 註解——回測顯示
 * 門檻內隨機取 15 檔打敗所有排序法，排名不但沒資訊還會主動傷害績效。
 *
 * ## 每天跑，不必等 10 號
 *
 * 月營收依規定次月 10 日前公布，但公司是**陸續**報的，3 號就有人報。因為門檻是
 * 絕對值、不需要同儕母體，早報的公司當天就能用跟 11 號完全相同的標準判定。
 * 所以這支每天跑，對「還在公布中」的月份照樣出名單，並標記：
 *   - partial: true    這份還會長大
 *   - firstSeen        每檔第一次進榜的日期，跨日重跑不會變
 *   - fresh            這次執行才新出現的公司（今天的新料）
 *
 * 用法：
 *   npx tsx scripts/build-revenue-momentum.ts            # 最新月份（可能還在公布中）
 *   npx tsx scripts/build-revenue-momentum.ts --month 2026-05   # 指定月份（回測用）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { twIso, twDate, fmtTw } from "./lib/time";
import { renderSubpageNav } from "./lib/nav";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadFinancials, newestQuarter, latestMarginQuarter, marginSeries } from "./lib/gross-margin";
import {
  loadSnapshots, coverageOf, createFactorCalc, screen, janGateShift, median, GATE_YOY, MIN_COVERAGE,
  type Tier, type SkipReason, type RevFactors,
} from "./lib/revenue-factors";

const ROOT = process.cwd();
const OUT_LATEST = "data/revenue-momentum-latest.json";
const OUT_HISTORY_DIR = "data/revenue-momentum-history";
const OUT_HTML = "data/revenue.html";

const snaps = loadSnapshots(ROOT);
if (!snaps.size) {
  console.error("data/revenue-history 是空的，先跑 npx tsx scripts/fetch-monthly-revenue.ts --months 36");
  process.exit(1);
}
const allMonths = [...snaps.keys()].sort();

// ---------- 目標月份 ----------

const args = process.argv.slice(2);
const monthArg = args.indexOf("--month");
let target = monthArg >= 0 ? args[monthArg + 1] : "";
/** 明確指定月份＝回測用途，不該覆蓋 latest（那是「今天該看哪一份」） */
const explicit = !!target;
if (!target) target = allMonths[allMonths.length - 1];
if (!snaps.has(target)) {
  console.error(`${target} 沒有資料（現有 ${allMonths[0]} ~ ${allMonths[allMonths.length - 1]}）`);
  process.exit(1);
}
// 1 月照出名單，但標記為暫定：1+2 合併值要等 2 月才算得出來，這個月只能用單月數字，
// 而農曆年落在 1 月或 2 月每年不同，工作天數會整組錯位。整個月沒東西看更糟。
const provisionalJan = +target.slice(5, 7) === 1;

const targetSnap = snaps.get(target)!;
const coverage = coverageOf(snaps, target);
const partial = coverage < MIN_COVERAGE;

// ---------- 價格位置（只做附註） ----------

const phDir = resolve(ROOT, "data/price-history");
const series = new Map<string, number[]>();
if (existsSync(phDir)) {
  for (const f of readdirSync(phDir).filter((f) => f.endsWith(".json")).sort()) {
    const day: Record<string, number> = JSON.parse(readFileSync(resolve(phDir, f), "utf-8"));
    for (const [code, close] of Object.entries(day)) {
      if (typeof close !== "number" || !(close > 0)) continue;
      let arr = series.get(code);
      if (!arr) series.set(code, (arr = []));
      arr.push(close);
    }
  }
}

// ---------- 個股期貨（只做附註） ----------
// 跟漲跌 100 名單同一來源：fetch-market-data.ts 從期交所抓的保證金級距，存在 market-latest 的 stockMap。
const futuresMap = new Map<string, { level: string; margin: string }>();
{
  const mp = resolve(ROOT, "data/market-latest.json");
  if (existsSync(mp)) {
    const sm = JSON.parse(readFileSync(mp, "utf-8")).stockMap ?? {};
    for (const [code, v] of Object.entries<any>(sm)) if (v?.futures) futuresMap.set(code, v.futures);
  }
}

// ---------- 季報毛利率 ----------
// 線上頁面用「這檔算得出來的最新一季」，逐檔判斷：早報的公司就看新的那一季，
// 還沒報的自動退一季。申報期限只在回測裡當守門員（當時沒公布的不能看），
// 在「今天」這個時點上沒有意義——已經公布的東西沒有理由不看。
const fin = loadFinancials(ROOT);
const finNewest = newestQuarter(fin);

// ---------- 上次的結果：用來認出「這次才新出現的公司」 ----------

const histPath = resolve(ROOT, OUT_HISTORY_DIR, `${target}.json`);
const prevSeen = new Map<string, string>();
if (existsSync(histPath)) {
  const prev = JSON.parse(readFileSync(histPath, "utf-8"));
  for (const e of prev.entries ?? []) if (e.firstSeen) prevSeen.set(e.code, e.firstSeen);
}
const today = twDate();

// ---------- 篩選 ----------

interface Entry {
  code: string;
  name: string;
  market: "twse" | "tpex";
  industry: string;
  tier: Tier;
  /** 動能標記：連 3 個月 MoM 為正。與 tier 平行、可重疊 */
  momentum: boolean;
  flags: string[];
  rev: number;
  yoy: number;
  accel: number | null;
  streak: number;
  highMonths: number;
  cumYoy: number | null;
  ttmYoy: number | null;
  /** 毛利率取自哪一季（逐檔可能不同，早報的公司會比較新） */
  marginQuarter: string | null;
  /** 最近一季（已公布）的單季毛利率 */
  margin: number | null;
  /** 毛利率比上一季增減，單位 pp */
  marginQoq: number | null;
  /** 單季毛利率是否為近 4 季最高 */
  marginHigh4: boolean | null;
  /** MoM 連續正成長月數 */
  momStreak: number;
  /** 近 5 年單月營收新高 */
  allTimeHigh: boolean;
  /** 同一個日曆月的近 5 年新高 */
  sameMonthHigh: boolean;
  /** 第一次進這個月名單的日期。跨日重跑不會變，用來看「這檔已經公布幾天了」 */
  firstSeen: string;
  /**
   * 今天才第一次進本月名單。
   * 判斷用的是 `firstSeen === today` 而不是「比上次執行多出來」——同一天重跑（例如
   * 手動補跑一次）不該讓整份名單的「今日新到」歸零。
   */
  fresh: boolean;
  price: { close: number | null; ma20: number | null; aboveMa20: boolean | null; r20: number | null };
  /** 有個股期貨才有值；margin 是原始保證金比例 */
  futures: { level: string; margin: string } | null;
}

const calc = createFactorCalc(snaps, target);
const filtered: Record<SkipReason, number> = { small: 0, base: 0, industry: 0, short: 0 };
const entries: Entry[] = [];
let belowGate = 0;

// 先把因子全算完，才知道當月全市場的 YoY 中位數（1 月門檻校正要用）
const facts: { code: string; row: typeof targetSnap.stocks[string]; f: RevFactors }[] = [];
for (const [code, row] of Object.entries(targetSnap.stocks)) {
  const f = calc.factorsFor(code, row);
  if (typeof f === "string") { filtered[f]++; continue; }
  facts.push({ code, row, f });
}

/**
 * 1 月門檻校正：常態基準取「最近 6 個非 1/2 月」各自的全市場 YoY 中位數再取中位數。
 * 非 1 月時 shift 是 0，門檻就是原本的 20%。
 */
let gate = GATE_YOY;
let gateShift = 0;
if (provisionalJan) {
  const medOfMonth = (m: string): number | null => {
    const c = createFactorCalc(snaps, m);
    const ys: number[] = [];
    for (const [code, row] of Object.entries(snaps.get(m)?.stocks ?? {})) {
      const f = c.factorsFor(code, row);
      if (typeof f !== "string") ys.push(f.yoy);
    }
    return ys.length >= 300 ? median(ys) : null;
  };
  const baseMonths: string[] = [];
  for (let i = 1; baseMonths.length < 6 && i <= 18; i++) {
    const m = monthsBack(target, i);
    const mm = +m.slice(5, 7);
    if (mm !== 1 && mm !== 2 && snaps.has(m) && coverageOf(snaps, m) >= MIN_COVERAGE) baseMonths.push(m);
  }
  const baseline = median(baseMonths.map(medOfMonth).filter((v): v is number => v !== null));
  gateShift = janGateShift(median(facts.map((x) => x.f.yoy)), baseline);
  gate = GATE_YOY + gateShift;
}

for (const { code, row, f } of facts) {
  const s = screen(f, gate);
  if (!s) { belowGate++; continue; }

  const arr = series.get(code) ?? [];
  const close = arr.length ? arr[arr.length - 1] : null;
  const ma20 = arr.length >= 20 ? arr.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const firstSeen = prevSeen.get(code) ?? today;

  entries.push({
    code,
    name: row.n,
    market: row.m,
    industry: row.ind,
    tier: s.tier,
    momentum: s.momentum,
    flags: s.flags,
    rev: f.rev,
    yoy: f.yoy,
    accel: f.accel,
    streak: f.streak,
    highMonths: f.highMonths,
    cumYoy: f.cumYoy,
    ttmYoy: f.ttmYoy,
    ...(() => {
      const mq = finNewest ? latestMarginQuarter(code, fin, finNewest) : null;
      const ser = mq ? marginSeries(code, mq, 4, fin) : [];
      const past = ser.slice(1).filter((v): v is number => v !== null);
      return {
        marginQuarter: mq,
        margin: ser[0] ?? null,
        marginQoq: ser[0] != null && ser[1] != null ? ser[0] - ser[1] : null,
        marginHigh4: ser[0] != null && past.length >= 3 ? ser[0] >= Math.max(...past) : null,
      };
    })(),
    momStreak: f.momStreak,
    allTimeHigh: f.allTimeHigh,
    sameMonthHigh: f.sameMonthHigh,
    firstSeen,
    fresh: firstSeen === today,
    price: {
      close,
      ma20,
      aboveMa20: close !== null && ma20 !== null ? close > ma20 : null,
      r20: arr.length > 20 ? arr[arr.length - 1] / arr[arr.length - 21] - 1 : null,
    },
    futures: futuresMap.get(code) ?? null,
  });
}

// 排序只是為了讓人好讀（有標記的在前、同群依代號），**不代表優先順序**。
// 兩者皆中的排最前面只是因為它最稀有，不是因為它最好——回測顯示「核心+動能」相對
// 單獨核心是 +0.64pp、t=1.25，分不出高下。部位配置請等權。
const markOrder = (e: Entry) => (e.tier === "核心" ? 0 : 2) + (e.momentum ? 0 : 1);
entries.sort((a, b) => markOrder(a) - markOrder(b) || a.code.localeCompare(b.code));

const nCore = entries.filter((e) => e.tier === "核心").length;
const nMom = entries.filter((e) => e.momentum).length;
const nBoth = entries.filter((e) => e.tier === "核心" && e.momentum).length;
const out = {
  generatedAt: twIso(),
  month: target,
  /** 這個月還在公布中，名單會繼續長大 */
  partial,
  /** 2 月的數字是 1+2 月合併值 */
  combinedJanFeb: +target.slice(5, 7) === 2,
  /** 1 月：只能用單月數字，受農曆年錯位影響，屬暫定名單 */
  provisionalJan,
  /** 這個月實際採用的 YoY 門檻，以及相對 20% 的平移量（只有 1 月會不是 0） */
  gate: Math.round(gate * 1000) / 1000,
  gateShift: Math.round(gateShift * 1000) / 1000,
  basis: {
    publishedAt: targetSnap.publishedAt,
    coverage,
    monthsAvailable: calc.window24.length,
  },
  rule: {
    gate: provisionalJan
      ? `單月營收 YoY ≥ ${(gate * 100).toFixed(1)}%（1 月依農曆年錯位自 20% 平移 ${gateShift >= 0 ? "+" : ""}${(gateShift * 100).toFixed(1)}pp）`
      : `單月營收 YoY ≥ ${(GATE_YOY * 100).toFixed(0)}%（2 月用 1+2 月合併）`,
    核心: "門檻 + 連 3 月 YoY 為正 + 單月營收創 24 個月新高",
    動能: "門檻 + 連 3 月 MoM 為正（與核心平行，可重疊）",
    配置: "等權分散，不要照名單順序集中——回測顯示門檻內排名沒有資訊",
  },
  counts: {
    門檻: entries.length, 核心: nCore, 動能: nMom, 核心且動能: nBoth, 未過門檻: belowGate,
    // 以下是「特別標註」的旗標數，不影響核心／動能兩個記號
    五年新高: entries.filter((e) => e.allTimeHigh).length,
    同期新高: entries.filter((e) => e.sameMonthHigh).length,
    毛利率成長: entries.filter((e) => e.marginQoq !== null && e.marginQoq > 0).length,
    毛利率下滑: entries.filter((e) => e.marginQoq !== null && e.marginQoq < 0).length,
    毛利率4季高: entries.filter((e) => e.marginHigh4 === true).length,
    站上月線: entries.filter((e) => e.price.aboveMa20 === true).length,
    YoY30以上: entries.filter((e) => e.yoy >= 0.3).length,
    YoY40以上: entries.filter((e) => e.yoy >= 0.4).length,
    兩年新高: entries.filter((e) => e.allTimeHigh || e.highMonths === 24).length,
    只有兩年: entries.filter((e) => !e.allTimeHigh && e.highMonths === 24).length,
    只有同月: entries.filter((e) => !e.allTimeHigh && e.highMonths !== 24 && e.sameMonthHigh).length,
    沒創高: entries.filter((e) => !e.allTimeHigh && e.highMonths !== 24 && !e.sameMonthHigh).length,
  },
  fresh: entries.filter((e) => e.fresh).length,
  filtered,
  entries,
};

if (!explicit) writeFileSync(resolve(ROOT, OUT_LATEST), JSON.stringify(out, null, 2));
mkdirSync(resolve(ROOT, OUT_HISTORY_DIR), { recursive: true });
writeFileSync(histPath, JSON.stringify(out, null, 2));


// ---------- 子頁 ----------

/** 表頭 tooltip：滑鼠移上去就看得到欄位定義，不用翻說明區 */
const COL_HELP: Record<string, string> = {
  c: "股票代號，點了開雅虎股市",
  n: "公司名稱，點了開雅虎股市",
  m: "上市或上櫃",
  ind: "公開資訊觀測站的產業分類",
  t: "標記：核心＝過門檻又連3月YoY成長又創2年新高；動能＝過門檻又連3個月MoM都在增加。兩者平行、可以同時中（顯示「核心·動能」），沒中就是門檻。66個月回測兩者分不出高下，不要當成先後順序",
  y: "年增率：本月營收 ÷ 去年同月營收 − 1。2 月用 1+2 月合併值",
  r: "當月營收，單位億元（原始資料是千元）",
  s: "YoY 連續月數：連續幾個月「年增率為正」（跟去年同月比）。看的是長期趨勢",
  ms: "MoM 連續月數：連續幾個月「比上個月增加」。看的是短期動能。注意 1 月通常比 12 月低、農曆年那個月也會掉，年初斷掉是季節性不是轉壞",
  mk: "營收創高，只寫最強的一級。5年＝近 60 個月最高（必然也是 2 年新高）；2年＝近 24 個月最高；5年同月＝前兩者沒中，但在過去 5 個相同月份裡是最高（例如今年 8 月贏過前 5 個 8 月）；— ＝都沒有。回測顯示「2 年新高以上」是最有價值的加分條件",
  a: "成長加速度，單位 pp（百分點）＝兩個百分比相減。本月 YoY 減掉前 3 個月 YoY 的平均：YoY 從 30% 變 40% 就是 +10pp。正值代表成長「變快」了；YoY 還有 40% 但上個月是 60%，這欄就是負的——成長在減速",
  gm: "已公布的最新一季單季毛利率（滑到數字上會顯示是哪一季——台股陸續申報，早報的公司會比別人新一季）＝(單季營收−單季成本)÷單季營收。MOPS 的季報是累計數，這裡已經減去上一季還原成單季。標「4季高」代表是近 4 季最高。金融保險業不適用，會留白",
  gq: "毛利率比上一季增減，單位 pp（百分點）。營收在成長但這欄是負的，代表「賣得多但賺得薄」——實測這批的表現只有毛利率同時成長那批的一半",
  ttm: "近 12 個月營收合計，跟前 12 個月合計比的年增率。比「今年累計」好用：不會在每年 1 月歸零重來，而且任何 12 個月都剛好含一次農曆年，不受過年落點影響",
  cu: "今年 1 月到本月的累計營收年增率（YTD）。⚠️ 1 月時「累計」就等於「當月」，所以每年 1 月這欄跟 YoY 完全相同、沒有額外資訊。新聞上引用的通常是這個數字",
  fu: "有沒有個股期貨，以及期交所公告的原始保證金比例（級距 1 = 13.5%、級距 2 = 16.2%、級距 3 = 20.25%；被調整保證金的個股會只顯示比例）。跟漲跌 100 名單同一來源。想做多空對沖或用期貨替代現股時看這欄",
  px: "最近一個交易日的收盤價。「站上月線」勾選看的是它是否高於最近 20 個交易日的平均收盤",
  ma: "收盤價是否站上 20 日均線。✗ 代表過去一個月偏弱",
  r20: "最近 20 根 K 棒（約一個月）的報酬率。跟「站上月線」高度重疊，篩選建議用月線勾選（見說明 ③）；這欄留著看漲了多少",
  f: "這檔第一次進本月名單的日期。公司是陸續公布的，這欄看得出它公布多久了",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 自足單頁：可排序、可篩選的名單，發佈到日報網站當子頁 /revenue.html。
 * 資料直接內嵌（幾百檔很小），不打 API、不吃外部資源——跟 cb-pledge.html 同一套做法。
 */
function renderHtml(o: typeof out): string {
  const rows = o.entries.map((e) => ({
    c: e.code, n: e.name, m: e.market === "twse" ? "上市" : "上櫃", ind: e.industry,
    // 雅虎股市連結的後綴：上市 .TW、上櫃 .TWO，跟設質+CB 子頁同一套
    sfx: e.market === "twse" ? ".TW" : ".TWO",
    t: e.tier === "核心" && e.momentum ? "核心·動能" : e.tier === "核心" ? "核心" : e.momentum ? "動能" : "門檻",
    y: e.yoy, r: e.rev, s: e.streak, h: e.highMonths,
    a: e.accel, cu: e.cumYoy, ttm: e.ttmYoy, f: e.firstSeen, nw: e.fresh ? 1 : 0,
    gqt: e.marginQuarter,
    ms: e.momStreak, ath: e.allTimeHigh ? 1 : 0, smh: e.sameMonthHigh ? 1 : 0,
    gm: e.margin, gq: e.marginQoq, g4: e.marginHigh4 === null ? null : e.marginHigh4 ? 1 : 0,
    // 「營收創高」欄的排序值，跟顯示的優先序一致：5年 3、2年 2、同月 1、無 0
    mk: e.allTimeHigh ? 3 : e.highMonths === 24 ? 2 : e.sameMonthHigh ? 1 : 0,
    px: e.price.close, ma: e.price.aboveMa20 === null ? null : e.price.aboveMa20 ? 1 : 0, r20: e.price.r20,
    // 期貨欄的排序值＝保證金比例（沒期貨為 null 排最後）；顯示用 fut 文字
    fu: e.futures ? parseFloat(e.futures.margin) : null, fut: e.futures ? [e.futures.level, e.futures.margin].filter(Boolean).join(" ") : null,
  }));
  const inds = [...new Set(o.entries.map((e) => e.industry))].sort();
  // 1 月的門檻是平移過的，卡片與下拉都必須顯示實際值，不能寫死 20%
  const g = `${(o.gate * 100).toFixed(o.gateShift ? 1 : 0)}%`;
  const partialNote = o.partial
    ? `<p class='note'>⚠️ ${o.month} 還在公布中（已收 ${o.basis.coverage} 家，全市場約 1900 家）。月營收依規定次月 10 日前公布，公司是陸續報的——這份名單接下來幾天會繼續長大。因為門檻是絕對值、不需要跟同儕比，早報的公司現在就能用跟 10 號完全相同的標準判定。</p>`
    : "";
  const janFebNote = o.combinedJanFeb
    ? "<p class='note'>ℹ️ 2 月的營收與 YoY 都是 <b>1+2 月合併值</b>——農曆年落在 1 月或 2 月每年不同，單看一個月的年增率會是假的。</p>"
    : o.provisionalJan
      ? "<p class='note'>⚠️ <b>1 月名單屬暫定</b>：1+2 月合併值要等 2 月公布才算得出來，所以這個月只能用 1 月單月數字。農曆年落在 1 月或 2 月每年不同，工作天數會整組錯位——去年農曆年在 2 月、今年在 1 月的話，今年 1 月少了好幾個工作天，YoY 會無故變難看（反之亦然）。<b>下個月的 1+2 月合併名單才是這兩個月的定論</b>，這份先當觀察用，不要照它重壓部位。</p>"
      : "";

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>月營收動能名單</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">📈</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.note{color:var(--up)}
.preset button{font-size:12px;padding:1px 8px;margin-left:4px;border:1px solid var(--chip);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.card{flex:1 1 170px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.card .cname{font-size:14px;font-weight:700;color:var(--fg)}
.card .cdesc{color:var(--muted);font-size:11.5px;line-height:1.5;margin-top:2px;flex:1}
.card b{font-size:17px;line-height:1.2;margin-top:6px}
.card.core .cname,.card.core b{color:var(--up)}
.card.total{border-color:var(--accent)}
.card.total .cname,.card.total b{color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}
.filters label{display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}
/* 篩選項的名稱：加粗＋偏冷的藍，跟旁邊的選單值分得開，但不搶眼 */
.filters .fl{font-weight:700;color:color-mix(in srgb,var(--accent) 78%,var(--muted))}
/* 產業名稱最長（「電腦及週邊設備業」），單獨縮窄，不然整列會被它擠到第二行 */
.filters #fInd{max-width:118px}
.filters select{max-width:152px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:13px}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:980px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:nth-child(-n+4),td:nth-child(-n+4){text-align:left}
th{position:sticky;top:0;background:var(--card);cursor:pointer;user-select:none;color:var(--muted);font-weight:600}
th .arr{font-size:10px}
tr:hover td{background:color-mix(in srgb,var(--accent) 6%,transparent)}
a{color:var(--accent);text-decoration:none}
.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;font-size:11px;color:var(--muted)}
.chip.core{color:#fff;background:var(--up)}
.chip.watch{color:var(--up);background:color-mix(in srgb,var(--up) 15%,transparent)}
.chip.fut{color:#4338ca;background:#e0e7ff;white-space:nowrap}
.filters .n{color:var(--muted);font-size:11px}
.filters .sep{border-left:1px solid var(--line);height:16px;align-self:center}
.hit{color:var(--up);font-weight:700}
.hit2{color:var(--accent);font-weight:600}
.none{color:var(--muted)}
td a{color:var(--accent)}
td a:hover{text-decoration:underline}
.new{display:inline-block;background:var(--down);color:#fff;border-radius:99px;padding:0 6px;font-size:10px;margin-left:4px}
.pos{color:var(--up)}.neg{color:var(--down)}
.count{margin:8px 2px;color:var(--muted);font-size:13px}
.nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.nav a{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:700;background:var(--card);color:var(--fg)}
.nav a:hover{border-color:var(--accent);color:var(--accent)}
.nav a.here{background:var(--accent);border-color:var(--accent);color:#fff}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;font-size:13px;color:var(--muted)}
details.howto summary{cursor:pointer;list-style:none;padding:10px 16px;font-size:14px;font-weight:600;color:var(--fg);user-select:none}
details.howto summary::-webkit-details-marker{display:none}
details.howto summary::before{content:"▸";display:inline-block;margin-right:8px;color:var(--accent);transition:transform .15s}
details.howto[open] summary::before{transform:rotate(90deg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto h4{margin:14px 0 4px;font-size:13px;color:var(--fg)}
details.howto h4.warn{color:var(--up)}
details.howto p{margin:4px 0}
details.howto ul{margin:4px 0;padding-left:18px}
details.howto li{margin:3px 0}
details.howto b{color:var(--fg)}
details.howto table{min-width:0;width:auto;font-size:12px;margin:6px 0}
details.sub{border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:0 12px;background:color-mix(in srgb,var(--accent) 4%,transparent)}
details.sub summary{cursor:pointer;padding:8px 0;font-weight:600;color:var(--accent);font-size:12.5px}
details.sub ol{margin:4px 0;padding-left:20px}
details.sub li{margin:3px 0}
details.howto td,details.howto th{padding:3px 10px;text-align:right}
details.howto td:first-child,details.howto th:first-child{text-align:left}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("revenue.html")}
<h1>\u{1f4c8} 月營收動能名單 · ${o.month}</h1>
<p class="sub">產生於 ${fmtTw(o.generatedAt)}（台北時間）｜已收錄 ${o.basis.coverage} 家</p>
${partialNote}${janFebNote}
<div class="cards">
<div class="card total"><span class="cname">門檻群</span><span class="cdesc">營收 YoY ≥ ${g}。及格線，下面表格裡的全部公司</span><b>${o.counts.門檻}</b></div>
<div class="card core"><span class="cname">核心</span><span class="cdesc">門檻群之中，連 3 月 YoY 成長又創 2 年新高的</span><b>${o.counts.核心}</b></div>
<div class="card core"><span class="cname">動能</span><span class="cdesc">門檻群之中，連 3 個月 MoM 都在增加的。與核心平行、可重疊</span><b>${o.counts.動能}</b></div>
<div class="card"><span class="cname">兩者皆中</span><span class="cdesc">核心與動能同時成立的。最稀有，但回測贏不過單獨核心</span><b>${o.counts.核心且動能}</b></div>
</div>
<details class="howto">
<summary>\u{1f4d6} 這張表怎麼看、篩選怎麼來的</summary>
<div class="body">

<h4>一句話：這在找營收成長的公司</h4>
<p>台灣的上市櫃公司每個月都要公布營收，規定是<b>次月 10 日前</b>。這是唯一每個月都會更新的基本面數字。這張表做的事很單純：<b>把「這個月營收比去年同月成長超過 ${g}」的公司列出來</b>。市場上隨時有三百多家達標，成長沒到這個水準，不如把錢放在有達標的公司上。</p>

<h4>先分清楚兩個詞</h4>
<ul>
<li><b>門檻</b>＝一道及格線（YoY ≥ ${g}）。沒過的公司根本不會出現在這張表。</li>
<li><b>標記</b>＝及格的公司再看它中不中兩個加分條件，各自是一個記號：
<ul>
<li><b>核心</b>：連 3 個月 YoY 都在成長，而且營收創 2 年新高</li>
<li><b>動能</b>：連 3 個月「比上個月增加」（MoM 連 3 月為正）</li>
</ul>
</li>
</ul>
<p><b>核心和動能是兩個平行的記號，不是一層包一層。</b>一檔可以同時中（表格標「核心·動能」）、也可以只中一個、或兩個都沒中（那就只是門檻群）。所以卡片的數字加起來會超過門檻群的總數，那是正常的——重疊的部分被算了兩次，「兩者皆中」那張卡就是重疊的數量。</p>
<p class="note">⚠️ 2026 年 9 月改過一次：舊版有一層「觀察群 ＝ 連 3 個月 YoY 成長」夾在中間，66 個月回測顯示它 339 家裡放行 269 家（79%），跟不篩幾乎沒差（只多賺 0.15%），所以拿掉了。取而代之的「動能」是真的有篩選力的那個條件，細節見下面第 ② 點。</p>

<h4>下面的數字是怎麼來的</h4>
<p>我拿過去 <b>66 個月</b>（2020 年 8 月 ~ 2026 年 7 月）的真實資料試跑過：假裝每個月營收公布完（11 號）就照規則買進，一個月後換下一批，看結果如何。三個欄位的意思：</p>
<ul>
<li><b>比大盤多</b>：同一段時間，這批股票的平均漲幅減掉全市場所有股票的平均漲幅。<b>+1.32% 代表大盤漲 1% 的時候這批漲 2.32%</b>。用「全市場平均」而不是加權指數當比較對象，是因為這個做法是每檔買一樣的錢。</li>
<li><b>贏的月份</b>：66 個月裡有幾個月贏過大盤（有些條件在某些月份湊不滿 5 家，那個月不列入，所以分母會小於 66）。</li>
<li><b>穩定度</b>（算式見下方摺疊）：贏得多還要贏得穩。同樣平均多賺 3%，一種是每個月都穩穩多賺 3%，另一種是這個月 +20%、下個月 −14%——後者穩定度低，抱起來很痛苦。數字越高越穩。<span class="note">（專業名稱叫 Information Ratio。實務上 1 以上就算好，我這裡的數字偏高，原因見最後一段。）</span></li>
</ul>

<details class="sub">
<summary>穩定度是怎麼算出來的？（點開看實際數字）</summary>
<p>三步，以「YoY≥20% 全部等權」為例：</p>
<ol>
<li>每個月算一次「策略報酬 − 大盤報酬」，得到 66 個超額報酬。</li>
<li>算這 66 個數字的<b>平均</b>（＝1.320%）和<b>標準差</b>（＝1.970%）。標準差就是「這些數字彼此差多遠」——每個月都差不多就小，忽好忽壞就大。</li>
<li><b>平均 ÷ 標準差 = 0.670</b>，再<b>乘以 √12 換算成年</b>（因為是月資料）→ <b>2.32</b>。</li>
</ol>
<p>直覺是：<b>分子是「賺多少」，分母是「過程有多顛簸」</b>。所以同樣多賺 3%，穩穩賺的穩定度高，大起大落的低。</p>
<table>
<tr><th>營收月</th><th>策略</th><th>大盤</th><th>超額</th></tr>
<tr><td>2020-08</td><td>+1.69%</td><td>+1.13%</td><td>+0.57%</td></tr>
<tr><td>2020-09</td><td>+2.74%</td><td>+2.22%</td><td>+0.52%</td></tr>
<tr><td>2020-10</td><td>+5.92%</td><td>+5.02%</td><td>+0.90%</td></tr>
<tr><td>2020-11</td><td>+6.95%</td><td>+5.09%</td><td>+1.86%</td></tr>
<tr><td>2020-12</td><td>-0.90%</td><td>-1.89%</td><td>+0.99%</td></tr>
<tr><td>2021-02</td><td>+15.39%</td><td>+11.28%</td><td>+4.10%</td></tr>
<tr><td>2021-03</td><td>-4.72%</td><td>-4.39%</td><td>-0.33%</td></tr>
<tr><td>2021-04</td><td>+1.86%</td><td>+1.19%</td><td>+0.67%</td></tr>
<tr><td>2021-05</td><td>+11.82%</td><td>+7.18%</td><td>+4.64%</td></tr>
<tr><td>2021-06</td><td>-5.66%</td><td>-4.25%</td><td>-1.41%</td></tr>
<tr><td>2021-07</td><td>-0.27%</td><td>-0.87%</td><td>+0.60%</td></tr>
<tr><td>2021-08</td><td>-5.11%</td><td>-2.91%</td><td>-2.20%</td></tr>
<tr><td>2021-09</td><td>+8.86%</td><td>+7.30%</td><td>+1.56%</td></tr>
<tr><td>2021-10</td><td>+5.13%</td><td>+4.49%</td><td>+0.64%</td></tr>
<tr><td>2021-11</td><td>-1.42%</td><td>+0.47%</td><td>-1.88%</td></tr>
<tr><td>2021-12</td><td>+1.05%</td><td>+0.31%</td><td>+0.75%</td></tr>
<tr><td>2022-02</td><td>+0.59%</td><td>+0.97%</td><td>-0.38%</td></tr>
<tr><td>2022-03</td><td>-4.80%</td><td>-5.37%</td><td>+0.57%</td></tr>
<tr><td>2022-04</td><td>+4.92%</td><td>+3.63%</td><td>+1.29%</td></tr>
<tr><td>2022-05</td><td>-9.18%</td><td>-8.46%</td><td>-0.72%</td></tr>
<tr><td>2022-06</td><td>+6.88%</td><td>+4.35%</td><td>+2.53%</td></tr>
<tr><td>2022-07</td><td>+3.31%</td><td>+2.81%</td><td>+0.50%</td></tr>
<tr><td>2022-08</td><td>-8.26%</td><td>-8.98%</td><td>+0.73%</td></tr>
<tr><td>2022-09</td><td>+3.29%</td><td>+3.25%</td><td>+0.04%</td></tr>
<tr><td>2022-10</td><td>+7.95%</td><td>+5.62%</td><td>+2.33%</td></tr>
<tr><td>2022-11</td><td>-1.27%</td><td>-0.21%</td><td>-1.06%</td></tr>
<tr><td>2022-12</td><td>+6.20%</td><td>+4.50%</td><td>+1.70%</td></tr>
<tr><td>2023-02</td><td>+7.51%</td><td>+4.05%</td><td>+3.46%</td></tr>
<tr><td>2023-03</td><td>+3.49%</td><td>-1.44%</td><td>+4.93%</td></tr>
<tr><td>2023-04</td><td>+11.41%</td><td>+7.13%</td><td>+4.28%</td></tr>
<tr><td>2023-05</td><td>+4.29%</td><td>+1.40%</td><td>+2.89%</td></tr>
<tr><td>2023-06</td><td>-4.28%</td><td>-3.83%</td><td>-0.45%</td></tr>
<tr><td>2023-07</td><td>+2.03%</td><td>+0.78%</td><td>+1.24%</td></tr>
<tr><td>2023-08</td><td>-0.54%</td><td>+0.33%</td><td>-0.87%</td></tr>
<tr><td>2023-09</td><td>+2.40%</td><td>+0.63%</td><td>+1.77%</td></tr>
<tr><td>2023-10</td><td>+6.87%</td><td>+7.09%</td><td>-0.23%</td></tr>
<tr><td>2023-11</td><td>-1.36%</td><td>-0.18%</td><td>-1.17%</td></tr>
<tr><td>2023-12</td><td>+5.35%</td><td>+2.44%</td><td>+2.91%</td></tr>
<tr><td>2024-02</td><td>+4.36%</td><td>+3.37%</td><td>+0.99%</td></tr>
<tr><td>2024-03</td><td>+1.70%</td><td>+0.91%</td><td>+0.79%</td></tr>
<tr><td>2024-04</td><td>+5.47%</td><td>+4.27%</td><td>+1.20%</td></tr>
<tr><td>2024-05</td><td>+8.78%</td><td>+6.06%</td><td>+2.72%</td></tr>
<tr><td>2024-06</td><td>-9.79%</td><td>-7.95%</td><td>-1.85%</td></tr>
<tr><td>2024-07</td><td>+0.60%</td><td>-0.27%</td><td>+0.88%</td></tr>
<tr><td>2024-08</td><td>+4.66%</td><td>+3.37%</td><td>+1.30%</td></tr>
<tr><td>2024-09</td><td>+1.75%</td><td>+0.53%</td><td>+1.22%</td></tr>
<tr><td>2024-10</td><td>-1.41%</td><td>-1.95%</td><td>+0.54%</td></tr>
<tr><td>2024-11</td><td>-6.55%</td><td>-5.97%</td><td>-0.58%</td></tr>
<tr><td>2024-12</td><td>+6.77%</td><td>+6.06%</td><td>+0.72%</td></tr>
<tr><td>2025-02</td><td>-19.83%</td><td>-17.73%</td><td>-2.10%</td></tr>
<tr><td>2025-03</td><td>+14.99%</td><td>+11.43%</td><td>+3.56%</td></tr>
<tr><td>2025-04</td><td>+3.88%</td><td>+0.47%</td><td>+3.41%</td></tr>
<tr><td>2025-05</td><td>+0.24%</td><td>-1.87%</td><td>+2.12%</td></tr>
<tr><td>2025-06</td><td>+6.96%</td><td>+2.78%</td><td>+4.17%</td></tr>
<tr><td>2025-07</td><td>+6.61%</td><td>+2.80%</td><td>+3.81%</td></tr>
<tr><td>2025-08</td><td>+1.15%</td><td>+0.35%</td><td>+0.80%</td></tr>
<tr><td>2025-09</td><td>+0.85%</td><td>-1.31%</td><td>+2.16%</td></tr>
<tr><td>2025-10</td><td>+2.31%</td><td>+1.51%</td><td>+0.80%</td></tr>
<tr><td>2025-11</td><td>+8.47%</td><td>+4.07%</td><td>+4.40%</td></tr>
<tr><td>2025-12</td><td>+1.64%</td><td>+0.53%</td><td>+1.11%</td></tr>
<tr><td>2026-02</td><td>+10.00%</td><td>+3.63%</td><td>+6.37%</td></tr>
<tr><td>2026-03</td><td>+13.75%</td><td>+6.14%</td><td>+7.61%</td></tr>
<tr><td>2026-04</td><td>+4.36%</td><td>+2.29%</td><td>+2.07%</td></tr>
<tr><td>2026-05</td><td>+2.93%</td><td>+2.01%</td><td>+0.92%</td></tr>
<tr><td>2026-06</td><td>-4.72%</td><td>-4.26%</td><td>-0.46%</td></tr>
<tr><td>2026-07</td><td>-0.25%</td><td>-0.46%</td><td>+0.21%</td></tr>
</table>
<p>（每年 1 月不在表上——農曆年錯位不可比，回測一律跳過。2021-01 之前的月份也不在，因為營收歷史從 2019-06 起算，前 14 個月要拿去算「連續成長月數」與「24 個月新高」這些回看指標。）</p>
</details>

<h4>為什麼沒有分數、沒有排名</h4>
<p>我試過幫每檔打分再挑前 15 名，結果<b>比隨機亂抽 15 檔還差</b>：按 YoY 高低挑前 15 名多賺 0.78%、穩定度 0.47，66 個月只贏 56%；隨機亂抽 15 檔是多賺 1.32%、穩定度 2.30，跟「全部等權」的 1.32% 一模一樣。按加速度挑前 15 名多賺 1.83% 看起來比較高，但穩定度只有 1.11、贏的月份也是 56%——多賺的部分被顛簸吃掉了。</p>
<p>原因是「YoY 特別高」常常不是公司變強，而是<b>去年同期特別爛</b>（基期效應）。挑最高的那批，等於專挑這種假成長。</p>
<p><b>→ 所以這張表不打分數。</b>表格排序只是方便你看，不是推薦順序。<b>要買就每檔買一樣的錢、分散買</b>，不要照表格從上往下挑幾檔。</p>

<h4>下拉選單是怎麼定出來的</h4>

<p><b>① YoY 門檻：預設 20%</b></p>
<table>
<tr><th>門檻</th><th>家數</th><th>比大盤多</th><th>贏的月份</th><th>穩定度</th></tr>
<tr><td><b>20%（預設）</b></td><td>339</td><td>+1.32%</td><td>51/66</td><td><b>2.32</b></td></tr>
<tr><td>30%</td><td>235</td><td>+1.51%</td><td>51/66</td><td>2.17</td></tr>
<tr><td>40%</td><td>168</td><td>+1.64%</td><td>47/66</td><td>2.04</td></tr>
<tr><td>50%</td><td>124</td><td><b>+1.69%</b></td><td>47/66</td><td>1.87</td></tr>
</table>
<p>門檻拉越高，<b>平均是多賺一點沒錯</b>（1.32% → 1.69%），<b>但穩定度一路掉</b>（2.32 → 1.87），贏的月份也從 51/66 掉到 47/66。多賺的那 0.4% 是拿「忽好忽壞」換來的。<b>拉高門檻主要換到的是「檔數變少」，不是「賺得更穩」。</b>預設留在 20%，是因為它的穩定度最高、而且三百多家夠分散。</p>
<p class="note">⚠️ 這張表在 2026 年 9 月用 66 個月重算過（修正了股價快取缺上市股的問題）。舊版用 18 個月，當時的結論是「拉到 40% 以上就不會再多賺、80% 反而變差」——樣本拉長之後<b>那個轉折不見了</b>，超額其實是單調上升的。這就是 18 個月太短的例子。</p>

<p><b>② 營收創高：「2 年新高」最有用</b></p>
<table>
<tr><th>及格（20%）之後再加上…</th><th>家數</th><th>比大盤多</th><th>贏的月份</th><th>穩定度</th></tr>
<tr><td class="pos"><b>MoM 連 3 月正成長（＝動能）</b></td><td>56</td><td class="pos"><b>+2.72%</b></td><td>48/65</td><td>2.10</td></tr>
<tr><td>創 2 年新高</td><td>129</td><td>+2.28%</td><td>47/61</td><td>2.17</td></tr>
<tr><td><b>創 2 年新高 ＋ YoY 連 3 月（＝核心）</b></td><td>110</td><td><b>+2.20%</b></td><td>46/61</td><td>2.16</td></tr>
<tr><td>創 5 年新高</td><td>56</td><td>+2.07%</td><td>26/36</td><td>1.85</td></tr>
<tr><td>同月新高</td><td>199</td><td>+1.72%</td><td>33/46</td><td><b>2.52</b></td></tr>
<tr><td>YoY 連 3 個月成長</td><td>269</td><td>+1.47%</td><td>50/66</td><td>2.22</td></tr>
<tr><td class="note">（不篩，全部及格的）</td><td>339</td><td>+1.32%</td><td>51/66</td><td>2.32</td></tr>
<tr><td class="note">完全沒創新高</td><td>140</td><td>+0.57%</td><td>42/66</td><td>0.96</td></tr>
</table>
<p><b>最有用的是「MoM 連 3 月正成長」</b>——多賺 2.72%，是所有單一條件裡最高的，也是<b>動能</b>這個記號的來源。「創 2 年新高 ＋ YoY 連 3 月」就是<b>核心</b>，多賺 2.20%。</p>
<p>兩者<b>分不出高下</b>：拿同一個月份相減比較，「MoM 連 3 月＋2 年新高」比核心多 0.63%、但統計上不顯著（t=1.44）；把兩個疊起來也沒有可證實的增量。<b>所以它們是平行的兩個記號，不是誰包含誰、也不是誰比較好。</b></p>
<p>相對地，<b>「YoY 連 3 個月成長」幾乎沒有篩選力</b>——339 家裡放行 269 家（79%），只多賺 0.15%。這也是為什麼它<b>沒有獨立成一個勾選項</b>：它已經是核心的條件之一，單獨拿出來幾乎等於不篩。舊版拿它當「觀察群」是個錯誤，已經拿掉。</p>
<p>最後一列才是真正的對照組：<b>完全沒創新高的那 140 家只多賺 0.57%、穩定度 0.96</b>。「營收有沒有創新高」是這裡最乾淨的分水嶺。</p>
<p class="note">⚠️ 這張表在 2026 年 9 月用 66 個月重算過。<b>MoM 連 1 月、連 2 月確實沒有資訊</b>：同月相減，連 2 月相對 0 月只多 0.24%（t=0.63）、連 1 月只多 0.13%（t=0.39）。門檻設在 3 是因為資訊集中在那裡，是懸崖不是斜坡。</p>

<p><b>③ 股價位置：只留「站上月線」的，但不要避開漲多的</b></p>
<p>常見的直覺是「已經漲多的，接下來比較容易跌」。用<b>乖離率</b>（進場當天收盤 ÷ 20 日均線 − 1）實測 66 個月，結果剛好相反：</p>
<table>
<tr><th>門檻群，買進當天的乖離</th><th>家數</th><th>比大盤多</th><th>贏的月份</th><th>穩定度</th></tr>
<tr><td>（不篩）</td><td>339</td><td>+1.32%</td><td>51/66</td><td>2.32</td></tr>
<tr><td><b>跌破月線（&lt;0%）</b></td><td>140</td><td><b>+0.20%</b></td><td><b>36/66</b></td><td><b>0.32</b></td></tr>
<tr><td>0~5%</td><td>112</td><td>+1.25%</td><td>45/66</td><td>2.37</td></tr>
<tr><td>5~10%</td><td>45</td><td>+1.84%</td><td>45/65</td><td>1.91</td></tr>
<tr><td>10~15%</td><td>20</td><td>+3.63%</td><td>40/59</td><td>1.57</td></tr>
<tr><td>15~20%</td><td>12</td><td>+5.55%</td><td>27/39</td><td>2.01</td></tr>
<tr><td>20% 以上</td><td>14</td><td>+3.96%</td><td>26/43</td><td>1.18</td></tr>
<tr class="pos"><td><b>站上月線（≥0%）</b></td><td>193</td><td class="pos"><b>+1.87%</b></td><td>53/66</td><td class="pos"><b>2.49</b></td></tr>
</table>
<p><b>乖離越大、多賺越多</b>，沒有「漲多就變差」這回事——營收爆發股的強勢是動能在延續，不是過熱反轉。真正差的是<b>跌破月線的那 140 家：只多賺 0.20%、66 個月只贏 36 個月，跟擲硬幣差不多</b>。「營收好但股價不動」通常代表市場不買帳。</p>
<p>放到預設的「核心 × 毛利率成長」上也一樣：</p>
<table>
<tr><th>核心 × 毛利率成長，再加上…</th><th>家數</th><th>比大盤多</th><th>贏的月份</th><th>穩定度</th></tr>
<tr><td>（不加）</td><td>63</td><td>+3.00%</td><td>43/61</td><td>2.30</td></tr>
<tr class="pos"><td><b>站上月線</b></td><td>42</td><td class="pos"><b>+3.49%</b></td><td>44/59</td><td class="pos"><b>2.33</b></td></tr>
<tr><td>跌破月線</td><td>30</td><td>+1.64%</td><td>24/44</td><td>0.81</td></tr>
<tr><td>乖離 &lt; 10%（避開漲多）</td><td>52</td><td>+2.30%</td><td>41/60</td><td>1.69</td></tr>
<tr><td>站上月線但乖離 &lt; 10%</td><td>31</td><td>+2.57%</td><td>41/57</td><td>1.80</td></tr>
</table>
<p><b>→ 所以多了一個「站上月線」勾選，預設打勾。</b>「避開漲多」的上限（乖離 &lt;10%、&lt;15%）三項都變差，所以<b>沒有做成選項</b>。20 日報酬下拉還留著方便看，但它跟月線高度重疊，建議用月線就好。本益比也測過（PE&lt;15、&lt;20），一樣是低本益比那批最差，沒有加進來。</p>
<p class="note">乖離用的是還沒還原除權息的收盤價，除息日附近會略為低估。乖離 10% 以上各格只有 13~23 個月湊得滿 5 檔，數字別太當真，但方向都一致。</p>

<p><b>④ 毛利率：營收成長但毛利被殺，是純看營收最大的陷阱</b></p>
<p>月營收只告訴你「賣了多少」，沒說「賺不賺錢」。靠降價衝量的公司營收會很漂亮，毛利率卻在掉。所以我用季報的<b>單季毛利率</b>測了一次（66 個月，2020-08 ~ 2026-07）：</p>
<table>
<tr><th>YoY≥20% 再加上…</th><th>家數</th><th>比大盤多</th><th>贏的月份</th><th>穩定度</th></tr>
<tr><td>（不加）</td><td>339</td><td>+1.32%</td><td>51/66</td><td><b>2.32</b></td></tr>
<tr><td>毛利率比上季成長</td><td>185</td><td>+1.58%</td><td>50/66</td><td>2.19</td></tr>
<tr><td>毛利率比上季下滑</td><td>143</td><td>+1.06%</td><td>45/66</td><td>1.99</td></tr>
<tr><td>毛利率創 4 季新高</td><td>119</td><td>+1.56%</td><td>49/66</td><td>1.84</td></tr>
</table>
<p>在整個門檻群裡，毛利率<b>差得不多</b>（升與降差 0.5pp）。它的資訊集中在核心群：</p>
<table>
<tr><th></th><th>家數</th><th>比大盤多</th><th>贏的月份</th><th>穩定度</th></tr>
<tr><td>核心群</td><td>110</td><td>+2.20%</td><td>46/61</td><td>2.16</td></tr>
<tr><td><b>核心群 ＋ 毛利率成長</b></td><td>63</td><td class="pos"><b>+3.00%</b></td><td>43/61</td><td class="pos"><b>2.30</b></td></tr>
<tr><td><b>核心群 ＋ 毛利率創4季新高</b></td><td>43</td><td class="pos"><b>+3.05%</b></td><td>42/60</td><td>1.99</td></tr>
<tr><td><b>核心群 ＋ 毛利率下滑</b></td><td>44</td><td><b>+1.21%</b></td><td>35/60</td><td>1.17</td></tr>
</table>
<p><b>同樣是核心群，毛利率下滑的只多賺 +1.21%，毛利率成長的有 +3.00%——差兩倍多。</b>「營收成長但毛利被殺」的陷阱是真的。</p>
<p class="note">⚠️ 這張表在 2026 年 9 月用 66 個月重算過。舊版 18 個月的數字是核心群＋毛利率成長 +5.29% vs 下滑 +2.41%——方向一樣，但穩定度從 3.83 降到 2.30。18 個月那段剛好是多頭，數字偏樂觀。</p>
<p><b>順便測了營業利益率（OPM）。</b>有人會說毛利率不夠，要看營業利益率——多扣營業費用，才能濾掉「毛利虛胖、費用暴增」的公司。實測不成立：</p>
<table>
<tr><th>核心群 ＋…</th><th>家數</th><th>比大盤多</th><th>贏的月份</th><th>穩定度</th></tr>
<tr><td>OPM 比上季成長</td><td>66</td><td>+2.55%</td><td>43/61</td><td>1.88</td></tr>
<tr><td>OPM 比上季下滑</td><td>41</td><td>+1.90%</td><td>40/60</td><td>2.06</td></tr>
<tr><td>毛利率成長 ＋ OPM 成長</td><td>56</td><td>+3.12%</td><td>44/60</td><td>2.04</td></tr>
<tr><td><b>毛利率成長 ＋ OPM 下滑</b></td><td>13</td><td class="pos"><b>+3.18%</b></td><td>20/33</td><td>1.79</td></tr>
<tr><td>OPM 比去年同季成長</td><td>75</td><td>+2.39%</td><td>42/60</td><td>1.97</td></tr>
<tr><td>OPM 比去年同季下滑</td><td>33</td><td>+1.96%</td><td>38/58</td><td>2.05</td></tr>
</table>
<p>OPM 升與降只差 0.65pp，比毛利率（1.8pp）弱得多，而且 OPM 下滑那批反而比較穩。關鍵那一格：<b>「毛利率成長但 OPM 下滑」是 +3.18%，不輸「兩個都成長」的 +3.12%</b>（樣本小，只有 33 個月有夠多檔數，不能說它更好，但至少不是要濾掉的那批）。營收在衝、費用同步擴張，多半是在招人備產能，不是失控。<b>→ 所以 OPM 沒有加進來，毛利率才是要看的那個。</b></p>
<p><b>→ 所以：</b>多了「毛利率」「毛利率增減」兩欄和一個毛利率下拉。<b>但它沒有變成核心或動能的條件</b>——這兩個標記每個月更新，財報一季才一次、還有兩個半月時滯，把季頻資料綁進月頻標記會讓它們的意義變得不一致。建議用法：<b>先用「標記」選核心，再把毛利率切到「比上季成長」。</b></p>
<p class="note">兩個技術細節：①MOPS 的季報是<b>累計數</b>（Q2 是上半年合計），這裡已減去上一季還原成單季，否則會把 Q1 的獲利重複算進 Q2。②財報有公布時滯（申報期限：Q1 到 5/15、Q2 到 8/14、Q3 到 11/14、年報到次年 3/31）。<b>回測只用「當時申報期限已過」的那一季</b>，否則會憑空多出好幾週的資訊優勢；<b>但這個頁面看的是今天，已經公布的就直接用最新的</b>，而且是逐檔判斷——台股是陸續申報的，期限前後那幾週有些公司報了、有些還沒，早報的公司這裡就會比別人新一季（滑到毛利率數字上會顯示是哪一季）。金融保險業損益結構不同，算不出可比的毛利率，那兩欄會留白。</p>

<p><b>⑤ 預設值：288 組下拉組合裡挑一組</b></p>
<p>上面 ①～④ 是一次動一個條件。把「YoY 門檻（4 檔）× 標記（4 種）× 營收創高（3 種）× 毛利率（3 種）× 月線（2 種）」全部排列組合，288 組各跑一次 66 個月回測。<b>選法不是報酬最高</b>——條件疊越多、檔數越少，越容易被幾檔飆股撐出漂亮數字。門檻是：平均至少 15 檔（要能分散）、有效月份 ≥ 50、<b>前半段與後半段的超額都要是正的</b>（一半靠運氣的淘汰），剩下的按穩定度排。</p>
<table>
<tr><th>合格組合（依穩定度）</th><th>家數</th><th>比大盤多</th><th>贏的月份</th><th>穩定度</th><th>前半 / 後半</th></tr>
<tr><td>≥40% × 門檻群 × 站上月線</td><td>101</td><td>+2.50%</td><td>47/66</td><td>2.63</td><td>+2.24% / +2.75%</td></tr>
<tr><td>≥30% × 門檻群 × 站上月線</td><td>138</td><td>+2.22%</td><td>49/66</td><td>2.59</td><td>+2.03% / +2.40%</td></tr>
<tr><td>2年新高 × 毛利率成長 × 站上月線</td><td>47</td><td><b>+3.57%</b></td><td>43/60</td><td>2.51</td><td>+3.41% / +3.70%</td></tr>
<tr><td>門檻群 × 站上月線</td><td>193</td><td>+1.87%</td><td>53/66</td><td>2.49</td><td>+1.66% / +2.08%</td></tr>
<tr><td>核心 × 站上月線</td><td>69</td><td>+2.85%</td><td>42/61</td><td>2.40</td><td>+2.86% / +2.84%</td></tr>
<tr class="pos"><td><b>核心 × 毛利率成長 × 站上月線（預設）</b></td><td>42</td><td><b>+3.49%</b></td><td>44/59</td><td><b>2.33</b></td><td>+2.94% / +3.96%</td></tr>
<tr><td>門檻群（什麼都不篩）</td><td>339</td><td>+1.32%</td><td>51/66</td><td>2.32</td><td>+1.09% / +1.55%</td></tr>
<tr><td>核心 × 毛利率成長（舊預設）</td><td>63</td><td>+3.00%</td><td>43/61</td><td>2.30</td><td>+2.44% / +3.48%</td></tr>
</table>
<p>前幾名的穩定度都擠在 2.3~2.6 之間，差距在雜訊範圍內，<b>真正拉開的是報酬</b>。排第一的「≥40% × 門檻群 × 站上月線」靠的是拉高 YoY 門檻，但 ① 單獨看拉高門檻是讓穩定度變差的，所以不拿它當預設。預設選的是<b>多賺最多的那一群裡、前後半段都成立的</b>：「核心 × 毛利率成長 × 站上月線」多賺 +3.49%、贏 44/59 個月，比舊預設多賺約 0.5%、穩定度也略高。</p>
<p>值得一提的是「2年新高 × 毛利率成長 × 站上月線」（不要求 YoY 連 3 月）是 +3.57%、穩定度 2.51，跟預設幾乎一樣——再次說明核心裡「YoY 連 3 月」那個條件幾乎沒在篩。</p>
<p>對照組——<b>報酬最高的那幾組長什麼樣</b>：「≥50% × 動能 × 2年新高 × 毛利率4季高 × 站上月線」多賺 +8.83%，但平均只有 10 檔、只有 22 個月湊得出 5 檔以上，前半段 +12.74%、後半段掉到 +6.13%。這種就是過度配適：數字漂亮是因為樣本小，不是規則強。所有帶「5 年新高」的組合前半段都是空的（2020~2023 沒幾檔創 5 年新高），根本沒辦法驗證。</p>
<p class="note">⚠️ 這是 in-sample 挑出來的，前後半段一致只能降低、不能消除過度配適的疑慮。想看全部門檻群，按上面的「看全部門檻群」。</p>

<h4>欄位怎麼讀</h4>
<p>表頭可以點著排序，滑鼠移上去有完整說明。幾個容易誤會的：</p>
<ul>
<li><b>YoY連續月</b>＝連續幾個月「跟去年同月比是成長的」，看長期趨勢。<b>MoM連續月</b>＝連續幾個月「比上個月多」，看短期動能。⚠️ 1 月通常比 12 月低、過年那個月也會掉，所以 MoM 在年初斷掉是季節性，不是公司變差。</li>
<li><b>加速度 (pp)</b>＝本月 YoY 減掉前 3 個月 YoY 的平均，代表成長「是不是變快了」。<b>pp 是「百分點」</b>——兩個百分比相減的單位：YoY 從 30% 變成 40% 是 <b>+10pp</b>，不是 +10%（40÷30 才是 +33%）。<b>YoY 還有 40%、但上個月是 60%，這欄就是負的</b>——成長在減速，即使數字看起來還很漂亮。</li>
<li><b>營收創高</b>只寫最強的一級：<b>5年</b>（近 60 個月最高）＞ <b>2年</b>（近 24 個月最高）＞ <b>5年同月</b>（前兩者沒中，但贏過過去 5 個相同月份，例如今年 8 月贏過前 5 個 8 月）＞ <b>—</b>（都沒有）。</li>
<li><b>近12月YoY</b>＝最近 12 個月營收總和 vs 前 12 個月總和。<b>不會在 1 月歸零</b>，而且任何 12 個月都剛好含一次農曆年，不受過年落點影響。</li>
<li><b>今年累計YoY</b>＝今年 1 月到本月的累計年增率，新聞引用的通常是這個。⚠️ <b>每年 1 月它就等於當月 YoY</b>（只累計了一個月），2 月以後才有意義。</li>
<li>上面兩個累計欄位<b>只是參考，沒有進篩選規則</b>——實測都不會讓結果變好（「累計YoY&gt;0」多 2.24%、穩定度 3.14；「近12月YoY&gt;0」是 2.35%、3.10；完全不篩反而 2.27%、穩定度 3.28 最高）。</li>
<li><b>首次進榜</b>＝這檔第一次出現在本月名單的日期。公司是陸續公布的，看得出它公布多久了。</li>
</ul>

<h4>怎麼用這張表</h4>
<ul>
<li><b>分散、每檔買一樣的錢。</b>不要照排序從上往下挑幾檔。要縮小名單就用「標記」下拉選核心或動能，不要在同一群裡再挑。</li>
<li><b>不要在營收公布當天追高。</b>等它回檔到 MA10 沒破再進，或整理個 3~5 天後突破公布日高點再進。</li>
<li><b>停損</b>：收盤跌破 MA20，或賠 8%，先到先算。</li>
<li><b>抱到下個月營收公布再重新篩一次。</b>如果它掉出名單（YoY 跌破門檻），那是「當初買的理由不成立了」，該賣——這跟股價跌了要不要停損是兩回事。</li>
</ul>

<h4>幾個容易踩的坑</h4>
<ul>
<li><b>月營收 ≠ 賺錢。</b>光看營收抓不到「營收成長但毛利被殺」——這是純營收策略最大的盲點。現在可以用「毛利率」下拉補上（見 ④），但財報一季一次、還有時滯，補得沒有營收即時。</li>
<li><b>過年會搞亂 1、2 月。</b>農曆年有時在 1 月有時在 2 月，工作天數整個錯位。所以 <b>2 月一律用「1 月+2 月合計」來算</b>；1 月照樣出名單，但門檻會自動調整（因為 1 月全市場的 YoY 中位數曾經從 +0.8% 跳到 +19.4%，跟公司好壞無關），而且要等 2 月的合計數字才算定論。</li>
<li>已經排除掉的：月營收不到 1 億、去年同月不到 3000 萬（分母太小，YoY 會失真）、建材營造（認列方式讓月營收本來就跳來跳去）、創新板（一般人買不到）。金融保險本來就不公布月營收。</li>
</ul>

<h4 class="warn">⚠️ 這些數字要打折看</h4>
<p>上面的「穩定度」動不動就 2 以上，這在真實世界高得不合理（專業機構長期做到 1 就很好了）。原因：</p>
<ul>
<li><b>66 個月裡多頭占多數</b>（同期全市場平均每月漲 1.10%），只經歷過 2022 年一段空頭。多頭本來就對這種「追成長」的做法特別友善。</li>
<li><b>沒算手續費和滑價。</b>每個月換一次股，成本會實際吃掉一部分。</li>
<li><b>中途下市的公司被自動排除了</b>，等於自動跳過最慘的那批，所以報酬被高估。</li>
<li><b>「隨機抽 15 檔」是抽 500 次的平均</b>，把運氣平均掉了。真的只買 15 檔，波動會大得多。</li>
</ul>
<p>所以這些數字的用途是<b>「規則 A 和規則 B 哪個好」</b>，<b>不是</b>「照做可以賺這麼多」。</p>

</div>
</details>
<div class="filters">
<label><span class="fl">營收 YoY</span> <select id="fYoy">
<option value="${o.gate}">≥ ${g}</option>
${[0.3, 0.4, 0.5].filter((v) => v > o.gate).map((v) => `<option value="${v}">≥ ${(v * 100).toFixed(0)}%</option>`).join("")}
</select></label>
<label><span class="fl">標記</span> <select id="fTier">
<option value="核心·動能,核心,動能,門檻">門檻群 ${o.counts.門檻}</option>
<option value="核心·動能,核心" selected>核心 ${o.counts.核心}</option>
<option value="核心·動能,動能">動能 ${o.counts.動能}</option>
<option value="核心·動能">兩者皆中 ${o.counts.核心且動能}</option>
</select></label>
<label><span class="fl">營收創高</span> <select id="fHigh">
<option value="">不限</option>
<option value="h24">2年以上 ${o.counts.兩年新高}</option>
<option value="ath">5年 ${o.counts.五年新高}</option>
<option value="only24">只有2年 ${o.counts.只有兩年}</option>
<option value="smh">5年同月 ${o.counts.只有同月}</option>
<option value="none">沒創高 ${o.counts.沒創高}</option>
</select></label>
<label><span class="fl">毛利率</span> <select id="fGm">
<option value="">不限</option>
<option value="up" selected>比上季成長 ${o.counts.毛利率成長}</option>
<option value="high4">創4季新高 ${o.counts.毛利率4季高}</option>
<option value="down">比上季下滑 ${o.counts.毛利率下滑}</option>
</select></label>
<label><span class="fl">20日報酬</span> <select id="fR20">
<option value="">不限</option>
<option value="best">漲10~25%</option>
<option value="up">上漲</option>
<option value="mild">漲0~10%</option>
<option value="hot">漲超過25%</option>
<option value="down">下跌</option>
</select></label>
<label><span class="fl">產業</span> <select id="fInd"><option value="">全部</option>${inds.map((i) => `<option>${esc(i)}</option>`).join("")}</select></label>
<label><input type="checkbox" id="fMa" checked><span class="fl">站上月線 ${o.counts.站上月線}</span></label>
<label><input type="checkbox" id="fMom"><span class="fl">MoM連3月</span></label>
<label><input type="checkbox" id="fFut"><span class="fl">有期貨</span></label>
<label><input type="checkbox" id="fNew"><span class="fl">今日新到</span></label>
</div>
<div class="count" id="count"></div>
<p class="sub preset">預設已套用「核心 × 毛利率比上季成長 × 站上月線」——66 個月回測多賺最多、且前後半段都成立的那組（見說明 ③ ⑤）。<button type="button" id="fReset">還原預設</button> <button type="button" id="fAll">看全部門檻群</button></p>
<div class="tablebox"><table id="t">
<thead><tr>
${[["名稱", "n"], ["期貨", "fu"], ["產業", "ind"], ["標記", "t"], ["YoY", "y"], ["YoY連續月", "s"], ["MoM連續月", "ms"], ["營收創高", "mk"], ["加速度 (pp)", "a"], ["毛利率", "gm"], ["毛利率增減 (pp)", "gq"], ["近12月YoY", "ttm"], ["今年累計YoY", "cu"], ["股價", "px"], ["20日報酬", "r20"], ["首次進榜", "f"]]
    .map(([label, key]) => `<th data-k="${key}" title="${esc(COL_HELP[key] ?? label)}">${label}<span class="arr"></span></th>`)
    .join("")}
</tr></thead><tbody></tbody></table></div>
<p class="sub" style="margin-top:10px">資料來源：公開資訊觀測站月營收統計表（t21sc03）。本頁不構成投資建議。</p>
</div>
<script>
const DATA = ${JSON.stringify(rows)};
const tb = document.querySelector("#t tbody"), cnt = document.getElementById("count");
let sortK = null, sortDir = -1;
const yh = d => "https://tw.stock.yahoo.com/quote/" + d.c + d.sfx;
/** 20 日報酬級距篩選。級距是回測跑出來的，不是隨手切的——見本頁說明。 */
const r20ok = (d, mode) => {
  if (!mode) return true;
  if (d.r20 == null) return false;
  if (mode === "best") return d.r20 > 0.10 && d.r20 <= 0.25;
  if (mode === "up") return d.r20 > 0;
  if (mode === "mild") return d.r20 > 0 && d.r20 <= 0.10;
  if (mode === "hot") return d.r20 > 0.25;
  if (mode === "down") return d.r20 <= 0;
  return true;
};
/**
 * 營收創高的顯示文字。5 年新高必然也是 2 年新高，所以只寫最強的那一級，
 * 再把「同月」接在後面——同月新高跟前兩者是不同維度（只跟歷年同一個月比），
 * 可以同時成立。總共就 5 種組合：5年 / 5年·同月 / 2年 / 2年·同月 / 同月 / 否。
 */
/**
 * 「營收創高」下拉。除了 h24（含 5 年，回測看的就是這一組）之外，
 * 其餘選項都跟欄位顯示的那一級一致，看到什麼就篩到什麼。
 */
/** 毛利率篩選。沒有財報資料（如金融業、新上市）的一律排除，寧可漏掉也不要當成通過。 */
const gmOk = (d, mode) => {
  if (!mode) return true;
  if (mode === "up") return d.gq != null && d.gq > 0;
  if (mode === "down") return d.gq != null && d.gq < 0;
  if (mode === "high4") return d.g4 === 1;
  return true;
};
const highOk = (d, mode) => {
  if (!mode) return true;
  if (mode === "h24") return d.ath || d.h === 24;
  if (mode === "ath") return !!d.ath;
  if (mode === "only24") return !d.ath && d.h === 24;
  if (mode === "smh") return !d.ath && d.h !== 24 && !!d.smh;
  if (mode === "none") return !d.ath && d.h !== 24 && !d.smh;
  return true;
};
const highText = d =>
  d.ath ? '<span class="hit">5年</span>'
  : d.h === 24 ? '<span class="hit">2年</span>'
  : d.smh ? '<span class="hit2">5年同月</span>'
  : '<span class="none">—</span>';
const pc = v => v == null ? "—" : '<span class="' + (v > 0 ? "pos" : "neg") + '">' + (v > 0 ? "+" : "") + (v * 100).toFixed(1) + "%</span>";
function view() {
  const tiers = document.getElementById("fTier").value.split(",");
  const ind = document.getElementById("fInd").value;
  const minYoy = parseFloat(document.getElementById("fYoy").value);
  const onlyNew = document.getElementById("fNew").checked;
  const r20Mode = document.getElementById("fR20").value;
  const gmMode = document.getElementById("fGm").value;
  const onlyMom = document.getElementById("fMom").checked;
  const onlyMa = document.getElementById("fMa").checked;
  const onlyFut = document.getElementById("fFut").checked;
  const highMode = document.getElementById("fHigh").value;
  let rows = DATA.filter(d => tiers.includes(d.t) && d.y >= minYoy && (!ind || d.ind === ind) &&
    (!onlyNew || d.nw) && r20ok(d, r20Mode) &&
    (!onlyMom || d.ms >= 3) && (!onlyMa || d.ma === 1) && (!onlyFut || d.fut) && highOk(d, highMode) && gmOk(d, gmMode));
  if (sortK) rows.sort((a, b) => {
    const x = a[sortK], y = b[sortK];
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir;
  });
  cnt.textContent = rows.length + " 檔" + (sortK ? "（已依欄位排序——提醒：門檻內名次沒有資訊，不要照順序集中買）" : "");
  tb.innerHTML = rows.map(d =>
    '<tr><td><a href="' + yh(d) + '" target="_blank" rel="noopener">' + d.n + "</a>" + (d.nw ? '<span class="new">新</span>' : "") + "</td><td>" + (d.fut ? '<span class="chip fut">' + d.fut + "</span>" : '<span class="none">—</span>') + "</td><td>" + d.ind +
    '</td><td><span class="chip ' + (d.t.startsWith("核心") ? "core" : d.t === "動能" ? "watch" : "") + '">' + d.t + "</span></td><td>" + pc(d.y) +
    "</td><td>" + d.s +
    "</td><td>" + (d.ms >= 3 ? '<span class="hit">' + d.ms + "</span>" : d.ms) +
    "</td><td>" + highText(d) +
    "</td><td>" + (d.a == null ? "—" : '<span class="' + (d.a > 0 ? "pos" : "neg") + '">' + (d.a > 0 ? "+" : "") + (d.a * 100).toFixed(0) + "</span>") +
    "</td><td" + (d.gqt ? ' title="' + d.gqt + ' 單季"' : "") + ">" + (d.gm == null ? "—" : (d.gm * 100).toFixed(1) + "%" + (d.g4 ? '<span class="hit"> 4季高</span>' : "")) +
    "</td><td>" + (d.gq == null ? "—" : '<span class="' + (d.gq > 0 ? "pos" : "neg") + '">' + (d.gq > 0 ? "+" : "") + (d.gq * 100).toFixed(1) + "</span>") +
    "</td><td>" + pc(d.ttm) + "</td><td>" + pc(d.cu) + "</td><td>" + (d.px == null ? "—" : d.px) +
    "</td><td>" + pc(d.r20) + "</td><td>" + d.f + "</td></tr>"
  ).join("");
}
document.querySelectorAll("#t th").forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  sortDir = sortK === k ? -sortDir : -1;
  sortK = k;
  document.querySelectorAll("#t th .arr").forEach(a => a.textContent = "");
  th.querySelector(".arr").textContent = sortDir < 0 ? " ▼" : " ▲";
  view();
});
document.querySelectorAll(".filters input,.filters select").forEach(el => el.onchange = view);
const setF = (tier, gm, ma) => {
  document.querySelectorAll(".filters select").forEach(el => el.selectedIndex = 0);
  document.querySelectorAll(".filters input").forEach(el => el.checked = false);
  document.getElementById("fTier").value = tier;
  document.getElementById("fGm").value = gm;
  document.getElementById("fMa").checked = ma;
  view();
};
document.getElementById("fReset").onclick = () => setF("核心·動能,核心", "up", true);
document.getElementById("fAll").onclick = () => setF("核心·動能,核心,動能,門檻", "", false);
view();
</script>
</body></html>`;
}

// 跟 latest.json 同一個道理：明確指定月份是回測/檢視用途，不該覆寫線上那份子頁
if (!explicit) writeFileSync(resolve(ROOT, OUT_HTML), renderHtml(out));

console.log(
  `[ok] ${target} 月營收篩選${partial ? "（公布中，名單會再長大）" : ""}：收錄 ${coverage} 家 → 門檻 ${out.counts.門檻}（核心 ${out.counts.核心}、動能 ${out.counts.動能}、兩者皆中 ${out.counts.核心且動能}；未過門檻 ${belowGate}）`,
);
const fresh = entries.filter((e) => e.fresh && (e.tier === "核心" || e.momentum));
if (fresh.length) {
  console.log(`  今日新到 ${out.fresh} 檔，其中核心或動能 ${fresh.length} 檔：`);
  for (const e of fresh.slice(0, 20)) {
    console.log(`    ${e.tier} ${e.code} ${e.name.padEnd(6)} ${e.flags.join("、")}  ${e.industry}`);
  }
}
