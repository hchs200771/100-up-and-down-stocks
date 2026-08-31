import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "dotenv/config";
import dotenv from "dotenv";
dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true });

// 網頁版報告（GitHub Pages）。Email 版沒有互動圖，用這個連結把讀者導回網頁版。
const SITE_URL = "https://hchs200771.github.io/100-up-and-down-stocks/";

interface MarketHistoryEntry {
  date: string;
  retailNetPct: number | null;
  retailNetLots?: number | null;
  taiexClose?: number | null;
  [key: string]: unknown;
}

interface MarginHistoryEntry {
  date: string;
  marginAmount: number | null;
  maintenance: number | null;
}

interface OptionSide {
  lots: number;
  amount: number;
  dLots: number;
  dAmount: number;
}

interface MarginOptionsReport {
  tradingDate: string;
  margin: {
    twseLots: number;
    twseAmount: number;
    dAmount: number;
    twseShortLots: number;
    tpexLots: number | null;
    maintenance: number | null;
    maintenanceCoverage: { stocks: number; collateral: number } | null;
  } | null;
  options: {
    dataDate: string;
    prevDate: string;
    call: { buy: OptionSide; sell: OptionSide };
    put: { buy: OptionSide; sell: OptionSide };
    bull: { lots: number; dLots: number; amount: number; dAmount: number };
    bear: { lots: number; dLots: number; amount: number; dAmount: number };
  } | null;
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
  stage?: string; // "啟動/擴散/高潮/退潮"（finalizer）或 "連N日/回歸"（時間軸機械標籤）
  call?: "順勢" | "觀察" | "反轉";
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
  institutional?: { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number } | null;
}

interface IntlIndex {
  key: string;
  name: string;
  region: string;
  close: number;
  change: number;
  pct: number;
}

interface CreditSpread {
  key: string;
  name: string;
  note: string;
  asOf: string;
  bps: number;
  chg1d: number | null;
  chg1m: number | null;
  pctile1y: number | null;
}

interface IntlBlock {
  summary: string;
  indices: IntlIndex[];
  credit?: CreditSpread[];
}

/** build-index-contribution.ts 的輸出（data/index-contribution-latest.json） */
interface StockContribution {
  code: string;
  name: string;
  industry: string;
  pct: number;
  points: number;
}

interface SectorContribution {
  name: string;
  points: number;
  absPoints: number;
  upPoints: number;
  downPoints: number;
  count: number;
  top: StockContribution[];
}

interface IndexContribution {
  timestamp: string;
  tradingDate: string;
  index: { close: number; change: number; prev: number };
  calibration: number;
  totals: { up: number; down: number; net: number; abs: number; offset: number };
  coverage: { priced: number; matched: number };
  sectors: SectorContribution[];
  topGainers: StockContribution[];
  topLosers: StockContribution[];
}

interface RrgAlert {
  kind: string;
  sector: string;
  detail: string;
  severity: string;
}

interface RrgBlock {
  asOf: string;
  mainWindow: number;
  quadrants: Record<string, string[]>;
  regime: { kind: string; sectors: string[]; note: string }[];
  alerts: RrgAlert[];
}

interface Analysis {
  timestamp: string;
  date: string;
  stockMap?: Record<string, StockMeta>;
  gainers: CategoryGroup[];
  losers: CategoryGroup[];
  summary: string;
  longTermStrategy?: string;
  playbook?: string;
  intl?: IntlBlock;
  rrg?: RrgBlock;
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
  return `<span style="font-size: 12px; background-color: #e0e7ff; color: #4338ca; padding: 2px 4px; border-radius: 4px; margin-left: 4px;">期貨(${label})</span>`;
}

function renderStockChipBadges(meta?: StockMeta): string {
  if (!meta) return "";
  let badges = "";
  const flags = meta.flags ?? {};
  if (flags.attention) badges += `<span style="font-size: 12px; color: #d97706; margin-left: 3px;">⚠</span>`;
  if (flags.disposition) badges += `<span style="font-size: 12px; color: #dc2626; margin-left: 3px;">⛔</span>`;
  if (meta.chips) {
    const { foreignRatio, trustRatio, foreignBuyStreak, trustBuyStreak } = meta.chips;
    if (foreignRatio !== undefined && Math.abs(foreignRatio) >= 0.2) {
      const sign = foreignRatio > 0 ? "+" : "";
      const color = foreignRatio > 0 ? "#dc2626" : "#16a34a";
      badges += `<span style="font-size: 12px; color: ${color}; margin-left: 3px;">外本比 ${sign}${foreignRatio.toFixed(2)}%</span>`;
    }
    if (trustRatio !== undefined && Math.abs(trustRatio) >= 0.1) {
      const sign = trustRatio > 0 ? "+" : "";
      const color = trustRatio > 0 ? "#dc2626" : "#16a34a";
      badges += `<span style="font-size: 12px; color: ${color}; margin-left: 3px;">投本比 ${sign}${trustRatio.toFixed(2)}%</span>`;
    }
    if (foreignBuyStreak !== undefined && foreignBuyStreak >= 3) {
      badges += `<span style="font-size: 12px; background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; margin-left: 3px;">外資連買${foreignBuyStreak}日</span>`;
    }
    if (trustBuyStreak !== undefined && trustBuyStreak >= 3) {
      badges += `<span style="font-size: 12px; background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; margin-left: 3px;">投信連買${trustBuyStreak}日</span>`;
    }
  }
  if (meta.dayTradeRatio !== undefined && meta.dayTradeRatio >= 40) {
    badges += `<span style="font-size: 12px; color: #6b7280; margin-left: 3px;">沖${Math.round(meta.dayTradeRatio)}%</span>`;
  }
  if (meta.overnightDumpRepeat) {
    badges += `<span style="font-size: 12px; background-color: #dc2626; color: white; padding: 2px 4px; border-radius: 4px; margin-left: 3px;">隔日沖慣犯</span>`;
  } else if (meta.overnightDump) {
    badges += `<span style="font-size: 12px; background-color: #e5e7eb; color: #374151; padding: 2px 4px; border-radius: 4px; margin-left: 3px;">疑似隔日沖</span>`;
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

  const cell = (label: string, val: number, max: number | null, isRisk = false): string => {
    const valColor = isRisk && val < 0 ? "#dc2626" : "#1f2937";
    const maxStr = max ? `<span style="color:#9ca3af; font-size:12px;">/${max}</span>` : "";
    return `<div style="display:inline-block; text-align:center; min-width:62px; margin:0 2px;">
      <div style="font-size:13px; color:#6b7280;">${label}</div>
      <div style="font-size:18px; font-weight:bold; color:${valColor};">${val}${maxStr}</div>
    </div>`;
  };

  const rationaleHtml = g.entryRationale
    ? `<p style="margin:8px 0 0 0; font-size:14px; color:#374151; line-height:1.6;">${g.entryRationale}</p>`
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
  if (g.call) {
    const callStyle: Record<string, string> = {
      順勢: "background-color: #dc2626; color: white;",
      觀察: "background-color: #fef3c7; color: #92400e;",
      反轉: "background-color: #16a34a; color: white;",
    };
    const style = callStyle[g.call] ?? "background-color: #e5e7eb; color: #374151;";
    headerBadges += `<span style="font-size: 11px; ${style} padding: 2px 6px; border-radius: 4px; margin-left: 6px; font-weight: bold;">${g.call}</span>`;
  }
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
    <div style="margin-bottom: 10px;">${stocksHtml}</div>
    ${storyHtml}
    ${kind === "gainer" ? renderScorePanel(g) : ""}
  </div>`;
}

/**
 * 市場總覽的主圖：微臺散戶淨多空（長條）＋ 加權指數（線）＋ 融資餘額（線）。
 *
 * **雙軌渲染**，兩者都要維護：
 * - 伺服器端先畫一張靜態 SVG（三條資料都畫上去），信件端看到的就是它，沒有 JS 也完整。
 * - 網頁端 JS 接手後，打開「顯示哪些資料」的 checkbox 與滑鼠 hover 的十字線＋數值框，
 *   並在勾選改變時整張重畫（Y 軸會跟著只剩下的序列重新縮放）。
 *
 * 為什麼 checkbox 預設 `display:none` 由 JS 打開：信件沒有 JS，一排點不動的核取方塊
 * 比沒有更糟。同理 hover 提示只在網頁版出現。
 *
 * 融資餘額只有上市，且是**自己抓的另一條序列**（data/margin-history.json），
 * 日期軸不一定跟微臺完全對齊；對不上的日子畫成斷點而不是內插，不要自作聰明補值。
 */
export function renderRetailTrend(history: MarketHistoryEntry[], marginHistory?: MarginHistoryEntry[]): string {
  const points = history
    .filter((h) => h.retailNetLots !== null && h.retailNetLots !== undefined)
    .slice(-40);

  if (points.length < 2) return "";

  const lotsValues = points.map((p) => p.retailNetLots as number);
  const maxAbsLots = Math.max(...lotsValues.map(Math.abs), 1);

  const tickUnit = (() => {
    const wan = maxAbsLots / 10000;
    if (wan >= 4) return 10000;
    if (wan >= 2) return 5000;
    if (wan >= 1) return 2000;
    return 1000;
  })();
  const maxTick = Math.ceil(maxAbsLots / tickUnit) * tickUnit;
  const halfTick = Math.round(maxTick / 2 / tickUnit) * tickUnit;
  const fmtWan = (lots: number) => `${(lots / 10000).toFixed(1)}萬`;

  const firstDate = points[0].date.slice(5);
  const lastDate = points[points.length - 1].date.slice(5);
  const lastLots = lotsValues[lotsValues.length - 1];
  const lastPct = points[points.length - 1].retailNetPct;
  const lastColor = lastLots >= 0 ? "#dc2626" : "#16a34a";
  const pctLabel =
    lastPct !== null && lastPct !== undefined ? ` (${lastPct >= 0 ? "+" : ""}${(lastPct as number).toFixed(2)}%)` : "";
  const direction = lastLots >= 0 ? "散戶淨多" : "散戶淨空";

  const statLine = `<div style="font-size:12px; margin:6px 0; padding:6px 8px; background:#ffffff; border:1px solid #e2e8f0; border-radius:6px;">
    最新（${lastDate}）：<strong style="color:${lastColor};">${direction} ${lastLots >= 0 ? "+" : ""}${fmtWan(Math.abs(lastLots))}口${pctLabel}</strong>
    <span style="color:#9ca3af; margin-left:6px;">近${points.length}日 ${firstDate}~${lastDate}</span>
  </div>`;

  // 融資餘額對齊到微臺的日期軸；對不上的留 null（畫成斷點）
  const marginByDate = new Map((marginHistory ?? []).map((m) => [m.date, m]));
  const marginSeries = points.map((p) => marginByDate.get(p.date)?.marginAmount ?? null);
  const maintSeries = points.map((p) => marginByDate.get(p.date)?.maintenance ?? null);
  const hasMargin = marginSeries.filter((v) => v !== null).length >= 2;

  // ---- 幾何 ----
  const svgW = 560;
  const svgH = 190;
  const padL = 48;
  const padR = 54;
  const padT = 14;
  const padB = 34;
  const innerW = svgW - padL - padR;
  const innerH = svgH - padT - padB;
  const lotsMin = -maxTick;
  const lotsSpan = maxTick - lotsMin || 1;

  const xSvg = (i: number) => (points.length === 1 ? padL + innerW / 2 : padL + (i / (points.length - 1)) * innerW);
  const ySvgLots = (v: number) => padT + innerH - ((v - lotsMin) / lotsSpan) * innerH;
  const zeroY = ySvgLots(0);

  const barW = Math.max(2, Math.floor(innerW / points.length) - 1);
  const svgBars = points
    .map((p, i) => {
      const val = p.retailNetLots as number;
      const y = val >= 0 ? ySvgLots(val) : zeroY;
      const h = Math.max(1, Math.abs(ySvgLots(val) - zeroY));
      return `<rect x="${(xSvg(i) - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" fill="${val >= 0 ? "#dc2626" : "#16a34a"}" fill-opacity="0.7"/>`;
    })
    .join("");

  const leftTicks = [-maxTick, -halfTick, 0, halfTick, maxTick]
    .map((v) => {
      const y = ySvgLots(v).toFixed(1);
      const label = v === 0 ? "0" : `${v >= 0 ? "+" : ""}${fmtWan(v)}`;
      return `<line x1="${padL - 4}" y1="${y}" x2="${padL}" y2="${y}" stroke="#94a3b8" stroke-width="1"/>
<text x="${padL - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#64748b">${label}</text>`;
    })
    .join("\n");

  /** 把任一條序列（可含 null）畫成右軸折線，回傳 polyline 與刻度。 */
  function rightAxisLine(values: (number | null)[], color: string, offset: number) {
    const valid = values.map((v, i) => ({ i, v })).filter((p) => p.v !== null) as { i: number; v: number }[];
    if (valid.length < 2) return { path: "", ticks: "", lo: 0, hi: 1 };
    const min = Math.min(...valid.map((p) => p.v));
    const max = Math.max(...valid.map((p) => p.v));
    const span = max - min || 1;
    const lo = min - span * 0.08;
    const hi = max + span * 0.08;
    const y = (v: number) => padT + innerH - ((v - lo) / (hi - lo)) * innerH;
    // 斷點：連續的有效值才連線，中間有 null 就斷開，不內插
    const segs: string[] = [];
    let cur: string[] = [];
    values.forEach((v, i) => {
      if (v === null) {
        if (cur.length > 1) segs.push(cur.join(" "));
        cur = [];
      } else cur.push(`${xSvg(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (cur.length > 1) segs.push(cur.join(" "));
    const path = segs
      .map((pts) => `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>`)
      .join("");
    const ticks = [lo, (lo + hi) / 2, hi]
      .map((v) => {
        const yy = y(v).toFixed(1);
        return `<text x="${svgW - padR + 6 + offset}" y="${yy}" text-anchor="start" dominant-baseline="middle" font-size="9" fill="${color}">${Math.round(v).toLocaleString()}</text>`;
      })
      .join("\n");
    return { path, ticks, lo, hi };
  }

  const taiexVals = points.map((p) => (p.taiexClose ?? null) as number | null);
  const taiexLine = rightAxisLine(taiexVals, "#4f46e5", 0);
  const marginLine = hasMargin ? rightAxisLine(marginSeries, "#ea580c", 0) : { path: "", ticks: "" };

  const zeroLine = `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${svgW - padR}" y2="${zeroY.toFixed(1)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,2"/>`;

  const legendY = svgH - 16;
  const legend =
    `<rect x="${padL}" y="${legendY - 8}" width="10" height="8" fill="#dc2626" fill-opacity="0.7"/>` +
    `<text x="${padL + 13}" y="${legendY}" font-size="9" fill="#64748b">散戶淨多空（萬口）</text>` +
    `<line x1="${padL + 108}" y1="${legendY - 4}" x2="${padL + 124}" y2="${legendY - 4}" stroke="#4f46e5" stroke-width="1.8"/>` +
    `<text x="${padL + 127}" y="${legendY}" font-size="9" fill="#4f46e5">加權指數</text>` +
    (hasMargin
      ? `<line x1="${padL + 190}" y1="${legendY - 4}" x2="${padL + 206}" y2="${legendY - 4}" stroke="#ea580c" stroke-width="1.8"/>` +
        `<text x="${padL + 209}" y="${legendY}" font-size="9" fill="#ea580c">融資餘額（億）</text>`
      : "");

  // 網頁版 hover 用的資料；短 key 控制體積
  const payload = {
    d: points.map((p) => p.date.slice(5)),
    r: lotsValues,
    p: points.map((p) => (p.retailNetPct ?? null)),
    t: taiexVals,
    m: hasMargin ? marginSeries : null,
    n: hasMargin ? maintSeries : null,
    g: { w: svgW, h: svgH, l: padL, rr: padR, t: padT, b: padB, zero: zeroY, min: lotsMin, span: lotsSpan, bw: barW },
  };

  const cb = (id: string, label: string, color: string, checked: boolean) =>
    `<label style="font-size:11px; color:#475569; margin-right:12px; cursor:pointer; white-space:nowrap;">
      <input type="checkbox" class="rt-cb" data-k="${id}"${checked ? " checked" : ""} style="vertical-align:-1px; margin-right:3px; accent-color:${color};">${label}
    </label>`;

  return `<div style="background-color:#f8fafc; border:1px solid #e2e8f0; padding:12px 15px; border-radius:8px; margin-top:10px; margin-bottom:0;" class="rt-root">
    <div style="font-size:12px; font-weight:bold; color:#334155; margin-bottom:4px;">市場情緒趨勢（近${points.length}日）</div>
    <div style="font-size:11px; color:#6b7280; margin-bottom:6px;">長條＝微臺散戶淨多空（正值紅＝偏多、負值綠＝偏空，單位萬口）；折線＝加權指數與上市融資餘額</div>
    ${statLine}
    <div class="rt-ctrl" style="display:none; margin:4px 0 2px;">
      ${cb("r", "微臺散戶口數", "#dc2626", true)}
      ${cb("t", "加權指數", "#4f46e5", true)}
      ${hasMargin ? cb("m", "融資餘額", "#ea580c", false) : ""}
      ${hasMargin ? cb("n", "融資維持率", "#0891b2", false) : ""}
    </div>
    <div style="margin-top:8px; overflow-x:auto; position:relative;" class="rt-wrap">
      <svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="max-width:100%; overflow:visible;" class="rt-svg">
        <g class="rt-bars">${svgBars}</g>
        ${zeroLine}
        ${leftTicks}
        <g class="rt-taiex">${taiexLine.path}${taiexLine.ticks}</g>
        <g class="rt-margin" style="display:none">${marginLine.path}</g>
        <g class="rt-hover" style="display:none"><line class="rt-vline" y1="${padT}" y2="${padT + innerH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/></g>
        <g class="rt-legend">${legend}</g>
      </svg>
      <div class="rt-tip" style="display:none; position:absolute; pointer-events:none; background:rgba(15,23,42,.92); color:#fff; font-size:11px; line-height:1.6; padding:6px 8px; border-radius:5px; white-space:nowrap; z-index:5;"></div>
    </div>
    <div style="font-size:11px; color:#94a3b8; margin-top:6px;" class="rt-hint">
      融資餘額與維持率僅含<strong>上市</strong>；維持率是用「Σ個股融資餘額張數×收盤價 ÷ 融資金額」自算的，與券商公布值會有零點幾個百分點差異，看趨勢與 166%／130% 兩條線即可。
    </div>
    <script type="application/json" class="rt-data">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
    <script>
    (function(){
      var root=document.currentScript&&document.currentScript.parentNode; if(!root) return;
      var raw=root.querySelector('.rt-data'); if(!raw) return;
      var D=JSON.parse(raw.textContent), G=D.g;
      var svg=root.querySelector('.rt-svg'), wrap=root.querySelector('.rt-wrap'), tip=root.querySelector('.rt-tip');
      var ctrl=root.querySelector('.rt-ctrl'); if(ctrl) ctrl.style.display='block';
      var on={r:true,t:true,m:false,n:false};
      var innerW=G.w-G.l-G.rr, innerH=G.h-G.t-G.b;
      var COL={r:'#dc2626',t:'#4f46e5',m:'#ea580c',n:'#0891b2'};
      var NAME={r:'散戶淨多空',t:'加權指數',m:'融資餘額',n:'融資維持率'};
      function x(i){return D.d.length===1?G.l+innerW/2:G.l+(i/(D.d.length-1))*innerW}
      function fmtWan(v){return (v/10000).toFixed(1)+'萬'}
      function seg(vals,color,lo,hi){
        var y=function(v){return G.t+innerH-((v-lo)/(hi-lo))*innerH};
        var out='',cur=[];
        for(var i=0;i<vals.length;i++){
          if(vals[i]===null){ if(cur.length>1) out+='<polyline points="'+cur.join(' ')+'" fill="none" stroke="'+color+'" stroke-width="1.8" stroke-linejoin="round"/>'; cur=[]; }
          else cur.push(x(i).toFixed(1)+','+y(vals[i]).toFixed(1));
        }
        if(cur.length>1) out+='<polyline points="'+cur.join(' ')+'" fill="none" stroke="'+color+'" stroke-width="1.8" stroke-linejoin="round"/>';
        return out;
      }
      function range(vals){
        var v=vals.filter(function(a){return a!==null});
        if(v.length<2) return null;
        var mn=Math.min.apply(null,v), mx=Math.max.apply(null,v), sp=(mx-mn)||1;
        return [mn-sp*0.08, mx+sp*0.08];
      }
      function paint(){
        // 長條
        var bars='';
        if(on.r){
          for(var i=0;i<D.r.length;i++){
            var v=D.r[i], yv=G.t+innerH-((v-G.min)/G.span)*innerH;
            var top=v>=0?yv:G.zero, h=Math.max(1,Math.abs(yv-G.zero));
            bars+='<rect x="'+(x(i)-G.bw/2).toFixed(1)+'" y="'+top.toFixed(1)+'" width="'+G.bw+'" height="'+h.toFixed(1)+'" fill="'+(v>=0?'#dc2626':'#16a34a')+'" fill-opacity="0.7"/>';
          }
        }
        root.querySelector('.rt-bars').innerHTML=bars;
        // 右軸折線：一次只給一條完整刻度，多條時只畫線避免刻度打架
        var lines=[], keys=['t','m','n'], drawn=[];
        keys.forEach(function(k){
          var vals=D[k]; if(!on[k]||!vals) return;
          var r=range(vals); if(!r) return;
          drawn.push({k:k,lo:r[0],hi:r[1]});
          lines.push(seg(vals,COL[k],r[0],r[1]));
        });
        var ticks='';
        if(drawn.length===1){
          var d0=drawn[0], yy=function(v){return G.t+innerH-((v-d0.lo)/(d0.hi-d0.lo))*innerH};
          [d0.lo,(d0.lo+d0.hi)/2,d0.hi].forEach(function(v){
            ticks+='<text x="'+(G.w-G.rr+6)+'" y="'+yy(v).toFixed(1)+'" text-anchor="start" dominant-baseline="middle" font-size="9" fill="'+COL[d0.k]+'">'+(d0.k==='n'?v.toFixed(0)+'%':Math.round(v).toLocaleString())+'</text>';
          });
        }
        root.querySelector('.rt-taiex').innerHTML=lines.join('')+ticks;
        root.querySelector('.rt-margin').innerHTML='';
        // 圖例
        var lg='', lx=G.l, ly=G.h-16;
        if(on.r){ lg+='<rect x="'+lx+'" y="'+(ly-8)+'" width="10" height="8" fill="#dc2626" fill-opacity="0.7"/><text x="'+(lx+13)+'" y="'+ly+'" font-size="9" fill="#64748b">散戶淨多空（萬口）</text>'; lx+=122; }
        keys.forEach(function(k){
          if(!on[k]||!D[k]) return;
          lg+='<line x1="'+lx+'" y1="'+(ly-4)+'" x2="'+(lx+16)+'" y2="'+(ly-4)+'" stroke="'+COL[k]+'" stroke-width="1.8"/><text x="'+(lx+19)+'" y="'+ly+'" font-size="9" fill="'+COL[k]+'">'+NAME[k]+'</text>';
          lx+=NAME[k].length*9+30;
        });
        root.querySelector('.rt-legend').innerHTML=lg;
      }
      function nearest(clientX){
        var box=svg.getBoundingClientRect();
        var sx=(clientX-box.left)/box.width*G.w;
        var best=0,bd=1e9;
        for(var i=0;i<D.d.length;i++){var dd=Math.abs(x(i)-sx); if(dd<bd){bd=dd;best=i}}
        return best;
      }
      var hov=root.querySelector('.rt-hover'), vline=root.querySelector('.rt-vline');
      function show(e){
        var i=nearest(e.clientX);
        hov.style.display=''; vline.setAttribute('x1',x(i).toFixed(1)); vline.setAttribute('x2',x(i).toFixed(1));
        var h='<div style="color:#cbd5e1;margin-bottom:2px;">'+D.d[i]+'</div>';
        if(on.r) h+='<div><span style="color:'+(D.r[i]>=0?'#f87171':'#4ade80')+'">■</span> 散戶淨'+(D.r[i]>=0?'多':'空')+' '+(D.r[i]>=0?'+':'-')+fmtWan(Math.abs(D.r[i]))+'口'+(D.p[i]!==null?'（'+(D.p[i]>=0?'+':'')+D.p[i].toFixed(2)+'%）':'')+'</div>';
        if(on.t&&D.t[i]!==null) h+='<div><span style="color:#818cf8">—</span> 加權 '+D.t[i].toLocaleString()+'</div>';
        if(on.m&&D.m&&D.m[i]!==null) h+='<div><span style="color:#fb923c">—</span> 融資 '+D.m[i].toLocaleString()+' 億</div>';
        if(on.n&&D.n&&D.n[i]!==null) h+='<div><span style="color:#22d3ee">—</span> 維持率 '+D.n[i].toFixed(1)+'%</div>';
        tip.innerHTML=h; tip.style.display='block';
        var box=svg.getBoundingClientRect(), wb=wrap.getBoundingClientRect();
        var px=box.left-wb.left+x(i)/G.w*box.width;
        tip.style.left=Math.min(Math.max(0,px+10), wrap.clientWidth-tip.offsetWidth-4)+'px';
        tip.style.top='6px';
      }
      svg.addEventListener('mousemove',show);
      svg.addEventListener('mouseleave',function(){hov.style.display='none';tip.style.display='none'});
      [].forEach.call(root.querySelectorAll('.rt-cb'),function(c){
        c.addEventListener('change',function(){ on[c.getAttribute('data-k')]=c.checked; paint(); });
      });
      paint();
    })();
    </script>
  </div>`;
}

/**
 * 外資臺指選擇權未平倉的四個象限。
 *
 * **選擇權的多空不能只看買方**：賣方是收權利金、賭「不會漲過去／不會跌破」，
 * 所以「賣出賣權（Put 賣方）」是偏多，「賣出買權（Call 賣方）」才是偏空。
 * 只看「外資買了多少 Call」會把避險部位讀成看多，這是最常見的誤讀，所以這裡
 * 一定要四格並列、再給一行合成的多空對比，不要只挑其中一格講。
 *
 * 用未平倉而不是當日交易口數：當日交易含大量價差單與隔日沖，方向性意義弱。
 */
function renderForeignOptions(o: MarginOptionsReport["options"] | null | undefined): string {
  if (!o) return "";
  const d = (n: number, unit: string, digits = 0) => {
    const c = n > 0 ? "#dc2626" : n < 0 ? "#16a34a" : "#9ca3af";
    return `<span style="color:${c};">${n >= 0 ? "+" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: digits })}${unit}</span>`;
  };
  const cell = (label: string, tone: "bull" | "bear", s: OptionSide) => {
    const bg = tone === "bull" ? "#fef2f2" : "#f0fdf4";
    const bd = tone === "bull" ? "#fecaca" : "#bbf7d0";
    const fg = tone === "bull" ? "#991b1b" : "#166534";
    return `<td style="padding:6px 8px; background:${bg}; border:1px solid ${bd}; border-radius:6px; vertical-align:top;">
      <div style="font-size:11px; color:${fg}; font-weight:bold; margin-bottom:2px;">${label}</div>
      <div style="font-size:13px; font-weight:bold; color:#334155;">${s.lots.toLocaleString()} 口 <span style="font-size:11px; font-weight:normal;">${d(s.dLots, "")}</span></div>
      <div style="font-size:11px; color:#6b7280;">${s.amount.toLocaleString()} 億 <span>${d(s.dAmount, "", 1)}</span></div>
    </td>`;
  };
  const net = o.bull.lots - o.bear.lots;
  const netD = o.bull.dLots - o.bear.dLots;
  const stance = net > 0 ? "偏多" : net < 0 ? "偏空" : "中性";
  const stanceColor = net > 0 ? "#dc2626" : net < 0 ? "#16a34a" : "#6b7280";

  return `<div style="background:#ffffff; border:1px solid #e2e8f0; padding:12px 15px; border-radius:8px; margin-top:10px;">
    <div style="font-size:12px; font-weight:bold; color:#334155; margin-bottom:2px;">外資臺指選擇權未平倉（${o.dataDate}，括號為對 ${o.prevDate} 的增減）</div>
    <div style="font-size:11px; color:#6b7280; margin-bottom:8px;">
      看多 = 買買權 + 賣賣權；看空 = 賣買權 + 買賣權。<strong>賣方是收權利金賭不會發生</strong>，所以賣賣權算偏多、賣買權算偏空。
    </div>
    <table style="width:100%; border-collapse:separate; border-spacing:4px; table-layout:fixed;">
      <tr>${cell("買進買權 Call 買方（偏多）", "bull", o.call.buy)}${cell("賣出買權 Call 賣方（偏空）", "bear", o.call.sell)}</tr>
      <tr>${cell("賣出賣權 Put 賣方（偏多）", "bull", o.put.sell)}${cell("買進賣權 Put 買方（偏空）", "bear", o.put.buy)}</tr>
    </table>
    <div style="font-size:12px; color:#334155; margin-top:8px; padding:6px 8px; background:#f8fafc; border-radius:6px;">
      合計：看多 <strong>${o.bull.lots.toLocaleString()}</strong> 口（${o.bull.amount} 億）${d(o.bull.dLots, "")}　·　
      看空 <strong>${o.bear.lots.toLocaleString()}</strong> 口（${o.bear.amount} 億）${d(o.bear.dLots, "")}　·　
      淨部位 <strong style="color:${stanceColor};">${stance} ${Math.abs(net).toLocaleString()} 口</strong>（日變化 ${d(netD, " 口")}）
    </div>
  </div>`;
}

function renderMarketDashboard(market: MarketBlock | null | undefined, retailHistory?: MarketHistoryEntry[], marginHistory?: MarginHistoryEntry[], mo?: MarginOptionsReport | null): string {
  if (!market) return "";

  const rows: string[] = [];

  const fmtIndexChange = (close: number, change: number) => {
    const sign = change >= 0 ? "+" : "";
    const color = change >= 0 ? "#dc2626" : "#16a34a";
    const prevClose = close - change;
    const pct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
    return `<td style="padding: 4px 8px; color: ${color}; font-weight: bold;">${sign}${change.toFixed(2)} <span style="font-size: 12px;">(${sign}${pct.toFixed(2)}%)</span></td>`;
  };
  const taiex = market.taiex;
  if (taiex) {
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">加權指數</td><td style="padding: 4px 8px; font-weight: bold;">${taiex.close.toLocaleString()}</td>${fmtIndexChange(taiex.close, taiex.change)}</tr>`);
  }
  const tpex = market.tpex;
  if (tpex) {
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">櫃買指數</td><td style="padding: 4px 8px; font-weight: bold;">${tpex.close.toLocaleString()}</td>${fmtIndexChange(tpex.close, tpex.change)}</tr>`);
  }
  const breadth = market.breadth;
  if (breadth) {
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">上漲/下跌</td><td style="padding: 4px 8px;" colspan="2"><span style="color: #dc2626;">${breadth.up}家</span> / <span style="color: #16a34a;">${breadth.down}家</span>　漲停 <strong style="color: #dc2626;">${breadth.limitUp}</strong> / 跌停 <strong style="color: #16a34a;">${breadth.limitDown}</strong></td></tr>`);
  }
  const dt = market.dayTrade;
  if (dt) {
    const dtPct = (v: number | null | undefined) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(2)}%` : "—");
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">當沖比重</td><td style="padding: 4px 8px;" colspan="2">上市 ${dtPct(dt.twseVolumePct)}　上櫃 ${dtPct(dt.tpexVolumePct)}</td></tr>`);
  }
  const insti = market.institutional;
  if (insti) {
    const fmt = (n: number) => {
      const color = n >= 0 ? "#dc2626" : "#16a34a";
      const sign = n >= 0 ? "+" : "";
      return `<span style="color: ${color}; font-weight: bold;">${sign}${n.toFixed(1)}</span>`;
    };
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">三大法人(上市)</td><td style="padding: 4px 8px;" colspan="2">合計 ${fmt(insti.totalNet)} 億　<span style="color:#9ca3af; font-size:12px;">外資 ${fmt(insti.foreignNet)}／投信 ${fmt(insti.trustNet)}／自營 ${fmt(insti.dealerNet)}</span></td></tr>`);
  }
  const mfr = market.microFuturesRetail;
  if (mfr) {
    const netPct = mfr.retailNetPct.toFixed(2);
    const netColor = mfr.retailNetPct < 0 ? "#16a34a" : "#dc2626";
    rows.push(`<tr><td style="padding: 4px 8px; color: #6b7280;">微臺散戶淨多空</td><td style="padding: 4px 8px; color: ${netColor}; font-weight: bold;" colspan="2">${netPct}%　<span style="font-size: 11px; color: #9ca3af;">(${mfr.dataDate})</span></td></tr>`);
  }

  // 融資餘額／維持率。與盤後資料同一天才顯示，避免把昨天的數字混進今天的儀表板。
  const mg = mo?.margin;
  if (mg) {
    const dColor = mg.dAmount >= 0 ? "#dc2626" : "#16a34a";
    const dSign = mg.dAmount >= 0 ? "+" : "";
    // 166% 是追繳線、130% 是斷頭線。整體維持率離這兩條還很遠時只是背景資訊，
    // 逼近時才是風險訊號，所以低於門檻才變色。
    const mt = mg.maintenance;
    const mtColor = mt === null ? "#9ca3af" : mt < 140 ? "#dc2626" : mt < 166 ? "#ea580c" : "#334155";
    rows.push(
      `<tr><td style="padding: 4px 8px; color: #6b7280;">融資餘額(上市)</td><td style="padding: 4px 8px; font-weight: bold;">${mg.twseAmount.toLocaleString()} 億</td><td style="padding: 4px 8px; color: ${dColor}; font-weight: bold;">${dSign}${mg.dAmount.toFixed(1)} 億<span style="color:#9ca3af; font-weight:normal; font-size:11px;">　${mg.twseLots.toLocaleString()} 張${mg.tpexLots ? `／上櫃 ${mg.tpexLots.toLocaleString()} 張` : ""}</span></td></tr>`,
    );
    rows.push(
      `<tr><td style="padding: 4px 8px; color: #6b7280;">融資維持率</td><td style="padding: 4px 8px; color: ${mtColor}; font-weight: bold;" colspan="2">${mt === null ? "—" : `${mt.toFixed(1)}%`}<span style="color:#9ca3af; font-weight:normal; font-size:11px;">　自算值，追繳線 166%／斷頭線 130%${mg.maintenanceCoverage ? `　涵蓋 ${mg.maintenanceCoverage.stocks} 檔` : ""}</span></td></tr>`,
    );
  }

  if (rows.length === 0) return "";

  const trendHtml = retailHistory ? renderRetailTrend(retailHistory, marginHistory) : "";
  const optionsHtml = renderForeignOptions(mo?.options);

  return `<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
  <h3 style="margin-top: 0; color: #334155;">📊 市場儀表板</h3>
  <table style="border-collapse: collapse; font-size: 13px; width: 100%;">
    ${rows.join("\n    ")}
  </table>
  ${trendHtml}
  ${optionsHtml}
</div>`;
}

function renderLegend(): string {
  const item = (badge: string, desc: string) =>
    `<div style="margin-bottom: 6px; display: flex; align-items: flex-start; gap: 6px;">${badge}<span style="color: #64748b;">${desc}</span></div>`;

  return `<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
  <h3 style="margin-top: 0; color: #334155; font-size: 16px;">🔖 圖例說明</h3>
  <div style="font-size: 13px; line-height: 1.7;">
    ${item(`<span style="background-color: #e0e7ff; color: #4338ca; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">期貨(級距N XX%)</span>`, "個股有期貨合約；級距=保證金級距，%=原始保證金率")}
    ${item(`<span style="color: #dc2626; font-size: 11px;">外本比 +X%</span> / <span style="color: #16a34a; font-size: 11px;">外本比 −X%</span>`, "外資買賣超佔已發行股數比例（+買超紅、−賣超綠；顯示門檻 ≥ 0.2%）")}
    ${item(`<span style="color: #dc2626; font-size: 11px;">投本比 +X%</span> / <span style="color: #16a34a; font-size: 11px;">投本比 −X%</span>`, "投信買賣超佔已發行股數比例（與外本比同義，投信版；顯示門檻 ≥ 0.1%）")}
    ${item(`<span style="background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; font-size: 10px;">外資連買N日</span> / <span style="background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; font-size: 10px;">投信連買N日</span>`, "法人連續 ≥ 3 日淨買，吸籌訊號（含今日，今日若非淨買則不顯示）")}
    ${item(`<span style="color: #6b7280; font-size: 11px;">沖X%</span>`, "當日當沖佔成交量比例（≥40% 才標，代表投機/隔日沖盤偏多）")}
    ${item(`<span style="color: #d97706; font-size: 11px;">⚠</span>`, "注意股")}
    ${item(`<span style="color: #dc2626; font-size: 11px;">⛔</span>`, "處置股")}
    ${item(`<span style="background-color: #fef9c3; color: #92400e; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">🔻 退潮警訊</span>`, "前幾日強勢族群今天落入弱勢榜（換手/退潮）")}
    ${item(`<span style="background-color: #e5e7eb; color: #6b7280; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">⚠ 題材未經新聞驗證</span>`, "該族群，因為沒有找到新聞，而是用 AI 模型裡的產業資料做推論，所以信心度比較低")}
    ${item(`<span style="background-color: #dc2626; color: white; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px; font-weight: bold;">順勢</span> / <span style="background-color: #fef3c7; color: #92400e; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px; font-weight: bold;">觀察</span> / <span style="background-color: #16a34a; color: white; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px; font-weight: bold;">反轉</span>`, "AI 操盤判斷（隔日記分板會回頭驗證勝率）：順勢=主流有連續性或法人認養，可加碼續抱；觀察=今日新進榜或訊號互相矛盾，先看一天再決定；反轉=當沖過熱、題材鬆散或預期熄火，不建議追價。沒把握的族群不標，避免灌水。有標記的族群排在最前面")}
    ${item(`<span style="background-color: #e0e7ff; color: #4338ca; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">連N日</span> / <span style="background-color: #e0e7ff; color: #4338ca; padding: 1px 4px; border-radius: 4px; white-space: nowrap; font-size: 11px;">回歸</span>`, "族群連續強勢天數（機械計算自歷史榜單）：連N日=連續 N 個交易日進強勢榜，天數越多主流地位越確立、但也越接近高潮；回歸=近 10 個交易日曾強勢、休息後再度進榜（二波行情，須觀察力道）；無此標籤=今日首次進榜的新面孔")}
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
  <h3 style="margin-top: 0; color: #334155; font-size: 16px;">🧮 進場評分說明（強勢族群，0-100）</h3>
  <p style="font-size: 13px; color: #64748b; line-height: 1.6; margin: 0 0 10px 0;">分數＝<strong>現在進場的 risk／reward</strong>，不是今天多強。剛起漲、上檔大下檔小→高分；漲多進入高潮→低分。四軸相加＝總分。</p>
  <div style="font-size: 13px; line-height: 1.6;">
    ${axis("趨勢", "0–40", "長線題材夠不夠硬：AI 基建、記憶體循環、先進封裝=高；補漲、單一事件、ETF=低")}
    ${axis("時機", "0–35", "漲潮退潮階段，越早進場分越高。<strong>依榜單連續性＋籌碼判定，不看技術線型</strong>：啟動＝連續上榜≤1天、法人帶龍頭先動、尚未擴散；擴散＝連2天以上、成員增加或全面走強；高潮＝當沖飆高／投機股多／價漲但法人卻賣（過熱，是減碼點）；退潮＝前幾日強勢今天落入弱勢榜")}
    ${axis("籌碼", "0–25", "法人是否真錢背書：外資＋投信同向買、龍頭先動加分")}
    ${axis("風險", "−30–0", "投機假象扣分：當沖比高、投機股多、注意／處置／低流動、隔日沖")}
  </div>
  <div style="font-size: 13px; line-height: 1.7; margin-top: 10px; border-top: 1px solid #e2e8f0; padding-top: 10px;">
    ${tier(chip("#dcfce7", "#15803d", "85+ 核心加碼"), "趨勢好＋剛啟動＋法人買，優先放錢")}
    ${tier(chip("#dbeafe", "#1d4ed8", "70–84 標準持有"), "主升段、可續抱或加碼")}
    ${tier(chip("#fef9c3", "#a16207", "55–69 觀察不追"), "等回測或擴散驗證再進")}
    ${tier(chip("#f3f4f6", "#6b7280", "<55 不碰／減碼"), "高潮、退潮或純投機")}
  </div>
</div>`;
}

/**
 * 信用利差：資金鬆緊的直接讀數。利差走闊＝市場要求更高的風險補償＝資金在收縮。
 * 用 bps 呈現而不是百分比漲跌——利差本身就是「幾個百分點」，再算 % 變化沒有意義。
 * 走闊用紅（風險升高）、收斂用綠，跟報告其餘部分的紅漲綠跌一致。
 */
function renderCredit(credit: CreditSpread[] | null | undefined): string {
  if (!credit || credit.length === 0) return "";
  const cells = credit
    .map((c) => {
      const d = c.chg1d;
      const color = d === null ? "#6b7280" : d > 0 ? "#dc2626" : d < 0 ? "#16a34a" : "#6b7280";
      const dTxt = d === null ? "—" : `${d > 0 ? "+" : ""}${d}bps`;
      // 百分位是「這個利差在近一年裡的相對高低」，比絕對數字更好判斷是不是真的緊。
      const p = c.pctile1y;
      const pTxt = p === null ? "" : `<span style="color:#9ca3af;"> 近一年 ${p} 百分位</span>`;
      const m = c.chg1m;
      const mTxt = m === null ? "" : `<span style="color:#9ca3af;"> 月${m > 0 ? "+" : ""}${m}</span>`;
      return `<span style="display:inline-block; margin:0 10px 4px 0; white-space:nowrap;" title="${c.note}"><span style="color:#6b7280;">${c.name}</span> <strong>${c.bps}bps</strong> <span style="color:${color}; font-weight:bold;">${dTxt}</span>${mTxt}${pTxt}</span>`;
    })
    .join("");
  const asOf = credit[0]?.asOf ?? "";
  return `<tr><td style="padding:4px 8px; color:#6b7280; vertical-align:top; white-space:nowrap;">信用利差<div style="font-size:11px; color:#9ca3af;">${asOf}</div></td><td style="padding:4px 8px;">${cells}<div style="font-size:11px; color:#9ca3af; margin-top:2px;">ICE BofA OAS（公司債對公債的風險溢酬，CDS 的公開替代品）；走闊＝資金收縮、風險偏好下降。資料源 FRED，比美股晚一天。</div></td></tr>`;
}

function renderIntl(intl: IntlBlock | null | undefined): string {
  if (!intl) return "";
  const { summary, indices, credit } = intl;
  if (!summary && (!indices || indices.length === 0) && (!credit || credit.length === 0)) return "";

  let tableHtml = "";
  const creditRow = renderCredit(credit);
  if ((indices && indices.length > 0) || creditRow) {
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
    // 信用利差排在最後一列：它是「資金鬆緊」的背景條件，先看完各市場再看它。
    if (creditRow) rows.push(creditRow);
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

/**
 * 指數貢獻拆解區塊：把加權指數的漲跌拆回產業與個股。
 *
 * 為什麼值得單獨一個 tab：指數漲跌幾點是「結果」，真正能操作的是「誰推的、誰拖的」。
 * 常見狀況是指數收紅但半導體其實在拖，靠少數幾檔非電撐起來——只看指數完全看不到。
 *
 * treemap 用巢狀 <table> 而不是 CSS grid/flex/absolute：Gmail 會剝掉 position 與
 * 多數現代版面屬性，但固定 px 寬高的巢狀表格從 Outlook 到手機 Gmail 都畫得出來。
 * 版面用 strip treemap（逐列切）而非完整 squarified，因為列結構正好對應 <tr>，
 * 不需要任何定位就能還原，代價只是長寬比沒那麼方正。
 */
function contribColor(points: number, max: number): { bg: string; fg: string } {
  // 台股慣例：紅漲綠跌。強度依貢獻絕對值對當日最大值的比例，避免小格全糊在一起。
  const t = max > 0 ? Math.min(1, Math.abs(points) / max) : 0;
  const light = 0.88 - 0.55 * Math.sqrt(t); // sqrt 讓中小型格子也拉得開
  const [h, s] = points >= 0 ? [0, 72] : [145, 55];
  const bg = `hsl(${h}, ${s}%, ${Math.round(light * 100)}%)`;
  return { bg, fg: light < 0.55 ? "#fff" : "#1f2937" };
}

interface TreemapItem { name: string; value: number; points: number }

/** strip treemap：把 items 依值切成數列，每列高度正比於該列總值。回傳每列的 [高度, 該列項目]。 */
function stripRows(items: TreemapItem[], width: number, height: number): [number, TreemapItem[]][] {
  const rows: [number, TreemapItem[]][] = [];
  let rest = [...items];
  let restTotal = rest.reduce((a, i) => a + i.value, 0);
  let restH = height;

  // 一列的「最差長寬比」：愈接近 1 愈方正。用它決定何時該收掉這一列、另起新列。
  const worst = (row: TreemapItem[], rowH: number) => {
    const sum = row.reduce((a, i) => a + i.value, 0);
    if (sum <= 0 || rowH <= 0) return Infinity;
    return Math.max(
      ...row.map((i) => {
        const w = (i.value / sum) * width;
        return Math.max(w / rowH, rowH / w);
      }),
    );
  };

  while (rest.length > 0 && restTotal > 0 && restH > 1) {
    const row: TreemapItem[] = [rest[0]];
    let idx = 1;
    let rowH = (row[0].value / restTotal) * restH;
    while (idx < rest.length) {
      const cand = [...row, rest[idx]];
      const candSum = cand.reduce((a, i) => a + i.value, 0);
      const candH = (candSum / restTotal) * restH;
      if (worst(cand, candH) > worst(row, rowH)) break;
      row.push(rest[idx]);
      rowH = candH;
      idx++;
    }
    rows.push([rowH, row]);
    rest = rest.slice(idx);
    restTotal = rest.reduce((a, i) => a + i.value, 0);
    restH -= rowH;
  }
  return rows;
}

function renderTreemap(sectors: SectorContribution[]): string {
  const W = 900;
  const H = 380;
  // 面積用絕對貢獻（absPoints）：正負互相抵銷後的淨值會讓「內部廝殺很兇」的產業消失。
  const ranked = sectors
    .filter((s) => s.absPoints > 0)
    .sort((a, b) => b.absPoints - a.absPoints);
  if (ranked.length === 0) return "";

  // 長尾切掉：30 幾個產業裡有一半佔不到 1% 面積，畫出來只是幾 px 寬的色條，
  // 既讀不到名字也擠掉主要格子的空間。合併成一格「其他產業」，總面積仍然守恆。
  const totalAbs = ranked.reduce((a, s) => a + s.absPoints, 0);
  const major = ranked.filter((s) => s.absPoints / totalAbs >= 0.01);
  const minor = ranked.filter((s) => s.absPoints / totalAbs < 0.01);
  const items: TreemapItem[] = major.map((s) => ({ name: s.name, value: s.absPoints, points: s.points }));
  if (minor.length > 0) {
    items.push({
      name: `其他 ${minor.length} 產業`,
      value: minor.reduce((a, s) => a + s.absPoints, 0),
      points: minor.reduce((a, s) => a + s.points, 0),
    });
  }
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.points)));

  // 每一列各自一張巢狀表格。不能全部塞進同一張表：table-layout:fixed 會用第一列
  // 決定欄數，後面列多出來的格子會被壓成寬度 0 而整個消失。
  const rows = stripRows(items, W, H)
    .map(([rowH, row]) => {
      const sum = row.reduce((a, i) => a + i.value, 0);
      const h = Math.max(18, Math.round(rowH));
      const cells = row
        .map((i) => {
          const w = Math.max(2, Math.round((i.value / sum) * W));
          const { bg, fg } = contribColor(i.points, maxAbs);
          const sign = i.points >= 0 ? "+" : "";
          // 格子太小就只留產業名，再小就整格留白——硬塞字會變成一團看不懂的色塊
          const showPts = w >= 70 && h >= 40;
          const showName = w >= 44 && h >= 22;
          const label = showName
            ? `<div style="font-size:${w >= 110 ? 13 : 11}px; font-weight:bold; line-height:1.25;">${i.name}</div>` +
              (showPts
                ? `<div style="font-size:${w >= 110 ? 15 : 12}px; line-height:1.3; margin-top:2px;">${sign}${i.points.toFixed(1)}</div>`
                : "")
            : "";
          return `<td width="${w}" height="${h}" valign="middle" align="center" style="width:${w}px; height:${h}px; background:${bg}; color:${fg}; border:1px solid #ffffff; overflow:hidden; padding:0 2px;" title="${i.name} ${sign}${i.points.toFixed(2)} 點">${label}</td>`;
        })
        .join("");
      return `<tr><td style="padding:0;"><table cellpadding="0" cellspacing="0" border="0" width="${W}" style="width:${W}px; border-collapse:collapse; table-layout:fixed;"><tbody><tr>${cells}</tr></tbody></table></td></tr>`;
    })
    .join("");

  return `<div style="overflow-x:auto; margin-bottom:12px;">
      <table cellpadding="0" cellspacing="0" border="0" width="${W}" style="width:${W}px; border-collapse:collapse;"><tbody>${rows}</tbody></table>
    </div>`;
}

function renderContribStockList(title: string, list: StockContribution[], positive: boolean): string {
  if (!list || list.length === 0) return "";
  const color = positive ? "#dc2626" : "#16a34a";
  const rows = list
    .map((s) => {
      const sign = s.points >= 0 ? "+" : "";
      const pctSign = s.pct >= 0 ? "+" : "";
      return `<tr>
        <td style="padding:3px 6px; white-space:nowrap;"><a href="https://tw.stock.yahoo.com/quote/${s.code}" style="color:#374151; text-decoration:none;">${s.code} ${s.name}</a></td>
        <td style="padding:3px 6px; text-align:right; color:#9ca3af; white-space:nowrap;">${pctSign}${s.pct.toFixed(2)}%</td>
        <td style="padding:3px 6px; text-align:right; font-weight:bold; color:${color}; white-space:nowrap;">${sign}${s.points.toFixed(2)}</td>
        <td style="padding:3px 6px; color:#9ca3af; white-space:nowrap;">${s.industry}</td>
      </tr>`;
    })
    .join("");
  return `<td width="50%" valign="top" style="padding:0 6px;">
      <div style="font-size:12px; font-weight:bold; color:#6b7280; margin-bottom:4px;">${title}</div>
      <table style="width:100%; border-collapse:collapse; font-size:12px;"><tbody>${rows}</tbody></table>
    </td>`;
}

/**
 * 貢獻傳導 Sankey：上漲／下跌貢獻 → 產業 → 個股，帶寬正比於點數。
 *
 * 為什麼要有這張圖：treemap 回答「哪個產業戰場最大」，但看不出「這個產業是被誰
 * 推動的」，也看不出上漲與下跌兩股力量各自流去哪裡。Sankey 把兩件事一次講完——
 * 帶子有多寬就是貢獻幾點，一眼就能比重。
 *
 * 這裡用 inline SVG，Gmail 會整段剝掉。所以它是「加分項」而非主體：下方的 treemap
 * 與表格都是純表格、信件裡照樣完整，讀者不會因為看不到這張圖而漏掉任何結論。
 *
 * 版面刻意維持淺色（跟報告其他區塊一致），沒有沿用交易終端的深色底。
 */
interface SankeyNode {
  id: string;
  col: 0 | 1 | 2;
  label: string;
  sub: string;
  value: number;
  sign: number; // 1 正貢獻 / -1 負貢獻 / 0 混合
  y: number;
  h: number;
  inOff: number;
  outOff: number;
}

interface SankeyLink {
  s: string;
  t: string;
  v: number;
  sign: number;
}

const SANKEY_RED = "#dc2626";
const SANKEY_GREEN = "#16a34a";
const SANKEY_GRAY = "#9ca3af";
const flowColor = (sign: number) => (sign > 0 ? SANKEY_RED : sign < 0 ? SANKEY_GREEN : SANKEY_GRAY);

function renderSankey(c: IndexContribution): string {
  const W = 790; // 第三欄標籤最長約到 x=770，再寬只是留白
  const H = 620;
  const PAD = 7; // 同欄節點之間的間距
  const NODE_W = 13;
  const COL_X = [78, 340, 622];
  const MAX_SECTORS = 10;
  const EXPAND_SHARE = 0.06; // 佔總戰場 6% 以上的產業才展開到個股，否則第三欄會爆掉
  const TOP_STOCKS = 3;

  const totalAbs = c.totals.abs;
  if (!(totalAbs > 0)) return "";

  // ---- 第二欄：產業。小產業合併成一個節點，總量守恆 ----
  const ranked = [...c.sectors].filter((s) => s.absPoints > 0).sort((a, b) => b.absPoints - a.absPoints);
  const major = ranked.slice(0, MAX_SECTORS).filter((s) => s.absPoints / totalAbs >= 0.015);
  const minor = ranked.filter((s) => !major.includes(s));
  type Mid = { key: string; name: string; abs: number; up: number; down: number; net: number; top: StockContribution[]; expandable: boolean };
  const mids: Mid[] = major.map((s) => ({
    key: s.name,
    name: s.name,
    abs: s.absPoints,
    up: s.upPoints,
    down: s.downPoints,
    net: s.points,
    top: s.top ?? [],
    expandable: true,
  }));
  if (minor.length > 0) {
    mids.push({
      key: "__minor__",
      name: `其他 ${minor.length} 產業`,
      abs: minor.reduce((a, s) => a + s.absPoints, 0),
      up: minor.reduce((a, s) => a + s.upPoints, 0),
      down: minor.reduce((a, s) => a + s.downPoints, 0),
      net: minor.reduce((a, s) => a + s.points, 0),
      top: [],
      expandable: false,
    });
  }
  // 上漲佔比高的排上面、被拖累的排下面，讓帶子少交叉
  mids.sort((a, b) => {
    const sa = a.up / (a.up + a.down || 1);
    const sb = b.up / (b.up + b.down || 1);
    return sb - sa || b.abs - a.abs;
  });

  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const push = (n: Omit<SankeyNode, "y" | "h" | "inOff" | "outOff">) =>
    nodes.push({ ...n, y: 0, h: 0, inOff: 0, outOff: 0 });

  const upTotal = c.totals.up;
  const downTotal = Math.abs(c.totals.down);
  push({ id: "UP", col: 0, label: "上漲貢獻", sub: `+${upTotal.toFixed(0)}`, value: upTotal, sign: 1 });
  push({ id: "DOWN", col: 0, label: "下跌貢獻", sub: `−${downTotal.toFixed(0)}`, value: downTotal, sign: -1 });

  for (const m of mids) {
    const sign = m.net > 0 ? 1 : m.net < 0 ? -1 : 0;
    push({
      id: `S:${m.key}`,
      col: 1,
      label: m.name,
      sub: `${m.net >= 0 ? "+" : "−"}${Math.abs(m.net).toFixed(1)}`,
      value: m.abs,
      sign,
    });
    if (m.up > 0) links.push({ s: "UP", t: `S:${m.key}`, v: m.up, sign: 1 });
    if (m.down > 0) links.push({ s: "DOWN", t: `S:${m.key}`, v: m.down, sign: -1 });
  }

  // ---- 第三欄：大產業展開到個股 ----
  for (const m of mids) {
    if (!m.expandable || m.abs / totalAbs < EXPAND_SHARE) continue;
    const picks = m.top.slice(0, TOP_STOCKS).filter((s) => Math.abs(s.points) > 0);
    if (picks.length === 0) continue;
    const ordered = [
      ...picks.filter((s) => s.points > 0).sort((a, b) => b.points - a.points),
      ...picks.filter((s) => s.points < 0).sort((a, b) => a.points - b.points),
    ];
    for (const s of ordered) {
      const id = `K:${m.key}:${s.code}`;
      push({
        id,
        col: 2,
        label: `${s.code} ${s.name}`,
        sub: `${s.points >= 0 ? "+" : "−"}${Math.abs(s.points).toFixed(1)}`,
        value: Math.abs(s.points),
        sign: s.points > 0 ? 1 : -1,
      });
      links.push({ s: `S:${m.key}`, t: id, v: Math.abs(s.points), sign: s.points > 0 ? 1 : -1 });
    }
    // 剩下的成分股併一格，帶寬才守恆（不然產業節點的流出量會憑空變少）
    const rest = m.abs - ordered.reduce((a, s) => a + Math.abs(s.points), 0);
    if (rest > totalAbs * 0.004) {
      const id = `K:${m.key}:rest`;
      push({ id, col: 2, label: "其他成分股", sub: "", value: rest, sign: 0 });
      links.push({ s: `S:${m.key}`, t: id, v: rest, sign: 0 });
    }
  }

  // ---- 版面：三欄各自等比例縮放後垂直置中，共用同一個 scale 才能比寬度 ----
  const byCol = [0, 1, 2].map((ci) => nodes.filter((n) => n.col === ci));
  const scale = Math.min(
    ...byCol
      .filter((col) => col.length > 0)
      .map((col) => {
        const total = col.reduce((a, n) => a + n.value, 0);
        return (H - (col.length - 1) * PAD) / total;
      }),
  );
  for (const col of byCol) {
    if (col.length === 0) continue;
    const colH = col.reduce((a, n) => a + n.value * scale, 0) + (col.length - 1) * PAD;
    let y = (H - colH) / 2;
    for (const n of col) {
      n.h = Math.max(1.5, n.value * scale);
      n.y = y;
      y += n.h + PAD;
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 連線依「目標節點的排列順序」決定出口高低，交叉才會最少
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  links.sort((a, b) => (order.get(a.s)! - order.get(b.s)!) || (order.get(a.t)! - order.get(b.t)!));

  const paths = links
    .map((l) => {
      const s = byId.get(l.s)!;
      const t = byId.get(l.t)!;
      const th = l.v * scale;
      const x0 = COL_X[s.col] + NODE_W;
      const x1 = COL_X[t.col];
      const y0 = s.y + s.outOff;
      const y1 = t.y + t.inOff;
      s.outOff += th;
      t.inOff += th;
      const mx = (x0 + x1) / 2;
      const d = `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1 + th} C${mx},${y1 + th} ${mx},${y0 + th} ${x0},${y0 + th} Z`;
      return `<path d="${d}" fill="${flowColor(l.sign)}" fill-opacity="0.3"/>`;
    })
    .join("");

  const rects = nodes
    .map(
      (n) =>
        `<rect x="${COL_X[n.col]}" y="${n.y.toFixed(1)}" width="${NODE_W}" height="${n.h.toFixed(1)}" fill="${flowColor(n.sign)}" rx="2"><title>${n.label} ${n.sub}</title></rect>`,
    )
    .join("");

  // 文字壓在帶子上，靠白色描邊（paint-order）讓它讀得出來
  const halo = 'style="paint-order:stroke; stroke:#ffffff; stroke-width:3px; stroke-linejoin:round;"';
  const labels = nodes
    .map((n) => {
      const cy = n.y + n.h / 2;
      const small = n.h < 13;
      if (n.col === 0) {
        return `<text x="${COL_X[0] - 8}" y="${cy - 4}" text-anchor="end" font-size="13" font-weight="bold" fill="#374151" ${halo}>${n.label}</text>` +
          `<text x="${COL_X[0] - 8}" y="${cy + 12}" text-anchor="end" font-size="13" font-weight="bold" fill="${flowColor(n.sign)}" ${halo}>${n.sub}</text>`;
      }
      const x = COL_X[n.col] + NODE_W + 6;
      const fs = n.col === 1 ? 12 : 11;
      if (small) {
        // 節點太薄，名稱與數字並排一行，否則兩行會疊到隔壁
        return `<text x="${x}" y="${cy + 3.5}" font-size="${fs}" fill="#4b5563" ${halo}>${n.label} <tspan fill="${flowColor(n.sign)}" font-weight="bold">${n.sub}</tspan></text>`;
      }
      return `<text x="${x}" y="${cy - 2}" font-size="${fs}" font-weight="${n.col === 1 ? "bold" : "normal"}" fill="#374151" ${halo}>${n.label}</text>` +
        `<text x="${x}" y="${cy + 11}" font-size="${fs}" font-weight="bold" fill="${flowColor(n.sign)}" ${halo}>${n.sub}</text>`;
    })
    .join("");

  const headers = ["資金方向", "產業", "主要個股"]
    .map((t, i) => `<text x="${i === 0 ? COL_X[0] - 8 : COL_X[i] + NODE_W + 6}" y="-8" text-anchor="${i === 0 ? "end" : "start"}" font-size="11" fill="#9ca3af">${t}</text>`)
    .join("");

  return `<div style="overflow-x:auto; margin-bottom:6px;">
      <svg width="${W}" height="${H + 24}" viewBox="0 -20 ${W} ${H + 24}" style="width:${W}px; max-width:none; font-family:sans-serif;" role="img" aria-label="指數貢獻傳導圖">
        ${headers}${paths}${rects}${labels}
      </svg>
    </div>`;
}

function renderIndexContribution(c: IndexContribution | null | undefined): string {
  if (!c || !c.sectors || c.sectors.length === 0) return "";
  const { index, totals } = c;
  const up = index.change >= 0;
  const idxColor = up ? "#dc2626" : "#16a34a";

  // 產業表只列有感的（≥0.5 點），其餘折成一行摘要，避免 30 幾列把重點稀釋掉。
  const shown = c.sectors.filter((s) => Math.abs(s.points) >= 0.5);
  const hidden = c.sectors.length - shown.length;
  const sectorRows = shown
    .map((s) => {
      const sign = s.points >= 0 ? "+" : "";
      const color = s.points >= 0 ? "#dc2626" : "#16a34a";
      const share = totals.abs > 0 ? (s.absPoints / totals.abs) * 100 : 0;
      const tops = s.top
        .slice(0, 3)
        .map((t) => `${t.name} ${t.points >= 0 ? "+" : ""}${t.points.toFixed(1)}`)
        .join("、");
      return `<tr style="border-top:1px solid #f3f4f6;">
        <td style="padding:4px 8px; white-space:nowrap;">${s.name}<span style="color:#d1d5db; font-size:11px;"> ${s.count}檔</span></td>
        <td style="padding:4px 8px; text-align:right; font-weight:bold; color:${color}; white-space:nowrap;">${sign}${s.points.toFixed(2)}</td>
        <td style="padding:4px 8px; text-align:right; color:#9ca3af; white-space:nowrap;">${share.toFixed(1)}%</td>
        <td style="padding:4px 8px; color:#6b7280; font-size:11px;">${tops}</td>
      </tr>`;
    })
    .join("");

  const hiddenNote = hidden > 0
    ? `<div style="font-size:11px; color:#9ca3af; margin-top:4px;">另有 ${hidden} 個產業貢獻不足 0.5 點，未列出。</div>`
    : "";

  return `<div style="background-color:#fffbeb; border:1px solid #fde68a; padding:15px; border-radius:8px; margin-bottom:20px;">
      <h3 style="margin-top:0; color:#b45309;">⚖️ 指數貢獻拆解</h3>
      <p style="font-size:13px; color:#4b5563; margin:0 0 10px; line-height:1.7;">
        加權指數收 <strong>${index.close.toLocaleString()}</strong>
        <span style="color:${idxColor}; font-weight:bold;">${up ? "+" : ""}${index.change.toFixed(2)} 點</span>，
        拆成
        <span style="color:#dc2626; font-weight:bold;">上漲貢獻 +${totals.up.toFixed(0)} 點</span>
        與 <span style="color:#16a34a; font-weight:bold;">下跌貢獻 ${totals.down.toFixed(0)} 點</span>。
        兩邊互相對沖掉 <strong>${totals.offset.toFixed(0)} 點</strong>——這是只看指數完全看不到的內部廝殺。
      </p>
      <div style="font-size:12px; color:#6b7280; font-weight:bold; margin-bottom:2px;">
        貢獻傳導（帶寬＝點數，紅＝推升、綠＝拖累）
      </div>
      <div style="font-size:11px; color:#9ca3af; margin-bottom:6px;">
        由左往右看：當日的推升與拖累力道，各自流進哪些產業、又由哪幾檔撐起來。帶子愈寬代表點數愈多。
        三個看點：<strong>左右兩根柱子誰高</strong>（多空力量對比）、
        <strong>哪個產業同時接到紅帶與綠帶</strong>（內部多空互打，方向未定）、
        <strong>產業的帶子是不是集中在一兩檔</strong>（集中＝個股事件，分散＝真的族群動能）。
      </div>
      ${renderSankey(c)}
      <div style="font-size:11px; color:#9ca3af; margin:0 0 14px;">
        這張流向圖是 SVG，Email 用戶端多半不支援而不會顯示；下方的分布圖與表格是純表格，信件裡照樣完整。
        要看流向圖請開 <a href="${SITE_URL}" style="color:#b45309; font-weight:bold;">→ 網頁版報告</a>。
      </div>
      <div style="font-size:12px; color:#6b7280; font-weight:bold; margin-bottom:6px;">
        產業貢獻分布（面積＝絕對貢獻，紅＝推升、綠＝拖累）
      </div>
      ${renderTreemap(c.sectors)}
      <table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:12px;">
        <thead><tr style="color:#9ca3af; font-size:11px;">
          <th style="padding:2px 8px; text-align:left;">產業</th>
          <th style="padding:2px 8px; text-align:right;">淨貢獻</th>
          <th style="padding:2px 8px; text-align:right;">佔戰場</th>
          <th style="padding:2px 8px; text-align:left;">主要來源</th>
        </tr></thead>
        <tbody>${sectorRows}</tbody>
      </table>
      ${hiddenNote}
      <table style="width:100%; border-collapse:collapse; margin-top:10px;"><tbody><tr>
        ${renderContribStockList("推升最多", c.topGainers, true)}
        ${renderContribStockList("拖累最多", c.topLosers, false)}
      </tr></tbody></table>
      <div style="font-size:11px; color:#9ca3af; margin-top:10px; line-height:1.6;">
        個股貢獻點數 ＝ 漲跌價差 × 發行股數 ÷ 昨日總市值 × 昨日指數；納入 ${c.coverage.matched} 檔上市普通股
        （ETF、權證等非指數成分已排除）。發行股數為 MOPS 月更資料，且特別股／私募股／全額交割股無法從公開資料剝離，
        故原始加總與交易所公佈值有落差，已用係數 ${c.calibration} 整體校準，總數精確、個股相對比重不受影響。
        僅涵蓋上市，不含上櫃。
      </div>
    </div>`;
}

/**
 * 族群輪動（RRG）區塊：先圖後結論——上方是可切換 120/60/20 日的互動圖，下方才是
 * 象限分佈與異動判讀（不看圖也拿得到結論）。
 *
 * 互動圖本身不在這裡產生：這裡只留 <!--RRG_EMBED--> 佔位，發佈網站時由
 * build-site-html.ts 把 data/tw-rrg-embed.html 整段塞進來（沒有 iframe、沒有子頁）。
 * Email 沒有 JS，佔位符會維持空白，所以一定要保留下方文字結論與網頁版連結當退路。
 */
function renderRrg(rrg: RrgBlock | null | undefined): string {
  if (!rrg || !rrg.quadrants) return "";
  const { asOf, mainWindow, quadrants, regime, alerts } = rrg;

  // 象限分佈：領先/改善 用紅（強）、弱化/落後 用綠（弱），與報告其餘部分的漲跌配色一致
  const quadMeta: Record<string, { color: string; bg: string; desc: string }> = {
    領先: { color: "#dc2626", bg: "#fef2f2", desc: "強於大盤且動能向上" },
    改善: { color: "#2563eb", bg: "#eff6ff", desc: "仍弱於大盤但動能翻正" },
    弱化: { color: "#d97706", bg: "#fffbeb", desc: "仍強於大盤但動能轉負" },
    落後: { color: "#16a34a", bg: "#f0fdf4", desc: "弱於大盤且動能向下" },
  };
  const quadHtml = ["領先", "改善", "弱化", "落後"]
    .map((q) => {
      const m = quadMeta[q];
      const list = quadrants[q] ?? [];
      return `<tr>
        <td style="padding:6px 8px; white-space:nowrap; vertical-align:top;">
          <span style="display:inline-block; background:${m.bg}; color:${m.color}; border:1px solid ${m.color}33; border-radius:4px; padding:2px 8px; font-weight:bold;">${q}</span>
          <span style="color:#9ca3af; font-size:11px;"> ${list.length}</span>
        </td>
        <td style="padding:6px 8px; font-size:13px; color:#374151;">${list.join("、") || "—"}<div style="color:#9ca3af; font-size:11px; margin-top:2px;">${m.desc}</div></td>
      </tr>`;
    })
    .join("");

  const sevMeta: Record<string, { color: string; label: string }> = {
    high: { color: "#dc2626", label: "重要" },
    medium: { color: "#d97706", label: "留意" },
    low: { color: "#6b7280", label: "參考" },
  };
  const alertsHtml = alerts.length
    ? alerts
        .map((al) => {
          const m = sevMeta[al.severity] ?? sevMeta.low;
          return `<div style="border-left:3px solid ${m.color}; padding:6px 0 6px 10px; margin-bottom:10px;">
            <div style="font-size:13px;">
              <span style="color:${m.color}; font-weight:bold;">[${m.label}]</span>
              <strong style="color:#1f2937;"> ${al.sector}</strong>
              <span style="color:#6b7280;"> — ${al.kind}</span>
            </div>
            <div style="font-size:12px; color:#4b5563; line-height:1.6; margin-top:3px;">${al.detail}</div>
          </div>`;
        })
        .join("")
    : `<p style="font-size:13px; color:#6b7280; margin:0;">今日無明顯象限異動。</p>`;

  // 市場狀態：多族群同時觸發同一訊號時的收斂結論，避免個別訊號被雜訊淹沒
  const regimeHtml = regime.length
    ? `<div style="background:#f9fafb; border:1px dashed #d1d5db; border-radius:6px; padding:10px 12px; margin-bottom:14px;">
        <div style="font-size:12px; color:#6b7280; font-weight:bold; margin-bottom:6px;">📐 市場狀態（多族群同時出現，屬大盤特徵而非個別族群訊號）</div>
        ${regime
          .map(
            (r) =>
              `<div style="font-size:12px; color:#4b5563; line-height:1.6; margin-bottom:4px;">・<strong>${r.kind}</strong>（${r.sectors.length} 個族群）：${r.note}</div>`,
          )
          .join("")}
      </div>`
    : "";

  return `<div style="background-color:#faf5ff; border:1px solid #e9d5ff; padding:15px; border-radius:8px; margin-bottom:20px;">
      <h3 style="margin-top:0; color:#7e22ce;">🔄 族群輪動 RRG</h3>
      <p style="font-size:12px; color:#6b7280; margin:0 0 10px;">
        以加權指數為基準、${mainWindow} 日視窗計算相對強弱與動能，資料截至 <strong>${asOf}</strong>。
        族群成分是固定籃子（與每日分類分開維護），所以軌跡可跨日比較。
      </p>
      <!--RRG_EMBED-->
      <p style="font-size:11px; color:#9ca3af; margin:0 0 14px;">
        圖上方可切換四個市場（台股族群／全球資產／美股板塊／全球市場）、120／60／20 日視窗與軌跡長度；
        勾選框控制是否畫在圖上，點族群名稱可展開成分股並連到 Yahoo 股市。
        Email 版不會顯示互動圖，請開
        <a href="${SITE_URL}" style="color:#7e22ce; font-weight:bold;">→ 網頁版報告</a>的「🔄 族群輪動」分頁；
        下方文字結論不看圖也讀得懂（結論只針對台股族群）。
      </p>
      <table style="width:100%; border-collapse:collapse; margin-bottom:14px;"><tbody>${quadHtml}</tbody></table>
      ${regimeHtml}
      <div style="font-size:12px; color:#6b7280; font-weight:bold; margin-bottom:8px;">🔔 值得注意的異動（近 5 個交易日）</div>
      ${alertsHtml}
    </div>`;
}

/** build-tdcc-divergence.ts 的輸出（data/tdcc-divergence-latest.json） */
interface DivergenceRow {
  code: string;
  name: string;
  market: "twse" | "tpex";
  cum: number;
  dCum: number;
  dHolders: number;
  pricePct: number;
  price20: number | null;
  aboveMa20: boolean | null;
  avgTop: number;
  dAvgTop: number;
  byLevel: Record<string, number>;
  score: number;
  lots: number;
  close: number;
  dilutionRisk: boolean;
  streak: number;
}

interface DivergenceView {
  key: string;
  label: string;
  desc: string;
  byCutoff: Record<string, DivergenceRow[]>;
}

interface DivergenceReport {
  generatedAt: string;
  curDate: string;
  prevDate: string;
  curWeek: string;
  prevWeek: string;
  universe: number;
  partial: boolean;
  hasLevels: boolean;
  filters: { minLots: number; minPrice: number; divergeMaxGain: number; divergeMinChange: number };
  cutoffs: { key: string; lots: number; label: string }[];
  views: DivergenceView[];
  defaults: { view: string; cutoff: string };
}

/** 一列榜單。web 版的 JS 會用同一套欄位順序重畫，改這裡要同步改下方的 renderRow。 */
function tdccRowHtml(r: DivergenceRow, i: number): string {
  const cumColor = r.dCum > 0 ? "#dc2626" : "#16a34a";
  const priceColor = r.pricePct > 0 ? "#dc2626" : r.pricePct < 0 ? "#16a34a" : "#6b7280";
  const mkt = r.market === "twse" ? "上市" : "上櫃";
  const badge = (bg: string, fg: string, text: string, title: string) =>
    `<span title="${title}" style="display:inline-block; background:${bg}; color:${fg}; font-size:10px; border-radius:3px; padding:0 4px; margin-left:4px;">${text}</span>`;
  const flags =
    (r.streak >= 2 ? badge("#fef3c7", "#92400e", `連${r.streak}週`, "連續多週增加") : "") +
    (r.dilutionRisk
      ? badge("#fee2e2", "#991b1b", "股數變動?", "比例上升但大戶人數沒增加，可能是除權息／現增造成的股數變動，不是有人買進")
      : "") +
    (r.aboveMa20 ? badge("#dbeafe", "#1e40af", "站上20MA", "收盤在 20 日均線之上") : "");
  const p20 =
    r.price20 === null
      ? `<span style="color:#d1d5db;">—</span>`
      : `<span style="color:${r.price20 > 0 ? "#dc2626" : r.price20 < 0 ? "#16a34a" : "#6b7280"};">${r.price20 >= 0 ? "+" : ""}${r.price20.toFixed(1)}%</span>`;
  return `<tr style="border-top:1px solid #f3f4f6;">
    <td style="padding:4px 6px; color:#9ca3af; text-align:right;">${i + 1}</td>
    <td style="padding:4px 6px; white-space:nowrap;">
      <a href="https://tw.stock.yahoo.com/quote/${r.code}" style="color:#374151; text-decoration:none; font-weight:bold;">${r.code} ${r.name}</a>
      <span style="color:#d1d5db; font-size:10px;"> ${mkt}</span>${flags}
    </td>
    <td style="padding:4px 6px; text-align:right; color:#6b7280; white-space:nowrap;">${r.close.toLocaleString()}</td>
    <td style="padding:4px 6px; text-align:right; color:${priceColor}; white-space:nowrap;">${r.pricePct >= 0 ? "+" : ""}${r.pricePct.toFixed(1)}%</td>
    <td style="padding:4px 6px; text-align:right; white-space:nowrap;">${p20}</td>
    <td style="padding:4px 6px; text-align:right; font-weight:bold; color:${cumColor}; white-space:nowrap;">${r.dCum >= 0 ? "+" : ""}${r.dCum.toFixed(2)}</td>
    <td style="padding:4px 6px; text-align:right; color:#9ca3af; white-space:nowrap;">${r.cum.toFixed(1)}%</td>
    <td style="padding:4px 6px; text-align:right; color:${r.dHolders > 0 ? "#dc2626" : "#9ca3af"}; white-space:nowrap;">${r.dHolders >= 0 ? "+" : ""}${r.dHolders}</td>
    <td style="padding:4px 6px; text-align:right; color:${r.dAvgTop > 0 ? "#dc2626" : r.dAvgTop < 0 ? "#16a34a" : "#d1d5db"}; white-space:nowrap;">${r.avgTop > 0 ? `${r.avgTop.toLocaleString()}<span style="color:#d1d5db; font-size:10px;">${r.dAvgTop >= 0 ? "+" : ""}${r.dAvgTop}</span>` : "—"}</td>
  </tr>`;
}

/**
 * 大戶籌碼分頁：兩種視角 × 五種門檻，可切換。
 *
 * 這是**週資料**（TDCC 每週五結算、週六才拿得到），所以同一份榜單會在報告裡連續
 * 出現好幾天，直到下週六更新。標題會標出資料週期，避免誤以為是當日資料。
 *
 * **為什麼只有預設組合是伺服器端渲染、其他組合走 JSON + JS**：
 * 2 視角 × 5 門檻 × 20 檔 = 200 列 HTML，全部展開約 160KB，會超過 Gmail 102KB 的
 * 截斷門檻，信件會被切掉尾巴。改成只渲染預設那張表、其餘壓成精簡 JSON（短 key）
 * 由 JS 現畫，信件端只看到一張完整的表，網頁端才有切換器。
 *
 * 切換器本身預設 `display:none`，由 JS 打開——沒有 JS 的信件不會出現一排點不動的按鈕。
 */
function renderTdcc(d: DivergenceReport | null | undefined): string {
  if (!d || !d.views || d.views.length === 0) return "";
  const defView = d.views.find((v) => v.key === d.defaults.view) ?? d.views[0];
  const defCut = d.cutoffs.find((c) => c.key === d.defaults.cutoff) ?? d.cutoffs[0];
  const defRows = defView.byCutoff[defCut.key] ?? [];
  if (defRows.length === 0) return "";

  // 精簡 key，控制信件體積
  const payload = {
    v: d.views.map((v) => ({
      k: v.key,
      l: v.label,
      d: v.desc,
      c: Object.fromEntries(
        Object.entries(v.byCutoff).map(([ck, rows]) => [
          ck,
          rows.map((r) => [
            r.code, r.name, r.market === "twse" ? 1 : 0, r.close, r.pricePct,
            r.price20, r.dCum, r.cum, r.dHolders, r.avgTop, r.dAvgTop,
            r.streak, r.dilutionRisk ? 1 : 0, r.aboveMa20 ? 1 : 0,
          ]),
        ]),
      ),
    })),
    c: d.cutoffs,
  };

  const btn = (active: boolean) =>
    `display:inline-block; padding:3px 10px; margin:0 4px 4px 0; border-radius:12px; font-size:11px; cursor:pointer; border:1px solid ${active ? "#15803d" : "#d1d5db"}; background:${active ? "#15803d" : "#fff"}; color:${active ? "#fff" : "#6b7280"};`;

  const viewBtns = d.views
    .map((v) => `<span class="tdcc-view" data-k="${v.key}" style="${btn(v.key === defView.key)}">${v.label}</span>`)
    .join("");
  const cutBtns = d.cutoffs
    .map((c) => `<span class="tdcc-cut" data-k="${c.key}" style="${btn(c.key === defCut.key)}">${c.label}</span>`)
    .join("");

  const partialNote = d.partial
    ? `<div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:8px 10px; font-size:11px; color:#991b1b; line-height:1.6; margin-bottom:10px;">
        ⚠️ 這期的對照週是<strong>限定範圍回補</strong>的快照（只涵蓋流動性前段的個股，非全市場），
        所以榜單看不到未被回補的股票。等每週快照自然累積後就會恢復全市場比較。
      </div>`
    : "";

  return `<div style="background-color:#f0fdf4; border:1px solid #bbf7d0; padding:15px; border-radius:8px; margin-bottom:20px;">
      <h3 style="margin-top:0; color:#15803d;">🏦 大戶籌碼</h3>
      <p style="font-size:13px; color:#4b5563; margin:0 0 10px; line-height:1.7;">
        比較 <strong>${d.prevDate}</strong>（${d.prevWeek}）→ <strong>${d.curDate}</strong>（${d.curWeek}）兩週的集保持股分級，
        比較範圍 ${d.universe} 檔（成交 ≥${d.filters.minLots} 張、股價 ≥${d.filters.minPrice} 元）。
      </p>
      <div class="tdcc-ctrl" style="display:none; margin-bottom:10px;">
        <div style="font-size:11px; color:#9ca3af; margin-bottom:3px;">視角</div>
        <div>${viewBtns}</div>
        <div style="font-size:11px; color:#9ca3af; margin:6px 0 3px;">大戶門檻</div>
        <div>${cutBtns}</div>
      </div>
      <div class="tdcc-desc" style="font-size:12px; color:#4b5563; background:#fff; border-radius:6px; padding:8px 10px; line-height:1.7; margin-bottom:10px;">${defView.desc}</div>
      <div style="font-size:11px; color:#6b7280; line-height:1.7; margin-bottom:10px;">
        <strong>怎麼看</strong>：「大戶增減」是<span style="color:#15803d; font-weight:bold;">該門檻以上全部級距的累計比例</span>週變化——
        用累計而不是單一級距，是因為 900 張的人加碼到 1100 張會跨級，只看某一級會把加碼誤讀成減碼。
        「大戶人數」同步增加才代表真的有新的人進場；比例漲但人數沒動會標「股數變動?」。
        「千張均張」是級 15 的平均每人持股張數——TDCC 沒有更高的分級，這是判斷「超大戶是否在集中」最接近的指標。
        <strong>這是觀察名單，不是買賣訊號</strong>。
      </div>
      ${partialNote}
      <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12px; min-width:680px;">
        <thead><tr style="color:#9ca3af; font-size:11px;">
          <th style="padding:2px 6px; text-align:right;">#</th>
          <th style="padding:2px 6px; text-align:left;">個股</th>
          <th style="padding:2px 6px; text-align:right;">收盤</th>
          <th style="padding:2px 6px; text-align:right;" title="兩份快照之間的收盤價變化">週漲跌</th>
          <th style="padding:2px 6px; text-align:right;" title="近 20 個交易日漲跌幅">20日</th>
          <th class="tdcc-h-d" style="padding:2px 6px; text-align:right;" title="該門檻以上累計持股比例的週增減（百分點）">${defCut.label}增減</th>
          <th class="tdcc-h-c" style="padding:2px 6px; text-align:right;" title="該門檻以上累計持股比例">總計</th>
          <th style="padding:2px 6px; text-align:right;" title="該門檻涵蓋級距的持有人數週增減">人數</th>
          <th style="padding:2px 6px; text-align:right;" title="級15（1000張以上）平均每人持股張數與其週增減">千張均張</th>
        </tr></thead>
        <tbody class="tdcc-body">${defRows.map((r, i) => tdccRowHtml(r, i)).join("")}</tbody>
      </table>
      </div>
      <div class="tdcc-empty" style="display:none; font-size:12px; color:#9ca3af; padding:12px 0;">這個門檻與視角的組合本週沒有符合條件的個股。</div>
      <div style="font-size:11px; color:#9ca3af; margin-top:10px; line-height:1.6;">
        資料源：集保結算所「集保戶股權分散表」，每週五結算、隔天公布，所以這份榜單一週更新一次。
        排序用標準化分數（z-score）而非絕對門檻——大型股大戶比例週變動 1% 已是巨量、小型股 1% 只是雜訊，
        絕對門檻會讓榜單被小型股洗版。信件版只呈現「${defView.label} × ${defCut.label}」，其餘組合請看網頁版。
      </div>
      <script type="application/json" class="tdcc-data">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
      <script>
      (function(){
        var root=document.currentScript&&document.currentScript.parentNode; if(!root) return;
        var raw=root.querySelector('.tdcc-data'); if(!raw) return;
        var D=JSON.parse(raw.textContent), view='${defView.key}', cut='${defCut.key}';
        var ctrl=root.querySelector('.tdcc-ctrl'); if(ctrl) ctrl.style.display='block';
        var body=root.querySelector('.tdcc-body'), desc=root.querySelector('.tdcc-desc');
        var empty=root.querySelector('.tdcc-empty'), table=body.parentNode;
        var hD=root.querySelector('.tdcc-h-d');
        function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
        function col(v){return v>0?'#dc2626':v<0?'#16a34a':'#6b7280'}
        function badge(bg,fg,t){return '<span style="display:inline-block;background:'+bg+';color:'+fg+';font-size:10px;border-radius:3px;padding:0 4px;margin-left:4px;">'+t+'</span>'}
        function row(r,i){
          var f=(r[11]>=2?badge('#fef3c7','#92400e','連'+r[11]+'週'):'')+(r[12]?badge('#fee2e2','#991b1b','股數變動?'):'')+(r[13]?badge('#dbeafe','#1e40af','站上20MA'):'');
          var p20=r[5]===null?'<span style="color:#d1d5db;">—</span>':'<span style="color:'+col(r[5])+';">'+(r[5]>=0?'+':'')+r[5].toFixed(1)+'%</span>';
          var av=r[9]>0?r[9].toLocaleString()+'<span style="color:#d1d5db;font-size:10px;">'+(r[10]>=0?'+':'')+r[10]+'</span>':'—';
          var td='padding:4px 6px;text-align:right;white-space:nowrap;';
          return '<tr style="border-top:1px solid #f3f4f6;">'+
            '<td style="padding:4px 6px;color:#9ca3af;text-align:right;">'+(i+1)+'</td>'+
            '<td style="padding:4px 6px;white-space:nowrap;"><a href="https://tw.stock.yahoo.com/quote/'+r[0]+'" style="color:#374151;text-decoration:none;font-weight:bold;">'+r[0]+' '+esc(r[1])+'</a><span style="color:#d1d5db;font-size:10px;"> '+(r[2]?'上市':'上櫃')+'</span>'+f+'</td>'+
            '<td style="'+td+'color:#6b7280;">'+r[3].toLocaleString()+'</td>'+
            '<td style="'+td+'color:'+col(r[4])+';">'+(r[4]>=0?'+':'')+r[4].toFixed(1)+'%</td>'+
            '<td style="'+td+'">'+p20+'</td>'+
            '<td style="'+td+'font-weight:bold;color:'+col(r[6])+';">'+(r[6]>=0?'+':'')+r[6].toFixed(2)+'</td>'+
            '<td style="'+td+'color:#9ca3af;">'+r[7].toFixed(1)+'%</td>'+
            '<td style="'+td+'color:'+(r[8]>0?'#dc2626':'#9ca3af')+';">'+(r[8]>=0?'+':'')+r[8]+'</td>'+
            '<td style="'+td+'color:'+(r[10]>0?'#dc2626':r[10]<0?'#16a34a':'#d1d5db')+';">'+av+'</td></tr>';
        }
        function paint(){
          var v=null,i; for(i=0;i<D.v.length;i++) if(D.v[i].k===view) v=D.v[i];
          if(!v) return;
          var rows=(v.c[cut]||[]);
          desc.textContent=v.d;
          var cl=''; for(i=0;i<D.c.length;i++) if(D.c[i].key===cut) cl=D.c[i].label;
          if(hD) hD.textContent=cl+'增減';
          body.innerHTML=rows.map(row).join('');
          table.parentNode.style.display=rows.length?'':'none';
          empty.style.display=rows.length?'none':'block';
          [].forEach.call(root.querySelectorAll('.tdcc-view'),function(b){mark(b,b.getAttribute('data-k')===view)});
          [].forEach.call(root.querySelectorAll('.tdcc-cut'),function(b){mark(b,b.getAttribute('data-k')===cut)});
        }
        function mark(b,on){b.style.borderColor=on?'#15803d':'#d1d5db';b.style.background=on?'#15803d':'#fff';b.style.color=on?'#fff':'#6b7280';}
        [].forEach.call(root.querySelectorAll('.tdcc-view'),function(b){b.onclick=function(){view=b.getAttribute('data-k');paint()}});
        [].forEach.call(root.querySelectorAll('.tdcc-cut'),function(b){b.onclick=function(){cut=b.getAttribute('data-k');paint()}});
      })();
      </script>
    </div>`;
}

// ---------- 終極選股池（build-stock-picks.ts 的輸出） ----------

interface PickSignal { label: string; detail: string; tone: "pos" | "neg" }
interface PickEntry {
  rank: number;
  code: string;
  name: string;
  close: number;
  score: number;
  type: string;
  sector: string | null;
  reason: string;
  signals: PickSignal[];
  plan: { entry: string; stop: string; exit: string };
  metrics: Record<string, string>;
}
interface PicksReport {
  generatedAt: string;
  date: string;
  basis: { tdccWeek?: string | null; cbWeek?: string | null; rrgAsOf?: string | null; priceHistoryDays?: number };
  regimeNotes: string[];
  long: PickEntry[];
  short: PickEntry[];
}

/**
 * 終極選股池分頁：長線 10 檔＋短線 10 檔，各自一張理由表格。
 * 版面策略——20 檔全攤開會太擠，所以每張榜單先給「可一眼掃完」的表格
 * （代號/收盤/分數/型態/一句話理由），個股完整訊號與進出場計畫收進
 * 每檔一個 <details>，要看再點開。信件版沒有可靠的 <details> 支援，
 * 只出表格、明細導去網頁版。
 */
function renderPicks(picks: PicksReport | null, forEmail: boolean): string {
  if (!picks || (!picks.long.length && !picks.short.length)) return "";

  const metricLabel: Record<string, string> = {
    r10: "近兩週", r20: "近一月", ma10: "MA10", ma20: "MA20", high20: "20日高",
    dayTrade: "當沖比", instNet: "法人買賣超", quadrant: "RRG 族群", tdcc: "集保大戶", cb: "CB+設質",
  };

  const table = (list: PickEntry[], accent: string): string => {
    const rows = list
      .map((p) => {
        const badges = p.signals
          .filter((s) => s.tone === "pos")
          .slice(0, 4)
          .map((s) => `<span style="background:#eef2ff; color:#4f46e5; border-radius:10px; padding:1px 6px; font-size:11px; white-space:nowrap; margin-right:3px;">${s.label}</span>`)
          .join("");
        const warn = p.signals.filter((s) => s.tone === "neg").map((s) => s.label).join("、");
        return `<tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:6px 8px; color:#9ca3af; text-align:center;">${p.rank}</td>
          <td style="padding:6px 8px; white-space:nowrap;"><strong style="color:#1f2937;">${p.name}</strong> <span style="color:#9ca3af; font-size:12px;">${p.code}</span></td>
          <td style="padding:6px 8px; text-align:right; white-space:nowrap;">${p.close}</td>
          <td style="padding:6px 8px; text-align:center;"><span style="background:${accent}; color:#fff; border-radius:10px; padding:1px 8px; font-weight:bold; font-size:12px;">${p.score}</span></td>
          <td style="padding:6px 8px; white-space:nowrap; font-size:12px; color:#6b7280;">${p.type}</td>
          <td style="padding:6px 8px; font-size:12px; line-height:1.6; color:#4b5563;">${badges}${badges ? "<br>" : ""}${p.reason}${warn ? `<br><span style="color:#b45309;">⚠ ${warn}</span>` : ""}</td>
        </tr>`;
      })
      .join("");
    return `<div style="overflow-x:auto;"><table style="border-collapse:collapse; width:100%; font-size:13px; min-width:560px;">
      <tr style="color:#6b7280; font-size:12px; text-align:left;">
        <th style="padding:4px 8px;">#</th><th style="padding:4px 8px;">個股</th><th style="padding:4px 8px; text-align:right;">收盤</th><th style="padding:4px 8px;">分數</th><th style="padding:4px 8px;">型態</th><th style="padding:4px 8px;">入選理由</th>
      </tr>${rows}</table></div>`;
  };

  const detailBlocks = (list: PickEntry[]): string =>
    list
      .map((p) => {
        const sigRows = p.signals
          .map((s) => `<li style="color:${s.tone === "pos" ? "#166534" : "#b45309"};"><strong>${s.label}</strong>：${s.detail}</li>`)
          .join("");
        const mRows = Object.entries(p.metrics)
          .filter(([, v]) => v && v !== "—")
          .map(([k, v]) => `<span style="display:inline-block; margin:0 12px 3px 0; white-space:nowrap;"><span style="color:#9ca3af;">${metricLabel[k] ?? k}</span> <strong style="color:#374151;">${v}</strong></span>`)
          .join("");
        return `<details style="border:1px solid #e5e7eb; border-radius:6px; margin-bottom:6px; background:#fff;">
        <summary style="cursor:pointer; padding:8px 12px; font-size:13px; user-select:none;"><strong>${p.rank}. ${p.name}</strong> <span style="color:#9ca3af;">${p.code}</span> · ${p.score} 分 · ${p.type} <span style="color:#9ca3af; font-size:12px;">— 點開看訊號明細與進出場</span></summary>
        <div style="padding:4px 14px 12px; font-size:13px; line-height:1.7;">
          <ul style="margin:6px 0; padding-left:18px;">${sigRows}</ul>
          <div style="background:#f8fafc; border-radius:6px; padding:8px 10px; margin:8px 0;">
            <div>🎯 <strong>進場</strong>：${p.plan.entry}</div>
            <div>🛑 <strong>停損</strong>：${p.plan.stop}</div>
            <div>🚪 <strong>出場</strong>：${p.plan.exit}</div>
          </div>
          <div style="font-size:12px;">${mRows}</div>
        </div>
      </details>`;
      })
      .join("");

  const listSection = (title: string, hint: string, list: PickEntry[], accent: string, border: string, bg: string): string => {
    if (!list.length) return "";
    return `<div style="background:${bg}; border:1px solid ${border}; border-radius:8px; padding:12px 14px; margin-bottom:16px;">
      <h3 style="margin:0 0 4px; color:#1f2937; font-size:15px;">${title}</h3>
      <p style="font-size:12px; color:#6b7280; margin:0 0 8px; line-height:1.6;">${hint}</p>
      ${table(list, accent)}
      ${forEmail ? `<p style="font-size:12px; color:#9ca3af; margin:8px 0 0;">個股訊號明細與進出場計畫請開網頁版。</p>` : `<div style="margin-top:10px;">${detailBlocks(list)}</div>`}
    </div>`;
  };

  const regime = picks.regimeNotes.length
    ? `<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:8px 12px; font-size:12px; color:#92400e; line-height:1.7; margin-bottom:12px;"><strong>大盤狀態提醒</strong>（來自族群輪動）：${picks.regimeNotes.map((n) => `<div>· ${n}</div>`).join("")}<div>出現「大盤全面回檔」特徵時，以下新倉建議減半。</div></div>`
    : "";

  const basis = picks.basis;
  return `<div style="background-color:#f8fafc; border:1px solid #e2e8f0; padding:15px; border-radius:8px; margin-bottom:20px;">
    <h3 style="margin-top:0; color:#334155;">🏆 終極選股池（${picks.date}）</h3>
    <p style="font-size:13px; color:#4b5563; line-height:1.7; margin:0 0 10px;">
      把大戶籌碼、CB+設質、法人買賣超、族群輪動、當日分類與價格動能<strong>五路訊號統合到個股層級</strong>打分。
      進榜門檻：至少兩個獨立資料源同時給正訊號（共振），單一訊號再強都只算噪音。
      分數是排序用的相對值，不同天之間不可直接比大小。
    </p>
    ${regime}
    ${listSection(
      "🐢 長線波段 Top 10（3 個月～1 年）",
      "吃「結構性籌碼」：大戶默默累積、公司派有作價動機、族群在中期輪動的順風處。多為背離佈局型——買點靠等，不靠追。",
      picks.long, "#0d9488", "#99f6e4", "#f0fdfa",
    )}
    ${listSection(
      "⚡ 短線動能 Top 10（2 週～1 個月）",
      "吃「資金正在青睞」：相對強度前段、法人連買、族群剛啟動。多為動能順勢型——嚴設停損，訊號轉弱就走。",
      picks.short, "#ea580c", "#fed7aa", "#fff7ed",
    )}
    <p style="font-size:11px; color:#9ca3af; line-height:1.6; margin:4px 0 0;">
      資料基準：集保大戶 ${basis.tdccWeek ?? "—"}（週）、CB+設質 ${basis.cbWeek ?? "—"}（週）、RRG ${basis.rrgAsOf ?? "—"}、價格序列 ${basis.priceHistoryDays ?? 0} 個交易日。
      純規則計算（無 AI 判讀），每日快照存於 stock-picks-history 供回測。非投資建議。
    </p>
  </div>`;
}

/**
 * 每個分頁「在回答什麼問題」。key 必須與 sections 的 label 完全一致。
 *
 * 為什麼要有這張表：tab 上只有名字，第一次看報告的人分不出「指數貢獻」與
 * 「族群輪動」差在哪（一個看今天、一個看這段期間）。這裡寫的是用途，不是內容摘要。
 */
const TAB_GUIDE: Record<string, string> = {
  "🔥 上漲族群": "今天哪些族群在漲、背後的產業故事，以及每個族群的進場評分與建議動作。",
  "🧊 下跌族群": "今天哪些族群在跌、為什麼跌，哪些是該避開的、哪些只是回檔。",
  "🎯 操作建議": "把當日結論收斂成三類：可以現在介入、需要再觀察、直接避開。",
  "📊 市場總覽": "一段盤後總結，加上大盤指數、成交量、法人買賣超、當沖比、散戶部位的儀表板。",
  "⚖️ 指數貢獻": "指數這幾點到底是誰推的、誰在拖。資金流向圖看力道來源，分布圖看主戰場在哪。",
  "🔄 族群輪動": "中期資金在族群之間怎麼輪動（RRG 四象限）。看的是趨勢，不是單日漲跌。",
  "🏦 大戶籌碼": "集保大戶這週買了什麼。可切「背離（籌碼先動、價還沒動）」與「同向（籌碼與趨勢一致）」，門檻 200~1000 張可調。週資料。",
  "🌐 國際情勢": "美股、亞股、原物料、匯率與信用利差——台股開盤前的外部條件。",
  "🧭 長線策略": "跳出當日波動，長線的進出場想法與部位思考。",
  "🏆 終極選股池": "全部訊號統合後的最終結論：長線 10 檔＋短線 10 檔，含入選理由與進出場計畫。",
  "🔖 圖例說明": "報告裡各種標記、badge、顏色代表什麼意思。",
  "🧮 評分說明": "進場評分 0-100 是怎麼算出來的，四個構面各佔多少。",
};

/** 建議的閱讀順序：由外而內、由結果到原因，最後才是可以動手的結論。 */
const READ_ORDER = ["🌐 國際情勢", "📊 市場總覽", "⚖️ 指數貢獻", "🔥 上漲族群", "🔄 族群輪動", "🏦 大戶籌碼", "🎯 操作建議", "🏆 終極選股池"];

/**
 * Email 版的段落順序，與網頁版（READ_ORDER）**刻意不同**。
 *
 * Gmail 在 102KB 就會截斷信件、把後面收進「查看完整訊息」。這份報告 300KB 以上，
 * 一定會被截，所以重點不是塞進 102KB（辦不到，光上漲族群就 90KB 以上），而是
 * **讓截斷落在不重要的地方**。
 *
 * 網頁版的動線把「指數貢獻」排在「上漲族群」前面（先看大盤是誰推的，再看個股），
 * 那在有分頁的網頁上很合理；但在信件裡它是 50KB 的實體段落，會把最重要的族群內容
 * 整個推到截斷線之後。所以信件版把上漲族群提到市場總覽之後，圖表重的段落往後放。
 *
 * 改動線時**兩張表都要看**：READ_ORDER 管網頁的分頁與「建議第 N 站」徽章，
 * 這張只管信件的段落順序。
 */
const EMAIL_ORDER = ["🌐 國際情勢", "📊 市場總覽", "🔥 上漲族群", "🎯 操作建議", "🏆 終極選股池", "⚖️ 指數貢獻", "🔄 族群輪動", "🏦 大戶籌碼"];

/**
 * 把完整版 HTML 壓成信件版。**只拿掉信件本來就顯示不出來的東西**，不動看得見的內容。
 *
 * - `<script>`：信件用戶端一律剝除，留著純粹是體積（含 tab 切換、圖表互動、
 *   大戶籌碼那 13KB 的 JSON payload）。
 * - 標籤之間的縮排空白：HTML 是用樣板字串寫的，縮排佔了可觀比例。
 * - inline style 裡冒號與分號後的空白：每個 chip 的 style 字串會重複兩百次。
 *
 * **不要**在這裡拿掉 `<svg>`：Gmail 確實不支援，但 Apple Mail 等用戶端畫得出來，
 * 刪掉是拿別的用戶端的體驗換 Gmail 的體積，不划算（實測也只省 27KB，救不了 102KB）。
 */
function slimForEmail(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    // style="..." 內部壓縮：只動屬性值裡的空白，不碰標籤外的文字內容
    .replace(/style="([^"]*)"/g, (_m, css: string) => `style="${css.replace(/\s*([:;])\s*/g, "$1").replace(/;$/, "").trim()}"`)
    // 縮排空白壓成**一個空格**，不是刪掉。標籤之間的空白在 HTML 裡是有意義的內容，
    // 瀏覽器本來就會把它折成一個空格；刪掉會讓相鄰的行內元素黏在一起。
    // 實測踩過兩次：`<strong>華新科</strong> <span>2492</span>` → 「華新科2492」、
    // 「領先 9 IC設計」→「領先 9IC設計」。壓成一個空格則渲染結果完全不變。
    .replace(/>[ \t]*\n[ \t\n]*</g, "> <")
    .replace(/[ \t]{2,}/g, " ");
}

/**
 * 總覽分頁：介紹每個分頁的用途並可一鍵跳過去。
 *
 * 刻意做成漸進增強——這裡只輸出純文字卡片，沒有 <a>、沒有「前往」字樣。
 * 有 JS 時（網頁版）由下方 script 把卡片變成可點按鈕並補上箭頭；
 * 沒有 JS 時（Email，所有分頁本來就依序攤開）它就是一份開頭導讀，不會出現點不動的死連結。
 */
/**
 * @param order 這份輸出實際採用的段落順序（網頁是 READ_ORDER、信件是 EMAIL_ORDER）。
 *   **一定要跟外層排序用的是同一份表**，否則「建議第 N 站」會跟卡片與段落的實際
 *   先後對不上——之前就發生過徽章順序 4,2,3,5,1 的情況。
 */
function renderHome(labels: string[], date: string, order: string[] = READ_ORDER): string {
  // 動線上「今天真的有輸出」的段落，卡片徽章與建議動線都以它為準
  const steps = order.filter((l) => labels.includes(l));
  // labels 進來時已由 sortByReadOrder 排好，這裡直接沿用——分頁列、面板順序、
  // 卡片順序必須是同一份順序，否則「建議第 N 站」會跟上方分頁列對不起來。
  const ordered = labels;
  // 分頁改名時 TAB_GUIDE 會對不上，卡片就只剩標題、沒人會發現。出個聲。
  const missing = ordered.filter((l) => !TAB_GUIDE[l]);
  if (missing.length > 0) {
    console.warn(`[warn] 總覽缺少分頁說明，請補 TAB_GUIDE：${missing.join("、")}`);
  }

  // 標題與說明排同一行：原本上下兩行讓每張卡片吃掉 78px，右側大半是空的。
  // 用一般的行內流排版（不是固定欄寬表格），窄螢幕上說明會自然換行到下一行。
  // float 的箭頭必須寫在文字之前，某些 Email 用戶端才會正確靠右。
  const card = (label: string) => {
    const desc = TAB_GUIDE[label] ?? "";
    // 用「在實際存在的段落之中排第幾」而不是在 order 表裡的索引：
    // 動線上的段落可能整個缺席（例如今天沒有操作建議），用表索引會跳號（1,2,3,5,6）。
    const step = steps.indexOf(label);
    const badge = step >= 0
      ? `<span style="display:inline-block; background:#eef2ff; color:#4f46e5; font-size:10px; font-weight:bold; border-radius:999px; padding:1px 6px; margin-left:5px; vertical-align:1px;">建議第 ${step + 1} 站</span>`
      : "";
    return `<div class="homecard" data-goto="${label}" style="border:1px solid #e5e7eb; border-radius:6px; padding:9px 12px; margin-bottom:6px; background:#fff; font-size:13px; line-height:1.65;">
        <span class="homecard-arrow" style="float:right; color:#c7d2fe;"></span>
        <strong style="color:#374151; white-space:nowrap;">${label}</strong>${badge}<span style="color:#d1d5db;"> · </span><span style="color:#6b7280; font-size:12px;">${desc}</span>
      </div>`;
  };

  // 設質+CB 候選池是獨立子頁（週更），不是分頁——卡片直接外連，網頁與信件都能點。
  const cbCard = `<a href="${SITE_URL}cb-pledge.html" style="text-decoration:none; display:block;"><div style="border:1px solid #e5e7eb; border-radius:6px; padding:9px 12px; margin-bottom:6px; background:#fff; font-size:13px; line-height:1.65;">
        <span style="float:right; color:#c7d2fe;">↗</span>
        <strong style="color:#374151; white-space:nowrap;">🔐 設質+CB 候選池</strong><span style="color:#d1d5db;"> · </span><span style="color:#6b7280; font-size:12px;">董監新增設質＋有流通中 CB 的公司派作價訊號池，含轉換價距離與 CB 溢價。週更、獨立頁面。</span>
      </div></a>`;

  // 首頁分組：依「多久變一次」分色塊，讀者可以先看每天會動的，慢變數另外一區。
  // labels 進來已依 READ_ORDER 排好，各色塊內沿用該順序；沒被任何色塊認領的分頁
  // 落到「其他」，分頁改名或新增時不會從首頁消失。
  const BLOCKS: { title: string; hint: string; bg: string; border: string; titleColor: string; labels: string[]; extraHtml?: string }[] = [
    {
      title: "🔥 今日族群與操作",
      // 圖例位置兩版不同：網頁版附在上漲/下跌分頁底部、信件版是最後的獨立段落
      hint: `每天的主菜：漲跌族群與可執行結論。圖例與評分說明${order === EMAIL_ORDER ? "在本信最後" : "收在上漲/下跌分頁最上方的「本頁說明」，點開就有"}。`,
      bg: "#fff7ed", border: "#fed7aa", titleColor: "#c2410c",
      labels: ["🔥 上漲族群", "🧊 下跌族群", "🎯 操作建議", "🏆 終極選股池"],
    },
    {
      title: "📅 一日市場總覽",
      hint: "每天更新的市場背景：外部條件 → 大盤儀表板 → 指數是誰推的。",
      bg: "#eff6ff", border: "#bfdbfe", titleColor: "#1d4ed8",
      labels: ["🌐 國際情勢", "📊 市場總覽", "⚖️ 指數貢獻"],
    },
    {
      title: "🐢 非每日變動",
      hint: "慢變數：週更或月更，不用每天看，但轉折時最值錢。",
      bg: "#f0fdf4", border: "#bbf7d0", titleColor: "#15803d",
      labels: ["🔄 族群輪動", "🏦 大戶籌碼"],
      extraHtml: cbCard,
    },
    {
      title: "📚 其他",
      hint: "",
      bg: "#f8fafc", border: "#e2e8f0", titleColor: "#334155",
      labels: [], // 由 leftovers 填入
    },
  ];
  const claimed = new Set(BLOCKS.flatMap((b) => b.labels));
  BLOCKS[BLOCKS.length - 1].labels = ordered.filter((l) => !claimed.has(l));

  const renderBlock = (b: (typeof BLOCKS)[number], style = "") => {
    const present = b.labels.filter((l) => ordered.includes(l));
    if (!present.length && !b.extraHtml) return "";
    return `<div style="background-color:${b.bg}; border:1px solid ${b.border}; border-radius:8px; padding:12px 14px; margin-bottom:10px; ${style}">
        <div style="font-weight:bold; color:${b.titleColor}; margin-bottom:2px;">${b.title}</div>
        ${b.hint ? `<p style="font-size:12px; color:#6b7280; line-height:1.6; margin:0 0 8px;">${b.hint}</p>` : `<div style="margin-bottom:8px;"></div>`}
        ${present.map(card).join("")}${b.extraHtml ?? ""}
      </div>`;
  };

  // 「一日市場總覽」與「非每日變動」在寬螢幕左右並排（inline-block 49%），
  // 窄螢幕/信件視窗因 min-width 排不下會自動上下堆疊。不用 flex/grid 是為了 Email 相容。
  const twoCol =
    `<div>` +
    `<div style="display:inline-block; width:49%; min-width:300px; vertical-align:top;">${renderBlock(BLOCKS[1], "margin-right:0;")}</div>` +
    `<div style="display:inline-block; width:49%; min-width:300px; vertical-align:top; margin-left:1%;">${renderBlock(BLOCKS[2])}</div>` +
    `</div>`;

  const orderText = steps
    .map((l) => l.replace(/^\S+\s/, ""))
    .join(" → ");

  return `<div style="margin-bottom:20px;">
      <div style="background-color:#f8fafc; border:1px solid #e2e8f0; padding:12px 15px; border-radius:8px; margin-bottom:10px;">
        <h3 style="margin-top:0; margin-bottom:6px; color:#334155;">🏠 這份報告怎麼看</h3>
        <p style="font-size:13px; color:#4b5563; line-height:1.8; margin:0;">
          這是 ${date} 的台股盤後報告。它不預測明天，而是回答三件事：<strong>今天實際發生了什麼</strong>、
          <strong>錢流去了哪裡</strong>、<strong>這是單日雜訊還是正在成形的趨勢</strong>。
          ${orderText ? `第一次看建議照這個順序：<strong>${orderText}</strong>。` : ""}
        </p>
        <div class="home-hint" style="font-size:11px; color:#9ca3af; margin-top:6px; line-height:1.6; display:none;">
          點任一張卡片可直接跳到該分頁；隨時可以從上方的分頁列回到這裡。
        </div>
      </div>
      ${renderBlock(BLOCKS[0])}
      ${twoCol}
      ${renderBlock(BLOCKS[3])}
    </div>`;
}

function renderHtml(a: Analysis, stockMap: Record<string, StockMeta>, codeByName: Map<string, string>, market?: MarketBlock | null, retailHistory?: MarketHistoryEntry[], contrib?: IndexContribution | null, tdcc?: DivergenceReport | null, marginHistory?: MarginHistoryEntry[], mo?: MarginOptionsReport | null, picks?: PicksReport | null, forEmail = false): string {
  // 有 call 標記的族群排前面（順勢 → 觀察 → 反轉），其餘維持原順序（檔數多→少）
  const callRank: Record<string, number> = { 順勢: 0, 觀察: 1, 反轉: 2 };
  const sortedGainers = [...a.gainers].sort(
    (x, y) => (x.call ? callRank[x.call] ?? 3 : 4) - (y.call ? callRank[y.call] ?? 3 : 4),
  );
  const gainersHtml = sortedGainers.map((g) => renderCategoryBlock(g, stockMap, codeByName, "gainer")).join("");
  const losersHtml = a.losers.map((g) => renderCategoryBlock(g, stockMap, codeByName, "loser")).join("");
  const longTermStrategyHtml = a.longTermStrategy
    ? `<div style="background-color: #eef6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1d4ed8;">🧭 長線策略與進出場</h3>
      <p style="line-height: 1.7; margin-bottom: 0; color: #1e3a8a;">${a.longTermStrategy.replace(/\n/g, "<br>")}</p>
    </div>`
    : "";
  const playbookHtml = a.playbook
    ? `<div style="background-color: #fff7ed; border: 1px solid #fed7aa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #c2410c;">🎯 操作建議</h3>
      <p style="line-height: 1.7; margin-bottom: 0; color: #7c2d12;">${a.playbook.replace(/\n/g, "<br>")}</p>
    </div>`
    : "";
  const marketDashboardHtml = renderMarketDashboard(market, retailHistory, marginHistory, mo);
  const intlHtml = renderIntl(a.intl);
  const rrgHtml = renderRrg(a.rrg);
  const contribHtml = renderIndexContribution(contrib);
  const tdccHtml = renderTdcc(tdcc);
  const legendHtml = renderLegend();
  const rubricHtml = renderScoringRubric();

  const summaryHtml = `<div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1f2937;">📝 盤後總結</h3>
      <p style="line-height: 1.6; margin-bottom: 0;">${a.summary.replace(/\n/g, "<br>")}</p>
    </div>`;

  // 圖例／評分說明的歸屬：
  // - 網頁版：不再是獨立分頁，改成放在會用到它們的分頁**最上方的摺疊區塊**
  //   （<details>，預設收合、要看再點開），讀者不用滑到最底才發現有說明。
  //   badge 都出現在上漲/下跌族群；進場評分只有強勢族群有，所以評分說明只附在上漲。
  // - 信件版：維持單份、照舊排在最後。信件是線性攤開的（Gmail 對 <details> 支援
  //   也不可靠），圖例出現兩次只是灌體積，而 102KB 截斷的壓力一直都在。
  const foldNote = (label: string, inner: string) =>
    `<details style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; margin-bottom:14px;">
      <summary style="cursor:pointer; padding:9px 14px; font-size:13px; font-weight:bold; color:#475569; user-select:none;">📖 ${label}（點開）</summary>
      <div style="padding:0 10px;">${inner}</div>
    </details>`;
  const groupGHtml = `${forEmail ? "" : foldNote("本頁說明：圖例與進場評分", legendHtml + rubricHtml)}<h3 style="color: #dc2626; margin-top: 0;">🔥 強勢焦點 (量大優先)</h3>${gainersHtml}`;
  const groupLHtml = `${forEmail ? "" : foldNote("本頁說明：圖例", legendHtml)}<h3 style="color: #16a34a; margin-top: 0;">🧊 弱勢焦點 (量大優先)</h3>${losersHtml}`;

  // 每個區塊都是一個 tab panel；瀏覽器端由下方 script 產生頂部切換鈕、預設只顯示第一個（上漲族群）。
  // email 無 JS 時所有 panel 都顯示（完整退回），不會壞。
  const sections: Array<{ label: string; html: string }> = [
    { label: "🔥 上漲族群", html: groupGHtml },
    { label: "🧊 下跌族群", html: groupLHtml },
    // 操作建議：可現在介入 / 需關注 / 避開，放在族群後、總覽前，方便快速決策。
    { label: "🎯 操作建議", html: playbookHtml },
    // 盤後總結與市場儀表板都是整體市場觀點，合併成一個「市場總覽」tab。
    { label: "📊 市場總覽", html: `${summaryHtml}${marketDashboardHtml}` },
    // 指數貢獻：把當日指數漲跌拆回產業與個股，緊接在市場總覽之後回答「這幾點是誰推的」
    { label: "⚖️ 指數貢獻", html: contribHtml },
    // 族群輪動：中期資金流向，放在市場總覽之後、國際情勢之前
    { label: "🔄 族群輪動", html: rrgHtml },
    // 大戶籌碼：週資料（TDCC 每週五結算），與每日資料放在一起時要留意更新頻率不同
    { label: "🏦 大戶籌碼", html: tdccHtml },
    // 終極選股池：全訊號統合後的最終結論，動線上排在操作建議之後（先看族群層級的結論，再看個股層級的收斂）
    { label: "🏆 終極選股池", html: renderPicks(picks ?? null, forEmail) },
    { label: "🌐 國際情勢", html: intlHtml },
    { label: "🧭 長線策略", html: longTermStrategyHtml },
    // 圖例/評分說明只有信件版還是獨立段落（見上方 groupGHtml 的說明）
    ...(forEmail
      ? [
          { label: "🔖 圖例說明", html: legendHtml },
          { label: "🧮 評分說明", html: rubricHtml },
        ]
      : []),
  ].filter((s) => s.html && s.html.trim());

  // 依建議閱讀順序重排。這是唯一的排序來源：分頁列、面板順序、總覽卡片全部吃它，
  // 三者只要有一個不同步，「建議第 N 站」就會跟上方分頁列對不起來。
  // Email 版沒有分頁、段落是依序攤開的，所以這個順序同時也是信件的閱讀順序。
  const order = forEmail ? EMAIL_ORDER : READ_ORDER;
  const rank = (label: string) => {
    const i = order.indexOf(label);
    return i < 0 ? 99 : i; // 不在動線上的（圖例、評分說明等）沉到最後，維持原相對順序
  };
  sections.sort((x, y) => rank(x.label) - rank(y.label));

  // 總覽放最前面：網頁版是預設落地頁（activate(0)），Email 版沒有 JS，
  // 所有分頁本來就依序攤開，它自然成為開頭的導讀。
  sections.unshift({ label: "🏠 總覽", html: renderHome(sections.map((s) => s.label), a.timestamp, order) });

  const panelsHtml = sections
    .map((s) => `<div class="tabpanel" data-label="${s.label}">${s.html}</div>`)
    .join("");

  // 單欄 + RWD：viewport 讓手機正確縮放；容器 max-width 980、左右留白隨螢幕縮放。
  return `<meta name="viewport" content="width=device-width, initial-scale=1">
  <div style="font-family: sans-serif; max-width: 980px; margin: 0 auto; color: #333; padding: 0 16px;">
    <h2 style="color: #4f46e5; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📈 台股盤後資金流向與 AI 總結 (${a.timestamp})</h2>
    ${forEmail ? `<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:8px 10px; font-size:12px; color:#92400e; line-height:1.6; margin-bottom:16px;">這封信內容較長，Gmail 可能在中途截斷並顯示「查看完整訊息」。互動圖表（可切換的大戶籌碼榜、市場情緒疊圖）在信件裡也無法操作 — <a href="${SITE_URL}" style="color:#b45309; font-weight:bold;">開啟網頁版</a>看完整內容。</div>` : ""}
    <div id="tabbar" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px;"></div>
    ${panelsHtml}
    <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px;">
      Generated via Claude Code workflow
    </div>
  </div>
  <script>
  (function(){
    var bar=document.getElementById('tabbar');
    var panels=[].slice.call(document.querySelectorAll('.tabpanel'));
    if(!bar||!panels.length)return;
    var btns=[];
    function activate(i){
      panels.forEach(function(p,j){p.style.display=j===i?'':'none';});
      btns.forEach(function(b,j){
        var on=j===i;
        b.style.background=on?'#4f46e5':'#fff';
        b.style.color=on?'#fff':'#374151';
        b.style.borderColor=on?'#4f46e5':'#e5e7eb';
      });
    }
    var idxByLabel={};
    var PILL='font-family:inherit;font-size:14px;font-weight:bold;cursor:pointer;border:1px solid #e5e7eb;border-radius:999px;padding:8px 14px;background:#fff;color:#374151;';
    panels.forEach(function(p,i){
      var label=p.getAttribute('data-label')||('Tab '+(i+1));
      idxByLabel[label]=i;
      var b=document.createElement('button');
      b.textContent=label;
      b.style.cssText=PILL;
      // hash 深連結：子頁（設質+CB）要能連回特定分頁，重新整理也要留在原分頁
      b.onclick=function(){activate(i);location.hash='tab='+encodeURIComponent(label);};
      btns.push(b);bar.appendChild(b);
    });
    // 子頁入口：設質+CB 候選池是獨立頁面（週更），放在分頁列最後當第一級導覽，
    // 樣式與分頁鈕一致但用 <a>，讓它看得出是「離開這一頁」。
    var ext=document.createElement('a');
    ext.href='cb-pledge.html';
    ext.textContent='🔐 設質+CB ↗';
    ext.style.cssText=PILL+'text-decoration:none;border-style:dashed;';
    bar.appendChild(ext);
    // 總覽卡片：只有在 JS 跑得動時才變成可點的入口，並補上箭頭與提示。
    // Email 沒有 JS，卡片維持純文字，不會出現點不動的死連結。
    [].slice.call(document.querySelectorAll('.homecard')).forEach(function(card){
      var target=idxByLabel[card.getAttribute('data-goto')];
      if(target===undefined)return;
      card.style.cursor='pointer';
      var arrow=card.querySelector('.homecard-arrow');
      if(arrow){arrow.textContent=' →';arrow.style.color='#4f46e5';arrow.style.float='right';}
      card.onclick=function(){activate(target);window.scrollTo(0,0);};
      card.onmouseenter=function(){card.style.borderColor='#4f46e5';card.style.background='#f5f3ff';};
      card.onmouseleave=function(){card.style.borderColor='#e5e7eb';card.style.background='#fff';};
    });
    var hint=document.querySelector('.home-hint');
    if(hint)hint.style.display='';
    // 進站時若帶 #tab=xxx（從子頁連回來或重新整理）就開那一頁，否則落在總覽
    function fromHash(){
      var m=/^#tab=(.+)$/.exec(location.hash||'');
      if(!m)return -1;
      var i=idxByLabel[decodeURIComponent(m[1])];
      return i===undefined?-1:i;
    }
    var start=fromHash();
    activate(start<0?0:start);
    window.addEventListener('hashchange',function(){var i=fromHash();if(i>=0)activate(i);});
  })();
  </script>`;
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
  // 略過旗標，第一個非 -- 開頭的參數才是輸入檔
  const inputPath = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "data/analysis-latest.json";
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
  // 融資序列（互動圖的第三條線）與當日融資／外資選擇權快照。
  // 兩者由 fetch-margin-options.ts 產出，缺檔就退回沒有這些資料的版本。
  let marginHistory: MarginHistoryEntry[] | undefined;
  const marginHistoryPath = resolve(process.cwd(), "data/margin-history.json");
  if (existsSync(marginHistoryPath)) {
    try {
      marginHistory = JSON.parse(readFileSync(marginHistoryPath, "utf-8"));
    } catch {
      console.warn("[warn] margin-history.json 解析失敗，圖表少一條融資線");
    }
  }
  let marginOptions: MarginOptionsReport | null = null;
  const marginOptionsPath = resolve(process.cwd(), "data/margin-options-latest.json");
  if (existsSync(marginOptionsPath)) {
    try {
      const parsed: MarginOptionsReport = JSON.parse(readFileSync(marginOptionsPath, "utf-8"));
      // 新鮮度檢查：交易所在收盤前／假日會回上一個交易日，日期對不上就不顯示，
      // 免得把昨天的融資餘額掛在今天的儀表板上
      if (parsed.tradingDate === analysis.date) marginOptions = parsed;
      else console.warn(`[warn] margin-options 的日期 ${parsed.tradingDate} 與分析日 ${analysis.date} 不符，略過`);
    } catch {
      console.warn("[warn] margin-options-latest.json 解析失敗");
    }
  }

  let retailHistory: MarketHistoryEntry[] | undefined;
  if (existsSync(marketHistoryPath)) {
    try {
      retailHistory = JSON.parse(readFileSync(marketHistoryPath, "utf-8"));
    } catch {
      // ignore
    }
  }

  // 指數貢獻拆解（build-index-contribution.ts 的輸出）。缺檔或過期就不顯示這個 tab，
  // 不影響其他區塊——這支是獨立可選步驟，失敗不該擋掉整份報告。
  const contribPath = resolve(process.cwd(), "data/index-contribution-latest.json");
  let contrib: IndexContribution | null = null;
  if (existsSync(contribPath)) {
    try {
      const parsed: IndexContribution = JSON.parse(readFileSync(contribPath, "utf-8"));
      // 交易日對不上代表這份是舊的（例如當天沒重跑），寧可不顯示也不要秀錯的數字。
      if (parsed?.tradingDate === analysis.date || !analysis.date) contrib = parsed;
      else console.warn(`index-contribution 交易日 ${parsed?.tradingDate} 與分析 ${analysis.date} 不符，略過`);
    } catch {
      console.warn("index-contribution-latest.json 無法解析，略過");
    }
  }

  // 大戶籌碼背離（build-tdcc-divergence.ts 的輸出）。這是週資料，不做「當日新鮮度」
  // 檢查——同一份榜單本來就會連續出現好幾天，直到下週六 TDCC 更新。
  const tdccPath = resolve(process.cwd(), "data/tdcc-divergence-latest.json");
  let tdcc: DivergenceReport | null = null;
  if (existsSync(tdccPath)) {
    try {
      tdcc = JSON.parse(readFileSync(tdccPath, "utf-8"));
    } catch {
      console.warn("tdcc-divergence-latest.json 無法解析，略過");
    }
  }

  // 網頁版（給 build-site-html.ts）與信件版分開產：兩者的段落順序不同，
  // 而且信件版會再過一次 slimForEmail 把信件顯示不出來的東西拿掉。
  const html = renderHtml(analysis, stockMap, codeByName, marketBlock, retailHistory, contrib, tdcc, marginHistory, marginOptions);
  const emailHtml = slimForEmail(
    renderHtml(analysis, stockMap, codeByName, marketBlock, retailHistory, contrib, tdcc, marginHistory, marginOptions, true),
  );

  const htmlOutPath = resolve(process.cwd(), "data/report-latest.html");
  writeFileSync(htmlOutPath, html, "utf-8");
  console.log(`Wrote HTML preview to ${htmlOutPath}`);
  writeFileSync(resolve(process.cwd(), "data/report-email.html"), emailHtml, "utf-8");
  console.log(
    `Email 版 ${(emailHtml.length / 1024).toFixed(0)}KB（網頁版 ${(html.length / 1024).toFixed(0)}KB）` +
      `${emailHtml.length > 102 * 1024 ? "，仍超過 Gmail 102KB 截斷線，但重點段落已排在截斷線之前" : ""}`,
  );

  updateHistory(analysis);

  // 注意：.env.local 是用 override:true 載入的，所以「GAS_WEBHOOK_URL= 前綴」擋不掉寄信，
  // 一定要用這個旗標（而且旗標必須能單獨當第一個參數傳，見上方 inputPath 的處理）。
  const shouldSend = !process.argv.includes("--no-email");
  if (shouldSend) {
    await sendEmail(emailHtml);
  } else {
    console.log("Skipped email (--no-email flag)");
  }
}

main().catch((err) => {
  console.error("send-report failed:", err);
  process.exit(1);
});
