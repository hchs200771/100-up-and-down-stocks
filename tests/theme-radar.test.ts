import assert from "node:assert/strict";
import test from "node:test";
import { completedWeekEnd, matchTheme, scoreThemes, themesByTicker, type ThemeArticle, type ThemeDefinition } from "../scripts/lib/theme-radar.ts";
import { parseThemeFeed } from "../scripts/lib/theme-feed.ts";
import { renderThemePage } from "../scripts/lib/theme-page.ts";
import { renderSubpageNav } from "../scripts/lib/nav.ts";

const theme: ThemeDefinition = {
  id: "cpo", name: "共同封裝光學", aliases: ["CPO", "共同封裝光學"],
  exclude: ["chief product officer"], tickers: ["3363"],
};

test("theme matching uses English word boundaries and excludes unrelated meanings", () => {
  assert.equal(matchTheme("CPO 產業加速", theme), true);
  assert.equal(matchTheme("CPOS 平台", theme), false);
  assert.equal(matchTheme("chief product officer (CPO)", theme), false);
});

test("RSS and Atom parsing keeps publication dates and deduplicates tracking links", () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title>CPO 擴產</title><link>https://example.com/a?utm_source=mail</link><pubDate>Mon, 21 Sep 2026 10:00:00 +0800</pubDate><description>新設備</description></item></channel></rss>`;
  const atom = `<?xml version="1.0"?><feed><entry><title>CPO 擴產</title><link href="https://example.com/a"/><published>2026-09-21T02:00:00Z</published><summary>新設備</summary></entry></feed>`;
  const first = parseThemeFeed(rss, "rss")[0];
  const second = parseThemeFeed(atom, "atom")[0];
  assert.equal(first.id, second.id);
  assert.equal(first.publishedAt, "2026-09-21T02:00:00.000Z");
  assert.equal(parseThemeFeed("<rss><channel><item><title>沒有日期</title></item></channel></rss>", "rss").length, 0);
});

test("theme page shares the subpage nav and separates data coverage from acceleration", () => {
  const snapshot = { date: "2026-09-21", generatedAt: "2026-09-21T18:00:00+08:00", articles: 0, warnings: [],
    signals: scoreThemes([], [theme], "2026-09-21") };
  const html = renderThemePage(snapshot, [], [theme]);
  assert.ok(html.includes(renderSubpageNav("themes.html")));
  assert.ok(html.includes('<details class="howto">'));
  assert.ok(!html.includes('<details class="howto" open'));
  assert.ok(html.includes("0／12 ＋ 0／4"));
  assert.ok(html.includes("資料累積中"));
  assert.ok(!html.includes("資料累積中／未達門檻"));
});

test("theme score uses mention share, completed weeks, and requires full coverage", () => {
  const asOf = "2026-09-21";
  const end = completedWeekEnd(asOf);
  const week = 7 * 86_400_000;
  const articles: ThemeArticle[] = [];
  for (let i = 0; i < 16; i++) {
    const total = i < 12 ? 100 : 300;
    const hits = i < 12 ? 1 : 18;
    for (let j = 0; j < total; j++) {
      articles.push({
        id: `${i}-${j}`, source: "fixture",
        publishedAt: new Date(end - (16 - i) * week + 86_400_000).toISOString(),
        title: j < hits ? "CPO" : "一般新聞", body: "", url: "",
      });
    }
  }
  // 當週尚未結束，不可進分母或分子。
  articles.push({ id: "current", source: "fixture", publishedAt: new Date(end + 86_400_000).toISOString(), title: "CPO", body: "", url: "" });
  const score = scoreThemes(articles, [theme], asOf)[0];
  assert.equal(score.recentMentions, 72);
  assert.equal(score.accelerating, true);
  assert.equal(themesByTicker([score]).get("3363")?.[0].id, "cpo");

  const volumeOnly = articles.map((article) => ({ ...article }));
  for (const article of volumeOnly) {
    const [index, number] = article.id.split("-").map(Number);
    if (index >= 12 && index < 16 && number >= 3) article.title = "一般新聞";
  }
  assert.equal(scoreThemes(volumeOnly, [theme], asOf)[0].accelerating, false);
  assert.equal(scoreThemes(articles.filter((article) => Date.parse(article.publishedAt) >= end - 8 * week), [theme], asOf)[0].accelerating, false);
});
