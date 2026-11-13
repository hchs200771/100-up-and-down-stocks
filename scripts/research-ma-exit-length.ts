/** Offline paired MA exit sensitivity. No fetch, report, publish or portfolio changes. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { writeMaExitPresentation } from './lib/ma-exit-presentation.ts';
import { loadExitResearch, sma, rng, COST, SEED, type Signal } from './lib/exit-research.ts';
const started = Date.now();
const log = (s: string) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${s}`);
const lengths = [10, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 40, 60], mainGrid = lengths.filter(n => n >= 15 && n <= 25);
const methods = ['S0', 'S2'] as const;
type Method = typeof methods[number];
const periods = ['train', 'validation', 'all'] as const;
const u = loadExitResearch(log);
interface Outcome {
    ret: number;
    hold: number;
    exit: string;
    exitDate: string;
    maWashed: boolean | null;
    missed: number | null;
    stopWashed: boolean | null;
}
interface Entry {
    id: string;
    code: string;
    date: string;
    group: string;
    pair: string;
    outcomes: Record<string, Record<string, Outcome>>;
}
const entries: Entry[] = [];
const averages = new Map<string, Map<number, Float64Array>>();
function run(g: Signal, group: 'A' | 'B', pair: string) {
    if (!u.qualified(g, group))
        return false;
    const { x, t } = g, s = x.s, price = s.adjustedClose[t];
    let mas = averages.get(s.code);
    if (!mas) {
        mas = new Map(lengths.map(n => [n, sma(s.adjustedClose, n)]));
        averages.set(s.code, mas);
    }
    const e: Entry = { id: `${group}/${pair}`, code: s.code, date: u.calendar[t], group, pair, outcomes: {} };
    for (const method of methods) {
        e.outcomes[method] = {};
        for (const n of lengths) {
            let end = t, exit = 'endOfData';
            for (let j = t + 1; j < u.N && j <= t + 120; j++) {
                if (s.segmentId[j] !== s.segmentId[t]) {
                    exit = 'segmentEnd';
                    break;
                }
                if (!s.seen[j] || !(s.adjustedClose[j] > 0))
                    continue;
                end = j;
                if (method === 'S2' && s.adjustedClose[j] < price * .9) {
                    exit = 'stop';
                    break;
                }
                if (s.adjustedClose[j] < mas.get(n)![j]) {
                    exit = 'ma';
                    break;
                }
                if (j === t + 120)
                    exit = 'max120';
            }
            let maWashed: boolean | null = null, stopWashed: boolean | null = null, missed: number | null = null;
            if (exit === 'ma' || exit === 'stop') {
                let complete = end + 20 < u.N, max = -Infinity, recovered = false;
                for (let j = end + 1; j <= Math.min(end + 20, u.N - 1); j++) {
                    if (s.segmentId[j] !== s.segmentId[t]) {
                        complete = false;
                        break;
                    }
                    if (s.seen[j] && s.adjustedClose[j] > 0) {
                        max = Math.max(max, s.adjustedClose[j]);
                        if (s.adjustedClose[j] >= price)
                            recovered = true;
                    }
                }
                if (complete) {
                    if (exit === 'stop')
                        stopWashed = recovered;
                    else {
                        maWashed = max >= s.adjustedClose[end] * 1.05;
                        if (maWashed)
                            missed = max / s.adjustedClose[end] - 1;
                    }
                }
            }
            assert(end - t >= 0 && end - t <= 120);
            assert(Number.isFinite(s.adjustedClose[end] / price));
            assert(method === 'S2' || exit !== 'stop');
            assert(maWashed === null || exit === 'ma');
            assert(stopWashed === null || exit === 'stop');
            e.outcomes[method][n] = { ret: s.adjustedClose[end] / price - 1 - COST, hold: end - t, exit, exitDate: u.calendar[end], maWashed, missed, stopWashed };
        }
    }
    entries.push(e);
    return true;
}
u.forEachSample(run);
log(`aggregate ${entries.length} entries`);
const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const pc = (v: number | null) => v === null ? null : v * 100;
function bootstrap(es: Entry[], m: Method, n: number) {
    const blocks = new Map<string, {
        sum: number;
        n: number;
    }>();
    for (const e of es) {
        const k = e.date.slice(0, 7), b = blocks.get(k) ?? { sum: 0, n: 0 };
        b.sum += e.outcomes[m][n].ret - e.outcomes[m][20].ret;
        b.n++;
        blocks.set(k, b);
    }
    const bs = [...blocks.values()], draw = rng(SEED), samples: number[] = [];
    if (!bs.length)
        return { meanDifferencePp: null, ci95Pp: [null, null], months: 0, n: 0 };
    for (let i = 0; i < 2000; i++) {
        let sum = 0, count = 0;
        for (let k = 0; k < bs.length; k++) {
            const b = bs[Math.floor(draw() * bs.length)];
            sum += b.sum;
            count += b.n;
        }
        samples.push(sum / count * 100);
    }
    samples.sort((a, b) => a - b);
    return { meanDifferencePp: bs.reduce((s, b) => s + b.sum, 0) / es.length * 100, ci95Pp: [samples[49], samples[1949]], months: bs.length, n: es.length };
}
function stats(es: Entry[], m: Method, n: number, ci = true) {
    const os = es.map(e => e.outcomes[m][n]), rs = os.map(o => o.ret).sort((a, b) => a - b), wins = rs.filter(v => v > 0), losses = rs.filter(v => v <= 0);
    const aw = mean(wins), al = mean(losses), ma = os.filter(o => o.exit === 'ma'), mw = ma.filter(o => o.maWashed !== null), st = os.filter(o => o.exit === 'stop'), sw = st.filter(o => o.stopWashed !== null);
    return { n: rs.length, avgPct: pc(mean(rs)), medianPct: rs.length ? 100 * (rs[Math.floor((rs.length - 1) / 2)] + rs[Math.floor(rs.length / 2)]) / 2 : null, winPct: rs.length ? wins.length / rs.length * 100 : null, avgWinPct: pc(aw), avgLossPct: pc(al), payoff: aw !== null && al !== null && al < 0 ? aw / -al : null, hold: mean(os.map(o => o.hold)), full120Pct: os.length ? os.filter(o => o.hold === 120).length / os.length * 100 : null, maWashRatePct: mw.length ? mw.filter(o => o.maWashed).length / mw.length * 100 : null, maWashEligible: mw.length, maWashCensored: ma.length - mw.length, missedGainPct: pc(mean(mw.filter(o => o.maWashed).map(o => o.missed!))), stopWashRatePct: sw.length ? sw.filter(o => o.stopWashed).length / sw.length * 100 : null, stopWashEligible: sw.length, stopWashCensored: st.length - sw.length, exits: Object.fromEntries([...new Set(os.map(o => o.exit))].map(k => [k, os.filter(o => o.exit === k).length])), ...(ci ? { vs20: bootstrap(es, m, n) } : {}) };
}
const inPeriod = (e: Entry, p: string) => p === 'all' || (p === 'train' ? e.date < '2016-01-01' : e.date >= '2016-01-01');
const results: Record<string, any> = {};
const selection: Record<string, any> = {}, yearly: Record<string, any> = {}, neighborhoods: Record<string, any> = {};
for (const group of ['A', 'B']) {
    const es = entries.filter(e => e.group === group);
    results[group] = {};
    selection[group] = {};
    yearly[group] = {};
    neighborhoods[group] = {};
    for (const m of methods) {
        results[group][m] = Object.fromEntries(periods.map(p => [p, Object.fromEntries(lengths.map(n => [n, stats(es.filter(e => inPeriod(e, p)), m, n)]))]));
        const rank = (p: string, ns = lengths) => [...ns].sort((a, b) => results[group][m][p][b].avgPct - results[group][m][p][a].avgPct || a - b);
        selection[group][m] = Object.fromEntries([['allGrid', lengths], ['mainGrid', mainGrid]].map(([key, ns]: [
            string,
            number[]
        ]) => { const best = rank('train', ns)[0]; return [key, { bestN: best, trainAvgPct: results[group][m].train[best].avgPct, validationRank: rank('validation', ns).indexOf(best) + 1, candidates: ns.length, validation: results[group][m].validation[best] }]; }));
        neighborhoods[group][m] = Object.fromEntries(periods.map(p => [p, Object.fromEntries(lengths.map(n => { const ns = lengths.filter(k => Math.abs(k - n) <= 2); return [n, { lengths: ns, complete: ns.length === 5, avgPct: mean(ns.map(k => results[group][m][p][k].avgPct)) }]; }))]));
        yearly[group][m] = Object.fromEntries([...new Set(es.map(e => e.date.slice(0, 4)))].sort().map(y => { const rows = es.filter(e => e.date.startsWith(y)), grid = Object.fromEntries(mainGrid.map(n => [n, stats(rows, m, n, false)])), rank = [...mainGrid].sort((a, b) => grid[b].avgPct - grid[a].avgPct || a - b); return [y, { n: rows.length, bestN: rank[0], rank20: rank.indexOf(20) + 1, grid }]; }));
    }
}
// Exact entry and N=20 reconciliation with the independently rerun predecessor.
const previous = JSON.parse(readFileSync('data/backtest/volume-profile-stop-results.json', 'utf8'));
assert.equal(entries.length, previous.entries.length);
entries.forEach((e, i) => { const old = previous.entries[i]; assert.deepEqual([e.id, e.code, e.date], [old.id, old.code, old.date]); for (const m of methods) {
    const o = e.outcomes[m][20], p = old.outcomes[m];
    assert.deepEqual([o.ret, o.hold, o.exitDate], [p.ret, p.hold, p.exitDate]);
    assert.equal(o.exit === 'ma' ? 'ma20' : o.exit, p.exit);
    assert.equal(o.stopWashed, p.washed);
} });
const OUT = 'data/backtest/ma-exit-length-results.json';
const output = { generatedAt: new Date().toISOString(), period: [u.calendar[0], u.last], entryPeriod: [entries[0]?.date, entries.at(-1)?.date], lengths, mainGrid, cost: COST, seed: SEED, bootstrapIterations: 2000, missingFiles: u.missing, excluded: u.excluded, exclusionDetails: u.exclusionDetails, reconciliation: { entries: entries.length, methods, exactN20: true }, definitions: { maWash: 'MA exits with a full 20-market-session same-segment window; any observed close >= exit close * 1.05. Incomplete windows excluded even if already washed.', missedGain: 'Mean maximum close / exit close - 1 among washed MA exits only; excludes exit day.', stopWash: 'Stop exits recovering entry close within a complete 20-session window, identical to predecessor.', neighborhood: 'Equal-weight mean of available tested N within N±2. complete=false means sparse/boundary, not a full five-length neighborhood.', selection: 'Max training mean net per-entry return; ties resolve to smaller N. Both full grid and primary 15–25 grid reported.', bootstrap: 'Entry-month blocks resampled with replacement, retaining entries and entry-count weighting; pointwise percentile CI indices 49/1949, fixed seed, 2000 repetitions.', split: 'Entry date before 2016 is training; later is validation. Holding windows may cross the split.' }, results, selection, neighborhoods, yearly, entries };
mkdirSync('data/backtest', { recursive: true });
writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');
log(`wrote ${OUT}; exact N20 reconciliation passed`);
writeMaExitPresentation(output);
log("wrote factor-lab entry, review tables and 3 SVGs");
