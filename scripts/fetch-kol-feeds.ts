import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { resolve } from "node:path";

/**
 * 財經 KOL 新內容抓取：Podcast RSS、YouTube feed、股癌 Telegram 公開預覽與駿哥 X 本機 inbox，
 * 挑出「還沒上過報告」的新節目／貼文；Telegram 自動翻頁，X 由互動瀏覽器先擷取，
 * 盡量取得全文，寫到 data/tmp/kol-items.json 給 kol-brief-worker 判讀。
 *
 * 全文來源（由好到差）：
 * 1. YouTube 字幕（免金鑰）：先直接打 YouTube player API 拿字幕軌（不需要任何外部工具），
 *    失敗才退回 yt-dlp。財經M平方的 Podcast 也會上 YouTube 且 YouTube 是超集，
 *    所以 M平方只追 YouTube：同一集不重複處理，還順便拿到逐字稿。
 * 2. 音檔轉文字：Podcast 音檔，以及沒有中文字幕的 YouTube（例如被 YouTube 誤判成英文、
 *    只有英文 ASR 的影片，音訊同樣用 player API 直接下載，被擋就退回 yt-dlp）。轉文字的方式見下方。
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

// Telegram 等海外主機連線常超過 Node 預設 250ms 的 happy-eyeballs 嘗試時間，會直接 ETIMEDOUT，放寬到 2 秒
setDefaultAutoSelectFamilyAttemptTimeout(2000);

interface Source {
  key: string;
  name: string;
  platform: "youtube" | "podcast" | "telegram" | "x";
  feed: string;
}

const SOURCES: Source[] = [
  { key: "macromicro", name: "財經M平方", platform: "youtube", feed: "https://www.youtube.com/feeds/videos.xml?channel_id=UC6LU7FUBvbFCh_cQasrHZ_Q" },
  { key: "jcinsight", name: "財女珍妮", platform: "youtube", feed: "https://www.youtube.com/feeds/videos.xml?channel_id=UCdwPn2TO60Ec8QDIFRx50lQ" },
  { key: "gooaye", name: "股癌", platform: "youtube", feed: "https://www.youtube.com/feeds/videos.xml?channel_id=UC23rnlQU_qE3cec9x709peA" },
  { key: "wilsonrice", name: "股海飯桶", platform: "youtube", feed: "https://www.youtube.com/feeds/videos.xml?channel_id=UCDjTsgUSCsFWDDXkNZHLAXQ" },
  { key: "statementdog", name: "財報狗", platform: "podcast", feed: "https://feed.firstory.me/rss/user/clcftm46z000201z45w1c47fi" },
  { key: "ayen", name: "淡定聽台指", platform: "podcast", feed: "https://rss.buzzsprout.com/1901075.rss" },
  { key: "gooaye-tg", name: "股癌 Telegram", platform: "telegram", feed: "https://t.me/s/Gooaye" },
  { key: "qq_timmy", name: "駿哥（X）", platform: "x", feed: "data/kol/x-inbox/QQ_Timmy.json" },
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

interface PostItem {
  id: string;
  url: string;
  published: Date;
  text: string;
  images?: string;
}

/** 公開預覽的每個訊息各自切段，避免圖片／連結預覽的巢狀 div 混到下一則。 */
function parseTelegram(html: string): PostItem[] {
  const starts = [...html.matchAll(/<div\b[^>]*\bclass="[^"]*\btgme_widget_message\b[^"]*"[^>]*\bdata-post="(Gooaye\/\d+)"[^>]*>/g)];
  const posts: PostItem[] = [];
  for (const [i, match] of starts.entries()) {
    const block = html.slice(match.index! + match[0].length, starts[i + 1]?.index ?? html.length);
    const published = new Date(block.match(/<time\b[^>]*\bdatetime="([^"]+)"/)?.[1] ?? "");
    if (!Number.isFinite(published.getTime())) continue;
    const raw = block.match(/<div\b[^>]*\bclass="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    // 有標籤文字的連結仍保留目的網址；先解碼正文，再補 HTML 常見實體。
    const linked = raw.replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label} (${href})`);
    const text = decode(linked)
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&nbsp;/g, " ");
    posts.push({ id: `tg:${match[1]}`, url: `https://t.me/${match[1]}`, published, text: text.trim() || "[圖片貼文]" });
  }
  return posts;
}

/** 最多三頁；已碰到回溯期限就不用再往前抓。後頁失敗仍保留前頁。 */
async function telegramPosts(feed: string, cutoff: number): Promise<PostItem[]> {
  const posts = new Map<string, PostItem>();
  let before = "";
  for (let page = 0; page < 3; page++) {
    let batch: PostItem[];
    try {
      const res = await fetch(`${feed}${before ? `?before=${before}` : ""}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      batch = parseTelegram(await res.text());
    } catch (err) {
      console.warn(`fetch-kol-feeds: Telegram page ${page + 1} failed: ${(err as Error).message}`);
      break;
    }
    for (const post of batch) posts.set(post.id, post);
    if (!batch.length || batch.some((post) => post.published.getTime() < cutoff)) break;
    const oldest = String(Math.min(...batch.map((post) => Number(post.id.split("/").pop()))));
    if (oldest === before) break;
    before = oldest;
  }
  return [...posts.values()];
}

/** X 只能讀互動瀏覽器留下的 inbox；缺檔／格式不符由來源層 warn 並略過。 */
function xPosts(feed: string): PostItem[] {
  const inbox = JSON.parse(readFileSync(resolve(cwd, feed), "utf8"));
  if (inbox?.handle !== "QQ_Timmy" || !Array.isArray(inbox.posts)) throw new Error("invalid X inbox");
  const posts = new Map<string, PostItem>();
  for (const post of inbox.posts) {
    const published = new Date(typeof post?.postedAt === "string" ? post.postedAt : "");
    if (!post || typeof post.id !== "string" || !/^\d+$/.test(post.id) || !Number.isFinite(published.getTime())
      || typeof post.text !== "string" || (post.images != null && typeof post.images !== "string")) {
      console.warn("fetch-kol-feeds: invalid X inbox post, skipped");
      continue;
    }
    const id = `x:QQ_Timmy/${post.id}`;
    posts.set(id, { id, url: `https://x.com/QQ_Timmy/status/${post.id}`, published, text: post.text, images: post.images ?? "" });
  }
  return [...posts.values()];
}

/** 貼文依逐則已讀狀態篩選，一個來源每天只交一包，不套用節目數上限。 */
function bundlePosts(src: Source, posts: PostItem[], seen: Record<string, string>, tradingDate: string, cutoff: number) {
  const fresh = posts
    .filter((post) => post.published.getTime() >= cutoff && (!seen[post.id] || seen[post.id] === tradingDate))
    .sort((a, b) => b.published.getTime() - a.published.getTime())
    .slice(0, 40)
    .reverse();
  if (!fresh.length) return null;
  const oldest = taipeiDate(fresh[0].published);
  const newest = taipeiDate(fresh[fresh.length - 1].published);
  const shortDate = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
  const text = fresh.map((post) => {
    const stamp = new Date(post.published.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
    return `[${stamp}] ${post.url}\n${post.text}${post.images ? `\n圖片內容：${post.images}` : ""}`;
  }).join("\n\n").slice(0, MAX_TEXT_CHARS);
  return {
    id: `${src.platform === "telegram" ? "tg:Gooaye" : "x:QQ_Timmy"}@${tradingDate}`,
    source: src.name,
    platform: src.platform,
    title: `${fresh.length} 則新貼文（${shortDate(oldest)}–${shortDate(newest)}）`,
    url: src.platform === "telegram" ? "https://t.me/Gooaye" : "https://x.com/QQ_Timmy",
    publishedAt: newest,
    basis: "posts",
    notes: "",
    text,
    postIds: fresh.map((post) => post.id),
  };
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
  if (text || !TRANSCRIBER || groqExhausted) return text;
  let audio: { data: Buffer; ext: string } | null = null;
  if (player) {
    try {
      audio = await youtubeAudio(player);
    } catch (err) {
      console.warn(`fetch-kol-feeds: YouTube audio failed for ${videoId}: ${(err as Error).message}, trying yt-dlp`);
    }
  }
  audio ??= youtubeAudioViaYtDlp(videoId);
  if (!audio) return "";
  try {
    return await transcribeAudio(audio.data, audio.ext, outFile);
  } catch (err) {
    console.warn(`fetch-kol-feeds: transcribe failed for YouTube ${videoId}: ${(err as Error).message}`);
    return "";
  }
}

/**
 * player API 直接下載音訊常被擋（HTTP 403），改用 yt-dlp 抓最小的音訊格式。
 * 優先 m4a（約 48kbps，一小時約 21MB，在 Groq 25MB 上限內）。
 */
function youtubeAudioViaYtDlp(videoId: string): { data: Buffer; ext: string } | null {
  const tmp = resolve(transcriptDir, `tmp-audio-${videoId}`);
  try {
    execFileSync(
      YTDLP,
      ["-f", "worstaudio[ext=m4a]/worstaudio", "-o", `${tmp}.%(ext)s`, `https://www.youtube.com/watch?v=${videoId}`],
      { stdio: "ignore", timeout: 600_000 },
    );
  } catch {
    // yt-dlp 不在或下載失敗，下面找不到檔案就當作沒有
  }
  const file = readdirSync(transcriptDir).find((f) => f.startsWith(`tmp-audio-${videoId}.`) && !f.endsWith(".part"));
  const audio = file ? { data: readFileSync(resolve(transcriptDir, file)), ext: file.split(".").pop()! } : null;
  for (const f of readdirSync(transcriptDir)) if (f.startsWith(`tmp-audio-${videoId}.`)) rmSync(resolve(transcriptDir, f));
  if (!audio) console.warn(`fetch-kol-feeds: yt-dlp audio failed for ${videoId}`);
  return audio;
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

// YouTube 頻道 feed 常隨機回 404/500（實測單次成功率約兩成，跟 UA、快取參數無關），多試幾次
async function fetchFeed(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 12) throw new Error(`${(err as Error).message}（試了 ${attempt} 次）`);
      await new Promise((r) => setTimeout(r, 2000));
    }
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
    if (src.platform === "telegram" || src.platform === "x") {
      try {
        const posts = src.platform === "telegram" ? await telegramPosts(src.feed, cutoff) : xPosts(src.feed);
        const bundle = bundlePosts(src, posts, seen, tradingDate, cutoff);
        if (bundle) {
          out.push(bundle);
          console.log(`fetch-kol-feeds: ${src.name} | ${bundle.title} | posts ${bundle.text.length} chars`);
        }
      } catch (err) {
        console.warn(`fetch-kol-feeds: ${src.name} posts failed: ${(err as Error).message}`);
      }
      continue;
    }
    let items: FeedItem[];
    try {
      items = parseFeed(src, await fetchFeed(src.feed));
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
