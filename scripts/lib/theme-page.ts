import { completedWeekEnd, matchTheme, type ThemeArticle, type ThemeDefinition, type ThemeSignal } from "./theme-radar";
import { renderSubpageNav } from "./nav";

interface Snapshot {
  date: string;
  generatedAt: string;
  articles: number;
  warnings: string[];
  signals: ThemeSignal[];
}

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char] ?? char);
const WEEK = 7 * 86_400_000;

export function renderThemePage(snapshot: Snapshot, articles: ThemeArticle[], themes: ThemeDefinition[]): string {
  const weekStart = completedWeekEnd(snapshot.date);
  const coverage = Array.from({ length: 16 }, (_, index) => articles.some((article) => {
    const time = Date.parse(article.publishedAt);
    const start = weekStart - (16 - index) * WEEK;
    return time >= start && time < start + WEEK;
  }));
  const baselineWeeks = coverage.slice(0, 12).filter(Boolean).length;
  const recentWeeks = coverage.slice(12).filter(Boolean).length;
  const ready = baselineWeeks >= 10 && recentWeeks === 4;
  const current = articles.filter((article) => Date.parse(article.publishedAt) >= weekStart)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const matches = themes.map((theme) => ({
    theme,
    articles: current.filter((article) => matchTheme(`${article.title} ${article.body}`, theme)),
    score: snapshot.signals.find((signal) => signal.id === theme.id),
  }));
  const scored = matches.filter((item) => item.score?.accelerating);
  const status = (score?: ThemeSignal) => snapshot.warnings.length
    ? "來源待修復" : !ready ? "資料累積中" : score?.accelerating ? "加速" : "未達加速門檻";
  const recent = current.flatMap((article) => {
    const names = themes.filter((theme) => matchTheme(`${article.title} ${article.body}`, theme))
      .map((theme) => theme.name);
    return names.length ? [{ article, names }] : [];
  }).slice(0, 20);
  const rows = matches.map(({ theme, articles: hits, score }) => `<tr>
    <td><strong>${esc(theme.name)}</strong></td>
    <td><span class="chip ${score?.accelerating ? "hot" : ""}">${status(score)}</span></td>
    <td>${score?.recentMentions ?? 0}</td>
    <td>${ready ? `${((score?.recentShare ?? 0) * 100).toFixed(1)}%` : "—"}</td>
    <td>${ready ? `${(score?.ratio ?? 0).toFixed(1)} 倍` : "—"}</td>
    <td>${hits.length}</td>
    <td>${esc(theme.tickers.join("、") || "—")}</td>
  </tr>`).join("");
  const articleRows = recent.map(({ article, names }) => {
    let link = esc(article.title);
    try {
      const url = new URL(article.url);
      if (url.protocol === "https:" || url.protocol === "http:") {
        link = `<a href="${esc(url.toString())}" target="_blank" rel="noopener noreferrer">${link}</a>`;
      }
    } catch { /* 無有效 URL 時只顯示標題 */ }
    return `<tr><td>${esc(article.publishedAt.slice(0, 10))}</td><td>${link}<small>${esc(article.source)}</small></td><td>${esc(names.join("、"))}</td></tr>`;
  }).join("");
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>題材雷達｜台股盤後報告</title><meta name="robots" content="noindex"><link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20100%20100%22%3E%3Ctext%20y%3D%22.9em%22%20font-size%3D%2288%22%3E%F0%9F%93%A1%3C%2Ftext%3E%3C%2Fsvg%3E">
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1a202c;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--up:#c2410c;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--fg:#e5eaf3;--muted:#8b98ad;--line:#28334a;--accent:#7aa2ff;--up:#ff8a5c;--chip:#222c42}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:16px}.wrap{max-width:1200px;margin:0 auto}h1{font-size:20px;margin:4px 0 2px}h2{font-size:17px;margin:22px 0 8px}.sub{color:var(--muted);font-size:13px;margin:2px 0}.note{color:var(--up);font-size:13px}a{color:var(--accent);text-decoration:none}.nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.nav a{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:700;background:var(--card);color:var(--fg)}.nav a:hover{border-color:var(--accent);color:var(--accent)}.nav a.here{background:var(--accent);border-color:var(--accent);color:#fff}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.card{flex:1 1 170px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}.card .cname{font-size:14px;font-weight:700}.card .cdesc{color:var(--muted);font-size:11.5px;line-height:1.5;margin-top:2px;flex:1}.card b{font-size:17px;line-height:1.2;margin-top:6px}.card.total{border-color:var(--accent)}.card.total b{color:var(--accent)}.tablebox{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:800px;font-size:13px}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}th{background:var(--card);color:var(--muted);font-weight:600}tr:hover td{background:color-mix(in srgb,var(--accent) 6%,transparent)}.chip{display:inline-block;background:var(--chip);border-radius:99px;padding:0 8px;font-size:11px;color:var(--muted)}.chip.hot{background:var(--accent);color:#fff}small{display:block;color:var(--muted);margin-top:2px}
details.howto{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:12px 0;font-size:13px;color:var(--muted)}details.howto summary{cursor:pointer;list-style:none;padding:10px 16px;font-size:14px;font-weight:600;color:var(--fg);user-select:none}details.howto summary::-webkit-details-marker{display:none}details.howto summary::before{content:"▸";display:inline-block;margin-right:8px;color:var(--accent);transition:transform .15s}details.howto[open] summary::before{transform:rotate(90deg)}details.howto .body{padding:0 16px 12px;border-top:1px solid var(--line)}details.howto h4{margin:12px 0 4px;font-size:13px;color:var(--fg)}details.howto p{margin:4px 0}details.howto ul,details.howto ol{margin:4px 0;padding-left:20px}details.howto li{margin:3px 0}details.howto b{color:var(--fg)}
</style></head><body><div class="wrap">
${renderSubpageNav("themes.html")}
<h1>📡 題材雷達</h1><p class="sub">市場基準日 ${esc(snapshot.date)}｜產生於 ${esc(snapshot.generatedAt.replace("T", " ").slice(0, 16))}（台北時間）｜已保存 ${snapshot.articles} 篇 RSS 文章</p>
<div class="cards">
<div class="card total"><span class="cname">資料週數</span><span class="cdesc">基準期至少 10／12 週有文章，近期 4／4 週都要有文章</span><b>${baselineWeeks}／12 ＋ ${recentWeeks}／4</b></div>
<div class="card"><span class="cname">本週新文章</span><span class="cdesc">這週尚未結束，不納入加速度計算</span><b>${current.length}</b></div>
<div class="card"><span class="cname">加速題材</span><span class="cdesc">資料足夠、來源正常且提及占比與 z 值都達門檻</span><b>${scored.length}</b></div>
</div>
${snapshot.warnings.length ? `<p class="note">來源警告：${esc(snapshot.warnings.join("；"))}。本次不發加速訊號。</p>` : ""}
<details class="howto"><summary>📖 本頁怎麼看、資料與門檻怎麼算（點開）</summary><div class="body">
<h4>這一頁在找什麼</h4><p>從公開 RSS 文章觀察科技題材的<b>提及占比是否突然上升</b>。題材與關聯個股寫在固定字典中；關鍵字命中只代表文章提到題材，<b>不等於利多、公司訂單或題材營收已確認</b>。</p>
<h4>資料怎麼抓</h4><p>每日報告抓完市場資料後，與分類、研究等工作並行抓取 TechNews、iThome、ServeTheHome、Tom's Hardware 的 RSS。按文章網址去重並保存標題、摘要、來源與發表時間。某來源抓取失敗或回傳空白時，當日會顯示警告並停止發出加速訊號，避免提及占比的分母失真。</p>
<h4>「資料累積中」到什麼程度才結束</h4><p>只使用<b>已結束的完整週</b>。計算視窗共 16 週：前 12 週是基準期，最近 4 週是比較期。前 12 週中至少 <b>10 週有文章</b>，最近 4 週必須<b>每週都有文章</b>，才開始判斷是否加速。本週正在抓的文章只列在表格的「本週提及」，到下週才會進入完整週計算。目前進度是<b>${baselineWeeks}／12 個基準週、${recentWeeks}／4 個近期週</b>；因此表格顯示「資料累積中」，不代表題材已被判定為弱勢。</p>
<h4>資料足夠後，怎樣才算「加速」</h4><ol><li>最近 4 個完整週至少 <b>3 篇</b>命中該題材。</li><li>最近 4 週的「命中文章／所有文章」占比，至少是前 12 週占比的 <b>2 倍</b>；計算倍率時兩邊各加 0.2 個百分點，避免基準為零時無限放大。</li><li>近期占比相對基準 12 週的週占比分布，<b>z 值至少 2</b>；標準差下限設為 0.2 個百分點。</li><li>當次 RSS 來源沒有失敗或空白。</li></ol><p>四項都成立才標成「加速」。資料已足夠但條件未全過，會顯示「未達加速門檻」。</p>
<h4>怎麼判斷它有沒有幫助</h4><p>現階段題材訊號<b>只作觀察，不參與選股分數或入選門檻</b>。每日選股快照會記下同日是否有題材加速；累積足夠交易日後，用同日有訊號與無訊號的選股，對照下一交易日進場後 5／20 日的<b>扣成本勝率、平均淨報酬與相對全市場超額報酬</b>。至少累積 20 個可觀測進場日再討論權重，並檢查樣本是否跨越不同市場狀態；目前沒有證據顯示它能提高勝率。</p>
</div></details>
<h2>題材概況</h2><div class="tablebox"><table><thead><tr><th>題材</th><th>狀態</th><th>近 4 個完整週提及</th><th>近期占比</th><th>占比倍率</th><th>本週提及（未計分）</th><th>關聯個股</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>本週命中的文章</h2><div class="tablebox"><table><thead><tr><th>日期</th><th>文章與來源</th><th>題材</th></tr></thead><tbody>${articleRows || '<tr><td colspan="3">本週尚無追蹤題材的關鍵字命中。</td></tr>'}</tbody></table></div>
<p class="sub" style="margin-top:10px">資料來源：上述公開 RSS；題材與關聯個股是研究字典。未完成週、來源缺漏與樣本不足都不會產生加速訊號。本頁不構成投資建議。</p>
</div></body></html>`;
}
