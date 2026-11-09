import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA, readJson, validDate, locked, compact, writeScript, synthesize } from "./lib/audio.ts";

export async function main() {
  const review = readJson("trade-review-latest.json");
  const date = validDate(review?.date);
  await locked(resolve(DATA, "tmp/audio/holdings.pid"), async () => {
    const heartbeat = setInterval(() => console.log("[audio-private] 本機語音製作中"), 55_000);
    try {
      const dated = (name: string) => {
        const value = readJson(name);
        if (value && value.date !== date) { console.warn(`[audio-private] ${name} 日期不同，略過`); return null; }
        return value;
      };
      const script = await writeScript("scripts/prompts/audio-holdings-writer.md", compact({ review, technical: dated("holdings-tech-latest.json"), chips: dated("holdings-chip-latest.json") }, 30), resolve(DATA, `tmp/audio/holdings-script-${date}.txt`), 900, 1600);
      const audio = await synthesize(script, resolve(DATA, `audio-private/holdings-${date}`), resolve(DATA, `tmp/audio/holdings-${date}`));
      console.log(`[audio-private] ${audio.bytes} bytes，約 ${audio.durationSec} 秒，${audio.voice}`);
      console.log(audio.path);
    } finally { clearInterval(heartbeat); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e); process.exitCode = 1; });
