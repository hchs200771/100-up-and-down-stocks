import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseStockCode } from "./score-report.ts";

/**
 * 法人買賣超按族群彙總。
 *
 * 讀 data/tmp/classification.json（當日族群結構）+ data/market-latest.json
 * （gainers/losers 每檔已含 chips：外資/投信買賣超張數與連買天數、當沖比），
 * 彙總成族群層級的籌碼摘要，寫 data/tmp/group-chips.json 並印出精簡表格。
 *
 * 用途：Step 5 寫盤後總結前跑一次，判斷起漲族群有沒有法人（尤其投信）認養、
 * 以及當沖比過高的隔日沖風險族群。
 */

interface StockChips {
  foreignNet?: number;
  trustNet?: number;
  totalNet?: number;
  foreignBuyStreak?: number;
  trustBuyStreak?: number;
}

interface MarketStock {
  code: string;
  name: string;
  chips?: StockChips;
  dayTradeRatio?: number;
}

interface Group {
  id?: string;
  category: string;
  stocks: string[];
}

interface GroupChips {
  id?: string;
  category: string;
  members: number;
  covered: number;
  foreignNet: number;
  trustNet: number;
  trustBacked: string[];
  foreignBacked: string[];
  avgDayTradeRatio: number | null;
}

/** 連買天數視為「認養」的門檻 */
const BACKED_STREAK = 3;
/** 族群平均當沖比高於此值標記隔日沖風險 */
const HOT_DAYTRADE_PCT = 30;

export function aggregateGroupChips(
  groups: Group[],
  stockByCode: Map<string, MarketStock>,
): GroupChips[] {
  return groups.map((g) => {
    let foreignNet = 0;
    let trustNet = 0;
    let covered = 0;
    const trustBacked: string[] = [];
    const foreignBacked: string[] = [];
    const dayTradeRatios: number[] = [];

    for (const entry of g.stocks) {
      const code = parseStockCode(entry);
      const stock = code ? stockByCode.get(code) : undefined;
      if (!stock) continue;
      covered++;
      const c = stock.chips;
      if (c) {
        foreignNet += c.foreignNet ?? 0;
        trustNet += c.trustNet ?? 0;
        if ((c.trustBuyStreak ?? 0) >= BACKED_STREAK) trustBacked.push(entry);
        if ((c.foreignBuyStreak ?? 0) >= BACKED_STREAK) foreignBacked.push(entry);
      }
      if (typeof stock.dayTradeRatio === "number") dayTradeRatios.push(stock.dayTradeRatio);
    }

    const avgDayTradeRatio =
      dayTradeRatios.length > 0
        ? parseFloat((dayTradeRatios.reduce((a, b) => a + b, 0) / dayTradeRatios.length).toFixed(1))
        : null;

    return {
      ...(g.id ? { id: g.id } : {}),
      category: g.category,
      members: g.stocks.length,
      covered,
      foreignNet,
      trustNet,
      trustBacked,
      foreignBacked,
      avgDayTradeRatio,
    };
  });
}

function fmtNet(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}張`;
}

function printSide(label: string, rows: GroupChips[]) {
  console.log(`\n== ${label} ==`);
  for (const r of rows) {
    const parts = [
      `${r.id ? `${r.id} ` : ""}${r.category} ${r.members}檔`,
      `外資${fmtNet(r.foreignNet)} 投信${fmtNet(r.trustNet)}`,
    ];
    if (r.trustBacked.length > 0) parts.push(`投信連買≥${BACKED_STREAK}日: ${r.trustBacked.join(", ")}`);
    if (r.foreignBacked.length > 0) parts.push(`外資連買≥${BACKED_STREAK}日: ${r.foreignBacked.length}檔`);
    if (r.avgDayTradeRatio !== null) {
      const hot = r.avgDayTradeRatio >= HOT_DAYTRADE_PCT ? " ⚠️隔日沖熱" : "";
      parts.push(`當沖均${r.avgDayTradeRatio}%${hot}`);
    }
    console.log(`- ${parts.join(" | ")}`);
  }
}

function main() {
  const cwd = process.cwd();
  const classPath = resolve(cwd, "data/tmp/classification.json");
  const marketPath = resolve(cwd, "data/market-latest.json");
  const outPath = resolve(cwd, "data/tmp/group-chips.json");

  if (!existsSync(classPath)) throw new Error(`classification.json not found: ${classPath}`);
  if (!existsSync(marketPath)) throw new Error(`market-latest.json not found: ${marketPath}`);

  const cls = JSON.parse(readFileSync(classPath, "utf8")) as { gainers?: Group[]; losers?: Group[] };
  const market = JSON.parse(readFileSync(marketPath, "utf8")) as {
    gainers?: MarketStock[];
    losers?: MarketStock[];
    stockMap?: Record<string, { chips?: StockChips; dayTradeRatio?: number }>;
  };

  const stockByCode = new Map<string, MarketStock>();
  // stockMap 覆蓋全市場，先鋪底；gainers/losers 再覆蓋（欄位相同但較完整）
  for (const [code, s] of Object.entries(market.stockMap ?? {})) {
    stockByCode.set(code, { code, name: "", chips: s.chips, dayTradeRatio: s.dayTradeRatio });
  }
  for (const s of [...(market.gainers ?? []), ...(market.losers ?? [])]) {
    stockByCode.set(s.code, s);
  }

  const out = {
    gainers: aggregateGroupChips(cls.gainers ?? [], stockByCode),
    losers: aggregateGroupChips(cls.losers ?? [], stockByCode),
  };
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  printSide("強勢族群籌碼", out.gainers);
  printSide("弱勢族群籌碼", out.losers);
  console.log(`\nWrote ${outPath}`);
}

const isMain = process.argv[1]?.endsWith("group-chips.ts") || process.argv[1]?.endsWith("group-chips.js");
if (isMain) main();
