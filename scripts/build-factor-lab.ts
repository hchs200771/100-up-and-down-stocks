/**
 * 因子驗證子頁：讀 research/factor-lab/experiments.json 與 charts/<id>/*.svg，輸出 factor-lab.html。
 * 用法：node --import tsx scripts/build-factor-lab.ts [輸出路徑，預設 data/factor-lab.html]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFactorLabPage, type FactorExperiment } from "./lib/factor-lab-page";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAB = path.join(ROOT, "research/factor-lab");
const VERDICTS = ["不成立", "有條件", "成立"];

function fail(msg: string): never {
  throw new Error(`[factor-lab] ${msg}`);
}

function validate(list: unknown): FactorExperiment[] {
  if (!Array.isArray(list)) fail("experiments.json 必須是陣列");
  const ids = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const e = raw as Record<string, unknown>;
    const at = `experiments[${i}]${typeof e?.id === "string" ? ` (${e.id})` : ""}`;
    for (const k of ["id", "date", "title", "question", "verdict", "verdictNote", "summary", "method"])
      if (typeof e[k] !== "string" || !(e[k] as string).trim()) fail(`${at} 缺少文字欄位 ${k}`);
    if (!/^[\w-]+$/.test(e.id as string)) fail(`${at} id 只能用英數與 - _`);
    if (ids.has(e.id as string)) fail(`${at} id 重複`);
    ids.add(e.id as string);
    if (!VERDICTS.includes(e.verdict as string)) fail(`${at} verdict 必須是 ${VERDICTS.join("/")}`);
    for (const k of ["stats", "findings", "caveats", "nextIdeas", "charts"])
      if (e[k] !== undefined && !Array.isArray(e[k])) fail(`${at} ${k} 必須是陣列`);
    for (const s of (e.stats ?? []) as Record<string, unknown>[])
      if (typeof s?.label !== "string" || typeof s?.value !== "string") fail(`${at} stats 每項需要 label 與 value 字串`);
    for (const k of ["findings", "caveats", "nextIdeas"])
      if (((e[k] ?? []) as unknown[]).some((x) => typeof x !== "string")) fail(`${at} ${k} 必須全是字串`);
    if (e.category !== undefined && typeof e.category !== "string") fail(`${at} category 必須是字串`);
    const src = e.source as Record<string, unknown> | undefined;
    if (!src || typeof src !== "object") fail(`${at} 缺少 source`);
    if (!src.script && !src.doc) fail(`${at} source 至少要有 script 或 doc`);
    for (const k of ["script", "results", "doc"]) if (src[k] !== undefined && typeof src[k] !== "string") fail(`${at} source.${k} 必須是字串`);
    for (const c of (e.charts ?? []) as Record<string, unknown>[])
      if (typeof c?.file !== "string" || typeof c?.caption !== "string") fail(`${at} charts 每項需要 file 與 caption`);
  }
  return list as FactorExperiment[];
}

function main() {
  const out = path.resolve(process.argv[2] ?? path.join(ROOT, "data/factor-lab.html"));
  const experiments = validate(JSON.parse(fs.readFileSync(path.join(LAB, "experiments.json"), "utf8")));
  for (const e of experiments) e.charts ??= [];
  const svgs = new Map<string, string>();
  for (const e of experiments)
    for (const c of e.charts) {
      const file = path.join(LAB, "charts", e.id, c.file);
      if (!fs.existsSync(file)) fail(`${e.id}: 找不到圖檔 ${path.relative(ROOT, file)}`);
      svgs.set(`${e.id}/${c.file}`, fs.readFileSync(file, "utf8"));
    }
  const html = renderFactorLabPage(experiments, svgs);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`[factor-lab] ${experiments.length} 個實驗、${svgs.size} 張圖 → ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB)`);
}

main();
