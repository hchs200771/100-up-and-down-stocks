import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

export const ROOT = resolve(import.meta.dirname, "../..");
export const DATA = resolve(ROOT, "data");
export function readJson(name: string): any {
  const path = resolve(DATA, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
export function validDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("無效交易日");
  return date;
}
export function saveJson(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); }
export function running(lock: string): boolean {
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === "EPERM"; }
  } catch { return false; }
}
export async function locked(lock: string, action: () => Promise<void>) {
  mkdirSync(dirname(lock), { recursive: true });
  if (running(lock)) throw new Error("語音工作仍在執行");
  if (existsSync(lock)) unlinkSync(lock);
  writeFileSync(lock, String(process.pid), { flag: "wx" });
  try { await action(); } finally {
    if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  }
}

// 保留完整句子；單句太長時才依逗號或字元切開。
export function splitScript(script: string, max = 1500): string[] {
  if (max < 1) throw new Error("分段長度須為正數");
  const chunks: string[] = [];
  let current = "";
  for (const sentence of script.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/gu) ?? []) {
    const pieces = sentence.length > max ? sentence.match(/[^，、；,;]+[，、；,;]*|[，、；,;]+/gu) ?? [sentence] : [sentence];
    for (const piece of pieces) {
      if (current.length + piece.length > max && current) { chunks.push(current); current = ""; }
      let remaining = piece;
      while (remaining.length > max) { chunks.push(remaining.slice(0, max)); remaining = remaining.slice(max); }
      current += remaining;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function command(bin: string, args: string[], log?: string, timeout = 600_000): Promise<string> {
  const fd = log ? openSync(log, "a", 0o600) : undefined;
  try {
    return await new Promise((ok, fail) => {
      const child = spawn(bin, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd ?? "pipe", fd ?? "pipe"] });
      let output = "";
      child.stdout?.on("data", (data) => { output += data; });
      child.stderr?.on("data", (data) => { output += data; });
      let expired = false;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已結束 */ } } };
      const timer = setTimeout(() => { expired = true; kill(); }, timeout);
      const stop = () => kill();
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
      const cleanup = () => { clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop); };
      child.once("error", (e) => { cleanup(); fail(e); });
      child.once("exit", (code) => { cleanup(); code === 0 && !expired ? ok(output) : fail(new Error(`${bin}: ${expired ? "逾時" : `exit ${code}`} ${log ? `詳見 ${log}` : output.slice(-1200)}`)); });
    });
  } finally { if (fd !== undefined) closeSync(fd); }
}

// 去除來源網址與大型歷史陣列，避免把提示詞膨脹成整份資料庫。
export function compact(value: any, limit = 8): any {
  if (typeof value === "string") return value.replace(/https?:\/\/[^\s)）]+/g, "").slice(0, 800);
  if (Array.isArray(value)) return value.slice(0, limit).map((v) => compact(v, limit));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([k]) => !/url|fileZh|fileEn|transcript|weeklyCloses|archive|raw|html|inputHash/i.test(k))
    .map(([k, v]) => [k, compact(v, limit)]));
  return value;
}
export async function writeScript(promptFile: string, input: unknown, output: string, min: number, max: number) {
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const prompt = readFileSync(resolve(ROOT, promptFile), "utf8") + "\n僅使用以下資料：\n" + JSON.stringify(input);
  console.log(`[audio] 口播撰稿開始，輸入 ${prompt.length} 字元`);
  // 不讀取工作區、不呼叫工具，持倉資料僅透過本次明確提供的輸入。
  for (let attempt = 0; attempt < 2; attempt++) {
    if (existsSync(output)) unlinkSync(output);
    await command("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "-m", "gpt-6-luna", "-o", output,
      prompt + (attempt ? `\n上次字數不合，務必寫 ${min} 到 ${max} 字元。` : "")], output + ".log");
    const script = readFileSync(output, "utf8").trim();
    if (script.length >= min && script.length <= max && !/https?:\/\/|```|^#{1,6} /m.test(script)) {
      writeFileSync(output, script + "\n", { mode: 0o600 });
      console.log(`[audio] 口播稿 ${script.length} 字元：${output}`); return script;
    }
    console.warn(`[audio] 字數／格式不合（${script.length}），重試`);
  }
  throw new Error("口播稿未符合長度或純文字格式");
}
export async function synthesize(script: string, base: string, workDir: string) {
  mkdirSync(dirname(base), { recursive: true, mode: 0o700 });
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  let bin = process.env.EDGE_TTS_BIN;
  if (!bin) {
    try { await command("edge-tts", ["--version"]); bin = "edge-tts"; }
    catch { bin = resolve(homedir(), "Library/Python/3.9/bin/edge-tts"); }
  }
  const voice = process.env.EDGE_TTS_VOICE || "zh-TW-HsiaoChenNeural";
  const rate = process.env.EDGE_TTS_RATE || "+20%";
  const chunks = splitScript(script);
  const buffers: Buffer[] = [];
  try {
    for (const [i, chunk] of chunks.entries()) {
      const text = resolve(workDir, `chunk-${i}.txt`), mp3 = resolve(workDir, `chunk-${i}.mp3`);
      writeFileSync(text, chunk, { mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try {
          if (existsSync(mp3)) unlinkSync(mp3);
          await command(bin, ["--voice", voice, `--rate=${rate}`, "--file", text, "--write-media", mp3], undefined, 180_000);
          if (!statSync(mp3).size) throw new Error("空白音訊");
          buffers.push(readFileSync(mp3)); break;
        } catch (e) { if (attempt >= 2) throw e; console.warn(`[audio] 第 ${i + 1} 段重試 ${attempt + 1}`); }
      }
      console.log(`[audio] TTS ${i + 1}/${chunks.length} 完成`);
    }
    const path = base + ".mp3";
    writeFileSync(path, Buffer.concat(buffers), { mode: 0o600 });
    return { path, voice, durationSec: Math.round(statSync(path).size * 8 / 48000), bytes: statSync(path).size, type: "audio/mpeg" };
  } catch (e) {
    console.warn(`[audio] edge-tts 失敗，改用 Mei-Jia：${e}`);
    const text = resolve(workDir, "fallback.txt"), path = base + ".m4a";
    writeFileSync(text, script, { mode: 0o600 });
    await command("say", ["-v", "Mei-Jia", "-o", path, "--file-format=m4af", "-f", text]);
    let durationSec = Math.round(script.length / 4.5);
    try { const info = await command("afinfo", [path]); const m = info.match(/estimated duration:\s*([\d.]+)/); if (m) durationSec = Math.round(Number(m[1])); } catch { /* 使用字數估計 */ }
    return { path, voice: "Mei-Jia", durationSec, bytes: statSync(path).size, type: "audio/mp4" };
  }
}

export interface Episode { date: string; url: string; durationSec: number; voice: string; generatedAt: string; length: number; type: string }
export function keepEpisodes(episodes: Episode[]): Episode[] {
  return [...new Map(episodes.map((e) => [e.date, e])).values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
}
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
export function podcastRss(episodes: Episode[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>台股盤後語音版</title><link>https://hchs200771.github.io/100-up-and-down-stocks/</link>
<description>每日台股市場、族群與國際情勢 AI 語音摘要</description><language>zh-tw</language>
<itunes:author>台股盤後報告</itunes:author><itunes:explicit>false</itunes:explicit>
${keepEpisodes(episodes).map((e) => `<item><title>${xml(e.date)} 台股盤後語音版</title><description>AI 產生的市場摘要，非投資建議。</description><guid isPermaLink="false">${xml(e.date)}</guid><pubDate>${new Date(e.date + "T16:00:00+08:00").toUTCString()}</pubDate><enclosure url="${xml(e.url)}" length="${e.length}" type="${xml(e.type)}"/><itunes:duration>${e.durationSec}</itunes:duration></item>`).join("\n")}
</channel></rss>\n`;
}
