#!/usr/bin/env python3
"""Reproducible Wednesday TXO straddle risk study; Python standard library only.

Raw public TAIFEX archives and derived observations stay in data/backtest/.
No production weights, report outputs, or report delivery are changed.
"""
import argparse
import csv
import datetime as dt
import io
import hashlib
import json
import math
from pathlib import Path
import random
import re
import statistics as st
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/backtest/weekly-straddle"
SOURCE = "https://www.taifex.com.tw/cht/3/optDataDown"
RULES = ("raw_spike", "adjusted_spike", "high_level")
OUTCOMES = ("big1", "big3")


def number(value):
    try:
        x = float(value.replace(",", ""))
        return x if math.isfinite(x) else None
    except (ValueError, AttributeError):
        return None


def percentile(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo = int(k)
    return xs[lo] + (xs[min(lo + 1, len(xs) - 1)] - xs[lo]) * (k - lo)


def scheduled_expiry(contract):
    """Wednesday series only; the monthly series supplies third Wednesday."""
    m = re.fullmatch(r"(\d{4})(\d{2})(?:W([1245]))?", contract)
    if not m:
        return None
    year, month = int(m[1]), int(m[2])
    nth = int(m[3]) if m[3] else 3
    first = dt.date(year, month, 1)
    result = first + dt.timedelta(days=(2 - first.weekday()) % 7 + (nth - 1) * 7)
    return result if result.month == month else None


def actual_expiry(contract, calendar):
    scheduled = scheduled_expiry(contract)
    if scheduled is None:
        return None
    # Official holiday rule postpones to the next business day. Use the
    # historical TAIEX calendar; omit any contract whose last observed date
    # disagrees with this calendar below (TAIFEX-only closures are not guessed).
    for offset in range(8):
        day = (scheduled + dt.timedelta(days=offset)).isoformat()
        if day in calendar:
            return day
    return None


def fetch_year(year):
    path = CACHE / f"{year}.zip"
    if path.exists():
        return path
    body = urllib.parse.urlencode({"his_year": year, "down_type": "2"}).encode()
    req = urllib.request.Request(SOURCE, data=body)
    with urllib.request.urlopen(req, timeout=180) as response:
        payload = response.read()
    if not payload.startswith(b"PK"):
        raise RuntimeError(f"{year}: expected official ZIP, received HTML/error; stopping")
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(payload)
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None:
            raise RuntimeError(f"{year}: corrupt ZIP")
    temporary.replace(path)
    print(f"Downloaded {year}: {len(payload):,} bytes", flush=True)
    return path


def select_pairs(pairs, spot, audit):
    candidates = []
    for strike, sides in pairs.items():
        if "買權" not in sides or "賣權" not in sides:
            continue
        call, put = sides["買權"], sides["賣權"]
        if any(x["close"] is None or x["close"] <= 0 or x["volume"] <= 0 for x in (call, put)):
            continue
        # Forward ATM: the liquid strike whose call/put prices are closest.
        # Also store spot-ATM to test selection sensitivity (13:30 vs 13:45).
        candidates.append((strike, call, put))
    if not candidates:
        return None
    strike, call, put = min(candidates, key=lambda x: (abs(x[1]["close"] - x[2]["close"]), x[0]))
    total = call["close"] + put["close"]
    # Reject an incomplete chain masquerading as ATM. Do not choose a farther
    # strike because the true near-ATM quote was missing.
    if abs(call["close"] - put["close"]) > 0.5 * total:
        audit["non_atm_rejected"] += 1
        return None
    k2, c2, p2 = min(candidates, key=lambda x: (abs(x[0] - spot), x[0]))
    mid = None
    if all(x["bid"] is not None and x["ask"] is not None and 0 < x["bid"] <= x["ask"]
           and (x["ask"] - x["bid"]) <= 0.2 * x["close"] for x in (call, put)):
        mid = sum((x["bid"] + x["ask"]) / 2 for x in (call, put))
    return {"strike": strike, "call": call["close"], "put": put["close"],
            "premium": total, "mid": mid, "spot_atm_premium": c2["close"] + p2["close"],
            "oi": sum(x["oi"] or 0 for x in (call, put)),
            "volume": call["volume"] + put["volume"], "spot_atm_strike": k2}


def parse_year(path, prices, calendar):
    result, last_dates = {}, {}
    audit = {"rows": 0, "non_atm_rejected": 0}
    with zipfile.ZipFile(path) as archive:
        for name in sorted(archive.namelist()):
            grouped = {}
            with archive.open(name) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="big5", errors="strict"))
                for row in reader:
                    if row.get("契約", "").strip() != "TXO" or row.get("交易時段", "一般").strip() != "一般":
                        continue
                    contract = row["到期月份(週別)"].strip()
                    if scheduled_expiry(contract) is None:
                        continue
                    date = row["交易日期"].strip().replace("/", "-")
                    last_dates[contract] = max(last_dates.get(contract, ""), date)
                    audit["rows"] += 1
                    if date not in prices:
                        continue
                    expiry = actual_expiry(contract, calendar)
                    if not expiry or not date < expiry:
                        continue
                    dte = (dt.date.fromisoformat(expiry) - dt.date.fromisoformat(date)).days
                    if dte > 7:
                        continue
                    strike = number(row["履約價"])
                    if strike is None:
                        continue
                    grouped.setdefault((date, contract, expiry), {}).setdefault(strike, {})[row["買賣權"].strip()] = {
                        "close": number(row["收盤價"]), "volume": number(row["成交量"]) or 0,
                        "oi": number(row["未沖銷契約數"]),
                        "bid": number(row["最後最佳買價"]), "ask": number(row["最後最佳賣價"])}
            for (date, contract, expiry), pairs in grouped.items():
                selected = select_pairs(pairs, prices[date]["close"], audit)
                if selected:
                    result.setdefault(date, []).append({**selected, "contract": contract, "expiry": expiry})
            print(f"Parsed {path.name}/{name}", flush=True)
    # End-of-year contracts extending into next year may be unobservable here;
    # only validate expiries within the archive year.
    mismatches = {c: {"observed": last, "scheduled": actual_expiry(c, calendar)}
                  for c, last in last_dates.items()
                  if actual_expiry(c, calendar) and actual_expiry(c, calendar)[:4] == path.stem
                  and last != actual_expiry(c, calendar)}
    for date in result:
        result[date] = [r for r in result[date] if r["contract"] not in mismatches]
    audit["expiry_mismatches"] = mismatches
    return result, audit


def make_observations(chains, prices, variant="premium"):
    dates = sorted(prices)
    observations = []
    history = []
    previous = None
    daily_returns = [None] + [math.log(prices[dates[i]]["close"] / prices[dates[i-1]]["close"])
                               for i in range(1, len(dates))]
    for i, date in enumerate(dates):
        if i < 60 or i + 3 >= len(dates):
            continue
        options = chains.get(date, [])
        if not options:
            previous = None
            continue
        selected = min(options, key=lambda x: x["expiry"])
        premium = selected.get(variant)
        if premium is None:
            previous = None
            continue
        close = prices[date]["close"]
        dte = (dt.date.fromisoformat(selected["expiry"]) - dt.date.fromisoformat(date)).days
        level = premium / close / math.sqrt(dte / 365)
        rv20 = math.sqrt(st.mean(x*x for x in daily_returns[i-19:i+1]))
        row = {**selected, "date": date, "dte": dte, "level": level,
               "rv20": rv20, "today_abs": abs(daily_returns[i]),
               "same_day_range": (prices[date]["max"] - prices[date]["min"]) / close,
               "next_abs": abs(prices[dates[i+1]]["close"] / close - 1),
               "future_rv3": math.sqrt(st.mean(x*x for x in daily_returns[i+1:i+4])),
               "future_excursion3": max(max(abs(prices[d]["max"] / close - 1),
                                             abs(prices[d]["min"] / close - 1)) for d in dates[i+1:i+4]),
               "next_open_abs3": abs(prices[dates[i+3]]["close"] / prices[dates[i+1]]["open"] - 1)}
        row["big1"] = float(row["next_abs"] >= 0.01)
        row["big3"] = float(row["future_excursion3"] >= 0.02)
        threshold = percentile(history[-60:], 0.9) if len(history) >= 60 else None
        row["high_eligible"] = threshold is not None
        row["high_level"] = threshold is not None and level >= threshold
        row["raw_spike"] = False
        row["adjusted_spike"] = False
        row["raw_change"] = None
        row["adjusted_change"] = None
        # Adjacent trading days, SAME expiry: no zero-DTE or rolling artifacts.
        # ATM strike may move; this measures risk surface, not one position P&L.
        if previous and previous["date"] == dates[i-1] and previous["expiry"] == row["expiry"]:
            row["raw_change"] = premium / previous["variant_premium"] - 1
            row["adjusted_change"] = level / previous["level"] - 1
            row["raw_spike"] = row["raw_change"] >= 0.25
            row["adjusted_spike"] = row["adjusted_change"] >= 0.25
        row["variant_premium"] = premium
        row["has_prior"] = row["raw_change"] is not None
        observations.append(row)
        previous = row
        history.append(level)
    return observations


def assign_strata(rows):
    training = [r for r in rows if r["date"] < "2023-01-01"]
    cuts = {key: [percentile([r[key] for r in training], q) for q in (1/3, 2/3)]
            for key in ("rv20", "today_abs")}
    for row in rows:
        bins = [sum(row[key] > cut for cut in cuts[key]) for key in cuts]
        row["stratum"] = (min(row["dte"], 4), *bins)
    return cuts


def matched_difference(rows, rule, outcome):
    groups = {}
    for row in rows:
        if rule == "high_level" and not row.get("high_eligible", False):
            continue
        if rule != "high_level" and not row["has_prior"]:
            continue
        group = groups.setdefault(tuple(row["stratum"]), [[], []])
        group[int(bool(row[rule]))].append(row[outcome])
    effects, control_values = [], []
    for controls, events in groups.values():
        if len(controls) < 5:
            continue
        mean = st.mean(controls)
        effects.extend(event - mean for event in events)
        control_values.extend([mean] * len(events))
    return {"difference": st.mean(effects) if effects else None,
            "matched_events": len(effects),
            "control_mean": st.mean(control_values) if control_values else None}


def summarize(rows, rule):
    eligible = [r for r in rows if (r.get("high_eligible", False) if rule == "high_level" else r["has_prior"])]
    events = [r for r in eligible if r[rule]]
    controls = [r for r in eligible if not r[rule]]
    result = {"eligible": len(eligible), "events": len(events), "controls": len(controls)}
    for key in (*OUTCOMES, "next_abs", "future_rv3", "same_day_range", "next_open_abs3"):
        result[key] = {"event": st.mean(r[key] for r in events) if events else None,
                       "control": st.mean(r[key] for r in controls) if controls else None,
                       **matched_difference(eligible, rule, key)}
    return result


def bootstrap(rows, draws):
    rng = random.Random(20261005)
    # Resample blocks of ten consecutive observed sessions, preserving local
    # clustering and overlapping three-day labels. Recompute control means.
    all_keys = [(rule, outcome) for rule in RULES for outcome in OUTCOMES]
    counts = {key: matched_difference(rows, *key)["matched_events"] for key in all_keys}
    # A bootstrap of three all-success events cannot represent unobserved
    # failures. Suppress inferential claims with fewer than twenty event dates.
    values = {key: [] for key in all_keys if counts[key] >= 20}
    estimates = {key: matched_difference(rows, *key)["difference"] for key in values}
    for _ in range(draws):
        sample = []
        while len(sample) < len(rows):
            start = rng.randrange(len(rows))
            sample.extend(rows[(start+j) % len(rows)] for j in range(10))
        sample = sample[:len(rows)]
        for key in values:
            difference = matched_difference(sample, *key)["difference"]
            if difference is not None:
                values[key].append(difference)
    result = {f"{key[0]}:{key[1]}": {"ci95": [None, None], "familywise_ci": [None, None],
              "approx_centered_bootstrap_p": None, "bonferroni_p": None,
              "successful_draws": 0, "reason": "fewer than 20 matched event dates"}
              for key in all_keys if key not in values}
    for key, xs in values.items():
        estimate = estimates[key]
        p = ((1 + sum(abs(x-estimate) >= abs(estimate) for x in xs)) / (len(xs)+1)
             if estimate is not None else None)
        result[f"{key[0]}:{key[1]}"] = {
            "ci95": [percentile(xs, .025), percentile(xs, .975)],
            "familywise_ci": [percentile(xs, .05/12), percentile(xs, 1-.05/12)],
            "approx_centered_bootstrap_p": p,
            "bonferroni_p": min(1, p*6) if p is not None else None,
            "successful_draws": len(xs)}
    return result


def fmt(x, scale=100):
    return "—" if x is None else f"{x*scale:.2f}"


def render(results, destination):
    lines = ["# 週三價平合風險訊號驗證", "", "此文件由 `scripts/research-weekly-straddle.py` 產生。", "",
             f"資料範圍：{results['dates'][0]} 至 {results['dates'][1]}，{results['observations']} 日。",
             "2019–2022 作開發描述／控制變數分層；2023–2025 作固定規則時間驗證。這是回溯研究，非真正未見的前瞻樣本。", "",
             "價平合＝同到期同履約價的買權收盤價＋賣權收盤價；未平倉口數另存、不混入價格。",
             "採一般交易時段、最近尚未到期且距到期不超過7日的週三W1/W2/W4/W5；第三週用月選，排除週五。結算日收盤後改下一期。",
             "ATM選擇有效成交的C/P價差最小履約價，並以大盤價平履約價與有效收盤買賣報價中點重跑敏感度。",
             "正規化值＝(C+P)/TAIEX收盤/√(剩餘日曆天數/365)，是近似波動代理，不是精確IV或VaR。",
             "暴衝定義固定為≥25%，只比較相鄰交易日同到期契約；高檔為超過過去60個有效觀察的90百分位。", "",
             "次日大行情＝次日收盤對訊號日收盤絕對變動≥1%；未來3日大行情＝最高／最低對訊號日收盤最大偏離≥2%。",
             "控制比較按剩餘天數（1/2/3/4–7）、過去20日實際波動與當日絕對報酬分層；後兩者界線僅由開發期定義。每格至少5個非訊號日。",
             "所有訊號均在收盤後才知道，沒有使用訊號當日行情當未來績效。", ""]
    for period, table in results["periods"].items():
        lines.extend([f"## {period}", "", "|規則|可比日/訊號日|次日≥1%：訊號/非訊號|控制後差(pp)/配對訊號數|未來3日≥2%：訊號/非訊號|控制後差(pp)/配對訊號數|", "|---|---:|---:|---:|---:|---:|"])
        for rule, row in table.items():
            a,b = row["big1"],row["big3"]
            lines.append(f"|{rule}|{row['eligible']}/{row['events']}|{fmt(a['event'])}% / {fmt(a['control'])}%|{fmt(a['difference'])} / {a['matched_events']}|{fmt(b['event'])}% / {fmt(b['control'])}%|{fmt(b['difference'])} / {b['matched_events']}|")
        lines.append("")
    lines.extend(["## 時間驗證的不確定性", "", f"固定seed，10日區塊bootstrap {results['draws']} 次，6個主比較做Bonferroni校正。機率差不是交易報酬。", "", "|比較|95% CI(pp)|6比較同時CI(pp)|近似校正p|", "|---|---:|---:|---:|"])
    for key, row in results["bootstrap"].items():
        p = "—" if row['bonferroni_p'] is None else f"{row['bonferroni_p']:.4f}"
        lines.append(f"|{key}|{fmt(row['ci95'][0])}～{fmt(row['ci95'][1])}|{fmt(row['familywise_ci'][0])}～{fmt(row['familywise_ci'][1])}|{p}|")
    lines.extend(["", "配對訊號日不足20筆，不計信賴區間或p值；原始暴衝只有3次，不能用其100%命中率推論可靠性。"])
    lines.extend(["", "## 敏感度（2023–2025）", "", "|價格口徑|規則|訊號數|控制後次日機率差(pp)|控制後3日機率差(pp)|", "|---|---|---:|---:|---:|"])
    for variant, table in results["sensitivity"].items():
        for rule,row in table.items():
            lines.append(f"|{variant}|{rule}|{row['events']}|{fmt(row['big1']['difference'])}|{fmt(row['big3']['difference'])}|")
    lines.extend(["", "## 加入當日盤中振幅控制", "", "上述主要分層再加入當日高低振幅的開發期三分位；降低『當天已波動』混淆，代價是可配對訊號減少。此檢查不調整訊號門檻。", "", "|規則|配對訊號日|次日機率差(pp)|3日機率差(pp)|3日95% CI(pp)|6比較同時CI(pp)|", "|---|---:|---:|---:|---:|---:|"])
    for rule, row in results["intraday_control"]["summary"].items():
        uncertainty = results["intraday_control"]["bootstrap"][f"{rule}:big3"]
        lines.append(f"|{rule}|{row['big3']['matched_events']}|{fmt(row['big1']['difference'])}|{fmt(row['big3']['difference'])}|{fmt(uncertainty['ci95'][0])}～{fmt(uncertainty['ci95'][1])}|{fmt(uncertainty['familywise_ci'][0])}～{fmt(uncertainty['familywise_ci'][1])}|")
    lines.extend(["", "## 資料與解讀限制", "", "- 期交所選擇權一般盤收盤13:45，大盤收盤13:30，不完全同步；兩腿最後成交也未必同時。報價中點版本是敏感度，不保證可成交。",
                  "- 非訊號日缺成交與兩腿不完整不補零；距到期超過7日的長假窗口不納入。契約到期日與歷史交易日曆／最後出現日不符者排除，稽核見JSON。",
                  "- 剩餘天數的平方根校正只是近似；結算前事件、週末／假期與波動期限結構仍會影響數值。",
                  "- 分層只能粗略控制已發生波動，不能證明因果或獨立alpha；敏感度屬描述，未再次搜索最優門檻。",
                  "- 年度資料含2025週五上市前後，但只使用週三系列；年份結果另存JSON。",
                  "- 未測跨式買入損益、成本或風險控倉效益；預示波動不等於買選擇權會獲利，也不能預測漲跌方向。",
                  "", "來源：https://www.taifex.com.tw/cht/3/dlOptDailyMarketView；契約規格：https://www.taifex.com.tw/cht/2/tXO", ""])
    destination.write_text("\n".join(lines))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--start-year", type=int, default=2019)
    parser.add_argument("--end-year", type=int, default=2025)
    parser.add_argument("--draws", type=int, default=3000)
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    benchmark = json.loads((ROOT / "research/wide-market/benchmark-input.json").read_text())
    prices = {r["date"]: r for r in benchmark["benchmarkTotalReturn"]["TaiwanStockPrice"]}
    calendar = set(prices)
    chains, audits = {}, {}
    for year in range(args.start_year, args.end_year+1):
        derived = CACHE / f"{year}-atm.json"
        if derived.exists():
            saved = json.loads(derived.read_text())
            chain, audit = saved["chains"], saved["audit"]
        else:
            path = fetch_year(year) if args.fetch else CACHE / f"{year}.zip"
            chain, audit = parse_year(path, prices, calendar)
            derived.write_text(json.dumps({"chains": chain, "audit": audit}, ensure_ascii=False))
        chains.update(chain)
        audit["archive_sha256"] = hashlib.sha256((CACHE / f"{year}.zip").read_bytes()).hexdigest()
        audits[str(year)] = audit
        if args.fetch:
            time.sleep(1)
    rows = make_observations(chains, prices)
    cuts = assign_strata(rows)
    periods = {"開發期2019–2022": [r for r in rows if r["date"] < "2023-01-01"],
               "時間驗證2023–2025": [r for r in rows if r["date"] >= "2023-01-01"]}
    validation = periods["時間驗證2023–2025"]
    results = {"dates": [rows[0]["date"], rows[-1]["date"]], "observations": len(rows),
               "benchmark_sha256": hashlib.sha256((ROOT / "research/wide-market/benchmark-input.json").read_bytes()).hexdigest(),
               "audit": audits, "stratum_cuts": cuts, "draws": args.draws,
               "periods": {name: {rule: summarize(part, rule) for rule in RULES} for name,part in periods.items()},
               "years": {str(y): {rule: summarize([r for r in rows if r['date'][:4] == str(y)], rule)
                                    for rule in RULES} for y in range(args.start_year,args.end_year+1)},
               "bootstrap": bootstrap(validation, args.draws), "sensitivity": {}}
    for variant in ("mid", "spot_atm_premium"):
        alternative = make_observations(chains, prices, variant)
        # SAME control cuts for all price variants.
        for row in alternative:
            row["stratum"] = (min(row["dte"],4), *[sum(row[k] > c for c in cuts[k]) for k in cuts])
        results["sensitivity"][variant] = {rule: summarize([r for r in alternative if r["date"] >= "2023-01-01"],rule) for rule in RULES}
    range_cuts = [percentile([r["same_day_range"] for r in periods["開發期2019–2022"]],q) for q in (1/3,2/3)]
    stronger = [{**r, "stratum": (*r["stratum"], sum(r["same_day_range"] > cut for cut in range_cuts))} for r in validation]
    results["intraday_control"] = {"range_cuts": range_cuts,
           "summary": {rule: summarize(stronger,rule) for rule in RULES},
           "bootstrap": bootstrap(stronger,args.draws)}
    (CACHE / "observations.json").write_text(json.dumps(rows, ensure_ascii=False))
    (CACHE / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    destination = ROOT / "docs/weekly-straddle-risk-results.md"
    render(results, destination)
    print(f"Wrote {destination}; {len(rows)} observations", flush=True)


if __name__ == "__main__":
    main()
