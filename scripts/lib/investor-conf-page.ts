/**
 * /investor-conf.html — 法說會判讀子頁。資料由 scripts/fetch-investor-conferences.ts 準備好，這裡只負責排版。
 * 內容是一段段文字，不適合表格，所以每場一張卡片；樣式沿用 target-price-page.ts 的 CSS 變數。
 * 網站公開：只放判讀摘要，不放簡報全文與逐字稿。
 */
import { fmtTw } from "./time";
import { renderSubpageNav } from "./nav";
import { yahooUrl } from "./stock-links";
import type { ConfResult, InvestorConfLatest } from "../fetch-investor-conferences";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MARKET: Record<string, string> = { sii: "上市", otc: "上櫃", rotc: "興櫃" };
const WEEKDAY = "日一二三四五六";
const mmdd = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;
const stockLink = (code: string, text: string) => `<a href="${yahooUrl(code)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const list = (title: string, xs: string[], cls = "") =>
  xs.length ? `<div class="blk ${cls}"><div class="bt">${title}</div><ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "";

function card(x: ConfResult, isNew: boolean): string {
  const a = x.analysis;
  const score = a?.score ?? 0;
  const sources = [
    x.deck ? `簡報 ${x.deck.pages} 頁${x.deck.imageHeavy ? "（多為圖片）" : ""}` : x.deckStatus === "尚未上傳" ? "簡報尚未上傳" : "無簡報",
    x.transcript ? `影音 ${x.transcript.minutes} 分鐘` : x.videoStatus === "無影片" ? "" : `影音：${x.videoStatus}`,
  ].filter(Boolean);
  const head = `<div class="ch">
<span class="score s${score}">${a ? score : "–"}</span>
<div class="who"><div class="nm">${stockLink(x.code, `${x.code} ${x.name}`)}${isNew ? ' <span class="new">新</span>' : ""} <span class="chip">${MARKET[x.market]}</span>${a ? ` <span class="verdict v${score}">${esc(a.verdict)}</span>` : ""}${a && a.tone !== "無法判斷" ? ` <span class="chip tone-${a.tone}">語氣${esc(a.tone)}</span>` : ""}</div>
<div class="meta">${mmdd(x.date)} ${esc(x.time)} · ${esc(x.place)}</div></div></div>`;
  if (!a) {
    return `<article class="conf" data-s="0" data-m="${x.market}" data-d="${x.date}" data-n="${isNew ? 1 : 0}" data-st="pending">${head}
<p class="hl none">${esc(x.pendingNote || "尚未判讀")}，下次更新會補上</p>
<p class="sum">${esc(x.summary)}</p><div class="src">${sources.map((s) => `<span class="chip">${esc(s)}</span>`).join(" ")}</div></article>`;
  }
  const nums = a.keyNumbers.length
    ? `<div class="nums">${a.keyNumbers.map((n) => `<span class="num"><span class="nl">${esc(n.label)}</span><b>${esc(n.value)}</b></span>`).join("")}</div>`
    : "";
  return `<article class="conf" data-s="${score}" data-m="${x.market}" data-d="${x.date}" data-n="${isNew ? 1 : 0}" data-st="${x.state ?? "done"}">${head}
<p class="hl">${esc(a.headline)}</p>
<p class="reason">${esc(a.reason)}</p>
${nums}
<details${score >= 4 ? " open" : ""}><summary>展望、動能與風險</summary>
<div class="blk"><div class="bt">展望</div><p>${esc(a.guidance)}</p></div>
${list("成長動能", a.drivers, "up")}${list("風險／警訊", a.risks, "dn")}${list("問答與口頭補充", a.qaHighlights)}
<div class="blk"><div class="bt">公告擇要訊息</div><p class="sum">${esc(x.summary)}</p></div>
${x.context.revenue || x.context.move ? `<div class="blk"><div class="bt">市場脈絡</div><p class="sum">${[x.context.revenue, x.context.move].filter(Boolean).map((s) => esc(s!)).join("<br>")}</p></div>` : ""}
</details>
<div class="src">${sources.map((s) => `<span class="chip">${esc(s)}</span>`).join(" ")}${x.state === "partial" && x.pendingNote ? ` <span class="chip warnc">待補：${esc(x.pendingNote)}，補上後會重新判讀</span>` : ""}</div>
</article>`;
}

export function renderInvestorConfPage(r: InvestorConfLatest): string {
  const items = r.items;
  const newSet = new Set(r.run?.newKeys ?? []);
  const counts = {
    all: items.length,
    hot: items.filter((x) => (x.analysis?.score ?? 0) >= 4).length,
    done: items.filter((x) => x.state === "done").length,
    partial: items.filter((x) => x.state === "partial").length,
    pending: items.filter((x) => x.state === "pending").length,
    fresh: newSet.size,
  };
  const range = r.from === r.date ? mmdd(r.date) : `${mmdd(r.from)} ～ ${mmdd(r.date)}`;
  const dates = [...new Set(items.map((x) => x.date))].sort().reverse();
  const names = (xs: ConfResult[]) => xs.map((x) => `${x.code} ${x.name}`).join("、");
  const freshItems = items.filter((x) => newSet.has(x.key));
  const waiting = items.filter((x) => x.state !== "done");
  const running = r.run && !r.run.finishedAt;
  const banner = `<div class="run${running ? " live" : ""}">
<div class="rt">${running ? "⏳ 背景仍在處理中" : "✅ 這次更新已處理完"}<span class="rtime">（${esc(fmtTw(r.generatedAt))}）</span></div>
<p><b>這次新增 ${counts.fresh} 場</b>${freshItems.length ? `：${esc(names(freshItems))}` : ""}</p>
<p><b>已完整判讀 ${counts.done} 場</b>；已判讀但還在等資料 ${counts.partial} 場；還沒判讀 ${counts.pending} 場。</p>
${waiting.length ? `<p class="note">還沒完成的：${esc(names(waiting))}。法說會判讀在每日報告背景執行、不等它跑完，這些會在下次更新時補上（頁面保留最近 7 天）。</p>` : ""}
</div>`;

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>法說會判讀</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">🎤</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42;--warn:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:16px;margin:24px 0 8px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.card{flex:1 1 140px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.card .cname{font-size:14px;font-weight:700}
.card .cdesc{color:var(--muted);font-size:11.5px;line-height:1.5;margin-top:2px;flex:1}
.card b{font-size:17px;line-height:1.2;margin-top:6px}
.card.total{border-color:var(--accent)}.card.total .cname,.card.total b{color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0;font-size:13px}
.filters label{display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}
.filters .fl{font-weight:700;color:color-mix(in srgb,var(--accent) 78%,var(--muted))}
.filters select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:13px}
.count{margin:8px 2px;color:var(--muted);font-size:13px}
.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;font-size:11px;color:var(--muted);white-space:nowrap}
.none{color:var(--muted)}
article.conf{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:10px 0}
article.conf[data-s="5"]{border-color:var(--up);box-shadow:inset 4px 0 0 var(--up)}
article.conf[data-s="4"]{box-shadow:inset 4px 0 0 var(--warn)}
.ch{display:flex;gap:12px;align-items:flex-start}
.score{flex:none;width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:800;background:var(--chip);color:var(--muted)}
.score.s5{background:var(--up);color:#fff}.score.s4{background:var(--warn);color:#fff}.score.s3{color:var(--fg)}
.who{min-width:0}
.nm{font-size:15px;font-weight:700;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}
.meta{color:var(--muted);font-size:12.5px;margin-top:1px}
.verdict{font-size:12px;font-weight:700;border-radius:6px;padding:0 6px;background:var(--chip)}
.verdict.v5{color:var(--up)}.verdict.v4{color:var(--warn)}
.tone-轉佳{color:var(--up)}.tone-轉差{color:var(--down)}
.hl{font-size:15px;font-weight:700;margin:10px 0 2px}
.reason{margin:2px 0 8px;color:var(--fg)}
.nums{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.num{display:inline-flex;flex-direction:column;background:var(--chip);border-radius:8px;padding:4px 10px;font-size:12px;line-height:1.35}
.num .nl{color:var(--muted)}
.num b{font-size:13.5px}
details{margin-top:6px;border-top:1px solid var(--line);padding-top:6px}
details summary{cursor:pointer;font-size:13px;color:var(--muted);font-weight:600}
.blk{margin:8px 0}
.blk .bt{font-size:12px;font-weight:700;color:var(--muted);margin-bottom:2px}
.blk p{margin:0}
.blk ul{margin:0;padding-left:20px}
.blk.up .bt{color:var(--up)}.blk.dn .bt{color:var(--down)}
.sum{color:var(--muted);font-size:13px;white-space:pre-line}
.src{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;padding:0;font-size:13px;color:var(--muted)}
details.howto summary{padding:10px 16px;font-size:14px;color:var(--fg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto p{margin:6px 0}
details.howto b{color:var(--fg)}
.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:640px;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}
td.nw{white-space:nowrap}
td.s{color:var(--muted)}
.new{display:inline-block;background:var(--up);color:#fff;border-radius:99px;padding:0 6px;font-size:10px;font-weight:700}
.chip.warnc{color:var(--warn)}
article.conf[data-st="pending"]{opacity:.75}
.run{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;margin:12px 0;font-size:13.5px}
.run.live{border-color:var(--warn)}
.run .rt{font-weight:700;font-size:14px;margin-bottom:4px}
.run .rtime{color:var(--muted);font-weight:400;font-size:12.5px}
.run p{margin:3px 0}
@media (max-width:640px){body{padding:12px}article.conf{padding:12px}}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("investor-conf.html")}
<h1>🎤 法說會判讀</h1>
<p class="sub">${range}（最近 7 天）公開資訊觀測站公告的法說會，AI 讀過簡報與影音後，依「有沒有可能影響股價的新資訊」給 1～5 分。更新：${esc(fmtTw(r.generatedAt))}</p>
<div class="cards">
<div class="card"><span class="cname">法說會</span><span class="cdesc">最近 7 天上市、上櫃、興櫃合計</span><b>${counts.all}</b></div>
<div class="card total"><span class="cname">值得關注</span><span class="cdesc">4 分以上（重點關注／值得留意）</span><b>${counts.hot}</b></div>
<div class="card"><span class="cname">這次新增</span><span class="cdesc">上次更新之後才出現在公告的</span><b>${counts.fresh}</b></div>
<div class="card"><span class="cname">待補</span><span class="cdesc">還沒判讀，或在等簡報上傳／影音轉文字</span><b>${counts.partial + counts.pending}</b></div>
</div>
<details class="howto"><summary>資料怎麼來、分數怎麼看、限制</summary><div class="body">
<p><b>來源</b>：公開資訊觀測站「法人說明會一覽表」。簡報抽出文字；證交所有錄影的，把語音轉成逐字稿，問答內容也會讀到。再加上月營收動能和當日漲跌幅，由 AI（${esc(r.model)}）判讀。</p>
<p><b>分數</b>：5＝重點關注、4＝值得留意、3＝一般、1～2＝可略過。看的是「有沒有市場可能還沒反映的新資訊」，利空也算值得留意，理由裡會寫是利多還是利空。</p>
<p><b>限制</b>：簡報裡做成圖片的數字抽不到（標「多為圖片」的要自己看原檔）；逐字稿是語音辨識，專有名詞可能有錯字；證交所錄影與 YouTube 會轉，放在公司官網頁面的不會。晚上的場次常隔天才上傳簡報，影音轉文字也有每日額度，所以判讀在背景慢慢做、每天補一些，補到新資料就重新判讀。原始簡報請到公開資訊觀測站的法說會一覽表下載。這不是投資建議。</p>
</div></details>
${banner}
<div class="filters">
<label><span class="fl">分數</span><select id="fS"><option value="0">全部</option><option value="3">≥ 3</option><option value="4">≥ 4</option></select></label>
<label><span class="fl">日期</span><select id="fD"><option value="">全部</option>${dates.map((d) => `<option value="${d}">${mmdd(d)}</option>`).join("")}</select></label>
<label><span class="fl">市場</span><select id="fM"><option value="">全部</option><option value="sii">上市</option><option value="otc">上櫃</option><option value="rotc">興櫃</option></select></label>
<label><input type="checkbox" id="fN"><span class="fl">只看這次新增</span></label>
</div>
<div class="count" id="count"></div>
<div id="list">${items.map((x) => card(x, newSet.has(x.key))).join("\n") || '<p class="note">這段期間沒有法說會。</p>'}</div>
<h2>接下來 7 天</h2>
${r.upcoming.length
    ? `<div class="tablebox"><table><thead><tr><th>日期</th><th>時間</th><th>公司</th><th>市場</th><th>擇要訊息</th></tr></thead><tbody>${r.upcoming
        .map((u) => `<tr><td class="nw">${mmdd(u.date)}</td><td class="nw">${esc(u.time)}</td><td class="nw">${stockLink(u.code, `${u.code} ${u.name}`)}</td><td class="nw">${MARKET[u.market]}</td><td class="s">${esc(u.summary.length > 90 ? `${u.summary.slice(0, 90)}…` : u.summary)}</td></tr>`)
        .join("")}</tbody></table></div>`
    : '<p class="note">目前還沒有公告。</p>'}
</div>
<script>
const $=id=>document.getElementById(id);
function apply(){const s=+$('fS').value,m=$('fM').value,d=$('fD').value,nw=$('fN').checked;let n=0;const all=document.querySelectorAll('article.conf');
all.forEach(a=>{const ok=+a.dataset.s>=s&&(!m||a.dataset.m===m)&&(!d||a.dataset.d===d)&&(!nw||a.dataset.n==='1');a.hidden=!ok;if(ok)n++;});
$('count').textContent='顯示 '+n+' / '+all.length+' 場';}
['fS','fM','fD','fN'].forEach(id=>$(id).addEventListener('change',apply));
apply();
</script>
</body>
</html>
`;
}
