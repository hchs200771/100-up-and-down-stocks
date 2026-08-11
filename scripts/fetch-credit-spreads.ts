import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 信用利差快照（判斷「資金是不是在緊縮」）。
 *
 * 為什麼不是真的 CDS：CDX / iTraxx / 主權 CDS 報價是 Markit（S&P Global）的商品，
 * 沒有免費且可自動抓的來源。市場講「信用風險升高」時，公開資料裡最貼近、
 * 而且天天更新的替代品是 ICE BofA 的 OAS（option-adjusted spread，公司債對公債的
 * 風險溢酬），跟 CDX 指數走勢高度同向。FRED 提供免費 CSV，不需金鑰。
 *
 * 抓三條，由鬆到緊：
 *   - 高收益債（HY）OAS：風險偏好的溫度計，飆升＝市場開始要求更高的風險補償。
 *   - 投資等級（IG）OAS：擴散到體質好的發行人才算真的信用緊縮。
 *   - AAA OAS：最頂級信用的溢酬，平常貼地不動；它一動代表壓力已經進到核心。
 *
 * 注意用 OAS（利差）而不是殖利率：AAA 殖利率有八成是無風險利率在動，
 * 跟報告裡的美 10 年期殖利率高度重疊，看不出信用面的事；利差才是純風險溢酬。
 *
 * FRED 更新有一天時差（T+1），所以 asOf 通常是前一個美國交易日。
 *
 * 輸出：data/credit-spreads-latest.json
 */

const FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";

const SERIES: { key: string; id: string; name: string; note: string }[] = [
  {
    key: "hyOas",
    id: "BAMLH0A0HYM2",
    name: "美國高收益債利差",
    note: "風險偏好溫度計，最先反應",
  },
  {
    key: "igOas",
    id: "BAMLC0A0CM",
    name: "投資等級公司債利差",
    note: "擴散到投等債才算真的信用收縮",
  },
  {
    key: "aaaOas",
    id: "BAMLC0A1CAAA",
    name: "AAA 級公司債利差",
    note: "最頂級信用的溢酬，動了代表壓力進到核心",
  },
];

interface Point {
  date: string;
  value: number; // 百分點（0.78 = 78 bps）
}

interface CreditSeries {
  key: string;
  fredId: string;
  name: string;
  note: string;
  asOf: string;
  bps: number; // 最新利差（bps）
  chg1d: number | null; // 對前一個有值交易日的變化（bps）
  chg1m: number | null; // 對約 21 個交易日前的變化（bps）
  pctile1y: number | null; // 在近一年分佈中的百分位（0-100，越高＝越緊張）
}

async function fetchSeries(id: string): Promise<Point[]> {
  const res = await fetch(FRED_CSV + encodeURIComponent(id), {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`);
  const csv = await res.text();
  const points: Point[] = [];
  for (const line of csv.split("\n").slice(1)) {
    const [date, raw] = line.trim().split(",");
    if (!date || !raw) continue;
    const value = Number(raw); // 休市日 FRED 給 "."，Number(".") 是 NaN
    if (!isFinite(value)) continue;
    points.push({ date, value });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return points;
}

const toBps = (pct: number) => Math.round(pct * 100);

function build(s: (typeof SERIES)[number], points: Point[]): CreditSeries | null {
  if (points.length === 0) return null;
  const last = points[points.length - 1];
  const prev = points[points.length - 2] ?? null;
  const monthAgo = points[points.length - 22] ?? null;

  // 近一年（約 252 個交易日）的百分位：現在的利差在過去一年裡算高還是低。
  const window = points.slice(-252).map((p) => p.value);
  const below = window.filter((v) => v <= last.value).length;
  const pctile1y = window.length >= 60 ? Math.round((below / window.length) * 100) : null;

  return {
    key: s.key,
    fredId: s.id,
    name: s.name,
    note: s.note,
    asOf: last.date,
    bps: toBps(last.value),
    chg1d: prev ? toBps(last.value) - toBps(prev.value) : null,
    chg1m: monthAgo ? toBps(last.value) - toBps(monthAgo.value) : null,
    pctile1y,
  };
}

async function main() {
  const results = await Promise.all(
    SERIES.map(async (s) => {
      try {
        return build(s, await fetchSeries(s.id));
      } catch (e) {
        console.warn(`[warn] credit spread fetch failed: ${s.id} (${s.name}) — ${(e as Error).message}`);
        return null;
      }
    }),
  );

  const series = results.filter((x): x is CreditSeries => x !== null);
  if (series.length === 0) {
    console.error("No credit spread data available.");
    process.exit(1);
  }

  const outPath = resolve(process.cwd(), "data/credit-spreads-latest.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), source: "FRED (ICE BofA OAS)", series }, null, 2)}\n`,
    "utf-8",
  );
  console.log(`Wrote ${series.length}/${SERIES.length} credit spreads to ${outPath}`);
  for (const s of series) {
    const d1 = s.chg1d === null ? "n/a" : `${s.chg1d >= 0 ? "+" : ""}${s.chg1d}bps`;
    console.log(`  ${s.name}  ${s.bps}bps  日${d1}  近一年百分位 ${s.pctile1y ?? "n/a"}  (${s.asOf})`);
  }
}

main();
