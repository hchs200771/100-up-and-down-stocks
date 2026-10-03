/** 重新發布舊的靜態子頁時，同步共用麵包屑；不重算各頁的金融資料。 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUBPAGES, renderSubpageNav } from "./lib/nav";

const siteDir = resolve(process.cwd(), process.argv[2] ?? "data/site");
for (const { file } of SUBPAGES) {
  const path = resolve(siteDir, file);
  if (!existsSync(path)) continue;
  const html = readFileSync(path, "utf8");
  if (!/<nav class="nav">[\s\S]*?<\/nav>/.test(html)) continue;
  const updated = html.replace(/<nav class="nav">[\s\S]*?<\/nav>/, renderSubpageNav(file));
  if (updated !== html) writeFileSync(path, updated);
}
