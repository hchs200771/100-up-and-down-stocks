import assert from "node:assert/strict";
import test from "node:test";
import { extractFugleArticle, fetchFugleArticle } from "../scripts/lib/investor-conf-fugle.ts";
import { renderInvestorConfPage } from "../scripts/lib/investor-conf-page.ts";
import type { ConfResult, InvestorConfLatest } from "../scripts/fetch-investor-conferences.ts";

const paragraph = "公司營收持續成長，毛利率改善；下季展望仍須觀察訂單與庫存變化。".repeat(20);
// 模擬富果串流 HTML：main 中是骨架，真正主文在後方、分成兩個 article。
const fixture = `<nav>導覽雜訊</nav><main><article><div></div></article></main>
<article><header>發布日與分享</header><div class="contain-inline-size">
<article><h2>營運摘要</h2><p>${paragraph}</p></article>
<div class="fugle-card-container">註冊會員廣告</div>
<article><h2>財務表現</h2><table><tr><th>EPS</th><td>1.29 &amp; 成長</td></tr></table>
<h2>展望</h2><p>訂單能見度提升</p><h2>Q&amp;A</h2><p>問：庫存？答：持續觀察。</p>
<h2>免責聲明</h2><p>聲明雜訊</p></article></div></article>
<aside><article><h2>相關文章</h2><p>相關雜訊</p></article></aside>`;

test("擷取全部主文區塊、表格與問答，排除導覽、廣告、相關文章、免責聲明", () => {
  const text = extractFugleArticle(fixture)!;
  assert.ok(text.startsWith("營運摘要\n"));
  for (const term of [paragraph, "財務表現", "EPS", "1.29 & 成長", "展望", "Q&A", "問：庫存？答：持續觀察。"])
    assert.ok(text.includes(term), term);
  for (const term of ["導覽雜訊", "發布日與分享", "註冊會員廣告", "免責聲明", "聲明雜訊", "相關雜訊"])
    assert.ok(!text.includes(term), term);
});

test("短主文、缺主文與只有導覽時回傳 null，不以整頁長度充數", () => {
  assert.equal(extractFugleArticle(`<nav>${paragraph}</nav><div class="entry-content"><p>尚未發布</p></div>`), null);
  assert.equal(extractFugleArticle(`<nav>${paragraph}</nav>`), null);
  assert.equal(extractFugleArticle('<div class="entry-content"><p> </p></div>'), null);
});

test("直接以代號及法說日期取文，帶 User-Agent 與 20 秒逾時 signal", async () => {
  const result = await fetchFugleArticle("2397", "2026-11-11", async (url, options) => {
    assert.equal(url, "https://blog.fugle.tw/post/earnings-call-2397-2026-11-11");
    assert.ok(new Headers(options?.headers).get("User-Agent"));
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options?.redirect, "error");
    return new Response(fixture);
  });
  assert.equal(result?.text, extractFugleArticle(fixture));
  assert.equal(result?.url, "https://blog.fugle.tw/post/earnings-call-2397-2026-11-11");
});

test("404、HTTP 失敗、短文及網路逾時均回傳 null，允許影音備援", async () => {
  for (const response of [new Response(fixture, { status: 404 }), new Response(fixture, { status: 503 }), new Response('<article><h2>摘要</h2><p>太短</p></article>')])
    assert.equal(await fetchFugleArticle("2397", "2026-11-11", async () => response), null);
  assert.equal(await fetchFugleArticle("2397", "2026-11-11", async () => { throw new DOMException("Timeout", "TimeoutError"); }), null);
});

const item = (): ConfResult => ({
  key: "2397-2026-11-11", code: "2397", name: "友通", market: "sii", date: "2026-11-11", time: "14:00",
  place: "線上", summary: "公司公告擇要", fileZh: null, fileEn: null, videoUrl: null, note: "",
  deck: null, transcript: { minutes: 0, chars: 800, source: "fugle", url: "https://blog.fugle.tw/post/earnings-call-2397-2026-11-11" },
  videoStatus: "ok", context: { revenue: null, move: null }, analysis: null,
});
const render = (x: ConfResult) => renderInvestorConfPage({
  generatedAt: "2026-11-12T00:00:00Z", date: x.date, from: x.date, model: "fixture",
  run: { startedAt: "2026-11-12T00:00:00Z", finishedAt: null, newKeys: [] },
  items: [x], upcoming: [],
} satisfies InvestorConfLatest);

test("頁面已判讀及待判讀場次都顯示富果原文連結，舊快取仍標為影音", () => {
  const x = item();
  for (const analyzed of [false, true]) {
    if (analyzed) x.analysis = { headline: "自行判讀", score: 3, verdict: "一般", reason: "中性",
      keyNumbers: [], guidance: "仍待觀察", drivers: [], risks: [], qaHighlights: [], tone: "持平", evidence: "富果整理" };
    const html = render(x);
    assert.ok(html.includes(`href="${x.transcript!.url}" target="_blank" rel="noopener noreferrer">富果整理</a>`));
    assert.ok(!html.includes("影音 0 分鐘"));
    assert.ok(!html.includes(paragraph));
  }
  x.transcript = { minutes: 45, chars: 2000 };
  assert.ok(render(x).includes("影音 45 分鐘"));
  x.transcript = { minutes: 0, chars: 800, source: "fugle", url: "javascript:alert(1)" };
  assert.ok(!render(x).includes('href="javascript:'));
});
