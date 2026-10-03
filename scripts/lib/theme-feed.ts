import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ThemeArticle } from "./theme-radar";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new (xml: string, options: { contentType: string }) => { window: { document: Document } } };

function text(el: Element, names: string[]): string {
  for (const name of names) {
    const value = el.getElementsByTagName(name).item(0)?.textContent?.trim();
    if (value) return value;
  }
  return "";
}

function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return raw; }
}

export function parseThemeFeed(xml: string, source: string): ThemeArticle[] {
  const doc = new JSDOM(xml, { contentType: "application/xml" }).window.document;
  if (doc.getElementsByTagName("parsererror").length) throw new Error("RSS XML 格式錯誤");
  const nodes = [...doc.getElementsByTagName("item"), ...doc.getElementsByTagName("entry")];
  return nodes.flatMap((node) => {
    const title = text(node, ["title"]);
    const linkNode = node.getElementsByTagName("link").item(0);
    const url = canonicalUrl(linkNode?.getAttribute("href") || linkNode?.textContent?.trim() || "");
    const guid = text(node, ["guid", "id"]);
    const published = text(node, ["pubDate", "published", "updated", "dc:date"]);
    const timestamp = Date.parse(published);
    if (!title || !Number.isFinite(timestamp)) return [];
    const body = text(node, ["description", "summary", "content:encoded", "content"]);
    const id = createHash("sha256").update(url || `${source}:${guid || title}`).digest("hex");
    return [{ id, source, publishedAt: new Date(timestamp).toISOString(), title,
      body: body.slice(0, 4000), url }];
  });
}
