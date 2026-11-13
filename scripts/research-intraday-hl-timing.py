#!/usr/bin/env python3
"""Offline TAIEX high/low timing research; standard library only.

Run: python3 -I scripts/research-intraday-hl-timing.py
Uses the verified hl_time.py definitions and existing intraday-pattern cache.
Returns are basis points; high/low ties use the first occurrence.
"""
import gzip
import json
import statistics as st
import zlib
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import datetime, timezone
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/backtest/intraday-pattern"
OUT = ROOT / "data/backtest/intraday-hl-timing/results.json"
CHARTS = ROOT / "research/factor-lab/charts/2026-11-13-intraday-hl-timing"
S0, S1 = 32405, 48300  # Skip the stale 09:00:00 print and closing auction.


def clock(t):
    return f"{t // 3600:02}:{t % 3600 // 60:02}"


EDGES = [32400, 33300] + list(range(34200, 46801, 1800)) + [S1]
BUCKETS = [(a, b, f"{clock(a)}–{clock(b)}") for a, b in zip(EDGES, EDGES[1:])]


def number(x):
    return float(str(x).replace(",", ""))


def load_sessions():
    daily = {r["date"]: r for r in json.loads((CACHE / "taiex-daily.json").read_text())["data"]}
    dates = sorted(daily)
    prev = {d: daily[dates[i - 1]]["close"] for i, d in enumerate(dates) if i}
    days, skipped = [], []
    paths = sorted((CACHE / "taiex-5s").glob("*.json.gz"))
    for path in paths:
        try:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                raw = json.load(f)
            fields = raw["fields"]
            ti, pi = fields.index("時間"), fields.index("發行量加權股價指數")
            points = {}
            for item in raw["data"]:
                h, m, s = map(int, item[ti].split(":"))
                t = h * 3600 + m * 60 + s
                if S0 <= t <= S1:
                    points[t] = number(item[pi])
            d = f"{path.name[:4]}-{path.name[4:6]}-{path.name[6:8]}"
            # Same minimum count and daily-calendar rule as the verified prototype.
            if len(points) < 3100 or d not in prev:
                raise ValueError("連續交易資料不足或缺前一日收盤")
            seq = sorted(points.items())
            high, low = max(points.values()), min(points.values())
            days.append(dict(date=d, points=points, times=sorted(points), high=high, low=low,
                             high_time=next(t for t, v in seq if v == high),
                             low_time=next(t for t, v in seq if v == low),
                             open=seq[0][1], close=seq[-1][1], gap=seq[0][1] / number(prev[d]) - 1))
        except (OSError, EOFError, ValueError, KeyError, IndexError, TypeError, UnicodeError, zlib.error) as e:
            skipped.append(dict(file=path.name, reason=str(e)))
    if not days:
        raise ValueError("快取內沒有可用交易日")
    return days, dict(files_at_start=len(paths), skipped=skipped)


def bucket(t):
    return next(label for a, b, label in BUCKETS if a <= t < b or t == b == S1)


def distribution(days):
    hc = Counter(bucket(x["high_time"]) for x in days)
    lc = Counter(bucket(x["low_time"]) for x in days)
    return [dict(bucket=label, minutes=(b-a)/60, high_count=hc[label], low_count=lc[label],
                 high_pct=100*hc[label]/len(days), low_pct=100*lc[label]/len(days))
            for a, b, label in BUCKETS]


def slot_summary(days, t):
    positions, returns = [], []
    for x in days:
        v = x["points"][x["times"][bisect_right(x["times"], t) - 1]]
        if x["high"] > x["low"]:
            positions.append((v - x["low"]) / (x["high"] - x["low"]))
        returns.append((x["close"] / v - 1) * 1e4)
    return dict(time=clock(t), position=st.mean(positions), mean_bp=st.mean(returns),
                median_bp=st.median(returns), close_higher_pct=100*sum(r > 0 for r in returns)/len(days))


def analyze(days, audit):
    groups = {"全部": days, "跳空開高≥0.5%": [x for x in days if x["gap"] >= .005],
              "平開(±0.5%)": [x for x in days if abs(x["gap"]) < .005],
              "跳空開低≤−0.5%": [x for x in days if x["gap"] <= -.005],
              "收紅K": [x for x in days if x["close"] > x["open"]],
              "收黑K": [x for x in days if x["close"] < x["open"]]}
    result = {}
    for name, xs in groups.items():
        result[name] = dict(n=len(xs), buckets=distribution(xs),
                            high_first_pct=100*sum(x["high_time"] < x["low_time"] for x in xs)/len(xs))
        if name not in ("收紅K", "收黑K"):
            result[name]["slots"] = [slot_summary(xs, t) for t in list(range(33300, 47701, 900)) + [S1]]
    years = defaultdict(list)
    for x in days:
        years[x["date"][:4]].append(x)
    yearly = [dict(year=y, n=len(xs),
                   high_before_10_pct=100*sum(x["high_time"] < 36000 for x in xs)/len(xs),
                   low_before_10_pct=100*sum(x["low_time"] < 36000 for x in xs)/len(xs),
                   low_after_12_pct=100*sum(x["low_time"] >= 43200 for x in xs)/len(xs),
                   high_after_12_pct=100*sum(x["high_time"] >= 43200 for x in xs)/len(xs))
              for y, xs in sorted(years.items())]
    xs = [x for x in days if 34200 <= x["high_time"] < 37800]
    ys = [x for x in xs if x["low_time"] > x["high_time"]]
    conditional = dict(n=len(xs), low_after_high_n=len(ys), low_after_high_pct=100*len(ys)/len(xs),
                       buckets=distribution(ys),
                       close_position=st.mean((x["close"]-x["low"])/(x["high"]-x["low"]) for x in ys),
                       low_after_13_pct=100*sum(x["low_time"] >= 46800 for x in ys)/len(ys))
    return dict(generated_at=datetime.now(timezone.utc).isoformat(),
                start=days[0]["date"], end=days[-1]["date"], n=len(days), audit=audit,
                method="加權指數5秒資料；09:00:05–13:25:00；極值同價取首次；至少3100筆；跳空對前一日官方收盤；時點缺值取之前最近一筆；未扣成本。",
                groups=result, yearly=yearly, high_0930_1030=conditional)


def svg_start(title):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 500" font-family="system-ui,sans-serif" font-size="12" fill="#333"><rect width="960" height="500" fill="white"/><title>{escape(title)}</title>',
            f'<text x="480" y="25" text-anchor="middle" font-size="18">{escape(title)}</text>']


def text(x, y, value, anchor="start", color="#333"):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" fill="{color}">{escape(str(value))}</text>'


def grid(parts, low, high, ticks, unit):
    y = lambda v: 405 - (v-low)/(high-low)*325
    parts.append(text(70, 55, unit))
    for v in ticks:
        parts.append(f'<line x1="70" y1="{y(v):.2f}" x2="920" y2="{y(v):.2f}" stroke="{"#777" if v == 0 else "#ddd"}"/>')
        parts.append(text(60, y(v)+4, f"{v:g}", "end"))
    return y


def bars(filename, title, series):
    parts = svg_start(title)
    y = grid(parts, 0, 70 if filename.startswith("02") else 40,
             range(0, 71, 10) if filename.startswith("02") else range(0, 41, 10), "交易日占比（%）")
    for j, (name, values, color) in enumerate(series):
        parts.append(text(350+j*260, 55, name, color=color))
        for i, value in enumerate(values):
            x = 70 + (i+.5)*85 + (j-.5)*25
            parts.append(f'<rect x="{x-11}" y="{y(value):.2f}" width="22" height="{405-y(value):.2f}" fill="{color}"><title>{escape(name)}：{BUCKETS[i][2]}，{value:.1f}%</title></rect>')
            parts.append(text(x, y(value)-6, f"{value:.1f}", "middle", color))
    for i, (_, _, label) in enumerate(BUCKETS):
        start, end = label.split("–")
        parts.append(text(70+(i+.5)*85, 427, start, "middle"))
        parts.append(text(70+(i+.5)*85, 443, "–"+end, "middle"))
    parts.append(text(70, 478, "各柱為桶內日數比例，非每分鐘密度；前兩桶各15分鐘，其後30分鐘，最後13:00–13:25為25分鐘。"))
    (CHARTS / filename).write_text("".join(parts)+"</svg>\n", encoding="utf-8")


def charts(out):
    CHARTS.mkdir(parents=True, exist_ok=True)
    groups = out["groups"]
    bars("01-hl-bucket.svg", f"全日高低點呈 U 型分布（共 {out['n']} 日）", [
        ("全日高點", [b["high_pct"] for b in groups["全部"]["buckets"]], "#c55"),
        ("全日低點", [b["low_pct"] for b in groups["全部"]["buckets"]], "#2679c8")])
    bars("02-red-black.svg", "收紅K與收黑K：高低點時段互為鏡像", [
        (f"紅K日高點（{groups['收紅K']['n']}日）", [b["high_pct"] for b in groups["收紅K"]["buckets"]], "#c55"),
        (f"黑K日低點（{groups['收黑K']['n']}日）", [b["low_pct"] for b in groups["收黑K"]["buckets"]], "#2679c8")])
    parts = svg_start("依開盤跳空分組：各時點買進持有至13:25的平均報酬")
    series = [(name, [s for s in groups[name]["slots"] if s["time"] <= "13:00"], color)
              for name, color in [("平開(±0.5%)", "#2679c8"), ("跳空開高≥0.5%", "#c55"), ("跳空開低≤−0.5%", "#27956b")]]
    values = [s["mean_bp"] for _, rows, _ in series for s in rows]
    low, high = (int(min(values)//5)*5, int(max(values)//5+1)*5)
    y = grid(parts, low, high, range(low, high+1, 5), "平均報酬（bp）")
    for j, (name, rows, color) in enumerate(series):
        parts.append(text(270+j*225, 55, name, color=color))
        points = [(70+i*850/(len(rows)-1), y(s["mean_bp"])) for i, s in enumerate(rows)]
        coords = " ".join(f"{x:.2f},{yy:.2f}" for x, yy in points)
        parts.append(f'<polyline fill="none" stroke="{color}" stroke-width="2" points="{coords}"/>')
        for (x, yy), s in zip(points, rows):
            parts.append(f'<circle cx="{x:.2f}" cy="{yy:.2f}" r="3" fill="{color}"><title>{escape(name)} {s["time"]}：{s["mean_bp"]:+.1f}bp</title></circle>')
    for i, s in enumerate(series[0][1]):
        parts.append(text(70+i*850/15, 428 if i % 2 == 0 else 445, s["time"], "middle"))
    parts.append(text(70, 478, "每15分鐘取一點，持有至13:25；1bp＝0.01%，未扣成本；分組只使用09:00:05相對昨收的跳空。"))
    (CHARTS / "03-buy-to-close.svg").write_text("".join(parts)+"</svg>\n", encoding="utf-8")


def main():
    days, audit = load_sessions()
    out = analyze(days, audit)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    charts(out)
    print(f"樣本 {out['start']}～{out['end']}：{out['n']} 日；略過 {len(audit['skipped'])} 檔")
    for name, group in out["groups"].items():
        first, last = group["buckets"][0], group["buckets"][-1]
        print(f"{name}（{group['n']}日）：09:15前高 {first['high_pct']:.1f}%／低 {first['low_pct']:.1f}%；13:00後高 {last['high_pct']:.1f}%／低 {last['low_pct']:.1f}%；先高後低 {group['high_first_pct']:.1f}%")
        for s in group.get("slots", []):
            print(f"  {s['time']} 位置 {s['position']:.2f}，至13:25 {s['mean_bp']:+.1f}bp")
    print("結果：", OUT.relative_to(ROOT))
    print("圖表：", CHARTS.relative_to(ROOT))


if __name__ == "__main__":
    main()
