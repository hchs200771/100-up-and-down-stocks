import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Stock {
  code: string;
  name: string;
  pct: number;
}

interface MarketData {
  tradingDate: string;
  timestamp: string;
  gainers: Stock[];
  losers: Stock[];
}

type Direction = "gainer" | "loser";

interface Rule {
  category: string;
  hints: string[];
}

const outDir = resolve(process.cwd(), process.argv[2] ?? "data/tmp/group-tasks");
const marketPath = resolve(process.cwd(), "data/market-latest.json");

const STOCK_RULES: Record<string, Rule> = {
  "00715L": rule("原油ETF/油價槓桿", "原油 ETF 台股", "布蘭特原油 正2"),
  "00642U": rule("原油ETF/油價槓桿", "原油 ETF 台股", "S&P石油 ETF"),
  "00673R": rule("原油反向ETF/商品避險反轉", "原油反1 ETF", "原油反向 ETF"),
  "00653L": rule("印度/越南ETF與DR市場", "印度 ETF 台股", "富邦印度正2"),
  "9110": rule("印度/越南ETF與DR市場", "越南 DR 台股", "越南控 DR"),

  "2313": rule("低軌衛星/HDI高階PCB", "華通 低軌衛星 HDI PCB"),
  "2367": rule("低軌衛星/HDI高階PCB", "燿華 低軌衛星 HDI PCB"),
  "3491": rule("低軌衛星/微波通訊", "昇達科 低軌衛星 微波通訊"),
  "3152": rule("低軌衛星/天線通訊", "璟德 RF 低軌衛星"),
  "3419": rule("低軌衛星/天線通訊", "譁裕 天線 衛星"),
  "2485": rule("低軌衛星/天線通訊", "兆赫 衛星 通訊"),

  "3037": rule("ABF/BT載板與封裝基板", "ABF 載板 欣興"),
  "8046": rule("ABF/BT載板與封裝基板", "ABF 載板 南電"),
  "8074": rule("ABF/BT載板與封裝基板", "BT 載板 鉅橡"),
  "6213": rule("CCL/銅箔基板與高頻材料", "CCL 聯茂 AI伺服器"),
  "6672": rule("CCL/銅箔基板與高頻材料", "騰輝 CCL 高頻材料"),
  "8358": rule("CCL/銅箔基板與高頻材料", "金居 銅箔 CCL"),
  "4989": rule("CCL/銅箔基板與高頻材料", "榮科 銅箔 CCL"),
  "8021": rule("PCB鑽針/耗材", "尖點 PCB 鑽針"),
  "4927": rule("PCB/傳統板廠與HDI板", "泰鼎 PCB"),
  "6108": rule("PCB/傳統板廠與HDI板", "競國 PCB"),
  "6191": rule("PCB/傳統板廠與HDI板", "精成科 PCB"),

  "2408": memoryRule(),
  "2337": memoryRule(),
  "8299": memoryRule(),
  "2451": memoryRule(),
  "5289": memoryRule(),
  "4973": memoryRule(),
  "3260": memoryRule(),
  "8110": memoryRule(),
  "2329": memoryRule(),
  "8277": memoryRule(),
  "6485": memoryRule(),

  "2455": rule("化合物半導體/RF前端與砷化鎵", "全新 砷化鎵 RF"),
  "3105": rule("化合物半導體/RF前端與砷化鎵", "穩懋 砷化鎵 RF"),
  "3707": rule("化合物半導體/RF前端與砷化鎵", "漢磊 功率半導體"),
  "4991": rule("化合物半導體/RF前端與砷化鎵", "環宇 砷化鎵 RF"),
  "6488": rule("矽晶圓/半導體基板", "環球晶 矽晶圓"),
  "3016": rule("矽晶圓/半導體基板", "嘉晶 矽晶圓"),

  "5474": equipmentRule(),
  "6187": equipmentRule(),
  "6830": equipmentRule(),
  "8027": equipmentRule(),
  "3498": equipmentRule(),
  "6234": equipmentRule(),
  "6683": equipmentRule(),
  "8064": equipmentRule(),
  "3581": equipmentRule(),
  "5443": equipmentRule(),
  "3167": equipmentRule(),
  "6937": equipmentRule(),
  "2467": equipmentRule(),
  "6207": equipmentRule(),
  "6735": equipmentRule(),
  "7769": equipmentRule(),
  "6510": equipmentRule(),
  "6739": equipmentRule(),
  "7751": equipmentRule(),
  "6261": equipmentRule(),
  "8162": equipmentRule(),

  "3163": opticalRule(),
  "4908": opticalRule(),
  "4979": opticalRule(),
  "6451": opticalRule(),
  "3081": opticalRule(),
  "3234": opticalRule(),
  "6442": opticalRule(),
};

function rule(category: string, ...hints: string[]): Rule {
  return { category, hints };
}

function memoryRule(): Rule {
  return rule("DRAM/NAND記憶體製造與模組通路", "DRAM NAND 記憶體 台股", "記憶體報價 模組 控制IC");
}

function equipmentRule(): Rule {
  return rule("半導體設備/檢測與自動化", "半導體設備 檢測 自動化 台股", "AOI 檢測設備");
}

function opticalRule(): Rule {
  return rule("光通訊/CPO矽光子", "CPO 光通訊 矽光子 台股", "800G 光模組");
}

function inferRule(stock: Stock, direction: Direction): Rule {
  if (STOCK_RULES[stock.code]) return STOCK_RULES[stock.code];

  const name = stock.name;
  if (/光|LED|晶|鼎元|宏齊|佰鴻|光鋐|GIS/.test(name)) return rule("LED/顯示與光電", "LED 顯示 光電 台股");
  if (/化|塑|材料|樹脂|達興|聚和|德淵|華夏/.test(name)) return rule("化工/塑化與特用材料", "化工 塑化 特用材料 台股");
  if (/建|營|工|開發|愛山林|名軒/.test(name)) return rule("營建/不動產與工程承攬", "營建 不動產 工程 台股");
  if (/生|藥|醫|康|喬山|三顧/.test(name)) return rule("生技醫療/健康照護", "生技 醫療 健康照護 台股");
  if (/機|鋼|金|車|精|川湖|南俊|晟銘/.test(name)) return rule("機械/車用與金屬加工", "機械 車用 金屬加工 台股");
  if (/訊|網|通|電腦|資訊|資|創|軟|遊戲/.test(name)) return rule("資訊服務/網通與工業電腦", "資訊服務 網通 工業電腦 台股");
  if (/電|科|半|矽|晶|封|測/.test(name)) return rule("電子零組件/半導體個股整理", "電子零組件 半導體 台股");

  return direction === "gainer"
    ? rule("其他強勢個股事件整理", "台股 強勢 個股 事件")
    : rule("其他弱勢個股事件整理", "台股 弱勢 個股 事件");
}

function stockLabel(stock: Stock): string {
  return `${stock.name}(${stock.code})`;
}

function preliminaryStory(category: string, direction: Direction, members: Stock[]): string {
  const names = members.slice(0, 3).map((stock) => stock.name).join("、");
  const focus = category
    .replace(/個股事件整理/g, "題材輪動")
    .replace(/與/g, "、")
    .replace(/\//g, "、");

  if (direction === "gainer") {
    return `${focus}的市場焦點在需求升級、規格提升或報價預期改善，${names}是這組最容易被資金辨識的代表股。若短線沒有單一新聞，仍要從產業鏈位置、接單能見度、法人資金與同題材延伸來寫清楚交易邏輯。`;
  }
  return `${focus}的賣壓通常來自前波漲多後籌碼調節、報價或庫存預期降溫、長假前資金收斂，${names}是觀察這條線的代表股。故事要保留產業亮點，同時交代市場為何降低追價意願。`;
}

function slugify(input: string): string {
  return input
    .replace(/[\\/]/g, "-")
    .replace(/[()（）]/g, "")
    .replace(/[^A-Za-z0-9\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "group";
}

function buildTasks(market: MarketData, direction: Direction, stocks: Stock[]) {
  const groups = new Map<string, { rule: Rule; members: Stock[] }>();
  for (const stock of stocks) {
    const stockRule = inferRule(stock, direction);
    const existing = groups.get(stockRule.category);
    if (existing) {
      existing.members.push(stock);
    } else {
      groups.set(stockRule.category, { rule: stockRule, members: [stock] });
    }
  }

  return [...groups.values()].map(({ rule: groupRule, members }) => ({
    tradingDate: market.tradingDate,
    timestamp: market.timestamp,
    category: groupRule.category,
    direction,
    stocks: members.map(stockLabel),
    members,
    preliminaryStory: preliminaryStory(groupRule.category, direction, members),
    queryHints: [...new Set([...groupRule.hints, `${groupRule.category} 台股 盤後`])].slice(0, 6),
  }));
}

function main() {
  const market: MarketData = JSON.parse(readFileSync(marketPath, "utf8"));
  if (!market.tradingDate || !market.timestamp) {
    throw new Error("market-latest.json missing tradingDate/timestamp");
  }

  const tasks = [
    ...buildTasks(market, "gainer", market.gainers),
    ...buildTasks(market, "loser", market.losers),
  ];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  tasks.forEach((task, index) => {
    const number = String(index + 1).padStart(2, "0");
    const file = `${number}-${task.direction}-${slugify(task.category)}.json`;
    writeFileSync(join(outDir, file), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  });

  const gainers = tasks.filter((task) => task.direction === "gainer").length;
  const losers = tasks.filter((task) => task.direction === "loser").length;
  console.log(`Fallback generated ${tasks.length} task files (${gainers} gainer / ${losers} loser) in ${outDir}`);
}

main();
