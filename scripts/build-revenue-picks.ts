#!/usr/bin/env npx tsx
/**
 * 月營收篩選名單的逐檔配置分析子頁（/revenue-picks.html）。
 *
 * 讀：data/revenue-picks-latest.json —— 一次性的研究快照，不是每日自動產生。
 *     篩選條件、位階數字、Haiku 逐檔網搜的成長與估值、主對話的最終分類與配置都在裡面。
 * 寫：data/revenue-picks.html
 *
 * 位階數字是快照當天算的，之後不會自動更新；頁面上會標出價格日期。
 * 配置的權重是「名目曝險占總資金」，個股期貨也用名目金額算，不是保證金。
 *
 * 用法：npx tsx scripts/build-revenue-picks.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderSubpageNav } from "./lib/nav";

const ROOT = process.cwd();
const IN = resolve(ROOT, "data/revenue-picks-latest.json");
const OUT = resolve(ROOT, "data/revenue-picks.html");

type Tier = "pick" | "wait" | "other" | "skip";
interface Stock {
  code: string;
  name: string;
  industry: string;
  tier: Tier;
  close: number;
  futures: { level: string; margin: string } | null;
  yoy: number;
  momStreak: number;
  position: { r20: number | null; r60: number | null; devMA20: number | null; devMA60: number | null; devMA240: number | null; pctFrom52wHigh: number | null };
  target: number | null;
  upside: number | null;
  eps2026: number | null;
  eps2027: number | null;
  pe2026: number | null;
  pe2027: number | null;
  growthDrivers: string | null;
  outlook: string | null;
  valuationNote: string | null;
  risks: string[];
  catalysts: string[];
  haikuVerdict: string | null;
  haikuReason: string | null;
  dataWarning: string | null;
  alloc?: { weight: number; stopPct: number; stopPrice: number; why: string };
}
interface Snapshot {
  generatedAt: string;
  priceDate: string;
  revenueMonth: string;
  screen: string;
  market: { taiex: number; devMA20: number; devMA60: number };
  cashWeight: number;
  stocks: Stock[];
}

const TIER_LABEL: Record<Tier, string> = { pick: "配置名單", wait: "等回檔", other: "可留意但非優先", skip: "不建議" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (v: number | null | undefined, d = 0) =>
  v == null ? '<span class="none">—</span>' : `<span class="${v < 0 ? "neg" : "pos"}">${v > 0 ? "+" : ""}${(v * 100).toFixed(d)}%</span>`;
const num = (v: number | null | undefined, d = 1) => (v == null ? '<span class="none">—</span>' : v.toLocaleString("zh-TW", { maximumFractionDigits: d }));
const yahoo = (s: Stock) => `<a href="https://tw.stock.yahoo.com/quote/${s.code}" target="_blank" rel="noopener">${s.code} ${esc(s.name)}</a>`;
const futTag = (s: Stock) => (s.futures ? `<span class="tag fut">期 ${esc(s.futures.margin)}</span>` : "");

function allocTable(picks: Stock[]): string {
  const rows = picks
    .map((s) => {
      const a = s.alloc!;
      return `<tr><td>${yahoo(s)}${futTag(s)}</td><td>${a.weight}%</td><td>${num(s.close, 2)}</td><td>${num(a.stopPrice, 0)}</td><td>−${(a.stopPct * 100).toFixed(0)}%</td><td>${num(s.pe2026)}</td><td>${num(s.pe2027)}</td><td class="why">${esc(a.why)}</td></tr>`;
    })
    .join("");
  return `<div class="tablebox"><table class="alloc"><thead><tr><th>個股</th><th>比重</th><th>收盤</th><th>停損價</th><th>停損距離</th><th>本益比 26</th><th>本益比 27</th><th>理由</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function card(s: Stock): string {
  const p = s.position;
  const fields: [string, string | null][] = [
    ["成長驅動", s.growthDrivers],
    ["展望", s.outlook],
    ["估值", s.valuationNote],
    ["風險", s.risks.join("；") || null],
    ["催化劑", s.catalysts.join("；") || null],
    ["Haiku 結論", s.haikuVerdict ? `${s.haikuVerdict}：${s.haikuReason ?? ""}` : null],
  ];
  const eps = `EPS 2026 ${num(s.eps2026, 2)}／2027 ${num(s.eps2027, 2)}，換算本益比 ${num(s.pe2026)}／${num(s.pe2027)} 倍`;
  const tgt = s.target ? `，FactSet 目標價 ${num(s.target, 1)}（${pct(s.upside)}）` : "";
  return `<details class="card ${s.tier}" data-q="${esc(`${s.code} ${s.name} ${s.industry}`)}"><summary><span class="t">${yahoo(s)}</span>${futTag(s)}<span class="ind">${esc(s.industry)}</span>${s.alloc ? `<span class="tag w">${s.alloc.weight}%</span>` : ""}<span class="mini">YoY ${pct(s.yoy)}・20 日 ${pct(p.r20)}・對月線 ${pct(p.devMA20)}</span></summary><div class="body">
${s.dataWarning ? `<p class="warn">⚠️ ${esc(s.dataWarning)}</p>` : ""}
<p class="pos-line">收盤 ${num(s.close, 2)}，20 日 ${pct(p.r20)}、60 日 ${pct(p.r60)}，對 MA20 ${pct(p.devMA20)}、MA60 ${pct(p.devMA60)}、MA240 ${pct(p.devMA240)}，離 52 週高點 ${pct(p.pctFrom52wHigh)}。MoM 連 ${s.momStreak} 月。${eps}${tgt}。</p>
${fields.filter(([, v]) => v).map(([k, v]) => `<p><b>${k}</b>：${esc(v!)}</p>`).join("\n")}
</div></details>`;
}

function render(d: Snapshot): string {
  const picks = d.stocks.filter((s) => s.tier === "pick");
  const sections = (["pick", "wait", "other", "skip"] as Tier[])
    .map((t) => {
      const list = d.stocks.filter((s) => s.tier === t);
      return `<h2>${TIER_LABEL[t]}（${list.length} 檔）</h2><div class="cards">${list.map(card).join("")}</div>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>營收名單配置</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">🧮</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42;--warn:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:15px;margin:20px 0 8px}
.sub{color:var(--muted);font-size:13px;margin:2px 0}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:860px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child,td.why{text-align:left}
td.why{white-space:normal;min-width:260px;color:var(--muted)}
th{background:var(--card);color:var(--muted);font-weight:600}
.pos{color:var(--up)}.neg{color:var(--down)}.none{color:var(--muted)}
.tag{display:inline-block;border-radius:99px;padding:0 7px;font-size:11px;margin-left:5px;background:var(--chip);color:var(--muted)}
.tag.fut{color:var(--accent)}
.tag.w{color:#fff;background:var(--accent)}
a{color:var(--accent);text-decoration:none}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin:12px 0;font-size:13px}
.box ul{margin:4px 0;padding-left:20px}
.box b{color:var(--fg)}
.filter{font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);width:100%;max-width:320px;margin:8px 0}
.cards{display:grid;gap:8px}
details.card{background:var(--card);border:1px solid var(--line);border-radius:10px}
details.card.pick{border-left:3px solid var(--accent)}
details.card.skip{opacity:.8}
details.card summary{cursor:pointer;padding:9px 14px;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center}
details.card .t{font-weight:700}
details.card .ind{color:var(--muted);font-size:12px}
details.card .mini{margin-left:auto;color:var(--muted);font-size:12px}
details.card .body{padding:0 14px 10px;border-top:1px solid var(--line);font-size:13px}
details.card .body p{margin:6px 0}
.warn{color:var(--warn)}
.pos-line{color:var(--muted)}
@media (max-width:640px){details.card .mini{margin-left:0;width:100%}}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("revenue-picks.html")}
<h1>🧮 營收名單配置分析</h1>
<p class="sub">${esc(d.revenueMonth)} 營收、價格截至 ${esc(d.priceDate)} 的一次性研究快照，不會每日更新。篩選：${esc(d.screen)}，共 ${d.stocks.length} 檔。</p>
<div class="box">
<b>先讀這段</b>
<ul>
<li>專案回測顯示「營收門檻內排名沒有資訊」：隨機取 15 檔跟任何排序法一樣好。這裡的挑選是加上成長與估值的主觀判斷，不是回測證明過的優勢。</li>
<li>成長、展望、估值、風險來自 Haiku 逐檔網搜，品質不一；已發現的矛盾用 ⚠️ 標在個股裡，本益比一律用「收盤 ÷ EPS」重算。下單前請自行核對 EPS。</li>
<li>大盤：加權指數 ${num(d.market.taiex, 0)}，在月線上 ${pct(d.market.devMA20, 1)}、季線上 ${pct(d.market.devMA60, 1)}，趨勢向上。</li>
</ul>
</div>
<h2>配置（共 ${picks.reduce((n, s) => n + s.alloc!.weight, 0)}%，現金 ${d.cashWeight}%）</h2>
${allocTable(picks)}
<div class="box">
<b>部位怎麼算</b>
<ul>
<li>每筆碰到停損時虧總資金約 1%：比重 ≈ 1% ÷ 停損距離，單檔上限 12%。</li>
<li>停損設在月線下方，至少 7%、最多 12%。離月線遠的不排除（專案回測乖離大不代表後面較弱），而是停損放寬、部位自動變小。</li>
<li>分兩次建倉：先買一半，順向且站穩 3～5 天再加另一半。</li>
<li>這 8 檔除了信邦與南亞科，都押在 AI 資料中心資本支出上；加權指數收盤跌破月線時，全部減半。</li>
<li>有「期」標記的可用個股期貨，比重算的是<b>名目金額</b>，不是保證金；保證金約 20%，等於 4～5 倍槓桿。一般個股期貨一口 2,000 股、小型 100 股，高價股多半要用小型合約。</li>
</ul>
</div>
<input class="filter" id="q" placeholder="搜尋代號、名稱或產業">
${sections}
</div>
<script>
document.getElementById('q').addEventListener('input',function(){var q=this.value.trim().toLowerCase();
[].slice.call(document.querySelectorAll('details.card')).forEach(function(c){c.style.display=!q||c.getAttribute('data-q').toLowerCase().indexOf(q)>=0?'':'none';});});
</script>
</body>
</html>
`;
}

if (!existsSync(IN)) {
  console.error(`找不到 ${IN}`);
  process.exit(1);
}
const data: Snapshot = JSON.parse(readFileSync(IN, "utf8"));
writeFileSync(OUT, render(data));
console.log(`revenue-picks: ${data.stocks.length} 檔 → ${OUT}`);
