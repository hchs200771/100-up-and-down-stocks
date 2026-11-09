import { writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA, ROOT, readJson, validDate, saveJson, running, locked, compact, writeScript, synthesize, command, keepEpisodes, podcastRss, type Episode } from "./lib/audio.ts";

const REPO = "hchs200771/100-up-and-down-stocks";
const TAG = "audio-brief";
export async function main() {
  const index = process.argv.indexOf("--date");
  const date = validDate(index >= 0 ? process.argv[index + 1] : readJson("analysis-latest.json")?.date);
  const status = (state: "running" | "done" | "failed", message: string) => saveJson(resolve(DATA, "audio-status.json"), {
    date, state, message, updatedAt: new Date().toISOString(), log: process.env.AUDIO_LOG || "",
  });
  const publish = async () => {
    if (!process.argv.includes("--no-publish")) await command("bash", [resolve(ROOT, "scripts/publish-github-pages.sh")], resolve(DATA, `tmp/audio/publish-${date}.log`));
  };
  await locked(resolve(DATA, "tmp/audio/public.pid"), async () => {
    const heartbeat = setInterval(() => console.log("[audio] 語音製作仍在執行"), 55_000);
    try {
      status("running", "製作中");
      const analysis = readJson("analysis-latest.json");
      if (analysis?.date !== date) throw new Error("市場分析日期與要求日期不符，拒絕產生錯日節目");
      const deadline = Date.now() + 15 * 60_000;
      const deepLock = resolve(DATA, "tmp/pick-deepdive/run.pid");
      while (running(deepLock) && Date.now() < deadline) {
        console.log("[audio] 等待選股深挖（最多十五分鐘）");
        await new Promise((r) => setTimeout(r, 15_000));
      }
      if (running(deepLock)) console.warn("[audio] 深挖等待逾時，使用目前完成資料");
      const dated = (name: string) => {
        const value = readJson(name);
        if (value && value.date !== date && value.tradingDate !== date) { console.warn(`[audio] ${name} 日期不同，略過`); return null; }
        return value;
      };
      const picks = dated("stock-picks-latest.json");
      const deep = dated("pick-deepdive-latest.json");
      const conf = dated("investor-conf-latest.json");
      // 明列市場欄位，不讀取任何私人檔案；排除大型法說逐字稿及歷史紀錄。
      const briefAnalysis = (a: any) => a && ({
        headline: a.headline, verdict: a.verdict, reason: a.reason,
        guidance: a.guidance, drivers: a.drivers?.slice(0, 2), risks: a.risks?.slice(0, 2),
        keyNumbers: a.keyNumbers?.slice(0, 3), shortTerm: a.shortTerm,
        longTerm: a.longTerm, notPricedIn: a.notPricedIn?.slice(0, 1), invalidation: a.invalidation,
        catalysts: a.catalysts?.slice(-3),
      });
      const input = compact({ date,
        analysis: { date, summary: analysis.summary, gainers: analysis.gainers?.slice(0, 5), losers: analysis.losers?.slice(0, 5), intl: { summary: analysis.intl?.summary, window: analysis.intl?.window, events: analysis.intl?.events?.slice(0, 4) }, kol: analysis.kol },
        picks: picks && { date, basis: picks.basis, regimeNotes: picks.regimeNotes, long: picks.long?.slice(0, 5).map((p: any) => ({ name: p.name, reason: p.reason, plan: p.plan })), short: picks.short?.slice(0, 5).map((p: any) => ({ name: p.name, reason: p.reason, plan: p.plan })) },
        deepdive: deep && { date, items: deep.items?.slice(0, 5).map((i: any) => ({ name: i.pick?.name, status: i.status, analysis: briefAnalysis(i.analysis) })) },
        conferences: conf && { date, overview: conf.overview, items: conf.items?.filter((i: any) => i.date <= date && i.analysis).slice(0, 8).map((i: any) => ({ date: i.date, name: i.name, analysis: briefAnalysis(i.analysis) })) },
        international: dated("intl-market-latest.json"),
      }, 8);
      const script = await writeScript("scripts/prompts/audio-brief-writer.md", input, resolve(DATA, `tmp/audio/script-${date}.txt`), 2800, 4000);
      const audio = await synthesize(script, resolve(DATA, `tmp/audio/market-${date}`), resolve(DATA, `tmp/audio/public-${date}`));
      console.log(`[audio] ${audio.bytes} bytes，約 ${audio.durationSec} 秒，${audio.voice}`);
      // 先取得 Release；僅在確認不存在時建立，認證或網路錯誤直接回報。
      const releases = JSON.parse(await command("gh", ["api", `repos/${REPO}/releases?per_page=100`]));
      if (!releases.some((r: any) => r.tag_name === TAG)) {
        await command("gh", ["release", "create", TAG, "--repo", REPO, "--title", "台股盤後語音版", "--notes", "最近七集市場語音摘要。AI 產生，非投資建議。", "--latest=false"]);
      }
      await command("gh", ["release", "upload", TAG, audio.path, "--repo", REPO, "--clobber"]);
      const release = JSON.parse(await command("gh", ["api", `repos/${REPO}/releases/tags/${TAG}`]));
      const asset = release.assets.find((a: any) => a.name === basename(audio.path));
      if (!asset?.browser_download_url) throw new Error("上傳後找不到公開資產 URL");
      const episode: Episode = { date, url: asset.browser_download_url, durationSec: audio.durationSec, voice: audio.voice, generatedAt: new Date().toISOString(), length: asset.size, type: audio.type };
      const saved: Episode[] = readJson("audio-history.json") ?? [];
      // 換機或快取遺失仍可從 Release 還原既有集數，不誤刪最近七集。
      const recovered: Episode[] = release.assets.flatMap((a: any) => {
        const match = a.name.match(/^market-(\d{4}-\d{2}-\d{2})\.(mp3|m4a)$/);
        if (!match) return [];
        return [{ date: match[1], url: a.browser_download_url, durationSec: Math.round(a.size * 8 / 48000), voice: "unknown", generatedAt: a.created_at, length: a.size, type: match[2] === "mp3" ? "audio/mpeg" : "audio/mp4" }];
      });
      const history = keepEpisodes([...recovered, ...saved.filter((e) => release.assets.some((a: any) => a.browser_download_url === e.url)), episode]);
      const kept = new Set(history.map((e) => basename(new URL(e.url).pathname)));
      // 只刪除本流程的音訊資產，不碰 Release 內其他檔案。
      for (const old of release.assets) {
        if (/^market-\d{4}-\d{2}-\d{2}\.(mp3|m4a)$/.test(old.name) && !kept.has(old.name)) {
          await command("gh", ["release", "delete-asset", TAG, old.name, "--repo", REPO, "--yes"]);
        }
      }
      saveJson(resolve(DATA, "audio-history.json"), history);
      const latest = history[0];
      saveJson(resolve(DATA, "audio-latest.json"), { date: latest.date, url: latest.url, durationSec: latest.durationSec, voice: latest.voice, generatedAt: latest.generatedAt });
      status("done", `約 ${Math.round(latest.durationSec / 60)} 分鐘`);
      writeFileSync(resolve(DATA, "podcast.xml"), podcastRss(history));
      console.log(`[audio] 公開音訊：${episode.url}`);
      await publish();
    } catch (error) {
      status("failed", (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 200));
      try { await publish(); } catch (publishError) { console.warn(`[audio] 失敗狀態發佈失敗：${publishError}`); }
      throw error;
    } finally { clearInterval(heartbeat); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e); process.exitCode = 1; });
