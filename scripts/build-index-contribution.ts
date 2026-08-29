#!/usr/bin/env npx tsx
/**
 * 加權指數貢獻拆解。
 *
 * 指數漲跌幾點是結果，「誰把它推上去、誰在拖」才是可操作的資訊。這支把當日
 * 加權指數的漲跌，依市值權重拆回每一檔上市股與每一個官方產業別，輸出
 * data/index-contribution-latest.json，供 send-report.ts 的「指數貢獻拆解」區塊使用。
 *
 * 公式：個股貢獻點數 = 漲跌價差 × 發行股數 / 昨日總市值 × 昨日指數
 *
 * 為什麼要校準（calibration）：
 *   原始加總跟交易所公佈的指數漲跌會差幾個百分點，來源是
 *   1. 發行股數取自 MOPS 月更資料（t187ap03_L），出表日期通常比交易日早一天
 *   2. 特別股、私募股不計入指數，但上面那份股數沒有拆開
 *   3. 全額交割股、上市未滿一個月的新股不納入指數計算
 *   這些偏差無法從公開資料完全還原，所以改用一個整體係數把加總對齊實際漲跌。
 *   個股之間的相對比重不受影響，總數則精確等於交易所公佈值。
 *
 * 只涵蓋上市（TWSE）。加權指數本來就不含上櫃，TPEx 另有櫃買指數，不混在一起。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** TWSE 官方產業別代碼 → 名稱（t187ap03_L 的「產業別」欄位）。 */
const INDUSTRY: Record<string, string> = {
  "01": "水泥", "02": "食品", "03": "塑膠", "04": "紡織纖維", "05": "電機機械",
  "06": "電器電纜", "08": "玻璃陶瓷", "09": "造紙", "10": "鋼鐵", "11": "橡膠",
  "12": "汽車", "14": "建材營造", "15": "航運", "16": "觀光餐旅", "17": "金融保險",
  "18": "貿易百貨", "20": "其他", "21": "化學工業", "22": "生技醫療", "23": "油電燃氣",
  "24": "半導體", "25": "電腦及週邊", "26": "光電", "27": "通信網路", "28": "電子零組件",
  "29": "電子通路", "30": "資訊服務", "31": "其他電子", "32": "文化創意", "33": "農業科技",
  "34": "電子商務", "35": "綠能環保", "36": "數位雲端", "37": "運動休閒", "38": "居家生活",
  "80": "管理股票",
};

const TOP_N = 12;

export interface StockContribution {
  code: string;
  name: string;
  industry: string;
  pct: number;
  points: number;
}

export interface SectorContribution {
  name: string;
  points: number;
  /** 成分股貢獻的絕對值加總——treemap 的面積用這個，才看得出「戰場大小」 */
  absPoints: number;
  /** 產業內部往上推的力道（正貢獻加總）。Sankey 要靠這個拆「上漲貢獻→產業」的流量。 */
  upPoints: number;
  /** 產業內部往下拖的力道（負貢獻加總的絕對值）。 */
  downPoints: number;
  count: number;
  top: StockContribution[];
}

export interface IndexContribution {
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

/** 民國日期 "115/08/27" → "2026-08-27"。交易所端點的日期欄一律是這個格式。 */
export function rocToIso(roc: string): string | null {
  const m = roc.trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  return `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}`;
}

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function fetchText(url: string, label: string, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim()) throw new Error("empty body");
      return text;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw new Error(`${label} failed: ${(lastErr as Error)?.message}`);
}

/** STOCK_DAY_ALL 可能回 CSV 或 JSON，兩種都吃。回傳 [代號, 名稱, ..., 收盤價, 漲跌價差, ...] */
export function parseDayAll(text: string): string[][] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    const j = JSON.parse(text);
    return Array.isArray(j?.data) ? j.data : [];
  }
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("日期")) continue;
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (cols.length < 11 || !/^\d{3,}$/.test(cols[0])) continue;
    rows.push(cols.slice(1)); // 丟掉開頭的日期欄，對齊 JSON 版欄位
  }
  return rows;
}

async function main() {
  const [dayAllRaw, issuedRaw, fmtqikRaw] = await Promise.all([
    fetchText("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json", "STOCK_DAY_ALL"),
    fetchText("https://openapi.twse.com.tw/v1/opendata/t187ap03_L", "TWSE issued shares"),
    fetchText("https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json", "FMTQIK"),
  ]);

  const rows = parseDayAll(dayAllRaw);
  if (rows.length === 0) throw new Error("STOCK_DAY_ALL 沒有解析到任何個股");

  // 發行股數 + 官方產業別，同一支 API 一次拿到
  const meta = new Map<string, { shares: number; industry: string }>();
  for (const item of JSON.parse(issuedRaw) as Record<string, string>[]) {
    const code = item["公司代號"];
    const shares = num(item["已發行普通股數或TDR原股發行股數"]);
    if (!code || !shares || shares <= 0) continue;
    meta.set(code, { shares, industry: INDUSTRY[item["產業別"]] ?? "其他" });
  }
  if (meta.size === 0) throw new Error("t187ap03_L 沒有解析到發行股數");

  const fmtqik = JSON.parse(fmtqikRaw);
  const lastIdx = fmtqik?.data?.[fmtqik.data.length - 1];
  const idxClose = num(lastIdx?.[4]);
  const idxChange = num(lastIdx?.[5]);
  if (idxClose === null || idxChange === null) throw new Error("FMTQIK 沒有解析到加權指數收盤");
  const idxPrev = idxClose - idxChange;

  // 交易日一定要取自資料本身，不能用執行當下的日期：這支在收盤前、假日、或隔天早上
  // 跑都會拿到「上一個交易日」的數字，用時鐘當日期會讓 send-report 的新鮮度檢查誤判。
  const tradingDate = rocToIso(String(lastIdx?.[0] ?? ""));
  if (!tradingDate) throw new Error(`FMTQIK 日期無法解析：${lastIdx?.[0]}`);

  // 昨日總市值：加權指數的分母。用「今日收盤 - 漲跌價差」回推昨收，避免多打一支 API。
  let mcapPrev = 0;
  let priced = 0;
  const raw: (StockContribution & { dMcap: number })[] = [];
  for (const r of rows) {
    const [code, name] = r;
    const close = num(r[7]);
    const change = num(r[8]);
    if (close === null || change === null) continue;
    priced++;
    const m = meta.get(code);
    if (!m) continue; // ETF、權證、受益證券等不在指數成分內，本來就該排除
    const prev = close - change;
    if (prev <= 0) continue;
    mcapPrev += prev * m.shares;
    raw.push({
      code,
      name,
      industry: m.industry,
      pct: (change / prev) * 100,
      points: 0,
      dMcap: change * m.shares,
    });
  }
  if (mcapPrev <= 0) throw new Error("推估總市值為 0，資料異常");

  const rawPoints = raw.map((s) => (s.dMcap / mcapPrev) * idxPrev);
  const rawSum = rawPoints.reduce((a, b) => a + b, 0);
  // 指數幾乎不會剛好平盤；真的平盤時校準沒有意義，退回 1 保留原始比重。
  const calibration = Math.abs(rawSum) > 1e-9 ? idxChange / rawSum : 1;
  const stocks = raw.map((s, i) => ({
    code: s.code,
    name: s.name,
    industry: s.industry,
    pct: Number(s.pct.toFixed(2)),
    points: Number((rawPoints[i] * calibration).toFixed(2)),
  }));

  const up = stocks.filter((s) => s.points > 0).reduce((a, s) => a + s.points, 0);
  const down = stocks.filter((s) => s.points < 0).reduce((a, s) => a + s.points, 0);
  const abs = up - down;

  const byIndustry = new Map<string, StockContribution[]>();
  for (const s of stocks) {
    const list = byIndustry.get(s.industry) ?? [];
    list.push(s);
    byIndustry.set(s.industry, list);
  }
  const sectors: SectorContribution[] = [...byIndustry]
    .map(([name, list]) => {
      const sorted = [...list].sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
      return {
        name,
        points: Number(list.reduce((a, s) => a + s.points, 0).toFixed(2)),
        absPoints: Number(list.reduce((a, s) => a + Math.abs(s.points), 0).toFixed(2)),
        upPoints: Number(list.filter((s) => s.points > 0).reduce((a, s) => a + s.points, 0).toFixed(2)),
        downPoints: Number(list.filter((s) => s.points < 0).reduce((a, s) => a - s.points, 0).toFixed(2)),
        count: list.length,
        // Sankey 第三欄要展開個股，5 檔不夠用；treemap/表格只取前 3，多存不影響它們。
        top: sorted.slice(0, 8),
      };
    })
    .sort((a, b) => b.points - a.points);

  const byPoints = [...stocks].sort((a, b) => b.points - a.points);
  const out: IndexContribution = {
    timestamp: new Date().toISOString(),
    tradingDate,
    index: { close: idxClose, change: idxChange, prev: Number(idxPrev.toFixed(2)) },
    calibration: Number(calibration.toFixed(4)),
    totals: {
      up: Number(up.toFixed(2)),
      down: Number(down.toFixed(2)),
      net: Number(idxChange.toFixed(2)),
      abs: Number(abs.toFixed(2)),
      offset: Number((abs - Math.abs(idxChange)).toFixed(2)),
    },
    coverage: { priced, matched: stocks.length },
    sectors,
    topGainers: byPoints.slice(0, TOP_N),
    topLosers: byPoints.slice(-TOP_N).reverse(),
  };

  const outPath = resolve(process.cwd(), "data/index-contribution-latest.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf-8");

  console.log(
    `指數貢獻拆解：交易日 ${out.tradingDate}（取自 FMTQIK）加權 ${idxClose}（${idxChange >= 0 ? "+" : ""}${idxChange} 點）\n` +
      `  納入 ${stocks.length} / ${priced} 檔（其餘為 ETF、權證等非指數成分），校準係數 ${out.calibration}\n` +
      `  上漲貢獻 +${out.totals.up} / 下跌貢獻 ${out.totals.down} / 內部對沖 ${out.totals.offset} 點\n` +
      `  寫入 ${outPath}`,
  );
}

main().catch((err) => {
  console.error("build-index-contribution failed:", err.message);
  process.exit(1);
});
