import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Member {
  code: string;
  name: string;
  pct: number;
}

interface GroupTask {
  tradingDate: string;
  timestamp: string;
  category: string;
  direction: "gainer" | "loser";
  stocks: string[];
  members: Member[];
  preliminaryStory?: string;
  queryHints?: string[];
}

interface OverrideRule {
  category: string;
  queryHints: string[];
  preliminaryStory: string;
}

const taskDir = resolve(process.cwd(), process.argv[2] ?? "data/tmp/group-tasks");

const OVERRIDES: Record<string, OverrideRule> = {
  "2313": {
    category: "低軌衛星/HDI高階PCB",
    queryHints: ["華通 低軌衛星 HDI PCB 台股", "華通 衛星板 高階PCB"],
    preliminaryStory:
      "華通雖屬 PCB 廠，但盤面解讀應優先放在低軌衛星與高階 HDI 板題材，不宜與一般 PCB/CCL 下游混為同一組。",
  },
  "2367": {
    category: "低軌衛星/HDI高階PCB",
    queryHints: ["燿華 低軌衛星 HDI PCB 台股", "燿華 衛星板 高階PCB"],
    preliminaryStory:
      "燿華具低軌衛星與高階 HDI 板題材，若進入漲跌幅榜，應優先視為衛星板/高階板鏈，而不是一般 PCB 分類。",
  },
  "3491": {
    category: "低軌衛星/微波通訊",
    queryHints: ["昇達科 低軌衛星 微波通訊 台股", "昇達科 衛星通訊"],
    preliminaryStory:
      "昇達科的市場定位偏低軌衛星與微波通訊，分類時應優先獨立出衛星通訊題材，避免併入一般網通或光通訊。",
  },
  "8277": memoryRule(),
  "8299": memoryRule(),
  "3260": memoryRule(),
  "4967": memoryRule(),
  "4973": memoryRule(),
  "3006": memoryRule(),
  "8110": memoryRule(),
  "6488": {
    category: "矽晶圓/半導體基板",
    queryHints: ["環球晶 矽晶圓 台股", "矽晶圓 半導體基板 景氣"],
    preliminaryStory:
      "矽晶圓屬半導體基板供應鏈，和 DRAM/NAND 記憶體模組或控制 IC 的報價邏輯不同，應獨立觀察。",
  },
};

function memoryRule(): OverrideRule {
  return {
    category: "DRAM/NAND記憶體模組與控制IC",
    queryHints: ["DRAM NAND 記憶體模組 台股", "記憶體控制IC SSD 台股", "記憶體報價 模組廠"],
    preliminaryStory:
      "記憶體模組、NAND 控制 IC 與記憶體封測的核心變數是 DRAM/NAND 報價、SSD 需求與庫存循環，應和 RF、石英、矽晶圓或一般 IC 設計拆開。",
  };
}

function stockLabel(member: Member): string {
  return `${member.name}(${member.code})`;
}

function slugify(input: string): string {
  const aliases: Record<string, string> = {
    "低軌衛星/HDI高階PCB": "leo-satellite-hdi-pcb",
    "低軌衛星/微波通訊": "leo-satellite-microwave",
    "DRAM/NAND記憶體模組與控制IC": "dram-nand-memory-controller",
    "矽晶圓/半導體基板": "silicon-wafer-substrate",
  };
  if (aliases[input]) return aliases[input];

  return input
    .toLowerCase()
    .replace(/dram/g, "dram")
    .replace(/nand/g, "nand")
    .replace(/hdi/g, "hdi")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "group";
}

function mergeHints(...hints: Array<string[] | undefined>): string[] {
  return [...new Set(hints.flatMap((items) => items ?? []))].slice(0, 6);
}

function mergeStory(category: string, direction: GroupTask["direction"], stories: Array<string | undefined>): string {
  const usefulStories = stories.filter((story): story is string => Boolean(story?.trim()));
  if (usefulStories.length === 0) {
    return direction === "gainer"
      ? `${category}的交易重點在產業需求、規格升級、報價或代表股事件，後續可沿著成分股的接單、營收與法人資金尋找最有解釋力的催化。`
      : `${category}的賣壓多半要從前波漲多後籌碼調節、報價或庫存預期、法人資金收斂與代表股事件判讀，同時保留原本產業題材的中期亮點。`;
  }
  return usefulStories[0];
}

function normalizeTask(task: GroupTask): GroupTask {
  return {
    ...task,
    stocks: task.members.map(stockLabel),
    queryHints: mergeHints(task.queryHints, [`${task.category} 台股 盤後`]),
  };
}

function regroup(direction: GroupTask["direction"], tasks: GroupTask[]): GroupTask[] {
  const output = new Map<string, GroupTask>();

  function upsert(base: GroupTask, member: Member, rule?: OverrideRule) {
    const category = rule?.category ?? base.category;
    const key = `${direction}:${category}`;
    const existing = output.get(key);

    if (!existing) {
      output.set(key, {
        tradingDate: base.tradingDate,
        timestamp: base.timestamp,
        category,
        direction,
        stocks: [stockLabel(member)],
        members: [member],
        preliminaryStory: rule?.preliminaryStory ?? base.preliminaryStory ?? "",
        queryHints: mergeHints(rule?.queryHints, base.queryHints, [`${category} 台股 盤後`]),
      });
      return;
    }

    existing.members.push(member);
    existing.stocks = existing.members.map(stockLabel);
    existing.preliminaryStory = mergeStory(category, direction, [
      existing.preliminaryStory,
      rule?.preliminaryStory,
      base.preliminaryStory,
    ]);
    existing.queryHints = mergeHints(existing.queryHints, rule?.queryHints, base.queryHints, [`${category} 台股 盤後`]);
  }

  for (const task of tasks) {
    for (const member of task.members) {
      upsert(task, member, OVERRIDES[member.code]);
    }
  }

  return [...output.values()].map(normalizeTask);
}

function main() {
  const files = readdirSync(taskDir).filter((file) => file.endsWith(".json")).sort();
  const tasks: GroupTask[] = files.map((file) => JSON.parse(readFileSync(join(taskDir, file), "utf8")));

  const refined = [
    ...regroup("gainer", tasks.filter((task) => task.direction === "gainer")),
    ...regroup("loser", tasks.filter((task) => task.direction === "loser")),
  ];

  rmSync(taskDir, { recursive: true, force: true });
  mkdirSync(taskDir, { recursive: true });

  refined.forEach((task, index) => {
    const number = String(index + 1).padStart(2, "0");
    const file = `${number}-${task.direction}-${slugify(task.category)}.json`;
    writeFileSync(join(taskDir, file), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  });

  console.log(`Refined ${files.length} task files into ${refined.length} task files in ${taskDir}`);
}

main();
