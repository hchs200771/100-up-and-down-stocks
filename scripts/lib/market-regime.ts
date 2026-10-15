export type Ma20Slope = "up" | "down" | "flat";
export type MarketRegimeColor = "green" | "yellow" | "red";

// 指數權重與燈號門檻集中管理，方便調整市場判讀規則。
const US_KEYS = ["sp500", "nasdaq", "dji", "sox"] as const;
const EQUITY_KEYS = new Set<string>([...US_KEYS, "nikkei", "kospi", "hsi", "china_adr"]);
const MACRO_KEYS = new Set(["us10y", "wti", "dxy"]);
const WEIGHTS: Readonly<Record<string, number>> = {
  sp500: 6, nasdaq: 6, dji: 6, sox: 6,
  us10y: 3, wti: 3, dxy: 1,
  nikkei: 1, kospi: 1, hsi: 1, china_adr: 1,
};
const GREEN_THRESHOLD = 65;
const YELLOW_THRESHOLD = 40;
const RED_SCORE_CAP = 39;
const US_BREADTH_BONUS = 5;

// 美股四項皆在月線上時加分；月線偏弱與核心資料缺漏限制最高燈號。

export interface MA20Fields {
  ma20?: number;
  aboveMa20?: boolean;
  ma20GapPct?: number;
  ma20Slope?: Ma20Slope;
}
export type Ma20Fields = MA20Fields;

export interface MarketRegimeIndex extends MA20Fields {
  key: string;
  name?: string;
  close?: number;
}

export interface MarketRegime {
  score: number;
  signal: MarketRegimeColor;
  conclusion: string;
  reasons: string[];
  missing: string[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Calculate the latest MA20 and its position/slope from finite closes only. */
export function computeMa20(closes: readonly (number | null | undefined)[]): MA20Fields {
  const valid = closes.filter(finite);
  if (valid.length < 20) return {};

  const latestWindow = valid.slice(-20);
  const latestMean = latestWindow.reduce((sum, close) => sum + close, 0) / 20;
  const latestClose = latestWindow[19];
  const result: MA20Fields = {
    ma20: Number(latestMean.toFixed(4)),
    aboveMa20: latestClose > latestMean,
    ma20GapPct: latestMean === 0 ? undefined : Number(((latestClose / latestMean - 1) * 100).toFixed(2)),
  };
  if (valid.length >= 25) {
    const previousWindow = valid.slice(-25, -5);
    const previousMean = previousWindow.reduce((sum, close) => sum + close, 0) / 20;
    result.ma20Slope = latestMean > previousMean ? "up" : latestMean < previousMean ? "down" : "flat";
  }
  return result;
}

const NAMES: Readonly<Record<string, string>> = {
  sp500: "S&P 500", nasdaq: "那斯達克", dji: "道瓊", sox: "費半",
  us10y: "美國 10 年債殖利率", wti: "WTI 原油", dxy: "美元指數",
  nikkei: "日經", kospi: "韓國 KOSPI", hsi: "恆生", china_adr: "中國 ADR",
};

function usable(index: MarketRegimeIndex | undefined): index is MarketRegimeIndex {
  return !!index && (typeof index.aboveMa20 === "boolean" || finite(index.ma20GapPct));
}

function above(index: MarketRegimeIndex): boolean {
  return typeof index.aboveMa20 === "boolean" ? index.aboveMa20 : (index.ma20GapPct ?? 0) > 0;
}

function description(key: string, index: MarketRegimeIndex | undefined): string {
  const name = index?.name || NAMES[key] || key;
  if (!usable(index)) return `${name}資料缺（偏離資料缺）`;
  const position = above(index) ? "在月線上" : "在月線下";
  const gap = finite(index.ma20GapPct) ? `，偏離 ${index.ma20GapPct.toFixed(2)}%` : "，偏離資料缺";
  const slope = index.ma20Slope ? `，月線${index.ma20Slope === "up" ? "上彎" : index.ma20Slope === "down" ? "下彎" : "走平"}` : "";
  return `${name}${position}${gap}${slope}`;
}

/** Score a fixed basket of global market indicators, tolerating absent inputs. */
export function computeMarketRegime(indices: readonly MarketRegimeIndex[] = []): MarketRegime {
  const byKey = new Map(indices.map((index) => [index.key, index]));
  const expected = Object.keys(WEIGHTS);
  const missing = expected.filter((key) => !usable(byKey.get(key)));
  let weighted = 0;
  let availableWeight = 0;
  for (const key of expected) {
    const index = byKey.get(key);
    if (!usable(index)) continue;
    const weight = WEIGHTS[key];
    availableWeight += weight;
    const isAbove = above(index);
    let direction: number;
    if (EQUITY_KEYS.has(key)) direction = isAbove ? 1 : -1;
    else if (MACRO_KEYS.has(key)) {
      if (index.ma20Slope === "down" || !isAbove) direction = 1;
      else if (isAbove && index.ma20Slope === "up") direction = -1;
      else direction = 0;
    } else direction = 0;
    weighted += direction * weight;
  }
  let score = availableWeight ? 50 + 50 * weighted / availableWeight : 50;
  if (US_KEYS.every((key) => usable(byKey.get(key)) && above(byKey.get(key)!))) score += US_BREADTH_BONUS;
  score = Math.max(0, Math.min(100, score));

  const usBelow = US_KEYS.filter((key) => usable(byKey.get(key)) && !above(byKey.get(key))).length;
  const allUsBelow = usBelow === US_KEYS.length;
  const soxNasdaqBelow = ["sox", "nasdaq"].every((key) => usable(byKey.get(key)) && !above(byKey.get(key)!));
  const bondNegative = usable(byKey.get("us10y")) && above(byKey.get("us10y")!) && byKey.get("us10y")!.ma20Slope === "up";
  if (allUsBelow || (soxNasdaqBelow && bondNegative)) score = Math.min(score, RED_SCORE_CAP);
  let color: MarketRegimeColor = score >= GREEN_THRESHOLD ? "green" : score >= YELLOW_THRESHOLD ? "yellow" : "red";
  if ((usBelow >= 2 || missing.some((key) => US_KEYS.includes(key as typeof US_KEYS[number]))) && color === "green") color = "yellow";

  const label = color === "green" ? "綠燈適合做多" : color === "yellow" ? "黃燈謹慎、減碼或只做強勢" : "紅燈不宜做多";
  const reasons = expected.map((key) => description(key, byKey.get(key)));
  const caution = usBelow > 0 ? "注意：部分美股指數位於月線下。" : "";
  const missingNote = missing.length ? `缺少資料：${missing.map((key) => NAMES[key]).join("、")}。` : "";
  const conclusion = `${label}；${caution}${missingNote}`;
  return { score: Number(score.toFixed(2)), signal: color, conclusion, reasons, missing };
}
