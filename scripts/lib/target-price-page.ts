/**
 * /target-price.html — 法人目標價子頁。資料由 scripts/fetch-target-prices.ts 準備好，這裡只負責排版。
 * 樣式沿用 build-revenue-decline.ts 的子頁（同一組 CSS 變數與 .nav），兩頁並排看才一致。
 */
import { fmtTw } from "./time";
import { renderSubpageNav } from "./nav";
import { yahooUrl } from "./stock-links";
import type { TargetPriceLatest } from "../fetch-target-prices";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COL_HELP: Record<string, string> = {
  c: "股票代號，點了開 Yahoo 股市個股頁",
  n: "股票名稱。「新」＝今天第一次進入空間 ≥ 門檻的名單",
  px: "最近一個交易日的收盤價。上櫃收盤較晚出來，盤中產生時會用前一個交易日（滑鼠移上去看日期）",
  t: "FactSet 調查的分析師共識目標價（中位數）",
  u: "共識目標價 ÷ 收盤 − 1",
  th: "分析師裡最高的目標價。只有「目標價變動」那種速報才附，EPS 變動的速報沒有，所以約一半是空的",
  uh: "最高目標價 ÷ 收盤 − 1，也就是最樂觀的分析師覺得還有多少空間",
  tl: "分析師裡最低的目標價",
  a: "FactSet 調查涵蓋的分析師人數。人數太少時共識代表性有限",
  d30: "共識目標價和約 30 天前相比的變化。調升代表分析師在追認基本面，通常比空間本身更有資訊",
  ld: "最近一則 FactSet 速報的日期與類型（EPS＝EPS 預估變動、目標價＝目標價變動），點了看原文",
  f: "這次連續在名單上的第一天",
};

export function renderTargetPricePage(r: TargetPriceLatest): string {
  const rows = r.rows.map((x) => ({
    c: x.code, n: x.name, y: yahooUrl(x.code), px: x.close, pxd: x.closeDate ?? null, t: x.target, u: x.upside,
    th: x.targetHigh, uh: x.upsideHigh, tl: x.targetLow, a: x.analysts,
    d30: x.target30d ? x.target / x.target30d - 1 : null,
    ld: x.lastEvent.date, lk: x.lastEvent.kind, ldir: x.lastEvent.direction, lu: x.lastEvent.url,
    st: x.stale ? 1 : 0, f: x.firstSeen, nw: x.isNew ? 1 : 0,
  }));
  const week = r.rows.filter((x) => !x.stale && Date.parse(r.closeDate) - Date.parse(x.lastEvent.date) <= 7 * 86_400_000);
  const counts = {
    cover: r.coverage.fresh,
    pass: r.rows.filter((x) => x.qualified).length,
    fresh: r.rows.filter((x) => x.isNew).length,
    up7: week.filter((x) => x.lastEvent.direction === "up").length,
    down7: week.filter((x) => x.lastEvent.direction === "down").length,
  };
  const cols: [string, string][] = [["代號", "c"], ["名稱", "n"], ["收盤", "px"], ["共識目標", "t"], ["空間", "u"], ["最高目標", "th"], ["最樂觀空間", "uh"], ["最低目標", "tl"], ["分析師", "a"], ["30日目標變化", "d30"], ["最近速報", "ld"], ["首次進榜", "f"]];
  const gatePct = Math.round(r.gate * 100);
  const calls = r.brokerCalls;
  const related = r.relatedNews.slice(0, 40);
  const pctHtml = (v: number | null) =>
    v === null ? `<span class="none">—</span>` : `<span class="${v < 0 ? "neg" : "pos"}">${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%</span>`;
  const numHtml = (v: number | null) => (v === null ? `<span class="none">—</span>` : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  const stockLink = (code: string, text: string) => `<a href="${yahooUrl(code)}" target="_blank" rel="noopener">${esc(text)}</a>`;

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>法人目標價</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">🎯</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:16px;margin:22px 0 6px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.card{flex:1 1 150px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.card .cname{font-size:14px;font-weight:700}
.card .cdesc{color:var(--muted);font-size:11.5px;line-height:1.5;margin-top:2px;flex:1}
.card b{font-size:17px;line-height:1.2;margin-top:6px}
.card.total{border-color:var(--accent)}.card.total .cname,.card.total b{color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}
.filters label{display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}
.filters .fl{font-weight:700;color:color-mix(in srgb,var(--accent) 78%,var(--muted))}
.filters select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:13px}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:980px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:nth-child(-n+2),td:nth-child(-n+2){text-align:left}
th{position:sticky;top:0;background:var(--card);cursor:pointer;user-select:none;color:var(--muted);font-weight:600}
tr:hover td{background:color-mix(in srgb,var(--accent) 6%,transparent)}
tr.stale td{opacity:.55}
a{color:var(--accent);text-decoration:none}
td a:hover,li a:hover{text-decoration:underline}
.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;font-size:11px;color:var(--muted)}
.new{display:inline-block;background:var(--up);color:#fff;border-radius:99px;padding:0 6px;font-size:10px;margin-left:4px}
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
table.calls{min-width:900px}
table.calls th{cursor:default}
table.calls th:nth-child(-n+3),table.calls td:nth-child(-n+3),table.calls td.t,table.calls th:last-child{text-align:left}
table.calls td.t{white-space:normal;min-width:320px}
table.calls tr.hit td:first-child{box-shadow:inset 3px 0 0 var(--up)}
ul.news{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:10px}
ul.news li{padding:7px 14px;border-bottom:1px solid var(--line);font-size:13px}
ul.news li:last-child{border-bottom:0}
ul.news .d{color:var(--muted);margin-right:8px;font-variant-numeric:tabular-nums}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("target-price.html")}
<h1>🎯 法人目標價</h1>
<p class="sub">FactSet 分析師共識目標價跟最新收盤的空間，以及共識最近是上修還是下修。回測顯示<b>空間大小本身沒有預測力</b>，<b>被下修</b>的股票之後明顯較弱；空間當參考、下修當警訊。更新：${esc(fmtTw(r.generatedAt))}（收盤取自 ${esc(r.closeDate)}）</p>
<div class="cards">
<div class="card"><span class="cname">有共識</span><span class="cdesc">${r.staleDays} 天內有 FactSet 速報的股票</span><b>${counts.cover}</b></div>
<div class="card total"><span class="cname">空間 ≥ ${gatePct}%</span><span class="cdesc">共識目標價比收盤高 ${gatePct}% 以上</span><b>${counts.pass}</b></div>
<div class="card"><span class="cname">今日新進榜</span><span class="cdesc">今天第一次達到門檻（新共識或股價回落）</span><b>${counts.fresh}</b></div>
<div class="card"><span class="cname">近 7 日上修</span><span class="cdesc">最近一則速報是上修 EPS 或目標價</span><b>${counts.up7}</b></div>
<div class="card"><span class="cname">近 7 日下修</span><span class="cdesc">最近一則速報是下修；回測之後 60 日平均跑輸約 3%</span><b>${counts.down7}</b></div>
</div>
<details class="howto"><summary>資料怎麼來、怎麼用、限制</summary><div class="body">
<p><b>來源</b>：鉅亨網「Factset 最新調查」速報。分析師共識（EPS 或目標價中位數）有變動時才會發一則，所以每檔的共識＝最近一則速報；超過 ${r.staleDays} 天沒有新速報的視為過期，預設不顯示。速報從 2024 年開始有。</p>
<p><b>只涵蓋有外資／法人追蹤的股票</b>，大約一百多檔，以中大型股為主；小型股不會出現在這裡，不代表它沒有空間。</p>
<p><b>最高／最低目標價</b>只有「目標價變動」那種速報才附，EPS 變動的速報只有中位數，所以「最樂觀空間」約一半是空的。</p>
<p><b>共識會落後</b>：個別券商調升後，FactSet 共識要等下一則速報才會反映；下方「個別券商目標價」從新聞標題補這段空窗。標題常只寫「外資」不寫是哪家，也有不少「這檔」之類不寫名字的，那些抽不出來。</p>
<p><b>回測（2024-06～2026-08，27 個月，有共識的約 126 檔）</b>：每月買「空間 ≥ 20%」的股票，平均每月比母體<b>少</b> 0.66%（t −1.6），前後兩段方向相反；空間最小的那組反而最好，比較像動能效果。<b>共識下修</b>（目標價或 EPS）之後 60 日平均跑輸約 3%（t 約 −2.9，勝率 35～37%），是唯一站得住的結果；上修之後平均為正但不顯著，而且上修前 20 日股價平均已經漲了 16%，常是分析師在追認漲幅。</p>
<p>所以「空間 ≥ 20%」只當直觀參考，不是買進訊號；勾「近 60 日被下修」看要避開的。樣本短、又是 AI 多頭期，結論僅供參考。完整研究：<a href="https://github.com/hchs200771/100-up-and-down-stocks/blob/main/docs/target-price-backtest.md">target-price-backtest.md</a>。這不是投資建議。</p>
</div></details>
<div class="filters">
<label><span class="fl">空間</span><select id="fGate"><option value="-9">全部</option><option value="0">≥ 0%</option><option value="${r.gate}" selected>≥ ${gatePct}%</option><option value="0.3">≥ 30%</option><option value="0.5">≥ 50%</option></select></label>
<label><span class="fl">分析師</span><select id="fA"><option value="0">不限</option><option value="5">≥ 5 位</option><option value="10">≥ 10 位</option></select></label>
<label><input type="checkbox" id="fNew"><span class="fl">只看今日新進榜</span></label>
<label><input type="checkbox" id="fUp"><span class="fl">30 日目標上調</span></label>
<label><input type="checkbox" id="fDn"><span class="fl">近 60 日被下修</span></label>
<label><input type="checkbox" id="fSt"><span class="fl">含過期共識</span></label>
</div>
<div class="count" id="count"></div>
<div class="tablebox"><table><thead><tr>${cols.map(([t, k]) => `<th data-k="${k}" title="${esc(COL_HELP[k] ?? "")}">${t}</th>`).join("")}</tr></thead><tbody id="tb"></tbody></table></div>
<h2>個別券商目標價（近 14 天新聞）</h2>
<p class="note">FactSet 共識還沒反映的個別券商意見，從新聞<b>標題</b>抽出（只認得標題裡剛好一檔台股、而且寫出目標價數字的）。同一則被多家媒體轉載只算一次。數字以原文為準，點標題看原文。</p>
${calls.length
    ? `<div class="tablebox"><table class="calls"><thead><tr><th>日期</th><th>股票</th><th>券商</th><th>目標價</th><th>方向</th><th>收盤</th><th>空間</th><th>標題</th></tr></thead><tbody>${calls
        .map((c) => `<tr${c.upside !== null && c.upside >= r.gate ? ' class="hit"' : ""}><td>${esc(c.date.slice(5))}</td><td>${stockLink(c.code, `${c.code} ${c.name}`)}</td><td>${c.brokers.length ? esc(c.brokers.join("、")) : '<span class="none">未寫明</span>'}</td><td>${c.prevTarget ? `${numHtml(c.prevTarget)} → ` : ""}${numHtml(c.target)}</td><td>${c.direction === "up" ? '<span class="pos">調升</span>' : c.direction === "down" ? '<span class="neg">調降</span>' : '<span class="none">—</span>'}</td><td>${numHtml(c.close)}</td><td>${pctHtml(c.upside)}</td><td class="t"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>${c.sources.length ? ` <span class="chip">${esc(c.sources.slice(0, 3).join("、"))}${c.sources.length > 3 ? ` 等 ${c.sources.length} 家` : ""}</span>` : ""}</td></tr>`)
        .join("")}</tbody></table></div>`
    : `<p class="note">最近沒有抽得出數字的。</p>`}
${related.length
    ? `<h2>其他相關標題</h2><p class="note">認得出股票，但標題沒寫目標價數字（或寫「這檔」之類代稱，數字可能屬於別檔）。</p><ul class="news">${related
        .map((h) => `<li><span class="d">${esc(h.date.slice(5))}</span>${stockLink(h.code, h.name)} · <a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a>${h.source ? ` <span class="chip">${esc(h.source)}</span>` : ""}</li>`)
        .join("")}</ul>`
    : ""}
</div>
<script>
const ROWS=${JSON.stringify(rows).replace(/</g, "\\u003c")};
const CLOSE_MS=Date.parse(${JSON.stringify(r.closeDate)});
const recentDown=r=>r.ldir==='down'&&CLOSE_MS-Date.parse(r.ld)<=60*864e5;
let sortK='u',sortD=-1;
const $=id=>document.getElementById(id);
const none='<span class="none">—</span>';
const pct=v=>v==null?none:Math.abs(v)<5e-4?'<span class="none">0.0%</span>':'<span class="'+(v<0?'neg':'pos')+'">'+(v>0?'+':'')+(v*100).toFixed(1)+'%</span>';
const num=v=>v==null?none:v.toLocaleString('zh-TW',{maximumFractionDigits:2});
const sl=(r,t)=>'<a href="'+r.y+'" target="_blank" rel="noopener">'+t+'</a>';
function render(){
  const g=+$('fGate').value,a=+$('fA').value;
  let rows=ROWS.filter(r=>($('fSt').checked||!r.st)&&(g<=-9||(r.u!=null&&r.u>=g))&&r.a>=a&&(!$('fNew').checked||r.nw)&&(!$('fUp').checked||(r.d30!=null&&r.d30>0))&&(!$('fDn').checked||recentDown(r)));
  rows=[...rows].sort((a,b)=>{const x=a[sortK],y=b[sortK];if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1;return (x>y?1:x<y?-1:0)*sortD;});
  $('count').textContent='顯示 '+rows.length+' / '+ROWS.length+' 檔';
  $('tb').innerHTML=rows.map(r=>'<tr'+(r.st?' class="stale"':'')+'><td>'+sl(r,r.c)+'</td><td>'+sl(r,r.n)+(r.nw?'<span class="new">新</span>':'')+'</td><td'+(r.pxd?' title="'+r.pxd+' 收盤"':'')+'>'+num(r.px)+(r.pxd?'*':'')+'</td><td>'+num(r.t)+'</td><td>'+pct(r.u)+'</td><td>'+num(r.th)+'</td><td>'+pct(r.uh)+'</td><td>'+num(r.tl)+'</td><td>'+r.a+'</td><td>'+pct(r.d30)+'</td><td><a href="'+r.lu+'" target="_blank" rel="noopener">'+r.ld.slice(5)+'</a> <span class="chip">'+(r.lk==='eps'?'EPS':'目標價')+(r.ldir==='up'?'↑':'↓')+'</span></td><td>'+(r.f||none)+'</td></tr>').join('');
}
['fGate','fA','fNew','fUp','fDn','fSt'].forEach(id=>$(id).addEventListener('change',render));
document.querySelectorAll('table:not(.calls) th').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.k;if(sortK===k)sortD=-sortD;else{sortK=k;sortD=k==='c'||k==='n'?1:-1;}render();}));
render();
</script>
</body>
</html>
`;
}
