import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { significantInstitutionalBuys, type InstitutionalStrength } from "./institutional-strength.ts";
import { HOME_LABEL, READ_ORDER, TAB_ALIASES, renderSiteNav } from "./lib/nav";
import { linkifyStocks, yahooUrl } from "./lib/stock-links";

// 中文字型堆疊：先吃各平台的系統黑體（蘋方／思源／正黑），最後才退回 sans-serif。
// 原本只寫 sans-serif，Windows/Android 常掉到細明體或簡中字型，數字與中文粗細也不一致。
// 用單引號包字型名，才能安全地塞進 style="..." 屬性（信件版也吃得到）。
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei', 'Heiti TC', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

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
  chips?: { foreignNet: number; trustNet: number; dealerNet: number; totalNet: number; foreignRatio?: number; trustRatio?: number; foreignBuyStreak?: number; trustBuyStreak?: number; strength?: InstitutionalStrength };
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

/** worker 寫的「過去一天大事」時間軸（data/tmp/intl-events.json → attach-intl.ts） */
interface IntlEvent {
  when: string;   // 台北時間 MM/DD HH:MM
  cat: string;    // 央行 / 數據 / 地緣 / 關稅 / 財報 / 政治 / 原物料 / 科技
  title: string;  // 一句事實
  impact: string; // 利多 / 利空 / 中性（對台股）
  level: string;  // 高 / 中
  chain: string;  // 一句影響鏈
}

/** 美股指標股：價格來自 fetch-intl-market.ts，why/tw 由 worker 補 */
interface IntlMover {
  symbol: string;
  name: string;
  tag: string;
  close: number;
  change: number;
  pct: number;
  why?: string;
  tw?: string;
}

/** fetch-sector-flows.ts 的輸出（data/sector-flows-latest.json） */
interface SectorFlow {
  symbol: string;
  name: string;
  close: number;
  pct: number;
  ret1w: number | null;
  ret4w: number | null;
  rsi14: number | null;
  pe: number | null;
  aum: number | null;
  flow1w: number | null;
  flow4w: number | null;
  flowDays1w: number | null;
  flowDays4w: number | null;
}

interface IntlBlock {
  summary: string;
  window?: string;
  events?: IntlEvent[];
  indices: IntlIndex[];
  credit?: CreditSpread[];
  movers?: IntlMover[];
  sectors?: SectorFlow[];
}

/** attach-kol.ts 併進來的財經 KOL 新內容（kol-brief-worker 的判讀 + 來源連結） */
interface KolItem {
  source: string;
  platform: string;
  title: string;
  url: string;
  publishedAt: string;
  insight: string;
  tickers?: string[];
  stance?: string;
  basis?: string;
}

interface KolBlock {
  overview: string;
  items: KolItem[];
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
  kol?: KolBlock;
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
    for (const buy of significantInstitutionalBuys(meta.chips.strength)) {
      badges += `<span title="${buy.detail}" style="font-size: 12px; background-color: #fee2e2; color: #991b1b; padding: 1px 4px; border-radius: 4px; margin-left: 3px;">${buy.label}</span>`;
    }
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
    return `<div style="display:inline-block; text-align:center; min-width:54px; margin:0 1px;">
      <div style="font-size:10px; color:#6b7280;">${label}</div>
      <div style="font-size:14px; font-weight:bold; color:${valColor};">${val}${maxStr}</div>
    </div>`;
  };

  const rationaleHtml = g.entryRationale
    ? `<p style="margin:4px 0 0 0; font-size:11px; color:#374151; line-height:1.3;">${escHtml(g.entryRationale)}</p>`
    : "";

  return `<div style="background-color:${tierBg}; border:1px solid ${tierColor}; padding:5px 8px; border-radius:6px; margin-bottom:6px;">
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:4px;">
      <div>
        <span style="font-size:18px; font-weight:bold; color:${tierColor};">${s}</span>
        <span style="font-size:10px; color:#6b7280;"> / 100</span>
        <span style="font-size:10px; background-color:${tierColor}; color:#fff; padding:1px 6px; border-radius:10px; margin-left:5px;">${action}</span>
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
  const bgColor = kind === "gainer" ? "#fef2f2" : "#f0fdf4";
  const headerColor = kind === "gainer" ? "#991b1b" : "#166534";
  const chipBg = kind === "gainer" ? "#fecaca" : "#bbf7d0";
  const stockBorder = kind === "gainer" ? "#fca5a5" : "#86efac";
  const pctColor = kind === "gainer" ? "#dc2626" : "#16a34a";
  const storyLabelColor = kind === "gainer" ? "#991b1b" : "#166534";
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
    headerBadges += `<span style="font-size: 11px; background-color: #e0e7ff; color: #4338ca; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">${escHtml(g.stage)}</span>`;
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
    const href = code ? yahooUrl(code, "technical-analysis") : "#";
    const codeHtml = code ? `<span style="color: #6b7280; font-size: 12px;">${escHtml(code)}</span>` : "";
    const pctHtml = pct !== "" ? `<span style="color: ${pctColor}; font-weight: bold; margin-left: 4px;">${pct}</span>` : "";
    stocksHtml += `<a href="${escHtml(href)}" target="_blank" style="text-decoration: none; display: inline-block; background-color: white; border: 1px solid ${stockBorder}; padding: 4px 8px; border-radius: 6px; margin: 0 6px 6px 0; font-size: 14px;">
      <strong style="color: #1f2937;">${escHtml(name)}</strong> ${codeHtml}
      ${pctHtml}
      ${futuresHtml}${chipBadges}
    </a>`;
  }

  // 故事是整段長文：底色維持族群的淡紅／淡綠，但內文改深灰。
  // 原本整段用紅／綠字，幾百字的紅字很難讀，漲跌語意交給標題與左側色條就夠了。
  const storyHtml = g.story
    ? `<div style="background-color: ${bgColor}; padding: 10px 12px; border-radius: 8px; border: 1px solid ${storyBorder}; margin-bottom: 10px;">
        <strong style="color: ${storyLabelColor}; font-size: 13px;">${storyLabel}</strong>
        <p style="margin: 4px 0 0 0; font-size: 14px; color: #374151; line-height: 1.75;">${escHtml(g.story)}</p>
      </div>`
    : "";

  // 卡片：白底 + 左側 4px 漲跌色條（紅＝漲、綠＝跌），取代整張粉紅／粉綠底，
  // 長頁面一路滑下來不會一片紅，每張卡的邊界也更清楚。border-left 在各家信件用戶端都支援。
  return `<div style="border: 1px solid #e5e7eb; border-left: 4px solid ${pctColor}; background: #fff; padding: 14px 16px 6px; border-radius: 10px; margin-bottom: 14px;">
    <h4 style="margin: 0 0 10px; font-size: 17px; color: ${headerColor}; display: flex; align-items: center; flex-wrap: wrap;">
      <span style="background-color: ${chipBg}; color: ${headerColor}; padding: 1px 8px; border-radius: 999px; font-size: 12px; margin-right: 8px;">${g.stocks.length}檔</span>
      ${escHtml(g.category)}${headerBadges}
    </h4>
    <div style="margin-bottom: 6px;">${stocksHtml}</div>
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
    return `<td style="padding: 6px 8px; border-top: 1px solid #eef2f7; color: ${color}; font-weight: bold;">${sign}${change.toFixed(2)} <span style="font-size: 12px;">(${sign}${pct.toFixed(2)}%)</span></td>`;
  };
  const taiex = market.taiex;
  if (taiex) {
    rows.push(`<tr><td style="padding: 6px 10px 6px 0; color: #6b7280; white-space: nowrap; width: 1%; border-top: 1px solid #eef2f7;">加權指數</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7; font-weight: bold;">${taiex.close.toLocaleString()}</td>${fmtIndexChange(taiex.close, taiex.change)}</tr>`);
  }
  const tpex = market.tpex;
  if (tpex) {
    rows.push(`<tr><td style="padding: 6px 10px 6px 0; color: #6b7280; white-space: nowrap; width: 1%; border-top: 1px solid #eef2f7;">櫃買指數</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7; font-weight: bold;">${tpex.close.toLocaleString()}</td>${fmtIndexChange(tpex.close, tpex.change)}</tr>`);
  }
  const breadth = market.breadth;
  if (breadth) {
    rows.push(`<tr><td style="padding: 6px 10px 6px 0; color: #6b7280; white-space: nowrap; width: 1%; border-top: 1px solid #eef2f7;">上漲/下跌</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7;" colspan="2"><span style="color: #dc2626;">${breadth.up}家</span> / <span style="color: #16a34a;">${breadth.down}家</span>　漲停 <strong style="color: #dc2626;">${breadth.limitUp}</strong> / 跌停 <strong style="color: #16a34a;">${breadth.limitDown}</strong></td></tr>`);
  }
  const dt = market.dayTrade;
  if (dt) {
    const dtPct = (v: number | null | undefined) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(2)}%` : "—");
    rows.push(`<tr><td style="padding: 6px 10px 6px 0; color: #6b7280; white-space: nowrap; width: 1%; border-top: 1px solid #eef2f7;">當沖比重</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7;" colspan="2">上市 ${dtPct(dt.twseVolumePct)}　上櫃 ${dtPct(dt.tpexVolumePct)}</td></tr>`);
  }
  const insti = market.institutional;
  if (insti) {
    const fmt = (n: number) => {
      const color = n >= 0 ? "#dc2626" : "#16a34a";
      const sign = n >= 0 ? "+" : "";
      return `<span style="color: ${color}; font-weight: bold;">${sign}${n.toFixed(1)}</span>`;
    };
    rows.push(`<tr><td style="padding: 6px 10px 6px 0; color: #6b7280; white-space: nowrap; width: 1%; border-top: 1px solid #eef2f7;">三大法人(上市)</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7;" colspan="2">合計 ${fmt(insti.totalNet)} 億　<span style="color:#9ca3af; font-size:12px;">外資 ${fmt(insti.foreignNet)}／投信 ${fmt(insti.trustNet)}／自營 ${fmt(insti.dealerNet)}</span></td></tr>`);
  }
  const mfr = market.microFuturesRetail;
  if (mfr) {
    const netPct = mfr.retailNetPct.toFixed(2);
    const netColor = mfr.retailNetPct < 0 ? "#16a34a" : "#dc2626";
    rows.push(`<tr><td style="padding: 6px 10px 6px 0; color: #6b7280; white-space: nowrap; width: 1%; border-top: 1px solid #eef2f7;">微臺散戶淨多空</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7; color: ${netColor}; font-weight: bold;" colspan="2">${netPct}%　<span style="font-size: 11px; color: #9ca3af;">(${mfr.dataDate})</span></td></tr>`);
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
      `<tr><td style="padding: 6px 10px 6px 0; color: #6b7280; white-space: nowrap; width: 1%; border-top: 1px solid #eef2f7;">融資餘額(上市)</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7; font-weight: bold;">${mg.twseAmount.toLocaleString()} 億</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7; color: ${dColor}; font-weight: bold;">${dSign}${mg.dAmount.toFixed(1)} 億<span style="color:#9ca3af; font-weight:normal; font-size:11px;">　${mg.twseLots.toLocaleString()} 張${mg.tpexLots ? `／上櫃 ${mg.tpexLots.toLocaleString()} 張` : ""}</span></td></tr>`,
    );
    rows.push(
      `<tr><td style="padding: 6px 10px 6px 0; color: #6b7280; white-space: nowrap; width: 1%; border-top: 1px solid #eef2f7;">融資維持率</td><td style="padding: 6px 8px; border-top: 1px solid #eef2f7; color: ${mtColor}; font-weight: bold;" colspan="2">${mt === null ? "—" : `${mt.toFixed(1)}%`}<span style="color:#9ca3af; font-weight:normal; font-size:11px;">　自算值，追繳線 166%／斷頭線 130%${mg.maintenanceCoverage ? `　涵蓋 ${mg.maintenanceCoverage.stocks} 檔` : ""}</span></td></tr>`,
    );
  }

  if (rows.length === 0) return "";

  const trendHtml = retailHistory ? renderRetailTrend(retailHistory, marginHistory) : "";
  const optionsHtml = renderForeignOptions(mo?.options);

  return `<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
  <h3 style="margin-top: 0; color: #334155;">📊 市場儀表板</h3>
  <table style="border-collapse: collapse; font-size: 14px; width: 100%; line-height: 1.5;">
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
      return `<span style="display:inline-block; margin:0 10px 4px 0; white-space:nowrap;" title="${escHtml(c.note)}"><span style="color:#6b7280;">${escHtml(c.name)}</span> <strong>${c.bps}bps</strong> <span style="color:${color}; font-weight:bold;">${dTxt}</span>${mTxt}${pTxt}</span>`;
    })
    .join("");
  const asOf = credit[0]?.asOf ?? "";
  return `<tr><td style="padding:4px 8px; color:#6b7280; vertical-align:top; white-space:nowrap;">信用利差<div style="font-size:11px; color:#9ca3af;">${asOf}</div></td><td style="padding:4px 8px;">${cells}<div style="font-size:11px; color:#9ca3af; margin-top:2px;">ICE BofA OAS（公司債對公債的風險溢酬，CDS 的公開替代品）；走闊＝資金收縮、風險偏好下降。資料源 FRED，比美股晚一天。</div></td></tr>`;
}

/**
 * 過去一天的國際大事時間軸。
 *
 * 這一段回答的是「我睡覺的時候世界發生了什麼」——台股收盤到隔天開盤中間，美股整個
 * 交易日、各國央行與地緣事件都在這段空窗發生，光看指數漲跌幅看不出原因。
 * 每列刻意壓成一行可掃：時間 → 類別 → 事實 → 對台股方向，第二行才是影響鏈。
 *
 * 用 <table> 而不是 flex：Gmail 會剝掉 flex，表格在所有用戶端都畫得出來。
 */
const EVENT_CAT_COLOR: Record<string, [string, string]> = {
  央行: ["#e0e7ff", "#4338ca"],
  數據: ["#dbeafe", "#1d4ed8"],
  地緣: ["#fee2e2", "#991b1b"],
  政治: ["#fee2e2", "#991b1b"],
  關稅: ["#ffedd5", "#9a3412"],
  財報: ["#dcfce7", "#15803d"],
  科技: ["#dcfce7", "#15803d"],
  原物料: ["#fef9c3", "#a16207"],
};

function renderIntlEvents(events: IntlEvent[] | null | undefined, window: string | undefined): string {
  if (!events || events.length === 0) return "";
  const rows = events
    .map((e) => {
      const [bg, fg] = EVENT_CAT_COLOR[e.cat] ?? ["#e5e7eb", "#374151"];
      // 台股慣例紅漲綠跌：利多紅、利空綠。
      const impactColor = e.impact === "利多" ? "#dc2626" : e.impact === "利空" ? "#16a34a" : "#6b7280";
      const impactHtml = e.impact
        ? `<span style="color:${impactColor}; font-weight:bold; white-space:nowrap;">${e.impact}</span>`
        : "";
      // 重要度高的用左側色條標出來，掃的時候先看有色條那幾條就好。
      const accent = e.level === "高" ? "border-left:3px solid #0284c7;" : "border-left:3px solid transparent;";
      const chain = e.chain ? `<div style="color:#64748b; font-size:12px; margin-top:2px;">${escHtml(e.chain)}</div>` : "";
      return `<tr><td style="padding:6px 8px; ${accent} vertical-align:top; white-space:nowrap; color:#6b7280; font-size:12px;">${escHtml(e.when)}</td>
      <td style="padding:6px 6px; vertical-align:top; white-space:nowrap;"><span style="background-color:${bg}; color:${fg}; padding:1px 6px; border-radius:10px; font-size:11px;">${escHtml(e.cat)}</span></td>
      <td style="padding:6px 8px; vertical-align:top;"><span style="color:#1f2937; font-weight:${e.level === "高" ? "bold" : "normal"};">${escHtml(e.title)}</span> ${impactHtml}${chain}</td></tr>`;
    })
    .join("");
  const win = window
    ? `<div style="font-size:12px; color:#64748b; margin:0 0 6px 0;">涵蓋區間：${escHtml(window)}</div>`
    : "";
  return `<div style="margin-bottom:12px;">
    <div style="font-weight:bold; color:#0369a1; font-size:14px; margin-bottom:4px;">🕒 過去一天大事</div>
    ${win}
    <table style="width:100%; border-collapse:collapse; font-size:13px; background-color:#ffffff; border:1px solid #e0f2fe; border-radius:6px;"><tbody>${rows}</tbody></table>
  </div>`;
}

/**
 * 美股指標股：台股電子供應鏈的隔夜對照組。
 *
 * 價格全部來自 fetch-intl-market.ts（程式抓的），worker 只補「為什麼動 / 對到台股誰」，
 * 所以就算 worker 沒跑，這段仍然有完整數字。名單固定、由強到弱排，掃第一行就知道
 * 昨晚是 AI 晶片在噴還是記憶體在殺。
 */
function renderIntlMovers(movers: IntlMover[] | null | undefined): string {
  if (!movers || movers.length === 0) return "";
  const chips = movers
    .map((m) => {
      const up = m.pct >= 0;
      const color = up ? "#dc2626" : "#16a34a";
      return `<span style="display:inline-block; margin:0 10px 4px 0; white-space:nowrap;"><span style="color:#6b7280;">${m.name}</span> <strong>${m.close.toLocaleString()}</strong> <span style="color:${color}; font-weight:bold;">${up ? "+" : ""}${m.pct.toFixed(2)}%</span></span>`;
    })
    .join("");
  // 有 worker 註解的才展開成一行說明，沒有的就只是上面那排數字，不硬湊理由。
  const notes = movers
    .filter((m) => m.why)
    .map((m) => {
      const up = m.pct >= 0;
      const color = up ? "#dc2626" : "#16a34a";
      const tw = m.tw ? `<span style="color:#9ca3af;">　台股連動：${escHtml(m.tw)}</span>` : "";
      return `<div style="margin-top:4px; font-size:12px; color:#475569;"><strong style="color:#1f2937;">${m.name}</strong> <span style="color:${color}; font-weight:bold;">${up ? "+" : ""}${m.pct.toFixed(2)}%</span>　${m.why ? escHtml(m.why) : ""}${tw}</div>`;
    })
    .join("");
  return `<div style="margin-bottom:12px;">
    <div style="font-weight:bold; color:#0369a1; font-size:14px; margin-bottom:4px;">🇺🇸 美股指標股（最近一個收盤）</div>
    <div style="font-size:13px;">${chips}</div>
    ${notes}
  </div>`;
}

/**
 * 美股板塊資金流向熱圖。
 *
 * 回答的問題是「錢往哪個板塊跑」——指數收紅收黑是結果，板塊之間的相對強弱才看得出
 * 資金在做什麼輪動，而且直接對得上台股的族群（半導體→台積電供應鏈、非必需消費→
 * 電商/零售代工）。
 *
 * 主數字有兩種來源，優先用真正的資金流：
 *  - **淨流量**：ETF 淨申購／贖回（股數變化 × 淨值），是真的有錢進出。需要跨日快照，
 *    所以剛開始跑的前幾天沒有這個數字（見 fetch-sector-flows.ts）。
 *  - **週漲跌幅**：流量還沒累積出來時的替代主數字，至少仍看得出板塊相對強弱。
 * 兩者混用會誤導，所以整張圖一次只用同一種，標題直接寫明現在看的是哪一種。
 *
 * 顏色沿用報告一貫的台股慣例**紅＝流入／上漲、綠＝流出／下跌**（與多數美股網站相反），
 * 深淺按當日最大絕對值等比例，讓小格子也拉得開。
 * 版面用固定四欄的 <table>：Gmail 不支援 grid，表格在所有用戶端都畫得出來。
 */
function sectorTileColor(v: number, max: number): { bg: string; fg: string } {
  const t = max > 0 ? Math.min(1, Math.abs(v) / max) : 0;
  const light = 0.95 - 0.35 * Math.sqrt(t);
  const [h, sat] = v >= 0 ? [0, 72] : [145, 45];
  return { bg: `hsl(${h}, ${sat}%, ${Math.round(light * 100)}%)`, fg: v >= 0 ? "#991b1b" : "#166534" };
}

function fmtFlow(usd: number): string {
  const abs = Math.abs(usd);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  return `$${Math.round(abs / 1e6)}M`;
}

function renderSectorFlows(sectors: SectorFlow[] | null | undefined): string {
  if (!sectors || sectors.length === 0) return "";

  // 全部板塊都算得出流量才用流量當主數字：只有一半有數字的話，格子之間沒得比。
  const useFlow = sectors.every((s) => s.flow1w !== null);
  const days = sectors.find((s) => s.flowDays1w)?.flowDays1w ?? null;
  const metric = (s: SectorFlow): number | null => (useFlow ? s.flow1w : s.ret1w);
  const label = useFlow
    ? `ETF 淨流量${days ? `（近 ${days} 個交易日）` : ""}`
    : "近 5 個交易日漲跌幅";

  const values = sectors.map((s) => metric(s)).filter((v): v is number => v !== null);
  if (values.length === 0) return "";
  const max = Math.max(...values.map(Math.abs));

  // 由強到弱排：第一格就是昨晚資金最集中的板塊。
  const sorted = [...sectors].sort((a, b) => (metric(b) ?? -Infinity) - (metric(a) ?? -Infinity));

  const tile = (s: SectorFlow): string => {
    const v = metric(s);
    if (v === null) return `<td style="width:25%; padding:3px;"></td>`;
    const { bg, fg } = sectorTileColor(v, max);
    const arrow = v >= 0 ? "↑" : "↓";
    const main = useFlow ? fmtFlow(v) : `${Math.abs(v).toFixed(2)}%`;
    const sub = [
      s.rsi14 !== null ? `RSI ${s.rsi14.toFixed(1)}` : "",
      s.pe !== null ? `PE ${s.pe.toFixed(1)}x` : "",
      useFlow && s.ret1w !== null ? `週${s.ret1w >= 0 ? "+" : ""}${s.ret1w.toFixed(1)}%` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `<td style="width:25%; padding:3px; vertical-align:top;">
      <div style="background-color:${bg}; border-radius:8px; padding:10px 8px; text-align:center;">
        <div style="color:#1f2937; font-weight:bold; font-size:13px;">${s.name}</div>
        <div style="color:${fg}; font-weight:bold; font-size:16px; margin:3px 0;">${arrow} ${main}</div>
        <div style="color:#6b7280; font-size:11px;">${sub}</div>
      </div></td>`;
  };

  const rows: string[] = [];
  for (let i = 0; i < sorted.length; i += 4) {
    const cells = sorted.slice(i, i + 4).map(tile);
    while (cells.length < 4) cells.push(`<td style="width:25%; padding:3px;"></td>`);
    rows.push(`<tr>${cells.join("")}</tr>`);
  }

  // 沒有流量時把原因寫清楚，不然看到「漲跌幅」會以為是流量。
  const note = useFlow
    ? "ETF 淨申購／贖回推算（流通股數變化 × 淨值），正＝資金淨流入。紅＝流入、綠＝流出。"
    : "淨流量需要跨日的流通股數快照，從今天開始累積，滿 5 個交易日後這張圖會改用真正的資金流量；目前先以近 5 日漲跌幅呈現板塊強弱。";

  return `<div style="margin-bottom:12px;">
    <div style="font-weight:bold; color:#0369a1; font-size:14px; margin-bottom:4px;">🗺️ 美股板塊熱圖（${label}）</div>
    <table style="width:100%; border-collapse:collapse;"><tbody>${rows.join("")}</tbody></table>
    <div style="font-size:11px; color:#9ca3af; margin-top:4px;">${note}</div>
  </div>`;
}

function renderIntl(intl: IntlBlock | null | undefined): string {
  if (!intl) return "";
  const { summary, indices, credit, events, movers, window, sectors } = intl;
  if (
    !summary &&
    (!indices || indices.length === 0) &&
    (!credit || credit.length === 0) &&
    (!events || events.length === 0) &&
    (!movers || movers.length === 0) &&
    (!sectors || sectors.length === 0)
  )
    return "";

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
    ? `<p style="line-height:1.6; margin:0;">${escHtml(summary).replace(/\n/g, "<br>")}</p>`
    : "";

  // 順序＝閱讀動線：先知道發生了什麼事（時間軸），再看誰動了（指標股、指數），最後看判讀。
  return `<div style="background-color:#f0f9ff; border:1px solid #bae6fd; padding:15px; border-radius:8px; margin-bottom:20px;">
      <h3 style="margin-top:0; color:#0369a1;">🌐 國際情勢</h3>
      ${renderIntlEvents(events, window)}
      ${renderIntlMovers(movers)}
      ${renderSectorFlows(sectors)}
      ${tableHtml}
      ${summaryHtml}
    </div>`;
}

function escHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * 財經 KOL 觀點：只列「上次報告之後的新節目」，沒有新內容時整個分頁不出現。
 * 標題與連結來自外部 RSS，一律 escape；insight 是 worker 寫的摘要，不是原文。
 */
function renderKol(kol: KolBlock | null | undefined): string {
  if (!kol || !kol.items || kol.items.length === 0) return "";
  const stanceColor: Record<string, string> = { 偏多: "#dc2626", 偏空: "#16a34a", 中性: "#6b7280" };
  const cards = kol.items
    .map((it) => {
      const color = stanceColor[it.stance ?? ""] ?? "#6b7280";
      const stance = it.stance
        ? `<span style="display:inline-block; font-size:11px; font-weight:bold; color:${color}; border:1px solid ${color}; border-radius:999px; padding:0 8px; margin-left:6px;">${escHtml(it.stance)}</span>`
        : "";
      const tickers = it.tickers && it.tickers.length > 0
        ? `<div style="font-size:12px; color:#6b7280; margin-top:4px;">提到：${it.tickers.map(escHtml).join("、")}</div>`
        : "";
      const notesOnly = it.basis === "notes"
        ? `<span style="font-size:11px; color:#9ca3af;">（僅依節目說明，未取得逐字稿）</span>`
        : "";
      return `<div style="border-top:1px solid #e9d5ff; padding:10px 0;">
        <div style="font-size:13px;"><strong style="color:#6b21a8;">${escHtml(it.source)}</strong>${stance} <span style="color:#9ca3af; font-size:12px;">${escHtml(it.publishedAt)}</span></div>
        <div style="font-size:13px; margin:2px 0 4px;">${/^https?:\/\//i.test(it.url) ? `<a href="${escHtml(it.url)}" style="color:#7c3aed;">${escHtml(it.title)}</a>` : escHtml(it.title)}</div>
        <div style="line-height:1.6;">${escHtml(it.insight).replace(/\n/g, "<br>")} ${notesOnly}</div>
        ${tickers}
      </div>`;
    })
    .join("");
  const overview = kol.overview
    ? `<p style="line-height:1.6; margin:0 0 6px;">${escHtml(kol.overview).replace(/\n/g, "<br>")}</p>`
    : "";
  return `<div style="background-color:#faf5ff; border:1px solid #e9d5ff; padding:15px; border-radius:8px; margin-bottom:20px;">
      <h3 style="margin-top:0; color:#6b21a8;">🎙️ KOL 觀點</h3>
      ${overview}
      ${cards}
      <div style="font-size:11px; color:#9ca3af; margin-top:6px;">以上為節目內容的 AI 摘要，是他人觀點、不是事實，也不是投資建議；細節以原節目為準。</div>
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
        <td style="padding:3px 6px; white-space:nowrap;"><a href="https://tw.stock.yahoo.com/quote/${s.code}" target="_blank" style="color:#374151; text-decoration:none;">${s.code} ${s.name}</a></td>
        <td style="padding:3px 6px; text-align:right; color:#9ca3af; white-space:nowrap;">${pctSign}${s.pct.toFixed(2)}%</td>
        <td style="padding:3px 6px; text-align:right; font-weight:bold; color:${color}; white-space:nowrap;">${sign}${s.points.toFixed(2)}</td>
        <td style="padding:3px 6px; color:#9ca3af; font-size:11px;">${s.industry}</td>
      </tr>`;
    })
    .join("");
  return `<div style="font-size:12px; font-weight:bold; color:#6b7280; margin-bottom:4px; padding:0 6px;">${title}</div>
      <table style="width:100%; border-collapse:collapse; font-size:12px;"><tbody>${rows}</tbody></table>`;
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
      <svg width="${W}" height="${H + 24}" viewBox="0 -20 ${W} ${H + 24}" style="width:${W}px; max-width:none; font-family:${FONT_STACK};" role="img" aria-label="指數貢獻傳導圖">
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
      <div style="margin-top:10px;">${
        // 推升／拖累兩張榜：寬螢幕左右並排、窄螢幕（手機 375px）自動上下堆疊。
        // 原本是兩欄 <table>，手機上兩張各 300px 的榜硬擠一排，整頁被撐出水平捲軸。
        // inline-block + min-width 是信件也吃的寫法（同總覽頁的雙欄）；兩個 div 之間不能有空白，否則 49%+1%+49% 會被擠到換行。
        `<div class="split-col" style="display:inline-block; width:49%; min-width:290px; vertical-align:top; margin-bottom:8px;">${renderContribStockList("推升最多", c.topGainers, true)}</div>` +
        `<div class="split-col" style="display:inline-block; width:49%; min-width:290px; vertical-align:top; margin-left:1%; margin-bottom:8px;">${renderContribStockList("拖累最多", c.topLosers, false)}</div>`
      }</div>
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
        <td style="padding:6px 8px; font-size:13px; color:#374151;">${list.map(escHtml).join("、") || "—"}<div style="color:#9ca3af; font-size:11px; margin-top:2px;">${m.desc}</div></td>
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
              <strong style="color:#1f2937;"> ${escHtml(al.sector)}</strong>
              <span style="color:#6b7280;"> — ${escHtml(al.kind)}</span>
            </div>
            <div style="font-size:12px; color:#4b5563; line-height:1.6; margin-top:3px;">${escHtml(al.detail)}</div>
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
              `<div style="font-size:12px; color:#4b5563; line-height:1.6; margin-bottom:4px;">・<strong>${escHtml(r.kind)}</strong>（${r.sectors.length} 個族群）：${escHtml(r.note)}</div>`,
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
    (r.streak >= 2 ? badge("#f3f4f6", "#6b7280", `連${r.streak}週`, "連續多週增加。⚠️ 這不是加分項——46 週回測裡「連 2 週以上」相對「本週才剛轉增」的下週報酬，5 個門檻 × 3 個視角沒有一格達到顯著。只當背景資訊看") : "") +
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
      <a href="https://tw.stock.yahoo.com/quote/${r.code}" target="_blank" style="color:#374151; text-decoration:none; font-weight:bold;">${r.code} ${r.name}</a>
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
        <br>「連N週」是灰色的、<strong>不加分</strong>：46 週回測（2025-09 ~ 2026-08）裡「連 2 週以上」相對「本週才剛轉為增加」的下週報酬，
        5 個門檻 × 3 個視角共 15 格，7 格正、8 格負，介於 −0.77% ~ +0.54%/週，<strong>|t| 全部小於 1.7，沒有一格顯著</strong>。
        直覺上「連兩週買代表大戶看好」，但資料上看不出這個效果——多等一次確認既沒多賺也沒少賺。排序分數裡原本有的連續加碼加分已經移除。
        <br>同一份回測還顯示：<strong>「大戶增加」本身在這一年沒有預測力</strong>（增加組相對減碼組的 t 值全部落在 ±1.6 以內）。
        <strong>所以這是觀察名單，不是買賣訊號</strong>。
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
        絕對門檻會讓榜單被小型股洗版。
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
            '<td style="padding:4px 6px;white-space:nowrap;"><a href="https://tw.stock.yahoo.com/quote/'+r[0]+'" target="_blank" style="color:#374151;text-decoration:none;font-weight:bold;">'+r[0]+' '+esc(r[1])+'</a><span style="color:#d1d5db;font-size:10px;"> '+(r[2]?'上市':'上櫃')+'</span>'+f+'</td>'+
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
  futures: { level: string; margin: string } | null;
  reason: string;
  signals: PickSignal[];
  themeRadar?: Array<{ id: string; name: string; ratio: number; z: number; recentMentions: number }>;
  plan: { entry: string; stop: string; exit: string };
  metrics: Record<string, string>;
}
interface PicksReport {
  generatedAt: string;
  date: string;
  basis: { tdccWeek?: string | null; cbWeek?: string | null; cbAsOf?: string | null; revenueMonth?: string | null; themeRadarAsOf?: string | null; rrgAsOf?: string | null; priceHistoryDays?: number };
  regimeNotes: string[];
  themeRadar?: { signals: Array<{ id: string; name: string; tickers: string[]; ratio: number; z: number; recentMentions: number }>; warnings: string[] } | null;
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
/** 與 renderFuturesBadge 同一種呈現，讓選股池和漲跌 100 名單看起來一致 */
function renderPickFutures(p: PickEntry): string {
  if (!p.futures) return "";
  const label = [p.futures.level, p.futures.margin].filter(Boolean).join(" ");
  return `<span style="font-size:11px; background-color:#e0e7ff; color:#4338ca; padding:1px 5px; border-radius:4px; margin-left:4px; white-space:nowrap;">期貨(${label})</span>`;
}

function renderPicks(picks: PicksReport | null): string {
  if (!picks || (!picks.long.length && !picks.short.length)) return "";

  const escapeTheme = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
  const themeNote = (p: PickEntry): string => (p.themeRadar ?? []).map((theme) =>
    `題材新聞觀察：${escapeTheme(theme.name)}（近 4 週占比 ${theme.ratio.toFixed(1)} 倍、${theme.recentMentions} 篇；不計分）`,
  ).join("；");

  const metricLabel: Record<string, string> = {
    r10: "近兩週", r20: "近一月", ma10: "MA10", ma20: "MA20", ma60: "MA60", high20: "20日高",
    dayTrade: "當沖比", instNet: "法人買賣超", quadrant: "RRG 族群", tdcc: "集保觀察", cb: "CB+設質事件", revenue: "營運品質",
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
          <td style="padding:6px 8px; white-space:nowrap;"><a href="https://tw.stock.yahoo.com/quote/${p.code}" target="_blank" style="text-decoration:none;"><strong style="color:#1f2937;">${p.name}</strong> <span style="color:#9ca3af; font-size:12px;">${p.code}</span></a>${renderPickFutures(p)}</td>
          <td style="padding:6px 8px; text-align:right; white-space:nowrap;">${p.close}</td>
          <td style="padding:6px 8px; text-align:center;"><span style="background:${accent}; color:#fff; border-radius:10px; padding:1px 8px; font-weight:bold; font-size:12px;">${p.score}</span></td>
          <td style="padding:6px 8px; white-space:nowrap; font-size:12px; color:#6b7280;">${p.type}</td>
          <td style="padding:6px 8px; font-size:12px; line-height:1.6; color:#4b5563;">${badges}${badges ? "<br>" : ""}${escHtml(p.reason)}${themeNote(p) ? `<br><span style="color:#0369a1;">${themeNote(p)}</span>` : ""}${warn ? `<br><span style="color:#b45309;">⚠ ${warn}</span>` : ""}</td>
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
          .map((s) => `<li style="color:${s.tone === "pos" ? "#166534" : "#b45309"};"><strong>${escHtml(s.label)}</strong>：${escHtml(s.detail)}</li>`)
          .join("");
        const mRows = Object.entries(p.metrics)
          .filter(([, v]) => v && v !== "—")
          .map(([k, v]) => `<span style="display:inline-block; margin:0 12px 3px 0; white-space:nowrap;"><span style="color:#9ca3af;">${metricLabel[k] ?? k}</span> <strong style="color:#374151;">${v}</strong></span>`)
          .join("");
        return `<details style="border:1px solid #e5e7eb; border-radius:6px; margin-bottom:6px; background:#fff;">
        <summary style="cursor:pointer; padding:8px 12px; font-size:13px; user-select:none;"><strong>${p.rank}. ${p.name}</strong> <a href="https://tw.stock.yahoo.com/quote/${p.code}" target="_blank" style="color:#9ca3af; text-decoration:none;">${p.code} ↗</a>${renderPickFutures(p)} · ${p.score} 分 · ${p.type} <span style="color:#9ca3af; font-size:12px;">— 點開看訊號明細與進出場</span></summary>
        <div style="padding:4px 14px 12px; font-size:13px; line-height:1.7;">
          <ul style="margin:6px 0; padding-left:18px;">${sigRows}${themeNote(p) ? `<li style="color:#0369a1;">${themeNote(p)}</li>` : ""}</ul>
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
      <div style="margin-top:10px;">${detailBlocks(list)}</div>
    </div>`;
  };

  const regime = picks.regimeNotes.length
    ? `<div style="background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:8px 12px; font-size:12px; color:#92400e; line-height:1.7; margin-bottom:12px;"><strong>大盤狀態提醒</strong>（來自族群輪動）：${picks.regimeNotes.map((n) => `<div>· ${n}</div>`).join("")}<div>出現「大盤全面回檔」特徵時，以下新倉建議減半。</div></div>`
    : "";

  const basis = picks.basis;
  const themeOverview = picks.themeRadar
    ? `<div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:6px; padding:8px 12px; margin-bottom:12px; font-size:12px; color:#1e3a8a; line-height:1.7;">
        <strong>題材新聞加速觀察</strong>（最近 4 個完整週對比前 12 週；不計入選股分數）
        ${picks.themeRadar.signals.length
          ? picks.themeRadar.signals.map((signal) => `<div>· ${escapeTheme(signal.name)}：提及占比 ${signal.ratio.toFixed(1)} 倍、${signal.recentMentions} 篇；關聯個股 ${signal.tickers.join("、")}</div>`).join("")
          : "<div>目前沒有符合門檻的題材；首次啟用需要累積約 16 週 RSS 文章。</div>"}
        ${picks.themeRadar.warnings.length ? "<div>部分 RSS 來源缺漏，本次不發加速訊號。</div>" : ""}
      </div>` : "";
  // 型態名稱由 build-stock-picks.ts 的 toPick() 決定；這裡說明同一個價格判斷
  // 在長線榜與波段榜各代表什麼，避免把「等待確認」誤讀成營收尚未公布。
  const typeGuide = `<div style="background:#fff; border:1px solid #cbd5e1; border-radius:8px; padding:12px 14px; margin-bottom:16px; font-size:12px; color:#475569; line-height:1.7;">
    <h4 style="margin:0 0 6px; color:#334155; font-size:14px;">📖 選股型態怎麼看</h4>
    <div><strong>營運先行·等待確認</strong>（長線）：營收已通過篩選，但價格符合以下任一情況：未站上 MA20、近 20 日漲幅低於 5%、距 20 日高點超過 5%。「等待」指價格，並非營收尚未公布。</div>
    <div><strong>營運成長·趨勢確認</strong>（長線）：營收已通過篩選，且未觸發上述價格等待條件；仍須看營運能否延續，並依進場與風控計畫執行。</div>
    <div><strong>回檔觀察</strong>（波段）：距 20 日高點超過 5%；若有營運訊號，也檢查是否站上 MA20 與近 20 日漲幅。這表示短線仍待價格確認，不表示已經落底。</div>
    <div><strong>動能順勢</strong>（波段）：未觸發價格等待條件；依個股計畫等回測 MA10 不破或整理後突破，再考慮進場。</div>
    <div style="border-top:1px solid #e2e8f0; margin-top:7px; padding-top:7px;"><strong>RRG 怎麼用：</strong>個股依所屬族群對應四象限；領先／改善可提供產業趨勢分，長線遇弱化會扣分。短線與當日族群訊號取較高分，不重複累加；RRG 是族群佐證，並非單獨的買進條件。</div>
  </div>`;
  return `<div style="background-color:#f8fafc; border:1px solid #e2e8f0; padding:15px; border-radius:8px; margin-bottom:20px;">
    <h3 style="margin-top:0; color:#334155;">🏆 終極選股池（${picks.date}）</h3>
    <p style="font-size:13px; color:#4b5563; line-height:1.7; margin:0 0 10px;">
      長線榜先要求營收成長，再用 TTM 營收、毛利率、產業趨勢與法人確認；波段榜分開看價格、法人、族群與營運催化。
      集保與 CB+設質只作觀察或風險註記，不再單獨構成長線理由；同一檔可以同時出現在兩榜。
      分數是排序用的相對值，不同天之間不可直接比大小。
    </p>
    ${typeGuide}
    ${regime}
    ${themeOverview}
    ${listSection(
      "🐢 長線研究 Top 10（3 個月～1 年）",
      "先看營運成長能否延續，再由毛利率、產業趨勢與法人確認。技術面管理建倉節奏；長期論點由營收品質與產業假設決定。",
      picks.long, "#0d9488", "#99f6e4", "#f0fdfa",
    )}
    ${listSection(
      "⚡ 波段動能 Top 10（2 週～3 個月）",
      "看價格確認、法人、族群與營運催化；相同價格訊號只算一個證據家族。嚴設停損，催化未兌現或趨勢轉弱就走。",
      picks.short, "#ea580c", "#fed7aa", "#fff7ed",
    )}
    <p style="font-size:11px; color:#9ca3af; line-height:1.6; margin:4px 0 0;">
      資料基準：營收 ${basis.revenueMonth ?? "—"}、題材新聞 ${basis.themeRadarAsOf ?? "—"}（觀察）、集保 ${basis.tdccWeek ?? "—"}（週）、CB+設質 ${basis.cbAsOf ?? basis.cbWeek ?? "—"}（CB 日頻／設質月頻）、RRG ${basis.rrgAsOf ?? "—"}、價格序列 ${basis.priceHistoryDays ?? 0} 個交易日。
      純規則計算（無 AI 判讀），每日快照存於 stock-picks-history 供回測。非投資建議。
    </p>
  </div>`;
}

/**
 * 交易檢討（data/trade-review-latest.json，由每日功課的持股健檢產出）。
 * 網頁是公開的：檔案只放標的、方向與文字檢討，不放數量、均價、損益——
 * 完整版（含金額）只寫在私人的 Notion 月份頁。
 */
interface TradeReviewItem {
  name: string;
  side?: string;
  kind?: string;
  status?: string;
  note: string;
}
interface TradeReview {
  date: string;
  summary?: string;
  trades?: TradeReviewItem[];
  holdings?: TradeReviewItem[];
}

function renderTradeReview(r: TradeReview | null): string {
  if (!r || (!r.trades?.length && !r.holdings?.length)) return "";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const card = (it: TradeReviewItem) => {
    const tags = [it.kind, it.side, it.status].filter(Boolean).map((t) =>
      `<span style="display:inline-block; font-size:11px; color:#475569; background:#f1f5f9; border-radius:999px; padding:1px 7px; margin-left:4px;">${esc(t!)}</span>`,
    ).join("");
    return `<div style="border:1px solid #e5e7eb; border-radius:6px; padding:9px 12px; margin-bottom:8px; background:#fff;">
        <div style="margin-bottom:3px;"><strong style="color:#1f2937;">${esc(it.name)}</strong>${tags}</div>
        <div style="font-size:13px; color:#374151; line-height:1.75;">${esc(it.note).replace(/\n/g, "<br>")}</div>
      </div>`;
  };
  const block = (title: string, list?: TradeReviewItem[]) =>
    list?.length ? `<h4 style="margin:14px 0 8px; color:#334155;">${title}</h4>${list.map(card).join("")}` : "";
  return `<div style="background-color:#f8fafc; border:1px solid #e2e8f0; padding:15px; border-radius:8px; margin-bottom:20px;">
    <h3 style="margin-top:0; color:#334155;">📒 交易檢討</h3>
    ${r.summary ? `<p style="font-size:13px; color:#4b5563; line-height:1.8; margin:0 0 4px;">${esc(r.summary).replace(/\n/g, "<br>")}</p>` : ""}
    ${block("本期進出場", r.trades)}
    ${block("持倉健檢", r.holdings)}
    <p style="font-size:11px; color:#9ca3af; line-height:1.6; margin:8px 0 0;">個人交易紀錄的流程檢討，不含部位大小與損益；非投資建議。</p>
  </div>`;
}

/**
 * 頁面層級的樣式。
 *
 * 內容區的樣式大多是 inline（以前要兼顧 Email，2026-10 起不再寄信）。這段只補
 * inline 做不到的部分：
 * - 導覽列的樣式跟著 lib/nav.ts 的 <nav> 一起輸出，不在這裡。
 * - 深色模式：內容有上百處寫死的淺色 inline 顏色，逐一改 token 成本太高，所以用
 *   「反相 + 色相轉 180°」整頁翻成深色——亮度反轉、色相不變，紅漲綠跌的語意保留。
 *   內嵌的互動 RRG 有自己的深色主題，若兩者都生效會負負得正變回淺色，所以下方 script
 *   把 <html data-theme="light"> 鎖住 RRG 的淺色 token，讓它跟報告其他部分一起被反相。
 */
const WEB_CSS = `<style>
  body{margin:0;background:#fff;}
  a.stk{color:inherit;text-decoration:underline dotted #a5b4fc;text-underline-offset:3px;}
  a.stk:hover{color:#4338ca;text-decoration-color:#4338ca;}
  @media (max-width:640px){
    .rpt h1{font-size:21px !important;}
    /* 雙欄區塊在手機上已經上下堆疊，改成滿版，不要只佔 300px 留一條空白 */
    .split-col{display:block !important;width:auto !important;min-width:0 !important;margin-left:0 !important;}
  }
  @media (prefers-color-scheme:dark){
    /* 反相 .86 而不是滿格：白底翻成 #242424 的深灰，不是接近純黑（使用者覺得太暗）。
       html 底色要跟反相後的白底一致，否則內容區兩側會出現色差。 */
    html,body{background:#242424;}
    .rpt{filter:invert(.86) hue-rotate(180deg);background:#fff;}
    .rpt img{filter:invert(1) hue-rotate(180deg);}
  }
</style>`;

/** 讀 data/ 底下的 JSON；缺檔或壞檔回 null（首頁摘要是加分項，不能擋掉整份報告）。 */
function readDataJson<T>(rel: string): T | null {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), rel), "utf-8")) as T;
  } catch {
    return null;
  }
}

interface HomeInput {
  a: Analysis;
  market?: MarketBlock | null;
  mo?: MarginOptionsReport | null;
  picks?: PicksReport | null;
  tdcc?: DivergenceReport | null;
  tradeReview?: TradeReview | null;
  /** 今天實際有輸出的分頁；不在裡面的分頁不給連結，免得點了落回首頁。 */
  tabs: string[];
}

/** 台股慣例：紅漲綠跌。 */
const upDown = (n: number) => (n > 0 ? "#dc2626" : n < 0 ? "#16a34a" : "#6b7280");
const signed = (n: number, digits = 1) => `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;

/**
 * 首頁「今日重點」：打開就看到今天的結論，一個畫面看完。
 *
 * 由上而下：一段盤後總結 → 市場溫度計（指數、廣度、法人、融資、散戶、選擇權）→
 * 操作三分類 → 各名單今天的狀態與資料日期 → 國際／KOL／交易檢討各一句。
 * 每一塊都連到詳細分頁或子頁。
 *
 * 跟報告其他部分一樣用 inline style；溫度計格子用 inline-block，窄螢幕自動折行。
 */
function renderHome(h: HomeInput): string {
  const { a } = h;
  const tabHref = (label: string) => (h.tabs.includes(label) ? `#tab=${encodeURIComponent(label)}` : null);
  const more = (href: string | null, text = "看詳細") =>
    href ? `<a href="${href}" style="color:#4f46e5; font-size:12px; font-weight:bold; text-decoration:none; white-space:nowrap;">${text} →</a>` : "";
  const card = (title: string, inner: string, link = "") =>
    `<div style="background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:12px 14px; margin-bottom:12px;">
      <div style="margin-bottom:8px;"><span style="font-size:15px; font-weight:800; color:#111827;">${title}</span>${link ? `<span style="float:right;">${link}</span>` : ""}</div>
      ${inner}
    </div>`;

  // 1. 盤後總結
  const summary = `<div style="background:#eef2ff; border:1px solid #c7d2fe; border-radius:10px; padding:12px 14px; margin-bottom:12px;">
      <div style="font-size:12px; font-weight:bold; color:#4f46e5; margin-bottom:4px;">📝 今天的結論 · ${a.timestamp}</div>
      <p style="margin:0; font-size:14px; line-height:1.8; color:#1f2937;">${escHtml(a.summary).replace(/\n/g, "<br>")}</p>
    </div>`;

  // 2. 市場溫度計：每格一個數字＋一行補充。inline-block 讓寬螢幕排成一列、手機自動折行。
  const tiles: string[] = [];
  const tile = (label: string, value: string, sub: string, color = "#111827") =>
    tiles.push(`<div style="display:inline-block; vertical-align:top; box-sizing:border-box; width:132px; margin:0 4px 6px 0; padding:8px 9px; border:1px solid #e5e7eb; border-radius:8px; background:#f9fafb;">
      <div style="font-size:11px; color:#6b7280;">${label}</div>
      <div style="font-size:16px; font-weight:800; color:${color}; line-height:1.4; white-space:nowrap;">${value}</div>
      <div style="font-size:11px; color:#6b7280; line-height:1.4;">${sub}</div>
    </div>`);
  const m = h.market;
  const idx = (name: string, x?: { close: number; change: number }) => {
    if (!x) return;
    const prev = x.close - x.change;
    const pct = prev ? (x.change / prev) * 100 : 0;
    tile(name, x.close.toLocaleString(), `<span style="color:${upDown(x.change)}; font-weight:bold;">${signed(x.change, 2)}（${signed(pct, 2)}%）</span>`);
  };
  idx("加權指數", m?.taiex);
  idx("櫃買指數", m?.tpex);
  if (m?.breadth) {
    const b = m.breadth;
    tile("上漲／下跌", `<span style="color:#dc2626;">${b.up}</span> / <span style="color:#16a34a;">${b.down}</span>`, `漲停 ${b.limitUp}／跌停 ${b.limitDown}`);
  }
  if (m?.institutional) {
    const i = m.institutional;
    tile("三大法人（上市）", `${signed(i.totalNet)} 億`, `外 ${signed(i.foreignNet)}／投 ${signed(i.trustNet)}／自 ${signed(i.dealerNet)}`, upDown(i.totalNet));
  }
  const mg = h.mo?.margin;
  if (mg) {
    const mt = mg.maintenance;
    tile("融資餘額（上市）", `${mg.twseAmount.toLocaleString()} 億`, `<span style="color:${upDown(mg.dAmount)};">${signed(mg.dAmount)} 億</span>${mt === null ? "" : `　維持率 ${mt.toFixed(0)}%`}`);
  }
  // 跟儀表板一樣只用當天快照；不從歷史序列回補，免得把好幾天前的數字當成今天的
  const retail = m?.microFuturesRetail ? { pct: m.microFuturesRetail.retailNetPct, date: m.microFuturesRetail.dataDate } : null;
  if (retail) {
    // 散戶是反指標：淨空（負值）對大盤偏多，所以顏色跟數字方向相反
    tile("微台散戶淨多空", `${signed(retail.pct, 2)}%`, `${retail.pct < 0 ? "散戶偏空（反指標偏多）" : "散戶偏多（反指標偏空）"}<br>${retail.date}`, upDown(retail.pct));
  }
  const op = h.mo?.options;
  if (op) {
    const net = op.bull.lots - op.bear.lots;
    const dNet = op.bull.dLots - op.bear.dLots;
    tile("外資選擇權淨部位", `${net > 0 ? "偏多" : net < 0 ? "偏空" : "中性"} ${Math.abs(net).toLocaleString()} 口`, `日變化 ${dNet > 0 ? "+" : ""}${dNet.toLocaleString()} 口`, upDown(net));
  }
  const gauges = tiles.length ? card("🌡️ 市場溫度計", `<div style="margin-bottom:-6px;">${tiles.join("")}</div>`, more(tabHref("📊 市場總覽"), "儀表板")) : "";

  // 3. 操作三分類：playbook 是「可現在介入：…；…\n需關注：…\n避開：…」的文字，拆成三列。
  // 每段開頭的「族群（代表股）」加粗；格式對不上就整段原文照放，不硬拆。
  const BUCKETS = [
    { key: "可現在介入", title: "可介入", color: "#dc2626", bg: "#fef2f2" },
    { key: "需關注", title: "觀察", color: "#d97706", bg: "#fffbeb" },
    { key: "避開", title: "避開", color: "#16a34a", bg: "#f0fdf4" },
  ];
  let playbook = "";
  if (a.playbook) {
    const lines = a.playbook.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const parsed = BUCKETS.map((b) => {
      const line = lines.find((l) => l.startsWith(b.key));
      return { ...b, items: line ? line.replace(new RegExp(`^${b.key}[：:]\\s*`), "").replace(/。$/, "").split("；").filter(Boolean) : [] };
    });
    const body = parsed.some((p) => p.items.length)
      ? parsed
          .filter((p) => p.items.length)
          .map(
            (p) => `<div style="background:${p.bg}; border-left:4px solid ${p.color}; border-radius:6px; padding:8px 10px; margin-bottom:6px;">
          <div style="font-size:12px; font-weight:800; color:${p.color}; margin-bottom:2px;">${p.title}</div>
          ${p.items
            .map((it) => {
              const itEsc = escHtml(it);
              const mm = /^([^，,（]+（[^）]*）)(.*)$/.exec(itEsc);
              return `<div style="font-size:13px; line-height:1.7; color:#374151;">· ${mm ? `<strong style="color:#111827;">${mm[1]}</strong>${mm[2]}` : itEsc}</div>`;
            })
            .join("")}
        </div>`,
          )
          .join("")
      : `<p style="margin:0; font-size:13px; line-height:1.8;">${escHtml(a.playbook).replace(/\n/g, "<br>")}</p>`;
    playbook = card("🎯 今天怎麼做", body, more(tabHref("🎯 操作建議"), "含長線策略"));
  }

  // 4. 各名單今天的狀態。右側標資料日期：日資料若不是今天，標橘色提醒是舊的。
  const rows: string[] = [];
  const row = (title: string, text: string, href: string | null, asOf: string, daily = false) => {
    const stale = daily && asOf !== a.date;
    rows.push(`<tr>
      <td style="padding:7px 8px 7px 0; border-top:1px solid #f1f5f9; white-space:nowrap; vertical-align:top; font-size:13px; font-weight:bold;">${href ? `<a href="${href}" style="color:#4338ca; text-decoration:none;">${title}</a>` : title}</td>
      <td style="padding:7px 8px; border-top:1px solid #f1f5f9; font-size:13px; line-height:1.6; color:#374151;">${text}</td>
      <td style="padding:7px 0 7px 8px; border-top:1px solid #f1f5f9; white-space:nowrap; vertical-align:top; text-align:right; font-size:11px; color:${stale ? "#d97706" : "#9ca3af"};">${asOf}${stale ? " 舊" : ""}</td>
    </tr>`);
  };
  if (h.picks) {
    const top = h.picks.long.slice(0, 3).map((p) => escHtml(p.name)).join("、");
    row("🏆 選股池", `長線 ${h.picks.long.length}、波段 ${h.picks.short.length} 檔${top ? `；長線前三：${top}` : ""}`, tabHref("🏆 終極選股池"), h.picks.date, true);
  }
  type BrokerItem = { stockName: string; broker: string; triggered?: boolean; net?: number };
  const bw = readDataJson<{ tradingDate: string; items: BrokerItem[] }>("data/broker-watch-latest.json");
  if (bw) {
    const hit = bw.items.filter((i) => i.triggered);
    row(
      "🕵️ 贏家分點",
      hit.length ? `觸發 ${hit.length} 組：${hit.slice(0, 4).map((i) => `${escHtml(i.stockName)}（${escHtml(i.broker)}）`).join("、")}${hit.length > 4 ? " 等" : ""}` : `今天沒有觸發（追蹤 ${bw.items.length} 組）`,
      "broker-watch.html",
      bw.tradingDate,
      true,
    );
  }
  // 回測（docs/target-price-backtest.md）：空間大小沒有預測力，共識「下修」後 60 日約跑輸 3%。
  // 所以這列先講近 7 日被下修的（警訊），空間 ≥ 門檻的檔數只當附註。
  type TargetRow = { name: string; qualified: boolean; stale: boolean; lastEvent: { date: string; direction: "up" | "down" } };
  const tp = readDataJson<{ closeDate: string; gate: number; rows: TargetRow[] }>("data/target-price-latest.json");
  if (tp) {
    const weekAgo = new Date(Date.parse(`${tp.closeDate}T00:00:00+08:00`) - 7 * 86_400_000).toISOString().slice(0, 10);
    const down = tp.rows.filter((r) => !r.stale && r.lastEvent.direction === "down" && r.lastEvent.date > weekAgo);
    const downText = down.length
      ? `近 7 日共識被下修 ${down.length} 檔：${down.slice(0, 4).map((r) => escHtml(r.name)).join("、")}${down.length > 4 ? " 等" : ""}（回測之後 60 日約跑輸 3%）`
      : "近 7 日沒有共識被下修";
    row("🎯 目標價", `${downText}；空間 ≥${Math.round(tp.gate * 100)}% 有 ${tp.rows.filter((r) => r.qualified).length} 檔（只當參考）`, "target-price.html", tp.closeDate, true);
  }
  if (h.tdcc) {
    row("🏦 大戶籌碼", `${h.tdcc.universe} 檔的集保大戶週變化（${h.tdcc.prevWeek} → ${h.tdcc.curWeek}）`, tabHref("🏦 大戶籌碼"), h.tdcc.curWeek);
  }
  const rev = readDataJson<{ month: string; partial: boolean; counts: Record<string, number> }>("data/revenue-momentum-latest.json");
  if (rev) {
    row("📈 月營收", `YoY≥20% 共 ${rev.counts["門檻"] ?? 0} 家，核心 ${rev.counts["核心"] ?? 0}、動能 ${rev.counts["動能"] ?? 0}${rev.partial ? "（公布中，名單每天增加）" : ""}`, "revenue.html", `${rev.month} 營收`);
  }
  const dec = readDataJson<{ active: string; lists: { month: string; entries: unknown[] }[] }>("data/revenue-decline-latest.json");
  const decList = dec?.lists.find((l) => l.month === dec.active);
  if (dec && decList) {
    row("📉 營收衰退", `YoY≤−20% 共 ${decList.entries.length} 家（避開／放空候選）`, "revenue-decline.html", `${dec.active} 營收`);
  }
  const cb = readDataJson<{ isoWeek: string; candidates: unknown[] }>("data/cb-pledge-latest.json");
  if (cb) {
    row("🔐 設質CB", `事件觀察池 ${cb.candidates.length} 檔`, "cb-pledge.html", cb.isoWeek);
  }
  const lists = rows.length
    ? card("📋 名單與訊號", `<table style="width:100%; border-collapse:collapse;">${rows.join("")}</table>`)
    : "";

  // 5. 背景與自我檢討，各一句
  const ctx: string[] = [];
  // 只放第一句，其餘看詳細分頁
  const line = (title: string, full: string | undefined, href: string | null) => {
    const text = full?.trim().split(/(?<=。)/)[0];
    if (!text) return;
    ctx.push(`<div style="padding:7px 0; border-top:1px solid #f1f5f9; font-size:13px; line-height:1.7; color:#374151;">
      <strong style="color:#111827;">${title}</strong>　${escHtml(text)} ${more(href)}
    </div>`);
  };
  line("🌐 國際", a.intl?.summary, tabHref("🌐 國際情勢"));
  line("🎙️ KOL", a.kol?.overview, tabHref("🎙️ KOL 觀點"));
  line("📒 交易檢討", h.tradeReview?.summary, tabHref("📒 交易檢討"));
  const context = ctx.length ? card("🧭 背景與檢討", `<div style="margin-top:-7px;">${ctx.join("")}</div>`) : "";

  return `<div style="margin-bottom:20px;">${summary}${gauges}${playbook}${lists}${context}</div>`;
}

function sortGroupsByMemberCount(groups: CategoryGroup[]): CategoryGroup[] {
  // 族群共振是主訊號：一起發動的公司越多，越能代表資金進駐。
  // 「其他／個股事件整理」不是共同題材，固定放最後；同檔數維持 controller 原始順序。
  // entryScore 只顯示、不參與排序。
  const isMisc = (group: CategoryGroup) => /^其他/.test(group.category);
  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => Number(isMisc(a.group)) - Number(isMisc(b.group)) || b.group.stocks.length - a.group.stocks.length || a.index - b.index)
    .map(({ group }) => group);
}

function renderHtml(a: Analysis, stockMap: Record<string, StockMeta>, codeByName: Map<string, string>, market?: MarketBlock | null, retailHistory?: MarketHistoryEntry[], contrib?: IndexContribution | null, tdcc?: DivergenceReport | null, marginHistory?: MarginHistoryEntry[], mo?: MarginOptionsReport | null, picks?: PicksReport | null, tradeReview?: TradeReview | null): string {
  const sortedGainers = sortGroupsByMemberCount(a.gainers);
  const gainersHtml = sortedGainers.map((g) => renderCategoryBlock(g, stockMap, codeByName, "gainer")).join("");
  const losersHtml = sortGroupsByMemberCount(a.losers)
    .map((g) => renderCategoryBlock(g, stockMap, codeByName, "loser")).join("");
  const longTermStrategyHtml = a.longTermStrategy
    ? `<div style="background-color: #eef6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1d4ed8;">🧭 長線策略與進出場</h3>
      <p style="line-height: 1.7; margin-bottom: 0; color: #1e3a8a;">${escHtml(a.longTermStrategy).replace(/\n/g, "<br>")}</p>
    </div>`
    : "";
  const playbookHtml = a.playbook
    ? `<div style="background-color: #fff7ed; border: 1px solid #fed7aa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #c2410c;">🎯 操作建議</h3>
      <p style="line-height: 1.7; margin-bottom: 0; color: #7c2d12;">${escHtml(a.playbook).replace(/\n/g, "<br>")}</p>
    </div>`
    : "";
  const marketDashboardHtml = renderMarketDashboard(market, retailHistory, marginHistory, mo);
  const intlHtml = renderIntl(a.intl);
  const kolHtml = renderKol(a.kol);
  const rrgHtml = renderRrg(a.rrg);
  const contribHtml = renderIndexContribution(contrib);
  const tdccHtml = renderTdcc(tdcc);
  const legendHtml = renderLegend();
  const rubricHtml = renderScoringRubric();

  const summaryHtml = `<div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #1f2937;">📝 盤後總結</h3>
      <p style="line-height: 1.6; margin-bottom: 0;">${escHtml(a.summary).replace(/\n/g, "<br>")}</p>
    </div>`;

  // 圖例／評分說明放在會用到它們的分頁**最上方的摺疊區塊**（<details>，預設收合）。
  // badge 都出現在上漲/下跌族群；進場評分只有強勢族群有，所以評分說明只附在上漲。
  const foldNote = (label: string, inner: string) =>
    `<details style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; margin-bottom:14px;">
      <summary style="cursor:pointer; padding:9px 14px; font-size:13px; font-weight:bold; color:#475569; user-select:none;">📖 ${label}（點開）</summary>
      <div style="padding:0 10px;">${inner}</div>
    </details>`;
  const groupGHtml = `${foldNote("本頁說明：圖例與進場評分", legendHtml + rubricHtml)}<h3 style="color: #dc2626; margin-top: 0;">🔥 強勢焦點（族群共振：檔數多→少）</h3>${gainersHtml}`;
  const groupLHtml = `${foldNote("本頁說明：圖例", legendHtml)}<h3 style="color: #16a34a; margin-top: 0;">🧊 弱勢焦點（族群共振：檔數多→少）</h3>${losersHtml}`;

  // 每個區塊都是一個 tab panel，由頂端導覽列（lib/nav.ts）的 #tab= 連結切換，預設落在首頁。
  const sections: Array<{ label: string; html: string }> = [
    { label: "🔥 上漲族群", html: groupGHtml },
    { label: "🧊 下跌族群", html: groupLHtml },
    // 操作建議：可現在介入 / 需關注 / 避開，放在族群後、總覽前，方便快速決策。
    // 長線策略併在操作建議下面：短線三分類＋長線主線，都是「我要怎麼做」。
    { label: "🎯 操作建議", html: playbookHtml + longTermStrategyHtml },
    // 盤後總結與市場儀表板都是整體市場觀點，合併成一個「市場總覽」tab。
    { label: "📊 市場總覽", html: `${summaryHtml}${marketDashboardHtml}` },
    // 指數貢獻：把當日指數漲跌拆回產業與個股，緊接在市場總覽之後回答「這幾點是誰推的」
    { label: "⚖️ 指數貢獻", html: contribHtml },
    // 族群輪動：中期資金流向，放在市場總覽之後、國際情勢之前
    { label: "🔄 族群輪動", html: rrgHtml },
    // 大戶籌碼：週資料（TDCC 每週五結算），與每日資料放在一起時要留意更新頻率不同
    { label: "🏦 大戶籌碼", html: tdccHtml },
    // 終極選股池：全訊號統合後的最終結論，動線上排在操作建議之後（先看族群層級的結論，再看個股層級的收斂）
    { label: "🏆 終極選股池", html: renderPicks(picks ?? null) },
    { label: "🌐 國際情勢", html: intlHtml },
    { label: "🎙️ KOL 觀點", html: kolHtml },
    { label: "📒 交易檢討", html: renderTradeReview(tradeReview ?? null) },
  ].filter((s) => s.html && s.html.trim());

  // 面板順序照 READ_ORDER；不在動線上的（下跌族群、交易檢討）排最後，維持原相對順序。
  const rank = (label: string) => {
    const i = READ_ORDER.indexOf(label);
    return i < 0 ? 99 : i;
  };
  sections.sort((x, y) => rank(x.label) - rank(y.label));

  const header = `<div style="padding:20px 0 14px; border-bottom:1px solid #e5e7eb; margin-bottom:4px;">
      <div style="font-size:12px; font-weight:bold; color:#6366f1; letter-spacing:1px; margin-bottom:4px;">台股盤後報告 · 漲跌幅前 100 名資金流向</div>
      <h1 style="margin:0; font-size:24px; line-height:1.35; color:#111827; font-weight:800;">📈 台股盤後資金流向與 AI 總結 <span style="display:inline-block; vertical-align:middle; font-size:14px; font-weight:bold; color:#4338ca; background:#eef2ff; border:1px solid #c7d2fe; border-radius:999px; padding:2px 10px; white-space:nowrap;">${a.timestamp}</span></h1>
    </div>`;

  sections.unshift({ label: HOME_LABEL, html: renderHome({ a, market, mo, picks, tdcc, tradeReview, tabs: sections.map((s) => s.label) }) });

  // 敘述文字裡提到的公司（盤後總結、族群故事、操作建議、KOL…）一律接上 Yahoo 連結；
  // 表格與 chip 本來就有連結，linkifyStocks 會跳過既有的 <a>。
  const panelsHtml = linkifyStocks(
    sections.map((s) => `<div class="tabpanel" data-label="${s.label}">${s.html}</div>`).join(""),
  );

  // 單欄 + RWD：viewport 讓手機正確縮放；容器 max-width 1060、左右留白隨螢幕縮放。
  // 內容樣式是 inline；WEB_CSS 只做 inline 做不到的事：hover、手機版面、深色模式。
  return `<meta name="viewport" content="width=device-width, initial-scale=1">
  ${WEB_CSS}
  <div class="rpt" style="font-family:${FONT_STACK}; font-variant-numeric:tabular-nums; -webkit-text-size-adjust:100%; max-width:1060px; margin:0 auto; color:#1f2937; line-height:1.6; padding:0 16px;">
    ${header}
    ${renderSiteNav("index.html", HOME_LABEL)}
    ${panelsHtml}
    <div style="text-align:center; margin-top:32px; padding:18px 0 24px; border-top:1px solid #e5e7eb; color:#9ca3af; font-size:12px;">
      Generated via Claude Code workflow
    </div>
  </div>
  <script>
  (function(){
    // 深色模式由 WEB_CSS 整頁反相處理；內嵌 RRG 鎖在淺色主題，才不會被反相兩次（見 WEB_CSS 說明）
    document.documentElement.setAttribute('data-theme','light');
    var nav=document.querySelector('.gnav');
    var panels=[].slice.call(document.querySelectorAll('.tabpanel'));
    if(!nav||!panels.length)return;
    var labels=panels.map(function(p){return p.getAttribute('data-label');});
    var idxByLabel={};
    labels.forEach(function(l,i){idxByLabel[l]=i;});
    var ALIASES=${JSON.stringify(TAB_ALIASES)};
    // 導覽列是全站共用的（lib/nav.ts），今天沒有輸出的分頁（例如沒有新 KOL 節目）就藏起來
    [].slice.call(nav.querySelectorAll('[data-tab]')).forEach(function(a){
      if(idxByLabel[a.getAttribute('data-tab')]===undefined)a.style.display='none';
    });
    function activate(i){
      panels.forEach(function(p,j){p.style.display=j===i?'':'none';});
      if(window.gnavMark)window.gnavMark(labels[i]);
    }
    // 導覽列是 sticky：在長頁面底部切分頁時，捲回導覽列位置，新分頁才會從頭開始看
    function toTop(){
      var head=nav.previousElementSibling;
      var y=head?head.getBoundingClientRect().bottom+window.pageYOffset:0;
      if(window.pageYOffset>y)window.scrollTo(0,y);
    }
    // 導覽連結都是 #tab=xxx：切分頁一律走 hashchange，重新整理或從子頁連回來也會停在同一頁
    function fromHash(){
      var m=/^#tab=(.+)$/.exec(location.hash||'');
      if(!m)return -1;
      var label=decodeURIComponent(m[1]);
      var i=idxByLabel[ALIASES[label]||label];
      return i===undefined?-1:i;
    }
    var start=fromHash();
    activate(start<0?0:start);
    window.addEventListener('hashchange',function(){var i=fromHash();activate(i<0?0:i);toTop();});
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
      // 存在但讀不了：不能當成空的，否則下面寫回會把歷史覆寫成只剩今天
      throw new Error(`${historyPath} exists but is unreadable or invalid: ${(e as Error).message}. Fix or restore it before re-running.`);
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

async function main() {
  // 略過旗標，第一個非 -- 開頭的參數才是輸入檔
  const inputPath = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "data/analysis-latest.json";
  const resolved = resolve(process.cwd(), inputPath);
  if (!existsSync(resolved)) {
    console.error(`Analysis file not found: ${resolved}`);
    process.exit(1);
  }
  const analysis: Analysis = JSON.parse(readFileSync(resolved, "utf-8"));

  // finalizer 只負責敘事，可能不帶 RRG 欄位；象限與警示是獨立腳本產生的確定資料。
  // 在寄信前補回，否則 renderRrg() 會連同網頁版的互動圖佔位符一起略過。
  if (!analysis.rrg) {
    const rrgPath = resolve(process.cwd(), "data/tw-rrg-alerts.json");
    if (existsSync(rrgPath)) {
      try {
        const rrg: RrgBlock = JSON.parse(readFileSync(rrgPath, "utf-8"));
        if (rrg.asOf === analysis.date && rrg.quadrants && Array.isArray(rrg.alerts) && Array.isArray(rrg.regime)) {
          analysis.rrg = rrg;
          console.log(`Loaded RRG for ${rrg.asOf}`);
        } else {
          console.warn(`[warn] RRG 日期 ${rrg.asOf ?? "未知"} 與分析日 ${analysis.date} 不符或資料不完整，略過族群輪動`);
        }
      } catch {
        console.warn("[warn] tw-rrg-alerts.json 無法解析，略過族群輪動");
      }
    }
  }

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

  // 終極選股池（build-stock-picks.ts 的輸出）。交易日對不上代表是舊榜單，寧缺勿舊。
  const picksPath = resolve(process.cwd(), "data/stock-picks-latest.json");
  let picks: PicksReport | null = null;
  if (existsSync(picksPath)) {
    try {
      const parsed: PicksReport = JSON.parse(readFileSync(picksPath, "utf-8"));
      if (parsed.date === analysis.date || !analysis.date) picks = parsed;
      else console.warn(`stock-picks 交易日 ${parsed.date} 與分析 ${analysis.date} 不符，終極選股池分頁略過`);
    } catch {
      console.warn("stock-picks-latest.json 無法解析，略過");
    }
  }

  // 交易檢討（每日功課寫入）。日期對不上代表是舊的檢討，寧缺勿舊。
  const tradeReviewPath = resolve(process.cwd(), "data/trade-review-latest.json");
  let tradeReview: TradeReview | null = null;
  if (existsSync(tradeReviewPath)) {
    try {
      const parsed: TradeReview = JSON.parse(readFileSync(tradeReviewPath, "utf-8"));
      if (parsed.date === analysis.date) tradeReview = parsed;
      else console.warn(`trade-review 日期 ${parsed.date} 與分析 ${analysis.date} 不符，交易檢討分頁略過`);
    } catch {
      console.warn("trade-review-latest.json 無法解析，略過");
    }
  }

  const html = renderHtml(analysis, stockMap, codeByName, marketBlock, retailHistory, contrib, tdcc, marginHistory, marginOptions, picks, tradeReview);
  const htmlOutPath = resolve(process.cwd(), "data/report-latest.html");
  writeFileSync(htmlOutPath, html, "utf-8");
  console.log(`Wrote HTML preview to ${htmlOutPath}（${(html.length / 1024).toFixed(0)}KB）`);

  updateHistory(analysis);
}

main().catch((err) => {
  console.error("send-report failed:", err);
  process.exit(1);
});
