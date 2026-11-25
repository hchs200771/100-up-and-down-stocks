import { renderSubpageNav } from "./nav";
import { fmtTw } from "./time";

/** 版型同強勢追蹤頁（scripts/lib/strong-tracking-page.ts） */
const STYLE = `<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:16px;margin:20px 0 6px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.note{color:var(--up)}
.regime{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}
.regime.ok{border-color:var(--down)}.regime.bad{border-color:var(--up)}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.card{flex:1 1 150px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.card .cname{font-size:14px;font-weight:700}
.card .cdesc{color:var(--muted);font-size:11.5px;line-height:1.5;margin-top:2px;flex:1}
.card b{font-size:17px;line-height:1.2;margin-top:6px}
.card.total{border-color:var(--accent)}.card.total .cname,.card.total b{color:var(--accent)}
.acct{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}
.acct input{width:130px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:860px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:nth-child(-n+2),td:nth-child(-n+2){text-align:left}
th{background:var(--card);color:var(--muted);font-weight:600}
tr:hover td{background:color-mix(in srgb,var(--accent) 6%,transparent)}
a{color:var(--accent);text-decoration:none}
.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;font-size:11px;color:var(--muted);margin-right:3px}
.pos{color:var(--up)}.neg{color:var(--down)}.none{color:var(--muted)}
.empty{padding:14px;color:var(--muted);font-size:13px}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;font-size:13px;color:var(--muted)}
details.howto summary{cursor:pointer;padding:10px 16px;font-size:14px;font-weight:600;color:var(--fg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto p{margin:6px 0}
details.howto b{color:var(--fg)}
</style>`;

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 財報選股子頁（scripts/build-earnings-scan.ts 產出的 JSON → HTML） */
export function renderEarningsScan(r: any): string {
  const s = r.seasons.at(-1);
  const st = r.positions.stats;
  const card = (name: string, desc: string, v: any) =>
    `<div class="card"><span class="cname">${name}</span><span class="cdesc">${desc}</span><b>${v ? `${v.avg > 0 ? "+" : ""}${v.avg}%${v.excess != null ? `（超額 ${v.excess > 0 ? "+" : ""}${v.excess}）` : ""}・${v.n} 筆` : "—"}</b></div>`;
  const data = JSON.stringify({ seasons: r.seasons.map((x: any) => ({ quarter: x.quarter, rows: x.rows })), open: r.positions.open, closed: r.positions.closed }).replace(/</g, "\\u003c");
  const head = s
    ? `${esc(s.quarter)} 季報：申報窗口 ${esc(s.window[0])}～${esc(s.window[1])}（法定期限 ${esc(s.deadline)}），目前已公布 ${s.filed} 家${s.noData ? `（其中 ${s.noData} 家還沒有財報數字或缺去年同季）` : ""}。門檻取自 ${esc(s.cutoff.from[0])}～${esc(s.cutoff.from.at(-1))} 共 ${s.cutoff.n.toLocaleString()} 筆：最高 20% ≥ ${s.cutoff.hiPct}%、最低 20% ≤ ${s.cutoff.loPct}%（獲利驚喜占股價的百分比）。`
    : "目前沒有進行中的財報季。";
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>財報選股</title>${STYLE}<style>details.sec{margin:16px 0}details.sec>summary{cursor:pointer;font-size:16px;font-weight:700;margin:0 0 6px}</style></head><body><div class="wrap">
${renderSubpageNav("earnings-scan.html")}<h1>🧾 財報選股</h1>
<p class="sub">財報季每天掃描新公布的季報，找出「營收成長解釋不了的獲利」最多與最少的公司。<b>目前是前瞻追蹤，不是下單訊號。</b>資料日：${esc(r.tradingDate)}，更新：${esc(fmtTw(r.generatedAt))}</p>
<p class="sub">${head}</p>
${r.warnings.map((w: string) => `<p class="note">⚠️ ${esc(w)}</p>`).join("")}
<p class="sub"><b>下面四張卡片是「紙上追蹤」的實際結果，不是回測。</b>每筆財報照規則在公布隔天開盤假裝買進，持有滿 20／60 個交易日後算報酬（扣成本），括號是相對加權指數的超額；還沒滿天數的不算進來。灰字的「回測」數字是 2020Q3–2026Q2 歷史回測的平均，拿來對照。2026Q2、Q3 是上線前用真實公布日回補的；其中 2026Q2 也在回測期間內，2026Q3 起才是回測沒看過的新資料。</p>
<div class="cards">
${card("紙上追蹤・候選 20 日", "獲利驚喜最高 20%；回測 +1.70%", st.top20)}
${card("紙上追蹤・候選 60 日", "回測 +2.32%", st.top60)}
${card("紙上追蹤・警示 20 日", "獲利驚喜最低 20%；回測 −2.40%", st.bottom20)}
${card("紙上追蹤・警示 60 日", "回測 −3.09%", st.bottom60)}
</div>
<details class="howto"><summary>規則、回測結果與限制</summary><div class="body">
<p><b>獲利驚喜</b>＝（單季 EPS − 去年同季 EPS × 今年單季營收 ÷ 去年單季營收）÷ 公布日收盤價。意思是：如果利潤率跟去年一樣，營收成長應該帶來多少 EPS；實際 EPS 比這個多出來的部分，就是毛利率、費用、業外帶來的意外。營收早就從月營收知道了，這部分才是季報的新資訊。去年同季 EPS ≤ 0 的公司不算。</p>
<p><b>候選／警示</b>：獲利驚喜 ≥ 前 4 季全部公司的第 80 百分位＝候選；≤ 第 20 百分位＝警示。用前 4 季定門檻，是因為財報季中途還不知道這季全部公司的分布。紙上部位只收近 20 日平均成交值 ≥ 2,000 萬、上市滿 60 個交易日的股票。</p>
<p><b>進場與出場</b>：公布日（董事會通過財報的重大訊息日期）之後第一個交易日開盤買；如果當晚彙總表還沒有數字，就從第一次看到數字那天之後才買。持有 20、60 個交易日後開盤賣，兩種同時記。報酬已扣來回成本 0.585%；超額＝減去同期加權指數。</p>
<p><b>回測（2020Q3–2026Q2，24 季，約 4.1 萬筆）</b>：候選組 20 日平均超額 +1.70%（扣成本 +1.12%，83% 的季為正），60 日 +2.32%；每一年都是正的。警示組 20 日 −2.40%、60 日 −3.09%，每一年都落後。同一批公司等到法定期限才買，20 日超額只剩 +0.81%，所以要早點上車。比公布日早 15 天以上就公布、又在候選組的，20 日 +3.40%（只有 13 季，未通過多重比較校正）。詳見因子驗證〈財報一公布就看亮點買進〉。</p>
<p><b>限制</b>：超額是平均值，個股差異很大；沒有控制產業與市值；回測超額是對全市場等權平均，這裡的超額是對加權指數；財報數字來自觀測站彙總表，少數公司晚幾天才出現。這不是投資建議。</p>
</div></details>
<p class="sub">表格都可以點欄位標題排序（例如公布時間、營收年增、獲利驚喜），再點一次反向。</p>
<details class="sec" open><summary>候選：獲利驚喜最高 20%</summary>
<div class="tablebox" id="top"></div></details>
<details class="sec" open><summary>警示：獲利驚喜最低 20%（持股出現在這裡要注意）</summary>
<div class="tablebox" id="bottom"></div></details>
<details class="sec" open><summary>紙上部位：還沒滿 60 日</summary>
<div class="tablebox" id="open"></div></details>
<details class="sec" open><summary>紙上部位：已滿 60 日</summary>
<div class="tablebox" id="closed"></div></details>
</div>
<script>
const D=${data};
const $=id=>document.getElementById(id);
const yi=(r,t)=>'<a href="https://tw.stock.yahoo.com/quote/'+r.code+(r.market==='twse'?'.TW':'.TWO')+'" target="_blank" rel="noopener">'+t+'</a>';
const pc=(v,d=2)=>v==null?'<span class="none">—</span>':'<span class="'+(v<0?'neg':'pos')+'">'+(v>0?'+':'')+v.toFixed(d)+'%</span>';
const pp=v=>v==null?'<span class="none">—</span>':(v>0?'+':'')+v.toFixed(1);
/* 可排序表格：點欄位標題排序，再點一次反向 */
function mount(id,cols,rows,key,dir){
  const el=$(id);
  const draw=()=>{
    if(!rows.length){el.innerHTML='<div class="empty">沒有</div>';return;}
    const c=cols[key];
    const v=r=>{const x=c.k(r);return x==null||x===''||(typeof x==='number'&&!isFinite(x))?null:x;};
    const sorted=[...rows].sort((a,b)=>{const x=v(a),y=v(b);if(x==null)return y==null?0:1;if(y==null)return -1;return (x<y?-1:x>y?1:0)*dir;});
    el.innerHTML='<table><thead><tr>'+cols.map((c,i)=>'<th data-i="'+i+'" style="cursor:'+(c.k?'pointer':'default')+'">'+c.h+(i===key?(dir<0?' ▼':' ▲'):'')+'</th>').join('')+'</tr></thead><tbody>'+sorted.map(r=>'<tr>'+cols.map(c=>'<td>'+c.f(r)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
    el.querySelectorAll('th').forEach(th=>th.onclick=()=>{const i=+th.dataset.i;if(!cols[i].k)return;if(i===key)dir=-dir;else{key=i;dir=i<2?1:-1;}draw();});
  };
  draw();
}
const S=D.seasons.at(-1)||{rows:[]};
const e2=v=>v==null?'—':v.toFixed(2);
const H=[
  {h:'代號',k:r=>r.code,f:r=>yi(r,r.code)},
  {h:'名稱',k:r=>r.name,f:r=>yi(r,r.name)+(r.liquid===false?' <span class="chip">成交量不足</span>':'')+(r.seen>r.date?' <span class="chip">'+r.seen+' 才有數字</span>':'')},
  {h:'公布時間',k:r=>r.date+' '+r.time,f:r=>r.date+' '+r.time.slice(0,5)},
  {h:'獲利驚喜',k:r=>r.surp,f:r=>pc(r.surp)},
  {h:'單季 EPS',k:r=>r.eps,f:r=>e2(r.eps)},
  {h:'去年同季',k:r=>r.epsLy,f:r=>e2(r.epsLy)},
  {h:'EPS 年增',k:r=>r.eps!=null&&r.epsLy>0?r.eps/r.epsLy-1:null,f:r=>r.eps!=null&&r.epsLy>0?pc((r.eps/r.epsLy-1)*100,0):'<span class="none">—</span>'},
  {h:'營收年增',k:r=>r.revYoy,f:r=>pc(r.revYoy,1)},
  {h:'毛利率年增',k:r=>r.gmYoy,f:r=>pp(r.gmYoy)},
  {h:'營益率年增',k:r=>r.opmYoy,f:r=>pp(r.opmYoy)},
  {h:'公布日收盤',k:r=>r.px,f:r=>r.px},
];
mount('top',H,S.rows.filter(r=>r.side==='top'),2,-1);
mount('bottom',H,S.rows.filter(r=>r.side==='bottom'),2,-1);
const leg=l=>l.status==='open'?'<span class="none">持有中</span>':pc(l.ret)+(l.excess!=null?' <span class="chip">超額 '+(l.excess>0?'+':'')+l.excess.toFixed(2)+'</span>':'');
const SIDE={top:'候選',bottom:'警示'};
const P=[
  {h:'代號',k:p=>p.code,f:p=>yi(p,p.code)},
  {h:'名稱',k:p=>p.name,f:p=>yi(p,p.name)+(p.backfill?' <span class="chip">上線前回補</span>':'')},
  {h:'組別',k:p=>p.side,f:p=>SIDE[p.side]},
  {h:'季別',k:p=>p.quarter,f:p=>p.quarter},
  {h:'公布日',k:p=>p.announce,f:p=>p.announce},
  {h:'進場日',k:p=>p.entryDate,f:p=>p.entryDate??'明天開盤'},
  {h:'進場價',k:null,f:p=>p.entry??'—'},
  {h:'獲利驚喜',k:p=>p.surp,f:p=>pc(p.surp)},
  {h:'目前報酬',k:p=>p.ret,f:p=>pc(p.ret)},
  {h:'目前超額',k:p=>p.excess,f:p=>pc(p.excess)},
  {h:'已持有',k:p=>p.held,f:p=>p.held??0},
  {h:'20 日',k:p=>p.d20.ret,f:p=>leg(p.d20)},
  {h:'60 日',k:p=>p.d60.ret,f:p=>leg(p.d60)},
];
mount('open',P,D.open,4,-1);
mount('closed',P,D.closed,4,-1);
</script>
</body></html>`;
}
