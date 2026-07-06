import { type Taxonomy, normalizeCategory } from "./taxonomy.ts";

/**
 * 族群時間軸：從 analysis-history 快照建出「每個 canonical 族群哪幾天出現在強勢/弱勢榜」，
 * 並據此機械計算 stage（連1日 / 連2日 / 連3日+ / 回歸）。
 *
 * 交易日曆用「有 analysis 快照的日期」近似（一天一份報告），不依賴外部行事曆。
 */

export interface TimelineSnapshot {
  date: string;
  gainers: Array<{ category: string }>;
  losers: Array<{ category: string }>;
}

export interface CategoryTimeline {
  canonical: string;
  strongDates: string[];
  weakDates: string[];
}

export function buildGroupTimeline(
  snapshots: TimelineSnapshot[],
  taxonomy: Taxonomy,
): Map<string, CategoryTimeline> {
  const map = new Map<string, CategoryTimeline>();

  function entryFor(raw: string): CategoryTimeline {
    const { canonical } = normalizeCategory(raw, taxonomy);
    let entry = map.get(canonical);
    if (!entry) {
      entry = { canonical, strongDates: [], weakDates: [] };
      map.set(canonical, entry);
    }
    return entry;
  }

  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  for (const snap of sorted) {
    for (const g of snap.gainers ?? []) {
      const entry = entryFor(g.category);
      if (!entry.strongDates.includes(snap.date)) entry.strongDates.push(snap.date);
    }
    for (const l of snap.losers ?? []) {
      const entry = entryFor(l.category);
      if (!entry.weakDates.includes(snap.date)) entry.weakDates.push(snap.date);
    }
  }
  return map;
}

/**
 * 以 baseDate 為終點，計算該族群在強勢榜的連續天數（沿 tradingDates 往回數）。
 * baseDate 當天不在強勢榜 → 0。
 */
export function consecutiveStrongDays(
  strongDates: string[],
  tradingDates: string[],
  baseDate: string,
): number {
  const idx = tradingDates.indexOf(baseDate);
  if (idx === -1) return 0;
  const strong = new Set(strongDates);
  let streak = 0;
  for (let i = idx; i >= 0; i--) {
    if (strong.has(tradingDates[i])) streak++;
    else break;
  }
  return streak;
}

/** 回歸判定的回看視窗（交易日） */
const RETURN_LOOKBACK = 10;

/**
 * 機械 stage 標籤：
 * - 連 1 日，且近 RETURN_LOOKBACK 個交易日內曾出現過 → "回歸"（休息後二波）
 * - 連 1 日（初登場）→ "連1日"
 * - 連 2 日 → "連2日"
 * - 連 3 日以上 → "連3日+"
 * - 當天不在強勢榜 → null
 */
export function mechanicalStage(
  strongDates: string[],
  tradingDates: string[],
  baseDate: string,
): string | null {
  const streak = consecutiveStrongDays(strongDates, tradingDates, baseDate);
  if (streak === 0) return null;
  if (streak >= 3) return "連3日+";
  if (streak === 2) return "連2日";
  // streak === 1：看回看視窗內是否曾出現（不含 baseDate）
  const idx = tradingDates.indexOf(baseDate);
  const strong = new Set(strongDates);
  for (let i = idx - 1; i >= Math.max(0, idx - RETURN_LOOKBACK); i--) {
    if (strong.has(tradingDates[i])) return "回歸";
  }
  return "連1日";
}
