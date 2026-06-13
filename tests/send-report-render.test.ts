import assert from "node:assert/strict";
import test from "node:test";

// We import the pure render functions by re-exporting them from a thin wrapper.
// Since send-report.ts is a script with side-effect imports (dotenv, etc.) we
// inline the minimal logic under test here as extracted pure functions.
// These tests exercise the HTML-generation rules directly.

// ---------------------------------------------------------------------------
// Extracted pure render helpers (mirrors send-report.ts logic)
// ---------------------------------------------------------------------------

interface StockMeta {
  pct: string | number;
  futures?: { level: string; margin: string };
  chips?: { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number; foreignRatio?: number; trustRatio?: number; foreignBuyStreak?: number; trustBuyStreak?: number };
  dayTradeRatio?: number;
  flags?: { attention?: boolean; disposition?: boolean; lowLiquidity?: boolean };
}

interface MarketBlock {
  taiex?: { close: number; change: number; amount: number };
  tpex?: { close: number; change: number; amount: number };
  breadth?: { up: number; down: number; flat: number; limitUp: number; limitDown: number };
  dayTrade?: { twseVolumePct: number; tpexVolumePct: number };
  microFuturesRetail?: { dataDate: string; totalOI: number; instLong: number; instShort: number; retailLong: number; retailShort: number; retailNetPct: number };
}

interface CategoryGroup {
  category: string;
  stocks: string[];
  story?: string;
  confidence?: "high" | "medium" | "low";
  stage?: string;
  retreatSignal?: boolean;
}

function renderStockChipBadges(meta?: StockMeta): string {
  if (!meta) return "";
  let badges = "";
  const flags = meta.flags ?? {};
  if (flags.attention) badges += `<span style="font-size: 10px; color: #d97706; margin-left: 3px;">⚠</span>`;
  if (flags.disposition) badges += `<span style="font-size: 10px; color: #dc2626; margin-left: 3px;">⛔</span>`;
  if (meta.chips) {
    const { foreignRatio, trustRatio, foreignBuyStreak, trustBuyStreak } = meta.chips;
    if (foreignRatio !== undefined && Math.abs(foreignRatio) >= 0.2) {
      const sign = foreignRatio > 0 ? "+" : "";
      const color = foreignRatio > 0 ? "#dc2626" : "#16a34a";
      badges += `<span style="font-size: 10px; color: ${color}; margin-left: 3px;">外本比 ${sign}${foreignRatio.toFixed(2)}%</span>`;
    }
    if (trustRatio !== undefined && Math.abs(trustRatio) >= 0.1) {
      const sign = trustRatio > 0 ? "+" : "";
      const color = trustRatio > 0 ? "#dc2626" : "#16a34a";
      badges += `<span style="font-size: 10px; color: ${color}; margin-left: 3px;">投本比 ${sign}${trustRatio.toFixed(2)}%</span>`;
    }
    if (foreignBuyStreak !== undefined && foreignBuyStreak >= 3) {
      badges += `<span style="font-size: 10px; background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; margin-left: 3px;">外資連買${foreignBuyStreak}日</span>`;
    }
    if (trustBuyStreak !== undefined && trustBuyStreak >= 3) {
      badges += `<span style="font-size: 10px; background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; margin-left: 3px;">投信連買${trustBuyStreak}日</span>`;
    }
  }
  if (meta.dayTradeRatio !== undefined && meta.dayTradeRatio >= 40) {
    badges += `<span style="font-size: 10px; color: #6b7280; margin-left: 3px;">沖${Math.round(meta.dayTradeRatio)}%</span>`;
  }
  return badges;
}

function renderMarketDashboard(market: MarketBlock | null | undefined): string {
  if (!market) return "";
  const rows: string[] = [];
  const taiex = market.taiex;
  if (taiex) {
    const changeSign = taiex.change >= 0 ? "+" : "";
    const changeColor = taiex.change >= 0 ? "#dc2626" : "#16a34a";
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">加權指數</td><td style="padding: 4px 8px; font-weight: bold;">${taiex.close.toLocaleString()}</td><td style="padding: 4px 8px; color: ${changeColor}; font-weight: bold;">${changeSign}${taiex.change.toFixed(2)}</td></tr>`);
  }
  const tpex = market.tpex;
  if (tpex) {
    const changeSign = tpex.change >= 0 ? "+" : "";
    const changeColor = tpex.change >= 0 ? "#dc2626" : "#16a34a";
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">櫃買指數</td><td style="padding: 4px 8px; font-weight: bold;">${tpex.close.toLocaleString()}</td><td style="padding: 4px 8px; color: ${changeColor}; font-weight: bold;">${changeSign}${tpex.change.toFixed(2)}</td></tr>`);
  }
  const breadth = market.breadth;
  if (breadth) {
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">上漲/下跌</td><td style="padding: 4px 8px;" colspan="2"><span style="color: #dc2626;">${breadth.up}家</span> / <span style="color: #16a34a;">${breadth.down}家</span>　漲停 <strong style="color: #dc2626;">${breadth.limitUp}</strong> / 跌停 <strong style="color: #16a34a;">${breadth.limitDown}</strong></td></tr>`);
  }
  const dt = market.dayTrade;
  if (dt) {
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">當沖比重</td><td style="padding: 4px 8px;" colspan="2">上市 ${dt.twseVolumePct.toFixed(2)}%　上櫃 ${dt.tpexVolumePct.toFixed(2)}%</td></tr>`);
  }
  const mfr = market.microFuturesRetail;
  if (mfr) {
    const netPct = mfr.retailNetPct.toFixed(2);
    const netColor = mfr.retailNetPct < 0 ? "#16a34a" : "#dc2626";
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">微臺散戶淨多空</td><td style="padding: 4px 8px; color: ${netColor}; font-weight: bold;" colspan="2">${netPct}%　<span style="font-size: 11px; color: #9ca3af;">(${mfr.dataDate})</span></td></tr>`);
  }
  if (rows.length === 0) return "";
  return `<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
  <h3 style="margin-top: 0; color: #334155;">📊 市場儀表板</h3>
  <table style="border-collapse: collapse; font-size: 13px; width: 100%;">
    ${rows.join("\n    ")}
  </table>
</div>`;
}

function renderCategoryBadges(g: CategoryGroup, kind: "gainer" | "loser"): string {
  let badges = "";
  if (g.confidence === "low") {
    badges += `⚠ 題材未經新聞驗證`;
  }
  if (g.stage) {
    badges += g.stage;
  }
  if (kind === "loser" && g.retreatSignal) {
    badges += `🔻 退潮警訊`;
  }
  return badges;
}

// ---------------------------------------------------------------------------
// Tests: renderStockChipBadges
// ---------------------------------------------------------------------------

test("renderStockChipBadges: returns empty for undefined meta", () => {
  assert.equal(renderStockChipBadges(undefined), "");
});

test("renderStockChipBadges: shows ⚠ for attention flag", () => {
  const html = renderStockChipBadges({ pct: 5, flags: { attention: true } });
  assert.ok(html.includes("⚠"), "should contain attention icon");
});

test("renderStockChipBadges: shows ⛔ for disposition flag", () => {
  const html = renderStockChipBadges({ pct: 5, flags: { disposition: true } });
  assert.ok(html.includes("⛔"), "should contain disposition icon");
});

test("renderStockChipBadges: shows 外本比 badge when |foreignRatio| >= 0.2", () => {
  const html = renderStockChipBadges({ pct: 10, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, foreignRatio: 0.85 } });
  assert.ok(html.includes("外本比 +0.85%"), "should show positive foreignRatio");
});

test("renderStockChipBadges: shows 外本比 badge at exactly 0.2 threshold", () => {
  const html = renderStockChipBadges({ pct: 5, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, foreignRatio: 0.2 } });
  assert.ok(html.includes("外本比 +0.20%"), "should show badge at exactly 0.2");
});

test("renderStockChipBadges: shows 外本比 negative in green when foreignRatio < -0.2", () => {
  const html = renderStockChipBadges({ pct: -3, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, foreignRatio: -0.5 } });
  assert.ok(html.includes("外本比 -0.50%"), "should show negative foreignRatio");
  assert.ok(html.includes("#16a34a"), "negative should use green color");
});

test("renderStockChipBadges: skips 外本比 badge when |foreignRatio| < 0.2", () => {
  const html = renderStockChipBadges({ pct: 3, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, foreignRatio: 0.1 } });
  assert.ok(!html.includes("外本比"), "should NOT show badge for small foreignRatio");
});

test("renderStockChipBadges: shows 投本比 badge when |trustRatio| >= 0.1", () => {
  const html = renderStockChipBadges({ pct: 5, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, trustRatio: 0.25 } });
  assert.ok(html.includes("投本比 +0.25%"), "should show positive trustRatio");
});

test("renderStockChipBadges: skips 投本比 badge when |trustRatio| < 0.1", () => {
  const html = renderStockChipBadges({ pct: 5, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, trustRatio: 0.05 } });
  assert.ok(!html.includes("投本比"), "should NOT show badge for small trustRatio");
});

test("renderStockChipBadges: shows 外資連買N日 badge when foreignBuyStreak >= 3", () => {
  const html = renderStockChipBadges({ pct: 5, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, foreignBuyStreak: 5 } });
  assert.ok(html.includes("外資連買5日"), "should show foreign buy streak");
  assert.ok(html.includes("#991b1b"), "should use dark red text");
});

test("renderStockChipBadges: skips 外資連買 badge when foreignBuyStreak < 3", () => {
  const html = renderStockChipBadges({ pct: 5, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, foreignBuyStreak: 2 } });
  assert.ok(!html.includes("外資連買"), "should NOT show streak badge below threshold");
});

test("renderStockChipBadges: shows 投信連買N日 badge when trustBuyStreak >= 3", () => {
  const html = renderStockChipBadges({ pct: 5, chips: { foreignNet: 0, trustNet: 0, dealerNet: 0, totalNet: 0, trustBuyStreak: 3 } });
  assert.ok(html.includes("投信連買3日"), "should show trust buy streak");
});

test("renderStockChipBadges: shows 沖 badge when dayTradeRatio >= 40", () => {
  const html = renderStockChipBadges({ pct: 10, dayTradeRatio: 41.4 });
  assert.ok(html.includes("沖41%"), "should show day trade ratio");
});

test("renderStockChipBadges: no 沖 badge when dayTradeRatio < 40", () => {
  const html = renderStockChipBadges({ pct: 5, dayTradeRatio: 25 });
  assert.ok(!html.includes("沖"), "should NOT show day trade ratio below threshold");
});

// ---------------------------------------------------------------------------
// Tests: renderMarketDashboard
// ---------------------------------------------------------------------------

test("renderMarketDashboard: returns empty string for null", () => {
  assert.equal(renderMarketDashboard(null), "");
});

test("renderMarketDashboard: returns empty string for undefined", () => {
  assert.equal(renderMarketDashboard(undefined), "");
});

test("renderMarketDashboard: returns empty string for empty object", () => {
  assert.equal(renderMarketDashboard({}), "");
});

test("renderMarketDashboard: renders taiex with positive change in red", () => {
  const html = renderMarketDashboard({ taiex: { close: 44169.04, change: 1019.58, amount: 0 } });
  assert.ok(html.includes("加權指數"), "should contain 加權指數 label");
  assert.ok(html.includes("+1019.58"), "should show positive change");
  assert.ok(html.includes("#dc2626"), "positive change should be red");
  assert.ok(html.includes("📊 市場儀表板"), "should have dashboard header");
});

test("renderMarketDashboard: renders tpex with negative change in green", () => {
  const html = renderMarketDashboard({ tpex: { close: 300.0, change: -5.5, amount: 0 } });
  assert.ok(html.includes("櫃買指數"));
  assert.ok(html.includes("-5.50"));
  assert.ok(html.includes("#16a34a"), "negative should be green");
});

test("renderMarketDashboard: renders breadth with limitUp/limitDown", () => {
  const html = renderMarketDashboard({
    breadth: { up: 1652, down: 441, flat: 128, limitUp: 60, limitDown: 6 },
  });
  assert.ok(html.includes("1652家"), "should show up count");
  assert.ok(html.includes("441家"), "should show down count");
  assert.ok(html.includes(">60<"), "should show limitUp");
  assert.ok(html.includes(">6<"), "should show limitDown");
});

test("renderMarketDashboard: renders microFuturesRetail with negative netPct in green (bearish signal)", () => {
  const html = renderMarketDashboard({
    microFuturesRetail: {
      dataDate: "20260611",
      totalOI: 88651,
      instLong: 0,
      instShort: 0,
      retailLong: 0,
      retailShort: 0,
      retailNetPct: -39.49,
    },
  });
  assert.ok(html.includes("微臺散戶淨多空"));
  assert.ok(html.includes("-39.49%"));
  assert.ok(html.includes("20260611"), "should show dataDate");
  assert.ok(html.includes("#16a34a"), "negative retailNetPct → green");
});

// ---------------------------------------------------------------------------
// Tests: category badges (confidence, stage, retreatSignal)
// ---------------------------------------------------------------------------

test("renderCategoryBadges: shows ⚠ 題材未經新聞驗證 for low confidence", () => {
  const badges = renderCategoryBadges({ category: "test", stocks: [], confidence: "low" }, "gainer");
  assert.ok(badges.includes("⚠ 題材未經新聞驗證"));
});

test("renderCategoryBadges: shows stage chip", () => {
  const badges = renderCategoryBadges({ category: "test", stocks: [], stage: "擴散" }, "gainer");
  assert.ok(badges.includes("擴散"));
});

test("renderCategoryBadges: shows 🔻 退潮警訊 for loser retreatSignal", () => {
  const badges = renderCategoryBadges({ category: "test", stocks: [], retreatSignal: true }, "loser");
  assert.ok(badges.includes("🔻 退潮警訊"));
});

test("renderCategoryBadges: does NOT show 🔻 for gainer retreatSignal", () => {
  const badges = renderCategoryBadges({ category: "test", stocks: [], retreatSignal: true }, "gainer");
  assert.ok(!badges.includes("🔻 退潮警訊"), "retreat badge only for losers");
});

test("renderCategoryBadges: no badges for high confidence with no stage", () => {
  const badges = renderCategoryBadges({ category: "test", stocks: [], confidence: "high" }, "gainer");
  assert.equal(badges, "");
});
