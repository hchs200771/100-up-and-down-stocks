#!/usr/bin/env python3
"""Does the TXO put/call open-interest ratio (or foreign option positioning) predict TAIEX?

Standard library only. Official TAIFEX monthly downloads are cached in
data/backtest/pc-ratio/. Every signal uses data published after the close of
day t; returns start at the close of day t (tradable via the night futures
session) and, as a robustness check, at the close of t+1. Directions and
quintile cuts come from 2019–2022 only; 2023 onward is out of sample.
This produces research artifacts; it never changes the production report.
"""
import argparse
import csv
import datetime as dt
import io
import json
import math
from pathlib import Path
import random
import statistics as st
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/backtest/pc-ratio"
PCR_URL = "https://www.taifex.com.tw/cht/3/pcRatioDown"
INST_URL = "https://www.taifex.com.tw/cht/3/callsAndPutsDateDown"  # official, only the last 3 years
FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"  # mirror of the same TAIFEX table since 2018
HORIZONS = (1, 5, 20)
DEV_END = "2023-01-01"
SIGNALS = {
    "pcr_oi": "未平倉P/C比（水準）",
    "pcr_oi_z": "未平倉P/C比（相對前60日z值）",
    "pcr_oi_chg5": "未平倉P/C比5日變化",
    "pcr_vol": "成交量P/C比",
    "foreign_net": "外資選擇權多空淨額（金額）",
    "foreign_chg": "外資選擇權多空淨額1日變化",
}


def number(text):
    try:
        return float(text.replace(",", ""))
    except (AttributeError, ValueError):
        return None


def months(start, end):
    y, m = start
    while (y, m) <= end:
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def download(url, params, path):
    if path.exists():
        return path.read_bytes()
    body = urllib.parse.urlencode(params).encode()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=60) as r:
                payload = r.read()
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(5)
    if payload.lstrip().startswith(b"<"):
        raise RuntimeError(f"{path.name}: TAIFEX returned HTML instead of CSV")
    path.write_bytes(payload)
    time.sleep(1)
    return payload


def fetch(end):
    CACHE.mkdir(parents=True, exist_ok=True)
    pcr, inst = {}, {}
    today = dt.date.today()
    for y, m in months((2019, 1), end):
        first = dt.date(y, m, 1)
        last = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))
        if first > today:
            break
        current = last >= today  # never cache an unfinished month
        rng = {"queryStartDate": first.strftime("%Y/%m/%d"), "queryEndDate": min(last, today).strftime("%Y/%m/%d")}
        path = CACHE / f"pcr-{y}{m:02d}.csv"
        if current and path.exists():
            path.unlink()
        text = download(PCR_URL, rng, path).decode("big5")
        for row in list(csv.reader(io.StringIO(text)))[1:]:
            if not row or not row[0].strip():
                continue
            pcr[row[0].strip().replace("/", "-")] = {
                "put_vol": number(row[1]), "call_vol": number(row[2]), "pcr_vol": number(row[3]) / 100,
                "put_oi": number(row[4]), "call_oi": number(row[5]), "pcr_oi": number(row[6]) / 100}
        if current:
            path.unlink()  # keep only completed months on disk
    for y in range(2019, end[0] + 1):
        path = CACHE / f"inst-{y}.json"
        if y == today.year and path.exists():
            path.unlink()
        if not path.exists():
            q = urllib.parse.urlencode({"dataset": "TaiwanOptionInstitutionalInvestors", "data_id": "TXO",
                                        "start_date": f"{y}-01-01", "end_date": f"{y}-12-31"})
            with urllib.request.urlopen(f"{FINMIND_URL}?{q}", timeout=120) as r:
                payload = json.loads(r.read())
            if payload.get("status") != 200 or not payload.get("data"):
                raise RuntimeError(f"FinMind {y}: {payload.get('msg')}")
            path.write_text(json.dumps(payload["data"], ensure_ascii=False))
            time.sleep(1)
        for row in json.loads(path.read_text()):
            if row["institutional_investors"] != "外資":
                continue
            side = "call" if row["call_put"] == "買權" else "put"
            # 未平倉契約金額買賣淨額 (thousand NTD) = long OI amount − short OI amount
            inst.setdefault(row["date"], {})[side] = (row["long_open_interest_balance_amount"]
                                                      - row["short_open_interest_balance_amount"])
        if y == today.year:
            path.unlink()
    return pcr, inst


def ols(y, xs):
    """OLS with Newey–West standard errors. xs: list of regressor columns (no constant)."""
    n, k = len(y), len(xs) + 1
    X = [[1.0] + [c[i] for c in xs] for i in range(n)]
    XtX = [[sum(X[r][a] * X[r][b] for r in range(n)) for b in range(k)] for a in range(k)]
    inv = invert(XtX)
    Xty = [sum(X[r][a] * y[r] for r in range(n)) for a in range(k)]
    beta = [sum(inv[a][b] * Xty[b] for b in range(k)) for a in range(k)]
    e = [y[r] - sum(beta[a] * X[r][a] for a in range(k)) for r in range(n)]
    return beta, e, X, inv


def invert(m):
    k = len(m)
    a = [row[:] + [float(i == j) for j in range(k)] for i, row in enumerate(m)]
    for c in range(k):
        p = max(range(c, k), key=lambda r: abs(a[r][c]))
        a[c], a[p] = a[p], a[c]
        pivot = a[c][c]
        a[c] = [v / pivot for v in a[c]]
        for r in range(k):
            if r != c:
                f = a[r][c]
                a[r] = [v - f * w for v, w in zip(a[r], a[c])]
    return [row[k:] for row in a]


def newey_west_t(y, xs, lags):
    """Slope on the first regressor and its Newey–West (Bartlett) t statistic."""
    beta, e, X, inv = ols(y, xs)
    n, k = len(y), len(beta)
    u = [[X[t][a] * e[t] for a in range(k)] for t in range(n)]
    S = [[sum(u[t][a] * u[t][b] for t in range(n)) for b in range(k)] for a in range(k)]
    for lag in range(1, lags + 1):
        w = 1 - lag / (lags + 1)
        for a in range(k):
            for b in range(k):
                g = sum(u[t][a] * u[t - lag][b] for t in range(lag, n))
                S[a][b] += w * g
                S[b][a] += w * g
    V = [[sum(inv[a][i] * S[i][j] * inv[j][b] for i in range(k) for j in range(k)) for b in range(k)] for a in range(k)]
    return beta[1], beta[1] / math.sqrt(V[1][1]) if V[1][1] > 0 else None


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=v.__getitem__)
        r = [0.0] * len(v)
        for i, j in enumerate(order):
            r[j] = i
        return r
    rx, ry = ranks(xs), ranks(ys)
    mx, my = st.mean(rx), st.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    return num / math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))


def build_rows(pcr, inst, prices):
    dates = sorted(d for d in prices if d in pcr)
    pdates = sorted(prices)
    pidx = {d: i for i, d in enumerate(pdates)}
    close = [prices[d]["close"] for d in pdates]
    rows = []
    for j, d in enumerate(dates):
        i = pidx[d]
        if i < 60 or j < 60:
            continue
        hist = [pcr[x]["pcr_oi"] for x in dates[j - 60:j]]
        sd = st.pstdev(hist)
        f = inst.get(d, {})
        fprev = inst.get(dates[j - 1], {})
        net = f["call"] - f["put"] if "call" in f and "put" in f else None
        prev = fprev["call"] - fprev["put"] if "call" in fprev and "put" in fprev else None
        row = {"date": d, "pcr_oi": pcr[d]["pcr_oi"], "pcr_vol": pcr[d]["pcr_vol"],
               "pcr_oi_z": (pcr[d]["pcr_oi"] - st.mean(hist)) / sd if sd else None,
               "pcr_oi_chg5": pcr[d]["pcr_oi"] - pcr[dates[j - 5]]["pcr_oi"],
               "foreign_net": net, "foreign_chg": None if net is None or prev is None else net - prev,
               "r1": math.log(close[i] / close[i - 1]), "r5": math.log(close[i] / close[i - 5]),
               "r20": math.log(close[i] / close[i - 20]), "r60": math.log(close[i] / close[i - 60]),
               "r120": math.log(close[i] / close[i - 120]) if i >= 120 else None}
        for h in HORIZONS:
            row[f"f{h}"] = math.log(close[i + h] / close[i]) if i + h < len(close) else None
            row[f"s{h}"] = math.log(close[i + 1 + h] / close[i + 1]) if i + 1 + h < len(close) else None
        rows.append(row)
    return rows


def evaluate(rows, sig, h, cuts=None, start="s"):
    key = f"{start}{h}"
    use = [r for r in rows if r[sig] is not None and r[key] is not None]
    if len(use) < 60:
        return None
    x = [r[sig] for r in use]
    y = [r[key] for r in use]
    sx = st.pstdev(x)
    xz = [(v - st.mean(x)) / sx for v in x]
    _, t_raw = newey_west_t(y, [xz], h)
    beta, t_ctrl = newey_west_t(y, [xz, [r["r1"] for r in use], [r["r5"] for r in use], [r["r20"] for r in use]], h)
    out = {"n": len(use), "ic": spearman(x, y), "t_raw": t_raw, "beta_ctrl_bp": beta * 1e4, "t_ctrl": t_ctrl}
    if cuts:
        buckets = [[] for _ in range(5)]
        for v, r in zip(x, y):
            buckets[sum(v > c for c in cuts)].append(r)
        out["quintiles"] = [st.mean(b) if b else None for b in buckets]
        out["quintile_n"] = [len(b) for b in buckets]
        out["top_minus_bottom"] = (out["quintiles"][4] - out["quintiles"][0]
                                   if buckets[0] and buckets[4] else None)
    return out


def quintile_cuts(rows, sig):
    xs = sorted(r[sig] for r in rows if r[sig] is not None)
    return [xs[int(len(xs) * q)] for q in (0.2, 0.4, 0.6, 0.8)]


def block_bootstrap_spread(rows, sig, h, cuts, draws=2000, block=20, seed=7):
    """CI of top-minus-bottom quintile mean forward return, resampling 20-day blocks."""
    use = [r for r in rows if r[sig] is not None and r[f"s{h}"] is not None]
    rng = random.Random(seed)
    n = len(use)
    stats = []
    for _ in range(draws):
        sample = []
        while len(sample) < n:
            s = rng.randrange(0, n - block)
            sample.extend(use[s:s + block])
        top = [r[f"s{h}"] for r in sample if r[sig] > cuts[3]]
        bot = [r[f"s{h}"] for r in sample if r[sig] <= cuts[0]]
        if top and bot:
            stats.append(st.mean(top) - st.mean(bot))
    stats.sort()
    return [stats[int(0.025 * len(stats))], stats[int(0.975 * len(stats)) - 1]]


def robustness(rows, sig="pcr_oi", h=20):
    """Longer momentum controls, within-year demeaning (removes slow regime level), and by period."""
    out = {}
    periods = {"dev": lambda d: d < DEV_END, "oos": lambda d: d >= DEV_END,
               "oos_2023_2025": lambda d: DEV_END <= d < "2026-01-01"}
    for pname, keep in periods.items():
        use = [r for r in rows if keep(r["date"]) and r[sig] is not None and r[f"s{h}"] is not None and r["r120"] is not None]
        by_year = {}
        for r in use:
            by_year.setdefault(r["date"][:4], []).append(r[sig])
        for mode in ("level", "within_year"):
            x = [r[sig] - (st.mean(by_year[r["date"][:4]]) if mode == "within_year" else 0) for r in use]
            sx, mx = st.pstdev(x), st.mean(x)
            xz = [(v - mx) / sx for v in x]
            y = [r[f"s{h}"] for r in use]
            for cname, ctrl in (("short", ("r1", "r5", "r20")), ("long", ("r1", "r5", "r20", "r60", "r120"))):
                beta, t = newey_west_t(y, [xz] + [[r[c] for r in use] for c in ctrl], h)
                out[f"{pname}:{mode}:{cname}"] = {"n": len(use), "beta_bp": beta * 1e4, "t": t}
    return out


def by_year_quintiles(rows, cuts, sig="pcr_oi", h=20):
    out = {}
    for r in rows:
        if r[sig] is None or r[f"s{h}"] is None:
            continue
        out.setdefault(r["date"][:4], [[] for _ in range(5)])[sum(r[sig] > c for c in cuts)].append(r[f"s{h}"])
    return {y: [{"n": len(b), "mean": st.mean(b) if b else None} for b in qs] for y, qs in sorted(out.items())}


def contemporaneous(rows):
    """Why the ratio looks informative: it moves with the market on the same day."""
    pairs = [(r["pcr_oi"] - p["pcr_oi"], r["r1"]) for p, r in zip(rows, rows[1:])]
    fpairs = [(r["foreign_chg"], r["r1"]) for r in rows if r["foreign_chg"] is not None]
    return {"pcr_change_vs_same_day_return": spearman(*zip(*pairs)),
            "pcr_level_vs_past20_return": spearman([r["pcr_oi"] for r in rows], [r["r20"] for r in rows]),
            "foreign_change_vs_same_day_return": spearman(*zip(*fpairs))}


def folk_rules(rows, h=5):
    """Common retail thresholds on the OI ratio, judged against unconditional drift."""
    out = {}
    base = [r[f"s{h}"] for r in rows if r[f"s{h}"] is not None]
    for name, test in (("pcr_ge_1.2", lambda v: v >= 1.2), ("pcr_le_0.9", lambda v: v <= 0.9),
                       ("pcr_1.0_to_1.2", lambda v: 1.0 <= v < 1.2)):
        hits = [r[f"s{h}"] for r in rows if r[f"s{h}"] is not None and test(r["pcr_oi"])]
        out[name] = {"days": len(hits), "mean": st.mean(hits) if hits else None,
                     "up_rate": sum(x > 0 for x in hits) / len(hits) if hits else None,
                     "all_mean": st.mean(base), "all_up_rate": sum(x > 0 for x in base) / len(base)}
    return out


def pct(x, d=2):
    return "—" if x is None else f"{x * 100:+.{d}f}%"


def num(x, d=2):
    return "—" if x is None else f"{x:+.{d}f}"


def render(res):
    tests = len(SIGNALS) * len(HORIZONS)
    crit = res["bonferroni_t"]
    L = [f"# 選擇權未平倉 P/C 比回測結果（{res['range'][0]}～{res['range'][1]}）", "",
         "由 `scripts/research-option-pc-ratio.py` 產生，判讀見 [option-pc-ratio-review.md](option-pc-ratio-review.md)。"
         "資料：期交所官方「臺指選擇權 Put/Call 比」，以及「三大法人選擇權買賣權分計」的外資及陸資部位（官方只開放近三年，2019 起改用 FinMind 轉載的同一張表）。"
         f"開發期 2019–2022 有 {res['n_dev']} 日，樣本外 2023 起有 {res['n_oos']} 日。", "",
         "報酬是加權指數對數報酬，從訊號日**次一交易日收盤**起算（保守，避免用到公布前的價格）。"
         "控制後係數是把訊號標準化後，迴歸時同時放入過去1/5/20日報酬，單位為每1個標準差對應的基點（bp）；"
         f"t 值用 Newey–West 調整重疊報酬。{tests} 組比較的 Bonferroni 門檻是 |t| ≥ {crit:.2f}。", ""]
    for period, label in (("dev", "開發期 2019–2022"), ("oos", "樣本外 2023 起")):
        L += [f"## {label}", "",
              "| 訊號 | 天期 | 等級相關 | t（未控制） | 控制後係數(bp/σ) | t（控制後） | 前1/5 − 後1/5 |",
              "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
        for sig, name in SIGNALS.items():
            for h in HORIZONS:
                e = res[period][sig][str(h)]
                if e is None:
                    continue
                L.append(f"| {name} | {h}日 | {num(e['ic'], 3)} | {num(e['t_raw'])} | {num(e['beta_ctrl_bp'], 1)} | "
                         f"{num(e['t_ctrl'])} | {pct(e.get('top_minus_bottom'))} |")
        L.append("")
    L += ["## 樣本外五分位（20日後報酬，切點來自開發期）", "",
          "| 訊號 | 最低1/5 | 2 | 3 | 4 | 最高1/5 | 前−後 95%區間 |", "| --- | ---: | ---: | ---: | ---: | ---: | --- |"]
    for sig, name in SIGNALS.items():
        e = res["oos"][sig]["20"]
        ci = res["oos_spread_ci20"][sig]
        L.append(f"| {name} | " + " | ".join(pct(q) for q in e["quintiles"]) + f" | {pct(ci[0])}～{pct(ci[1])} |")
    L += ["", "## 未平倉P/C比水準 × 20日：穩健性", "",
          "「年內去均值」是減掉當年平均 P/C 比，只看同一年內相對高低，排除多空格局本身造成的長期水準差。"
          "「長動能控制」是再加入過去60/120日報酬。", "",
          "| 期間 | 訊號 | 控制 | 日數 | 係數(bp/σ) | t |", "| --- | --- | --- | ---: | ---: | ---: |"]
    pnames = {"dev": "開發期 2019–2022", "oos": "樣本外 2023 起", "oos_2023_2025": "樣本外不含 2026"}
    for key, v in res["robustness_pcr_oi_20"].items():
        p, mode, c = key.split(":")
        L.append(f"| {pnames[p]} | {'水準' if mode == 'level' else '年內去均值'} | {'過去1/5/20日' if c == 'short' else '再加60/120日'} | "
                 f"{v['n']} | {num(v['beta_bp'], 1)} | {num(v['t'])} |")
    L += ["", "### 各年五分位（20日後報酬，切點固定用開發期）", "",
          "格內是「日數／平均報酬」；日數 0 的格子顯示 —。", "",
          "| 年 | 最低1/5 | 2 | 3 | 4 | 最高1/5 |", "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for y, qs in res["by_year_pcr_oi_20"].items():
        L.append(f"| {y} | " + " | ".join("—" if not q["n"] else f"{q['n']}／{pct(q['mean'], 1)}" for q in qs) + " |")
    c = res["contemporaneous"]
    L += ["", "## 同步關係（不是預測）", "",
          "| 關係 | 等級相關 |", "| --- | ---: |",
          f"| P/C 比當日變化 vs 當日漲跌 | {num(c['pcr_change_vs_same_day_return'], 3)} |",
          f"| P/C 比水準 vs 過去20日漲跌 | {num(c['pcr_level_vs_past20_return'], 3)} |",
          f"| 外資淨額當日變化 vs 當日漲跌 | {num(c['foreign_change_vs_same_day_return'], 3)} |", "",
          "## 常見門檻（全期，5日後報酬）", "",
          "| 規則 | 天數 | 平均5日報酬 | 上漲比例 | 全期平均 | 全期上漲比例 |", "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for name, f in res["folk"].items():
        L.append(f"| {name.replace('pcr_', 'P/C ').replace('_to_', '～').replace('ge_', '≥ ').replace('le_', '≤ ')} | "
                 f"{f['days']} | {pct(f['mean'])} | {f['up_rate'] * 100:.0f}% | {pct(f['all_mean'])} | {f['all_up_rate'] * 100:.0f}% |")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--draws", type=int, default=2000)
    args = ap.parse_args()
    today = dt.date.today()
    pcr, inst = fetch((today.year, today.month))
    benchmark = json.loads((ROOT / "research/wide-market/benchmark-input.json").read_text())
    prices = {r["date"]: r for r in benchmark["benchmarkTotalReturn"]["TaiwanStockPrice"]}
    rows = build_rows(pcr, inst, prices)
    dev = [r for r in rows if r["date"] < DEV_END]
    oos = [r for r in rows if r["date"] >= DEV_END]
    cuts = {s: quintile_cuts(dev, s) for s in SIGNALS}
    res = {"range": [rows[0]["date"], rows[-1]["date"]], "n_dev": len(dev), "n_oos": len(oos),
           "bonferroni_t": 3.14,  # two-sided 0.05 / 18 tests
           "quintile_cuts_dev": cuts,
           "dev": {s: {str(h): evaluate(dev, s, h, cuts[s]) for h in HORIZONS} for s in SIGNALS},
           "oos": {s: {str(h): evaluate(oos, s, h, cuts[s]) for h in HORIZONS} for s in SIGNALS},
           "oos_same_close": {s: {str(h): evaluate(oos, s, h, cuts[s], start="f") for h in HORIZONS} for s in SIGNALS},
           "oos_spread_ci20": {s: block_bootstrap_spread(oos, s, 20, cuts[s], args.draws) for s in SIGNALS},
           "contemporaneous": contemporaneous(rows), "folk": folk_rules(rows),
           "robustness_pcr_oi_20": robustness(rows),
           "by_year_pcr_oi_20": by_year_quintiles(rows, cuts["pcr_oi"])}
    (CACHE / "results.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    (CACHE / "observations.json").write_text(json.dumps(rows, ensure_ascii=False))
    dest = ROOT / "docs/option-pc-ratio-results.md"
    dest.write_text(render(res))
    print(f"Wrote {dest}; {len(rows)} rows ({len(dev)} dev / {len(oos)} oos)")


if __name__ == "__main__":
    main()
