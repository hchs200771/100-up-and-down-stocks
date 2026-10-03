import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const cwd = process.cwd();
const marketPath = resolve(cwd, "data/market-latest.json");
const taxonomyPath = resolve(cwd, "data/taxonomy.json");
const memoryDir = resolve(cwd, "data/memory");
const outPath = resolve(cwd, process.argv[2] ?? "data/tmp/codex-classify-input.json");

if (!existsSync(marketPath)) throw new Error(`market data missing: ${marketPath}`);
if (!existsSync(taxonomyPath)) throw new Error(`taxonomy missing: ${taxonomyPath}`);

const market = JSON.parse(readFileSync(marketPath, "utf8"));
const compactStocks = (items: unknown[]) =>
  (Array.isArray(items) ? items : []).map((item: any) => ({
    code: String(item.code),
    name: String(item.name),
    pct: Number(item.pct),
  }));

const memory = existsSync(memoryDir)
  ? readdirSync(memoryDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && name.slice(0, 10) < market.tradingDate)
      .sort()
      .slice(-3)
      .map((name) => ({ name, content: readFileSync(resolve(memoryDir, name), "utf8") }))
  : [];

const out = {
  tradingDate: market.tradingDate,
  timestamp: market.timestamp,
  gainers: compactStocks(market.gainers),
  losers: compactStocks(market.losers),
  taxonomy: JSON.parse(readFileSync(taxonomyPath, "utf8")),
  recentMemory: memory,
};

writeFileSync(outPath, `${JSON.stringify(out)}\n`, "utf8");
console.log(
  `codex classify input: ${out.gainers.length} gainers / ${out.losers.length} losers / ${memory.length} memories`,
);
