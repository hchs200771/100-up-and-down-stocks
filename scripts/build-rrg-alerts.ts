#!/usr/bin/env npx tsx
/**
 * 從 data/tw-rrg-data.json 找出「值得講的象限異動」，輸出 data/tw-rrg-alerts.json。
 *
 * 目的：使用者不必自己看圖判讀。這支腳本負責把「圖上看得到但要盯很久才發現」的事
 * 轉成文字訊號。
 *
 * 主視窗用 60 日（120 日太慢、吃不下數日崩盤；20 日雜訊多），20 日只用來抓短線背離。
 *
 * 偵測六類事件（依重要性排序）：
 *   1. 領先→弱化      主流見頂，最可操作的警訊
 *   2. 動能轉折       仍在領先象限但動能連續下滑 —— 比象限跨越更早的預警
 *   3. 改善→領先      新主流확立
 *   4. 落後→改善      落底翻揚
 *   5. 視窗背離       60日領先但20日已弱化（獲利了結）／60日落後但20日改善（可能打底）
 *   6. 榜單背離       RRG 位階與「今日是否在漲跌幅前100名」矛盾
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const MAIN_W = '60';
const FAST_W = '20';
const LOOKBACK = 5; // 幾個交易日前當作比較基準

type Pt = [number, number];
type Alert = {
  kind: string;
  sector: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
  rs: number;
  mom: number;
};

const quadOf = (p: Pt) =>
  p[0] >= 100 && p[1] >= 100 ? '領先'
  : p[0] < 100 && p[1] >= 100 ? '改善'
  : p[0] < 100 ? '落後'
  : '弱化';

function main() {
  const dataPath = path.join(ROOT, 'data', 'tw-rrg-data.json');
  if (!fs.existsSync(dataPath)) {
    console.error('缺少 data/tw-rrg-data.json —— 先跑 npx tsx scripts/build-tw-rrg.ts');
    process.exit(1);
  }
  const d = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const uni = d.universes.tw_sectors;
  const asOf = uni.dates[uni.dates.length - 1];

  // 今日漲跌幅前 100 名的代號 → 用來偵測「RRG 位階 vs 今日榜單」背離
  const inGainers = new Set<string>();
  const inLosers = new Set<string>();
  const mlPath = path.join(ROOT, 'data', 'market-latest.json');
  if (fs.existsSync(mlPath)) {
    const ml = JSON.parse(fs.readFileSync(mlPath, 'utf-8'));
    for (const s of ml.gainers ?? []) inGainers.add(s.code);
    for (const s of ml.losers ?? []) inLosers.add(s.code);
  }
  const baskets = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sector-baskets.json'), 'utf-8'));
  const membersOf: Record<string, string[]> = {};
  for (const b of baskets.baskets) membersOf[b.canonical] = b.members.map((m: [string, string]) => m[0]);

  const alerts: Alert[] = [];
  const quadrants: Record<string, string[]> = { 領先: [], 改善: [], 落後: [], 弱化: [] };

  for (const s of uni.series) {
    const main = s.tf[MAIN_W].filter(Boolean) as Pt[];
    const fast = s.tf[FAST_W].filter(Boolean) as Pt[];
    if (main.length < LOOKBACK + 3) continue;

    const now = main[main.length - 1];
    const then = main[main.length - 1 - LOOKBACK];
    const qNow = quadOf(now);
    const qThen = quadOf(then);
    quadrants[qNow].push(s.ticker);

    const dMom = now[1] - then[1];
    const dRs = now[0] - then[0];
    const fmt = (p: Pt) => `RS ${p[0].toFixed(1)} / 動能 ${p[1].toFixed(1)}`;

    // 1. 象限跨越
    if (qNow !== qThen) {
      const key = `${qThen}→${qNow}`;
      const spec: Record<string, { sev: Alert['severity']; msg: string }> = {
        '領先→弱化': { sev: 'high', msg: '主流動能轉負，資金開始撤出，是最該留意的出場訊號' },
        '改善→領先': { sev: 'high', msg: '正式站上領先象限，新主流確立' },
        '落後→改善': { sev: 'medium', msg: '相對動能翻正，落底翻揚的第一步' },
        '弱化→落後': { sev: 'medium', msg: '確認轉弱，續弱機率高' },
        '改善→落後': { sev: 'medium', msg: '改善失敗、打回落後，屬假突破' },
        '弱化→領先': { sev: 'medium', msg: '弱化後重返領先，主流地位守住' },
      };
      const m = spec[key];
      if (m) {
        alerts.push({
          kind: key, sector: s.ticker, severity: m.sev,
          detail: `${LOOKBACK} 日內由「${qThen}」轉入「${qNow}」（${fmt(now)}）。${m.msg}。`,
          rs: now[0], mom: now[1],
        });
      }
    }

    // 2. 仍在領先、但動能連續下滑 → 比象限跨越更早的預警
    if (qNow === '領先' && qThen === '領先' && dMom < -0.3) {
      alerts.push({
        kind: '領先但動能轉弱', sector: s.ticker, severity: 'high',
        detail: `仍在領先象限，但動能 ${LOOKBACK} 日內由 ${then[1].toFixed(1)} 降至 ${now[1].toFixed(1)}（${dMom.toFixed(2)}）。尚未跌出象限，屬見頂前的早期訊號，順勢單宜開始減碼而非加碼。`,
        rs: now[0], mom: now[1],
      });
    }

    // 3. 落後象限但動能明顯回升
    if (qNow === '落後' && dMom > 0.5) {
      alerts.push({
        kind: '落後但動能回升', sector: s.ticker, severity: 'low',
        detail: `仍在落後象限，但動能 ${LOOKBACK} 日內回升 ${dMom.toFixed(2)}（${fmt(now)}）。跌深反彈與真打底的分水嶺，需再觀察是否站上改善象限。`,
        rs: now[0], mom: now[1],
      });
    }

    // 4. 視窗背離：中期 vs 短期講不同的話
    if (fast.length) {
      const qFast = quadOf(fast[fast.length - 1]);
      if (qNow === '領先' && (qFast === '弱化' || qFast === '落後')) {
        alerts.push({
          kind: '中期強短線弱', sector: s.ticker, severity: 'medium',
          detail: `60 日仍在「領先」，20 日已掉到「${qFast}」。中期趨勢未破但短線資金正在獲利了結，追高風險高。`,
          rs: now[0], mom: now[1],
        });
      }
      if ((qNow === '落後' || qNow === '弱化') && qFast === '改善') {
        alerts.push({
          kind: '中期弱短線強', sector: s.ticker, severity: 'low',
          detail: `60 日仍在「${qNow}」，20 日已翻上「改善」。可能是落底，也可能只是跌深反彈——空頭市場中跌得比大盤少就會被算成改善，需搭配籌碼確認。`,
          rs: now[0], mom: now[1],
        });
      }
    }

    // 5. 榜單背離：RRG 說強但今天在跌幅榜（或反之）
    const codes = membersOf[s.ticker] ?? [];
    const nUp = codes.filter((c) => inGainers.has(c)).length;
    const nDn = codes.filter((c) => inLosers.has(c)).length;
    if (qNow === '領先' && nDn >= 2 && nDn > nUp) {
      alerts.push({
        kind: '位階強但今日殺盤', sector: s.ticker, severity: 'medium',
        detail: `RRG 中期仍在「領先」，但今日有 ${nDn} 檔成分股落入跌幅前 100 名。中期地位與當日走勢背離，留意是否為趨勢轉折的起點。`,
        rs: now[0], mom: now[1],
      });
    }
    if ((qNow === '落後' || qNow === '弱化') && nUp >= 2 && nUp > nDn) {
      alerts.push({
        kind: '位階弱但今日轉強', sector: s.ticker, severity: 'low',
        detail: `RRG 中期仍在「${qNow}」，但今日有 ${nUp} 檔成分股衝上漲幅前 100 名。屬弱勢族群中的逆勢反彈，未獲中期趨勢背書。`,
        rs: now[0], mom: now[1],
      });
    }
    void dRs;
  }

  const sevRank = { high: 0, medium: 1, low: 2 };

  // ── 收斂 ─────────────────────────────────────────────────────────────────
  // 同一種訊號如果在多數族群同時出現，那就不是「某族群的異動」，而是大盤的狀態。
  // 例：全面崩盤時幾乎每個領先族群的 20 日都會掉到弱化 —— 列成 6 條會淹沒真訊號，
  // 應該收斂成一句「市場狀態」。門檻取 5 個族群（全部 25 個的 20%）。
  const REGIME_MIN = 5;
  const byKind = new Map<string, Alert[]>();
  for (const a of alerts) {
    if (!byKind.has(a.kind)) byKind.set(a.kind, []);
    byKind.get(a.kind)!.push(a);
  }
  const regimeMsg: Record<string, string> = {
    中期強短線弱: '多數領先族群的短線動能同步轉弱 —— 這是大盤全面回檔的特徵，而非個別族群見頂，此時「改善／弱化」象限的參考價值下降',
    中期弱短線強: '多數落後族群的短線動能同步翻正 —— 空頭市場中跌得比大盤少就會被算成「改善」，多屬相對抗跌而非真打底',
    落後但動能回升: '多個落後族群同步出現動能回升 —— 屬跌深後的整體反彈，非個別族群的打底訊號',
  };
  const regime: { kind: string; sectors: string[]; note: string }[] = [];
  const suppressed = new Set<string>();
  for (const [kind, list] of byKind) {
    if (list.length >= REGIME_MIN && regimeMsg[kind]) {
      regime.push({ kind, sectors: list.map((a) => a.sector), note: regimeMsg[kind] });
      suppressed.add(kind);
    }
  }

  // 每個族群只留最重要的一條，避免同一族群洗版
  const kept: Alert[] = [];
  const seen = new Set<string>();
  for (const a of [...alerts].sort((x, y) => sevRank[x.severity] - sevRank[y.severity] || y.rs - x.rs)) {
    if (suppressed.has(a.kind) || seen.has(a.sector)) continue;
    seen.add(a.sector);
    kept.push(a);
  }
  const finalAlerts = kept.slice(0, 10);

  const out = {
    asOf,
    mainWindow: Number(MAIN_W),
    fastWindow: Number(FAST_W),
    lookback: LOOKBACK,
    basketVersion: baskets.version,
    quadrants,
    regime,
    alerts: finalAlerts,
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'tw-rrg-alerts.json'), JSON.stringify(out, null, 2));

  console.log(`asOf ${asOf} | 主視窗 ${MAIN_W} 日 | ${alerts.length} 則原始 → 收斂後 ${finalAlerts.length} 則 + ${regime.length} 則市場狀態`);
  for (const q of ['領先', '改善', '弱化', '落後']) {
    console.log(`  ${q}(${quadrants[q].length}): ${quadrants[q].join('、') || '—'}`);
  }
  if (regime.length) {
    console.log('\n── 市場狀態（收斂自多族群同時觸發）──');
    for (const r of regime) console.log(`  ${r.kind}（${r.sectors.length} 個族群）：${r.note}`);
  }
  console.log('\n── 個別族群異動 ──');
  for (const a of finalAlerts) {
    console.log(`[${a.severity.toUpperCase()}] ${a.kind} — ${a.sector}`);
    console.log(`        ${a.detail}`);
  }
}

main();
