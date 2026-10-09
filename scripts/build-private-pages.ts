/**
 * 產生加密的私人子頁到網站目錄（預設 data/site）：
 * - review.html：交易檢討（data/trade-review-latest.json，每日功課寫入）
 *
 * 資料檔不進版控。密碼讀 .env.local 的 SITE_PASSWORD；沒設就只發布說明頁，不發布內容。
 * 用法：tsx scripts/build-private-pages.ts [siteDir]
 */
import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderPrivatePage } from "./lib/private-page";

dotenv.config({ path: resolve(process.cwd(), ".env.local"), quiet: true });

interface TradeReviewItem {
  name: string;
  side?: string;
  kind?: string;
  status?: string;
  note: string;
}
interface TradeReview {
  date: string;
  summary?: string;
  trades?: TradeReviewItem[];
  holdings?: TradeReviewItem[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const para = (s: string) => esc(s).replace(/\n/g, "<br>");
const RELOCK = `<button class="relock" onclick="relock()">鎖上</button>`;

function readJson<T>(rel: string): T | null {
  const p = resolve(process.cwd(), rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    console.warn(`build-private-pages: ${rel} 無法解析，略過`);
    return null;
  }
}

function reviewHtml(r: TradeReview | null): string {
  if (!r || (!r.trades?.length && !r.holdings?.length && !r.summary)) {
    return `${RELOCK}<h1>📒 交易檢討</h1><p class="note">目前沒有檢討資料。</p>`;
  }
  const card = (it: TradeReviewItem) => {
    const tags = [it.kind, it.side, it.status].filter(Boolean).map((t) => `<span class="chip">${esc(t!)}</span>`).join("");
    return `<div class="card"><div class="t">${esc(it.name)}${tags}</div><div class="body">${para(it.note)}</div></div>`;
  };
  const block = (title: string, list?: TradeReviewItem[]) => (list?.length ? `<h2>${title}</h2>${list.map(card).join("")}` : "");
  return `${RELOCK}<h1>📒 交易檢討</h1>
<p class="sub">${esc(r.date)}</p>
${r.summary ? `<div class="card"><div class="body">${para(r.summary)}</div></div>` : ""}
${block("本期進出場", r.trades)}
${block("持倉健檢", r.holdings)}`;
}

async function main() {
  const siteDir = resolve(process.cwd(), process.argv[2] ?? "data/site");
  mkdirSync(siteDir, { recursive: true });
  const password = process.env.SITE_PASSWORD?.trim();
  if (!password) console.warn("build-private-pages: [warn] 沒有 SITE_PASSWORD，私人頁只發布說明、不含內容");

  const pages = [
    { file: "review.html", title: "交易檢討", icon: "📒", contentHtml: reviewHtml(readJson<TradeReview>("data/trade-review-latest.json")) },
  ];
  for (const p of pages) {
    writeFileSync(resolve(siteDir, p.file), await renderPrivatePage({ ...p, password }), "utf8");
  }
  console.log(`build-private-pages: ${pages.map((p) => p.file).join(", ")} → ${siteDir}${password ? "（已加密）" : "（未加密內容，未發布）"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
