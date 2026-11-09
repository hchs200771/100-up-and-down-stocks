import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA, readJson, running } from "./lib/audio.ts";

const status = readJson("audio-status.json");
console.log(status ? JSON.stringify(status, null, 2) : "尚無語音狀態");
console.log(`語音程序：${running(resolve(DATA, "tmp/audio/public.pid")) ? "執行中" : "未執行"}`);
if (status?.log) {
  try {
    const lines = readFileSync(status.log, "utf8").trimEnd().split(/\r?\n/);
    console.log(`最近 10 行紀錄（${status.log}）：\n${lines.slice(-10).join("\n")}`);
  } catch (error) { console.warn(`無法讀取語音紀錄：${error instanceof Error ? error.message : String(error)}`); }
}
