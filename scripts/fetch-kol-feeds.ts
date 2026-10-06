import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 財經 KOL 新節目抓取：Podcast RSS + YouTube 頻道 feed，挑出「還沒上過報告」的新節目，
 * 盡量取得全文，寫到 data/tmp/kol-items.json 給 kol-brief-worker 判讀。
 *
 * 全文來源（由好到差）：
 * 1. YouTube 字幕（免金鑰）：先直接打 YouTube player API 拿字幕軌（不需要任何外部工具），
 *    失敗才退回 yt-dlp。財經M平方的 Podcast 也會上 YouTube 且 YouTube 是超集，
 *    所以 M平方只追 YouTube：同一集不重複處理，還順便拿到逐字稿。
 * 2. 音檔轉文字：Podcast 音檔，以及沒有中文字幕的 YouTube（例如被 YouTube 誤判成英文、
 *    只有英文 ASR 的影片，音訊同樣用 player API 直接下載）。轉文字的方式見下方。
 * 3. 節目說明（show notes）：一定拿得到，但股癌這類說明很短，判讀會比較淺，報告上會標註。
 *
 * 轉文字方式（依序取第一個可用的）：
 * - KOL_TRANSCRIBE_CMD：自訂 shell 指令，$1 = 音檔、$2 = 要寫出的純文字檔；設成 off 則完全關閉。
 * - GROQ_API_KEY：Groq 的 whisper-large-v3-turbo（免費額度每天 8 小時音訊，夠用），任何機器都能跑。
 *   免費方案單檔上限 25MB，MP3 超過就在 frame 邊界切段分別轉再接起來。
 * - mlx_whisper（僅 Apple Silicon）：偵測到就用 DEFAULT_TRANSCRIBE_CMD 本機轉。
 * 轉好的逐字稿會快取在 data/kol/transcripts/，重跑不會重轉。
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
// （見 transcribeAudio），所以寫出來的正好就是 $2，不用再搬。
const DEFAULT_TRANSCRIBE_CMD =
  'mlx_whisper "$1" --model mlx-community/whisper-large-v3-turbo --language zh --output-format txt --output-dir "$(dirname "$2")"';
const GROQ_MODEL = process.env.KOL_GROQ_MODEL || "whisper-large-v3-turbo";
// Groq 免費方案單檔上限 25MB，留點餘裕給 multipart 開銷
const GROQ_MAX_BYTES = 24 * 1024 * 1024;
// Whisper 預設會吐簡體字；給一段繁體提示讓它沿用繁體，也順便提示常見專有名詞
const GROQ_PROMPT = "以下是台灣財經節目的繁體中文逐字稿，內容會提到台股、美股、台積電、輝達、聯準會、股癌、財報狗、ETF。";
const YT_ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

type Transcriber = { kind: "cmd"; cmd: string; label: string } | { kind: "groq"; key: string; label: string };

function resolveTranscriber(): Transcriber | null {
  const env = process.env.KOL_TRANSCRIBE_CMD;
  if (env === "off") return null;
  if (env) return { kind: "cmd", cmd: env, label: "KOL_TRANSCRIBE_CMD" };
  if (process.env.GROQ_API_KEY) return { kind: "groq", key: process.env.GROQ_API_KEY, label: `Groq ${GROQ_MODEL}` };
  try {
    execFileSync("sh", ["-c", "command -v mlx_whisper"], { stdio: "ignore" });
    return { kind: "cmd", cmd: DEFAULT_TRANSCRIBE_CMD, label: "mlx_whisper" };
  } catch {
    return null;
  }
}

const TRANSCRIBER = resolveTranscriber();

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

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

/**
 * YouTube player API（ANDROID client；WEB client 會回 UNPLAYABLE）。字幕軌和音訊串流都從這裡拿，
 * 不依賴 yt-dlp。
 */
async function youtubePlayer(videoId: string) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": YT_ANDROID_UA },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "zh-TW" } },
      videoId,
    }),
  });
  if (!res.ok) throw new Error(`player HTTP ${res.status}`);
  return res.json();
}

/**
 * 這裡列出的都是真的字幕軌（人工上傳或 ASR），不含自動翻譯軌，所以 zh-Hant 也可以用。
 * 優先人工字幕，其次中文 ASR。只有英文 ASR 的（影片被誤判成英文）不用，交給轉文字。
 */
async function youtubeCaptions(player: any): Promise<string> {
  const tracks: CaptionTrack[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const rank = (t: CaptionTrack) =>
    (t.kind === "asr" ? 10 : 0) + Math.max(0, ["zh-TW", "zh-Hant", "zh", "zh-HK", "zh-CN", "zh-Hans"].indexOf(t.languageCode));
  const track = tracks.filter((t) => t.languageCode.startsWith("zh")).sort((a, b) => rank(a) - rank(b))[0];
  if (!track) return "";
  const cap = await fetch(`${track.baseUrl.replace(/&fmt=[^&]*/, "")}&fmt=json3`);
  if (!cap.ok) throw new Error(`caption HTTP ${cap.status}`);
  const json = await cap.json();
  const lines: string[] = [];
  for (const ev of json.events ?? []) {
    const line = (ev.segs ?? []).map((seg: { utf8?: string }) => seg.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (line && lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join(" ");
}

/**
 * 由小到大試音訊串流（語音辨識不需要高位元率），某個格式回 403 就換下一個。
 * 分段 Range 下載避免被限速。
 */
async function youtubeAudio(player: any): Promise<{ data: Buffer; ext: string } | null> {
  const formats: { url: string; mimeType: string; contentLength?: string }[] = (player?.streamingData?.adaptiveFormats ?? [])
    .filter((f: { url?: string; mimeType: string }) => f.url && f.mimeType.startsWith("audio/"))
    .sort((a: { contentLength?: string }, b: { contentLength?: string }) => Number(a.contentLength ?? Infinity) - Number(b.contentLength ?? Infinity));
  let lastErr: Error | null = null;
  for (const fmt of formats) {
    try {
      const total = Number(fmt.contentLength);
      const parts: Buffer[] = [];
      for (let start = 0; start < total; start += 10 * 1024 * 1024) {
        const end = Math.min(total, start + 10 * 1024 * 1024) - 1;
        const res = await fetch(fmt.url, { headers: { Range: `bytes=${start}-${end}`, "User-Agent": YT_ANDROID_UA } });
        if (!res.ok) throw new Error(`audio HTTP ${res.status}`);
        parts.push(Buffer.from(await res.arrayBuffer()));
      }
      return { data: Buffer.concat(parts), ext: fmt.mimeType.startsWith("audio/webm") ? "webm" : "m4a" };
    } catch (err) {
      lastErr = err as Error;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

async function youtubeTranscript(videoId: string, outFile: string): Promise<string> {
  let player: any;
  try {
    player = await youtubePlayer(videoId);
    const text = await youtubeCaptions(player);
    if (text) {
      writeFileSync(outFile, text, "utf8");
      return text;
    }
  } catch (err) {
    console.warn(`fetch-kol-feeds: YouTube API captions failed for ${videoId}: ${(err as Error).message}`);
  }
  const text = youtubeTranscriptViaYtDlp(videoId, outFile);
  if (text || !TRANSCRIBER || groqExhausted || !player) return text;
  try {
    const audio = await youtubeAudio(player);
    return audio ? await transcribeAudio(audio.data, audio.ext, outFile) : "";
  } catch (err) {
    console.warn(`fetch-kol-feeds: YouTube audio failed for ${videoId}: ${(err as Error).message}`);
    return "";
  }
}

function youtubeTranscriptViaYtDlp(videoId: string, outFile: string): string {
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

/**
 * MP3 切成不超過 maxBytes 的段落，切點對齊到 frame sync（0xFFE），每段都能獨立解碼。
 * 段落邊界會切掉半句話，對摘要用途影響不大。
 */
function splitMp3(data: Buffer, maxBytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  let start = 0;
  while (data.length - start > maxBytes) {
    let cut = start + maxBytes;
    while (cut > start + 1 && !(data[cut] === 0xff && (data[cut + 1] & 0xe0) === 0xe0)) cut--;
    if (cut <= start + 1) cut = start + maxBytes;
    chunks.push(data.subarray(start, cut));
    start = cut;
  }
  chunks.push(data.subarray(start));
  return chunks;
}

// 免費額度用完（等待時間太長的 429）後，這次執行就不再送 Groq，免得每集都白下載音檔
let groqExhausted = false;

async function groqTranscribe(key: string, data: Buffer, ext: string): Promise<string> {
  if (groqExhausted) throw new Error("Groq 額度已用完，下次執行再轉");
  const chunks = data.length <= GROQ_MAX_BYTES ? [data] : ext === "mp3" ? splitMp3(data, GROQ_MAX_BYTES) : null;
  if (!chunks) throw new Error(`${ext} 檔 ${(data.length / 1048576).toFixed(1)}MB 超過 Groq 上限，且只有 MP3 能切段`);
  const texts: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(chunk)]), `audio-${i}.${ext}`);
      form.append("model", GROQ_MODEL);
      form.append("language", "zh");
      form.append("response_format", "text");
      form.append("prompt", GROQ_PROMPT);
      const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (res.ok) {
        texts.push((await res.text()).trim());
        break;
      }
      // 免費額度是每小時音訊秒數，等太久就放棄，下次跑報告再轉（逐字稿有快取）
      const wait = Number(res.headers.get("retry-after") ?? 0);
      if (res.status === 429 && attempt < 2 && wait > 0 && wait <= 90) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (res.status === 429) groqExhausted = true;
      throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
  return texts.join(" ");
}

async function transcribeAudio(data: Buffer, ext: string, outFile: string): Promise<string> {
  if (!TRANSCRIBER) return "";
  if (TRANSCRIBER.kind === "groq") {
    const text = await groqTranscribe(TRANSCRIBER.key, data, ext);
    if (text) writeFileSync(outFile, text, "utf8");
    return text;
  }
  const audioFile = outFile.replace(/\.txt$/, `.${ext}`);
  try {
    writeFileSync(audioFile, data);
    execFileSync("sh", ["-c", TRANSCRIBER.cmd, "kol-transcribe", audioFile, outFile], { stdio: "ignore", timeout: 1_800_000 });
    return existsSync(outFile) ? readFileSync(outFile, "utf8").trim() : "";
  } finally {
    rmSync(audioFile, { force: true });
  }
}

async function podcastTranscript(audioUrl: string, outFile: string): Promise<string> {
  if (!TRANSCRIBER || groqExhausted) return "";
  try {
    // Buzzsprout 等 CDN 不帶 User-Agent 會回 403
    const res = await fetch(audioUrl, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = audioUrl.match(/\.(mp3|m4a|aac|wav|ogg)(?:\?|$)/i)?.[1].toLowerCase() ?? "mp3";
    return await transcribeAudio(Buffer.from(await res.arrayBuffer()), ext, outFile);
  } catch (err) {
    console.warn(`fetch-kol-feeds: transcribe failed for ${audioUrl}: ${(err as Error).message}`);
    return "";
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
  console.log(
    TRANSCRIBER
      ? `fetch-kol-feeds: 音檔轉文字啟用（${TRANSCRIBER.label}）`
      : "fetch-kol-feeds: [warn] 音檔轉文字未啟用（沒有 GROQ_API_KEY 也找不到 mlx_whisper），Podcast 只能用節目說明",
  );
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
      if (!text && it.videoId) text = await youtubeTranscript(it.videoId, file);
      if (!text && it.audio) text = await podcastTranscript(it.audio, file);
      const basis = text ? "transcript" : "notes";
      // Groq 額度用完而沒轉到的，標記起來讓 attach-kol 先不要標已讀，下次執行補轉
      const deferred = !text && groqExhausted;
      out.push({
        id: it.id,
        source: src.name,
        platform: src.platform,
        title: it.title,
        url: it.url,
        publishedAt: taipeiDate(it.published),
        basis,
        ...(deferred ? { deferred: true } : {}),
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
