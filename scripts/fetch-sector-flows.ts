import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 美股板塊資金流向快照（SPDR 類股 ETF + 半導體）。
 *
 * 產出 data/sector-flows-latest.json，餵給報告「🌐 國際情勢」的板塊熱圖：
 * 一眼看出昨晚資金往哪個板塊跑、哪個板塊在被倒貨，補上「指數漲跌看不出來的輪動」。
 *
 * ── 兩種讀數，刻意分開 ──────────────────────────────────────
 * 1. **淨流量（flow）**：ETF 的「淨申購／贖回」，也就是真的有錢進出，不是價格漲跌。
 *    算法：流通在外股數變化 × 每股淨值。股數增加＝造市商向基金申購新單位＝有新資金進場。
 *    公開資料裡沒有現成的歷史流量，所以**我們自己每天記一筆股數快照**
 *    （data/sector-flows-history.json），跨日相減才算得出來。
 *    → 第一次跑沒有任何流量數字；累積 5 個交易日後有「當週」，20 個交易日後有「過去 4 週」。
 * 2. **價格與熱度（rsi / ret1w / ret4w）**：純從日 K 算，第一天就有，不依賴歷史檔。
 *
 * 為什麼不直接抓某個網站的「fund flows」欄位：那類頁面沒有公開 API、版面一改就整段掛掉，
 * 而且各家對流量的定義不同（有的含配息再投資）。股數 × 淨值是可驗證的原始定義，
 * 資料源只要給得出這兩個數字就算得出來，換資料源也不用改語意。
 *
 * PE 與淨值來自 stockanalysis.com 的 ETF 頁（頁面內嵌 JSON，欄位名穩定）；抓不到的
 * 板塊只是少了 PE 與流量，價格與 RSI 仍然完整，不會讓整張圖消失。
 */

interface SectorRow {
  symbol: string;
  name: string;
  close: number;
  pct: number;        // 最近一個交易日漲跌幅
  ret1w: number | null;   // 近 5 個交易日
  ret4w: number | null;   // 近 20 個交易日
  rsi14: number | null;
  pe: number | null;
  aum: number | null;         // 美元
  shares: number | null;      // 流通在外股數
  nav: number | null;
  flow1w: number | null;      // 美元，正＝淨流入
  flow4w: number | null;
  flowDays1w: number | null;  // 這筆流量實際涵蓋幾個交易日（歷史還沒滿 5 天時會小於 5）
  flowDays4w: number | null;
}

// 排列順序＝報告呈現順序。半導體用 SMH：台股電子供應鏈對它的連動遠高於整體科技股。
const SECTORS: { symbol: string; name: string }[] = [
  { symbol: "SMH", name: "半導體" },
  { symbol: "XLK", name: "科技" },
  { symbol: "XLC", name: "通訊服務" },
  { symbol: "XLY", name: "非必需消費" },
  { symbol: "XLF", name: "金融" },
  { symbol: "XLI", name: "工業" },
  { symbol: "XLV", name: "醫療保健" },
  { symbol: "XLE", name: "能源" },
  { symbol: "XLB", name: "原物料" },
  { symbol: "XLP", name: "必需消費" },
  { symbol: "XLU", name: "公用事業" },
  { symbol: "XLRE", name: "房地產" },
];

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

async function fetchCloses(symbol: string): Promise<{ closes: number[]; dates: string[] } | null> {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + path, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r?.timestamp) continue;
      const off = typeof r.meta?.gmtoffset === "number" ? r.meta.gmtoffset : 0;
      const raw: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
      const closes: number[] = [];
      const dates: string[] = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const c = raw[i];
        if (typeof c !== "number" || !isFinite(c)) continue;
        closes.push(c);
        dates.push(new Date((r.timestamp[i] + off) * 1000).toISOString().slice(0, 10));
      }
      // 盤中跑時最後一根是還在形成的今天，丟掉——整份報告一律以已收完的交易日為準。
      const today = new Date(Date.now() + off * 1000).toISOString().slice(0, 10);
      while (dates.length > 0 && dates[dates.length - 1] >= today) {
        dates.pop();
        closes.pop();
      }
      if (closes.length < 2) continue;
      return { closes, dates };
    } catch {
      // try next host
    }
  }
  return null;
}

/** Wilder RSI(14)：>70 過熱、<30 超賣，用來看這個板塊是「剛啟動」還是「追高」。 */
function rsi14(closes: number[]): number | null {
  const n = 14;
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return Number((100 - 100 / (1 + gain / loss)).toFixed(2));
}

function retOver(closes: number[], bars: number): number | null {
  if (closes.length < bars + 1) return null;
  const a = closes[closes.length - 1 - bars];
  const b = closes[closes.length - 1];
  if (!a) return null;
  return Number((((b - a) / a) * 100).toFixed(2));
}

/** "651.31M" / "$122.01B" → 數字。抓不到就 null，不要塞 0（0 會被當成真的沒資產）。 */
function parseMagnitude(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\$?([\d.]+)\s*([KMBT])?$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]);
  if (!isFinite(v)) return null;
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return v * (m[2] ? mult[m[2]] : 1);
}

/**
 * stockanalysis.com 的 ETF 頁面把基本面內嵌在一段 JS 物件裡（aum / nav / peRatio / sharesOut）。
 * 只取這四個欄位、各自獨立比對，改版時最多少一個欄位，不會整段解析失敗。
 */
async function fetchFundamentals(symbol: string): Promise<{ pe: number | null; aum: number | null; nav: number | null; shares: number | null }> {
  const empty = { pe: null, aum: null, nav: null, shares: null };
  try {
    const res = await fetch(`https://stockanalysis.com/etf/${symbol.toLowerCase()}/`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return empty;
    const html = await res.text();
    const pick = (key: string): string | undefined => new RegExp(`${key}:"([^"]+)"`).exec(html)?.[1];
    const peRaw = pick("peRatio");
    const pe = peRaw && isFinite(Number(peRaw)) ? Number(peRaw) : null;
    return {
      pe,
      aum: parseMagnitude(pick("aum")),
      nav: parseMagnitude(pick("nav")),
      shares: parseMagnitude(pick("sharesOut")),
    };
  } catch {
    return empty;
  }
}

interface HistoryFile {
  // 交易日 → 各板塊當日的股數與淨值快照
  [date: string]: { [symbol: string]: { shares: number; nav: number } };
}

function loadHistory(path: string): HistoryFile {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    console.warn("[warn] sector-flows-history.json unreadable, starting fresh");
    return {};
  }
}

/**
 * 用「往回第 N 個交易日的股數」算淨流量。
 *
 * 歷史還沒累積滿的時候不回傳 null 就好——回傳「目前能算的天數」讓報告標示清楚
 * （例：累積 3 天就寫「近 3 個交易日」），比整格空白有用。
 */
function flowOver(
  dates: string[],
  hist: HistoryFile,
  symbol: string,
  sharesNow: number,
  navNow: number,
  bars: number,
): { flow: number | null; days: number | null } {
  // 從最舊往新找出「有快照的交易日」，取距今 <= bars 天內最早的那一筆當基準。
  const wanted = dates.slice(-bars - 1, -1); // 不含最後一天（那天就是 now）
  for (const d of wanted) {
    const snap = hist[d]?.[symbol];
    if (snap && snap.shares > 0) {
      const idx = dates.indexOf(d);
      return { flow: (sharesNow - snap.shares) * navNow, days: dates.length - 1 - idx };
    }
  }
  return { flow: null, days: null };
}

async function main() {
  const cwd = process.cwd();
  const historyPath = resolve(cwd, "data/sector-flows-history.json");
  const outPath = resolve(cwd, "data/sector-flows-latest.json");
  const hist = loadHistory(historyPath);

  const rows = await Promise.all(
    SECTORS.map(async (s): Promise<SectorRow | null> => {
      const [chart, fund] = await Promise.all([fetchCloses(s.symbol), fetchFundamentals(s.symbol)]);
      if (!chart) {
        console.warn(`[warn] sector chart failed: ${s.symbol} (${s.name})`);
        return null;
      }
      const { closes, dates } = chart;
      const close = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      // 淨值抓不到時用收盤價代替：ETF 的市價與淨值差通常在 0.1% 以內，用來換算流量夠準。
      const nav = fund.nav ?? close;
      const f1 = fund.shares ? flowOver(dates, hist, s.symbol, fund.shares, nav, 5) : { flow: null, days: null };
      const f4 = fund.shares ? flowOver(dates, hist, s.symbol, fund.shares, nav, 20) : { flow: null, days: null };
      return {
        symbol: s.symbol,
        name: s.name,
        close: Number(close.toFixed(2)),
        pct: Number((((close - prev) / prev) * 100).toFixed(2)),
        ret1w: retOver(closes, 5),
        ret4w: retOver(closes, 20),
        rsi14: rsi14(closes),
        pe: fund.pe,
        aum: fund.aum,
        shares: fund.shares,
        nav: fund.nav,
        flow1w: f1.flow === null ? null : Math.round(f1.flow),
        flow4w: f4.flow === null ? null : Math.round(f4.flow),
        flowDays1w: f1.days,
        flowDays4w: f4.days,
      };
    }),
  );

  const sectors = rows.filter((r): r is SectorRow => r !== null);
  if (sectors.length === 0) {
    console.error("No sector data available.");
    process.exit(1);
  }

  // 今日快照寫回歷史：明天起才算得出流量。以「最後一個已收完交易日」為 key，
  // 同一天重跑會覆蓋成最新的一筆，不會產生兩筆互相矛盾的紀錄。
  const chart0 = await fetchCloses(sectors[0].symbol);
  const snapDate = chart0?.dates[chart0.dates.length - 1] ?? new Date().toISOString().slice(0, 10);
  hist[snapDate] = hist[snapDate] ?? {};
  for (const r of sectors) {
    if (r.shares && r.nav) hist[snapDate][r.symbol] = { shares: r.shares, nav: r.nav };
  }
  // 只留最近 120 個交易日，檔案不會無限長大（4 週流量最多只要往回 20 天）。
  const keys = Object.keys(hist).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete hist[k];

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(historyPath, `${JSON.stringify(hist, null, 2)}\n`, "utf8");
  writeFileSync(
    outPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), tradingDate: snapDate, sectors }, null, 2)}\n`,
    "utf8",
  );

  const withFlow = sectors.filter((s) => s.flow1w !== null).length;
  console.log(`Wrote ${sectors.length}/${SECTORS.length} sectors to ${outPath} (${withFlow} 有流量資料，歷史 ${Object.keys(hist).length} 天)`);
  for (const s of sectors) {
    const f = s.flow1w === null ? "流量:待累積" : `流量:${(s.flow1w / 1e6).toFixed(0)}M/${s.flowDays1w}日`;
    console.log(`  ${s.name.padEnd(6)} ${s.symbol.padEnd(5)} ${s.pct >= 0 ? "+" : ""}${s.pct}%  週${s.ret1w ?? "—"}%  RSI ${s.rsi14 ?? "—"}  PE ${s.pe ?? "—"}  ${f}`);
  }
}

main();
