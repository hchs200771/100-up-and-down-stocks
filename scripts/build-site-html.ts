/**
 * Wrap the shared report fragment (data/report-latest.html — also used as the
 * email body) into a full standalone HTML document for GitHub Pages, injecting
 * a browser-tab favicon and SEO / Open Graph metadata.
 *
 * The email body is intentionally left untouched: this wrapping happens only at
 * publish time so the tab icon + meta tags never leak into the email HTML.
 *
 * Usage: npx tsx scripts/build-site-html.ts <fragmentPath> <outPath>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SITE_URL = "https://hchs200771.github.io/100-up-and-down-stocks/";

const fragmentPath = process.argv[2] ?? "data/report-latest.html";
const outPath = process.argv[3] ?? "data/site/index.html";

// The fragment leads with a <meta viewport> (needed for the email body); drop it
// here so it doesn't end up as an invalid meta-in-body — the head already has one.
const fragment = readFileSync(resolve(process.cwd(), fragmentPath), "utf-8").replace(
  /^\s*<meta name="viewport"[^>]*>\s*/i,
  ""
);

// Pull timestamp + summary from the assembled analysis for dynamic title/description.
let timestamp = "";
let summary = "";
const analysisPath = resolve(process.cwd(), "data/analysis-latest.json");
if (existsSync(analysisPath)) {
  try {
    const a = JSON.parse(readFileSync(analysisPath, "utf-8"));
    timestamp = String(a.timestamp ?? a.date ?? "");
    summary = String(a.summary ?? "");
  } catch {
    // fall through to generic metadata
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const title = timestamp
  ? `台股盤後資金流向與 AI 總結 (${timestamp})`
  : "台股盤後資金流向與 AI 總結";

// Description: first ~150 chars of the summary, newlines collapsed; generic fallback.
const rawDesc = summary
  ? summary.replace(/\s+/g, " ").trim().slice(0, 150)
  : "每日台股盤後：漲跌幅前 100 名個股的產業族群分類、資金流向、法人籌碼與 AI 盤後總結。";
const description = esc(rawDesc);

// Emoji favicon as an inline SVG data URI — self-contained, no binary asset needed.
const favicon =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">📈</text></svg>'
  );

const doc = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${description}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${SITE_URL}">
<link rel="icon" href="${favicon}">
<link rel="apple-touch-icon" href="${favicon}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="台股盤後資金流向">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${SITE_URL}">
<meta property="og:locale" content="zh_TW">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${description}">
</head>
<body>
${fragment}
</body>
</html>
`;

writeFileSync(resolve(process.cwd(), outPath), doc, "utf-8");
console.log(`[build-site] Wrote ${outPath} (title: ${title})`);
