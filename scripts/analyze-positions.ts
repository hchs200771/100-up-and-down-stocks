import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 持倉分析（Mac 端，純讀檔，不連凱基）。
 *
 * 輸入：
 *   data/kgi-positions.json   ← 由 scripts/kgi/fetch_kgi_positions.py 在台灣的 Windows/Linux 主機產生
 *   data/market-latest.json   ← 既有盤後資料（個股今日漲跌、外本比、當沖等）
 *
 * 輸出：
 *   data/position-analysis.json
 *     - marginRisk：保證金率/風險指標評估（會不會太低）
 *     - positions[]：每個部位的標的今日盤面 + 給新聞 worker 用的 queryHints
 *
 * 新聞（個股今日新聞）由後續的 worker（scripts/prompts/position-news-worker.md）依 queryHints 補上，
 * 沿用既有族群 worker 的 web search 流程，這支程式只負責準備結構化資料與風險判斷。
 */

interface Margin {
  equity: number;
  initialMargin: number;
  maintenanceMargin: number;
  available: number;
  riskRatio: number; // %
  currency: string;
}
interface Position {
  type: "stock_future" | "micro_taiex" | "option" | "index_future";
  contractCode: string;
  contractName: string;
  underlyingCode: string;
  underlyingName: string;
  side: "long" | "short";
  lots: number;
  avgPrice: number;
  marketPrice: number;
  pnl: number;
}
interface KgiPositions {
  fetchedAt: string;
  margin: Margin;
  positions: Position[];
}

// 風險指標(=權益/維持保證金 ×100%) 門檻。可依個人風險偏好調整。
const RISK_THRESHOLDS = { critical: 100, warning: 130, caution: 167 };

function evalMargin(m: Margin) {
  const r = m.riskRatio;
  let level: "critical" | "warning" | "caution" | "healthy";
  let message: string;
  if (r < RISK_THRESHOLDS.critical) {
    level = "critical";
    message = `風險指標 ${r}% 已低於 100%，逼近追繳／強制平倉門檻，必須立即補保證金或減碼。`;
  } else if (r < RISK_THRESHOLDS.warning) {
    level = "warning";
    message = `風險指標 ${r}% 偏低（<130%），抗波動空間小，建議補保證金或降低槓桿。`;
  } else if (r < RISK_THRESHOLDS.caution) {
    level = "caution";
    message = `風險指標 ${r}%，尚可但已用掉多數原始保證金，留意盤中急殺。`;
  } else {
    level = "healthy";
    message = `風險指標 ${r}%，保證金水位健康，仍有加碼或抗波動空間。`;
  }
  const maintenanceUsagePct = m.equity > 0 ? Math.round((m.maintenanceMargin / m.equity) * 1000) / 10 : null;
  return { ...m, level, message, maintenanceUsagePct };
}

function loadMarketStockMap(): Record<string, any> {
  const p = resolve(process.cwd(), "data/market-latest.json");
  if (!existsSync(p)) return {};
  try {
    const m = JSON.parse(readFileSync(p, "utf-8"));
    return m.stockMap ?? {};
  } catch {
    return {};
  }
}

function main() {
  const inPath = process.argv[2] ?? "data/kgi-positions.json";
  const resolved = resolve(process.cwd(), inPath);
  if (!existsSync(resolved)) {
    console.error(`找不到持倉檔：${resolved}\n` +
      `請先在台灣的 Windows/Linux 主機跑 scripts/kgi/fetch_kgi_positions.py 產生它，` +
      `或先用 data/kgi-positions.sample.json 測試： npm run positions -- data/kgi-positions.sample.json`);
    process.exit(1);
  }

  const kgi: KgiPositions = JSON.parse(readFileSync(resolved, "utf-8"));
  const stockMap = loadMarketStockMap();
  const marginRisk = evalMargin(kgi.margin);

  const positions = kgi.positions.map((p) => {
    const meta = p.underlyingCode ? stockMap[p.underlyingCode] : undefined;
    const underlyingMarket = meta
      ? {
          pctToday: meta.pct ?? null,
          foreignRatio: meta.chips?.foreignRatio ?? null,
          trustRatio: meta.chips?.trustRatio ?? null,
          dayTradeRatio: meta.dayTradeRatio ?? null,
          flags: meta.flags ?? null,
        }
      : null;

    // 給新聞 worker 的查詢提示
    const queryHints =
      p.type === "stock_future" && p.underlyingName
        ? [`${p.underlyingName} 今日新聞`, `${p.underlyingName} ${p.underlyingCode} 利多 利空`, `${p.underlyingName} 法人 籌碼`]
        : p.type === "micro_taiex"
        ? ["台股加權指數 今日 盤勢", "台指期 外資 籌碼"]
        : [`${p.contractName} 今日`];

    // 方向 vs 標的今日走勢的一致性提示（純文字，給人看）
    let directionNote = "";
    if (underlyingMarket?.pctToday) {
      const up = String(underlyingMarket.pctToday).trim().startsWith("+");
      if (p.side === "long" && !up) directionNote = "持多單但標的今日收黑，留意是否轉弱。";
      if (p.side === "short" && up) directionNote = "持空單但標的今日走強，留意軋空風險。";
    }

    return { ...p, underlyingMarket, queryHints, directionNote };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    sourceFetchedAt: kgi.fetchedAt,
    marginRisk,
    positions,
  };

  const outPath = resolve(process.cwd(), "data/position-analysis.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");

  console.log(`保證金風險：${marginRisk.level}（${marginRisk.riskRatio}%）— ${marginRisk.message}`);
  console.log(`部位 ${positions.length} 筆，其中個股期貨 ${positions.filter((p) => p.type === "stock_future").length} 筆`);
  console.log(`已寫出 ${outPath}`);
}

main();
