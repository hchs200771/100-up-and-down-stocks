#!/usr/bin/env python3
"""Offline TAIEX/TPEx intraday research; standard library, no report integration.

Run: python3 -I scripts/research-intraday-patterns.py
Snapshots the available gzip paths; incomplete/corrupt sessions are skipped.
All returns are fractions; p-values are two-sided, unadjusted exploratory tests.
"""
import gzip
import json
import math
import statistics as st
import zlib
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/backtest/intraday-pattern"
PERIODS = [("全部", 2000, 9999), ("2000–2012", 2000, 2012),
           ("2013–2020", 2013, 2020), ("2021–至今", 2021, 9999)]
GROUPS = ["一般日", "一般週五", "長假前", "週四長假前", "大長假前"] + list("一二三四五")
OPENINGS = {"加權09:00:30": 32430, "加權09:01": 32460, "加權09:05": 32700}
METRICS = {"black": "黑K", "gap_up_fade": "開高走低", "open_drop_005": "低於開盤≥0.5%",
           "open_drop_01": "低於開盤≥1%", "high_drop_003": "低於高點≥0.3%", "high_drop_005": "低於高點≥0.5%",
           "high_drop_01": "低於高點≥1%", "low_then_high_005": "先低後高回落≥0.5%",
           "low_then_high_01": "先低後高回落≥1%"}


def number(x):
    v = float(str(x).replace(",", ""))
    if not math.isfinite(v) or v <= 0:
        raise ValueError("nonpositive/nonfinite price")
    return v


def load_daily(name, start):
    raw = json.loads((CACHE / f"{name}-daily.json").read_text())
    calendar, valid, rejected = set(), {}, []
    for r in raw["data"]:
        try:
            d = date.fromisoformat(r["date"])
            calendar.add(d)
            o, h, l, c = [number(r[k]) for k in ("open", "max", "min", "close")]
            if not l <= min(o, c) <= max(o, c) <= h:
                raise ValueError("inconsistent OHLC")
            valid[d] = dict(date=d.isoformat(), open=o, high=h, low=l, close=c)
        except (KeyError, TypeError, ValueError) as e:
            rejected.append({"date": r.get("date"), "reason": str(e)})
    days = sorted(calendar)
    rows = []
    for i, d in enumerate(days):
        if d not in valid or d.year < start:
            continue
        r = dict(valid[d])
        # Calendar includes dates whose OHLC was rejected; never bridge missing prices.
        r["prev"] = valid.get(days[i - 1], {}).get("close") if i else None
        r["gap"] = (days[i + 1] - d).days if i + 1 < len(days) else None
        r["weekday"] = d.weekday()
        rows.append(r)
    return rows, rejected


def clock(seconds):
    return f"{seconds // 3600:02}:{seconds % 3600 // 60:02}"


def opening_quote(points, target):
    return points[max(t for t in points if 32400 < t <= target)]


def load_intraday(daily):
    lookup = {r["date"]: r for r in daily}
    paths = sorted((CACHE / "taiex-5s").glob("*.json.gz"))
    sessions, skipped, seen = [], [], set()
    for path in paths:
        try:
            d = datetime.strptime(path.name[:8], "%Y%m%d").date().isoformat()
            if d < "2021-01-01" or d not in lookup or d in seen:
                raise ValueError("date outside daily calendar / duplicate / before 2021")
            with gzip.open(path, "rt", encoding="utf-8") as f:
                raw = json.load(f)
            if raw.get("date", d.replace("-", "")) != d.replace("-", ""):
                raise ValueError("filename/payload date mismatch")
            fields = raw["fields"]
            ti, pi = fields.index("時間"), fields.index("發行量加權股價指數")
            points = {}
            for item in raw["data"]:
                t, p = (item["時間"], item["發行量加權股價指數"]) if isinstance(item, dict) else (item[ti], item[pi])
                hh, mm, ss = map(int, t.strip().split(":"))
                if not (0 <= hh < 24 and 0 <= mm < 60 and 0 <= ss < 60):
                    raise ValueError("invalid clock")
                s = hh * 3600 + mm * 60 + ss
                if 32405 <= s <= 48600:
                    value = number(p)
                    if s in points and points[s] != value:
                        raise ValueError("conflicting timestamp")
                    points[s] = value
            # Closing call auction may omit updates between 13:25 and 13:30.
            # Require 99% of continuous-session grid plus exact key timestamps.
            expected = range(32405, 48301, 5)
            coverage = sum(s in points for s in expected) / len(expected)
            if coverage < .99 or any(s not in points for s in (32405, 48300, 48600)):
                raise ValueError(f"incomplete session (continuous coverage {coverage:.1%})")
            seq = sorted(points.items())
            high, low = max(points.values()), min(points.values())
            sessions.append(dict(date=d, points=points, high=high, low=low,
                                 close=points[48600], high_time=next(t for t, p in seq if p == high),
                                 low_time=next(t for t, p in seq if p == low), coverage=coverage,
                                 close_daily_difference=points[48600] / lookup[d]["close"] - 1))
            seen.add(d)
        except (OSError, EOFError, ValueError, KeyError, IndexError, TypeError, UnicodeError, zlib.error) as e:
            skipped.append({"file": path.name, "reason": str(e)})
    return sessions, {"files_at_start": len(paths), "used_days": len(sessions),
                      "skipped": skipped, "dates": [s["date"] for s in sessions],
                      "min_continuous_coverage": min((s["coverage"] for s in sessions), default=None),
                      "max_abs_close_daily_difference": max((abs(s["close_daily_difference"]) for s in sessions), default=None)}


def in_group(r, group):
    g, w = r["gap"], r["weekday"]
    if group in list("一二三四五"):
        return w == "一二三四五".index(group)
    return {"一般日": g == 1, "一般週五": g == 3 and w == 4,
            "長假前": g is not None and g >= 4,
            "週四長假前": g is not None and g >= 4 and w == 3,
            "大長假前": g is not None and g >= 5}[group]


def period_rows(rows, lo, hi):
    return [r for r in rows if lo <= int(r["date"][:4]) <= hi]


def z_test(k, n, b, m):
    if not n or not m:
        return None
    pooled = (k + b) / (n + m)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / m))
    return math.erfc(abs(k / n - b / m) / se / math.sqrt(2)) if se else 1.0


def binomial_p(a, b):
    """Exact two-sided Binomial(a+b, .5), log-sum avoids tail underflow."""
    n, k = a + b, min(a, b)
    if not n:
        return None
    if 2 * k == n:
        return 1.0
    logs = [math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1)
            - n * math.log(2) for i in range(k + 1)]
    top = max(logs)
    return min(1.0, 2 * math.exp(top) * sum(math.exp(v - top) for v in logs))


def events(r):
    o, c, h = r["open"], r["close"], r["high"]
    e = dict(black=c < o, gap_up_fade=o > r["prev"] and c < o,
             open_drop_005=c <= o * .995, open_drop_01=c <= o * .99,
             high_drop_003=c <= h * .997, high_drop_005=c <= h * .995, high_drop_01=c <= h * .99)
    if "low_time" in r:
        e.update(low_then_high_005=r["low_time"] < r["high_time"] and c <= h * .995,
                 low_then_high_01=r["low_time"] < r["high_time"] and c <= h * .99)
    return e


def q1(rows):
    result = []
    # Unknown prev/next session (cache endpoints) cannot be classified reliably.
    rows = [r for r in rows if r["prev"] is not None and r["gap"] is not None]
    for period, lo, hi in PERIODS:
        sample = period_rows(rows, lo, hi)
        for group in GROUPS:
            target = [r for r in sample if in_group(r, group)]
            # Remove overlapping weekday rows from normal-day reference for an
            # independent two-proportion test. Self-reference has no test.
            base = [r for r in sample if in_group(r, "一般日")
                    and (group == "一般日" or not in_group(r, group))]
            n, m = len(target), len(base)
            metrics = {}
            keys = events(sample[0]).keys() if sample else [k for k in METRICS if not k.startswith("low_then")]
            for key in keys:
                k = sum(events(r)[key] for r in target)
                b = sum(events(r)[key] for r in base)
                metrics[key] = dict(count=k, rate=k / n if n else None,
                                    baseline_count=b, baseline_n=m, baseline_rate=b / m if m else None,
                                    difference=k / n - b / m if n and m else None,
                                    p=None if group == "一般日" else z_test(k, n, b, m),
                                    unreliable=n < 30 or m < 30,
                                    small_expected_cells=bool(n and m and min((k+b)/(n+m)*min(n,m), (1-(k+b)/(n+m))*min(n,m)) < 5))
            result.append(dict(period=period, group=group, n=n, unreliable=n < 30, metrics=metrics,
                               mean_close_open=st.mean(r["close"] / r["open"] - 1 for r in target) if n else None,
                               mean_close_prev=st.mean(r["close"] / r["prev"] - 1 for r in target) if n else None))
    return result


def q2(rows):
    result = []
    for period, lo, hi in PERIODS:
        sample = period_rows(rows, lo, hi)
        for strict in (False, True):
            counts = {key: 0 for key in ("red_upper", "red_lower", "green_upper", "green_lower")}
            for r in sample:
                o, c, h, l = (r[k] for k in ("open", "close", "high", "low"))
                upper, lower, body = max(0, h - max(o, c)), max(0, min(o, c) - l), abs(c - o)
                if c == o or upper == lower:
                    continue
                side, wick = ("upper", upper) if upper > lower else ("lower", lower)
                if not strict or (wick >= body and wick >= .003 * o):
                    counts[("red_" if c > o else "green_") + side] += 1
            a, b = counts["green_upper"], counts["red_lower"]
            n = len(sample)
            result.append(dict(period=period, definition="嚴格" if strict else "寬鬆", n=n,
                               **{key + "_count": count for key, count in counts.items()},
                               **{key + "_rate": count / n if n else None for key, count in counts.items()},
                               ratio=a / b if b else None, ratio_denominator_zero=bool(a and not b),
                               p=binomial_p(a, b), unreliable=n < 30 or a + b < 30))
    return result


def entry_summary(values):
    return dict(n=len(values), mean_return=st.mean(x[0] for x in values) if values else None,
                median_return=st.median(x[0] for x in values) if values else None,
                mean_distance_high=st.mean(x[1] for x in values) if values else None,
                within_high_003_rate=st.mean(x[1] <= .003 for x in values) if values else None)


def q3(sessions, daily, after=None):
    if after is not None:
        filtered = []
        for session in sessions:
            points = {t: p for t, p in session["points"].items() if t > after}
            high, low = max(points.values()), min(points.values())
            filtered.append(dict(session, high=high, low=low,
                                 high_time=min(t for t, p in points.items() if p == high),
                                 low_time=min(t for t, p in points.items() if p == low)))
        sessions = filtered
    lookup = {r["date"]: r for r in daily}
    distributions = []
    for direction in ("全部", "上漲日", "下跌日", "平盤日"):
        ss = [s for s in sessions if direction == "全部" or
              (lookup[s["date"]]["prev"] is not None and
               ("上漲日" if s["close"] > lookup[s["date"]]["prev"] else
                "下跌日" if s["close"] < lookup[s["date"]]["prev"] else "平盤日") == direction)]
        for extreme in ("high", "low"):
            bins = [(s, s + 900, False) for s in range(32400, 48600, 900)] + [(48300, 48600, True)]
            for start, end, supplemental in bins:
                count = sum(start <= s[extreme + "_time"] < end or
                            (end == 48600 and s[extreme + "_time"] == end) for s in ss)
                rate = count / len(ss) if ss else None
                distributions.append(dict(direction=direction, extreme=extreme, n=len(ss), count=count,
                                          bucket=f"{clock(start)}–{clock(end)}", minutes=(end-start)/60,
                                          supplemental=supplemental, rate=rate,
                                          uniform_density_multiple=rate * 270 / ((end-start)/60) if rate is not None else None))
    entries, grouped = [], {"09:30–10:00": [], "其他時段": []}
    daily_groups = {key: [] for key in grouped}
    for s in sessions:
        day = {key: [] for key in grouped}
        for t in range(32700, 48600, 300):
            if t not in s["points"]:
                continue
            p = s["points"][t]
            value = (s["close"] / p - 1, 1 - p / s["high"])
            key = "09:30–10:00" if 34200 <= t < 36000 else "其他時段"
            grouped[key].append(value)
            day[key].append(value)
        for key, values in day.items():
            if values:
                daily_groups[key].append(st.mean(x[0] for x in values))
    for t in range(32700, 48600, 300):
        values = [(s["close"] / s["points"][t] - 1, 1 - s["points"][t] / s["high"])
                  for s in sessions if t in s["points"]]
        entries.append(dict(time=clock(t), **entry_summary(values)))
    comparison = [{"group": k, **entry_summary(v), "days": len(daily_groups[k]),
                   "mean_day_return": st.mean(daily_groups[k]) if daily_groups[k] else None}
                  for k, v in grouped.items()]
    return dict(distributions=distributions, entries=entries, comparison=comparison)


def pct(v):
    return "—" if v is None else f"{v * 100:.2f}%"


def pv(v):
    return "—" if v is None else "<0.0001" if v < .0001 else f"{v:.4f}"


def table(headers, rows):
    return ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"] + [
        "| " + " | ".join(map(str, r)) + " |" for r in rows]


def q1_conclusion(results):
    parts = []
    for name in ("加權日K", "櫃買日K", *OPENINGS):
        rows = results[name]
        for group in ("一般週五", "長假前"):
            r = next(x for x in rows if x["period"] == "全部" and x["group"] == group)
            m = r["metrics"]["gap_up_fade"]
            evidence = m["p"] is not None and m["p"] < .05 and not m["unreliable"]
            label = ("較高" if m["difference"] > 0 else "較低") if evidence else "沒有差異證據"
            periods = [x for x in rows if x["group"] == group and x["period"] != "全部"]
            signs = [x["metrics"]["gap_up_fade"]["difference"] for x in periods]
            consistent = all(v is not None and v > 0 for v in signs) or all(v is not None and v < 0 for v in signs)
            parts.append(f"{name}{group}開高走低{label}（差 {pct(m['difference'])}，p={pv(m['p'])}；分期方向{'一致' if consistent else '不一致或資料不足'}）")
    return "；".join(parts) + "。這是未校正多重比較的探索結果，不能推論每期都有相同效應。"


def sensitivity_label(difference, p, unreliable):
    direction = "正向" if difference is not None and difference > 0 else "負向" if difference is not None and difference < 0 else "持平" if difference == 0 else "資料不足"
    evidence = "有差異證據" if p is not None and p < .05 and not unreliable else "無足夠差異證據"
    return f"{direction}／{evidence}"


def sensitivity_line(label, labels):
    consistent = len({value for _, value in labels}) == 1
    available = all("資料不足" not in value for _, value in labels)
    verdict = "一致" if consistent and available else "不一致" if available else "資料不足，無法判定一致性"
    return f"- {label}：三版結論{verdict}（" + "；".join(f"{name}：{value}" for name, value in labels) + "）。"


def render(out):
    meta = out["intraday_data"]
    lines = ["# 台股指數盤中型態查證", "", f"產生時間：{out['generated_at']}。僅讀本機快取，未連網。",
             f"5 秒快取：發現 {meta['files_at_start']} 檔、使用 {meta['used_days']} 天、跳過 {len(meta['skipped'])} 檔。",
             "", "## 資料與統計口徑", ""]
    for name, info in out["daily_data"].items():
        lines.append(f"- {name}：{info['start']}～{info['end']}，{info['n']} 天；無效日K {len(info['rejected'])} 筆。")
    lines += ["- gap 使用各指數日K快取的下一個交易日期；假定快取日曆完整。末筆沒有下一交易日、首筆沒有昨收，Q1 排除。早期週六交易保留在 gap 日曆中。",
              "- 一般日 gap=1；一般週五為週五且 gap=3；長假前 gap≥4、週四長假前為其子集；大長假前 gap≥5。週一至週五另列，分類可重疊。",
              "- Q1 各分類對同期間一般日做雙尾 pooled two-proportion z 檢定；星期分類的基準先扣除重疊日期。一般日自身不檢定。差距單位為百分點（表內以 % 顯示）。",
              "- † 表示目標或基準 n<30，或 Q2 總天數／兩型態合計少於30，不可靠；‡ 表示 z 檢定期望格數<5，常態近似不穩。所有 p 值未做多重比較校正，未處理跨日自相關。",
              "- 09:00:30、09:01為主要版本，09:05為對照。開盤取指定時刻以前最近有效5秒報價，永遠排除09:00:00昨收；Q1、Q2高低點只用指定時刻之後（不含該時刻）的5秒資料，收盤用13:30，昨收用官方日K。影線長度最低為0。官方日K版保留官方全日OHLC，因此差異同時包含開盤、極值窗口及收盤來源；配對日K與三版日期相同。",
              "", "## Q1：週五／長假前較容易走低嗎？", "", "結論：" + q1_conclusion(out["q1"]), ""]
    lines += ["### 三版並排", ""]
    lines += table(["分期", "分類", "事件", *OPENINGS],
                   [[r["period"], r["group"], METRICS[key],
                     *[f"{v['count']}/{rr['n']} / {pct(v['rate'])} / 差 {pct(v['difference'])} / p={pv(v['p'])}"
                       + ("†" if v["unreliable"] else "") + ("‡" if v["small_expected_cells"] else "")
                       for rr in [out["q1"][name][i] for name in OPENINGS] for v in [rr["metrics"][key]]]]
                    for i, r in enumerate(out["q1"]["加權09:01"]) for key in r["metrics"]])
    lines += [""]
    for name, rows in out["q1"].items():
        lines += [f"### {name}", ""]
        for period, _, _ in PERIODS:
            subset = [r for r in rows if r["period"] == period]
            lines += [f"#### {period}", ""]
            lines += table(["分類", "n", "平均收/開−1", "平均收/昨收−1"],
                           [[r["group"] + ("†" if r["unreliable"] else ""), r["n"], pct(r["mean_close_open"]), pct(r["mean_close_prev"])] for r in subset])
            lines += [""]
            lines += table(["分類", "事件", "次數/n", "比率", "一般日基準n", "基準比率", "差(pp)", "p"],
                           [[r["group"], METRICS[k] + ("†" if v["unreliable"] else "") + ("‡" if v["small_expected_cells"] else ""),
                             f"{v['count']}/{r['n']}", pct(v["rate"]), v["baseline_n"], pct(v["baseline_rate"]), pct(v["difference"]), pv(v["p"])]
                            for r in subset for k, v in r["metrics"].items()])
            lines += [""]
    lines += ["限制：開高走低以全部分類交易日為分母，不是只看開高日；5秒『先低後高再回落』僅指全日最低首次出現早於全日最高首次出現，且收盤距高點達門檻，不代表先跌破開盤。日K舊開盤價可能改變K色與開高判定；不足30天或不顯著的差異沒有足夠證據。", "",
              "## Q2：上影線綠K是否更常見？", ""]
    conclusions = []
    for name, rows in out["q2"].items():
        for r in rows:
            if r["period"] == "全部":
                evidence = r["p"] is not None and r["p"] < .05 and not r["unreliable"]
                claim = ("上影線綠K較常見" if r["green_upper_count"] > r["red_lower_count"] else "下影線紅K較常見") if evidence else "沒有兩者頻率不同的證據"
                conclusions.append(f"{name}（{r['definition']}）{claim}，p={pv(r['p'])}")
    lines += ["結論：" + "；".join(conclusions) + "。", "",
              "紅K=收盤>開盤、綠K=收盤<開盤。四種K線皆列：寬鬆取較長那側影線；嚴格在寬鬆上再要求該影線≥實體且≥開盤價0.3%。平盤K與影線相等均不計入。比率分母為全部日數；二項檢定條件於兩類事件合計，以0.5為虛無假設。", ""]
    lines += table(["版本", "分期", "定義", "n", "綠K上影 次數/率", "紅K下影 次數/率", "比值", "p"],
                   [[name, r["period"], r["definition"] + ("†" if r["unreliable"] else ""), r["n"],
                     f"{r['green_upper_count']} / {pct(r['green_upper_rate'])}", f"{r['red_lower_count']} / {pct(r['red_lower_rate'])}",
                     "∞" if r["ratio_denominator_zero"] else "—" if r["ratio"] is None else f"{r['ratio']:.3f}", pv(r["p"])]
                    for name, rows in out["q2"].items() for r in rows])
    lines += ["", "### 四種K線（分母為全部日數）", ""]
    lines += table(["版本", "分期", "定義", "n", "紅K上影", "紅K下影", "綠K上影", "綠K下影"],
                   [[name, r["period"], r["definition"], r["n"],
                     *[f"{r[key + '_count']} / {pct(r[key + '_rate'])}"
                       for key in ("red_upper", "red_lower", "green_upper", "green_lower")]]
                    for name, rows in out["q2"].items() for r in rows])
    lines += ["", "### 三版並排", ""]
    lines += table(["分期", "定義", *OPENINGS],
                   [[r["period"], r["definition"],
                     *[f"n={v['n']} / 綠上影 {pct(v['green_upper_rate'])} / 紅下影 {pct(v['red_lower_rate'])} / p={pv(v['p'])}"
                       + ("†" if v["unreliable"] else "")
                       for name in OPENINGS for v in [out["q2"][name][i]]]]
                    for i, r in enumerate(out["q2"]["加權09:01"])])
    lines += ["", "相同日期的開盤及極值窗口敏感度：", ""]
    for definition in ("寬鬆", "嚴格"):
        a = next(r for r in out["q2"]["加權配對日K"] if r["period"] == "全部" and r["definition"] == definition)
        for name in OPENINGS:
            b = next(r for r in out["q2"][name] if r["period"] == "全部" and r["definition"] == definition)
            diff = ((a["green_upper_rate"] - a["red_lower_rate"]) - (b["green_upper_rate"] - b["red_lower_rate"])) if a["n"] else None
            direction = "偏向上影綠K" if diff is not None and diff > 0 else "偏向下影紅K" if diff is not None and diff < 0 else "無法判定方向或差為零"
            lines.append(f"- {definition}：官方相對{name}版的『綠上影率−紅下影率』差為 {pct(diff)}，{direction}。")
    lines += ["", "### 開盤及極值窗口敏感度", "",
              "以下比較全期三版的方向與顯著性結論；一致不代表各分期皆成立，也不是三版差異的顯著性檢定。", ""]
    for group in ("一般週五", "長假前"):
        labels = []
        for name in OPENINGS:
            r = next(r for r in out["q1"][name] if r["period"] == "全部" and r["group"] == group)
            m = r["metrics"]["gap_up_fade"]
            labels.append((name, sensitivity_label(m["difference"], m["p"], m["unreliable"])))
        lines.append(sensitivity_line(f"Q1 {group}開高走低", labels))
    for definition in ("寬鬆", "嚴格"):
        labels = []
        for name in OPENINGS:
            r = next(r for r in out["q2"][name] if r["period"] == "全部" and r["definition"] == definition)
            diff = r["green_upper_rate"] - r["red_lower_rate"] if r["n"] else None
            labels.append((name, sensitivity_label(diff, r["p"], r["unreliable"])))
        lines.append(sensitivity_line(f"Q2 {definition}綠上影率−紅下影率", labels))
    lines += ["", "限制：舊開盤價偏向昨收，牛市可能把開盤壓低而增加紅K、熊市則可能相反，沒有必然固定方向；上述配對差是描述性敏感度，並非兩版差異的顯著性檢定。分期結果可見上表，不能以全期p值代替每期驗證。", "",
              "## Q3：高點特別常出現在09:30–10:00嗎？", ""]
    q = out["q3"]
    selected = [r for r in q["distributions"] if r["direction"] == "全部" and r["extreme"] == "high" and r["bucket"] in ("09:30–09:45", "09:45–10:00")]
    rate = sum(r["rate"] for r in selected) if selected and all(r["rate"] is not None for r in selected) else None
    n = selected[0]["n"] if selected else 0
    k = sum(r["count"] for r in selected)
    # Descriptive comparison only: clock-uniform null is not a market model.
    lines += [f"結論：09:30–10:00首次全日高點占 {k}/{n}（{pct(rate)}），相對時鐘均勻分布（30/270）為 {rate * 9:.2f} 倍。" if rate is not None else "結論：尚無可用5秒資料，沒有證據支持指定時段較常見高點。",
              "此為描述性比例，未做顯著性檢定，不能據此宣稱存在穩定優勢。" + ("目前樣本少於30天，不可靠。" if n < 30 else ""), "",
              "每15分鐘桶採左閉右開，13:30歸最後桶；13:25–13:30另列為重疊補充桶，不可再與15分鐘桶加總。密度倍數=比率÷(桶分鐘/270)。重複高低點取首次出現；上漲／下跌以收盤對官方昨收分類。", ""]
    lines += table(["日別", "極值", "n", "時段", "次數", "比率", "密度倍數"],
                   [[r["direction"], "高" if r["extreme"] == "high" else "低", r["n"], r["bucket"] + ("（補充）" if r["supplemental"] else ""), r["count"], pct(r["rate"]),
                     "—" if r["uniform_density_multiple"] is None else f"{r['uniform_density_multiple']:.2f}"] for r in q["distributions"]])
    lines += ["", "### 排除開盤首分鐘的極值敏感度", "",
              "以相同交易日、相同15分鐘桶，僅用09:01之後（不含09:01）的5秒資料重新尋找最高／最低點；平手仍取首次。原版排除09:00:00，但保留首分鐘。兩版並列；09:00–09:15敏感度桶實際涵蓋09:01之後至09:15之前。", ""]
    lines += table(["日別", "極值", "時段", "n", "原版次數/率", "排除首分鐘次數/率"],
                   [[r["direction"], r["extreme"], r["bucket"], r["n"],
                     f"{r['count']} / {pct(r['rate'])}", f"{v['count']} / {pct(v['rate'])}"]
                    for r, v in zip(q["distributions"], q["after_0901_distributions"])])
    lines += ["", "### 進場至收盤（未含成本）", "",
              "進場取精確5分鐘時間點09:05～13:25；不使用09:00昨收，也不將收盤本身當進場。09:30–10:00指09:30～09:55，不含10:00。距高點=1−進場價/全日高點，越小越靠近高點。", ""]
    lines += table(["組別", "觀測數", "天數", "平均報酬", "中位報酬", "平均距高點", "高點0.3%內"],
                   [[r["group"], r["n"], r["days"], pct(r["mean_return"]), pct(r["median_return"]), pct(r["mean_distance_high"]), pct(r["within_high_003_rate"])] for r in q["comparison"]])
    lines += [""] + table(["進場", "n", "平均收/進−1", "中位收/進−1", "平均距高點", "高點0.3%內"],
                            [[r["time"], r["n"], pct(r["mean_return"]), pct(r["median_return"]), pct(r["mean_distance_high"]), pct(r["within_high_003_rate"])] for r in q["entries"]])
    lines += ["", "限制：這是加權指數而非個股，僅2021起已下載且通過完整性檢查的日期，可能有期間選擇偏誤；同日多個進場點高度相關，不能當獨立樣本。指數無法直接成交，未扣成本、滑價，距全日高點含事後資訊。早進場持有較久，報酬不能直接視為擇時能力。收盤集合競價更新稀疏、極值平手取首次，均會影響密度，時鐘均勻分布只是參考。", "",
              "## 跳過資料", ""]
    lines += [f"- {r['file']}：{r['reason']}" for r in meta["skipped"]] or ["- 無壞檔。"]
    return "\n".join(lines) + "\n"


def main():
    taiex, bad_taiex = load_daily("taiex", 2000)
    tpex, bad_tpex = load_daily("tpex", 2005)
    sessions, meta = load_intraday(taiex)
    lookup = {r["date"]: r for r in taiex}
    paired, revised, full_intraday = [], {name: [] for name in OPENINGS}, []
    # Preserve Q3's original exact-09:05 session eligibility and calculations.
    q3_sessions = [s for s in sessions if 32700 in s["points"]]
    for s in sessions:
        base = lookup[s["date"]]
        openings = {name: opening_quote(s["points"], target)
                    for name, target in OPENINGS.items()}
        paired.append(base)
        for name, opening in openings.items():
            points = {t: p for t, p in s["points"].items() if t > OPENINGS[name]}
            high, low = max(points.values()), min(points.values())
            revised[name].append(dict(base, open=opening, high=high, low=low, close=s["close"],
                                      high_time=min(t for t, p in points.items() if p == high),
                                      low_time=min(t for t, p in points.items() if p == low)))
        if 32700 in s["points"]:
            full_intraday.append(dict(base, open=s["points"][32405], high=s["high"], low=s["low"],
                                      close=s["close"], high_time=s["high_time"], low_time=s["low_time"]))
    versions = {"加權日K": taiex, "櫃買日K": tpex, "加權配對日K": paired, **revised}
    out = dict(generated_at=datetime.now(timezone.utc).isoformat(),
               daily_data={name: dict(n=len(rows), start=rows[0]["date"] if rows else None,
                                      end=rows[-1]["date"] if rows else None, rejected=bad)
                           for name, rows, bad in (("加權", taiex, bad_taiex), ("櫃買", tpex, bad_tpex))},
               intraday_data=meta,
               methods=dict(q1_baseline="same-period gap=1 excluding overlapping target dates; self p=null",
                            q1_test="two-sided pooled two-proportion z; raw p; n<30 unreliable",
                            q2_test="exact two-sided conditional Binomial(a+b, 0.5)",
                            revised_candle="primary 09:00:30/09:01; control 09:05; latest quote at or before target excluding 09:00:00; H/L strictly after target; 13:30 close; official previous close; common paired dates",
                            extrema="first occurrence; 09:00:00 excluded", returns="fractions; differences in proportions",
                            intraday_quality="99% continuous 09:00:05–13:25 grid plus exact open/13:25/13:30; Q3 and full-intraday Q1 additionally require exact 09:05"),
               q1={name: q1(rows) for name, rows in versions.items()},
               q2={name: q2(rows) for name, rows in versions.items()}, q3=q3(q3_sessions, taiex))
    out["q3"]["after_0901_distributions"] = q3(q3_sessions, taiex, after=32460)["distributions"]
    out["methods"]["q3_sensitivity"] = "same sessions; extrema strictly after 09:01; first occurrence"
    out["q1"]["加權5秒全日"] = q1(full_intraday)
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / "results.json").write_text(json.dumps(out, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    report = ROOT / "docs/research/intraday-pattern-results.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(render(out), encoding="utf-8")
    print(f"日K：加權 {len(taiex)} 天、櫃買 {len(tpex)} 天；5秒：使用 {len(sessions)}/{meta['files_at_start']} 天，跳過 {len(meta['skipped'])} 檔")
    print("版本 / 分類              n   開高走低   低於高點≥0.5%")
    for name in ("加權日K", "櫃買日K", *OPENINGS):
        for r in out["q1"][name]:
            if r["period"] == "全部" and r["group"] in ("一般日", "一般週五", "長假前"):
                print(f"{name}/{r['group']}  {r['n']:5d}  {pct(r['metrics']['gap_up_fade']['rate']):>8}  {pct(r['metrics']['high_drop_005']['rate']):>8}")
    print(q1_conclusion(out["q1"]))
    for r in out["q3"]["comparison"]:
        print(f"Q3 {r['group']}: n={r['n']}, 平均收盤報酬 {pct(r['mean_return'])}, 高點0.3%內 {pct(r['within_high_003_rate'])}")
    print("已輸出 data/backtest/intraday-pattern/results.json、docs/research/intraday-pattern-results.md")


if __name__ == "__main__":
    main()
