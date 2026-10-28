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

  const section = (e: FactorExperiment, i: number) => {
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
${stats ? `<div class="cards">${stats}</div>` : ""}
${findings.length ? `<h3>發現</h3>${list(findings)}` : ""}
${charts}
${caveats.length ? `<h3>限制與注意</h3>${list(caveats)}` : ""}
${nextIdeas.length ? `<h3>下一步可以試</h3>${list(nextIdeas)}` : ""}
<details class="howto"><summary>方法與資料</summary><div class="body">
<p>${md(e.method)}</p>
${e.source.script ? `<p><b>腳本</b>：<code>${esc(e.source.script)}</code></p>` : ""}
${e.source.results ? `<p><b>結果檔</b>：<code>${esc(e.source.results)}</code></p>` : ""}
${e.source.doc ? `<p><b>文件</b>：<a href="${esc(DOC_BASE + e.source.doc.replace(/^\/+/, ""))}" target="_blank" rel="noopener"><code>${esc(e.source.doc)}</code></a></p>` : ""}
</div></details>`;
    const head = `<h2>${esc(e.title)} ${pill(e.verdict)}${tag(e.category)} <span class="d">${esc(e.date)}</span></h2>
<p class="vnote">${md(e.verdictNote)}</p>
<p class="q"><b>問題</b>：${md(e.question)}</p>
<p class="sum">${md(e.summary)}</p>`;
    const hasBody = stats || findings.length || charts || caveats.length || nextIdeas.length;
    const rest = i === 0 || !hasBody ? body : `<details class="more"><summary>展開細節（數字、圖表、限制）</summary>${body}</details>`;
    return `<section id="${esc(e.id)}">${head}${rest}</section>`;
  };

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>因子驗證</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">🧪</text></svg>')}">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--down:#15803d;--chip:#eef2f7;--v-no:#b91c1c;--v-maybe:#b45309;--v-yes:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--down:#4ade80;--chip:#222c42;--v-no:#f87171;--v-maybe:#fbbf24;--v-yes:#4ade80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px;overflow-wrap:break-word}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:17px;margin:0 0 6px}
h3{font-size:14px;margin:16px 0 4px}
.sub,.note{color:var(--muted);font-size:13px;margin:2px 0}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.card{flex:1 1 150px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.card .cname{font-size:14px;font-weight:700}
.card .cdesc{color:var(--muted);font-size:11.5px;line-height:1.5;margin-top:2px;flex:1}
.card b{font-size:17px;line-height:1.2;margin-top:6px}
.pos{color:var(--up)}.neg{color:var(--down)}
a{color:var(--accent);text-decoration:none}
code{background:var(--chip);border-radius:4px;padding:0 5px;font-size:12px;word-break:break-all}
.nav a{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:700;background:var(--card);color:var(--fg)}
.nav a:hover{border-color:var(--accent);color:var(--accent)}
.nav a.here{background:var(--accent);border-color:var(--accent);color:#fff}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;font-size:13px;color:var(--muted)}
details.howto summary{cursor:pointer;padding:10px 16px;font-size:14px;font-weight:600;color:var(--fg)}
details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}
details.howto p{margin:6px 0}
details.howto b{color:var(--fg)}
details.more>summary{cursor:pointer;color:var(--accent);font-weight:600;margin:8px 0}
.pill{display:inline-block;border:1px solid currentColor;border-radius:99px;padding:0 8px;font-size:12px;font-weight:700;vertical-align:middle;white-space:nowrap}
.tag{display:inline-block;background:var(--chip);color:var(--muted);border-radius:99px;padding:0 8px;font-size:11px;font-weight:600;vertical-align:middle;margin-right:6px;white-space:nowrap}
.v-no{color:var(--v-no)}.v-maybe{color:var(--v-maybe)}.v-yes{color:var(--v-yes)}
.d{color:var(--muted);font-size:12px;font-weight:400;font-variant-numeric:tabular-nums}
ul.idx{list-style:none;margin:12px 0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:10px}
ul.idx li{padding:8px 14px;border-bottom:1px solid var(--line)}
ul.idx li:last-child{border-bottom:0}
ul.idx .d{margin-right:8px}
ul.idx .pill{margin-right:8px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:16px 0}
.vnote{margin:4px 0;font-weight:600}
.q,.sum{margin:6px 0}
ul.fl{margin:4px 0;padding-left:20px}
ul.fl li{margin:3px 0}
figure.chart{margin:12px 0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
figure.chart figcaption{font-size:13px;font-weight:600;margin-bottom:6px}
figure.chart svg{display:block;width:100%;height:auto;color:var(--fg)}
</style>
</head>
<body><div class="wrap">
${renderSubpageNav("factor-lab.html")}
<h1>🧪 因子驗證</h1>
<p class="sub">有新點子就回測一次，結果記在這裡。不是每日更新。共 ${experiments.length} 個實驗，最新 ${esc(latest)}。</p>
<ul class="idx">${index}</ul>
${experiments.map(section).join("\n")}
</div></body>
</html>
`;
}
