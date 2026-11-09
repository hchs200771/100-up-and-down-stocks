import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { splitScript, keepEpisodes, podcastRss, type Episode } from "../scripts/lib/audio.ts";

test("audio splitting preserves sentences, punctuation and content", () => {
  const script = "今天盤勢偏弱。資金轉向航空！接下來看風險？最後收尾。";
  const chunks = splitScript(script, 12);
  assert.equal(chunks.join(""), script);
  assert.ok(chunks.every((s) => s.length <= 12));
  assert.ok(chunks.slice(0, -1).every((s) => /[。！？]$/.test(s)));
  const long = "甲".repeat(1601) + "，" + "乙".repeat(1400) + "。\n";
  assert.equal(splitScript(long).join(""), long);
  assert.ok(splitScript(long).every((s) => s.length <= 1500));
  assert.deepEqual(splitScript(""), []);
});

test("podcast RSS is valid XML, escapes URLs, and retains seven unique episodes", () => {
  const episodes: Episode[] = Array.from({ length: 10 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, url: `https://example.org/audio-${i}.mp3?x=1&y=2`, durationSec: 720, voice: "test", generatedAt: "2026-11-10T08:00:00Z", length: 4321000, type: "audio/mpeg" }));
  const duplicate = { ...episodes[9], url: "https://example.org/replaced.mp3" };
  const kept = keepEpisodes([...episodes, duplicate]);
  assert.equal(kept.length, 7);
  assert.equal(kept[0].url, duplicate.url);
  const doc = new JSDOM(podcastRss([...episodes, duplicate]), { contentType: "text/xml" }).window.document;
  assert.equal(doc.querySelector("parsererror"), null);
  assert.equal(doc.documentElement.getAttribute("version"), "2.0");
  assert.equal(doc.querySelectorAll("item").length, 7);
  assert.equal(doc.querySelector("channel > language")?.textContent, "zh-tw");
  assert.equal(doc.querySelectorAll("item")[1].querySelector("enclosure")?.getAttribute("url"), episodes[8].url);
  assert.equal(doc.querySelector("item > guid")?.textContent, "2026-11-10");
  assert.ok(Number.isFinite(Date.parse(doc.querySelector("pubDate")!.textContent!)));
});

function home() {
  const source = readFileSync(new URL("../scripts/send-report.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("send-report.ts", source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === "renderHome")!;
  // renderHome 會讀模組層級的 CHART_LINKS（及其依賴的 YAHOO_QUOTE），一起抽出來才能單獨執行。
  const links = ast.statements.filter((n) => ts.isVariableStatement(n) && /^const (YAHOO_QUOTE|CHART_LINKS)\b/.test(n.getText(ast)));
  const js = ts.transpileModule([...links, node].map((n) => n.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const render = runInNewContext(`${js}\nrenderHome`, { escHtml: (s: string) => s, readDataJson: () => null, renderMarketRegime: () => "", renderHoldingLevel: () => "" });
  return render({ a: { date: "2026-11-03", summary: "摘要" }, tabs: [] });
}

test("rendered home includes top audio player, subscription and Media Session support", async () => {
  const html = home();
  const dom = new JSDOM(html);
  const audio = dom.window.document.querySelector("audio")!;
  assert.equal(audio.preload, "none");
  assert.equal(audio.controls, true);
  assert.equal(dom.window.document.querySelector("#daily-audio-feed")?.getAttribute("href"), "podcast.xml");
  assert.ok(html.indexOf('id="daily-audio"') < html.indexOf("今天的結論"));
  assert.ok(html.includes("mediaSession"));
});

test("home audio shows only matching date and reports missing current audio as not started", async () => {
  for (const state of ["current", "old", "future", "failed"]) {
    const dom = new JSDOM(home(), { url: "https://example.org/", runScripts: "outside-only" });
    Object.assign(dom.window, { fetch: async () => {
      if (state === "failed") throw new Error("offline");
      return { ok: true, json: async () => ({ date: state === "old" ? "2026-11-02" : state === "future" ? "2026-11-04" : "2026-11-03", url: "https://example.org/market.mp3", durationSec: 720 }) };
    } });
    dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
    await new Promise((r) => setTimeout(r, 0));
    const box = dom.window.document.querySelector<HTMLElement>("#daily-audio")!;
    if (state === "current") { assert.equal(box.hidden, false); assert.ok(box.textContent?.includes("約 12 分鐘")); }
    else { assert.equal(box.hidden, false); assert.ok(box.textContent?.includes("語音版尚未啟動")); assert.equal(dom.window.document.querySelector("audio")!.hidden, true); }
    dom.window.close();
  }
});
