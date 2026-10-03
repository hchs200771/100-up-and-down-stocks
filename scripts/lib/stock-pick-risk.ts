export interface StockPickRiskInput {
  dayTrade: number | null;
  pctToday: number;
  flags: { attention?: boolean; disposition?: boolean; lowLiquidity?: boolean };
  pledgeRatio?: number | null;
}

export interface StockPickRiskSignal {
  label: string;
  detail: string;
  tone: "neg";
}

/** 純函式，讓選股風險規則可獨立測試，不依賴漲跌幅前 100 名。 */
export function computeStockPickRisk(input: StockPickRiskInput): {
  deduction: number;
  signals: StockPickRiskSignal[];
} {
  let deduction = 0;
  const signals: StockPickRiskSignal[] = [];

  if (input.dayTrade !== null && input.dayTrade > 45) {
    deduction -= 14;
    signals.push({ label: "當沖過熱", detail: `當沖比 ${input.dayTrade.toFixed(0)}%，隔日沖主場`, tone: "neg" });
  } else if (input.dayTrade !== null && input.dayTrade > 35) {
    deduction -= 7;
    signals.push({ label: "當沖偏高", detail: `當沖比 ${input.dayTrade.toFixed(0)}%`, tone: "neg" });
  }
  if (input.flags.lowLiquidity) {
    deduction -= 10;
    signals.push({ label: "流動性低", detail: "日成交金額偏低，進出滑價大", tone: "neg" });
  }
  if (input.flags.attention) {
    deduction -= 5;
    signals.push({ label: "注意股", detail: "交易異常達公告門檻，波動與籌碼風險較高", tone: "neg" });
  }
  if (input.flags.disposition) {
    deduction -= 12;
    signals.push({ label: "處置股", detail: "交易受處置措施限制，不適合一般進場計畫", tone: "neg" });
  }
  if ((input.pledgeRatio ?? 0) >= 50) {
    deduction -= 8;
    signals.push({ label: "高設質風險", detail: `董監設質 ${input.pledgeRatio!.toFixed(0)}%，作為治理與融資風險而非利多`, tone: "neg" });
  }
  if (input.pctToday >= 9.5) {
    deduction -= 4;
    signals.push({ label: "今日漲停", detail: "追高風險，等回測再說", tone: "neg" });
  }
  return { deduction, signals };
}
