import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Group { category: string; stocks: string[] }
interface Analysis { date?: string; gainers?: Group[]; losers?: Group[] }
interface Market { tradingDate?: string; gainers?: unknown[]; losers?: unknown[] }

const analysisPath = resolve(process.argv[2] ?? "data/analysis-latest.json");
const skeletonPath = resolve(process.argv[3] ?? "data/tmp/analysis-skeleton.json");
const marketPath = resolve(process.argv[4] ?? "data/market-latest.json");

const analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as Analysis;
const skeleton = JSON.parse(readFileSync(skeletonPath, "utf8")) as Analysis;
const market = JSON.parse(readFileSync(marketPath, "utf8")) as Market;
const errors: string[] = [];

if (!market.tradingDate || analysis.date !== market.tradingDate || skeleton.date !== market.tradingDate) {
  errors.push(`date mismatch: market=${market.tradingDate ?? "—"}, skeleton=${skeleton.date ?? "—"}, analysis=${analysis.date ?? "—"}`);
}

for (const side of ["gainers", "losers"] as const) {
  const marketCount = market[side]?.length ?? 0;
  const skeletonGroups = skeleton[side] ?? [];
  const analysisGroups = analysis[side] ?? [];
  if (marketCount > 0 && skeletonGroups.length === 0) errors.push(`${side}: market has ${marketCount} stocks but skeleton is empty`);
  if (skeletonGroups.length > 0 && analysisGroups.length === 0) errors.push(`${side}: skeleton has ${skeletonGroups.length} groups but analysis is empty`);

  const expected = new Map(skeletonGroups.map((group) => [group.category, JSON.stringify(group.stocks)]));
  const actual = new Map(analysisGroups.map((group) => [group.category, JSON.stringify(group.stocks)]));
  for (const [category, stocks] of expected) {
    if (!actual.has(category)) errors.push(`${side}: analysis missing category ${category}`);
    else if (actual.get(category) !== stocks) errors.push(`${side}: stocks changed for category ${category}`);
  }
}

if (errors.length) {
  console.error(`analysis completeness validation failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`analysis completeness ok: ${analysis.gainers?.length ?? 0} gainer / ${analysis.losers?.length ?? 0} loser groups, date ${analysis.date}`);
