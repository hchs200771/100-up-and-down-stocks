/** 當日全市場買賣超標準化，再以佔已發行股數比過濾小額訊號。 */
export interface StrengthChannel {
  zScore: number | null;
  capitalRatio: number | null; // 百分比，非小數比例
  significantBuy: boolean;
}

export interface InstitutionalStrength {
  foreign: StrengthChannel;
  trust: StrengthChannel;
  total: StrengthChannel;
}

export const STRENGTH_DEFAULTS = {
  minUniverse: 20,
  zThreshold: 2,
  foreignMinRatio: 0.2,
  trustMinRatio: 0.1,
  totalMinRatio: 0.2,
};

type StrengthStock = {
  code: string;
  chips?: { foreignNet: number; trustNet: number; totalNet: number };
};

export function computeInstitutionalStrength(
  stocks: StrengthStock[],
  issuedShares: Map<string, number>,
  options: Partial<typeof STRENGTH_DEFAULTS> = {},
): Map<string, InstitutionalStrength> {
  const config = { ...STRENGTH_DEFAULTS, ...options };
  if (!Number.isInteger(config.minUniverse) || config.minUniverse < 2 ||
      ![config.zThreshold, config.foreignMinRatio, config.trustMinRatio, config.totalMinRatio]
        .every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error("Invalid institutional strength thresholds");
  }
  const channels = [
    ["foreign", "foreignNet", config.foreignMinRatio],
    ["trust", "trustNet", config.trustMinRatio],
    ["total", "totalNet", config.totalMinRatio],
  ] as const;
  const result = new Map<string, InstitutionalStrength>();
  const validShares = (code: string) => {
    const shares = issuedShares.get(code);
    return Number.isFinite(shares) && shares! > 0 ? shares! : null;
  };
  for (const stock of stocks) {
    if (!stock.chips) continue;
    result.set(stock.code, {
      foreign: { zScore: null, capitalRatio: null, significantBuy: false },
      trust: { zScore: null, capitalRatio: null, significantBuy: false },
      total: { zScore: null, capitalRatio: null, significantBuy: false },
    });
  }
  for (const [channel, field, ratioThreshold] of channels) {
    // 以有股數資料的普通股為母體，排除 ETF／權證與無法計算佔股本比的資料。
    const values = stocks
      .filter((s) => validShares(s.code) !== null && Number.isFinite(s.chips?.[field]))
      .map((s) => s.chips![field]);
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const std = values.length >= config.minUniverse
      ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
      : 0;
    for (const stock of stocks) {
      if (!stock.chips) continue;
      const net = stock.chips[field];
      const shares = validShares(stock.code);
      if (shares === null || !Number.isFinite(net)) continue;
      const capitalRatio = net * 1000 / shares * 100;
      const zScore = std > 0 && Number.isFinite(std) ? (net - mean) / std : null;
      result.get(stock.code)![channel] = {
        zScore,
        capitalRatio,
        // 以未四捨五入值判斷，避免門檻附近誤報。Z-score 是相對強度，非 p-value。
        significantBuy: net > 0 && zScore !== null && zScore >= config.zThreshold &&
          capitalRatio >= ratioThreshold,
      };
    }
  }
  return result;
}

/** 共用於選股理由與報告標記，只呈現同時通過兩個門檻的訊號。 */
export function significantInstitutionalBuys(strength?: InstitutionalStrength): Array<{ label: string; detail: string }> {
  if (!strength) return [];
  const labels = { foreign: "外資", trust: "投信", total: "法人合計" };
  return (Object.keys(labels) as Array<keyof InstitutionalStrength>).flatMap((key) => {
    const c = strength[key];
    if (!c?.significantBuy || !Number.isFinite(c.zScore) || !Number.isFinite(c.capitalRatio)) return [];
    return [{ label: `${labels[key]}顯著買超`, detail: `${labels[key]}買超 Z=${c.zScore!.toFixed(2)}、佔股本 ${c.capitalRatio!.toFixed(3)}%` }];
  });
}
