#!/usr/bin/env python3
"""Offline exploratory Tuesday study. Standard library only; returns are fractions.

Run: python3 -I scripts/research-tuesday-weakness.py
Only writes the two requested artifacts. No fetching, report or trading integration.
"""
import bisect
import importlib.util
import json
import math
import statistics as st
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/backtest/intraday-pattern'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('intraday_loader', ROOT / 'scripts/research-intraday-patterns.py')
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)
WEEK = ['週一', '週二', '週三', '週四', '週五']
METRICS = {'intraday': '日內', 'overnight': '隔夜', 'full': '全日'}


def mean(xs):
    return st.mean(xs) if xs else None


def correlation(xs, ys):
    # statistics.correlation is unavailable on the local Python 3.9 runtime.
    mx, my = st.mean(xs), st.mean(ys)
    dx, dy = [x - mx for x in xs], [y - my for y in ys]
    denom = math.sqrt(sum(x*x for x in dx) * sum(y*y for y in dy))
    return sum(x*y for x, y in zip(dx, dy)) / denom if denom else None


def gamma_q(a, x):
    """Regularized upper incomplete gamma: series / continued fraction."""
    if x <= 0:
        return 1.0
    logscale = a * math.log(x) - x - math.lgamma(a)
    if x < a + 1:
        term = total = 1 / a
        for i in range(1, 10000):
            term *= x / (a + i)
            total += term
            if abs(term) < abs(total) * 1e-14:
                break
        return max(0.0, min(1.0, 1 - total * math.exp(logscale)))
    b, c = x + 1 - a, 1e300
    d = 1 / b
    h = d
    for i in range(1, 10000):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        c = b + an / c
        d = 1e-300 if abs(d) < 1e-300 else d
        c = 1e-300 if abs(c) < 1e-300 else c
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-14:
            break
    return max(0.0, min(1.0, math.exp(logscale) * h))


def normal_p(z):
    return math.erfc(abs(z) / math.sqrt(2))


def inverse(matrix):
    n = len(matrix)
    a = [list(row) + [float(i == j) for j in range(n)] for i, row in enumerate(matrix)]
    for i in range(n):
        pivot = max(range(i, n), key=lambda k: abs(a[k][i]))
        if abs(a[pivot][i]) < 1e-14:
            raise ValueError('singular design')
        a[i], a[pivot] = a[pivot], a[i]
        scale = a[i][i]
        a[i] = [v / scale for v in a[i]]
        for j in range(n):
            if i != j:
                factor = a[j][i]
                a[j] = [v - factor * w for v, w in zip(a[j], a[i])]
    return [r[n:] for r in a]


def ols(rows, response, features, hac=0):
    """OLS with HC1 or Newey-West Bartlett covariance and normal Wald p-values.

    rows must be chronological for HAC. Feature scaling stabilizes inversion.
    HAC lags count adjacent available observations, not calendar days.
    """
    usable = [r for r in rows if all(r.get(k) is not None for k in [response] + features)]
    n, k = len(usable), len(features) + 1
    if n <= k + 1:
        return {'n': n, 'error': 'insufficient observations'}
    scales = [max(st.pstdev(r[f] for r in usable), 1e-12) for f in features]
    x = [[1.] + [r[f] / s for f, s in zip(features, scales)] for r in usable]
    y = [r[response] for r in usable]
    try:
        inv = inverse([[sum(v[i] * v[j] for v in x) for j in range(k)] for i in range(k)])
    except ValueError as exc:
        return {'n': n, 'error': str(exc)}
    xy = [sum(v[i] * z for v, z in zip(x, y)) for i in range(k)]
    beta = [sum(inv[i][j] * xy[j] for j in range(k)) for i in range(k)]
    residual = [z - sum(b * v for b, v in zip(beta, row)) for row, z in zip(x, y)]
    # Influence vectors: inv(X'X) x_t e_t; avoids two matrix multiplications.
    influence = [[sum(inv[i][j] * row[j] for j in range(k)) * e for i in range(k)]
                 for row, e in zip(x, residual)]
    variances = []
    for i in range(k):
        variance = sum(v[i] ** 2 for v in influence)
        for lag in range(1, min(hac, n - 1) + 1):
            variance += 2 * (1 - lag / (hac + 1)) * sum(
                influence[t][i] * influence[t - lag][i] for t in range(lag, n))
        variances.append(max(0., variance * n / (n - k)))
    terms = {}
    for f, b, v, s in zip(['intercept'] + features, beta, variances, [1.] + scales):
        coefficient, se = b / s, math.sqrt(v) / s
        p = normal_p(coefficient / se) if se else (1. if coefficient == 0 else 0.)
        terms[f] = {'coefficient': coefficient, 'se': se, 'p': p,
                    'ci95': [coefficient - 1.96 * se, coefficient + 1.96 * se]}
    y_mean = st.mean(y)
    total = sum((v - y_mean) ** 2 for v in y)
    return {'n': n, 'features': features, 'covariance': f'Newey-West({hac}), finite sample n/(n-k)' if hac else 'HC1',
            'p_reference': 'two-sided asymptotic normal', 'terms': terms,
            'r_squared': 1 - sum(e * e for e in residual) / total if total else None}


def proportion_test(a, b, key='drop'):
    n, m = len(a), len(b)
    ka, kb = sum(r[key] for r in a), sum(r[key] for r in b)
    if not n or not m:
        return {'n': n, 'reference_n': m, 'p': None}
    pooled = (ka + kb) / (n + m)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / m))
    diff = ka / n - kb / m
    ci_se = math.sqrt(ka / n * (1 - ka / n) / n + kb / m * (1 - kb / m) / m)
    return {'n': n, 'reference_n': m, 'count': ka, 'reference_count': kb,
            'rate': ka / n, 'reference_rate': kb / m, 'difference': diff,
            'ci95': [diff - 1.96 * ci_se, diff + 1.96 * ci_se],
            'p': normal_p(diff / se) if se else 1.,
            'small_expected_cell': min(n * pooled, n * (1 - pooled), m * pooled, m * (1 - pooled)) < 5}


def kruskal(groups):
    values = sorted((value, i) for i, group in enumerate(groups) for value in group)
    n = len(values)
    populated = sum(bool(g) for g in groups)
    if n < 2 or populated < 2:
        return {'n': n, 'p': None}
    ranks, tie_sum, start = [0.] * len(groups), 0., 0
    while start < n:
        end = start + 1
        while end < n and values[end][0] == values[start][0]:
            end += 1
        rank = (start + 1 + end) / 2
        for _, group in values[start:end]:
            ranks[group] += rank
        tie_sum += (end - start) ** 3 - (end - start)
        start = end
    correction = 1 - tie_sum / (n ** 3 - n)
    h = (12 / (n * (n + 1)) * sum(r * r / len(g) for r, g in zip(ranks, groups) if g) - 3 * (n + 1))
    h = max(0., h / correction) if correction else 0.
    return {'n': n, 'statistic': h, 'df': populated - 1, 'p': gamma_q((populated - 1) / 2, h / 2)}


def brief(rows):
    n = len(rows)
    return {'n': n, 'drop_count': sum(r['drop'] for r in rows), 'drop_rate': mean([r['drop'] for r in rows]),
            **{f'mean_{k}': mean([r[k] for r in rows]) for k in METRICS}}


def comparison(a, b):
    rows = [dict(r, group=1.) for r in a] + [dict(r, group=0.) for r in b]
    return {'target': brief(a), 'reference': brief(b), 'drop_test': proportion_test(a, b),
            'mean_tests': {key: ols(rows, key, ['group']) for key in METRICS}}


def weekdays(rows):
    groups = [[r for r in rows if r['weekday'] == i] for i in range(5)]
    rows = [r for r in rows if r['weekday'] < 5]
    n, drops = len(rows), sum(r['drop'] for r in rows)
    statistic, expected = 0., []
    for g in groups:
        for observed, probability in [(sum(r['drop'] for r in g), drops / n if n else 0),
                                      (sum(not r['drop'] for r in g), 1 - drops / n if n else 0)]:
            exp = len(g) * probability
            expected.append(exp)
            if exp:
                statistic += (observed - exp) ** 2 / exp
    tue = comparison(groups[1], [r for r in rows if r['weekday'] != 1])
    tue['drop_test']['p_bonferroni5'] = adjust(tue['drop_test']['p'])
    for result in tue['mean_tests'].values():
        if 'terms' in result:
            result['terms']['group']['p_bonferroni5'] = adjust(result['terms']['group']['p'])
    return {'n': n, 'by_weekday': [dict(weekday=WEEK[i], **brief(g)) for i, g in enumerate(groups)],
            'omnibus': {'drop': {'statistic': statistic, 'df': 4, 'n': n,
                                  'p': gamma_q(2, statistic / 2) if n else None,
                                  'small_expected_cell': any(e < 5 for e in expected)},
                        **{key: kruskal([[r[key] for r in g] for g in groups]) for key in METRICS}},
            'tuesday_vs_other_weekdays': tue}


def adjust(p):
    return min(1., 5 * p) if p is not None else None


def enrich(r, opening=None):
    o = r['open'] if opening is None else opening
    return dict(r, open=o, intraday=r['close'] / o - 1, overnight=o / r['prev'] - 1,
                full=r['close'] / r['prev'] - 1, drop=r['close'] <= o * .995,
                tuesday=float(r['weekday'] == 1))


def load_us(symbol):
    raw = json.loads((CACHE / f'us-{symbol}.json').read_text())['data']
    valid, rejected = {}, []
    for r in raw:
        try:
            d = date.fromisoformat(r['date'])
            adj, close = loader.number(r['Adj_Close']), loader.number(r['Close'])
            if d in valid:
                raise ValueError('duplicate date')
            valid[d] = (adj, close)
        except (KeyError, TypeError, ValueError) as exc:
            rejected.append({'date': r.get('date'), 'reason': str(exc)})
    result = []
    # Do not bridge an explicitly rejected source row.
    calendar = sorted({date.fromisoformat(r['date']) for r in raw})
    for prev, d in zip(calendar, calendar[1:]):
        if prev in valid and d in valid:
            result.append({'date': d.isoformat(), 'weekday': d.weekday(),
                           'return': valid[d][0] / valid[prev][0] - 1,
                           'raw_close_return': valid[d][1] / valid[prev][1] - 1})
    return result, rejected


def gap_label(value):
    return 0 if value < -.005 else 1 if value < 0 else 2 if value <= .005 else 3


def term(result, name):
    return result.get('terms', {}).get(name, {})


def run():
    daily, daily_bad = loader.load_daily('taiex', 2000)
    tpex, tpex_bad = loader.load_daily('tpex', 2000)
    print('載入本機日K與5秒資料…', flush=True)
    sessions, intraday_meta = loader.load_intraday(daily)
    lookup = {r['date']: r for r in daily}
    sets = {}
    for label, seconds in [('09:00:30', 32430), ('09:01', 32460), ('09:05', 32700)]:
        rows = []
        for session in sessions:
            base = lookup[session['date']]
            if base['prev'] and base['weekday'] < 5:
                opening = loader.opening_quote(session['points'], seconds)
                rows.append(enrich(dict(base, close=session['close']), opening))
        sets[label] = rows
    rows = sets['09:01']
    if not rows:
        raise ValueError('no complete weekday intraday sessions available')
    print(f'完成載入 {len(rows)} 個盤中交易日；檢驗星期與年度差異…', flush=True)
    years = sorted({r['date'][:4] for r in rows})
    datasets = {f'加權5秒開盤 {label}': sample for label, sample in sets.items()}
    datasets['加權日K 2000–2020（舊開盤）'] = [enrich(r) for r in daily if r['prev'] and r['date'] < '2021' and r['weekday'] < 5]
    datasets['櫃買日K 2005–2020（舊開盤）'] = [enrich(r) for r in tpex if r['prev'] and r['date'] < '2021' and r['weekday'] < 5]
    datasets['櫃買日K 2021–至今'] = [enrich(r) for r in tpex if r['prev'] and r['date'] >= '2021' and r['weekday'] < 5]
    existence = {}
    for name, sample in datasets.items():
        existence[name] = {'all': weekdays(sample), 'yearly': {y: weekdays([r for r in sample if r['date'][:4] == y])
                                                             for y in sorted({r['date'][:4] for r in sample})}}
    trim = {}
    for label, sample in sets.items():
        ordered = sorted(sample, key=lambda r: (r['intraday'], r['date']))
        cut = math.ceil(len(sample) * .05)
        removed = ordered[:cut]
        trim[label] = {'removed_n': cut, 'cutoff_intraday': removed[-1]['intraday'],
                       'removed_by_weekday': dict(Counter(WEEK[r['weekday']] for r in removed)),
                       'removed_dates': [r['date'] for r in removed],
                       'remaining': weekdays(sorted(ordered[cut:], key=lambda r: r['date']))}
    print(f'有效5秒交易日 {len(rows)}；計算美股、結算、路徑與期貨檢驗…', flush=True)
    us_sources, us_meta = {}, {}
    for symbol in ('SPY', 'QQQ', 'SOXX'):
        source, rejected = load_us(symbol)
        us_sources[symbol] = source
        us_meta[symbol] = {'n': len(source), 'first': source[0]['date'], 'last': source[-1]['date'], 'rejected': rejected}
        dates = [r['date'] for r in source]
        for r in rows:
            i = bisect.bisect_left(dates, r['date']) - 1
            if i >= 0:
                match = source[i]
                r[symbol] = match['return']
                r[symbol + '_date'] = match['date']
                r[symbol + '_age_days'] = (date.fromisoformat(r['date']) - date.fromisoformat(match['date'])).days
                r[symbol + '_weekday'] = match['weekday']
    gap_groups = []
    for i, label in enumerate(['<−0.5%', '−0.5%≤跳空<0', '0≤跳空≤0.5%', '>0.5%']):
        sample = [r for r in rows if gap_label(r['overnight']) == i]
        gap_groups.append({'label': label, **weekdays(sample)})
    models = {}
    for label, features in [('未控制', ['tuesday']), ('跳空', ['overnight', 'tuesday']),
                             *[(s, ['overnight', s, 'tuesday']) for s in us_sources],
                             ('三檔共同', ['overnight', 'SPY', 'QQQ', 'SOXX', 'tuesday'])]:
        models[label] = ols(rows, 'intraday', features, hac=5)
    for r in rows:
        for y in years[1:]:
            r['year_' + y] = float(r['date'].startswith(y))
    models['三檔共同＋年固定效果'] = ols(rows, 'intraday', ['overnight', 'SPY', 'QQQ', 'SOXX', 'tuesday'] + ['year_' + y for y in years[1:]], hac=5)
    event_models = {}
    for label in ['未控制', '三檔共同', '三檔共同＋年固定效果']:
        model = ols(rows, 'drop', models[label]['features'], hac=5)
        if 'terms' in model:
            model['terms']['tuesday']['p_bonferroni5'] = adjust(model['terms']['tuesday']['p'])
        event_models[label] = model
    monday = {}
    for symbol, source in us_sources.items():
        period = [dict(r, monday=float(r['weekday'] == 0)) for r in source if rows[0]['date'] <= r['date'] <= rows[-1]['date'] and r['weekday'] < 5]
        groups = [[r for r in period if r['weekday'] == i] for i in range(5)]
        effect = ols(period, 'return', ['monday'], hac=5)
        monday[symbol] = {'by_weekday': [{'weekday': WEEK[i], 'n': len(g), 'mean_return': mean([r['return'] for r in g])} for i, g in enumerate(groups)],
                          'omnibus': kruskal([[r['return'] for r in g] for g in groups]), 'monday_vs_others': effect}
    transmission = {}
    for symbol in us_sources:
        matched = [r for r in rows if symbol in r]
        strong = [dict(r, fade=r['intraday'] < 0) for r in matched if r[symbol] > .01 and r['overnight'] > 0]
        tue, other = [r for r in strong if r['weekday'] == 1], [r for r in strong if r['weekday'] != 1]
        interaction_rows = [dict(r, us_x_tuesday=r[symbol] * r['tuesday']) for r in matched]
        transmission[symbol] = {'strong_us_threshold': .01, 'positive_tw_gap': True,
                                'comparison': comparison(tue, other), 'fade_test': proportion_test(tue, other, 'fade'),
                                'interaction_model': ols(interaction_rows, 'intraday', ['overnight', symbol, 'tuesday', 'us_x_tuesday'], hac=5),
                                'tuesday_us_monday_n': sum(r[symbol + '_weekday'] == 0 for r in matched if r['weekday'] == 1),
                                'tuesday_n': sum(r['weekday'] == 1 for r in matched),
                                'max_match_age_days': max(r[symbol + '_age_days'] for r in matched)}
    monday_only = [r for r in rows if r['weekday'] != 1 or r.get('SPY_weekday') == 0]
    models['週二限前夜確為美股週一'] = ols(monday_only, 'intraday', ['overnight', 'SPY', 'QQQ', 'SOXX', 'tuesday'], hac=5)
    trading_dates = {r['date'] for r in daily}
    tuesdays = [r for r in rows if r['weekday'] == 1]
    for r in tuesdays:
        next_day = date.fromisoformat(r['date']) + timedelta(days=1)
        r['nominal_monthly_eve'] = 15 <= next_day.day <= 21
        r['next_wednesday_open'] = next_day.isoformat() in trading_dates
    monthly = [r for r in tuesdays if r['nominal_monthly_eve']]
    ordinary = [r for r in tuesdays if not r['nominal_monthly_eve']]
    settlement = {'monthly_vs_other_tuesdays': comparison(monthly, ordinary),
                  'yearly': {y: comparison([r for r in monthly if r['date'][:4] == y], [r for r in ordinary if r['date'][:4] == y]) for y in years},
                  'next_wednesday_open_vs_closed': comparison([r for r in tuesdays if r['next_wednesday_open']], [r for r in tuesdays if not r['next_wednesday_open']]),
                  'nominal_monthly_dates': [r['date'] for r in monthly],
                  'friday_expiry_status': '不可判斷：本機無契約到期日、上市日或實際結算資料；2025年後週四僅為星期代理，不標成週五到期前日。',
                  'post2025_thursday_proxy': weekdays([r for r in rows if r['date'] >= '2025-01-01'])}
    segments, path_skipped = {}, []
    row_lookup = {r['date']: r for r in rows}
    for session in sessions:
        r = row_lookup.get(session['date'])
        if not r:
            continue
        times = [32460, 36000, 43200, 48600]
        if any(t not in session['points'] for t in times):
            path_skipped.append(session['date'])
            continue
        values = [session['points'][t] for t in times]
        segments[r['date']] = dict(r, **{f'segment_{i}': values[i+1] / values[i] - 1 for i in range(3)})
    path = []
    path_rows = list(segments.values())
    for i, label in enumerate(['09:01–10:00', '10:00–12:00', '12:00–13:30']):
        key = f'segment_{i}'
        result = ols(path_rows, key, ['tuesday'], hac=5)
        if 'terms' in result:
            result['terms']['tuesday']['p_bonferroni3'] = min(1., 3 * result['terms']['tuesday']['p'])
        path.append({'label': label, 'by_weekday': [{'weekday': WEEK[w], 'n': sum(r['weekday'] == w for r in path_rows),
                                                    'mean_return': mean([r[key] for r in path_rows if r['weekday'] == w])} for w in range(5)],
                     'tuesday_vs_other': result, 'kw': kruskal([[r[key] for r in path_rows if r['weekday'] == w] for w in range(5)])})
    tx_raw = json.loads((ROOT / 'data/backtest/taiex/tx-institutional.json').read_text())['data']
    tx = {}
    for r in tx_raw:
        if r['futures_id'] == 'TX' and r['institutional_investors'] == '外資':
            d = r['date']
            if d in tx:
                raise ValueError(f'duplicate TX foreign row: {d}')
            tx[d] = {'net_oi': float(r['long_open_interest_balance_volume']) - float(r['short_open_interest_balance_volume']),
                     'net_deal': float(r['long_deal_volume']) - float(r['short_deal_volume'])}
    tx_dates = sorted(tx)
    daily_previous = {r['date']: daily[i-1]['date'] for i, r in enumerate(daily) if i}
    missing_prior = []
    for prev, d in zip(tx_dates, tx_dates[1:]):
        # Never treat changes across a missing stock-market session as daily changes.
        if daily_previous.get(d) == prev:
            tx[d]['oi_change'] = tx[d]['net_oi'] - tx[prev]['net_oi']
        elif d in lookup:
            missing_prior.append(d)
    tx_rows = [dict(r, **tx[r['date']]) for r in rows if r['date'] in tx and 'oi_change' in tx[r['date']]]
    oi_model = ols(tx_rows, 'oi_change', ['tuesday'], hac=5)
    correlations = {}
    for name, sample in [('全部', tx_rows), ('週二', [r for r in tx_rows if r['weekday'] == 1]), ('其他日', [r for r in tx_rows if r['weekday'] != 1])]:
        xs, ys = [r['oi_change'] for r in sample], [r['intraday'] for r in sample]
        pearson = correlation(xs, ys) if len(sample) > 2 else None
        correlations[name] = {'n': len(sample), 'pearson_r': pearson,
                              'slope_test': ols(sample, 'intraday', ['oi_change'], hac=5)}
    futures = {'first_source': tx_dates[0], 'last_source': tx_dates[-1], 'n': len(tx_rows),
               'missing_prior_sessions': missing_prior,
               'by_weekday': [{'weekday': WEEK[w], 'n': sum(r['weekday'] == w for r in tx_rows),
                               'mean_oi_change': mean([r['oi_change'] for r in tx_rows if r['weekday'] == w]),
                               'mean_net_deal': mean([r['net_deal'] for r in tx_rows if r['weekday'] == w])} for w in range(5)],
               'tuesday_oi_change_test': oi_model,
               'omnibus_oi_change': kruskal([[r['oi_change'] for r in tx_rows if r['weekday'] == w] for w in range(5)]),
               'correlations': correlations,
               'controlled_model': ols([dict(r, oi_per_1000=r['oi_change'] / 1000) for r in tx_rows], 'intraday',
                                       ['overnight', 'SPY', 'QQQ', 'SOXX', 'oi_per_1000', 'tuesday'], hac=5)}
    exploratory = {}
    for label, predicate in [('2021–2023', lambda r: r['date'] < '2024'), ('2024–至今', lambda r: r['date'] >= '2024'),
                             ('週二前一日台股有開盤', lambda r: r['weekday'] != 1 or (date.fromisoformat(r['date']) - timedelta(days=1)).isoformat() in trading_dates)]:
        exploratory[label] = weekdays([r for r in rows if predicate(r)])
    out = {'method': {'returns_unit': 'fraction', 'primary_open': '09:01', 'drop_definition': 'close <= open * 0.995',
                       'comparison': 'Tuesday vs all other Monday–Friday sessions (not next-day-gap=1 ordinary days)',
                       'bonferroni': 'min(1, p*5) within each metric/sample for selected weekday; not global study-wide correction',
                       'tests': '5x2 Pearson chi-square; tie-corrected Kruskal-Wallis; pooled two-proportion z; OLS HC1 or Newey-West(5) asymptotic normal',
                       'us_alignment': 'strictly last available US date < TW date; adjusted close/previous adjusted close - 1',
                       'settlement': 'nominal third-Wednesday eve; no actual expiry/holiday adjustment data'},
           'data_quality': {'first_intraday': rows[0]['date'], 'last_intraday': rows[-1]['date'],
                            'intraday': intraday_meta, 'daily_rejected': daily_bad, 'tpex_rejected': tpex_bad,
                            'excluded_non_weekdays_daily': sum(r['weekday'] > 4 for r in daily),
                            'tpex_first': tpex[0]['date'], 'us': us_meta, 'path_skipped': path_skipped},
           'existence': existence, 'trim_bottom_5pct': trim,
           'us_gap': {'gap_groups': gap_groups, 'regressions': models, 'event_lpm': event_models,
                      'us_monday': monday, 'strong_us': transmission,
                      'matches': [{'date': r['date'], **{k: v for k, v in r.items() if k.endswith('_date') or k.endswith('_age_days')}} for r in rows]},
           'settlement': settlement, 'intraday_path': path, 'foreign_futures': futures, 'exploratory': exploratory}
    return out


def pct(x):
    return '—' if x is None else f'{100*x:.3f}%'


def pp(x):
    return '—' if x is None else f'{100*x:+.3f}百分點'


def pv(x):
    return '—' if x is None else ('<0.000001' if x < .000001 else f'{x:.4f}')


def fmt(x):
    return '—' if x is None else f'{x:,.2f}'


def significance(p):
    return '無法檢定' if p is None else '名目顯著' if p < .05 else '未顯著'


def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] +
                     ['| ' + ' | '.join(map(str, r)) + ' |' for r in rows])


def weekday_table(result):
    return table(['星期', 'n', '跌≥0.5%次數／率', '平均日內', '平均隔夜', '平均全日'],
                 [[r['weekday'], r['n'], f"{r['drop_count']}／{pct(r['drop_rate'])}", *[pct(r['mean_' + k]) for k in METRICS]] for r in result['by_weekday']])


def tests_table(result):
    test = result['tuesday_vs_other_weekdays']
    rows = [['跌≥0.5%率', f"{test['target']['n']}／{test['reference']['n']}", pp(test['drop_test'].get('difference')),
             pv(result['omnibus']['drop']['p']), pv(test['drop_test']['p']), pv(test['drop_test']['p_bonferroni5'])]]
    for key, label in METRICS.items():
        t = term(test['mean_tests'][key], 'group')
        rows.append([label, f"{test['target']['n']}／{test['reference']['n']}", pp(t.get('coefficient')),
                     pv(result['omnibus'][key]['p']), pv(t.get('p')), pv(t.get('p_bonferroni5'))])
    return table(['指標', 'n週二／其他', '週二−其他', '五星期整體p', '週二p', '週二p×5'], rows)


def comparison_row(label, c):
    t = term(c['mean_tests']['intraday'], 'group')
    return [label, f"{c['target']['n']}／{c['reference']['n']}", pct(c['target']['drop_rate']), pct(c['reference']['drop_rate']),
            pv(c['drop_test']['p']), pct(c['target']['mean_intraday']), pct(c['reference']['mean_intraday']), pv(t.get('p'))]


def render(out):
    existence = out['existence']
    primary = existence['加權5秒開盤 09:01']['all']
    comp = primary['tuesday_vs_other_weekdays']
    raw_p = comp['drop_test']['p']
    corrected_p = comp['drop_test']['p_bonferroni5']
    base = term(out['us_gap']['regressions']['未控制'], 'tuesday')
    controlled = term(out['us_gap']['regressions']['三檔共同＋年固定效果'], 'tuesday')
    trim_test = out['trim_bottom_5pct']['09:01']['remaining']['tuesday_vs_other_weekdays']['drop_test']
    yearly = existence['加權5秒開盤 09:01']['yearly']
    weaker = sum(r['tuesday_vs_other_weekdays']['target']['mean_intraday'] < r['tuesday_vs_other_weekdays']['reference']['mean_intraday'] for r in yearly.values())
    rate_weaker = sum(r['tuesday_vs_other_weekdays']['drop_test']['difference'] > 0 for r in yearly.values())
    monthly = out['settlement']['monthly_vs_other_tuesdays']
    monthly_term = term(monthly['mean_tests']['intraday'], 'group')
    foreign = term(out['foreign_futures']['tuesday_oi_change_test'], 'tuesday')
    morning = term(out['intraday_path'][0]['tuesday_vs_other'], 'tuesday')
    spy_strong = out['us_gap']['strong_us']['SPY']['comparison']
    spy_strong_term = term(spy_strong['mean_tests']['intraday'], 'group')
    conclusion = ('只達名目顯著，×5後未達0.05' if raw_p < .05 <= corrected_p else
                  '通過本次星期內×5校正' if corrected_p < .05 else '本次樣本未達名目0.05顯著')
    lines = ['# 週二弱勢查證（離線研究）', '', '## 結論', '',
             f"以09:01為主，週二收盤低於開盤至少0.5%的比例為{pct(comp['target']['drop_rate'])}，其他星期{pct(comp['reference']['drop_rate'])}，"
             f"n={comp['target']['n']}／{comp['reference']['n']}，p={pv(raw_p)}、Bonferroni×5後p={pv(corrected_p)}，{conclusion}。"
             f"{len(yearly)}個年度中，週二平均日內報酬較其他日低的有{weaker}年，收低率較高的有{rate_weaker}年；"
             f"去掉全體最差5%日內交易日後，收低率差為{pp(trim_test.get('difference'))}、p×5={pv(trim_test['p_bonferroni5'])}。"
             '這是事後追查，未有獨立樣本外驗證，不能宣稱已確認穩健且可交易的星期效應。', '',
             f"解釋的優先次序是：先保留多重比較與抽樣波動的可能（目前不能確認穩健效應）；若找機制線索，依序為SPY大漲後的台股開高環境、早盤回落。"
             f"前夜SPY>+1%且台股開高時，週二日內較其他日低{pp(spy_strong_term.get('coefficient'))}，"
             f"n={spy_strong['target']['n']}／{spy_strong['reference']['n']}、p={pv(spy_strong_term.get('p'))}，"
             f"但完整樣本SPY×週二互動p={pv(term(out['us_gap']['strong_us']['SPY']['interaction_model'], 'us_x_tuesday').get('p'))}，"
             '故只算事後分組線索。'
             f"09:01–10:00週二比其他日低{pp(morning.get('coefficient'))}，p={pv(morning.get('p'))}，"
             f"三時段校正後p={pv(morning.get('p_bonferroni3'))}，僅定位到早盤。月結算與外資偏空的解釋優先度更低。這是證據排序，不是已辨識的因果排名。", '',
             f"各機制的直接檢驗：（1）跳空與美股傳導：控制三檔美股、跳空與年度後，週二係數{pp(controlled.get('coefficient'))}"
             f"（HAC p={pv(controlled.get('p'))}；未控制{pp(base.get('coefficient'))}、p={pv(base.get('p'))}），"
             + ('控制後仍顯著，這組因素無法完整解釋週二差異。' if controlled.get('p', 1) < .05 else
                '控制前後均不顯著，且係數幅度接近，未支持這組控制項能解釋明確的週二均值效應。' if base.get('p', 1) >= .05 else
                '控制後未顯著，但不能把顯著性消失當作因果證據。')
             + f"（2）月結算前週二相對其他週二差{pp(monthly_term.get('coefficient'))}、p={pv(monthly_term.get('p'))}，"
             + ('存在名目差異，但仍不能識別結算因果。' if monthly_term.get('p', 1) < .05 else '未支持月結算前特別弱。')
             + f"（3）外資OI變化的週二差為{fmt(foreign.get('coefficient'))}口、p={pv(foreign.get('p'))}，"
             + ('有名目差異，僅為同期關聯。' if foreign.get('p', 1) < .05 else '未支持週二外資期貨特別偏空。')
             + '以上是「未支持」，不等於證明排除；每週三結算與週二完全重疊，無法排除或確認一般週結算機制。', '',
             '## 資料與檢定定義', '',
             f"- 本機5秒完整交易日：{out['data_quality']['first_intraday']}～{out['data_quality']['last_intraday']}，n={primary['n']}。"
             f"掃描{out['data_quality']['intraday']['files_at_start']}檔，略過{len(out['data_quality']['intraday']['skipped'])}檔；細節與日期保留JSON。",
             '- 沿用既有載入函式：丟棄09:00昨收；連續盤5秒格覆蓋≥99%，且有09:00:05、13:25、13:30。開盤取指定時刻以前最新有效值；收盤用13:30。',
             f"- 5秒與日K收盤最大絕對差：{pct(out['data_quality']['intraday']['max_abs_close_daily_difference'])}。隔夜以日K昨收為分母。",
             '- 09:01為主版本，09:00:30與09:05為輔助敏感度。',
             '- 日內=收盤/開盤−1；隔夜=開盤/前一台股交易日收盤−1；全日=收盤/昨收−1。收低事件=日內≤−0.5%。',
             '- 其他日指其餘週一至週五，與原研究「距下一交易日1日」的一般日定義不同；週六交易日排除。',
             '- 五星期整體：事件率用5×2 Pearson卡方(df=4)；連續報酬用有ties校正的Kruskal–Wallis，檢驗分布而非專門檢驗平均數。',
             '- 週二對其他日：事件率用合併比例雙尾z檢定；平均差用OLS二元變數、HC1標準誤，雙尾常態近似p。主迴歸、盤中與期貨用Newey–West(5)及n/(n−k)修正；p為漸近值。',
             '- Bonferroni×5只校正每個樣本／每個指標中挑星期的5次比較，未涵蓋前次研究與本次所有年份、開盤版本、假說、分組。其餘表p為未校正探索性p；小樣本及稀少事件須保守解讀。',
             '- JSON含樣本數、檢定統計量、迴歸標準誤與95%信賴區間；比例差CI為未校正Wald區間。沒有網路請求。', '',
             '## 0. 是否真的存在', '']
    for name, result in existence.items():
        lines += ['### ' + name, '', weekday_table(result['all']), '', tests_table(result['all']), '']
        if '舊開盤' in name:
            lines += ['日K的open包含早期指數成分股尚未全部成交等開盤計算偏誤，不宜直接與09:01代理開盤拼接。', '']
        if name.startswith('櫃買'):
            lines += ['僅有日K，沒有櫃買5秒開盤可交叉驗證；本機最早2005年，無法檢驗2000–2004。', '']
        lines += ['逐年（完整五星期的日內／隔夜／全日平均、事件率與各項p在JSON）：', '',
                  table(['年', 'n週二／其他', '收低率週二／其他', '週二−其他日內', '日內p×5', '收低率p×5', '五星期收低率p'],
                        [[y, f"{r['tuesday_vs_other_weekdays']['target']['n']}／{r['tuesday_vs_other_weekdays']['reference']['n']}",
                          f"{pct(r['tuesday_vs_other_weekdays']['target']['drop_rate'])}／{pct(r['tuesday_vs_other_weekdays']['reference']['drop_rate'])}",
                          pp(term(r['tuesday_vs_other_weekdays']['mean_tests']['intraday'], 'group').get('coefficient')),
                          pv(term(r['tuesday_vs_other_weekdays']['mean_tests']['intraday'], 'group').get('p_bonferroni5')),
                          pv(r['tuesday_vs_other_weekdays']['drop_test']['p_bonferroni5']), pv(r['omnibus']['drop']['p'])]
                         for y, r in result['yearly'].items()]), '']
    lines += ['### 刪除全體日內最差5%（非逐星期各刪5%）', '',
              table(['開盤', '刪除n', '刪除門檻', '剩餘n週二／其他', '剩餘收低率週二／其他', '差', 'p', 'p×5'],
                    [[label, r['removed_n'], pct(r['cutoff_intraday']),
                      f"{r['remaining']['tuesday_vs_other_weekdays']['target']['n']}／{r['remaining']['tuesday_vs_other_weekdays']['reference']['n']}",
                      f"{pct(r['remaining']['tuesday_vs_other_weekdays']['target']['drop_rate'])}／{pct(r['remaining']['tuesday_vs_other_weekdays']['reference']['drop_rate'])}",
                      pp(r['remaining']['tuesday_vs_other_weekdays']['drop_test'].get('difference')),
                      pv(r['remaining']['tuesday_vs_other_weekdays']['drop_test']['p']),
                      pv(r['remaining']['tuesday_vs_other_weekdays']['drop_test']['p_bonferroni5'])] for label, r in out['trim_bottom_5pct'].items()]), '',
              '刪尾是對結果變數作條件篩選，只能檢查是否由少數極端日支撐，不能證明效應可交易。JSON另保留刪除日期及按星期數量。', '',
              '## 1. 美股週一傳導與跳空回補', '',
              '台股T日只對齊嚴格早於T的最近美股交易日；美股報酬採Adj_Close對前一交易日Adj_Close（避免拆股／配息跳動）。美股週一休市的週二會對到週五，不硬配週一。美股資料即使有台股樣本結束後紀錄也不使用。', '',
              table(['美股', '週二樣本', '前夜實為美股週一n', '全部對齊最大相隔日數'],
                    [[s, r['tuesday_n'], r['tuesday_us_monday_n'], r['max_match_age_days']] for s, r in out['us_gap']['strong_us'].items()]), '']
    for result in out['us_gap']['gap_groups']:
        lines += ['### 跳空 ' + result['label'], '', weekday_table(result), '', tests_table(result), '']
    lines += ['### 日內報酬迴歸：週二係數', '',
              table(['控制項', 'n', '週二係數', '95%CI', 'HAC p', 'R²'],
                    [[name, r['n'], pp(term(r, 'tuesday').get('coefficient')),
                      '～'.join(pp(v) for v in term(r, 'tuesday').get('ci95', [])),
                      pv(term(r, 'tuesday').get('p')), fmt(r.get('r_squared'))] for name, r in out['us_gap']['regressions'].items()]), '',
              '係數單位為報酬百分點；三檔同時控制可能共線。控制項本身可能是傳導媒介，係數衰減或p跨0.05都不等於因果解釋。年固定效果以第一年為基準。', '',
              '另用線性機率模型（事件指標0/1）直接檢查收低率，避免把均值迴歸當成尾端事件的解釋。係數是條件機率差，模型不保證預測落在0～1；使用HAC(5)：', '',
              table(['控制項', 'n', '週二事件率係數', 'HAC p', 'p×5'],
                    [[name, r['n'], pp(term(r, 'tuesday').get('coefficient')),
                      pv(term(r, 'tuesday').get('p')), pv(term(r, 'tuesday').get('p_bonferroni5'))]
                     for name, r in out['us_gap']['event_lpm'].items()]), '',
              '### 美股自身Monday effect（與台股主樣本相同日期範圍）', '',
              table(['標的', '星期', 'n', '平均調整收盤報酬'],
                    [[s, g['weekday'], g['n'], pct(g['mean_return'])] for s, r in out['us_gap']['us_monday'].items() for g in r['by_weekday']]), '',
              table(['標的', 'n', '週一−其他日', 'HAC p', '五星期KW p'],
                    [[s, r['monday_vs_others']['n'], pp(term(r['monday_vs_others'], 'monday').get('coefficient')),
                      pv(term(r['monday_vs_others'], 'monday').get('p')), pv(r['omnibus']['p'])] for s, r in out['us_gap']['us_monday'].items()]), '',
              'Monday effect判讀：' + '；'.join(s + ('達名目0.05顯著' if term(r['monday_vs_others'], 'monday').get('p', 1) < .05 else '未達0.05顯著')
                                           for s, r in out['us_gap']['us_monday'].items()) + '。', '',
              '### 美股前夜>+1%且台股跳空>0：週二是否特別開高走低', '',
              table(['美股', 'n週二／其他', '跌≥0.5%週二', '其他', '比例p', '日內週二', '其他', '平均差p'],
                    [comparison_row(s, r['comparison']) for s, r in out['us_gap']['strong_us'].items()]), '',
              table(['美股', 'n週二／其他', '開高走低率週二／其他', '比例p', '前夜報酬×週二係數', 'HAC互動p'],
                    [[s, f"{r['fade_test']['n']}／{r['fade_test']['reference_n']}",
                      f"{pct(r['fade_test'].get('rate'))}／{pct(r['fade_test'].get('reference_rate'))}", pv(r['fade_test']['p']),
                      fmt(term(r['interaction_model'], 'us_x_tuesday').get('coefficient')),
                      pv(term(r['interaction_model'], 'us_x_tuesday').get('p'))] for s, r in out['us_gap']['strong_us'].items()]), '',
              '開高走低定義為台股日內<0；互動迴歸用全體可對齊交易日，控制跳空、該美股報酬及週二。互動係數為無量綱斜率差；分組門檻屬事後選定。', '',
              '各標的判讀：' + '；'.join(
                  s + '大漲分組日內平均差' + significance(term(r['comparison']['mean_tests']['intraday'], 'group').get('p'))
                  + '、跌≥0.5%率' + significance(r['comparison']['drop_test']['p'])
                  + '、開高走低率' + significance(r['fade_test']['p'])
                  + '、全樣本線性互動' + significance(term(r['interaction_model'], 'us_x_tuesday').get('p'))
                  for s, r in out['us_gap']['strong_us'].items()) + '。不能把單一事後門檻的結果當作已證實的傳導機制。', '',
              '## 2. 選擇權週結算', '',
              '每週三名義結算與「前一天週二」完全共線，因此無法用星期資料獨立檢驗一般週結算。下表只檢驗第三個週三前的週二（月結算代理）與其他週二。未讀取實際契約與假日順延表，不能標成已確認結算日。', '',
              table(['比較', 'n目標／參考', '收低率目標', '參考', '比例p', '日內目標', '參考', '平均差p'],
                    [comparison_row('月結算前／其他週二', monthly),
                     comparison_row('下一週三開市／休市', out['settlement']['next_wednesday_open_vs_closed'])] +
                    [comparison_row(y + '月結算前／其他週二', r) for y, r in out['settlement']['yearly'].items()]), '',
              out['settlement']['friday_expiry_status'], '',
              '2025年後各星期代理描述（不視為實際到期日的檢驗）：', '',
              weekday_table(out['settlement']['post2025_thursday_proxy']), '', tests_table(out['settlement']['post2025_thursday_proxy']), '',
              '## 3. 盤中路徑', '',
              f"只用09:01、10:00、12:00、13:30精確時點；額外略過{len(out['data_quality']['path_skipped'])}日。分段算術報酬相乘才等於全段，平均數不能直接相加。", '',
              table(['區段', '星期', 'n', '平均區段報酬'],
                    [[r['label'], g['weekday'], g['n'], pct(g['mean_return'])] for r in out['intraday_path'] for g in r['by_weekday']]), '',
              table(['區段', 'n', '週二−其他日', 'HAC p', '三時段p×3', '五星期KW p'],
                    [[r['label'], r['tuesday_vs_other']['n'], pp(term(r['tuesday_vs_other'], 'tuesday').get('coefficient')),
                      pv(term(r['tuesday_vs_other'], 'tuesday').get('p')),
                      pv(term(r['tuesday_vs_other'], 'tuesday').get('p_bonferroni3')), pv(r['kw']['p'])] for r in out['intraday_path']]), '',
              '路徑只定位差異出現時段，不能由時段直接推斷賣方身分或結算因果。', '',
              '## 4. 外資台指期', '',
              f"來源範圍{out['foreign_futures']['first_source']}～{out['foreign_futures']['last_source']}；與主樣本重疊且有前一台股交易日OI的n={out['foreign_futures']['n']}。淨OI=多單OI−空單OI；變化=當日淨OI−前一交易日淨OI（口）。不跨缺失的台股交易日差分。", '',
              table(['星期', 'n', '平均淨OI日變化（口）', '平均多空成交量淨額（口）'],
                    [[r['weekday'], r['n'], fmt(r['mean_oi_change']), fmt(r['mean_net_deal'])] for r in out['foreign_futures']['by_weekday']]), '',
              f"週二相對其他日OI日變化差：{fmt(foreign.get('coefficient'))}口，HAC p={pv(foreign.get('p'))}；五星期KW p={pv(out['foreign_futures']['omnibus_oi_change']['p'])}。", '',
              table(['樣本', 'n', 'Pearson r（OI變化／日內）', '迴歸斜率HAC p'],
                    [[label, r['n'], fmt(r['pearson_r']), pv(term(r['slope_test'], 'oi_change').get('p'))]
                     for label, r in out['foreign_futures']['correlations'].items()]), '',
              f"控制跳空、三檔美股與每千口OI變化後，週二係數{pp(term(out['foreign_futures']['controlled_model'], 'tuesday').get('coefficient'))}，"
              f"HAC p={pv(term(out['foreign_futures']['controlled_model'], 'tuesday').get('p'))}，n={out['foreign_futures']['controlled_model']['n']}。", '',
              'OI是當日結束後觀測，含換月／結算機制與可能的避險反應；與報酬的同期相關不是外資先行賣壓證據。成交量淨額另作描述，不能代替未平倉淨額。', '',
              '## 5. 探索性穩定度', '',
              '以下切分不是預先註冊或獨立樣本外檢驗。比較早晚子期及排除週一台股休市的情況，檢查是否只是特定年代或假日組成。', '',
              table(['子樣本', 'n週二／其他', '收低率週二／其他', '收低率p×5', '日內差', '日內p×5'],
                    [[label, f"{r['tuesday_vs_other_weekdays']['target']['n']}／{r['tuesday_vs_other_weekdays']['reference']['n']}",
                      f"{pct(r['tuesday_vs_other_weekdays']['target']['drop_rate'])}／{pct(r['tuesday_vs_other_weekdays']['reference']['drop_rate'])}",
                      pv(r['tuesday_vs_other_weekdays']['drop_test']['p_bonferroni5']),
                      pp(term(r['tuesday_vs_other_weekdays']['mean_tests']['intraday'], 'group').get('coefficient')),
                      pv(term(r['tuesday_vs_other_weekdays']['mean_tests']['intraday'], 'group').get('p_bonferroni5'))]
                     for label, r in out['exploratory'].items()]), '',
              '## 限制', '',
              '- 2026為未完年度；加權早期與櫃買日K開盤定義不同，不能把較長樣本當作相同開盤代理的直接複現。',
              '- 全部檢定為探索；事件率z與卡方假設觀測獨立，無法充分處理波動叢聚。HAC(5)只是有限的序列相關敏感度檢查，不校正挑選假說的偏誤。',
              '- 每年約50個週二，月結算前每年約12個，強美股分組更小；無顯著差異不等於排除有實務幅度的效應。',
              '- 跳空／美股／外資OI存在共同宏觀因子、媒介與反向因果；無政策變動、實際到期資料或識別設計，不能給出確定原因。',
              '- 盤中完整性篩選會改變樣本；資料未覆蓋的日子不補值。來源與略過清單在JSON，可重跑追溯。',
              '- 未納入交易成本或可執行策略；本研究不生成每日報告、不更新Notion、不發布網站。', '']
    return '\n'.join(lines)


def main():
    out = run()
    markdown = render(out)
    json_path = CACHE / 'tuesday-results.json'
    md_path = ROOT / 'docs/research/tuesday-weakness-results.md'
    json_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    md_path.write_text(markdown, encoding='utf-8')
    result = out['existence']['加權5秒開盤 09:01']['all']['tuesday_vs_other_weekdays']
    print(f"09:01 週二／其他收低率 {pct(result['target']['drop_rate'])}／{pct(result['reference']['drop_rate'])}；"
          f"n={result['target']['n']}／{result['reference']['n']}；p={pv(result['drop_test']['p'])}，p×5={pv(result['drop_test']['p_bonferroni5'])}")
    print('已輸出 data/backtest/intraday-pattern/tuesday-results.json 與 docs/research/tuesday-weakness-results.md')


if __name__ == '__main__':
    main()
