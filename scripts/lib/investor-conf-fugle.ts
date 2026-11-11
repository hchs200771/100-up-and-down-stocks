import { createRequire } from "node:module";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

/** 富果的主文可能拆成數個 article；只讀主文容器，不讀整頁或相關文章卡片。 */
export function extractFugleArticle(html: string): string | null {
  const dom = new JSDOM(html);
  try {
    const doc = dom.window.document;
    const body = doc.querySelector('[class~="contain-inline-size"], [itemprop="articleBody"], .entry-content, .post-content')
      ?? [...doc.querySelectorAll("article")].find((el) => el.querySelector("h2") && !el.closest("aside, nav"));
    if (!body) return null;
    body.querySelectorAll("script, style, nav, header, footer, aside, .related-posts, .fugle-card-container, .fugle-access-divider, [hidden], [aria-hidden='true']")
      .forEach((el) => el.remove());
    // 免責聲明以後不是研究資料（也避免尾端的推薦文章混入）。
    const end = [...body.querySelectorAll("h1, h2, h3, h4, p")]
      .find((el) => /^(免責聲明|相關文章|延伸閱讀)$/.test(el.textContent?.trim() ?? ""));
    if (end) {
      const range = doc.createRange();
      range.selectNodeContents(body);
      range.setStartBefore(end);
      range.deleteContents();
    }
    body.querySelectorAll("h1, h2, h3, h4, p, li, tr, br").forEach((el) => el.append("\n"));
    body.querySelectorAll("td, th").forEach((el) => el.append("\t"));
    const text = (body.textContent ?? "").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return text.replace(/\s/g, "").length >= 500 ? text : null;
  } finally {
    dom.window.close();
  }
}

export async function fetchFugleArticle(code: string, date: string, request: typeof fetch = fetch): Promise<{ text: string; url: string } | null> {
  const url = `https://blog.fugle.tw/post/earnings-call-${encodeURIComponent(code)}-${encodeURIComponent(date)}`;
  try {
    const response = await request(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; InvestorConfReader/1.0)", Accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
      redirect: "error", // 來源固定，不跟隨到其他網站或登入頁。
    });
    if (!response.ok) return null;
    const text = extractFugleArticle(await response.text());
    return text ? { text, url } : null;
  } catch {
    return null; // 尚未發布、逾時或解析失敗均交回影音備援。
  }
}
