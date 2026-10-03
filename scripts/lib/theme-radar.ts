export interface ThemeDefinition {
  id: string;
  name: string;
  aliases: string[];
  exclude?: string[];
  tickers: string[];
}

export interface ThemeArticle {
  id: string;
  source: string;
  publishedAt: string;
  title: string;
  body: string;
  url: string;
}

export interface ThemeSignal {
  id: string;
  name: string;
  tickers: string[];
  recentShare: number;
  baselineShare: number;
  ratio: number;
  z: number;
  recentMentions: number;
  accelerating: boolean;
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const TAIPEI = 8 * 3_600_000;

export function completedWeekEnd(asOf: string): number {
  const day = Date.parse(`${asOf}T00:00:00+08:00`);
  if (!Number.isFinite(day)) throw new Error(`無效日期：${asOf}`);
  const local = new Date(day + TAIPEI);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  return day - daysSinceMonday * DAY;
}

export function matchTheme(text: string, theme: ThemeDefinition): boolean {
  const lower = text.toLocaleLowerCase();
  if (theme.exclude?.some((word) => lower.includes(word.toLocaleLowerCase()))) return false;
  return theme.aliases.some((alias) => {
    if (!alias.trim()) return false;
    if (/[^\x00-\x7f]/.test(alias)) return lower.includes(alias.toLocaleLowerCase());
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, "i").test(text);
  });
}

export function scoreThemes(
  articles: ThemeArticle[], themes: ThemeDefinition[], asOf: string,
): ThemeSignal[] {
  const end = completedWeekEnd(asOf);
  const start = end - 16 * WEEK;
  const weeks = Array.from({ length: 16 }, () => ({ total: 0 }));
  const valid = articles.filter((article) => {
    const time = Date.parse(article.publishedAt);
    return Number.isFinite(time) && time >= start && time < end;
  });
  for (const article of valid) {
    const index = Math.floor((Date.parse(article.publishedAt) - start) / WEEK);
    weeks[index].total++;
  }
  return themes.map((theme) => {
    const hits = Array(16).fill(0) as number[];
    for (const article of valid) {
      if (matchTheme(`${article.title} ${article.body}`, theme)) {
        hits[Math.floor((Date.parse(article.publishedAt) - start) / WEEK)]++;
      }
    }
    const shares = weeks.map((week, index) => week.total ? hits[index] / week.total : 0);
    const sum = (xs: number[]) => xs.reduce((total, x) => total + x, 0);
    const baselineTotal = sum(weeks.slice(0, 12).map((week) => week.total));
    const recentTotal = sum(weeks.slice(12).map((week) => week.total));
    const baselineHits = sum(hits.slice(0, 12));
    const recentMentions = sum(hits.slice(12));
    const baselineShare = baselineTotal ? baselineHits / baselineTotal : 0;
    const recentShare = recentTotal ? recentMentions / recentTotal : 0;
    const floor = 0.002;
    const ratio = (recentShare + floor) / (baselineShare + floor);
    const mean = sum(shares.slice(0, 12)) / 12;
    const variance = sum(shares.slice(0, 12).map((share) => (share - mean) ** 2)) / 12;
    const z = (recentShare - mean) / Math.max(Math.sqrt(variance), floor);
    const baselineCoverage = weeks.slice(0, 12).filter((week) => week.total > 0).length;
    const recentCoverage = weeks.slice(12).filter((week) => week.total > 0).length;
    return {
      id: theme.id, name: theme.name, tickers: theme.tickers,
      recentShare, baselineShare, ratio, z, recentMentions,
      accelerating: baselineCoverage >= 10 && recentCoverage === 4 &&
        recentMentions >= 3 && ratio >= 2 && z >= 2,
    };
  });
}

export function themesByTicker(signals: ThemeSignal[]): Map<string, ThemeSignal[]> {
  const map = new Map<string, ThemeSignal[]>();
  for (const signal of signals.filter((item) => item.accelerating)) {
    for (const ticker of signal.tickers) {
      map.set(ticker, [...(map.get(ticker) ?? []), signal]);
    }
  }
  return map;
}
