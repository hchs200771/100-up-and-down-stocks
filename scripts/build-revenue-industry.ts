#!/usr/bin/env npx tsx
/**
 * 月營收的產業族群性：營收強勢／弱勢是不是集中在某些產業？純規則、零 LLM。
 *
 * 讀：data/revenue-history/<YYYY-MM>.json
 * 寫：data/revenue-industry-latest.json、data/revenue-industry.html（子頁 /revenue-industry.html）
 *
 * ## 判定
 *
 *   強勢 = 單月 YoY ≥ 20%（與營收動能名單同一道門檻）
 *   弱勢 = 單月 YoY ≤ −20%（與營收衰退名單同一道門檻）
 *
 * 每個產業的強勢（弱勢）家數跟「全市場比例 × 該產業已公布家數」比，用二項分布的 z 值
 * 判斷是不是明顯集中：z ≥ 2 且至少 3 家才標「族群」。家數少的產業比例很容易偏高，
 * 單看比例會一直誤報，所以用 z 值。
 * 另外給產業合計 YoY（加總營收 ÷ 加總去年同月）與它跟前 3 個月平均的差，看整個產業是在
 * 轉強還是轉弱。
 *
 * ⚠️ 這是觀察工具，還沒回測過「產業族群性」對後續報酬有沒有幫助。
 *
 * 只讀本機檔案、幾秒內跑完；每日流程裡跟月營收抓取放在同一個背景子流程，不影響主流程時間。
 *
 * 用法：npx tsx scripts/build-revenue-industry.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { twIso, fmtTw } from "./lib/time";
import { renderSubpageNav } from "./lib/nav";
import { monthsBack } from "./fetch-monthly-revenue";
import { loadSnapshots, coverageOf, lastCompleteMonth, MIN_BASE, MIN_COVERAGE, isTib } from "./lib/revenue-factors";

const ROOT = process.cwd();
const OUT_LATEST = "data/revenue-industry-latest.json";
const OUT_HTML = "data/revenue-industry.html";
const STRONG = 0.2;
const WEAK = -0.2;
const MIN_FIRMS = 5;
const Z_FLAG = 2;
/** 原始產業別有時帶整段括號說明（例如金融保險業），頁面只顯示括號前的名稱 */
const indName = (s: string) => s.replace(/[（(].*$/, "").trim() || s;

const snaps = loadSnapshots(ROOT);
if (!snaps.size) {
  console.error("data/revenue-history 是空的，先跑 npx tsx scripts/fetch-monthly-revenue.ts --months 36");
  process.exit(1);
}
const allMonths = [...snaps.keys()].sort();
const latestMonth = allMonths[allMonths.length - 1];
const completeMonth = lastCompleteMonth(snaps);

/** 上次輸出：用來標出「這次才新公布」的家數 */
const prevCounts = new Map<string, number>();
{
  const p = resolve(ROOT, OUT_LATEST);
  if (existsSync(p)) {
    for (const l of JSON.parse(readFileSync(p, "utf-8")).lists ?? []) {
      for (const i of l.industries ?? []) prevCounts.set(`${l.month}/${i.industry}`, i.reported);
    }
  }
}

interface Firm { code: string; name: string; yoy: number }

function firmsOf(month: string) {
  const out = new Map<string, Firm[]>();
  const agg = new Map<string, { rev: number; prevY: number }>();
  for (const [code, r] of Object.entries(snaps.get(month)?.stocks ?? {})) {
    if (isTib(r.n) || r.ind === "存託憑證" || !r.ind) continue;
    if (!(r.prevY >= MIN_BASE) || !(r.rev > 0)) continue;
    const ind = indName(r.ind);
    let arr = out.get(ind);
    if (!arr) out.set(ind, (arr = []));
    arr.push({ code, name: r.n, yoy: r.rev / r.prevY - 1 });
    const a = agg.get(ind) ?? { rev: 0, prevY: 0 };
    a.rev += r.rev; a.prevY += r.prevY;
    agg.set(ind, a);
  }
  return { firms: out, agg };
}

const zOf = (k: number, n: number, p: number) => (p > 0 && p < 1 ? (k - n * p) / Math.sqrt(n * p * (1 - p)) : 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

function build(month: string) {
  const { firms, agg } = firmsOf(month);
  const all = [...firms.values()].flat();
  const pStrong = all.filter((f) => f.yoy >= STRONG).length / (all.length || 1);
  const pWeak = all.filter((f) => f.yoy <= WEAK).length / (all.length || 1);
  // 前 3 個月的產業合計 YoY（只用已公布完的月份才公平；公布中月份會缺很多家）
  const past = [1, 2, 3].map((j) => firmsOf(monthsBack(month, j)).agg);
  const industries = [...firms.entries()].map(([industry, fs]) => {
    const strong = fs.filter((f) => f.yoy >= STRONG).sort((a, b) => b.yoy - a.yoy);
    const weak = fs.filter((f) => f.yoy <= WEAK).sort((a, b) => a.yoy - b.yoy);
    const a = agg.get(industry)!;
    const aggYoy = a.prevY > 0 ? a.rev / a.prevY - 1 : null;
    const pastY = past.map((p) => p.get(industry)).filter((x): x is { rev: number; prevY: number } => !!x && x.prevY > 0).map((x) => x.rev / x.prevY - 1);
    const zStrong = zOf(strong.length, fs.length, pStrong);
    const zWeak = zOf(weak.length, fs.length, pWeak);
    const enough = fs.length >= MIN_FIRMS;
    const prev = prevCounts.get(`${month}/${industry}`);
    return {
      industry,
      reported: fs.length,
      newlyReported: prev === undefined ? null : fs.length - prev,
      strong: strong.length, weak: weak.length,
      strongShare: strong.length / fs.length, weakShare: weak.length / fs.length,
      zStrong: +zStrong.toFixed(2), zWeak: +zWeak.toFixed(2),
      strongCluster: enough && strong.length >= 3 && zStrong >= Z_FLAG,
      weakCluster: enough && weak.length >= 3 && zWeak >= Z_FLAG,
      medianYoy: median(fs.map((f) => f.yoy)),
      aggYoy,
      /** 產業合計 YoY 減前 3 個月平均：正＝整個產業在轉強 */
      aggYoyChange: aggYoy !== null && pastY.length === 3 ? aggYoy - pastY.reduce((s, x) => s + x, 0) / 3 : null,
      topStrong: strong.slice(0, 6).map(({ code, name, yoy }) => ({ code, name, yoy })),
      topWeak: weak.slice(0, 6).map(({ code, name, yoy }) => ({ code, name, yoy })),
    };
  }).sort((x, y) => (y.zStrong - y.zWeak) - (x.zStrong - x.zWeak));
  return {
    month,
    coverage: coverageOf(snaps, month),
    partial: coverageOf(snaps, month) < MIN_COVERAGE,
    marketFirms: all.length,
    marketStrongShare: pStrong,
    marketWeakShare: pWeak,
    strongClusters: industries.filter((i) => i.strongCluster).map((i) => i.industry),
    weakClusters: industries.filter((i) => i.weakCluster).map((i) => i.industry),
    industries,
  };
}

const lists = [completeMonth, latestMonth].filter((m, i, a) => m && a.indexOf(m) === i).map(build);
const result = {
  generatedAt: twIso(),
  rule: { 強勢: "單月 YoY ≥ 20%", 弱勢: "單月 YoY ≤ −20%", 族群: `已公布 ≥ ${MIN_FIRMS} 家、命中 ≥ 3 家，且比例明顯高於全市場（二項 z ≥ ${Z_FLAG}）` },
  active: completeMonth || null,
  lists,
};
writeFileSync(resolve(ROOT, OUT_LATEST), JSON.stringify(result, null, 2));

// ---------- 子頁 ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderHtml(r: typeof result): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>營收產業族群</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">🏭</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:15px;margin:18px 0 6px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.note{color:var(--up)}
.months button{font:inherit;font-size:13px;padding:4px 12px;margin:8px 6px 0 0;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg);cursor:pointer}
.months button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.clusters{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin:12px 0}
.cl{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.cl h3{margin:0 0 6px;font-size:14px}
.cl.s h3{color:var(--up)}.cl.w h3{color:var(--down)}
.cl .item{margin:6px 0;font-size:13px}
.cl .names{color:var(--muted);font-size:12px}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:900px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{position:sticky;top:0;background:var(--card);cursor:pointer;user-select:none;color:var(--muted);font-weight:600}
tr:hover td{background:color-mix(in srgb,var(--accent) 6%,transparent)}
.pos{color:var(--up)}.neg{color:var(--down)}.none{color:var(--muted)}
.tag{display:inline-block;border-radius:99px;padding:0 7px;font-size:11px;margin-left:5px}
.tag.s{color:#fff;background:var(--up)}.tag.w{color:#fff;background:var(--down)}
a{color:var(--accent);text-decoration:none}
.nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.nav a{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:700;background:var(--card);color:var(--fg)}
.nav a:hover{border-color:var(--accent);color:var(--accent)}
.nav a.here{background:var(--accent);border-color:var(--accent);color:#fff}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;font-size:13px;color:var(--muted)}
details.howto summary{cursor:pointer;padding:10px 16px;font-size:14px;font-weight:600;color:var(--fg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto b{color:var(--fg)}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("revenue-industry.html")}
<h1>🏭 營收產業族群</h1>
<p class="sub">營收強勢（YoY ≥ 20%）與弱勢（YoY ≤ −20%）是不是集中在某些產業。更新：${esc(fmtTw(r.generatedAt))}</p>
<div class="months" id="months"></div>
<p class="note" id="mnote"></p>
<details class="howto"><summary>怎麼看</summary><div class="body">
<p><b>族群</b>：產業內強勢（或弱勢）的比例明顯高於全市場，才標成族群。判斷用二項分布的 z 值（≥ 2），並要求已公布至少 ${MIN_FIRMS} 家、命中至少 3 家。家數少的產業比例很容易偏高，所以不能只看比例。</p>
<p><b>產業合計 YoY</b>：整個產業的營收加總跟去年同月比，大公司權重大。<b>較前 3 月</b>是它減去前 3 個月的平均，正值代表整個產業正在轉強。</p>
<p><b>公布中月份</b>：每月 1~10 號公司陸續公布，早報的公司不一定有代表性，族群判斷要等家數夠多再看。「今日新增」是這次比上次多公布的家數。</p>
<p>⚠️ 這是觀察工具，還沒有回測過產業族群性對後續股價的預測力。</p>
</div></details>
<div class="clusters" id="clusters"></div>
<h2>全部產業</h2>
<div class="tablebox"><table><thead><tr>
<th data-k="industry">產業</th><th data-k="reported">已公布</th><th data-k="newlyReported">今日新增</th><th data-k="strong">強勢家數</th><th data-k="strongShare">強勢比例</th><th data-k="zStrong">強勢 z</th><th data-k="weak">弱勢家數</th><th data-k="weakShare">弱勢比例</th><th data-k="zWeak">弱勢 z</th><th data-k="medianYoy">YoY 中位數</th><th data-k="aggYoy">產業合計 YoY</th><th data-k="aggYoyChange">較前 3 月</th>
</tr></thead><tbody id="tb"></tbody></table></div>
</div>
<script>
const DATA=${JSON.stringify(r.lists).replace(/</g, "\\u003c")};
const ACTIVE=${JSON.stringify(r.active)};
let cur=Math.max(0,DATA.findIndex(d=>d.month===ACTIVE)),sortK=null,sortD=-1;
const $=id=>document.getElementById(id);
const pct=v=>v==null?'<span class="none">—</span>':'<span class="'+(v<0?'neg':'pos')+'">'+(v>0?'+':'')+(v*100).toFixed(1)+'%</span>';
const pp=v=>v==null?'<span class="none">—</span>':'<span class="'+(v<0?'neg':'pos')+'">'+(v>0?'+':'')+(v*100).toFixed(1)+'pp</span>';
const share=v=>(v*100).toFixed(0)+'%';
const names=xs=>xs.map(f=>f.name+' '+(f.yoy>0?'+':'')+(f.yoy*100).toFixed(0)+'%').join('、');
function render(){
  const d=DATA[cur];
  $('months').innerHTML=DATA.map((m,i)=>'<button class="'+(i===cur?'on':'')+'" data-i="'+i+'">'+m.month+(m.partial?' 公布中':' 已公布完')+'</button>').join('');
  $('mnote').textContent=(d.partial?'⚠️ '+d.month+' 還在公布中（已收 '+d.coverage+' 家），族群判斷會隨公布家數變動。':'')+' 全市場 '+d.marketFirms+' 家：強勢 '+share(d.marketStrongShare)+'、弱勢 '+share(d.marketWeakShare)+'。';
  const block=(cls,title,list,key,top)=>'<div class="cl '+cls+'"><h3>'+title+'（'+list.length+'）</h3>'+(list.length?list.map(i=>'<div class="item"><b>'+i.industry+'</b> '+i[key]+'/'+i.reported+' 家（z '+i[key==='strong'?'zStrong':'zWeak'].toFixed(1)+'），產業合計 YoY '+pct(i.aggYoy)+'<div class="names">'+names(i[top])+'</div></div>').join(''):'<div class="item none">沒有明顯集中的產業</div>')+'</div>';
  $('clusters').innerHTML=block('s','📈 營收強勢族群',d.industries.filter(i=>i.strongCluster),'strong','topStrong')+block('w','📉 營收弱勢族群',d.industries.filter(i=>i.weakCluster),'weak','topWeak');
  let rows=d.industries;
  if(sortK)rows=[...rows].sort((a,b)=>{const x=a[sortK],y=b[sortK];if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1;return (x>y?1:x<y?-1:0)*sortD;});
  $('tb').innerHTML=rows.map(i=>'<tr><td>'+i.industry+(i.strongCluster?'<span class="tag s">強勢族群</span>':'')+(i.weakCluster?'<span class="tag w">弱勢族群</span>':'')+'</td><td>'+i.reported+'</td><td>'+(i.newlyReported?'+'+i.newlyReported:'<span class="none">—</span>')+'</td><td>'+i.strong+'</td><td>'+share(i.strongShare)+'</td><td>'+i.zStrong.toFixed(1)+'</td><td>'+i.weak+'</td><td>'+share(i.weakShare)+'</td><td>'+i.zWeak.toFixed(1)+'</td><td>'+pct(i.medianYoy)+'</td><td>'+pct(i.aggYoy)+'</td><td>'+pp(i.aggYoyChange)+'</td></tr>').join('');
}
$('months').addEventListener('click',e=>{const b=e.target.closest('button');if(b){cur=+b.dataset.i;render();}});
document.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.k;if(sortK===k)sortD=-sortD;else{sortK=k;sortD=-1;}render();}));
render();
</script>
</body>
</html>
`;
}

writeFileSync(resolve(ROOT, OUT_HTML), renderHtml(result));
for (const l of result.lists) {
  console.log(`[revenue-industry] ${l.month}${l.partial ? "（公布中）" : ""}：強勢族群 ${l.strongClusters.join("、") || "無"}；弱勢族群 ${l.weakClusters.join("、") || "無"}`);
}
