/** Shared offline universe, adjustments, signals, VP eligibility and seeded control draws. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createPanel, addDayQuotes, addReferenceEvent, finalizePanel, type StockPanel } from './wide-market-panel.ts';
import { volumeProfileStop, twoYearsBefore, type Ohlcv } from './volume-profile-stop.ts';
export const COST = 0.006, SEED = 20261113;
export function sma(a: Float64Array, n: number) {
    const out = new Float64Array(a.length).fill(NaN);
    let sum = 0, count = 0;
    for (let i = 0; i < a.length; i++) {
        if (!Number.isFinite(a[i])) {
            sum = 0;
            count = 0;
            continue;
        }
        sum += a[i];
        count++;
        if (count > n)
            sum -= a[i - n];
        if (count >= n)
            out[i] = sum / n;
    }
    return out;
}
export function loadExitResearch(log: (s: string) => void = console.log) {
    const benchDates: string[] = JSON.parse(readFileSync('research/wide-market/benchmark-input.json', 'utf8')).benchmarkTotalReturn.TaiwanStockPrice.map((r: {
        date: string;
    }) => r.date).sort();
    const last = benchDates.at(-1)!;
    const calendar = [...new Set([...benchDates, ...['twse', 'tpex'].flatMap(source => readdirSync(`data/backtest/wide/daily/${source}`).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).map(f => f.slice(0, 10)))])].filter(d => d >= '2005-01-01' && d <= last).sort();
    const N = calendar.length, panel = createPanel(calendar);
    const refs = JSON.parse(readFileSync('data/backtest/wide/actions/twse-ex-references.json', 'utf8')).rows as {
        code: string;
        date: string;
        reference: number;
        kind: string;
    }[];
    const actions = new Map(refs.map(a => [`${a.date}/${a.code}`, a]));
    const missing = { twse: 0, tpex: 0 };
    for (let i = 0; i < N; i++) {
        for (const source of ['twse', 'tpex'] as const) {
            const file = `data/backtest/wide/daily/${source}/${calendar[i]}.json.gz`;
            if (!existsSync(file)) {
                missing[source]++;
                continue;
            }
            const cached = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
            addDayQuotes(panel, i, cached.rows.map((q: Record<string, any>) => {
                const a = actions.get(`${calendar[i]}/${q.code}`);
                return a ? { ...q, explicitReference: a.reference, changeLabel: a.kind } : q;
            }));
        }
        if (i % 500 === 0)
            log(`load ${calendar[i]}`);
    }
    const idx = new Map(calendar.map((d, i) => [d, i]));
    for (const a of actions.values()) {
        const i = idx.get(a.date);
        if (i !== undefined)
            addReferenceEvent(panel, i, a.code, a.reference);
    }
    finalizePanel(panel);
    log(`panel ${N} dates / ${panel.size} stocks; missing ${JSON.stringify(missing)}`);
    // Rolling windows reset after invalid observations (the original naive sum remains NaN
    // forever for listings after calendar start). No change to backtest-new-high.ts.
    interface Stock {
        s: StockPanel;
        ma: Float64Array;
        money: Float64Array;
    }
    const stocks: Stock[] = [...panel.values()].sort((a, b) => a.code.localeCompare(b.code)).map(s => ({ s, ma: sma(s.adjustedClose, 20), money: sma(s.money, 20) }));
    function eligible(x: Stock, t: number) {
        const s = x.s;
        return t >= 20 && s.seen[t] && s.seen[t - 1] && x.money[t - 1] >= 3e7 && s.close[t] >= 10 && s.adjustedClose[t] > 0 && s.segmentId[t] >= 0;
    }
    const ew = new Float64Array(N).fill(1);
    for (let t = 1; t < N; t++) {
        let sum = 0, n = 0;
        for (const x of stocks) {
            const s = x.s;
            if (!s.seen[t] || !s.seen[t - 1] || !(x.money[t - 1] >= 3e7) || s.segmentId[t] !== s.segmentId[t - 1])
                continue;
            const r = s.adjustedClose[t] / s.adjustedClose[t - 1] - 1;
            if (Number.isFinite(r) && Math.abs(r) < 0.11) {
                sum += r;
                n++;
            }
        }
        ew[t] = ew[t - 1] * (1 + (n ? sum / n : 0));
    }
    interface Signal {
        x: Stock;
        t: number;
    }
    const signals: Signal[] = [], aKeys = new Set<string>();
    for (const x of stocks) {
        const s = x.s;
        let cooldown = -1;
        for (let t = 250; t < N; t++) {
            if (t < cooldown || !eligible(x, t) || !(s.adjustedClose[t] > s.adjustedHigh[t - 1]))
                continue;
            let H = 0, h = t - 1, ok = true;
            for (let j = t - 250; j <= t; j++) {
                if (s.segmentId[j] !== s.segmentId[t] || !(s.adjustedClose[j] > 0) || !(s.adjustedHigh[j] > 0)) {
                    ok = false;
                    break;
                }
                if (j < t && s.adjustedHigh[j] > H) {
                    H = s.adjustedHigh[j];
                    h = j;
                }
            }
            if (!ok || !(s.adjustedClose[t] > H) || t - h < 20)
                continue;
            cooldown = t + 20; // Match original: even excluded limit-up signals set cooldown.
            aKeys.add(`${t}/${s.code}`);
            if (s.adjustedClose[t] / s.adjustedClose[t - 1] - 1 < 0.095)
                signals.push({ x, t });
        }
    }
    signals.sort((a, b) => a.t - b.t || a.x.s.code.localeCompare(b.x.s.code));
    const random = rng(SEED);
    const cache = new Map<string, ReturnType<typeof volumeProfileStop>>();
    const excluded = { A: 0, B: 0, noRandomCandidate: 0, unsupportedPrice: 0 };
    const exclusionDetails: {
        group: string;
        code: string;
        date: string;
        reason: string;
    }[] = [];
    function profile({ x, t }: Signal, force = false) {
        const key = `${x.s.code}/${t}`;
        if (cache.has(key) && !force)
            return cache.get(key)!;
        const s = x.s, rows: Ohlcv[] = [], from = twoYearsBefore(calendar[t]);
        for (let j = t; j >= 0 && calendar[j] >= from; j--) {
            if (!s.seen[j] || s.segmentId[j] !== s.segmentId[t])
                continue;
            const factor = s.adjustedClose[j] / s.close[j];
            rows.push({ date: calendar[j], open: s.adjustedOpen[j], max: s.adjustedHigh[j] > 0 ? s.adjustedHigh[j] : s.high[j] * factor, min: s.adjustedLow[j] > 0 ? s.adjustedLow[j] : s.low[j] * factor, close: s.adjustedClose[j], Trading_Volume: s.volume[j] });
        }
        rows.reverse();
        let p: ReturnType<typeof volumeProfileStop>;
        try {
            p = volumeProfileStop({ rows, asOf: calendar[t], reference: s.adjustedClose[t], direction: '多', code: s.code });
        }
        catch (e) {
            if (!(e instanceof Error) || !e.message.includes('分箱寬度'))
                throw e;
            excluded.unsupportedPrice++;
            p = null;
        }
        // Cache only scalar outputs: full profiles may be large. Calls are direct, no approximation.
        cache.set(key, p ? { ...p, bins: [], valleys: [], peaks: [], candidates: [] } : null);
        return p;
    }
    function qualified(g: Signal, group: 'A' | 'B') {
        const p = profile(g), { x, t } = g, s = x.s;
        if (!p || p.historyDays < 120 || p.atr14 === null) {
            excluded[group]++;
            exclusionDetails.push({ group, code: s.code, date: calendar[t], reason: !p ? 'VP reference exceeds bin-width table' : 'fewer than 120 valid days / ATR unavailable' });
            return null;
        }
        return p;
    }
    function forEachSample(run: (g: Signal, group: 'A' | 'B', pair: string) => boolean) {
        let candidates: Stock[] = [], previousT = -1;
        for (let i = 0; i < signals.length; i++) {
            const g = signals[i], pair = `${calendar[g.t]}/${g.x.s.code}`;
            if (!run(g, 'A', pair))
                continue;
            if (g.t !== previousT) {
                previousT = g.t;
                candidates = stocks.filter(x => eligible(x, g.t) && x.s.adjustedClose[g.t] / x.s.adjustedClose[g.t - 1] - 1 < .095 && !aKeys.has(`${g.t}/${x.s.code}`));
            }
            if (!candidates.length) {
                excluded.noRandomCandidate++;
                continue;
            }
            // Draw once, then apply shared-history requirement to every B method. With replacement.
            run({ x: candidates[Math.floor(random() * candidates.length)], t: g.t }, 'B', pair);
            if (i % 500 === 0)
                log(`VP ${i}/${signals.length}`);
        }
    }
    return { calendar, N, last, stocks, signals, ew, missing, excluded, exclusionDetails, profile, qualified, cache, forEachSample };
}
export function rng(seed: number) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export type ExitResearch = ReturnType<typeof loadExitResearch>;
export type Signal = ExitResearch['signals'][number];
