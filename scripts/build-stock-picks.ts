/**
 * 終極選股池 — 把所有版位的訊號統合成個股層級的兩張榜單。
 *
 * 讀（全部都是其他步驟的現成產出，本身不打任何 API）：
 *  - data/market-latest.json            全市場 stockMap（法人/當沖/期貨級距）+ closeMap + 當日榜單
 *  - data/analysis-latest.json          族群分類與 stage/call 判斷
 *  - data/tw-rrg-alerts.json            族群 RRG 象限 + regime 警告
 *  - data/sector-baskets.json           個股 → RRG 族群的對照
 *  - data/tdcc-divergence-latest.json   集保大戶背離/同向（週資料，含 z-score）
 *  - data/cb-pledge-latest.json         CB＋設質事件觀察池（CB 日頻、設質月頻，含 0-100 分）
 *  - data/revenue-momentum-latest.json  月營收與毛利率資料（長線榜的基本面門檻）
 *  - data/price-history/*.json          每日收盤序列 → MA10/MA20/20日高/動能
 *
 * 寫：data/stock-picks-latest.json ＋ data/stock-picks-history/<date>.json（供日後回測權重）
 *
 * 設計原則：
 *  1. 純規則、零 LLM——每天跑結果可重現，權重之後可以用歷史快照回測調整。
 *  2. 不把同一價格現象重複當成多份證據：個股動能、族群趨勢、法人、基本面分軸計算。
 *  3. 長短分開評：長線先過營運門檻，再看品質與產業確認；短線看價格、法人與催化。
 *     同一檔可以同時適合長期研究與短期交易，兩張榜不互斥。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { significantInstitutionalBuys, STRENGTH_DEFAULTS } from "./institutional-strength.ts";

import { twIso } from "./lib/time";
import { computeStockPickRisk } from "./lib/stock-pick-risk";
import { themesByTicker, type ThemeSignal } from "./lib/theme-radar";
const ROOT = process.cwd();
const j = <T = any>(p: string): T | null => {
  const full = resolve(ROOT, p);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, "utf-8"));
  } catch {
    console.warn(`[warn] ${p} 解析失敗，該資料源略過`);
    return null;
  }
};

// ---------- 載入 ----------

const market = j<any>("data/market-latest.json");
if (!market) {
  console.error("data/market-latest.json 不存在，無法建立選股池");
  process.exit(1);
}
const analysis = j<any>("data/analysis-latest.json");
const rrgAlerts = j<any>("data/tw-rrg-alerts.json");
const baskets = j<any>("data/sector-baskets.json");
const tdcc = j<any>("data/tdcc-divergence-latest.json");
const cb = j<any>("data/cb-pledge-latest.json");
const rev = j<any>("data/revenue-momentum-latest.json");

const tradingDate: string = market.tradingDate;
const themeSnapshot = j<{ date: string; signals: ThemeSignal[]; warnings: string[] }>("data/theme-radar/latest.json");
// 只讀同一交易日的快照；舊資料不能替今天的選股背書。
const themeMap = themeSnapshot?.date === tradingDate
  ? themesByTicker(themeSnapshot.signals) : new Map<string, ThemeSignal[]>();

// 價格序列：每檔 code → 依日期排序的收盤陣列
const phDir = resolve(ROOT, "data/price-history");
const phFiles = existsSync(phDir) ? readdirSync(phDir).filter((f) => f.endsWith(".json")).sort() : [];
const series = new Map<string, number[]>();
for (const f of phFiles) {
  const day = j<Record<string, number>>(`data/price-history/${f}`);
  if (!day) continue;
  for (const [code, close] of Object.entries(day)) {
    if (typeof close !== "number" || !(close > 0)) continue;
    let arr = series.get(code);
    if (!arr) series.set(code, (arr = []));
    arr.push(close);
  }
}

// ---------- 各資料源整理成 code → 訊號 ----------

const names = new Map<string, string>();
const noteName = (code?: string, name?: string) => {
  if (code && name && !names.has(code)) names.set(code, name);
};

// 集保大戶：同一檔可能出現在多個門檻，取 z-score 最高的那筆
type TdccSig = { view: "diverge" | "converge"; score: number; dCum: number; streak: number; cutoff: string; aboveMa20: boolean | null };
const tdccMap = new Map<string, TdccSig>();
for (const view of tdcc?.views ?? []) {
  for (const [cutKey, rows] of Object.entries<any>(view.byCutoff ?? {})) {
    for (const r of rows as any[]) {
      noteName(r.code, r.name);
      const prev = tdccMap.get(r.code);
      // 背離（籌碼先動、價還沒動）賠率較好，同分時優先留背離視角
      const better = !prev || r.score > prev.score || (r.score === prev.score && view.key === "diverge");
      if (better) {
        tdccMap.set(r.code, {
          view: view.key,
          score: r.score,
          dCum: r.dCum,
          streak: r.streak ?? 1,
          cutoff: `${cutKey}張`,
          aboveMa20: r.aboveMa20 ?? null,
        });
      }
    }
  }
}

// CB＋設質只作事件與風險註記；尚無足夠回測，不直接當長線正向來源。
type CbSig = { score: number; flags: string[]; pledgeRatio: number; vsConversionPct: number | null };
const cbMap = new Map<string, CbSig>();
for (const c of cb?.candidates ?? []) {
  noteName(c.code, c.name);
  cbMap.set(c.code, {
    score: c.score ?? 0,
    flags: c.flags ?? [],
    pledgeRatio: c.pledgeRatio ?? 0,
    vsConversionPct: c.vsConversionPct ?? null,
  });
}

/**
 * 月營收篩選。這是六路訊號裡唯一的基本面軸，其他五路全是價量籌碼。
 *
 * 只收有標記的：**核心**（YoY≥20% + 連 3 月 YoY 成長 + 24 月營收新高）或**動能**
 * （YoY≥20% + 連 3 月 MoM 為正）。兩者是平行標記、可以同時中，65 個月回測分不出
 * 高下（配對相減 +0.78pp、t=1.66；保留樣本 t=0.61），所以**給同樣的分**。
 * 舊版收的「觀察」層（只要連 3 月 YoY 成長）已經廢除——它 263 檔裡放行 206 檔，
 * 相對不篩只有 +0.20pp，等於沒篩。細節見 lib/revenue-factors.ts 的 screen() 註解。
 *
 * **刻意沒有分數**——回測顯示門檻內部排名沒有資訊，所以這裡也只依標記給固定分。
 *
 * **陳舊保護**：月營收是月頻資料，離最近一次公布太久就不該再當「新訊號」用——
 * 超過 2 個月直接整份忽略，寧可少一軸也不要拿三個月前的營收替今天的價格背書。
 */
type RevSig = {
  core: boolean;
  momentum: boolean;
  label: string;
  yoy: number;
  ttmYoy: number | null;
  streak: number;
  flags: string[];
  month: string;
  marginQuarter: string | null;
  margin: number | null;
  marginQoq: number | null;
  marginHigh4: boolean | null;
  quiet: boolean;
};
const revMap = new Map<string, RevSig>();
{
  const month: string = rev?.month ?? "";
  const staleMonths = month
    ? (+tradingDate.slice(0, 4) * 12 + +tradingDate.slice(5, 7)) - (+month.slice(0, 4) * 12 + +month.slice(5, 7))
    : 99;
  if (month && staleMonths <= 2) {
    for (const e of rev.entries ?? []) {
      const core = e.tier === "核心";
      const momentum = e.momentum === true;
      if (!core && !momentum) continue;
      noteName(e.code, e.name);
      revMap.set(e.code, {
        core,
        momentum,
        label: core && momentum ? "核心·動能" : core ? "核心" : "動能",
        yoy: e.yoy,
        ttmYoy: typeof e.ttmYoy === "number" ? e.ttmYoy : null,
        streak: e.streak ?? 0,
        flags: e.flags ?? [],
        month,
        marginQuarter: e.marginQuarter ?? null,
        margin: typeof e.margin === "number" ? e.margin : null,
        marginQoq: typeof e.marginQoq === "number" ? e.marginQoq : null,
        marginHigh4: typeof e.marginHigh4 === "boolean" ? e.marginHigh4 : null,
        // 營收達標、但股價還沒反映。**這不是加分項**——回測把門檻內的股票依進場前
        // 一個月漲幅分五桶，最弱那桶之後一個月超額 +1.75pp，最強那桶 +3.65pp，
        // 動能是延續的不是均值回歸。留這個欄位只為了在報告上標示狀態，不進分數。
        quiet: e.price?.aboveMa20 === false || (typeof e.price?.r20 === "number" && e.price.r20 < 0.05),
      });
    }
  } else if (month) {
    console.warn(`[warn] 月營收名單是 ${month}（距今 ${staleMonths} 個月），太舊，本次不採用`);
  }
}

// 個股 → RRG 族群 → 當前象限
const sectorOf = new Map<string, string>();
for (const b of baskets?.baskets ?? []) {
  for (const [code, name] of b.members ?? []) {
    sectorOf.set(code, b.canonical);
    noteName(code, name);
  }
}
const quadrantOf = new Map<string, string>();
for (const [quad, sectors] of Object.entries<any>(rrgAlerts?.quadrants ?? {})) {
  for (const s of sectors as string[]) quadrantOf.set(s, quad);
}
// regime 警告：「大盤全面回檔」出現時，整體要更保守
const regimeNotes: string[] = (rrgAlerts?.regime ?? []).map((r: any) => `${r.kind}：${r.note}`);

// 當日族群分類。新版 finalizer 輸出 entryAction；call 僅供舊快照相容。
type GroupSig = { category: string; stage: string; action: string };
const groupOf = new Map<string, GroupSig>();
for (const g of analysis?.gainers ?? []) {
  for (const s of g.stocks ?? []) {
    const m = /^(.*?)\((\d{4,6}[A-Z]?)\)/.exec(s);
    if (!m) continue;
    noteName(m[2], m[1].replace(/\*$/, ""));
    const action = g.entryAction ?? (
      g.call === "順勢" ? "標準持有" : g.call === "反轉" ? "不碰減碼" : ""
    );
    groupOf.set(m[2], { category: g.category, stage: g.stage ?? "", action });
  }
}
// 弱勢榜的股票直接不碰（今天就在跌的東西，兩張榜單都不該出現）
const inLoserGroup = new Set<string>();
for (const g of analysis?.losers ?? []) {
  for (const s of g.stocks ?? []) {
    const m = /\((\d{4,6}[A-Z]?)\)/.exec(s);
    if (m) inLoserGroup.add(m[1]);
  }
}

// 當日漲跌前後 100 名只用來補名稱；風險旗標與漲跌幅一律讀完整 stockMap。
const todayMove = new Map<string, { pct: number }>();
for (const e of [...(market.gainers ?? []), ...(market.losers ?? [])]) {
  noteName(e.code, e.name);
  todayMove.set(e.code, { pct: e.pct ?? 0 });
}

// ---------- 每檔股票的原始特徵 ----------

interface Feat {
  code: string;
  name: string;
  close: number;
  chips: any | null;
  flags: { attention?: boolean; disposition?: boolean; lowLiquidity?: boolean };
  dayTrade: number | null;
  futures: { level: string; margin: string } | null;
  tdcc: TdccSig | null;
  cb: CbSig | null;
  rev: RevSig | null;
  sector: string | null;
  quadrant: string | null;
  group: GroupSig | null;
  r10: number | null; // 近 10 交易日報酬（約兩週）
  r20: number | null; // 近 20 交易日（約一個月）
  rAll: number | null; // 價史全長（目前約一個半月，之後會自然長到三個月）
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  high20: number | null;
  aboveMa20: boolean | null;
  distHigh: number | null; // 收盤距 20 日高，負值 = 還在下面
  pctToday: number;
}

// 候選宇宙：任一結構性訊號源出現過的股票 ＋ 當日強勢榜
const universe = new Set<string>([...tdccMap.keys(), ...cbMap.keys(), ...groupOf.keys(), ...revMap.keys()]);
for (const e of market.gainers ?? []) universe.add(e.code);

const closeMap: Record<string, number> = market.closeMap ?? {};
const stockMap: Record<string, any> = market.stockMap ?? {};

// 顯著買超也能成為候選入口，涵蓋尚未進漲幅前 100 的股票。
for (const [code, meta] of Object.entries(stockMap)) {
  if (significantInstitutionalBuys(meta.chips?.strength).length) {
    universe.add(code);
    noteName(code, meta.name);
  }
}

const feats: Feat[] = [];
for (const code of universe) {
  const close = closeMap[code];
  if (!(close > 8)) continue; // 低價股跳過，跟 TDCC 篩選一致
  const meta = stockMap[code] ?? {};
  const arr = series.get(code) ?? [];
  const last = arr.length ? arr[arr.length - 1] : close;
  const ret = (k: number) => (arr.length > k ? last / arr[arr.length - 1 - k] - 1 : null);
  const maN = (n: number) => (arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const win20 = arr.slice(-20);
  const high20 = win20.length >= 10 ? Math.max(...win20) : null;
  const ma20 = maN(20);
  feats.push({
    code,
    name: names.get(code) ?? code,
    close,
    chips: meta.chips ?? null,
    flags: meta.flags ?? {},
    dayTrade: meta.dayTradeRatio ?? null,
    futures: meta.futures ?? null,
    tdcc: tdccMap.get(code) ?? null,
    cb: cbMap.get(code) ?? null,
    rev: revMap.get(code) ?? null,
    sector: sectorOf.get(code) ?? null,
    quadrant: sectorOf.get(code) ? quadrantOf.get(sectorOf.get(code)!) ?? null : null,
    group: groupOf.get(code) ?? null,
    r10: ret(10),
    r20: ret(20),
    rAll: arr.length >= 15 ? last / arr[0] - 1 : null,
    ma10: maN(10),
    ma20,
    ma60: maN(60),
    high20,
    aboveMa20: ma20 !== null ? close > ma20 : null,
    distHigh: high20 !== null ? close / high20 - 1 : null,
    pctToday: Number.parseFloat(meta.pct) || todayMove.get(code)?.pct || 0,
  });
}

// 相對強度用百分位而不是絕對報酬：大盤齊漲時 +10% 可能只是中位數
const pctRank = (vals: (number | null)[], v: number | null): number | null => {
  if (v === null) return null;
  const xs = vals.filter((x): x is number => x !== null);
  if (xs.length < 10) return null;
  return xs.filter((x) => x <= v).length / xs.length;
};
const allR10 = feats.map((f) => f.r10);
const allR20 = feats.map((f) => f.r20);

// ---------- 評分 ----------

interface Signal { label: string; detail: string; tone: "pos" | "neg" }
interface Scored {
  feat: Feat;
  score: number;
  signals: Signal[];
  sources: number; // 幾個獨立資料源給了正訊號（共振門檻用）
}

const fmtPct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const px = (v: number | null) => (v === null ? "—" : v >= 500 ? v.toFixed(0) : v >= 50 ? v.toFixed(1) : v.toFixed(2));

/** 兩張榜單共用的風險扣分：投機假象與流動性問題，長短線都致命 */
function riskDeduct(f: Feat, sig: Signal[]): number {
  const risk = computeStockPickRisk({
    dayTrade: f.dayTrade,
    pctToday: f.pctToday,
    flags: f.flags,
    pledgeRatio: f.cb?.pledgeRatio,
  });
  sig.push(...risk.signals);
  return risk.deduction;
}

/** 長線（3 個月～1 年）：營運改善是門票，品質、產業與法人只負責確認。 */
function scoreLong(f: Feat): Scored {
  const sig: Signal[] = [];
  let s = 0;
  let src = 0;

  if (f.tdcc) {
    const t = f.tdcc;
    // 現有 46 週回測找不到穩健預測力，因此只作小幅佐證，也不計入「獨立來源」門檻。
    s += t.view === "diverge" ? Math.min(6, Math.max(2, t.score)) : 2;
    sig.push({
      label: t.view === "diverge" ? "集保背離觀察" : "集保同向觀察",
      detail: `${t.cutoff}大戶週增 ${fmtPct(t.dCum / 100)}（z=${t.score.toFixed(1)}${t.streak >= 2 ? `、連${t.streak}週` : ""}）${t.view === "diverge" ? "，價格還沒反映" : ""}`,
      tone: "pos",
    });
  }
  if (f.rev) {
    const r = f.rev;
    s += r.core && r.momentum ? 26 : 22;
    if (r.ttmYoy !== null) s += r.ttmYoy >= 0.1 ? 6 : r.ttmYoy > 0 ? 3 : -4;
    if (r.marginQoq !== null) s += r.marginQoq >= 0 ? 5 : -6;
    if (r.marginHigh4) s += 4;
    src++;
    const quality = [
      r.ttmYoy === null ? null : `TTM營收 ${fmtPct(r.ttmYoy)}`,
      r.marginQoq === null ? null : `毛利率季變動 ${(r.marginQoq * 100).toFixed(1)}pp`,
    ].filter(Boolean).join("、");
    sig.push({
      label: `營運${r.label}`,
      detail: `${r.month} ${r.flags.join("、")}${quality ? `；${quality}` : ""}${r.quiet ? "（價格尚未確認）" : ""}`,
      tone: "pos",
    });
  }

  let sectorPts = 0;
  let sectorDetail = "";
  if (f.quadrant === "領先" || f.quadrant === "改善") {
    sectorPts = f.quadrant === "領先" ? 8 : 6;
    sectorDetail = `族群「${f.sector}」在${f.quadrant}象限`;
  } else if (f.quadrant === "弱化") {
    s -= 5;
    sig.push({ label: "RRG 弱化", detail: `族群「${f.sector}」中期相對動能轉弱`, tone: "neg" });
  }
  if (f.group?.action === "核心加碼" || f.group?.action === "標準持有") {
    const pts = f.group.action === "核心加碼" ? 9 : 7;
    if (pts > sectorPts) {
      sectorPts = pts;
      sectorDetail = `「${f.group.category}」${f.group.stage || "當日"}，報告判斷${f.group.action}`;
    }
  } else if (f.group?.action === "不碰減碼") {
    s -= 10;
    sig.push({ label: "族群降級", detail: `「${f.group.category}」判斷不碰減碼`, tone: "neg" });
  }
  if (sectorPts > 0) {
    s += sectorPts;
    src++;
    sig.push({ label: "產業趨勢確認", detail: sectorDetail, tone: "pos" });
  }
  const c = f.chips;
  if (c) {
    const fStreak = c.foreignBuyStreak ?? 0;
    const buys = significantInstitutionalBuys(c.strength);
    if (fStreak >= 3) {
      s += fStreak >= 5 ? 8 : 5;
      sig.push({ label: "外資連買", detail: `外資連 ${fStreak} 日買超`, tone: "pos" });
    }
    if (buys.length) {
      s += 8;
      for (const buy of buys) sig.push({ ...buy, tone: "pos" });
    }
    // 連買與力度來自同一份法人資料，只計一個共振來源。
    if (fStreak >= 3 || buys.length) src++;
    if (c.strength?.foreign.significantBuy && c.strength?.trust.significantBuy) s += 4;
  }
  if (f.aboveMa20) s += 4;
  if (f.r20 !== null && f.r20 > -0.05 && f.r20 < 0.25) s += 6; // 沒噴出，長線還有位置
  if (f.r20 !== null && f.r20 > 0.4) {
    s -= 8;
    sig.push({ label: "漲幅已大", detail: `近一月已漲 ${fmtPct(f.r20)}，長線進場點不佳`, tone: "neg" });
  }
  s += riskDeduct(f, sig);
  return { feat: f, score: s, signals: sig, sources: src };
}

/** 波段（2 週～3 個月）：價格確認、法人、產業與營運催化分軸評分。 */
function scoreShort(f: Feat): Scored {
  const sig: Signal[] = [];
  let s = 0;
  let src = 0;

  const p10 = pctRank(allR10, f.r10);
  const p20 = pctRank(allR20, f.r20);
  if (p10 !== null) s += p10 * 22;
  if (p20 !== null) s += p20 * 14;
  if (p10 !== null && p10 >= 0.7) {
    src++;
    sig.push({ label: "動能強", detail: `兩週 ${fmtPct(f.r10)}、一月 ${fmtPct(f.r20)}（相對強度前 ${(100 - p10 * 100).toFixed(0)}%）`, tone: "pos" });
  }
  const c = f.chips;
  if (c) {
    const buys = significantInstitutionalBuys(c.strength);
    let instPts = buys.length ? (c.strength.foreign.significantBuy || c.strength.trust.significantBuy ? 12 : 8) : 0;
    if (c.strength?.foreign.significantBuy && c.strength?.trust.significantBuy) instPts += 4;
    const fStreak = c.foreignBuyStreak ?? 0;
    if (fStreak >= 3) {
      instPts += fStreak >= 5 ? 10 : 6;
      sig.push({ label: "外資連買", detail: `外資連 ${fStreak} 日買超`, tone: "pos" });
    }
    for (const buy of buys) sig.push({ ...buy, tone: "pos" });
    if (buys.length || fStreak >= 3) src++;
    s += instPts;
  }
  let sectorPts = 0;
  let sectorDetail = "";
  if (f.group?.action === "核心加碼" || f.group?.action === "標準持有") {
    sectorPts = f.group.stage === "啟動" ? 14 : f.group.stage === "擴散" ? 10 : 7;
    sectorDetail = `「${f.group.category}」${f.group.stage || "當日"}、${f.group.action}`;
  } else if (f.group?.action === "觀察不追") {
    sectorPts = 3;
  } else if (f.group?.action === "不碰減碼") {
    s -= 12;
    sig.push({ label: "族群降級", detail: `「${f.group.category}」判斷不碰減碼`, tone: "neg" });
  }
  if (f.quadrant === "領先" || f.quadrant === "改善") {
    const pts = f.quadrant === "領先" ? 8 : 6;
    if (pts > sectorPts) {
      sectorPts = pts;
      sectorDetail = `族群「${f.sector}」${f.quadrant}象限`;
    }
  }
  if (sectorPts >= 6) {
    s += sectorPts;
    src++;
    sig.push({ label: "族群趨勢", detail: sectorDetail, tone: "pos" });
  } else {
    s += sectorPts;
  }
  if (f.tdcc) {
    s += f.tdcc.view === "converge" ? 3 : 1;
    sig.push({ label: "集保觀察", detail: `${f.tdcc.cutoff}大戶週增 ${fmtPct(f.tdcc.dCum / 100)}，僅作佐證`, tone: "pos" });
  }
  // 短線認核心或動能：月頻資料本來就不是短線訊號，有價值的是營收公布後的漂移
  // （post-announcement drift），所以權重壓在長線的一半。
  if (f.rev) {
    s += 10;
    src++;
    sig.push({ label: `營收${f.rev.label}`, detail: `${f.rev.month} ${f.rev.flags.join("、")}`, tone: "pos" });
  }
  if (f.aboveMa20) s += 4;
  if (f.ma10 !== null && f.ma20 !== null && f.ma10 > f.ma20) s += 3;
  if (f.distHigh !== null && f.distHigh >= -0.03) s += 4; // 貼著 20 日高＝沒套牢賣壓
  s += riskDeduct(f, sig);
  return { feat: f, score: s, signals: sig, sources: src };
}

// ---------- 選股 ----------

const eligible = feats.filter((f) => !inLoserGroup.has(f.code));
// 長線必須有基本面門票；集保與 CB 不計入兩個獨立確認來源。
const longAll = eligible.map(scoreLong).filter((x) => x.feat.rev && x.sources >= 2 && x.score > 0).sort((a, b) => b.score - a.score);
const shortAll = eligible.map(scoreShort).filter((x) => x.sources >= 2 && x.score > 0).sort((a, b) => b.score - a.score);
const longPicks = longAll.slice(0, 10);
const shortPicks = shortAll.slice(0, 10);

// ---------- 進出場建議 ----------

interface PickOut {
  rank: number;
  code: string;
  name: string;
  close: number;
  score: number;
  type: string;
  sector: string | null;
  /** 有個股期貨才有值；margin 是保證金級距，與漲跌 100 名單同一來源 */
  futures: { level: string; margin: string } | null;
  reason: string;
  signals: Signal[];
  /** 題材新聞觀察欄位；尚未驗證增益，不參與分數或候選資格。 */
  themeRadar: Array<{ id: string; name: string; ratio: number; z: number; recentMentions: number }>;
  plan: { entry: string; stop: string; exit: string };
  metrics: {
    r10: string; r20: string; ma10: string; ma20: string; ma60: string; high20: string;
    dayTrade: string; instNet: string; quadrant: string; tdcc: string; cb: string; revenue: string;
  };
}

function toPick(x: Scored, rank: number, horizon: "long" | "short"): PickOut {
  const f = x.feat;
  const isQuiet = (f.distHigh ?? 0) < -0.05 || f.rev?.quiet === true;
  const type = horizon === "long"
    ? isQuiet ? "營運先行·等待確認" : "營運成長·趨勢確認"
    : isQuiet ? "回檔觀察" : "動能順勢";
  const entry = horizon === "long"
    ? `分批布局：MA20（${px(f.ma20)}）附近先建 1/3，站穩 20 日高 ${px(f.high20)} 且營運趨勢未轉弱再加碼`
    : isQuiet
      ? `等站回 MA20（${px(f.ma20)}）且量價轉強再進，不預判落底`
      : `不追今日價：回測 MA10（${px(f.ma10)}）不破，或整理 3-5 日後過 ${px(f.high20)} 再進`;
  const stop = horizon === "long"
    ? `技術風控：跌破 MA60（${px(f.ma60)}）且兩日無法站回先減碼；建倉均價 -12% 仍須退出重評`
    : `收盤跌破 MA20（${px(f.ma20)}）或進場價 -8%，先到先出`;
  const exit = horizon === "long"
    ? "基本面論點失效才清倉：TTM營收轉負、毛利率連兩季惡化、產業需求或競爭假設被證偽；單週籌碼與單月門檻只作預警"
    : "MA10 移動停利；族群降級、法人連 3 日賣超，或預定催化未兌現即出";

  const pos = x.signals.filter((s) => s.tone === "pos");
  const neg = x.signals.filter((s) => s.tone === "neg");
  const reason =
    pos.map((s) => s.detail).join("；") + (neg.length ? `。注意：${neg.map((s) => s.label).join("、")}` : "");

  const c = f.chips;
  return {
    rank,
    code: f.code,
    name: f.name,
    close: f.close,
    score: Math.round(x.score),
    type,
    sector: f.sector,
    futures: f.futures,
    reason,
    signals: x.signals,
    themeRadar: (themeMap.get(f.code) ?? []).map((signal) => ({
      id: signal.id, name: signal.name, ratio: +signal.ratio.toFixed(2),
      z: +signal.z.toFixed(2), recentMentions: signal.recentMentions,
    })),
    plan: { entry, stop, exit },
    metrics: {
      r10: fmtPct(f.r10),
      r20: fmtPct(f.r20),
      ma10: px(f.ma10),
      ma20: px(f.ma20),
      ma60: px(f.ma60),
      high20: px(f.high20),
      dayTrade: f.dayTrade === null ? "—" : `${f.dayTrade.toFixed(0)}%`,
      instNet: c ? `${c.totalNet > 0 ? "+" : ""}${c.totalNet} 張（外資 ${c.foreignNet > 0 ? "+" : ""}${c.foreignNet}／投信 ${c.trustNet > 0 ? "+" : ""}${c.trustNet}）` : "—",
      quadrant: f.quadrant ? `${f.sector}（${f.quadrant}）` : "—",
      tdcc: f.tdcc ? `${f.tdcc.view === "diverge" ? "背離" : "同向"} ${f.tdcc.cutoff} 週增 ${fmtPct(f.tdcc.dCum / 100)} z=${f.tdcc.score.toFixed(1)}` : "—",
      cb: f.cb ? `事件觀察 ${f.cb.score} 分（設質 ${f.cb.pledgeRatio.toFixed(0)}%，不列正向因子）` : "—",
      revenue: f.rev
        ? `${f.rev.month} ${f.rev.label}：${f.rev.flags.join("、")}；TTM ${fmtPct(f.rev.ttmYoy)}；毛利率季變動 ${f.rev.marginQoq === null ? "—" : `${(f.rev.marginQoq * 100).toFixed(1)}pp`}`
        : "—",
    },
  };
}

const out = {
  generatedAt: twIso(),
  date: tradingDate,
  basis: {
    market: market.tradingDate,
    analysis: analysis?.date ?? null,
    tdccWeek: tdcc?.curWeek ?? null,
    cbWeek: cb?.isoWeek ?? null,
    cbAsOf: cb?.boardDate ?? cb?.generatedAt?.slice(0, 10) ?? null,
    revenueMonth: revMap.size ? rev?.month ?? null : null,
    themeRadarAsOf: themeSnapshot?.date === tradingDate ? tradingDate : null,
    rrgAsOf: rrgAlerts?.asOf ?? null,
    priceHistoryDays: phFiles.length,
    institutionalStrength: { normalization: "daily-market-net-zscore", ...STRENGTH_DEFAULTS },
  },
  regimeNotes,
  themeRadar: themeSnapshot?.date === tradingDate ? {
    signals: themeSnapshot.signals.filter((signal) => signal.accelerating),
    warnings: themeSnapshot.warnings,
  } : null,
  long: longPicks.map((x, i) => toPick(x, i + 1, "long")),
  short: shortPicks.map((x, i) => toPick(x, i + 1, "short")),
};

writeFileSync(resolve(ROOT, "data/stock-picks-latest.json"), JSON.stringify(out, null, 2), "utf-8");
const histDir = resolve(ROOT, "data/stock-picks-history");
mkdirSync(histDir, { recursive: true });
writeFileSync(resolve(histDir, `${tradingDate}.json`), JSON.stringify(out, null, 2), "utf-8");

console.log(
  `終極選股池：候選 ${eligible.length} 檔（大戶 ${tdccMap.size}、CB ${cbMap.size}、族群 ${groupOf.size}、營收 ${revMap.size}）→ 長線 ${out.long.length} 檔、短線 ${out.short.length} 檔`,
);
console.log(`長線：${out.long.map((p) => `${p.name}(${p.code})${p.score}`).join("、")}`);
console.log(`短線：${out.short.map((p) => `${p.name}(${p.code})${p.score}`).join("、")}`);
