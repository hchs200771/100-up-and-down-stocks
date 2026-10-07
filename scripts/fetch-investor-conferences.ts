#!/usr/bin/env npx tsx
/**
 * 法說會判讀：每天掃公開資訊觀測站的法人說明會一覽表，讀簡報與影音，判斷值不值得關注。
 *
 * 資料源：公開資訊觀測站舊站（mopsov）。新站（mops.twse.com.tw）會擋非瀏覽器請求，舊站一般請求即可。
 * 1. 一覽表：POST ajax_t100sb02_1，上市 sii／上櫃 otc／興櫃 rotc 各一次，一次回一整個月，自己依日期篩。
 * 2. 簡報：POST server-java/FileDownLoad（沒有穩定的 GET 網址），優先中文檔，沒有才用英文檔。
 *    用 unpdf 抽文字；每頁平均字數太少的標成「簡報多為圖片」——圖表裡的數字抽不到。
 * 3. 影音：只處理直接的 .mp4（證交所 irconference 主機）。ffmpeg 直接從網址串流抽音軌、
 *    切成 20 分鐘的 mp3，丟 Groq whisper 轉文字（同 fetch-kol-feeds.ts 的 GROQ_API_KEY）。
 *    影片本身不落地；音檔轉完就刪，只留逐字稿。公司官網、YouTube 頁面之類的連結不轉。
 * 4. 判讀：每場一個 codex exec（預設 gpt-6.1-sol），簡報文字＋逐字稿＋月營收動能／當日漲跌，
 *    依 schemas/codex-investor-conf.schema.json 輸出重點與 1~5 分。
 *
 * 晚上開的場次常隔天才上傳簡報，所以預設看最近 3 天，已判讀過的直接沿用；
 * 之後才補上簡報或影音的，會重新判讀一次。
 *
 * 讀：data/market-latest.json（交易日、漲跌幅前 100）、data/revenue-momentum-latest.json
 * 寫：data/cache/investor-conf/ — 抽出的簡報文字與逐字稿（快取，不進版控；PDF 與音檔用完即刪）
 *     data/investor-conf-history/<YYYY-MM>.json — 每場的判讀結果，依「代號-日期」去重
 *     data/investor-conf-latest.json、data/investor-conf.html — 子頁 /investor-conf.html
 *
 * 用法：
 *   npx tsx scripts/fetch-investor-conferences.ts                       # 交易日往前 3 天
 *   npx tsx scripts/fetch-investor-conferences.ts --date 2026-10-01 --days 1
 *   加 --no-video 不轉影音、--no-llm 只抓不判讀、--redo 已判讀的也重做
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { extractText } from "unpdf";
import { twDate, twIso } from "./lib/time";
import { renderInvestorConfPage } from "./lib/investor-conf-page";

const ROOT = process.cwd();
const WORK_DIR = resolve(ROOT, "data/cache/investor-conf");
const HISTORY_DIR = resolve(ROOT, "data/investor-conf-history");
const OUT_LATEST = resolve(ROOT, "data/investor-conf-latest.json");
const OUT_HTML = resolve(ROOT, "data/investor-conf.html");
const PROMPT_FILE = resolve(ROOT, "scripts/prompts/investor-conf-reader-codex.md");
const SCHEMA_FILE = resolve(ROOT, "scripts/schemas/codex-investor-conf.schema.json");
const MODEL = process.env.INVESTOR_CONF_MODEL ?? "gpt-6.1-sol";
const EFFORT = process.env.INVESTOR_CONF_REASONING_EFFORT ?? "medium";
const CONCURRENCY = Number(process.env.INVESTOR_CONF_CONCURRENCY ?? 3);
const CODEX_TIMEOUT_MS = Number(process.env.INVESTOR_CONF_TIMEOUT_SECONDS ?? 600) * 1000;
const MAX_VIDEOS = Number(process.env.INVESTOR_CONF_MAX_VIDEOS ?? 12); // Groq 免費額度有限，一次最多轉幾支，剩的下次轉
const DECK_CHARS = 30_000;
const TRANSCRIPT_CHARS = 40_000;
const IMAGE_HEAVY_CHARS_PER_PAGE = 120;
const UPCOMING_DAYS = 7;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MOPS = "https://mopsov.twse.com.tw";
const GROQ_KEY = process.env.GROQ_API_KEY ?? "";
const GROQ_MODEL = process.env.KOL_GROQ_MODEL || "whisper-large-v3-turbo";
const GROQ_PROMPT = "以下是台灣上市櫃公司法人說明會的繁體中文逐字稿，內容會提到營收、毛利率、營業利益率、EPS、資本支出、產能利用率、年增率、季增率。";
const DAY_MS = 86_400_000;
// 每日報告在背景啟動、不等它；跑太久（例如 Groq 一直限速）就停在這裡，剩下的下次接著做
const MAX_MINUTES = Number(process.env.INVESTOR_CONF_MAX_MINUTES ?? 180);
const LOCK_FILE = resolve(WORK_DIR, "run.pid");

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);
const DAYS = Math.max(1, Number(arg("--days") ?? 7)); // 頁面保留最近一週：背景跑不完的，下次更新還看得到
const NO_VIDEO = flag("--no-video");
const NO_LLM = flag("--no-llm");
const REDO = flag("--redo");

export type Market = "sii" | "otc" | "rotc";
const MARKET_LABEL: Record<Market, string> = { sii: "上市", otc: "上櫃", rotc: "興櫃" };

export interface ConfRow {
  key: string; // 代號-日期
  code: string;
  name: string;
  market: Market;
  date: string; // YYYY-MM-DD
  time: string;
  place: string;
  summary: string; // 擇要訊息
  fileZh: string | null;
  fileEn: string | null;
  videoUrl: string | null; // 影音資訊網址（可能是公司網頁，不一定是影片）
  note: string;
}

export interface ConfAnalysis {
  headline: string;
  score: number;
  verdict: "重點關注" | "值得留意" | "一般" | "可略過";
  reason: string;
  keyNumbers: { label: string; value: string }[];
  guidance: string;
  drivers: string[];
  risks: string[];
  qaHighlights: string[];
  tone: "轉佳" | "持平" | "轉差" | "無法判斷";
  evidence: string;
}

export interface ConfResult extends ConfRow {
  deck: { file: string; pages: number; chars: number; imageHeavy: boolean } | null;
  transcript: { minutes: number; chars: number } | null;
  videoStatus: string; // ok / 無影片 / 非直接影片連結 / 失敗原因
  context: { revenue: string | null; move: string | null };
  analysis: ConfAnalysis | null;
  analysisError?: string;
  analyzedAt?: string;
  model?: string;
  /** 判讀時用到的資料等級（evidenceRank），之後補到更多資料（簡報上傳、影音轉好）就重判 */
  analyzedEvidence?: number;
  firstSeen?: string; // 第一次出現在一覽表的執行時間
  deckStatus?: string; // ok / 尚未上傳 / 下載失敗
  state?: "done" | "partial" | "pending";
  pendingNote?: string; // 還缺什麼、下次會補什麼
}

export interface InvestorConfLatest {
  generatedAt: string;
  date: string;
  from: string;
  model: string;
  run: { startedAt: string; finishedAt: string | null; newKeys: string[] };
  items: ConfResult[];
  upcoming: ConfRow[];
}

const log = (msg: string) => console.log(`[investor-conf] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
// 背景執行時，月營收等檔案可能正被主流程改寫；讀到一半的就當作沒有
const readJson = <T>(p: string, fallback: T): T => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};
/** 先寫暫存檔再改名：發佈腳本隨時可能來讀，不能讓它讀到寫一半的檔案 */
const writeAtomic = (p: string, data: string) => {
  writeFileSync(`${p}.tmp`, data);
  renameSync(`${p}.tmp`, p);
};

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

async function post(url: string, body: Record<string, string>, attempts = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: `${MOPS}/mops/web/t100sb02_1` },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= attempts) throw e;
      await sleep(2000 * i);
    }
  }
}

/**
 * 大檔下載：MOPS 簡報只有 30~50KB/s、又不給 Content-Length，一份 5MB 的簡報要兩三分鐘，
 * 固定總逾時會誤殺。改成「60 秒沒收到資料才放棄」，總時間另設上限。
 */
async function download(url: string, init: RequestInit, dest: string | null, maxMs = 20 * 60_000): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const hardStop = setTimeout(() => ctrl.abort(new Error("下載超過總時間上限")), maxMs);
  let idle = setTimeout(() => ctrl.abort(new Error("60 秒沒有收到資料")), 60_000);
  try {
    const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const chunks: Uint8Array[] = [];
    const out = dest ? createWriteStream(dest) : null;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new Error("60 秒沒有收到資料")), 60_000);
      if (out) {
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      } else chunks.push(chunk);
    }
    if (out) await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    return out ? new Uint8Array() : new Uint8Array(Buffer.concat(chunks));
  } finally {
    clearTimeout(hardStop);
    clearTimeout(idle);
  }
}

/**
 * 證交所影音主機：影片可能超過 1GB，長連線常在中途被切斷（undici 回 "terminated"）。
 * 它支援 Range，所以 50MB 一段下載，哪段斷了只重抓那段。
 */
async function downloadRanged(url: string, dest: string, label: string): Promise<void> {
  const CHUNK = 50 * 1024 * 1024;
  const head = await fetch(url, { headers: { "User-Agent": UA, Range: "bytes=0-0" }, signal: AbortSignal.timeout(30_000) });
  const total = Number(head.headers.get("content-range")?.split("/")[1] ?? 0);
  await head.body?.cancel();
  if (!total) return void (await download(url, {}, dest)); // 不支援 Range 就整檔抓
  if (total > 3 * 1024 ** 3) throw new Error(`影片 ${(total / 1024 ** 3).toFixed(1)}GB 太大，略過`);
  const out = createWriteStream(dest);
  try {
    for (let start = 0; start < total; start += CHUNK) {
      const end = Math.min(total, start + CHUNK) - 1;
      for (let attempt = 1; ; attempt++) {
        try {
          const buf = await download(url, { headers: { Range: `bytes=${start}-${end}` } }, null, 5 * 60_000);
          if (buf.length !== end - start + 1) throw new Error(`只收到 ${buf.length} bytes`);
          if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          log(`  影音 ${label} 第 ${Math.round(start / CHUNK) + 1} 段中斷（${(e as Error).message}），重試`);
          await sleep(2000 * attempt);
        }
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
}

// ───────────── 1. 一覽表 ─────────────

function parseList(html: string, market: Market): ConfRow[] {
  const rows: ConfRow[] = [];
  for (const m of html.matchAll(/<tr[^>]*data-type='body'[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length < 11) continue;
    const roc = decode(tds[2]).match(/(\d+)\/(\d+)\/(\d+)/);
    if (!roc) continue;
    const date = `${Number(roc[1]) + 1911}-${roc[2].padStart(2, "0")}-${roc[3].padStart(2, "0")}`;
    const file = (td: string) => td.match(/fileName\.value="([^"]+\.pdf)"/i)?.[1] ?? null;
    // 影音欄同時有「同步收看網址」與「影音資訊網址」，只取後者
    const media = tds[9].split(/影音資訊網址/)[1] ?? "";
    const videoUrl = media.match(/href='([^']+)'/)?.[1] ?? null;
    const code = decode(tds[0]);
    rows.push({
      key: `${code}-${date}`,
      code,
      name: decode(tds[1]),
      market,
      date,
      time: decode(tds[3]),
      place: decode(tds[4]),
      summary: decode(tds[5]),
      fileZh: file(tds[6]),
      fileEn: file(tds[7]),
      videoUrl,
      note: decode(tds[10]),
    });
  }
  return rows;
}

async function fetchList(months: string[]): Promise<ConfRow[]> {
  const all: ConfRow[] = [];
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    for (const market of ["sii", "otc", "rotc"] as Market[]) {
      const res = await post(`${MOPS}/mops/web/ajax_t100sb02_1`, {
        encodeURIComponent: "1", step: "1", firstin: "1", off: "1", TYPEK: market, year: String(y - 1911), month: String(m), co_id: "",
      });
      const rows = parseList(await res.text(), market);
      log(`一覽表 ${ym} ${MARKET_LABEL[market]}：${rows.length} 場`);
      all.push(...rows);
      await sleep(800);
    }
  }
  // 同一家同一天偶爾重複公告（更正），留後面那筆
  return [...new Map(all.map((r) => [r.key, r])).values()];
}

// ───────────── 2. 簡報 ─────────────

async function readDeck(row: ConfRow): Promise<{ meta: ConfResult["deck"]; text: string }> {
  for (const file of [row.fileZh, row.fileEn].filter((f): f is string => !!f)) {
    const cache = resolve(WORK_DIR, "decks", `${file}.txt`);
    if (existsSync(cache)) {
      const saved = JSON.parse(readFileSync(cache, "utf8"));
      return { meta: saved.meta, text: saved.text };
    }
    try {
      const t0 = Date.now();
      const buf = await download(`${MOPS}/server-java/FileDownLoad`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ step: "9", functionName: "t100sb02_1", fileName: file, filePath: "/home/html/nas/STR/" }).toString(),
      }, null);
      if (String.fromCharCode(...buf.slice(0, 4)) !== "%PDF") throw new Error(`不是 PDF（${buf.length} bytes）`);
      const mb = buf.length / 1048576; // unpdf 會把 buffer 轉移給 worker，之後 length 變 0，先記下來
      // PDF 不落地：抽完文字就丟，只快取文字
      const { totalPages, text } = await extractText(buf, { mergePages: false });
      const pages = (text as string[]).map((t, i) => `【第 ${i + 1} 頁】\n${t.replace(/[ \t]+/g, " ").trim()}`);
      const joined = pages.join("\n\n");
      const chars = (text as string[]).reduce((n, t) => n + t.replace(/\s+/g, "").length, 0);
      const meta = { file, pages: totalPages, chars, imageHeavy: chars / Math.max(1, totalPages) < IMAGE_HEAVY_CHARS_PER_PAGE };
      writeFileSync(cache, JSON.stringify({ meta, text: joined }));
      log(`  簡報 ${file}：${mb.toFixed(1)}MB／${Math.round((Date.now() - t0) / 1000)}s，${totalPages} 頁、${chars} 字${meta.imageHeavy ? "（多為圖片）" : ""}`);
      return { meta, text: joined };
    } catch (e) {
      log(`  [warn] 簡報 ${file} 下載／解析失敗：${(e as Error).message}`);
    }
  }
  return { meta: null, text: "" };
}

// ───────────── 3. 影音 ─────────────

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    if (!ffmpegPath) return fail(new Error("找不到 ffmpeg-static 執行檔"));
    const p = spawn(ffmpegPath as unknown as string, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-20_000)));
    const timer = setTimeout(() => p.kill("SIGKILL"), 30 * 60_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? ok(err) : fail(new Error(`ffmpeg exit ${code}: ${err.split("\n").filter(Boolean).slice(-2).join(" ")}`));
    });
  });
}

let groqExhausted = false;

async function groqTranscribe(file: string): Promise<string> {
  if (groqExhausted) throw new Error("Groq 額度已用完，下次執行再轉");
  const data = readFileSync(file);
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), "audio.mp3");
    form.append("model", GROQ_MODEL);
    form.append("language", "zh");
    form.append("response_format", "text");
    form.append("prompt", GROQ_PROMPT);
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: form,
    });
    if (res.ok) return (await res.text()).trim();
    const wait = Number(res.headers.get("retry-after") ?? 0);
    if (res.status === 429 && attempt < 2 && wait > 0 && wait <= 120) {
      log(`  Groq 限速，等 ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 429) groqExhausted = true;
    throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

const isDirectVideo = (url: string | null) => !!url && /^https?:\/\/[^?#]+\.(mp4|m4a|mp3|m3u8)(\?|$)/i.test(url);
const youtubeId = (url: string | null) =>
  url?.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null;
/** 轉得了的影音：證交所主機上的影片檔，或 YouTube。其他（公司官網、證交所 WebPortal 頁面）不轉。 */
const canTranscribe = (url: string | null) => isDirectVideo(url) || !!youtubeId(url);

// YouTube：同 fetch-kol-feeds.ts，用 player API（ANDROID client）拿字幕軌與音訊串流，不依賴 yt-dlp。
const YT_ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

async function youtubePlayer(videoId: string): Promise<any> {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": YT_ANDROID_UA },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "zh-TW" } }, videoId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`YouTube player HTTP ${res.status}`);
  return res.json();
}

/** 中文字幕軌（人工優先，其次中文 ASR）。沒有就回空字串，改走音訊轉文字。 */
async function youtubeCaptions(player: any): Promise<string> {
  const tracks: { baseUrl: string; languageCode: string; kind?: string }[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const rank = (t: { languageCode: string; kind?: string }) => (t.kind === "asr" ? 10 : 0) + Math.max(0, ["zh-TW", "zh-Hant", "zh", "zh-HK", "zh-CN", "zh-Hans"].indexOf(t.languageCode));
  const track = tracks.filter((t) => t.languageCode.startsWith("zh")).sort((a, b) => rank(a) - rank(b))[0];
  if (!track) return "";
  const cap = await fetch(`${track.baseUrl.replace(/&fmt=[^&]*/, "")}&fmt=json3`);
  if (!cap.ok) throw new Error(`caption HTTP ${cap.status}`);
  const lines: string[] = [];
  for (const ev of (await cap.json()).events ?? []) {
    const line = (ev.segs ?? []).map((seg: { utf8?: string }) => seg.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (line && lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join(" ");
}

const YTDLP = process.env.KOL_YTDLP || "yt-dlp";

/** yt-dlp 抓最小的音訊軌到 tmp，再改名成 dest。 */
function ytDlpAudio(videoId: string, tmp: string, dest: string): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(YTDLP, ["-q", "--no-progress", "-f", "worstaudio", "--js-runtimes", "node", "--ffmpeg-location", String(ffmpegPath),
      "-o", resolve(tmp, "yt.%(ext)s"), `https://www.youtube.com/watch?v=${videoId}`], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("error", (e) => fail(new Error(`yt-dlp 無法執行：${e.message}`)));
    const timer = setTimeout(() => p.kill("SIGKILL"), 15 * 60_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      const file = readdirSync(tmp).find((f) => f.startsWith("yt.") && !f.endsWith(".part"));
      if (code !== 0 || !file) return fail(new Error(`yt-dlp exit ${code}: ${err.trim().split("\n").pop()}`));
      renameSync(resolve(tmp, file), dest);
      ok();
    });
  });
}

/** 最小的音訊串流，10MB 一段 Range 下載（一次抓整檔會被限速），寫到 dest。 */
async function youtubeAudio(player: any, dest: string): Promise<void> {
  const formats: { url: string; mimeType: string; contentLength?: string }[] = (player?.streamingData?.adaptiveFormats ?? [])
    .filter((f: { url?: string; mimeType: string }) => f.url && f.mimeType.startsWith("audio/"))
    .sort((a: { contentLength?: string }, b: { contentLength?: string }) => Number(a.contentLength ?? Infinity) - Number(b.contentLength ?? Infinity));
  if (!formats.length) throw new Error("YouTube 沒有可下載的音訊串流");
  let lastErr: Error | null = null;
  for (const fmt of formats) {
    try {
      const total = Number(fmt.contentLength);
      const out = createWriteStream(dest);
      for (let start = 0; start < total; start += 10 * 1024 * 1024) {
        const end = Math.min(total, start + 10 * 1024 * 1024) - 1;
        const res = await fetch(fmt.url, { headers: { Range: `bytes=${start}-${end}`, "User-Agent": YT_ANDROID_UA }, signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`audio HTTP ${res.status}`);
        out.write(Buffer.from(await res.arrayBuffer()));
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
      return;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr;
}

async function transcribe(row: ConfRow): Promise<{ meta: ConfResult["transcript"]; text: string; status: string }> {
  if (!row.videoUrl) return { meta: null, text: "", status: "無影片" };
  if (!canTranscribe(row.videoUrl)) return { meta: null, text: "", status: "影音在公司網頁，未轉" };
  const cache = resolve(WORK_DIR, "transcripts", `${row.key}.json`);
  if (existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, "utf8"));
    return { meta: saved.meta, text: saved.text, status: "ok" };
  }
  if (NO_VIDEO) return { meta: null, text: "", status: "本次未轉" };
  if (!GROQ_KEY) return { meta: null, text: "", status: "未設定 GROQ_API_KEY" };
  if (groqExhausted) return { meta: null, text: "", status: "Groq 額度已滿，下次轉" };
  const url = row.videoUrl.replace(/^http:\/\/irconference\./, "https://irconference.");
  const tmp = resolve(WORK_DIR, "audio-tmp", row.key); // 影片暫存，用完即刪
  // 抽好的音檔（約 15MB／小時）。Groq 額度滿了就留到下次，不用再抓一次影片（大的超過 1GB）；轉完即刪
  const pending = resolve(WORK_DIR, "audio-pending", row.key);
  const listParts = () => (existsSync(pending) ? readdirSync(pending).filter((f) => f.endsWith(".mp3")).sort() : []);
  let keepAudio = false;
  try {
    let minutes = existsSync(resolve(pending, "minutes")) ? Number(readFileSync(resolve(pending, "minutes"), "utf8")) : 0;
    if (!listParts().length) {
      // ffmpeg-static 是靜態編譯，無法解析 DNS（讀網址會 segfault），所以先把影片抓到暫存檔。
      // 抽成 16kHz 單聲道 32kbps，20 分鐘一段約 4.8MB，遠低於 Groq 25MB 上限。
      mkdirSync(tmp, { recursive: true });
      mkdirSync(pending, { recursive: true });
      const t0 = Date.now();
      const video = resolve(tmp, "video");
      const ytId = youtubeId(row.videoUrl);
      if (ytId) {
        // YouTube 有中文字幕就直接用，省一次 Groq；沒有才抓音訊
        const player = await youtubePlayer(ytId);
        const ytMinutes = Math.round(Number(player?.videoDetails?.lengthSeconds ?? 0) / 60);
        const captions = await youtubeCaptions(player).catch(() => "");
        if (captions) {
          const meta = { minutes: ytMinutes, chars: captions.replace(/\s+/g, "").length };
          writeFileSync(cache, JSON.stringify({ meta, text: captions }));
          log(`  影音 ${row.key}：YouTube 字幕 ${ytMinutes} 分鐘、${meta.chars} 字`);
          return { meta, text: captions, status: "ok" };
        }
        // player API 的音訊網址現在多半回 403（要 PO token），退回 yt-dlp（同 fetch-kol-feeds.ts 的 KOL_YTDLP）
        await youtubeAudio(player, video).catch(async (e) => {
          log(`  影音 ${row.key}：YouTube API 音訊失敗（${(e as Error).message}），改用 yt-dlp`);
          await ytDlpAudio(ytId, tmp, video);
        });
      } else {
        await downloadRanged(url, video, row.key);
      }
      const mb = statSync(video).size / 1048576;
      const err = await runFfmpeg([
        "-hide_banner", "-nostdin", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k",
        "-f", "segment", "-segment_time", "1200", "-reset_timestamps", "1", resolve(pending, "part%03d.mp3"),
      ]);
      rmSync(tmp, { recursive: true, force: true });
      const dur = err.match(/Duration: (\d+):(\d+):(\d+)/);
      minutes = dur ? Number(dur[1]) * 60 + Number(dur[2]) + Math.round(Number(dur[3]) / 60) : 0;
      writeFileSync(resolve(pending, "minutes"), String(minutes));
      log(`  影音 ${row.key}：影片 ${mb.toFixed(0)}MB、${minutes} 分鐘，下載＋抽音軌 ${Math.round((Date.now() - t0) / 1000)}s，${listParts().length} 段送 Groq`);
    } else log(`  影音 ${row.key}：用上次留下的音檔（${minutes} 分鐘）送 Groq`);
    const texts: string[] = [];
    for (const p of listParts()) texts.push(await groqTranscribe(resolve(pending, p)));
    const text = texts.join("\n");
    const meta = { minutes, chars: text.replace(/\s+/g, "").length };
    writeFileSync(cache, JSON.stringify({ meta, text }));
    return { meta, text, status: "ok" };
  } catch (e) {
    const msg = (e as Error).message;
    keepAudio = groqExhausted && listParts().length > 0;
    log(`  [warn] 影音 ${row.key} 轉文字失敗：${msg}${keepAudio ? "（音檔留到下次）" : ""}`);
    return { meta: null, text: "", status: keepAudio ? "Groq 額度已滿，下次轉" : `失敗：${msg.slice(0, 80)}` };
  } finally {
    // 影片一律刪；音檔轉完（或失敗原因不是額度）也刪，只留逐字稿
    rmSync(tmp, { recursive: true, force: true });
    if (!keepAudio) rmSync(pending, { recursive: true, force: true });
  }
}

// ───────────── 4. 市場脈絡 ─────────────

function loadContext() {
  // 月營收：revenue-history 涵蓋全部上市櫃（興櫃沒有）；有在動能名單上的再補上它的標籤（連續成長、創新高…）
  const revDir = resolve(ROOT, "data/revenue-history");
  const revFiles = existsSync(revDir) ? readdirSync(revDir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort() : [];
  // 月初只有部分公司公布上月營收（10 日截止），所以每檔取「它自己最新有資料的那個月」
  const months = revFiles.slice(-4).map((f) => readJson<{ month: string; stocks: Record<string, any> }>(resolve(revDir, f), { month: "", stocks: {} }));
  const momentum = readJson<{ entries?: any[] }>(resolve(ROOT, "data/revenue-momentum-latest.json"), {});
  const flags = new Map((momentum.entries ?? []).map((e) => [String(e.code), (e.flags ?? []) as string[]]));
  const pct = (a: number, b: number) => (b > 0 ? `${a >= b ? "+" : ""}${((a / b - 1) * 100).toFixed(0)}%` : "—");
  const revMap = new Map<string, string>();
  for (let i = months.length - 1; i >= 0; i--) {
    for (const [code, x] of Object.entries(months[i].stocks ?? {})) {
      if (revMap.has(code)) continue;
      const p = months[i - 1]?.stocks?.[code];
      const parts = [`${months[i].month} 月營收 ${Math.round(x.rev / 1000).toLocaleString()} 百萬元`, `YoY ${pct(x.rev, x.prevY)}`];
      if (p?.rev) parts.push(`MoM ${pct(x.rev, p.rev)}`);
      if (x.cumPrevY) parts.push(`累計 YoY ${pct(x.cum, x.cumPrevY)}`);
      revMap.set(code, [...parts, ...(flags.get(code) ?? [])].join("，"));
    }
  }
  const market = readJson<{ tradingDate?: string; gainers?: any[]; losers?: any[] }>(resolve(ROOT, "data/market-latest.json"), {});
  const moveMap = new Map<string, string>();
  for (const [list, label] of [[market.gainers, "漲幅"], [market.losers, "跌幅"]] as const) {
    for (const s of list ?? []) moveMap.set(String(s.code), `${market.tradingDate} ${label}前 100（${s.pct > 0 ? "+" : ""}${s.pct}%）`);
  }
  return { tradingDate: market.tradingDate, revMap, moveMap };
}

// ───────────── 5. Codex 判讀 ─────────────

function runCodex(promptFile: string, outFile: string): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(
      "codex",
      ["exec", "--ephemeral", "--color", "never", "--sandbox", "read-only", "-c", `model_reasoning_effort="${EFFORT}"`,
        "--output-schema", SCHEMA_FILE, "-o", outFile, "-m", MODEL, "-C", ROOT, "-"],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.stdin.end(readFileSync(promptFile));
    const timer = setTimeout(() => p.kill("SIGKILL"), CODEX_TIMEOUT_MS);
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 && existsSync(outFile) ? ok() : fail(new Error(`codex exit ${code}: ${err.trim().split("\n").slice(-2).join(" ")}`));
    });
  });
}

async function analyze(item: ConfResult, deckText: string, transcript: string): Promise<void> {
  const tmp = resolve(WORK_DIR, "prompts");
  const promptFile = resolve(tmp, `${item.key}.md`);
  const outFile = resolve(tmp, `${item.key}.out.json`);
  const info = {
    公司: `${item.code} ${item.name}（${MARKET_LABEL[item.market]}）`,
    日期: `${item.date} ${item.time}`,
    地點: item.place,
    擇要訊息: item.summary,
    簡報: item.deck ? `${item.deck.file}，${item.deck.pages} 頁${item.deck.imageHeavy ? "，多為圖片、文字很少" : ""}` : "無",
    影音: item.transcript ? `有逐字稿，約 ${item.transcript.minutes} 分鐘` : `無（${item.videoStatus}）`,
    最新月營收: item.context.revenue ?? "無資料（興櫃或尚未公布）",
    當日股價: item.context.move ?? "不在最近交易日漲跌幅前 100",
  };
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（以下截斷）` : s);
  writeFileSync(
    promptFile,
    [
      readFileSync(PROMPT_FILE, "utf8"),
      "## 基本資訊\n```json\n" + JSON.stringify(info, null, 1) + "\n```",
      `## 簡報文字\n<<<DECK\n${deckText ? clip(deckText, DECK_CHARS) : "（無）"}\nDECK>>>`,
      `## 影音逐字稿\n<<<TRANSCRIPT\n${transcript ? clip(transcript, TRANSCRIPT_CHARS) : "（無）"}\nTRANSCRIPT>>>`,
    ].join("\n\n"),
  );
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      rmSync(outFile, { force: true });
      const t0 = Date.now();
      await runCodex(promptFile, outFile);
      item.analysis = JSON.parse(readFileSync(outFile, "utf8"));
      item.analyzedAt = twIso();
      item.model = MODEL;
      delete item.analysisError;
      log(`  判讀 ${item.key} ${item.name}：${item.analysis!.score} 分 ${item.analysis!.verdict}（${Math.round((Date.now() - t0) / 1000)}s）`);
      break;
    } catch (e) {
      item.analysisError = (e as Error).message.slice(0, 200);
      log(`  [warn] 判讀 ${item.key} 第 ${attempt} 次失敗：${item.analysisError}`);
    }
  }
  rmSync(promptFile, { force: true });
  rmSync(outFile, { force: true });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

// ───────────── main ─────────────

const evidenceRank = (r: Pick<ConfResult, "deck" | "transcript">) => (r.deck ? 1 : 0) + (r.transcript ? 2 : 0);

/** 同時最多 n 個；先呼叫的先跑（呼叫順序＝優先順序） */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** 一場法說會目前的狀態，以及還缺什麼（頁面上「下次更新會補上」的說明） */
function refreshState(it: ConfResult, waitingDeck: boolean) {
  const missing: string[] = [];
  if (waitingDeck) missing.push("簡報還沒上傳");
  else if (!it.deck && it.deckStatus?.startsWith("下載失敗")) missing.push("簡報下載失敗，下次重試");
  if (canTranscribe(it.videoUrl) && !it.transcript) missing.push(it.videoStatus === "處理中" || !it.videoStatus ? "影音轉文字中" : `影音：${it.videoStatus}`);
  if (!it.analysis) missing.unshift(it.analysisError ? "判讀失敗，下次重試" : "尚未判讀");
  it.state = !it.analysis ? "pending" : missing.length ? "partial" : "done";
  it.pendingNote = missing.join("；");
}

function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, "utf8"));
    try {
      process.kill(pid, 0);
      return false; // 上一次還在跑
    } catch {
      // 上次異常結束留下的鎖
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => {
    try {
      if (readFileSync(LOCK_FILE, "utf8") === String(process.pid)) rmSync(LOCK_FILE);
    } catch {}
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(1));
  return true;
}

async function main() {
  for (const d of ["decks", "transcripts", "prompts", "audio-tmp", "audio-pending"]) mkdirSync(resolve(WORK_DIR, d), { recursive: true });
  mkdirSync(HISTORY_DIR, { recursive: true });
  if (!acquireLock()) {
    log("上一次的法說會判讀還在背景執行，這次不重複啟動");
    return;
  }
  const startedAt = twIso();
  const deadline = Date.now() + MAX_MINUTES * 60_000;
  const expired = () => Date.now() > deadline;
  const ctx = loadContext();
  const date = arg("--date") ?? ctx.tradingDate ?? twDate();
  const from = addDays(date, -(DAYS - 1));
  const until = addDays(date, UPCOMING_DAYS);
  const months = [...new Set([from, date, until].map((d) => d.slice(0, 7)))];
  log(`日期 ${from} ~ ${date}，即將舉行看到 ${until}；判讀模型 ${MODEL}（${EFFORT}）；最多跑 ${MAX_MINUTES} 分鐘`);

  const list = await fetchList(months);
  const histories = new Map<string, Record<string, ConfResult>>();
  const history = (ym: string) => {
    if (!histories.has(ym)) histories.set(ym, readJson(resolve(HISTORY_DIR, `${ym}.json`), {}));
    return histories.get(ym)!;
  };
  // 一覽表只查得到當月與之後（上個月回「查無資料」），所以月初那幾天，上個月底的場次從歷史補回視窗
  const fromList = new Set(list.map((r) => r.key));
  const fromHistory: ConfRow[] = months
    .flatMap((ym) => Object.values(history(ym)))
    .filter((h) => !fromList.has(h.key) && h.date >= from && h.date <= date)
    .map(({ key, code, name, market, date, time, place, summary, fileZh, fileEn, videoUrl, note }) => ({ key, code, name, market, date, time, place, summary, fileZh, fileEn, videoUrl, note }));
  // 新的日期先做：今天的法說會優先，舊的多半已經判讀過、只是在補影音
  const inWindow = [...list.filter((r) => r.date >= from && r.date <= date), ...fromHistory]
    .sort((a, b) => b.date.localeCompare(a.date) || a.code.localeCompare(b.code));
  const upcoming = list.filter((r) => r.date > date && r.date <= until).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  log(`期間內 ${inWindow.length} 場（其中 ${fromHistory.length} 場來自歷史）、未來 ${UPCOMING_DAYS} 天 ${upcoming.length} 場`);

  const newKeys: string[] = [];
  const items: ConfResult[] = inWindow.map((row) => {
    const prev = history(row.date.slice(0, 7))[row.key];
    if (!prev) newKeys.push(row.key);
    const item: ConfResult = {
      ...row,
      deck: prev?.deck ?? null,
      transcript: prev?.transcript ?? null,
      videoStatus: prev?.transcript ? "ok" : row.videoUrl ? "處理中" : "無影片",
      deckStatus: prev?.deck ? "ok" : undefined,
      context: { revenue: ctx.revMap.get(row.code) ?? null, move: ctx.moveMap.get(row.code) ?? null },
      analysis: prev?.analysis ?? null,
      analysisError: prev?.analysisError,
      analyzedAt: prev?.analyzedAt,
      model: prev?.model,
      analyzedEvidence: prev?.analyzedEvidence ?? (prev?.analysis ? evidenceRank(prev) : undefined),
      firstSeen: prev?.firstSeen ?? startedAt,
    };
    refreshState(item, false);
    return item;
  });

  let finishedAt: string | null = null;
  const flush = () => {
    for (const it of items) history(it.date.slice(0, 7))[it.key] = it;
    for (const [ym, h] of histories) writeAtomic(resolve(HISTORY_DIR, `${ym}.json`), JSON.stringify(h, null, 1));
    const sorted = [...items].sort((a, b) => (b.analysis?.score ?? 0) - (a.analysis?.score ?? 0) || b.date.localeCompare(a.date) || a.code.localeCompare(b.code));
    const latest: InvestorConfLatest = { generatedAt: twIso(), date, from, model: MODEL, run: { startedAt, finishedAt, newKeys }, items: sorted, upcoming };
    writeAtomic(OUT_LATEST, JSON.stringify(latest, null, 1));
    writeAtomic(OUT_HTML, renderInvestorConfPage(latest));
  };
  flush(); // 先出一版：清單與上次的判讀，讓主流程發佈時至少有今天的法說會名單

  // 每場各自一條：簡報 → 判讀 → 影音 → 重判。簡報（MOPS 很慢）、影音（Groq 限速）、codex 各有自己的併發上限。
  const limitDeck = limiter(4);
  const limitVideo = limiter(2);
  const limitLLM = limiter(CONCURRENCY);
  let videoSlots = MAX_VIDEOS;
  let analyzedCount = 0;
  const redone = new Set<string>();

  const maybeAnalyze = async (it: ConfResult, deckText: string, transcript: string, waitingDeck: boolean) => {
    const rank = evidenceRank(it);
    const firstRedo = REDO && !redone.has(it.key);
    const improved = !it.analysis || rank > (it.analyzedEvidence ?? 0);
    // 簡報還沒上傳、也沒有影音的，先等，不要只憑擇要訊息判讀；超過兩天還沒有才用擇要訊息
    if (NO_LLM || expired() || (!firstRedo && !improved) || (rank === 0 && waitingDeck)) return;
    redone.add(it.key);
    await limitLLM(() => analyze(it, deckText, transcript));
    if (it.analysis) {
      it.analyzedEvidence = rank;
      analyzedCount++;
    }
  };

  await Promise.all(items.map(async (it) => {
    const row = inWindow.find((r) => r.key === it.key)!;
    const recent = row.date >= addDays(date, -1);
    const wantVideo = canTranscribe(row.videoUrl) && !NO_VIDEO;
    const cachedTr = existsSync(resolve(WORK_DIR, "transcripts", `${row.key}.json`));
    const videoAllowed = wantVideo && (cachedTr || videoSlots-- > 0);
    const trP = videoAllowed && !expired()
      ? limitVideo(() => (expired() ? Promise.resolve({ meta: null, text: "", status: "超過執行時間，下次轉" }) : transcribe(row)))
      : Promise.resolve({ meta: null, text: "", status: !row.videoUrl ? "無影片" : !canTranscribe(row.videoUrl) ? "影音在公司網頁，未轉" : NO_VIDEO ? "本次未轉" : "本次轉檔數已滿，下次轉" });
    let trDone: Awaited<typeof trP> | null = null;
    void trP.then((t) => (trDone = t));

    const deck = expired() ? { meta: it.deck, text: "" } : await limitDeck(() => readDeck(row));
    it.deck = deck.meta;
    const waitingDeck = !deck.meta && !row.fileZh && !row.fileEn && recent;
    it.deckStatus = deck.meta ? "ok" : row.fileZh || row.fileEn ? "下載失敗" : "尚未上傳";
    // 影音若已經好了（有快取）就一起判讀，省一次 codex
    await sleep(0);
    const tr0 = trDone as Awaited<typeof trP> | null;
    if (tr0) {
      it.transcript = tr0.meta;
      it.videoStatus = tr0.status;
    }
    await maybeAnalyze(it, deck.text, tr0?.text ?? "", waitingDeck);
    refreshState(it, waitingDeck);
    flush();

    const tr = await trP;
    it.transcript = tr.meta;
    it.videoStatus = tr.status;
    if (tr.meta) await maybeAnalyze(it, deck.text, tr.text, waitingDeck);
    refreshState(it, waitingDeck);
    flush();
  }));

  finishedAt = twIso();
  flush();
  const pending = items.filter((x) => x.state !== "done").length;
  log(`完成：${items.length} 場（這次新增 ${newKeys.length}），本次判讀 ${analyzedCount} 次，${items.filter((x) => (x.analysis?.score ?? 0) >= 4).length} 場 ≥ 4 分${pending ? `，${pending} 場還缺資料、下次補` : ""}${expired() ? "（已達執行時間上限）" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
