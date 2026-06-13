import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "dotenv/config";
import dotenv from "dotenv";
dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true });

interface MarketHistoryEntry {
  date: string;
  retailNetPct: number | null;
  retailNetLots?: number | null;
  taiexClose?: number | null;
  [key: string]: unknown;
}

interface ScoreBreakdown {
  trend: number; // A 趨勢基底 0-40
  timing: number; // B 進場時機 0-35
  chips: number; // C 籌碼確認 0-25
  risk: number; // D 風險扣分 -30-0
}

interface CategoryGroup {
  category: string;
  stocks: string[];
  story?: string;
  confidence?: "high" | "medium" | "low";
  stage?: "啟動" | "擴散" | "高潮" | "退潮";
  retreatSignal?: boolean;
  entryScore?: number; // 0-100 進場評分
  scoreBreakdown?: ScoreBreakdown;
  entryAction?: string; // 核心加碼 / 標準持有 / 觀察不追 / 不碰減碼
  entryRationale?: string; // 一句話說明分數來源與當前動作
}

interface StockMeta {
  pct: string | number;
  futures?: { level: string; margin: string };
  chips?: { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number; foreignRatio?: number; trustRatio?: number; foreignBuyStreak?: number; trustBuyStreak?: number };
  dayTradeRatio?: number;
  flags?: { attention?: boolean; disposition?: boolean; lowLiquidity?: boolean };
  overnightDump?: boolean;
  overnightDumpRepeat?: boolean;
}

interface MarketStock {
  code: string;
  name: string;
}

interface MarketBlock {
  taiex?: { close: number; change: number; amount: number };
  tpex?: { close: number; change: number; amount: number };
  breadth?: { up: number; down: number; flat: number; limitUp: number; limitDown: number };
  dayTrade?: { twseVolumePct: number; tpexVolumePct: number };
  microFuturesRetail?: { dataDate: string; totalOI: number; instLong: number; instShort: number; retailLong: number; retailShort: number; retailNetPct: number };
}

interface IntlIndex {
  key: string;
  name: string;
  region: string;
  close: number;
  change: number;
  pct: number;
}

interface IntlBlock {
  summary: string;
  indices: IntlIndex[];
}

interface Analysis {
  timestamp: string;
  date: string;
  stockMap?: Record<string, StockMeta>;
  gainers: CategoryGroup[];
  losers: CategoryGroup[];
  summary: string;
  longTermStrategy?: string;
  intl?: IntlBlock;
}

interface HistoryRecord {
  date: string;
  summary: string;
  gainerCategories: string[];
  loserCategories: string[];
}

interface StockLookup {
  code: string;
  name: string;
  meta?: StockMeta;
}

const HISTORY_MAX = 5;
const EMAIL_SUBJECT = "📈 台股盤後資金流向與 AI 總結";
const EMAIL_TO = "hchs200771@gmail.com";

function buildStockLookup(market: { gainers?: MarketStock[]; losers?: MarketStock[] }): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const stock of [...(market.gainers ?? []), ...(market.losers ?? [])]) {
    lookup.set(stock.name, stock.code);
  }
  return lookup;
}

function resolveStock(stockStr: string, stockMap: Record<string, StockMeta>, codeByName: Map<string, string>): StockLookup {
  const match = stockStr.match(/\((.*?)\)/);
  const rawName = stockStr.replace(/\(.*?\)/, "").trim();
  const code = match?.[1] ?? codeByName.get(rawName) ?? "";
  return {
    code,
    name: rawName,
    meta: code ? stockMap[code] : undefined,
  };
}

function renderFuturesBadge(meta?: StockMeta): string {
  if (!meta?.futures) return "";
  const label = [meta.futures.level, meta.futures.margin].filter(Boolean).join(" ");
  return `<span style="font-size: 10px; background-color: #e0e7ff; color: #4338ca; padding: 2px 4px; border-radius: 4px; margin-left: 4px;">期貨(${label})</span>`;
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
  if (meta.overnightDumpRepeat) {
    badges += `<span style="font-size: 10px; background-color: #dc2626; color: white; padding: 2px 4px; border-radius: 4px; margin-left: 3px;">隔日沖慣犯</span>`;
  } else if (meta.overnightDump) {
    badges += `<span style="font-size: 10px; background-color: #e5e7eb; color: #374151; padding: 2px 4px; border-radius: 4px; margin-left: 3px;">疑似隔日沖</span>`;
  }
  return badges;
}

function renderScorePanel(g: CategoryGroup): string {
  if (typeof g.entryScore !== "number") return "";
  const s = Math.round(g.entryScore);
  const b = g.scoreBreakdown ?? { trend: 0, timing: 0, chips: 0, risk: 0 };

  let tierBg: string, tierColor: string, tierLabel: string;
  if (s >= 85) {
    tierBg = "#dcfce7";
    tierColor = "#15803d";
    tierLabel = "核心加碼";
  } else if (s >= 70) {
    tierBg = "#dbeafe";
    tierColor = "#1d4ed8";
    tierLabel = "標準持有";
  } else if (s >= 55) {
    tierBg = "#fef9c3";
    tierColor = "#a16207";
    tierLabel = "觀察不追";
  } else {
    tierBg = "#f3f4f6";
    tierColor = "#6b7280";
    tierLabel = "不碰／減碼";
  }
  const action = g.entryAction || tierLabel;
  const barFill = Math.max(0, Math.min(100, s));

  const cell = (label: string, val: number, max: number | null, isRisk = false): string => {
    const valColor = isRisk && val < 0 ? "#dc2626" : "#1f2937";
    const maxStr = max ? `<span style="color:#9ca3af; font-size:11px;">/${max}</span>` : "";
    return `<div style="display:inline-block; text-align:center; min-width:54px; margin:0 1px;">
      <div style="font-size:11px; color:#6b7280;">${label}</div>
      <div style="font-size:15px; font-weight:bold; color:${valColor};">${val}${maxStr}</div>
    </div>`;
  };

  const rationaleHtml = g.entryRationale
    ? `<p style="margin:8px 0 0 0; font-size:12px; color:#374151; line-height:1.5;">${g.entryRationale}</p>`
    : "";

  return `<div style="background-color:${tierBg}; border:1px solid ${tierColor}; padding:10px 12px; border-radius:6px; margin-bottom:10px;">
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
      <div>
        <span style="font-size:24px; font-weight:bold; color:${tierColor};">${s}</span>
        <span style="font-size:12px; color:#6b7280;"> / 100</span>
        <span style="font-size:12px; background-color:${tierColor}; color:#fff; padding:2px 8px; border-radius:10px; margin-left:8px;">${action}</span>
      </div>
      <div style="text-align:right;">
        ${cell("趨勢", b.trend, 40)}
        ${cell("時機", b.timing, 35)}
        ${cell("籌碼", b.chips, 25)}
        ${cell("風險", b.risk, null, true)}
      </div>
    </div>
    <div style="background-color:#ffffff; border-radius:4px; height:6px; margin-top:8px; overflow:hidden;">
      <div style="width:${barFill}%; height:6px; background-color:${tierColor};"></div>
    </div>
    ${rationaleHtml}
  </div>`;
}

function renderCategoryBlock(
  g: CategoryGroup,
  stockMap: Record<string, StockMeta>,
  codeByName: Map<string, string>,
  kind: "gainer" | "loser",
): string {
  const borderColor = kind === "gainer" ? "#fee2e2" : "#dcfce7";
  const bgColor = kind === "gainer" ? "#fef2f2" : "#f0fdf4";
  const headerColor = kind === "gainer" ? "#991b1b" : "#166534";
  const chipBg = kind === "gainer" ? "#fecaca" : "#bbf7d0";
  const stockBorder = kind === "gainer" ? "#fca5a5" : "#86efac";
  const pctColor = kind === "gainer" ? "#dc2626" : "#16a34a";
  const storyLabelColor = kind === "gainer" ? "#991b1b" : "#166534";
  const storyTextColor = kind === "gainer" ? "#b91c1c" : "#15803d";
  const storyBorder = kind === "gainer" ? "#fecaca" : "#bbf7d0";
  const storyLabel =
    kind === "gainer" ? "💡 產業故事與上漲原因：" : "💡 產業故事與下跌原因：";

  // Header badges
  let headerBadges = "";
  if (g.confidence === "low") {
    headerBadges += `<span style="font-size: 11px; background-color: #e5e7eb; color: #6b7280; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">⚠ 題材未經新聞驗證</span>`;
  }
  if (g.stage) {
    headerBadges += `<span style="font-size: 11px; background-color: #e0e7ff; color: #4338ca; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">${g.stage}</span>`;
  }
  if (kind === "loser" && g.retreatSignal) {
    headerBadges += `<span style="font-size: 11px; background-color: #fef9c3; color: #92400e; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">🔻 退潮警訊</span>`;
  }

  let stocksHtml = "";
  for (const stockStr of g.stocks) {
    const { code, name, meta } = resolveStock(stockStr, stockMap, codeByName);
    const pctRaw = meta?.pct;
    const pct = pctRaw !== undefined && pctRaw !== "" ? pctRaw : "";
    const futuresHtml = renderFuturesBadge(meta);
    const chipBadges = renderStockChipBadges(meta);
    const href = code ? `https://tw.stock.yahoo.com/quote/${code}.TW/technical-analysis` : "#";
    const codeHtml = code ? `<span style="color: #6b7280; font-size: 12px;">${code}</span>` : "";
    const pctHtml = pct !== "" ? `<span style="color: ${pctColor}; font-weight: bold; margin-left: 4px;">${pct}</span>` : "";
    stocksHtml += `<a href="${href}" target="_blank" style="text-decoration: none; display: inline-block; background-color: white; border: 1px solid ${stockBorder}; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
      <strong style="color: #1f2937;">${name}</strong> ${codeHtml}
      ${pctHtml}
      ${futuresHtml}${chipBadges}
    </a>`;
  }

  const storyHtml = g.story
    ? `<div style="background-color: ${bgColor}; padding: 10px; border-radius: 6px; border: 1px solid ${storyBorder};">
        <strong style="color: ${storyLabelColor}; font-size: 14px;">${storyLabel}</strong>
        <p style="margin: 5px 0 0 0; font-size: 14px; color: ${storyTextColor}; line-height: 1.6;">${g.story}</p>
      </div>`
    : "";

  return `<div style="border: 1px solid ${borderColor}; background-color: ${bgColor}; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
    <h4 style="margin-top: 0; font-size: 16px; color: ${headerColor}; display: flex; align-items: center; flex-wrap: wrap;">
      <span style="background-color: ${chipBg}; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 8px;">${g.stocks.length}檔</span>
      ${g.category}${headerBadges}
    </h4>
    ${kind === "gainer" ? renderScorePanel(g) : ""}
    <div style="margin-bottom: 10px;">${stocksHtml}</div>
    ${storyHtml}
  </div>`;
}

/**
 * Render a retail net long/short trend chart for the last ~40 trading days.
 * Returns empty string if fewer than 2 data points have retailNetLots.
 *
 * Email-safe: CSS diverging bar chart (Y-axis in 萬口).
 * Web-only: SVG dual-axis overlay (retail bars + TAIEX line).
 */
export function renderRetailTrend(history: MarketHistoryEntry[]): string {
  const points = history
    .filter((h) => h.retailNetLots !== null && h.retailNetLots !== undefined)
    .slice(-40);

  if (points.length < 2) return "";

  const lotsValues = points.map((p) => p.retailNetLots as number);
  const maxAbsLots = Math.max(...lotsValues.map(Math.abs), 1);

  // Y-axis tick values in lots (nice round numbers in 萬口)
  // Pick ticks at approximately maxAbsLots, maxAbsLots/2, 0, -maxAbsLots/2, -maxAbsLots
  const tickUnit = (() => {
    const wan = maxAbsLots / 10000;
    if (wan >= 4) return 10000;
    if (wan >= 2) return 5000;
    if (wan >= 1) return 2000;
    return 1000;
  })();
  const maxTick = Math.ceil(maxAbsLots / tickUnit) * tickUnit;
  const halfTick = Math.round(maxTick / 2 / tickUnit) * tickUnit;

  function fmtWan(lots: number): string {
    return (lots / 10000).toFixed(1) + "萬";
  }

  const firstDate = points[0].date.slice(5);
  const lastDate = points[points.length - 1].date.slice(5);
  const lastLots = lotsValues[lotsValues.length - 1];
  const lastPct = points[points.length - 1].retailNetPct;
  const lastColor = lastLots >= 0 ? "#dc2626" : "#16a34a";
  const lastSign = lastLots >= 0 ? "+" : "";
  const lastLotsWan = fmtWan(Math.abs(lastLots));
  const pctLabel = lastPct !== null && lastPct !== undefined ? ` (${lastPct >= 0 ? "+" : ""}${(lastPct as number).toFixed(2)}%)` : "";
  const direction = lastLots >= 0 ? "散戶淨多" : "散戶淨空";

  // Email-visible text stat (Gmail strips the SVG overlay below, so keep a plain line)
  const statLine = `<div style="font-size:12px; margin:6px 0; padding:6px 8px; background:#ffffff; border:1px solid #e2e8f0; border-radius:6px;">
    最新（${lastDate}）：<strong style="color:${lastColor};">${direction} ${lastSign}${lastLotsWan}口${pctLabel}</strong>
    <span style="color:#9ca3af; margin-left:6px;">近${points.length}日 ${firstDate}~${lastDate}</span>
  </div>`;

  // ---- SVG dual-axis overlay (web only; Gmail strips SVG) ----
  const svgW = 540;
  const svgH = 160;
  const padL = 48; // left axis
  const padR = 52; // right axis (TAIEX)
  const padT = 16;
  const padB = 20;
  const innerW = svgW - padL - padR;
  const innerH = svgH - padT - padB;

  const lotsMax = maxTick;
  const lotsMin = -maxTick;
  const lotsSpan = lotsMax - lotsMin || 1;

  function xSvg(i: number): number {
    if (points.length === 1) return padL + innerW / 2;
    return padL + (i / (points.length - 1)) * innerW;
  }
  function ySvgLots(v: number): number {
    return padT + innerH - ((v - lotsMin) / lotsSpan) * innerH;
  }
  const zeroYSvg = ySvgLots(0);

  // Bars (SVG rects) - retail lots
  const barW = Math.max(2, Math.floor(innerW / points.length) - 1);
  const svgBars = points.map((p, i) => {
    const val = p.retailNetLots as number;
    const x = xSvg(i) - barW / 2;
    const yTop = val >= 0 ? ySvgLots(val) : zeroYSvg;
    const h = Math.abs(ySvgLots(val) - zeroYSvg);
    const col = val >= 0 ? "#dc2626" : "#16a34a";
    return `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW}" height="${Math.max(1, h).toFixed(1)}" fill="${col}" fill-opacity="0.7"/>`;
  }).join("");

  // Left Y-axis (lots) ticks
  const leftTicks = [-maxTick, -halfTick, 0, halfTick, maxTick].map((v) => {
    const y = ySvgLots(v).toFixed(1);
    const label = v === 0 ? "0" : `${v >= 0 ? "+" : ""}${fmtWan(v)}`;
    return `<line x1="${padL - 4}" y1="${y}" x2="${padL}" y2="${y}" stroke="#94a3b8" stroke-width="1"/>
<text x="${padL - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#64748b">${label}</text>`;
  }).join("\n");

  // TAIEX line (right axis)
  const taiexPoints = points
    .map((p, i) => ({ i, v: p.taiexClose as number | null | undefined }))
    .filter((pt) => pt.v !== null && pt.v !== undefined) as Array<{ i: number; v: number }>;

  let svgTaiex = "";
  if (taiexPoints.length >= 2) {
    const taiexMin = Math.min(...taiexPoints.map((t) => t.v));
    const taiexMax = Math.max(...taiexPoints.map((t) => t.v));
    const taiexSpan = taiexMax - taiexMin || 1;
    // Pad 5% top/bottom for aesthetics
    const taiexLo = taiexMin - taiexSpan * 0.05;
    const taiexHi = taiexMax + taiexSpan * 0.05;
    const taiexRange = taiexHi - taiexLo;

    function ySvgTaiex(v: number): number {
      return padT + innerH - ((v - taiexLo) / taiexRange) * innerH;
    }

    // Build polyline path (skip gaps)
    const linePoints = taiexPoints.map((pt) =>
      `${xSvg(pt.i).toFixed(1)},${ySvgTaiex(pt.v).toFixed(1)}`
    ).join(" ");
    svgTaiex = `<polyline points="${linePoints}" fill="none" stroke="#4f46e5" stroke-width="1.8" stroke-linejoin="round"/>`;

    // Right Y-axis (TAIEX) — 3 ticks
    const taiexTickValues = [taiexLo, (taiexLo + taiexHi) / 2, taiexHi];
    const rightTicks = taiexTickValues.map((v) => {
      const y = ySvgTaiex(v).toFixed(1);
      // Show actual nice value
      const label = Math.round(v).toLocaleString();
      return `<line x1="${svgW - padR}" y1="${y}" x2="${svgW - padR + 4}" y2="${y}" stroke="#94a3b8" stroke-width="1"/>
<text x="${svgW - padR + 6}" y="${y}" text-anchor="start" dominant-baseline="middle" font-size="9" fill="#4f46e5">${label}</text>`;
    }).join("\n");

    svgTaiex += `\n${rightTicks}`;
    // Right axis label
    svgTaiex += `\n<text x="${svgW - 4}" y="${padT + innerH / 2}" text-anchor="middle" dominant-baseline="middle" font-size="9" fill="#4f46e5" transform="rotate(-90 ${svgW - 4} ${padT + innerH / 2})">加權指數</text>`;
  }

  // Zero line
  const zeroLine = `<line x1="${padL}" y1="${zeroYSvg.toFixed(1)}" x2="${svgW - padR}" y2="${zeroYSvg.toFixed(1)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,2"/>`;

  // Legend
  const legendY = svgH - 6;
  const legend = `<rect x="${padL}" y="${legendY - 8}" width="10" height="8" fill="#dc2626" fill-opacity="0.7"/>
<text x="${padL + 13}" y="${legendY}" font-size="9" fill="#64748b">散戶淨多空（萬口）</text>
<line x1="${padL + 100}" y1="${legendY - 4}" x2="${padL + 116}" y2="${legendY - 4}" stroke="#4f46e5" stroke-width="1.8"/>
<text x="${padL + 119}" y="${legendY}" font-size="9" fill="#4f46e5">加權指數</text>`;

  const svgDual = `<div style="margin-top:8px; overflow-x:auto;">
    <svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="max-width:100%; overflow:visible;">
      ${svgBars}
      ${zeroLine}
      ${leftTicks}
      ${svgTaiex}
      ${legend}
    </svg>
  </div>`;

  // Footer link (for email readers to jump to web)
  const footerLink = `<div style="font-size:11px; color:#94a3b8; margin-top:6px; text-align:center;">
    <a href="https://daily-stock-report-coral.vercel.app" style="color:#4f46e5;">看完整互動圖表（含加權指數疊圖）→</a>
  </div>`;

  return `<div style="background-color:#f8fafc; border:1px solid #e2e8f0; padding:12px 15px; border-radius:8px; margin-top:10px; margin-bottom:0;">
    <div style="font-size:12px; font-weight:bold; color:#334155; margin-bottom:4px;">微臺散戶淨多空趨勢（近${points.length}日，淨口數）</div>
    <div style="font-size:11px; color:#6b7280; margin-bottom:6px;">正值=散戶偏多（紅），負值=散戶偏空（綠）；單位：萬口</div>
    ${statLine}
    ${svgDual}
    ${footerLink}
  </div>`;
}

function renderMarketDashboard(market: MarketBlock | null | undefined, retailHistory?: MarketHistoryEntry[]): string {
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

  const trendHtml = retailHistory ? renderRetailTrend(retailHistory) : "";

  return `<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
  <h3 style="margin-top: 0; color: #334155;">📊 市場儀表板</h3>
  <table style="border-collapse: collapse; font-size: 13px; width: 100%;">
    ${rows.join("\n    ")}
  </table>
  ${trendHtml}
</div>`;
}

function renderLegend(): string {
  const item = (badge: string, desc: string) =>
    `<div style="margin-bottom: 6px; display: flex; align-items: flex-start; gap: 6px;">${badge}<span style="color: #64748b;">${desc}</span></div>`;

  return `<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
  <h3 style="margin-top: 0; color: #334155; font-size: 14px;">🔖 圖例說明</h3>
  <div style="font-size: 12px; line-height: 1.6;">
    ${item(`<span style="background-color: #e0e7ff; color: #4338ca; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">期貨(級距N XX%)</span>`, "個股有期貨合約；級距=保證金級距，%=原始保證金率")}
    ${item(`<span style="color: #dc2626; font-size: 11px;">外本比 +X%</span> / <span style="color: #16a34a; font-size: 11px;">外本比 −X%</span>`, "外資買賣超佔已發行股數比例（+買超紅、−賣超綠；顯示門檻 ≥ 0.2%）")}
    ${item(`<span style="color: #dc2626; font-size: 11px;">投本比 +X%</span> / <span style="color: #16a34a; font-size: 11px;">投本比 −X%</span>`, "投信買賣超佔已發行股數比例（與外本比同義，投信版；顯示門檻 ≥ 0.1%）")}
    ${item(`<span style="background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; font-size: 10px;">外資連買N日</span> / <span style="background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; font-size: 10px;">投信連買N日</span>`, "法人連續 ≥ 3 日淨買，吸籌訊號（含今日，今日若非淨買則不顯示）")}
    ${item(`<span style="color: #6b7280; font-size: 11px;">沖X%</span>`, "當日當沖佔成交量比例（≥40% 才標，代表投機/隔日沖盤偏多）")}
    ${item(`<span style="color: #d97706; font-size: 11px;">⚠</span>`, "注意股")}
    ${item(`<span style="color: #dc2626; font-size: 11px;">⛔</span>`, "處置股")}
    ${item(`<span style="background-color: #fef9c3; color: #92400e; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">🔻 退潮警訊</span>`, "前幾日強勢族群今天落入弱勢榜（換手/退潮）")}
    ${item(`<span style="background-color: #e5e7eb; color: #6b7280; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">⚠ 題材未經新聞驗證</span>`, "該族群，因為沒有找到新聞，而是用 AI 模型裡的產業資料做推論，所以信心度比較低")}
    ${item(`<span style="background-color: #e0e7ff; color: #4338ca; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">啟動／擴散／高潮／退潮</span>`, "族群資金階段：依族群連續性＋法人買賣方向＋量能/當沖/退潮訊號綜合判斷（非精密公式）。啟動=剛進場龍頭先動；擴散=連日且成員增加；高潮=補漲股噴出、當沖飆高或法人開始調節；退潮=龍頭轉弱、補漲取代龍頭")}
    ${item(`<span style="background-color: #e5e7eb; color: #374151; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">疑似隔日沖</span>`, "昨漲停今爆當沖收黑的投機出貨足跡")}
    ${item(`<span style="background-color: #dc2626; color: white; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">隔日沖慣犯</span>`, "近期重複出現的隔日沖出貨足跡")}
  </div>
</div>`;
}

function renderScoringRubric(): string {
  const axis = (name: string, range: string, desc: string) =>
    `<div style="margin-bottom: 6px;"><span style="font-weight:bold; color:#1f2937;">${name}</span> <span style="color:#9ca3af;">${range}</span><br><span style="color:#64748b;">${desc}</span></div>`;
  const tier = (badge: string, desc: string) =>
    `<div style="margin-bottom: 4px;">${badge} <span style="color:#64748b;">${desc}</span></div>`;
  const chip = (bg: string, color: string, label: string) =>
    `<span style="background-color:${bg}; color:${color}; padding:1px 6px; border-radius:10px; font-size:11px; white-space:nowrap;">${label}</span>`;

  return `<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
  <h3 style="margin-top: 0; color: #334155; font-size: 14px;">🧮 進場評分說明（強勢族群，0-100）</h3>
  <p style="font-size: 12px; color: #64748b; line-height: 1.6; margin: 0 0 10px 0;">分數＝<strong>現在進場的 risk／reward</strong>，不是今天多強。剛起漲、上檔大下檔小→高分；漲多進入高潮→低分。四軸相加＝總分。</p>
  <div style="font-size: 12px; line-height: 1.5;">
    ${axis("趨勢", "0–40", "長線題材夠不夠硬：AI 基建、記憶體循環、先進封裝=高；補漲、單一事件、ETF=低")}
    ${axis("時機", "0–35", "漲潮退潮階段，越早進場分越高。<strong>依榜單連續性＋籌碼判定，不看技術線型</strong>：啟動＝連續上榜≤1天、法人帶龍頭先動、尚未擴散；擴散＝連2天以上、成員增加或全面走強；高潮＝當沖飆高／投機股多／價漲但法人卻賣（過熱，是減碼點）；退潮＝前幾日強勢今天落入弱勢榜")}
    ${axis("籌碼", "0–25", "法人是否真錢背書：外資＋投信同向買、龍頭先動加分")}
    ${axis("風險", "−30–0", "投機假象扣分：當沖比高、投機股多、注意／處置／低流動、隔日沖")}
  </div>
  <div style="font-size: 12px; line-height: 1.6; margin-top: 10px; border-top: 1px solid #e2e8f0; padding-top: 8px;">
    ${tier(chip("#dcfce7", "#15803d", "85+ 核心加碼"), "趨勢好＋剛啟動＋法人買，優先放錢")}
    ${tier(chip("#dbeafe", "#1d4ed8", "70–84 標準持有"), "主升段、可續抱或加碼")}
    ${tier(chip("#fef9c3", "#a16207", "55–69 觀察不追"), "等回測或擴散驗證再進")}
    ${tier(chip("#f3f4f6", "#6b7280", "<55 不碰／減碼"), "高潮、退潮或純投機")}
  </div>
</div>`;
}

function renderIntl(intl: IntlBlock | null | undefined): string {
  if (!intl) return "";
  const { summary, indices } = intl;
  if (!summary && (!indices || indices.length === 0)) return "";

  let tableHtml = "";
  if (indices && indices.length > 0) {
    // 依出現順序保留 region 分組，每個 region 一列標題 + 各標的。
    const order: string[] = [];
    const byRegion = new Map<string, IntlIndex[]>();
    for (const idx of indices) {
      if (!byRegion.has(idx.region)) {
        byRegion.set(idx.region, []);
        order.push(idx.region);
      }
      byRegion.get(idx.region)!.push(idx);
    }
    const rows: string[] = [];
    for (const region of order) {
      const items = byRegion.get(region)!;
      const cells = items
        .map((i) => {
          const up = i.pct >= 0;
          const color = up ? "#dc2626" : "#16a34a";
          const sign = up ? "+" : "";
          return `<span style="display:inline-block; margin:0 10px 4px 0; white-space:nowrap;"><span style="color:#6b7280;">${i.name}</span> <strong>${i.close.toLocaleString()}</strong> <span style="color:${color}; font-weight:bold;">${sign}${i.pct.toFixed(2)}%</span></span>`;
        })
        .join("");
      rows.push(
        `<tr><td style="padding:4px 8px; color:#6b7280; vertical-align:top; white-space:nowrap;">${region}</td><td style="padding:4px 8px;">${cells}</td></tr>`,
      );
    }
    tableHtml = `<table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:${summary ? "10px" : "0"};"><tbody>${rows.join("")}</tbody></table>`;
  }

  const summaryHtml = summary
    ? `<p style="line-height:1.6; margin:0;">${summary.replace(/\n/g, "<br>")}</p>`
    : "";

  return `<div style="background-color:#f0f9ff; border:1px solid #bae6fd; padding:15px; border-radius:8px; margin-bottom:20px;">
      <h3 style="margin-top:0; color:#0369a1;">🌐 國際情勢</h3>
      ${tableHtml}
      ${summaryHtml}
    </div>`;
}

function renderHtml(a: Analysis, stockMap: Record<string, StockMeta>, codeByName: Map<string, string>, market?: MarketBlock | null, retailHistory?: MarketHistoryEntry[]): string {
  const gainersHtml = a.gainers.map((g) => renderCategoryBlock(g, stockMap, codeByName, "gainer")).join("");
  const losersHtml = a.losers.map((g) => renderCategoryBlock(g, stockMap, codeByName, "loser")).join("");
  const longTermStrategyHtml = a.longTermStrategy
    ? `<div style="background-color: #eef6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1d4ed8;">🧭 長線策略與進出場</h3>
      <p style="line-height: 1.7; margin-bottom: 0; color: #1e3a8a;">${a.longTermStrategy.replace(/\n/g, "<br>")}</p>
    </div>`
    : "";
  const marketDashboardHtml = renderMarketDashboard(market, retailHistory);
  const intlHtml = renderIntl(a.intl);
  const legendHtml = renderLegend();
  const rubricHtml = renderScoringRubric();

  const summaryHtml = `<div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1f2937;">📝 盤後總結</h3>
      <p style="line-height: 1.6; margin-bottom: 0;">${a.summary.replace(/\n/g, "<br>")}</p>
    </div>`;

  // 左欄：只放族群焦點；右欄 sidebar：總結、國際、台股儀表板、長線策略，最下面才是圖例與評分說明。
  const leftCol = `
    <h3 style="color: #dc2626; margin-top: 0;">🔥 強勢焦點 (量大優先)</h3>
    ${gainersHtml}
    <h3 style="color: #16a34a; margin-top: 30px;">🧊 弱勢焦點 (量大優先)</h3>
    ${losersHtml}`;

  const rightCol = `
    ${summaryHtml}
    ${intlHtml}
    ${marketDashboardHtml}
    ${longTermStrategyHtml}
    ${legendHtml}
    ${rubricHtml}`;

  // 兩欄：左 6 : 右 4，左右留白縮小（≈3%）。
  return `<div style="font-family: sans-serif; max-width: 1500px; margin: 0 auto; color: #333; padding: 0 3%;">
    <h2 style="color: #4f46e5; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📈 台股盤後資金流向與 AI 總結 (${a.timestamp})</h2>
    <table role="presentation" style="width: 100%; border-collapse: collapse; table-layout: fixed;"><tbody><tr>
      <td style="vertical-align: top; width: 60%; padding-right: 28px;">${leftCol}</td>
      <td style="vertical-align: top; width: 40%;">${rightCol}</td>
    </tr></tbody></table>
    <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px;">
      Generated via Claude Code workflow
    </div>
  </div>`;
}

function updateHistory(a: Analysis): void {
  const historyPath = resolve(process.cwd(), "data/history.json");
  let history: HistoryRecord[] = [];
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(readFileSync(historyPath, "utf-8"));
    } catch (e) {
      console.warn("history.json unreadable, starting fresh");
    }
  }
  const record: HistoryRecord = {
    date: a.date,
    summary: a.summary,
    gainerCategories: a.gainers.map((g) => g.category),
    loserCategories: a.losers.map((g) => g.category),
  };
  const filtered = history.filter((h) => h.date !== a.date);
  filtered.unshift(record);
  const trimmed = filtered.slice(0, HISTORY_MAX);
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, JSON.stringify(trimmed, null, 2), "utf-8");
  console.log(`Updated history (${trimmed.length} records) at ${historyPath}`);
}

async function sendEmail(html: string): Promise<void> {
  const url = process.env.GAS_WEBHOOK_URL;
  if (!url) {
    throw new Error("GAS_WEBHOOK_URL env var is not set");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      to: EMAIL_TO,
      subject: EMAIL_SUBJECT,
      htmlBody: html,
    }),
  });
  if (!res.ok) {
    throw new Error(`GAS webhook returned ${res.status}: ${await res.text()}`);
  }
  console.log(`Email webhook responded ${res.status}`);
}

async function main() {
  const inputPath = process.argv[2] ?? "data/analysis-latest.json";
  const resolved = resolve(process.cwd(), inputPath);
  if (!existsSync(resolved)) {
    console.error(`Analysis file not found: ${resolved}`);
    process.exit(1);
  }
  const analysis: Analysis = JSON.parse(readFileSync(resolved, "utf-8"));

  const marketPath = resolve(process.cwd(), "data/market-latest.json");
  let stockMap: Record<string, StockMeta> = analysis.stockMap ?? {};
  let codeByName = new Map<string, string>();
  let marketBlock: MarketBlock | null = null;
  if (existsSync(marketPath)) {
    try {
      const market = JSON.parse(readFileSync(marketPath, "utf-8"));
      stockMap = market.stockMap ?? stockMap;
      codeByName = buildStockLookup(market);
      if (market.market && typeof market.market === "object") {
        marketBlock = market.market as MarketBlock;
      }
      // Also enrich stockMap with chips/dayTradeRatio/flags from market gainers/losers arrays
      for (const entry of [...(market.gainers ?? []), ...(market.losers ?? [])]) {
        if (entry.code && !stockMap[entry.code]) {
          stockMap[entry.code] = { pct: entry.pct ?? "" };
        }
        if (entry.code && stockMap[entry.code]) {
          if (entry.chips !== undefined) stockMap[entry.code].chips = entry.chips;
          if (entry.dayTradeRatio !== undefined) stockMap[entry.code].dayTradeRatio = entry.dayTradeRatio;
          if (entry.flags !== undefined) stockMap[entry.code].flags = entry.flags;
        }
      }
    } catch {
      // fall back to analysis.stockMap
    }
  }

  // Load market history for retail trend chart
  const marketHistoryPath = resolve(process.cwd(), "data/market-history.json");
  let retailHistory: MarketHistoryEntry[] | undefined;
  if (existsSync(marketHistoryPath)) {
    try {
      retailHistory = JSON.parse(readFileSync(marketHistoryPath, "utf-8"));
    } catch {
      // ignore
    }
  }

  const html = renderHtml(analysis, stockMap, codeByName, marketBlock, retailHistory);

  const htmlOutPath = resolve(process.cwd(), "data/report-latest.html");
  writeFileSync(htmlOutPath, html, "utf-8");
  console.log(`Wrote HTML preview to ${htmlOutPath}`);

  updateHistory(analysis);

  const shouldSend = !process.argv.includes("--no-email");
  if (shouldSend) {
    await sendEmail(html);
  } else {
    console.log("Skipped email (--no-email flag)");
  }
}

main().catch((err) => {
  console.error("send-report failed:", err);
  process.exit(1);
});
