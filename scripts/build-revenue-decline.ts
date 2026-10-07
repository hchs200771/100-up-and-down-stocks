#!/usr/bin/env npx tsx
/**
 * 月營收衰退名單 — 避開／放空候選。純規則、零 LLM。
 *
 * 依據 docs/revenue-short-backtest.md（91 個月回測）：單月營收 YoY ≤ −20% 的股票，
 * 下一個月平均跑輸同一流動性母體 1.22%（t −5.6），2019–2022 與 2023 後兩段都成立，
 * 流動性門檻 20M / 50M 都成立。毛利率年減單獨用很弱，這裡只當附註，不參與篩選。
 *
 * 讀：data/revenue-history/<YYYY-MM>.json（fetch-monthly-revenue.ts）
 *     data/financials-history/*.json（毛利率年增減，附註用）
 *     data/market-latest.json（個股期貨、當日成交額、收盤價；跟漲跌 100 名單同一來源）
 * 寫：data/revenue-decline-latest.json ＋ data/revenue-decline-history/<YYYY-MM>.json
 *     data/revenue-decline.html — 發佈到日報網站的子頁 /revenue-decline.html
 *
 * ## 規則（與回測相同）
 *
 *   母體 = 排除建材營造、創新板、存託憑證；去年同月營收 ≥ 3,000 萬；成交額 ≥ 2,000 萬
 *   名單 = 單月營收 YoY ≤ −20%
 *
 * 回測的流動性門檻是「進場前 20 日平均成交額」；每日流程只有當日成交額，這裡用它近似。
 *
 * ## 月份
 *
 * 回測的訊號在次月 11 日之後才生效（營收 10 日前公布完）。所以每月 1~10 號：
 *   - 「生效中」＝最新一個已公布完的月份，這是回測定義下現在該看的名單；
 *   - 「公布中」＝最新月份裡已經公布、而且已經命中的公司，名單還會長大。
 * 兩份都輸出，頁面上可以切換。
 *
 * 用法：npx tsx scripts/build-revenue-decline.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { twIso, twDate, fmtTw } from "./lib/time";
import { renderSubpageNav } from "./lib/nav";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadFinancials, newestQuarter, latestMarginQuarter, marginOf, prevQuarter } from "./lib/gross-margin";
import { loadSnapshots, coverageOf, lastCompleteMonth, MIN_BASE, MIN_COVERAGE, SKIP_INDUSTRIES, isTib } from "./lib/revenue-factors";

const ROOT = process.cwd();
const OUT_LATEST = "data/revenue-decline-latest.json";
const OUT_HISTORY_DIR = "data/revenue-decline-history";
const OUT_HTML = "data/revenue-decline.html";
const GATE = -0.2;
/** 原始產業別有時帶整段括號說明（例如金融保險業），頁面只顯示括號前的名稱 */
const indName = (s: string) => s.replace(/[（(].*$/, "").trim() || s;
const MIN_TURNOVER = 20_000_000;

const snaps = loadSnapshots(ROOT);
if (!snaps.size) {
  console.error("data/revenue-history 是空的，先跑 npx tsx scripts/fetch-monthly-revenue.ts --months 36");
  process.exit(1);
}
const allMonths = [...snaps.keys()].sort();
const latestMonth = allMonths[allMonths.length - 1];
const completeMonth = lastCompleteMonth(snaps);

// ---------- 市場資料（期貨、成交額、收盤） ----------
const market = new Map<string, { futures: { level: string; margin: string } | null; amount: number | null; close: number | null }>();
let marketDate: string | null = null;
{
  const mp = resolve(ROOT, "data/market-latest.json");
  if (existsSync(mp)) {
    const m = JSON.parse(readFileSync(mp, "utf-8"));
    marketDate = m.date ?? m.tradingDate ?? null;
    for (const [code, v] of Object.entries<any>(m.stockMap ?? {})) {
      market.set(code, {
        futures: v?.futures ?? null,
        amount: typeof v?.amount === "number" ? v.amount : null,
        close: typeof m.closeMap?.[code] === "number" ? m.closeMap[code] : null,
      });
    }
  }
}
// 舊版 market-latest 沒有 amount 欄位：整份都沒有就不套流動性門檻，頁面會註明
const hasTurnover = [...market.values()].some((v) => v.amount !== null);

// ---------- 前 60 日漲跌（附註）：price-history 只有收盤，跟營收動能頁同一來源 ----------
const closes = new Map<string, number[]>();
{
  const dir = resolve(ROOT, "data/price-history");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(-61)) {
      const day: Record<string, number> = JSON.parse(readFileSync(resolve(dir, f), "utf-8"));
      for (const [code, c] of Object.entries(day)) {
        if (typeof c !== "number" || !(c > 0)) continue;
        let arr = closes.get(code);
        if (!arr) closes.set(code, (arr = []));
        arr.push(c);
      }
    }
  }
}
/** 未還原除權息；有缺日的個股不給數字 */
const r60Of = (code: string) => {
  const a = closes.get(code);
  return a && a.length === 61 ? a[60] / a[0] - 1 : null;
};

const fin = loadFinancials(ROOT);
const finNewest = newestQuarter(fin);
const today = twDate();

interface Entry {
  code: string;
  name: string;
  market: "twse" | "tpex";
  industry: string;
  /** 單月營收，千元 */
  rev: number;
  yoy: number;
  /** 近 3 個月合計 YoY；缺任何一個月就 null */
  yoy3m: number | null;
  /** 連續幾個月 YoY ≤ −20%（含本月） */
  declineStreak: number;
  /** 連續幾個月 MoM < 0（含本月） */
  momDeclineStreak: number;
  /** 前 60 個交易日漲跌（未還原） */
  r60: number | null;
  marginQuarter: string | null;
  /** 最新一季毛利率減去年同季，小數（−0.03 ＝ −3pp） */
  marginYoy: number | null;
  turnover: number | null;
  close: number | null;
  futures: { level: string; margin: string } | null;
  firstSeen: string;
  fresh: boolean;
}

const yoyOf = (m: string, code: string): number | null => {
  const r = snaps.get(m)?.stocks[code];
  return r && r.prevY >= MIN_BASE && r.rev > 0 ? r.rev / r.prevY - 1 : null;
};

function build(month: string) {
  const snap = snaps.get(month)!;
  const histPath = resolve(ROOT, OUT_HISTORY_DIR, `${month}.json`);
  const prevSeen = new Map<string, string>();
  if (existsSync(histPath)) {
    for (const e of JSON.parse(readFileSync(histPath, "utf-8")).entries ?? []) if (e.firstSeen) prevSeen.set(e.code, e.firstSeen);
  }
  const entries: Entry[] = [];
  let universe = 0, illiquid = 0;
  for (const [code, row] of Object.entries(snap.stocks)) {
    if (SKIP_INDUSTRIES.has(row.ind) || isTib(row.n) || row.ind === "存託憑證") continue;
    if (!(row.prevY >= MIN_BASE) || !(row.rev > 0)) continue;
    const mk = market.get(code);
    if (hasTurnover && !(mk?.amount != null && mk.amount >= MIN_TURNOVER)) { illiquid++; continue; }
    universe++;
    const yoy = row.rev / row.prevY - 1;
    if (yoy > GATE) continue;

    let sum = 0, sumPrev = 0, ok3 = true;
    for (let j = 0; j < 3; j++) {
      const r = snaps.get(monthsBack(month, j))?.stocks[code];
      if (r && r.prevY > 0) { sum += r.rev; sumPrev += r.prevY; } else ok3 = false;
    }
    let declineStreak = 0;
    for (let j = 0; j < 24; j++) {
      const y = yoyOf(monthsBack(month, j), code);
      if (y === null || y > GATE) break;
      declineStreak++;
    }
    let momDeclineStreak = 0;
    for (let j = 0; j < 24; j++) {
      const r = snaps.get(monthsBack(month, j))?.stocks[code];
      const p = snaps.get(monthsBack(month, j + 1))?.stocks[code];
      if (!r || !p || !(p.rev > 0) || r.rev >= p.rev) break;
      momDeclineStreak++;
    }
    const mq = finNewest ? latestMarginQuarter(code, fin, finNewest) : null;
    const g = mq ? marginOf(code, mq, fin) : null;
    const gy = mq ? marginOf(code, prevQuarter(prevQuarter(prevQuarter(prevQuarter(mq)))), fin) : null;
    const firstSeen = prevSeen.get(code) ?? today;
    entries.push({
      code, name: row.n, market: row.m, industry: indName(row.ind), rev: row.rev, yoy,
      yoy3m: ok3 && sumPrev >= MIN_BASE * 3 ? sum / sumPrev - 1 : null,
      declineStreak,
      momDeclineStreak,
      r60: r60Of(code),
      marginQuarter: mq,
      marginYoy: g !== null && gy !== null ? g - gy : null,
      turnover: mk?.amount ?? null,
      close: mk?.close ?? null,
      futures: mk?.futures ?? null,
      firstSeen,
      fresh: firstSeen === today,
    });
  }
  // 有期貨的排前面（可以直接用個股期貨放空／避險），同群依 YoY 由差到好。不代表優先順序。
  entries.sort((a, b) => Number(!!b.futures) - Number(!!a.futures) || a.yoy - b.yoy);
  const out = {
    month,
    coverage: coverageOf(snaps, month),
    partial: coverageOf(snaps, month) < MIN_COVERAGE,
    combinedJanFeb: false,
    universe,
    illiquid,
    counts: {
      名單: entries.length,
      有期貨: entries.filter((e) => e.futures).length,
      連3月: entries.filter((e) => e.declineStreak >= 3).length,
      MoM連3月: entries.filter((e) => e.momDeclineStreak >= 3).length,
      毛利率年減: entries.filter((e) => e.marginYoy !== null && e.marginYoy < 0).length,
      今日新到: entries.filter((e) => e.fresh).length,
    },
    entries,
  };
  mkdirSync(resolve(ROOT, OUT_HISTORY_DIR), { recursive: true });
  writeFileSync(histPath, JSON.stringify(out, null, 2));
  return out;
}

type MonthOut = ReturnType<typeof build>;
const lists: MonthOut[] = [];
if (completeMonth) lists.push(build(completeMonth));
if (latestMonth !== completeMonth) lists.push(build(latestMonth));

const result = {
  generatedAt: twIso(),
  marketDate,
  rule: {
    名單: "單月營收 YoY ≤ −20%",
    母體: `排除建材營造、創新板、存託憑證；去年同月營收 ≥ 3,000 萬；${hasTurnover ? "當日成交額 ≥ 2,000 萬" : "（缺成交額資料，未套流動性門檻）"}`,
    生效: "次月 11 日起生效，持有約一個月（與回測相同）",
  },
  hasTurnover,
  /** 回測定義下現在該看的名單：最新一個已公布完的月份 */
  active: completeMonth || null,
  lists,
};
writeFileSync(resolve(ROOT, OUT_LATEST), JSON.stringify(result, null, 2));

// ---------- 子頁 ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COL_HELP: Record<string, string> = {
  c: "股票代號，點了開雅虎股市",
  n: "公司名稱，點了開雅虎股市",
  fu: "有沒有個股期貨，以及期交所公告的原始保證金比例（級距 1 = 13.5%、級距 2 = 16.2%、級距 3 = 20.25%）。跟漲跌 100 名單同一來源。有期貨就能直接用期貨放空或避險，不受融券張數、平盤以下與強制回補限制",
  ind: "公開資訊觀測站的產業分類",
  y: "單月營收年增率。名單門檻是 ≤ −20%",
  y3: "近 3 個月營收合計，跟去年同期 3 個月合計比的年增率。比單月穩定，不受單月出貨時點影響",
  st: "連續幾個月單月 YoY ≤ −20%（含本月）。1＝本月才掉下來。回測：連 3 月以上、而且前 60 日已經跌最多的那批，利空大多已反映，額外跑輸不顯著",
  ms: "連續幾個月營收比上個月少（MoM < 0，含本月）。回測：再加上 MoM 連 3 月衰退，平均每月跑輸從 1.2% 擴大到約 1.8%，但檔數少很多。注意農曆年前後的季節性下滑",
  r60: "前 60 個交易日的股價漲跌（未還原除權息）。回測：即使是前 60 日跌最多的那 1/3，營收衰退股仍比同組其他股票多跑輸約 1%，大致上沒有跌完",
  gm: "最新一季單季毛利率減去年同季（pp）。回測顯示毛利率下滑單獨用幾乎沒有放空價值，這欄只當附註",
  r: "當月營收，單位億元",
  to: "最近一個交易日的成交金額，單位億元",
  px: "最近一個交易日的收盤價",
  f: "第一次進這個月名單的日期",
};

function renderHtml(r: typeof result): string {
  const data = r.lists.map((l) => ({
    month: l.month, partial: l.partial, coverage: l.coverage, universe: l.universe, counts: l.counts,
    rows: l.entries.map((e) => ({
      c: e.code, n: e.name, sfx: e.market === "twse" ? ".TW" : ".TWO", ind: e.industry,
      y: e.yoy, y3: e.yoy3m, st: e.declineStreak, ms: e.momDeclineStreak, r60: e.r60, gm: e.marginYoy, gmq: e.marginQuarter,
      r: e.rev, to: e.turnover, px: e.close, f: e.firstSeen, nw: e.fresh ? 1 : 0,
      fu: e.futures ? parseFloat(e.futures.margin) : null,
      fut: e.futures ? [e.futures.level, e.futures.margin].filter(Boolean).join(" ") : null,
    })),
  }));
  const inds = [...new Set(r.lists.flatMap((l) => l.entries.map((e) => e.industry)))].sort();
  const cols: [string, string][] = [["代號", "c"], ["名稱", "n"], ["期貨", "fu"], ["產業", "ind"], ["YoY", "y"], ["3月合計YoY", "y3"], ["YoY連續月", "st"], ["MoM連續月", "ms"], ["前60日", "r60"], ["毛利率年增減", "gm"], ["營收(億)", "r"], ["成交額(億)", "to"], ["收盤", "px"], ["首次進榜", "f"]];
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>月營收衰退名單</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">📉</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.note{color:var(--up)}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.card{flex:1 1 150px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.card .cname{font-size:14px;font-weight:700}
.card .cdesc{color:var(--muted);font-size:11.5px;line-height:1.5;margin-top:2px;flex:1}
.card b{font-size:17px;line-height:1.2;margin-top:6px}
.card.total{border-color:var(--accent)}.card.total .cname,.card.total b{color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}
.filters label{display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}
.filters .fl{font-weight:700;color:color-mix(in srgb,var(--accent) 78%,var(--muted))}
.filters select{max-width:160px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:13px}
.months button{font:inherit;font-size:13px;padding:4px 12px;margin-right:6px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg);cursor:pointer}
.months button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:960px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:nth-child(-n+4),td:nth-child(-n+4){text-align:left}
th{position:sticky;top:0;background:var(--card);cursor:pointer;user-select:none;color:var(--muted);font-weight:600}
tr:hover td{background:color-mix(in srgb,var(--accent) 6%,transparent)}
a{color:var(--accent);text-decoration:none}
td a:hover{text-decoration:underline}
.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;font-size:11px;color:var(--muted)}
.chip.fut{color:#4338ca;background:#e0e7ff;white-space:nowrap}
.new{display:inline-block;background:var(--down);color:#fff;border-radius:99px;padding:0 6px;font-size:10px;margin-left:4px}
.pos{color:var(--up)}.neg{color:var(--down)}.none{color:var(--muted)}
.count{margin:8px 2px;color:var(--muted);font-size:13px}
.nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.nav a{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:700;background:var(--card);color:var(--fg)}
.nav a:hover{border-color:var(--accent);color:var(--accent)}
.nav a.here{background:var(--accent);border-color:var(--accent);color:#fff}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;font-size:13px;color:var(--muted)}
details.howto summary{cursor:pointer;padding:10px 16px;font-size:14px;font-weight:600;color:var(--fg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto p{margin:6px 0}
details.howto b{color:var(--fg)}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("revenue-decline.html")}
<h1>📉 月營收衰退名單</h1>
<p class="sub">單月營收 YoY ≤ −20%，下個月傾向跑輸大盤。用途是<b>避開</b>或當<b>放空候選</b>，不是買進名單。更新：${esc(fmtTw(r.generatedAt))}${r.marketDate ? `（期貨與成交額取自 ${esc(r.marketDate)}）` : ""}</p>
${r.hasTurnover ? "" : "<p class='note'>⚠️ 這次的市場資料沒有成交額，未套用 2,000 萬流動性門檻，名單會包含很難交易的冷門股。</p>"}
<div class="months" id="months"></div>
<p class="note" id="mnote"></p>
<div class="cards" id="cards"></div>
<details class="howto"><summary>怎麼用、回測結果與限制</summary><div class="body">
<p><b>回測（2019-01～2026-07，91 個月）</b>：單月 YoY ≤ −20% 的股票，下個月平均跑輸同一流動性母體 <b>1.22%</b>（t −5.6），76% 的月份跑輸；2023 前後兩段幾乎一樣，持有 3 個月的超額擴大到約 −2.7%。流動性門檻提高到 5,000 萬也成立。</p>
<p><b>放空的實際報酬會比回測少</b>：融券來回成本約 0.665%／月，扣完淨報酬約每月 0.5～0.8%。小型股可能沒券、遇到平盤以下限制或股東會強制回補。<b>有個股期貨</b>的標的可以直接用期貨放空，不受這些限制，所以排在最前面。</p>
<p><b>MoM 連續衰退</b>：連 3 個月營收比上個月少的股票，回測每月跑輸 1.46%（t −5.6）；和 YoY 衰退同時成立時擴大到 1.9%，但每月只有十幾檔。</p>
<p><b>股價是不是已經跌完了？</b>大致上沒有：在前 60 日跌最多的那 1/3 股票裡，營收衰退股仍比同組其他股票多跑輸約 1%。例外是 YoY 連 3 月以上 ≤ −20% 又已經跌深的，利空大多已反映。</p>
<p><b>毛利率</b>：回測顯示毛利率年減單獨用幾乎沒有放空價值，跟營收條件合併也只多一點點，這裡只當附註。</p>
<p><b>生效時間</b>：回測在營收月份的次月 11 日之後才進場、持有約一個月。每月 1~10 號，「生效中」是上一個已公布完的月份；「公布中」是正在陸續公布的新月份，名單還會長大。</p>
<p>完整研究：<a href="https://github.com/hchs200771/100-up-and-down-stocks/blob/main/docs/revenue-short-backtest.md">revenue-short-backtest.md</a>。這不是投資建議。</p>
</div></details>
<div class="filters">
<label><input type="checkbox" id="fFut"><span class="fl">只看有期貨</span></label>
<label><input type="checkbox" id="fSt"><span class="fl">YoY 連 3 月以上</span></label>
<label><input type="checkbox" id="fMs"><span class="fl">MoM 連 3 月衰退</span></label>
<label><input type="checkbox" id="fGm"><span class="fl">毛利率年減</span></label>
<label><span class="fl">產業</span><select id="fInd"><option value="">全部</option>${inds.map((i) => `<option>${esc(i)}</option>`).join("")}</select></label>
</div>
<div class="count" id="count"></div>
<div class="tablebox"><table><thead><tr>${cols.map(([t, k]) => `<th data-k="${k}" title="${esc(COL_HELP[k] ?? "")}">${t}</th>`).join("")}</tr></thead><tbody id="tb"></tbody></table></div>
</div>
<script>
const DATA=${JSON.stringify(data).replace(/</g, "\\u003c")};
const ACTIVE=${JSON.stringify(r.active)};
let cur=Math.max(0,DATA.findIndex(d=>d.month===ACTIVE)),sortK=null,sortD=1;
const $=id=>document.getElementById(id);
const pct=v=>v==null?'<span class="none">—</span>':'<span class="'+(v<0?'neg':'pos')+'">'+(v>0?'+':'')+(v*100).toFixed(1)+'%</span>';
const pp=v=>v==null?'<span class="none">—</span>':'<span class="'+(v<0?'neg':'pos')+'">'+(v>0?'+':'')+(v*100).toFixed(1)+'pp</span>';
const yi=(r,t)=>'<a href="https://tw.stock.yahoo.com/quote/'+r.c+r.sfx+'" target="_blank" rel="noopener">'+t+'</a>';
function months(){$('months').innerHTML=DATA.map((d,i)=>'<button class="'+(i===cur?'on':'')+'" data-i="'+i+'">'+d.month+(d.month===ACTIVE?' 生效中':' 公布中')+'</button>').join('');}
function render(){
  const d=DATA[cur];months();
  $('mnote').textContent=d.partial?('⚠️ '+d.month+' 還在公布中（已收 '+d.coverage+' 家，全市場約 1900 家），名單接下來幾天會繼續長大；依回測定義要到次月 11 日才生效。'):'';
  const c=d.counts;
  $('cards').innerHTML=[['total','名單',c['名單'],'母體 '+d.universe+' 檔中 YoY ≤ −20%'],['','有期貨',c['有期貨'],'可直接用個股期貨放空／避險'],['','YoY 連 3 月',c['連3月'],'連續 3 個月以上 YoY ≤ −20%'],['','MoM 連 3 月',c['MoM連3月'],'連 3 個月營收比上月少，回測更強'],['','毛利率年減',c['毛利率年減'],'附註用，回測單獨效果弱'],['','今日新到',c['今日新到'],'今天第一次進這個月名單']].map(([k,n,v,ds])=>'<div class="card '+k+'"><span class="cname">'+n+'</span><span class="cdesc">'+ds+'</span><b>'+v+'</b></div>').join('');
  let rows=d.rows.filter(r=>(!$('fFut').checked||r.fu!=null)&&(!$('fSt').checked||r.st>=3)&&(!$('fMs').checked||r.ms>=3)&&(!$('fGm').checked||(r.gm!=null&&r.gm<0))&&(!$('fInd').value||r.ind===$('fInd').value));
  if(sortK)rows=[...rows].sort((a,b)=>{const x=a[sortK],y=b[sortK];if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1;return (x>y?1:x<y?-1:0)*sortD;});
  $('count').textContent='顯示 '+rows.length+' / '+d.rows.length+' 檔';
  $('tb').innerHTML=rows.map(r=>'<tr><td>'+yi(r,r.c)+'</td><td>'+yi(r,r.n)+(r.nw?'<span class="new">新</span>':'')+'</td><td>'+(r.fut?'<span class="chip fut">'+r.fut+'</span>':'<span class="none">—</span>')+'</td><td>'+r.ind+'</td><td>'+pct(r.y)+'</td><td>'+pct(r.y3)+'</td><td>'+r.st+'</td><td>'+r.ms+'</td><td>'+pct(r.r60)+'</td><td'+(r.gmq?' title="'+r.gmq+'"':'')+'>'+pp(r.gm)+'</td><td>'+(r.r/1e5).toFixed(2)+'</td><td>'+(r.to==null?'<span class="none">—</span>':(r.to/1e8).toFixed(2))+'</td><td>'+(r.px==null?'<span class="none">—</span>':r.px)+'</td><td>'+r.f+'</td></tr>').join('');
}
$('months').addEventListener('click',e=>{const b=e.target.closest('button');if(b){cur=+b.dataset.i;render();}});
['fFut','fSt','fMs','fGm','fInd'].forEach(id=>$(id).addEventListener('change',render));
document.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.k;if(sortK===k)sortD=-sortD;else{sortK=k;sortD=1;}render();}));
render();
</script>
</body>
</html>
`;
}

writeFileSync(resolve(ROOT, OUT_HTML), renderHtml(result));
for (const l of result.lists) {
  console.log(`[revenue-decline] ${l.month}${l.month === result.active ? "（生效中）" : "（公布中）"}：母體 ${l.universe}、名單 ${l.counts.名單}、有期貨 ${l.counts.有期貨}`);
}
