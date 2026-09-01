/**
 * 終極選股池 — 把所有版位的訊號統合成個股層級的兩張榜單。
 *
 * 讀（全部都是其他步驟的現成產出，本身不打任何 API）：
 *  - data/market-latest.json            全市場 stockMap（法人/當沖/期貨級距）+ closeMap + 當日榜單
 *  - data/analysis-latest.json          族群分類與 stage/call 判斷
 *  - data/tw-rrg-alerts.json            族群 RRG 象限 + regime 警告
 *  - data/sector-baskets.json           個股 → RRG 族群的對照
 *  - data/tdcc-divergence-latest.json   集保大戶背離/同向（週資料，含 z-score）
 *  - data/cb-pledge-latest.json         設質+CB 公司派作價候選池（週資料，含 0-100 分）
 *  - data/price-history/*.json          每日收盤序列 → MA10/MA20/20日高/動能
 *
 * 寫：data/stock-picks-latest.json ＋ data/stock-picks-history/<date>.json（供日後回測權重）
 *
 * 設計原則：
 *  1. 純規則、零 LLM——每天跑結果可重現，權重之後可以用歷史快照回測調整。
 *  2. 「共振」比單一高分重要：進榜必須至少兩個獨立資料源同時給正訊號，
 *     單軸暴衝（只有法人買、但大戶在倒/族群在弱化）擋在門外。
 *  3. 長短分開評：長線吃結構性籌碼（大戶累積、公司派作價、中期輪動），
 *     短線吃資金動能（相對強度、法人連買、族群擴散）。同一檔兩邊都上時只留分數高的那邊。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

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

const tradingDate: string = market.tradingDate;

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

// 設質+CB 公司派作價
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

// 當日族群分類（strong 榜）
type GroupSig = { category: string; stage: string; call: string };
const groupOf = new Map<string, GroupSig>();
for (const g of analysis?.gainers ?? []) {
  for (const s of g.stocks ?? []) {
    const m = /^(.*?)\((\d{4,6}[A-Z]?)\)/.exec(s);
    if (!m) continue;
    noteName(m[2], m[1].replace(/\*$/, ""));
    groupOf.set(m[2], { category: g.category, stage: g.stage ?? "", call: g.call ?? "" });
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

// 當日榜單（漲停/流動性 flag 只在這裡有）
const todayMove = new Map<string, { pct: number; lowLiquidity: boolean }>();
for (const e of [...(market.gainers ?? []), ...(market.losers ?? [])]) {
  noteName(e.code, e.name);
  todayMove.set(e.code, { pct: e.pct ?? 0, lowLiquidity: !!e.flags?.lowLiquidity });
}

// ---------- 每檔股票的原始特徵 ----------

interface Feat {
  code: string;
  name: string;
  close: number;
  chips: any | null;
  dayTrade: number | null;
  futures: { level: string; margin: string } | null;
  tdcc: TdccSig | null;
  cb: CbSig | null;
  sector: string | null;
  quadrant: string | null;
  group: GroupSig | null;
  r10: number | null; // 近 10 交易日報酬（約兩週）
  r20: number | null; // 近 20 交易日（約一個月）
  rAll: number | null; // 價史全長（目前約一個半月，之後會自然長到三個月）
  ma10: number | null;
  ma20: number | null;
  high20: number | null;
  aboveMa20: boolean | null;
  distHigh: number | null; // 收盤距 20 日高，負值 = 還在下面
  pctToday: number;
}

// 候選宇宙：任一結構性訊號源出現過的股票 ＋ 當日強勢榜
const universe = new Set<string>([...tdccMap.keys(), ...cbMap.keys(), ...groupOf.keys()]);
for (const e of market.gainers ?? []) universe.add(e.code);

const closeMap: Record<string, number> = market.closeMap ?? {};
const stockMap: Record<string, any> = market.stockMap ?? {};

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
    dayTrade: meta.dayTradeRatio ?? null,
    futures: meta.futures ?? null,
    tdcc: tdccMap.get(code) ?? null,
    cb: cbMap.get(code) ?? null,
    sector: sectorOf.get(code) ?? null,
    quadrant: sectorOf.get(code) ? quadrantOf.get(sectorOf.get(code)!) ?? null : null,
    group: groupOf.get(code) ?? null,
    r10: ret(10),
    r20: ret(20),
    rAll: arr.length >= 15 ? last / arr[0] - 1 : null,
    ma10: maN(10),
    ma20,
    high20,
    aboveMa20: ma20 !== null ? close > ma20 : null,
    distHigh: high20 !== null ? close / high20 - 1 : null,
    pctToday: todayMove.get(code)?.pct ?? 0,
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
  let d = 0;
  if (f.dayTrade !== null && f.dayTrade > 45) {
    d -= 14;
    sig.push({ label: "當沖過熱", detail: `當沖比 ${f.dayTrade.toFixed(0)}%，隔日沖主場`, tone: "neg" });
  } else if (f.dayTrade !== null && f.dayTrade > 35) {
    d -= 7;
    sig.push({ label: "當沖偏高", detail: `當沖比 ${f.dayTrade.toFixed(0)}%`, tone: "neg" });
  }
  if (todayMove.get(f.code)?.lowLiquidity) {
    d -= 10;
    sig.push({ label: "流動性低", detail: "日成交金額偏低，進出滑價大", tone: "neg" });
  }
  if (f.pctToday >= 9.5) {
    d -= 4;
    sig.push({ label: "今日漲停", detail: "追高風險，等回測再說", tone: "neg" });
  }
  return d;
}

/** 長線（3 個月～1 年）：結構性籌碼優先——大戶累積、公司派作價、中期輪動方向 */
function scoreLong(f: Feat): Scored {
  const sig: Signal[] = [];
  let s = 0;
  let src = 0;

  if (f.tdcc) {
    const t = f.tdcc;
    const base = t.view === "diverge" ? Math.min(28, 10 + t.score * 2) : Math.min(14, 5 + t.score);
    s += base + (t.streak >= 2 ? 4 : 0);
    src++;
    sig.push({
      label: t.view === "diverge" ? "大戶背離" : "大戶同向",
      detail: `${t.cutoff}大戶週增 ${fmtPct(t.dCum / 100)}（z=${t.score.toFixed(1)}${t.streak >= 2 ? `、連${t.streak}週` : ""}）${t.view === "diverge" ? "，價格還沒反映" : ""}`,
      tone: "pos",
    });
  }
  if (f.cb && f.cb.score >= 60) {
    s += (f.cb.score - 60) * 0.5; // 最多 +20
    src++;
    sig.push({
      label: "CB+設質",
      detail: `公司派作價分 ${f.cb.score}（設質 ${f.cb.pledgeRatio.toFixed(0)}%${f.cb.flags.length ? `、${f.cb.flags.join("、")}` : ""}）`,
      tone: "pos",
    });
  }
  if (f.quadrant === "領先" || f.quadrant === "改善") {
    s += f.quadrant === "領先" ? 10 : 8;
    src++;
    sig.push({ label: `RRG ${f.quadrant}`, detail: `族群「${f.sector}」在${f.quadrant}象限，中期資金流入`, tone: "pos" });
  } else if (f.quadrant === "弱化") {
    s -= 4;
    sig.push({ label: "RRG 弱化", detail: `族群「${f.sector}」動能轉弱`, tone: "neg" });
  }
  if (f.group) {
    if (f.group.call === "順勢") {
      s += 6;
      src++;
      sig.push({ label: "族群順勢", detail: `「${f.group.category}」${f.group.stage}，操盤判斷順勢`, tone: "pos" });
    } else if (f.group.call === "反轉") {
      s -= 8;
      sig.push({ label: "族群過熱", detail: `「${f.group.category}」被判反轉/過熱`, tone: "neg" });
    }
  }
  const c = f.chips;
  if (c) {
    const fStreak = c.foreignBuyStreak ?? 0;
    if (fStreak >= 3) {
      s += fStreak >= 5 ? 8 : 5;
      src++;
      sig.push({ label: "外資連買", detail: `外資連 ${fStreak} 日買超`, tone: "pos" });
    }
    if (c.foreignNet > 0 && c.trustNet > 0) {
      s += 4;
      sig.push({ label: "外投同買", detail: `外資 +${c.foreignNet} 張、投信 +${c.trustNet} 張`, tone: "pos" });
    }
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

/** 短線（2 週～1 個月）：資金正在青睞誰——相對強度、法人連買、族群擴散 */
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
    let instPts = 0;
    if (c.totalNet > 0) instPts += 6;
    if (c.foreignNet > 0 && c.trustNet > 0) instPts += 6;
    const fStreak = c.foreignBuyStreak ?? 0;
    if (fStreak >= 3) instPts += fStreak >= 5 ? 10 : 6;
    if (instPts >= 10) {
      src++;
      sig.push({
        label: "法人進駐",
        detail: `法人合計 ${c.totalNet > 0 ? "+" : ""}${c.totalNet} 張${fStreak >= 3 ? `、外資連 ${fStreak} 買` : ""}${c.foreignNet > 0 && c.trustNet > 0 ? "、外投同向" : ""}`,
        tone: "pos",
      });
    }
    s += instPts;
  }
  if (f.group) {
    const days = Number(/連(\d+)日/.exec(f.group.stage)?.[1] ?? 0);
    if (f.group.call === "順勢") {
      s += 10 + (days <= 2 ? 6 : 0) - (days >= 7 ? 6 : 0);
      src++;
      sig.push({ label: "族群啟動", detail: `「${f.group.category}」${f.group.stage}、判斷順勢${days <= 2 ? "，剛啟動" : ""}`, tone: "pos" });
    } else if (f.group.call === "觀察") {
      s += 4;
    } else if (f.group.call === "反轉") {
      s -= 12;
      sig.push({ label: "族群過熱", detail: `「${f.group.category}」被判反轉，短線是減碼點不是進場點`, tone: "neg" });
    }
  }
  if (f.quadrant === "領先" || f.quadrant === "改善") {
    s += f.quadrant === "領先" ? 8 : 6;
    src++;
    sig.push({ label: `RRG ${f.quadrant}`, detail: `族群「${f.sector}」${f.quadrant}象限`, tone: "pos" });
  }
  if (f.tdcc) {
    s += f.tdcc.view === "converge" ? 6 : 3;
    src++;
    sig.push({ label: f.tdcc.view === "converge" ? "大戶同向" : "大戶背離", detail: `${f.tdcc.cutoff}大戶週增 ${fmtPct(f.tdcc.dCum / 100)}`, tone: "pos" });
  }
  if (f.aboveMa20) s += 4;
  if (f.ma10 !== null && f.ma20 !== null && f.ma10 > f.ma20) s += 3;
  if (f.distHigh !== null && f.distHigh >= -0.03) s += 4; // 貼著 20 日高＝沒套牢賣壓
  s += riskDeduct(f, sig);
  return { feat: f, score: s, signals: sig, sources: src };
}

// ---------- 選股與去重 ----------

const eligible = feats.filter((f) => !inLoserGroup.has(f.code));
const longAll = eligible.map(scoreLong).filter((x) => x.sources >= 2 && x.score > 0).sort((a, b) => b.score - a.score);
const shortAll = eligible.map(scoreShort).filter((x) => x.sources >= 2 && x.score > 0).sort((a, b) => b.score - a.score);

// 同一檔兩邊都進前段時，留在分數較高的那張榜（分數同尺度 0~100 上下），確保 20 檔不重複
const pickTop = (): { long: Scored[]; short: Scored[] } => {
  const long: Scored[] = [];
  const short: Scored[] = [];
  const taken = new Set<string>();
  const lq = [...longAll];
  const sq = [...shortAll];
  const sScore = new Map(shortAll.map((x) => [x.feat.code, x.score]));
  const lScore = new Map(longAll.map((x) => [x.feat.code, x.score]));
  while (long.length < 10 && lq.length) {
    const x = lq.shift()!;
    if (taken.has(x.feat.code)) continue;
    if ((sScore.get(x.feat.code) ?? -1) > x.score && short.length < 10) continue; // 讓給短線榜
    taken.add(x.feat.code);
    long.push(x);
  }
  while (short.length < 10 && sq.length) {
    const x = sq.shift()!;
    if (taken.has(x.feat.code)) continue;
    if ((lScore.get(x.feat.code) ?? -1) > x.score && !taken.has(x.feat.code) && longAll.findIndex((y) => y.feat.code === x.feat.code) < 10) {
      // 長線分較高且長線榜還有位置的讓回去；否則收進短線
      if (long.length < 10) continue;
    }
    taken.add(x.feat.code);
    short.push(x);
  }
  // 長線榜因禮讓而缺額時回填
  for (const x of longAll) {
    if (long.length >= 10) break;
    if (!taken.has(x.feat.code)) {
      taken.add(x.feat.code);
      long.push(x);
    }
  }
  return { long, short };
};
const { long: longPicks, short: shortPicks } = pickTop();

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
  plan: { entry: string; stop: string; exit: string };
  metrics: {
    r10: string; r20: string; ma10: string; ma20: string; high20: string;
    dayTrade: string; instNet: string; quadrant: string; tdcc: string; cb: string;
  };
}

function toPick(x: Scored, rank: number, horizon: "long" | "short"): PickOut {
  const f = x.feat;
  // 背離佈局＝籌碼先行、價格還沒發動（要等）；動能順勢＝已在走、順著做（別追）
  const isDiverge =
    (f.tdcc?.view === "diverge" || (f.cb && (f.r10 ?? 0) < 0.05)) && (f.distHigh ?? 0) < -0.05;
  const type = isDiverge ? "背離佈局" : "動能順勢";
  const entry = isDiverge
    ? `MA20（${px(f.ma20)}）附近分批建 1/2 倉，帶量突破 20 日高 ${px(f.high20)} 補足`
    : `不追今日價：回測 MA10（${px(f.ma10)}）不破進場，或整理 3-5 日後過 ${px(f.high20)} 再進`;
  const stop = `收盤跌破 MA20（${px(f.ma20)}）或進場價 -8%，先到先出`;
  const exit =
    horizon === "long"
      ? `論點失效就出：${f.tdcc ? "下週 TDCC 大戶轉減、" : ""}${f.cb ? "跌回轉換價下方、" : ""}族群 RRG 滑入弱化即清倉；否則沿 MA20 持有波段`
      : `MA10 移動停利；族群轉「反轉/高潮」（當沖飆高＋法人轉賣）或法人連 3 日賣超即出`;

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
    plan: { entry, stop, exit },
    metrics: {
      r10: fmtPct(f.r10),
      r20: fmtPct(f.r20),
      ma10: px(f.ma10),
      ma20: px(f.ma20),
      high20: px(f.high20),
      dayTrade: f.dayTrade === null ? "—" : `${f.dayTrade.toFixed(0)}%`,
      instNet: c ? `${c.totalNet > 0 ? "+" : ""}${c.totalNet} 張（外資 ${c.foreignNet > 0 ? "+" : ""}${c.foreignNet}／投信 ${c.trustNet > 0 ? "+" : ""}${c.trustNet}）` : "—",
      quadrant: f.quadrant ? `${f.sector}（${f.quadrant}）` : "—",
      tdcc: f.tdcc ? `${f.tdcc.view === "diverge" ? "背離" : "同向"} ${f.tdcc.cutoff} 週增 ${fmtPct(f.tdcc.dCum / 100)} z=${f.tdcc.score.toFixed(1)}` : "—",
      cb: f.cb ? `${f.cb.score} 分（設質 ${f.cb.pledgeRatio.toFixed(0)}%）` : "—",
    },
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  date: tradingDate,
  basis: {
    market: market.tradingDate,
    analysis: analysis?.date ?? null,
    tdccWeek: tdcc?.curWeek ?? null,
    cbWeek: cb?.isoWeek ?? null,
    rrgAsOf: rrgAlerts?.asOf ?? null,
    priceHistoryDays: phFiles.length,
  },
  regimeNotes,
  long: longPicks.map((x, i) => toPick(x, i + 1, "long")),
  short: shortPicks.map((x, i) => toPick(x, i + 1, "short")),
};

writeFileSync(resolve(ROOT, "data/stock-picks-latest.json"), JSON.stringify(out, null, 2), "utf-8");
const histDir = resolve(ROOT, "data/stock-picks-history");
mkdirSync(histDir, { recursive: true });
writeFileSync(resolve(histDir, `${tradingDate}.json`), JSON.stringify(out, null, 2), "utf-8");

console.log(
  `終極選股池：候選 ${eligible.length} 檔（大戶 ${tdccMap.size}、CB ${cbMap.size}、族群 ${groupOf.size}）→ 長線 ${out.long.length} 檔、短線 ${out.short.length} 檔`,
);
console.log(`長線：${out.long.map((p) => `${p.name}(${p.code})${p.score}`).join("、")}`);
console.log(`短線：${out.short.map((p) => `${p.name}(${p.code})${p.score}`).join("、")}`);
