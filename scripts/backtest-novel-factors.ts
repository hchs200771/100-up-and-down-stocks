/** Fixed rules for return decomposition and a market-only residual momentum proxy. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanel, addDayQuotes, addReferenceEvent, finalizePanel, featuresAt, historyRows, type StockPanel } from './lib/wide-market-panel.ts';
import { sessionReturnComponents, marketResidualMomentum } from './lib/novel-price-factors.ts';
import { simulateCohort } from './lib/expanded-portfolio.ts';
import { summarize, pairedBlockInterval, type ExperimentCohort } from './backtest-price-market-events.ts';
import { stressReturn } from './backtest-wide-market.ts';

export interface FactorCandidate { stock: StockPanel; total: number; day: number; negativeNight: number; residual: number | null }
export function percentileRanks(candidates: FactorCandidate[], score: (c: FactorCandidate) => number): Map<string, number> {
  const sorted = [...candidates].sort((a, b) => score(a) - score(b) || a.stock.code.localeCompare(b.stock.code));
  const result = new Map<string, number>();
  for (let first = 0; first < sorted.length;) {
    let last = first;
    while (last + 1 < sorted.length && score(sorted[last + 1]) === score(sorted[first])) last++;
    const rank = sorted.length > 1 ? ((first + last) / 2) / (sorted.length - 1) : .5;
    for (let k = first; k <= last; k++) result.set(sorted[k].stock.code, rank);
    first = last + 1;
  }
  return result;
}
export function selectFactorCandidates(rule: string, pool: FactorCandidate[], count: number): FactorCandidate[] {
  const rank = (score: (c: FactorCandidate) => number) => percentileRanks(pool, score);
  let score: (c: FactorCandidate) => number;
  if (rule === 'baseline_split' || rule === 'baseline_residual') score = (c) => c.total;
  else if (rule === 'day_momentum') score = (c) => c.day;
  else if (rule === 'night_reversal') score = (c) => c.negativeNight;
  else if (rule === 'market_residual') score = (c) => c.residual!;
  else if (rule === 'split_combination') {
    const day = rank((c) => c.day), night = rank((c) => c.negativeNight);
    score = (c) => (day.get(c.stock.code)! + night.get(c.stock.code)!) / 2;
  } else if (rule === 'residual_combination') {
    const total = rank((c) => c.total), residual = rank((c) => c.residual!);
    score = (c) => (total.get(c.stock.code)! + residual.get(c.stock.code)!) / 2;
  } else throw new Error(`Unknown factor rule ${rule}`);
  if ((rule === 'market_residual' || rule === 'residual_combination') && pool.some((c) => c.residual === null)) throw new Error('Residual strategy pool must have complete residual data');
  return [...pool].sort((a, b) => score(b) - score(a) || a.stock.code.localeCompare(b.stock.code)).slice(0, count);
}
const mean = (values: number[]) => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
const labels: Record<string, string> = {
  baseline_split: '同母體原始20日動能', day_momentum: '日間動能', night_reversal: '隔夜反轉', split_combination: '日間＋隔夜反轉',
  baseline_residual: '殘差完整母體原始動能', market_residual: '大盤殘差動能', residual_combination: '原始＋大盤殘差動能',
};
const n = (value: number | null | undefined) => value == null ? '—' : value.toFixed(2);

/** Keep reviewable metrics in the repository; raw quotes and full positions remain local. */
export function writeResearchSnapshot(output: any): void {
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const calendar = JSON.parse(readFileSync('research/wide-market/benchmark-input.json', 'utf8'))
    .benchmarkTotalReturn.TaiwanStockPrice.map((r: any) => r.date).filter((d: string) => d <= output.config.end).sort();
  const priceDigest = createHash('sha256');
  for (const date of calendar) for (const source of ['twse', 'tpex']) {
    const path = `data/backtest/wide/daily/${source}/${date}.json.gz`;
    priceDigest.update(`${path}:${existsSync(path) ? digest(path) : 'MISSING'}\n`);
  }
  const summaries = Object.fromEntries(Object.entries(output.summaries).map(([horizon, periods]: [string, any]) => [horizon,
    Object.fromEntries(Object.entries(periods).map(([period, rules]: [string, any]) => [period,
      Object.fromEntries(Object.entries(rules).map(([rule, stats]: [string, any]) => {
        const { daily, invalidExecutions, ...compact } = stats;
        return [rule, compact];
      }))]))]));
  const coverage = output.config.holdingSessions.flatMap((horizon: number) => Object.keys(output.config.families).map((family: string) => {
    const rows = output.coverage.filter((r: any) => r.horizon === horizon && r.family === family);
    const formed = rows.filter((r: any) => r.status === 'evaluated');
    return { horizon, family, planned: rows.length, formed: formed.length, firstSignal: formed[0]?.date ?? null, lastSignal: formed.at(-1)?.date ?? null,
      excludedByStatus: Object.fromEntries(['insufficient_warmup', 'missing_source', 'no_complete_candidates'].map((s) => [s, rows.filter((r: any) => r.status === s).length])) };
  }));
  const fingerprints = {
    benchmark: digest('research/wide-market/benchmark-input.json'), actions: digest('data/backtest/wide/actions/twse-ex-references.json'),
    priceCachePathAndSha256Digest: priceDigest.digest('hex'),
    code: Object.fromEntries(['scripts/backtest-novel-factors.ts', 'scripts/lib/novel-price-factors.ts', 'scripts/lib/wide-market-panel.ts',
      'scripts/lib/expanded-portfolio.ts', 'scripts/backtest-price-market-events.ts', 'scripts/backtest-wide-market.ts', 'docs/novel-factor-backtest-config.json'].map((path) => [path, digest(path)])),
  };
  mkdirSync('research/novel-factors', { recursive: true });
  writeFileSync('research/novel-factors/2026-10-05-summary.json', JSON.stringify({ schemaVersion: 1, generatedAt: output.generatedAt,
    decision: 'No new factor adopted; fixed-rule proxy tests do not establish reliable positive incremental returns. Gross profit/assets untested.',
    config: output.config, inputCoverage: output.inputCoverage, blockedFactors: output.blockedFactors, coverage, summaries, fingerprints }, null, 2) + '\n');
}

export function main() {
  const config = JSON.parse(readFileSync('docs/novel-factor-backtest-config.json', 'utf8'));
  const benchmarkInput = JSON.parse(readFileSync('research/wide-market/benchmark-input.json', 'utf8')).benchmarkTotalReturn;
  const raw = benchmarkInput.TaiwanStockPrice.filter((r: any) => r.date <= config.end).sort((a: any, b: any) => a.date.localeCompare(b.date));
  const calendar: string[] = raw.map((r: any) => r.date);
  const panel = createPanel(calendar);
  const actions = JSON.parse(readFileSync('data/backtest/wide/actions/twse-ex-references.json', 'utf8')).rows;
  const actionByKey = new Map<string, { reference: number; kind: string }>();
  for (const action of actions) {
    const key = `${action.date}/${action.code}`;
    if (actionByKey.has(key) && Math.abs(actionByKey.get(key)!.reference - action.reference) > 1e-8) throw new Error(`Conflicting reference ${key}`);
    actionByKey.set(key, action);
  }
  const sourceMissing: string[] = [];
  const sourceComplete = new Uint8Array(calendar.length);
  console.log('[load] Loading contemporaneous TWSE/TPEx history and official adjustment references');
  for (let i = 0; i < calendar.length; i++) {
    let complete = true;
    for (const source of ['twse', 'tpex']) {
      const path = `data/backtest/wide/daily/${source}/${calendar[i]}.json.gz`;
      if (!existsSync(path)) { sourceMissing.push(`${source}/${calendar[i]}`); complete = false; continue; }
      const cached = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
      if (cached.parserVersion !== 'all-ordinary-rows-v2' || cached.requestedDate !== calendar[i].replaceAll('-', '') || !cached.rows?.length) throw new Error(`Invalid cache ${path}`);
      addDayQuotes(panel, i, cached.rows.map((quote: any) => {
        const action = actionByKey.get(`${calendar[i]}/${quote.code}`);
        return action ? { ...quote, explicitReference: action.reference, changeLabel: action.kind } : quote;
      }));
    }
    sourceComplete[i] = Number(complete);
  }
  const indexByDate = new Map(calendar.map((d, i) => [d, i]));
  for (const [key, action] of actionByKey) {
    const [date, code] = key.split('/'); const i = indexByDate.get(date);
    if (i !== undefined) addReferenceEvent(panel, i, code, action.reference);
  }
  finalizePanel(panel);
  const marketPanel = createPanel(calendar);
  raw.forEach((r: any, i: number) => addDayQuotes(marketPanel, i, [{ date: r.date, code: 'INDEX', name: 'TAIEX', market: 'index',
    open: r.open, close: r.close, high: r.high ?? r.max, low: r.low ?? r.min,
    volume: r.volume > 0 ? r.volume : 1, money: r.money >= 0 ? r.money : 0, change: null, changeLabel: '', nextReference: null }] as any));
  finalizePanel(marketPanel);
  const market = marketPanel.get('INDEX')!;
  const benchmarkRows = new Map<string, { open: number; close: number }>(raw.map((r: any) => [r.date, { open: r.open, close: r.close }]));
  const benchmarkTR = new Map<string, number>(benchmarkInput.TaiwanStockTotalReturnIndex.map((r: any) => [r.date, r.price]));
  const start = calendar.indexOf(config.evaluationStart);
  if (start < 60) throw new Error('Invalid start or insufficient warmup');
  const coverage: any[] = [], summaries: any = {}, cohorts: any = {};
  const candidateCache = new Map<number, FactorCandidate[]>();
  const comparisons = 90;
  console.log(`[load] ${panel.size} historical codes, ${calendar.length} sessions; missing sources ${sourceMissing.length}`);
  for (const horizon of config.holdingSessions as number[]) {
    const horizonResults: Record<string, ExperimentCohort[]> = {};
    for (const family of Object.values(config.families) as any[]) for (const id of family.strategies) horizonResults[id] = [];
    console.log(`[start] ${horizon}-session holding, fixed signal phase ${config.evaluationStart}`);
    for (let i = start; i + horizon < calendar.length; i += horizon) {
      const dates = calendar.slice(i + 1, i + horizon + 1);
      if (!candidateCache.has(i)) {
        const candidates: FactorCandidate[] = [];
        for (const stock of panel.values()) {
          if (stock.volume[i] < config.minimumSignalVolumeShares) continue;
          const base = featuresAt(stock, i);
          const split = sessionReturnComponents(stock, i, config.signalSessions);
          if (!base || !split) continue;
          const residual = marketResidualMomentum(stock, market, i, config.trainingSessions, config.signalSessions);
          candidates.push({ stock, total: split.totalLogReturn, day: split.dayLogReturn, negativeNight: -split.nightLogReturn, residual: residual?.score ?? null });
        }
        candidateCache.set(i, candidates);
      }
      const common = candidateCache.get(i)!;
      const rows = new Map<string, ReturnType<typeof historyRows>>();
      for (const [familyId, family] of Object.entries(config.families) as [string, any][]) {
        const warmup = familyId === 'residual' ? config.trainingSessions + config.signalSessions : 60;
        if (i < warmup) { coverage.push({ horizon, family: familyId, date: calendar[i], status: 'insufficient_warmup' }); continue; }
        const missing = calendar.slice(i - warmup, i + horizon + 1).filter((_, k) => !sourceComplete[i - warmup + k]);
        if (missing.length) { coverage.push({ horizon, family: familyId, date: calendar[i], status: 'missing_source', missing }); continue; }
        const pool = familyId === 'residual' ? common.filter((c) => c.residual !== null) : common;
        if (!pool.length) { coverage.push({ horizon, family: familyId, date: calendar[i], status: 'no_complete_candidates' }); continue; }
        coverage.push({ horizon, family: familyId, date: calendar[i], status: 'evaluated', candidates: pool.length });
        for (const rule of family.strategies) {
          const selected = selectFactorCandidates(rule, pool, config.topCount);
          const selections = selected.map((c) => ({ code: c.stock.code, weight: 1 / selected.length }));
          const holdings = selected.map((c, k) => {
            if (!rows.has(c.stock.code)) rows.set(c.stock.code, historyRows(c.stock, Array.from({ length: horizon }, (_, k) => i + 1 + k)));
            return { ...selections[k], series: rows.get(c.stock.code)! };
          });
          horizonResults[rule].push({ signalDate: calendar[i], entryDate: dates[0], exitDate: dates.at(-1)!, selections,
            result: simulateCohort({ dates, holdings, benchmarkRows, benchmarkTR, holdingSessions: horizon }) });
        }
      }
      if ((i - start) % (horizon * 100) === 0) console.log(`[progress] ${horizon}-session through ${calendar[i]}`);
    }
    cohorts[horizon] = horizonResults;
    const periods = [
      { id: 'all', keep: (_c: ExperimentCohort) => true },
      { id: '2020_2023', keep: (c: ExperimentCohort) => c.exitDate < '2024-01-01' },
      { id: '2024_2026', keep: (c: ExperimentCohort) => c.signalDate >= '2024-01-01' },
    ];
    summaries[horizon] = {};
    for (const period of periods) {
      const byRule: any = {};
      for (const family of Object.values(config.families) as any[]) {
        const baseline = horizonResults[family.baseline].filter(period.keep);
        const baselineByDate = new Map(baseline.map((c) => [c.signalDate, c]));
        for (const rule of family.strategies) {
          const results = horizonResults[rule].filter(period.keep);
          const pairs = results.flatMap((c) => c.result.valid && baselineByDate.get(c.signalDate)?.result.valid ? [{ strategy: c, baseline: baselineByDate.get(c.signalDate)! }] : []);
          let group = 0;
          const groups = pairs.map((p, k) => {
            if (k && indexByDate.get(p.strategy.signalDate)! - indexByDate.get(pairs[k - 1].strategy.signalDate)! !== horizon) group++;
            return group;
          });
          const deltas = pairs.map((p) => p.strategy.result.netReturnPct! - p.baseline.result.netReturnPct!);
          const winDeltas = pairs.map((p) => 100 * (Number(p.strategy.result.netReturnPct! > p.strategy.result.benchmarkReturnPct!) - Number(p.baseline.result.netReturnPct! > p.baseline.result.benchmarkReturnPct!)));
          const stress = results.flatMap((c) => { const r = stressReturn(c, config.adverseSlippageEachSide); return r === null ? [] : [{ r, excess: r - c.result.benchmarkReturnPct! }]; });
          const pairedStress = pairs.map((p) => stressReturn(p.strategy, config.adverseSlippageEachSide)! - stressReturn(p.baseline, config.adverseSlippageEachSide)!);
          const stats = summarize(results);
          const consecutive = results.every((c, k) => !k || indexByDate.get(c.signalDate)! - indexByDate.get(results[k - 1].signalDate)! === horizon);
          if (!consecutive) { stats.performance = null; stats.daily = []; }
          const seed = [...rule].reduce((s, ch) => (Math.imul(s, 31) + ch.charCodeAt(0)) >>> 0, 1729 + horizon);
          byRule[rule] = { ...stats, baseline: family.baseline, consecutiveCoveredTimeline: consecutive,
            pairedVsBaseline: rule === family.baseline ? null : pairedBlockInterval(deltas, seed, comparisons, groups, Math.ceil(60 / horizon)),
            pairedExcessWinVsBaseline: rule === family.baseline ? null : pairedBlockInterval(winDeltas, seed + 1, comparisons, groups, Math.ceil(60 / horizon)),
            pairedCoverageComplete: pairs.length === results.length,
            slippage: { meanNetReturnPct: mean(stress.map((s) => s.r)), meanNetExcessPct: mean(stress.map((s) => s.excess)),
              excessWinRatePct: stress.length ? 100 * stress.filter((s) => s.excess > 0).length / stress.length : null,
              pairedMeanDeltaPct: mean(pairedStress) } };
        }
      }
      summaries[horizon][period.id] = byRule;
    }
    console.log(`[done] ${horizon}-session holding; split ${horizonResults.baseline_split.length}, residual ${horizonResults.baseline_residual.length} covered cohorts`);
  }
  const output = { generatedAt: new Date().toISOString(), config, inputCoverage: { sessions: calendar.length, start: calendar[0], end: calendar.at(-1), historicalCodes: panel.size, missingSourceDates: sourceMissing },
    blockedFactors: [{ factor: 'gross_profit_assets', reason: 'No complete historical total-assets / TTM gross-profit panel with verified filing timestamps and as-reported vintages. Recent income snapshots do not supply assets.' }], coverage, summaries, cohorts };
  mkdirSync('data/backtest/novel-factors', { recursive: true });
  writeFileSync('data/backtest/novel-factors/results.json', JSON.stringify(output) + '\n');
  writeResearchSnapshot(output);
  const lines = ['# 新選股因子固定規則回測（2026-10-05）', '',
    '本輪沒有足夠證據支持新增正式選股權重。這只適用於本次固定窗口與代理模型，不能宣稱整個因子家族無效。', '',
    `資料：${calendar[0]}～${calendar.at(-1)}，${panel.size}個歷史代碼、${calendar.length}個交易日；行情來源缺日${sourceMissing.length}筆。訊號起點${config.evaluationStart}。`, '',
    '收盤形成訊號，隔日開盤買進，每次等權前10檔。持有2／5／20個交易日，皆跨日；2日是隔日開盤至再隔日收盤，並非尾盤買、翌日開盤賣。每期完整換倉，買費0.1425%、賣費0.4425%，另測買賣各0.5%不利滑價。', '',
    '每個因子家族與同一資料完整母體的原始20日動能配對比較。拆解要求21日實際成交；殘差要求273日實際成交，252日迴歸窗口止於20日訊號窗口之前。殘差只是扣除大盤與截距的代理版本，未重現原論文的多因子模型與月資料規格。', '',
    '2020–2026已被專案研究看過；後段2024–2026只檢查期間穩定性，不是乾淨樣本外。規則先固定，沒有挑參數。以約60交易日時間區塊bootstrap 10,000次（2／5／20日策略分別30／12／3期），90項報酬／勝率比較做Bonferroni校正。有效期代表執行資料可評估，不等於全期；無法出場的期數列無效，不補成獲利，且不提供不完整連續年化與回撤。', '',
    '毛利／總資產：尚未回測。缺完整歷史資產、TTM毛利、公告時間與當時版本；不能以近期財報回填。', ''];
  lines.push('## 資料覆蓋與解讀', '',
    '缺日補抓31個交易日後，證交所回傳HTTP403，已停止請求。現有TWSE仍缺466日，TPEx完整；舊文件稱完整資料不代表本工作區已備齊。全期平均只使用完整窗口，可能受非隨機缺口與無效執行影響。', '',
    '| 持有日數 | 因子家族 | 計畫期數 | 完整行情已形成期 | 暖機不足 | 來源缺口排除 | 無完整候選 | 第一～最後訊號 |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const horizon of config.holdingSessions) for (const [familyId, family] of Object.entries(config.families) as [string, any][]) {
    const rows = coverage.filter((r) => r.horizon === horizon && r.family === familyId);
    const formed = rows.filter((r) => r.status === 'evaluated');
    lines.push(`| ${horizon} | ${familyId} | ${rows.length} | ${formed.length} | ${rows.filter((r) => r.status === 'insufficient_warmup').length} | ${rows.filter((r) => r.status === 'missing_source').length} | ${rows.filter((r) => r.status === 'no_complete_candidates').length} | ${formed[0]?.date ?? '—'}～${formed.at(-1)?.date ?? '—'} |`);
  }
  lines.push('', '殘差策略2024–2026沒有可評估窗口，因此不能判斷近期表現。表中各策略有效期不同，不能直接相減平均超額；「配對增益」只比較雙方可評估的同一期。勝率是組合期數勝率，不是單股交易勝率。', '');
  for (const horizon of config.holdingSessions) for (const period of ['all', '2020_2023', '2024_2026']) {
    lines.push(`## 持有${horizon}交易日：${period}`, '', '| 規則 | 有效／已形成期 | 打敗含息指數勝率 | 每期淨超額 | 同期配對增益 | 配對期數 | 90比較校正CI | 校正p | 滑價後淨超額 | 滑價後配對增益 |', '| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |');
    for (const [rule, s] of Object.entries(summaries[horizon][period]) as [string, any][]) {
      const p = s.pairedVsBaseline;
      lines.push(`| ${labels[rule]} | ${s.validCohorts}/${s.cohortCount} | ${n(s.excessWinRatePct)}% | ${n(s.meanCohortNetExcessPct)}% | ${p ? n(p.meanDeltaPct) + '%' : '基準'} | ${p?.count ?? '—'} | ${p?.familywiseCi ? p.familywiseCi.map((x: number) => n(x)).join('～') + '%' : '—'} | ${n(p?.adjustedP)} | ${n(s.slippage.meanNetExcessPct)}% | ${n(s.slippage.pairedMeanDeltaPct)}% |`);
    }
    lines.push('');
  }
  lines.push('## 規則、資料與重跑', '', '`node --import tsx scripts/backtest-novel-factors.ts`', '',
    '完整規則：[novel-factor-backtest-config.json](novel-factor-backtest-config.json)。逐期持倉、失敗進場、無效出場、完整性與勝率界限：`data/backtest/novel-factors/results.json`。', '',
    '這是獨立價格選股策略；未驗證對營收＋毛利策略的增量，也未改正式每日選股。資料要求會排除停牌或缺完整歷史的個股，兩個家族各自使用相同母體基準；上市／櫃買歷史母體包含後來下市者。', '',
    '參考：[台股日間／隔夜報酬拆解](https://doi.org/10.1016/j.pacfin.2023.102151)、[殘差動能](https://www.sciencedirect.com/science/article/pii/S0927539811000041)。');
  writeFileSync('docs/novel-factor-backtest-results.md', lines.join('\n') + '\n');
  console.log('[done] Results: docs/novel-factor-backtest-results.md and data/backtest/novel-factors/results.json');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
