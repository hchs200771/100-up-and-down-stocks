/**
 * /factor-lab.html — 因子驗證子頁。內容放在 research/factor-lab/（追蹤檔），不是每日更新；
 * 發佈時由 scripts/build-factor-lab.ts 重產。這裡只負責排版（純函式）。
 * 樣式沿用 target-price-page.ts 的子頁（同一組 CSS 變數與 .nav）。
 */
import { renderSubpageNav } from "./nav";

export type Verdict = "不成立" | "有條件" | "成立";
export interface FactorStat { label: string; value: string; tone?: "neg" | "pos" | ""; note?: string }
export interface FactorChart { file: string; caption: string }
export interface FactorExperiment {
  id: string;
  date: string;
  title: string;
  question: string;
  verdict: Verdict;
  verdictNote: string;
  summary: string;
  method: string;
  category?: string;
  stats?: FactorStat[];
  findings?: string[];
  caveats?: string[];
  nextIdeas?: string[];
  source: { script?: string; results?: string; doc?: string };
  charts?: FactorChart[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** 先跳脫再把 **粗體** 轉成 <b>。 */
const md = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
const plain = (s: string) => s.replace(/\*\*/g, "");
const VERDICT_CLASS: Record<Verdict, string> = { 不成立: "v-no", 有條件: "v-maybe", 成立: "v-yes" };
const pill = (v: Verdict) => `<span class="pill ${VERDICT_CLASS[v] ?? "v-maybe"}">${esc(v)}</span>`;
const list = (items: string[]) => (items.length ? `<ul class="fl">${items.map((x) => `<li>${md(x)}</li>`).join("")}</ul>` : "");

/** 名詞先讀；粗體開頭的發現改成小標與段落，其餘發現保留原始順序。 */
function renderFindings(items: string[]): string {
  const isGlossary = (text: string) => /^名詞說明[：:]/.test(text.trim());
  const glossary = items.filter(isGlossary).map((text) =>
    `<aside class="glossary"><h4>名詞說明</h4><p>${md(text.trim().replace(/^名詞說明[：:]\s*/, ""))}</p></aside>`
  ).join("");
  const findings = items.filter((text) => !isGlossary(text)).map((text) => {
    const lead = text.trim().match(/^\*\*([^*]+)\*\*\s*([\s\S]*)$/);
    return lead
      ? `<div class="finding"><h4>${esc(lead[1])}</h4>${lead[2] ? `<p>${md(lead[2])}</p>` : ""}</div>`
      : `<p>${md(text)}</p>`;
  }).join("");
  return `<div class="findings prose">${glossary}${findings}</div>`;
}

function svgInline(svg: string, label: string): string {
  const body = svg.replace(/<\?xml[\s\S]*?\?>\s*/g, "").trim();
  return body.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
    const a = attrs.replace(/\s(role|aria-label)="[^"]*"/g, "");
    return `<svg${a} role="img" aria-label="${esc(label)}">`;
  });
}

const DOC_BASE = "https://github.com/hchs200771/100-up-and-down-stocks/blob/main/";
const tag = (c?: string) => (c ? `<span class="tag">${esc(c)}</span>` : "");

export function renderFactorLabPage(input: FactorExperiment[], svgs: Map<string, string> | Record<string, string>): string {
  const experiments = [...input].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const getSvg = (key: string) => (svgs instanceof Map ? svgs.get(key) : svgs[key]) ?? "";
  const latest = experiments.map((e) => e.date).sort().at(-1) ?? "—";

  const index = experiments
    .map((e) => `<li><span class="d">${esc(e.date)}</span>${pill(e.verdict)}${tag(e.category)}<a href="#${esc(e.id)}">${esc(e.title)}</a></li>`)
    .join("");

  const section = (e: FactorExperiment) => {
    const findings = e.findings ?? [], caveats = e.caveats ?? [], nextIdeas = e.nextIdeas ?? [];
    const stats = (e.stats ?? [])
      .map((s) => {
        const cls = s.tone === "neg" ? " neg" : s.tone === "pos" ? " pos" : "";
        return `<div class="card"><span class="cname">${esc(s.label)}</span><b class="${cls.trim()}">${esc(s.value)}</b>${s.note ? `<span class="cdesc">${md(s.note)}</span>` : ""}</div>`;
      })
      .join("");
    const charts = (e.charts ?? [])
      .map((c) => `<figure class="chart"><figcaption>${md(c.caption)}</figcaption>${svgInline(getSvg(`${e.id}/${c.file}`), plain(c.caption))}</figure>`)
      .join("");
    const body = `
${stats ? `<h3>重點數字</h3><div class="cards">${stats}</div>` : ""}
${findings.length ? `<h3>發現</h3>${renderFindings(findings)}` : ""}
${charts ? `<h3>圖表</h3>${charts}` : ""}
${caveats.length ? `<h3>限制與注意</h3><div class="caveats prose">${list(caveats)}</div>` : ""}
${nextIdeas.length ? `<h3>下一步</h3><div class="prose">${list(nextIdeas)}</div>` : ""}
<details class="howto"><summary>方法與資料</summary><div class="body">
<p>${md(e.method)}</p>
${e.source.script ? `<p><b>腳本</b>：<code>${esc(e.source.script)}</code></p>` : ""}
${e.source.results ? `<p><b>結果檔</b>：<code>${esc(e.source.results)}</code></p>` : ""}
${e.source.doc ? `<p><b>文件</b>：<a href="${esc(DOC_BASE + e.source.doc.replace(/^\/+/, ""))}" target="_blank" rel="noopener"><code>${esc(e.source.doc)}</code></a></p>` : ""}
</div></details>`;
    const hasBody = Boolean(stats || findings.length || charts || caveats.length || nextIdeas.length);
    const bodyId = `${e.id}-body`;
    const toggle = hasBody ? `<button type="button" class="experiment-toggle" aria-expanded="false" aria-controls="${esc(bodyId)}"><span>展開</span><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3 6 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : "";
    const head = `<div class="experiment-head"><div class="head-row"><div class="article-title"><h2>${esc(e.title)}</h2><p class="meta"><span class="d">${esc(e.date)}</span>${e.category ? ` · ${tag(e.category)}` : ""}</p></div>${toggle}</div>
<div class="question prose"><p class="eyebrow">這篇在問</p><p class="q">${md(e.question)}</p></div>
<div class="verdict-callout prose ${VERDICT_CLASS[e.verdict] ?? "v-maybe"}"><p class="verdict-word">${esc(e.verdict)}</p><p class="vnote">${md(e.verdictNote)}</p><p class="sum">${md(e.summary)}</p></div></div>`;
    return `<section id="${esc(e.id)}"${hasBody ? ' class="collapsible"' : ""}>${head}<div class="experiment-body" id="${esc(bodyId)}">${body}</div></section>`;
  };

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<script>document.documentElement.classList.add("js");</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>因子驗證</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">🧪</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7;--v-no:#b91c1c;--v-maybe:#b45309;--v-yes:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42;--v-no:#f87171;--v-maybe:#fbbf24;--v-yes:#4ade80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px;overflow-wrap:break-word}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:22px;margin:4px 0 2px}
h2{font-size:18px;line-height:1.4;font-weight:800;margin:0 0 6px}
h3{font-size:16px;line-height:1.5;font-weight:750;margin:20px 0 10px;padding-top:12px;border-top:1px solid var(--line)}
h4{font-size:15px;line-height:1.65;font-weight:750;margin:0 0 6px;color:var(--fg)}
p{margin:0 0 .9em}
b{font-weight:750;color:var(--fg)}
.prose{max-width:760px}
.prose>:last-child{margin-bottom:0}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0}
.card{min-width:0;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.card .cname{font-size:14px;font-weight:700}
.card .cdesc{color:var(--muted);font-size:12px;line-height:1.5;margin-top:4px;flex:1}
.card>b{font-size:20px;line-height:1.3;margin-top:6px}
.pos{color:var(--up)}.neg{color:var(--down)}
a{color:var(--accent);text-decoration:none}
code{background:var(--chip);border-radius:4px;padding:0 5px;font-size:12px;word-break:break-all}
.nav a{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:700;background:var(--card);color:var(--fg)}
.nav a:hover{border-color:var(--accent);color:var(--accent)}
.nav a.here{background:var(--accent);border-color:var(--accent);color:#fff}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:28px 0 0;max-width:760px;font-size:14px;color:var(--muted)}
details.howto summary{cursor:pointer;padding:10px 16px;font-size:15px;font-weight:700;color:var(--fg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto p{margin:.9em 0}
details.howto b{color:var(--fg)}
.experiment-head{display:contents}
.head-row{display:flex;align-items:flex-start;gap:10px;background:var(--card);padding:6px 0}
.article-title{flex:1;min-width:0}
.head-row h2{margin:0}
.meta{color:var(--muted);font-size:13px;margin:6px 0 0}
.meta .d{font-size:inherit}
.experiment-toggle{display:none;flex:none;align-items:center;gap:5px;min-height:40px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--accent);font:inherit;cursor:pointer}
.experiment-toggle svg{transition:transform .15s}
.experiment-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.js .collapsible .experiment-head{cursor:pointer}
.js .experiment-toggle{display:inline-flex}
.js .collapsible:not(.is-open)>.experiment-body{display:none}
section.collapsible{scroll-margin-top:calc(var(--gnav-h,0px) + 8px)}
.js .collapsible.is-open .head-row{position:sticky;top:var(--gnav-h,0px);z-index:2;border-bottom:1px solid var(--line)}
.js .is-open .experiment-toggle svg{transform:rotate(180deg)}
@media(prefers-reduced-motion:reduce){.experiment-toggle svg{transition:none}}
.pill{display:inline-block;border:1px solid currentColor;border-radius:99px;padding:0 8px;font-size:12px;font-weight:700;vertical-align:middle;white-space:nowrap}
.tag{display:inline-block;background:var(--chip);color:var(--muted);border-radius:99px;padding:0 8px;font-size:11px;font-weight:600;vertical-align:middle;margin-right:6px;white-space:nowrap}
.v-no{color:var(--v-no)}.v-maybe{color:var(--v-maybe)}.v-yes{color:var(--v-yes)}
.d{color:var(--muted);font-size:12px;font-weight:400;font-variant-numeric:tabular-nums}
.index-heading{font-size:15px;font-weight:700;margin:24px 0 8px}
ul.idx{list-style:none;font-size:13px;line-height:1.6;margin:8px 0 24px;padding:0;background:var(--card);border:1px solid var(--line);border-radius:10px}
ul.idx li{padding:6px 12px;border-bottom:1px solid var(--line)}
ul.idx li:last-child{border-bottom:0}
ul.idx .d{margin-right:8px}
ul.idx .pill{margin-right:8px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:16px 0;min-width:0}
.question{margin:12px 0}
.eyebrow{color:var(--muted);font-size:12px;letter-spacing:.08em;font-weight:700;margin:0 0 6px}
.q{font-size:15.5px;font-weight:600;margin:0}
.verdict-callout{border-left:4px solid currentColor;border-radius:4px 10px 10px 4px;padding:18px 20px;background:var(--chip);background:color-mix(in srgb,currentColor 9%,var(--card))}
.verdict-word{font-size:16px;font-weight:800;line-height:1.5;margin:0 0 4px}
.verdict-callout .vnote{color:var(--fg);font-size:15px;font-weight:650;margin:0 0 .6em}
.verdict-callout .sum{color:var(--fg);font-weight:400;margin:0}
.finding{margin:22px 0}
.finding p{margin:0 0 .9em}
.glossary{background:var(--chip);color:var(--muted);border-radius:8px;padding:16px 20px;margin-bottom:24px}
.caveats{color:var(--muted);font-size:13.5px}
.caveats b{color:inherit}
ul.fl{margin:4px 0;padding-left:24px}
ul.fl li{margin:0 0 .6em}
figure.chart{margin:20px 0;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
figure.chart figcaption{font-size:13.5px;font-weight:600;margin-bottom:8px}
figure.chart svg{display:block;width:100%;max-width:100%;height:auto;color:var(--fg)}
@media(max-width:480px){
section{padding:16px}
h2{font-size:17px}
.head-row{gap:8px}
.experiment-toggle{padding:6px;font-size:13px}
.cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.card{padding:12px}
.card>b{font-size:18px}
.verdict-callout{padding:14px}
figure.chart{padding:8px}
}
@media(max-width:350px){.cards{grid-template-columns:minmax(0,1fr)}}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("factor-lab.html")}
<h1>🧪 因子驗證</h1>
<p class="sub">有新點子就回測一次，結果記在這裡。不是每日更新。共 ${experiments.length} 個實驗，最新 ${esc(latest)}。</p>
<h2 class="index-heading">全部實驗</h2>
<ul class="idx">${index}</ul>
${experiments.map(section).join("\n")}
</div>
<script>
(() => {
  // 網站導覽列也黏在頂端：展開後的標題列要黏在它正下方，不能被蓋住。
  const gnav = document.querySelector('nav.gnav');
  const syncNav = () => document.documentElement.style.setProperty('--gnav-h', (gnav && getComputedStyle(gnav).position === 'sticky' ? gnav.offsetHeight : 0) + 'px');
  syncNav();
  window.addEventListener('resize', syncNav);
  function setOpen(section, open, scrollOnClose = false) {
    section.classList.toggle('is-open', open);
    const button = section.querySelector('.experiment-toggle');
    button.setAttribute('aria-expanded', String(open));
    button.querySelector('span').textContent = open ? '收合' : '展開';
    if (!open && scrollOnClose && section.getBoundingClientRect().top < 0) {
      section.scrollIntoView({block: 'start'});
    }
  }
  document.querySelectorAll('section.collapsible').forEach(section => {
    section.querySelector('.experiment-head').addEventListener('click', event => {
      if (event.target.closest('a, input, textarea, select, label, summary')) return;
      if (event.target.closest('button') && !event.target.closest('.experiment-toggle')) return;
      if (window.getSelection()?.toString()) return;
      setOpen(section, !section.classList.contains('is-open'), true);
    });
  });
  function openHash() {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const section = document.getElementById(id);
    if (!section?.matches('section.collapsible')) return;
    setOpen(section, true);
    section.scrollIntoView({block: 'start'});
  }
  document.querySelector('.idx').addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const section = document.getElementById(link.hash.slice(1));
    if (section?.matches('section.collapsible')) setOpen(section, true);
    // Also scroll when clicking the current hash after the card was collapsed.
    if (link.hash === location.hash) openHash();
  });
  window.addEventListener('hashchange', openHash);
  openHash();
})();
</script>
</body>
</html>
`;
}
