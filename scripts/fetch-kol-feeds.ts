import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 財經 KOL 新節目抓取：Podcast RSS + YouTube 頻道 feed，挑出「還沒上過報告」的新節目，
 * 盡量取得全文，寫到 data/tmp/kol-items.json 給 kol-brief-worker 判讀。
 *
 * 全文來源（由好到差）：
 * 1. YouTube 自動字幕（yt-dlp，免金鑰）。財經M平方的 Podcast 也會上 YouTube 且 YouTube 是超集，
 *    所以 M平方只追 YouTube：同一集不重複處理，還順便拿到逐字稿。
 * 2. Podcast 音檔轉文字：機器上有 mlx_whisper（Apple Silicon）就自動做，沒有就跳過（見下方）。
 * 3. 節目說明（show notes）：一定拿得到，但股癌這類說明很短，判讀會比較淺，報告上會標註。
 *
 * 轉文字指令：預設用 DEFAULT_TRANSCRIBE_CMD（mlx_whisper，本機跑、免金鑰），偵測到 mlx_whisper
 * 才啟用。要換別的工具就設 KOL_TRANSCRIBE_CMD（一段 shell 指令，$1 = 音檔、$2 = 要寫出的純文字檔），
 * 設成 off 則完全關閉。轉好的逐字稿會快取在 data/kol/transcripts/，重跑不會重轉。
 *
 * 任何一個來源失敗只 warn，不影響其他來源，也不影響主報告。
 */

interface Source {
  key: string;
  name: string;
  platform: "youtube" | "podcast";
  feed: string;
}

const SOURCES: Source[] = [
  { key: "macromicro", name: "財經M平方", platform: "youtube", feed: "https://www.youtube.com/feeds/videos.xml?channel_id=UC6LU7FUBvbFCh_cQasrHZ_Q" },
  { key: "jcinsight", name: "財女珍妮", platform: "youtube", feed: "https://www.youtube.com/feeds/videos.xml?channel_id=UCdwPn2TO60Ec8QDIFRx50lQ" },
  { key: "gooaye", name: "股癌", platform: "podcast", feed: "https://feeds.soundon.fm/podcasts/954689a5-3096-43a4-a80b-7810b219cef3.xml" },
  { key: "statementdog", name: "財報狗", platform: "podcast", feed: "https://feed.firstory.me/rss/user/clcftm46z000201z45w1c47fi" },
  { key: "ayen", name: "淡定聽台指", platform: "podcast", feed: "https://rss.buzzsprout.com/1901075.rss" },
];

const LOOKBACK_DAYS = Number(process.env.KOL_LOOKBACK_DAYS ?? 7);
const MAX_PER_SOURCE = Number(process.env.KOL_MAX_PER_SOURCE ?? 3);
const MAX_TEXT_CHARS = 40000;
const YTDLP = process.env.KOL_YTDLP || "yt-dlp";
// mlx_whisper 會把結果寫成「輸出目錄/音檔主檔名.txt」。音檔和 $2 同目錄、同主檔名
// （見 podcastTranscript），所以寫出來的正好就是 $2，不用再搬。
const DEFAULT_TRANSCRIBE_CMD =
  'mlx_whisper "$1" --model mlx-community/whisper-large-v3-turbo --language zh --output-format txt --output-dir "$(dirname "$2")"';

function resolveTranscribeCmd(): string {
  const env = process.env.KOL_TRANSCRIBE_CMD;
  if (env === "off") return "";
  if (env) return env;
  try {
    execFileSync("sh", ["-c", "command -v mlx_whisper"], { stdio: "ignore" });
    return DEFAULT_TRANSCRIBE_CMD;
  } catch {
    return "";
  }
}

const TRANSCRIBE_CMD = resolveTranscribeCmd();

const cwd = process.cwd();
const kolDir = resolve(cwd, "data/kol");
const transcriptDir = resolve(kolDir, "transcripts");
const seenPath = resolve(kolDir, "seen.json");
const outPath = resolve(cwd, "data/tmp/kol-items.json");

interface FeedItem {
  id: string;
  title: string;
  url: string;
  published: Date;
  notes: string;
  audio?: string;
  videoId?: string;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
}

function parseFeed(src: Source, xml: string): FeedItem[] {
  if (src.platform === "youtube") {
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
      const videoId = tag(e, "yt:videoId");
      return {
        id: `yt:${videoId}`,
        title: tag(e, "title"),
        url: `https://www.youtube.com/watch?v=${videoId}`,
        published: new Date(tag(e, "published")),
        notes: tag(e, "media:description"),
        videoId,
      };
    });
  }
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, e]) => {
    const audio = e.match(/<enclosure[^>]*url="([^"]+)"/)?.[1];
    const guid = tag(e, "guid") || audio || tag(e, "title");
    return {
      id: `${src.key}:${guid}`,
      title: tag(e, "title"),
      url: tag(e, "link") || audio || src.feed,
      published: new Date(tag(e, "pubDate")),
      notes: tag(e, "content:encoded") || tag(e, "description") || tag(e, "itunes:summary"),
      audio: audio?.replace(/&amp;/g, "&"),
    };
  });
}

function cacheFile(id: string): string {
  return resolve(transcriptDir, `${id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 120)}.txt`);
}

/** WebVTT 自動字幕 → 純文字。自動字幕會滾動重複前一行，相鄰重複的去掉。 */
function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split("\n")) {
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (!line || line === "WEBVTT" || line.includes("-->") || /^(Kind|Language):/.test(line)) continue;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join(" ");
}

function youtubeTranscript(videoId: string, outFile: string): string {
  const tmp = resolve(transcriptDir, `tmp-${videoId}`);
  try {
    execFileSync(
      YTDLP,
      // 只要 zh-TW：那是中文原生辨識的軌。zh-Hant 是「翻譯軌」，影片被誤判成英文時它是
      // 英文亂辨識再翻成中文，內容不可用，而且翻譯軌很容易吃 HTTP 429。
      ["--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", "zh-TW", "--sub-format", "vtt",
        "-o", `${tmp}.%(ext)s`, `https://www.youtube.com/watch?v=${videoId}`],
      { stdio: "ignore", timeout: 120_000 },
    );
  } catch {
    // 沒字幕或 yt-dlp 不在都會走到這裡；下面找不到檔案就當作沒有
  }
  const vtt = readdirSync(transcriptDir).find((f) => f.startsWith(`tmp-${videoId}.`) && f.endsWith(".vtt"));
  let text = "";
  if (vtt) text = vttToText(readFileSync(resolve(transcriptDir, vtt), "utf8"));
  for (const f of readdirSync(transcriptDir)) if (f.startsWith(`tmp-${videoId}.`)) rmSync(resolve(transcriptDir, f));
  if (text) writeFileSync(outFile, text, "utf8");
  return text;
}

async function podcastTranscript(audioUrl: string, outFile: string): Promise<string> {
  if (!TRANSCRIBE_CMD) return "";
  const audioFile = outFile.replace(/\.txt$/, ".mp3");
  try {
    // Buzzsprout 等 CDN 不帶 User-Agent 會回 403
    const res = await fetch(audioUrl, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(audioFile, Buffer.from(await res.arrayBuffer()));
    execFileSync("sh", ["-c", TRANSCRIBE_CMD, "kol-transcribe", audioFile, outFile], { stdio: "ignore", timeout: 1_800_000 });
    return existsSync(outFile) ? readFileSync(outFile, "utf8").trim() : "";
  } catch (err) {
    console.warn(`fetch-kol-feeds: transcribe failed for ${audioUrl}: ${(err as Error).message}`);
    return "";
  } finally {
    rmSync(audioFile, { force: true });
  }
}

function taipeiDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function readTradingDate(): string {
  try {
    const m = JSON.parse(readFileSync(resolve(cwd, "data/market-latest.json"), "utf8"));
    if (typeof m.tradingDate === "string") return m.tradingDate;
  } catch {
    // 沒有 market 檔就用今天（台北時間）
  }
  return taipeiDate(new Date());
}

async function main() {
  mkdirSync(transcriptDir, { recursive: true });
  mkdirSync(resolve(cwd, "data/tmp"), { recursive: true });
  console.log(`fetch-kol-feeds: podcast 轉文字 ${TRANSCRIBE_CMD ? "啟用" : "未啟用（找不到 mlx_whisper，只用節目說明）"}`);
  const tradingDate = readTradingDate();
  const seen: Record<string, string> = existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, "utf8")) : {};
  const cutoff = Date.now() - LOOKBACK_DAYS * 86400_000;
  const out: unknown[] = [];

  for (const src of SOURCES) {
    let items: FeedItem[];
    try {
      const res = await fetch(src.feed, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items = parseFeed(src, await res.text());
    } catch (err) {
      console.warn(`fetch-kol-feeds: ${src.name} feed failed: ${(err as Error).message}`);
      continue;
    }

    // 同一交易日重跑時，當天才標記的節目仍算新的，KOL 區塊不會因重跑而消失
    const fresh = items
      .filter((it) => it.published.getTime() >= cutoff && (!seen[it.id] || seen[it.id] === tradingDate))
      .sort((a, b) => b.published.getTime() - a.published.getTime())
      .slice(0, MAX_PER_SOURCE);

    for (const it of fresh) {
      const file = cacheFile(it.id);
      let text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
      if (!text && it.videoId) text = youtubeTranscript(it.videoId, file);
      if (!text && it.audio) text = await podcastTranscript(it.audio, file);
      const basis = text ? "transcript" : "notes";
      out.push({
        id: it.id,
        source: src.name,
        platform: src.platform,
        title: it.title,
        url: it.url,
        publishedAt: taipeiDate(it.published),
        basis,
        notes: it.notes.slice(0, 3000),
        text: text.slice(0, MAX_TEXT_CHARS),
      });
      console.log(`fetch-kol-feeds: ${src.name} | ${it.title} | ${basis}${text ? ` ${text.length} chars` : ""}`);
    }
  }

  writeFileSync(outPath, `${JSON.stringify({ tradingDate, generatedAt: new Date().toISOString(), items: out }, null, 2)}\n`, "utf8");
  console.log(`fetch-kol-feeds: ${out.length} new item(s) → data/tmp/kol-items.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
