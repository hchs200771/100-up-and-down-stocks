import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Direction = "gainer" | "loser";
interface Member {
  code: string;
  name: string;
  pct: number;
}
interface Group {
  slug?: string;
  category: string;
  members: Member[];
  preliminaryStory: string;
  queryHints: string[];
}

const inputPath = resolve(process.argv[2] ?? "");
const taskDir = resolve(process.argv[3] ?? "data/tmp/group-tasks");
const expectedDirection = process.argv[4] as Direction;
if (!existsSync(inputPath)) throw new Error(`controller output missing: ${inputPath}`);
if (expectedDirection !== "gainer" && expectedDirection !== "loser") {
  throw new Error(`invalid expected direction: ${expectedDirection}`);
}

const market = JSON.parse(readFileSync(resolve("data/market-latest.json"), "utf8"));
const output = JSON.parse(readFileSync(inputPath, "utf8")) as { direction: Direction; groups: Group[] };
if (output.direction !== expectedDirection || !Array.isArray(output.groups) || output.groups.length === 0) {
  throw new Error(`controller output direction/groups invalid: ${inputPath}`);
}

const source = market[expectedDirection === "gainer" ? "gainers" : "losers"] as Member[];
const sourceByCode = new Map(source.map((item) => [String(item.code), item]));
const seen = new Set<string>();
for (const group of output.groups) {
  if (!group.category?.trim() || !group.preliminaryStory?.trim() || !Array.isArray(group.members)) {
    throw new Error(`invalid group in ${inputPath}`);
  }
  for (const member of group.members) {
    const code = String(member.code);
    if (!sourceByCode.has(code)) throw new Error(`unexpected ${expectedDirection} code: ${code}`);
    if (seen.has(code)) throw new Error(`duplicate ${expectedDirection} code: ${code}`);
    seen.add(code);
  }
}
const missing = [...sourceByCode.keys()].filter((code) => !seen.has(code));

const safeSlug = (raw: string | undefined) => {
  const slug = String(raw ?? "group")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "group";
};

mkdirSync(taskDir, { recursive: true });
// Claude/Codex 都在這裡統一排序：成分股越多代表族群共振越強；
// 同檔數保留 controller 原始次序，評分不參與分類 task 的順序。
const sortedGroups = output.groups
  .map((group, index) => ({ group, index }))
  .sort((a, b) => Number(/^其他/.test(a.group.category)) - Number(/^其他/.test(b.group.category)) || b.group.members.length - a.group.members.length || a.index - b.index)
  .map(({ group }) => group);

// Controller 偶爾只漏一兩檔。過去遇到漏股會拒絕整個方向，讓另一側繼續產報，
// 最後可能發布 gainers=[] 的半份報告。漏股不是分類整體失效：保留已完成的分類，
// 並把漏網之魚放到 deterministic 的其他事件組，後續 refine 仍可重新歸類。
if (missing.length) {
  const category = expectedDirection === "gainer"
    ? "其他強勢個股事件整理"
    : "其他弱勢個股事件整理";
  const supplement = missing.map((code) => sourceByCode.get(code)!);
  const existing = sortedGroups.find((group) => group.category === category);
  if (existing) {
    existing.members.push(...supplement);
    existing.queryHints = [...new Set([...(existing.queryHints ?? []), `${category} 台股 盤後`])].slice(0, 4);
  } else {
    sortedGroups.push({
      slug: "controller-missing-supplement",
      category,
      members: supplement,
      preliminaryStory: expectedDirection === "gainer"
        ? "這些強勢股未被 controller 納入既有產業群組，先保留為事件觀察，後續從公司公告、營收、法人資金與題材延伸確認共同驅動。"
        : "這些弱勢股未被 controller 納入既有產業群組，先保留為事件觀察，後續從公司公告、營收、法人資金與題材退潮確認共同壓力。",
      queryHints: [`${category} 台股 盤後`],
    });
  }
  console.warn(`controller omitted ${expectedDirection} codes; supplemented deterministically: ${missing.join(",")}`);
}
sortedGroups.forEach((group, index) => {
  const members = group.members.map((member) => {
    const original = sourceByCode.get(String(member.code))!;
    return { code: String(original.code), name: String(original.name), pct: Number(original.pct) };
  });
  const number = String(index + 1).padStart(2, "0");
  const task = {
    tradingDate: market.tradingDate,
    timestamp: market.timestamp,
    category: group.category.trim(),
    direction: expectedDirection,
    stocks: members.map((member) => `${member.name}(${member.code})`),
    members,
    preliminaryStory: group.preliminaryStory.trim(),
    queryHints: Array.isArray(group.queryHints) ? group.queryHints.filter(Boolean).slice(0, 4) : [],
  };
  writeFileSync(
    resolve(taskDir, `${number}-${expectedDirection}-${safeSlug(group.slug)}.json`),
    `${JSON.stringify(task, null, 2)}\n`,
    "utf8",
  );
});

console.log(`split controller output: ${sortedGroups.length} ${expectedDirection} tasks / ${sourceByCode.size} stocks${missing.length ? ` (${missing.length} supplemented)` : ""}`);
