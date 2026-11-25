#!/usr/bin/env python3
"""合約負債（預收訂單）研究：合約負債成長的公司，之後營收會不會比較好？股價有沒有超額？

執行（先跑 fetch-contract-liabilities.py 與 research-factor-panel.py）：
  uv run --with numpy python scripts/research-contract-liabilities.py

規則（跑結果前寫死，不中途改）：
  事件：每一季財報的法定期限隔天（Q1 5/16、Q2 8/15、Q3 11/15、Q4 隔年 4/1）之後第一個交易日開盤買進，
        分別持有 20、60 個交易日後開盤賣出。用期限而不是實際公布日，避免偷看早報公司。
  母體：當天有成交、上市滿 60 日、近 20 日平均成交金額 ≥ 2,000 萬元、上一季合約負債 > 0。
  超額報酬：個股報酬減去同一事件母體的等權平均報酬（同一天進出場）。
  訊號（事先登記）：
    rule_qoq10   圖上的規則：合約負債 QoQ > 10% 且存貨 QoQ > 0。
    dcl_q5       合約負債季增金額 ÷ 近四季營收，母體內分五組，看最高組與最低組（用營收縮放，避開小基期）。
    intensity_up 高預收產業（上一季合約負債 ≥ 單季營收 30%）裡，合約負債 QoQ > 10% 且 YoY > 0。
  營收驗證：訊號組下一季營收年增率，和母體中位數比，檢查「合約負債領先營收」這件事本身。
  訓練／驗證切點：2023-01-01 以前的事件為前段、之後為後段，兩段方向要一致才算數。
  顯著性：以「每一季的平均超額」當一筆觀察值，對季做 t 檢定（同一季的股票不是獨立樣本）。
  成本：來回 0.585 個百分點（手續費 0.1425%×2、證交稅 0.3%），扣在淨超額。
輸出：data/backtest/contract-liabilities/results.json，stdout 為精簡摘要。
"""
import importlib.util
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rf", ROOT / "scripts/research-factors.py")
rf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rf)

CL_DIR = ROOT / "data/contract-liabilities-history"
OUT = ROOT / "data/backtest/contract-liabilities"
SPLIT = "2023-01-01"
HOLDS = (20, 60)
COST = 0.00585
MIN_MONEY = 2e7
MIN_AGE = 60


def cl_matrix(quarters, codes):
    col = {c: j for j, c in enumerate(codes)}
    cl = np.full((len(quarters), len(codes)), np.nan)
    inv = np.full_like(cl, np.nan)
    for q, name in enumerate(quarters):
        f = CL_DIR / f"{name}.json"
        if not f.exists():
            continue
        for code, r in json.loads(f.read_text())["stocks"].items():
            j = col.get(code)
            if j is not None:
                cl[q, j] = r["cl"]
                inv[q, j] = r["inv"]
    return cl, inv


def tstat(v):
    v = np.asarray([a for a in v if np.isfinite(a)])
    if len(v) < 3:
        return len(v), float("nan"), float("nan"), float("nan")
    m, s = v.mean(), v.std(ddof=1)
    t = m / (s / math.sqrt(len(v))) if s > 0 else float("nan")
    p = math.erfc(abs(t) / math.sqrt(2)) if np.isfinite(t) else float("nan")  # 常態近似雙尾
    return len(v), float(m), float(t), float(p)


def main():
    dates, codes, d = rf.load_panel()
    x = rf.derived(d)
    x["age"] = d["age"]
    quarters, fin, fin_avail = rf.financial_matrix(dates, codes)
    cl, inv = cl_matrix(quarters, codes)
    rev = fin["rev"]
    _, mrev, mprev, rev_avail = rf.revenue_matrix(dates, codes)
    T = len(dates)

    signals = ("rule_qoq10", "dcl_top", "dcl_bottom", "intensity_up", "dcl_top_revneutral")
    events = []
    per = {s: {h: [] for h in HOLDS} for s in signals}
    revtest = {s: [] for s in signals}
    for q, name in enumerate(quarters):
        if q < 4 or not np.isfinite(cl[q]).any() or not np.isfinite(cl[q - 1]).any():
            continue
        t = int(fin_avail[q])
        if t >= T - 1:
            continue
        money20 = x["money"][t - 20:t].mean(axis=0)      # 進場前一天為止
        prev = t - 1
        univ = x["traded"][prev] & (d["age"][prev] >= MIN_AGE) & (money20 >= MIN_MONEY) & (cl[q - 1] > 0) & np.isfinite(cl[q])
        with np.errstate(invalid="ignore", divide="ignore"):
            qoq = cl[q] / cl[q - 1] - 1
            yoy = cl[q] / cl[q - 4] - 1
            invq = inv[q] / inv[q - 1] - 1
            ttm = rev[q - 3:q + 1].sum(axis=0)
            dcl = (cl[q] - cl[q - 1]) / np.where(ttm > 0, ttm, np.nan)
            intensity = cl[q - 1] / np.where(rev[q - 1] > 0, rev[q - 1], np.nan)
        groups = {
            "rule_qoq10": univ & (qoq > 0.10) & (invq > 0),
            "intensity_up": univ & (intensity >= 0.30) & (qoq > 0.10) & (yoy > 0),
        }
        ok = univ & np.isfinite(dcl)
        neutral_bucket = None
        if ok.sum() >= 50:
            lo, hi = np.nanpercentile(dcl[ok], [20, 80])
            groups["dcl_top"] = ok & (dcl >= hi)
            groups["dcl_bottom"] = ok & (dcl <= lo)
            # 營收中性：進場時已公布的近 3 個月營收年增分三組，各組內取 dcl 前 20%，
            # 超額改用「同組平均」當基準——檢查合約負債是不是只是月營收動能的另一種說法
            m = int(np.searchsorted(rev_avail, t, side="right")) - 1
            with np.errstate(invalid="ignore", divide="ignore"):
                r3 = mrev[m - 2:m + 1].sum(axis=0) / mprev[m - 2:m + 1].sum(axis=0) - 1
            ok3 = ok & np.isfinite(r3)
            if ok3.sum() >= 90:
                cuts = np.nanpercentile(r3[ok3], [33.3, 66.7])
                bucket = np.where(r3 <= cuts[0], 0, np.where(r3 <= cuts[1], 1, 2))
                top_n = np.zeros_like(ok3)
                for b in range(3):
                    mb = ok3 & (bucket == b)
                    top_n |= mb & (dcl >= np.nanpercentile(dcl[mb], 80))
                groups["dcl_top_revneutral"] = top_n
                neutral_bucket = np.where(ok3, bucket, -1)
            else:
                neutral_bucket = None
        ev = {"quarter": name, "entry": dates[t], "universe": int(univ.sum()), "groups": {}}
        # 下一季營收年增（驗證合約負債是否領先營收）
        if q + 1 < len(quarters) and q - 3 >= 0:
            with np.errstate(invalid="ignore", divide="ignore"):
                ry = rev[q + 1] / np.where(rev[q - 3] > 0, rev[q - 3], np.nan) - 1
            med_u = np.nanmedian(ry[univ]) if np.isfinite(ry[univ]).sum() > 20 else np.nan
        else:
            ry, med_u = None, np.nan
        for h in HOLDS:
            te = t + h
            if te >= T:
                continue
            r = rf.forward_returns(x, t, te)
            ru = r[univ & np.isfinite(r)]
            if len(ru) < 50:
                continue
            base = np.expm1(ru).mean()
            for s, mask in groups.items():
                rg = r[mask & np.isfinite(r)]
                if len(rg) < 5:
                    continue
                if s == "dcl_top_revneutral":
                    # 每檔減自己那一組（營收年增同一組）的平均，再取平均
                    rel = []
                    for b in range(3):
                        mb = (neutral_bucket == b) & np.isfinite(r)
                        sel = mb & mask
                        if sel.any():
                            rel.extend(np.expm1(r[sel]) - np.expm1(r[mb]).mean())
                    ex = float(np.mean(rel))
                    per[s][h].append((dates[t], ex))
                    ev["groups"].setdefault(s, {})["n"] = int(len(rg))
                    ev["groups"][s][f"ex{h}"] = round(ex * 100, 2)
                    continue
                ex = float(np.expm1(rg).mean() - base)
                per[s][h].append((dates[t], ex))
                ev["groups"].setdefault(s, {})[f"n"] = int(len(rg))
                ev["groups"][s][f"ex{h}"] = round(ex * 100, 2)
                ev["groups"][s][f"win{h}"] = round(float((np.expm1(rg) > base).mean()) * 100, 1)
        if ry is not None and np.isfinite(med_u):
            for s, mask in groups.items():
                v = ry[mask & np.isfinite(ry)]
                if len(v) >= 5:
                    diff = float(np.median(v) - med_u)
                    revtest[s].append((dates[t], diff))
                    ev["groups"].setdefault(s, {})["revYoYvsUniv"] = round(diff * 100, 1)
        events.append(ev)

    summary = {}
    for s in signals:
        summary[s] = {}
        for h in HOLDS:
            rows = per[s][h]
            allv = [e for _, e in rows]
            a = [e for dt, e in rows if dt < SPLIT]
            b = [e for dt, e in rows if dt >= SPLIT]
            n, m, tt, p = tstat(allv)
            summary[s][f"h{h}"] = {
                "quarters": n, "meanExcessPct": round(m * 100, 2), "netExcessPct": round((m - COST) * 100, 2),
                "t": round(tt, 2), "p": round(p, 3),
                "hitQuartersPct": round(100 * float(np.mean([e > 0 for e in allv])), 1) if allv else None,
                "pre2023": round(float(np.mean(a)) * 100, 2) if a else None,
                "post2023": round(float(np.mean(b)) * 100, 2) if b else None,
            }
        rv = [e for _, e in revtest[s]]
        n, m, tt, p = tstat(rv)
        summary[s]["nextQRevYoY"] = {"quarters": n, "medianDiffPct": round(m * 100, 1), "t": round(tt, 2), "p": round(p, 3)}

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps({"summary": summary, "events": events}, ensure_ascii=False, indent=1))
    print(f"panel last={dates[-1]} events={len(events)}")
    for s in signals:
        print(s, json.dumps(summary[s], ensure_ascii=False))
    make_charts(summary, events)


# ---------------------------------------------------------------- 圖

CHARTS = ROOT / "research/factor-lab/charts/2026-11-24-contract-liabilities"
LABEL = {
    "rule_qoq10": "圖上規則：合約負債季增>10%、存貨季增>0",
    "dcl_top": "合約負債季增金額÷營收 前 20%",
    "dcl_top_revneutral": "同上，但先按月營收年增分組再比",
    "intensity_up": "高預收公司（合約負債≥單季營收30%）且合約負債季增>10%",
    "dcl_bottom": "合約負債季增金額÷營收 後 20%（減少最多）",
}
ORDER = ["rule_qoq10", "dcl_top", "dcl_top_revneutral", "intensity_up", "dcl_bottom"]
C20, C60 = "#397fc3", "#cf7628"


def _esc(v):
    return str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _svg(w, h, title, sub):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" font-family="system-ui,sans-serif" font-size="13" fill="currentColor" role="img"><title>{_esc(title)}</title>',
            _t(w / 2, 29, title, "middle", 20), _t(w / 2, 52, sub, "middle")]


def _t(x, y, v, a="start", size=13, color="currentColor"):
    return f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{a}" font-size="{size}" fill="{color}">{_esc(v)}</text>'


def _l(x1, y1, x2, y2, op=1, color="currentColor", wdt=1):
    return f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{color}" opacity="{op}" stroke-width="{wdt}"/>'


def _r(x, y, w, h, color):
    if w < 0:
        x, w = x + w, -w
    return f'<rect x="{x:.1f}" y="{y:.1f}" width="{max(w, 0.5):.1f}" height="{h:.1f}" fill="{color}"/>'


def _axis(el, left, right, top, bottom, lo, hi, step):
    X = lambda v: left + (right - left) * (v - lo) / (hi - lo)
    v = lo
    while v <= hi + 1e-9:
        el.append(_l(X(v), top, X(v), bottom, 0.35 if abs(v) < 1e-9 else 0.12))
        el.append(_t(X(v), bottom + 15, f"{v:g}", "middle", 11))
        v += step
    return X


def make_charts(summary, events):
    CHARTS.mkdir(parents=True, exist_ok=True)
    # 1. 各訊號平均超額與 95% 區間
    w, h = 1040, 120 + 70 * len(ORDER)
    el = _svg(w, h, "進場後 20 日、60 日的平均超額報酬", "以季為單位平均（百分點，未扣成本）｜細線為 95% 信賴區間｜超額＝減去同季母體等權平均")
    el += [f'<circle cx="400" cy="76" r="4" fill="{C20}"/>', _t(412, 80, "20 個交易日"), f'<circle cx="540" cy="76" r="4" fill="{C60}"/>', _t(552, 80, "60 個交易日")]
    X = _axis(el, 470, 1000, 100, h - 30, -5, 7, 1)
    for i, s in enumerate(ORDER):
        y = 110 + 70 * i
        el.append(_t(460, y + 26, LABEL[s], "end", 12))
        for k, (hk, col) in enumerate((("h20", C20), ("h60", C60))):
            r = summary[s][hk]
            m, t = r["meanExcessPct"], r["t"]
            se = abs(m / t) if t else 0
            yy = y + 8 + k * 24
            el.append(_r(X(0), yy, X(m) - X(0), 16, col))
            el.append(_l(X(m - 1.96 * se), yy + 8, X(m + 1.96 * se), yy + 8, 0.9))
            el.append(_t(X(max(m + 1.96 * se, 0)) + 6, yy + 13, f"{m:+.2f}", "start", 11))
    (CHARTS / "01-excess.svg").write_text("\n".join(el + ["</svg>", ""]))

    # 2. 逐年 60 日超額
    show = [("dcl_top", "#2f8f5b"), ("intensity_up", C60), ("dcl_bottom", "#b5484b")]
    short = {"dcl_top": "合約負債增加最多 20%", "intensity_up": "高預收公司且季增>10%", "dcl_bottom": "合約負債減少最多 20%"}
    years = sorted({e["entry"][:4] for e in events})
    w, h = 1040, 140 + 62 * len(years)
    el = _svg(w, h, "逐年看：60 個交易日平均超額報酬", "以進場年份分組（百分點）｜2026 年只到 2026Q1 季報")
    for k, (s, col) in enumerate(show):
        el += [f'<circle cx="{150 + 270 * k}" cy="76" r="4" fill="{col}"/>', _t(162 + 270 * k, 80, short[s], "start", 12)]
    X = _axis(el, 120, 1000, 100, h - 30, -6, 12, 2)
    for i, yv in enumerate(years):
        y = 108 + 62 * i
        el.append(_t(105, y + 30, yv, "end", 13))
        for k, (s, col) in enumerate(show):
            vals = [e["groups"][s]["ex60"] for e in events if e["entry"][:4] == yv and "ex60" in e["groups"].get(s, {})]
            if not vals:
                continue
            m = sum(vals) / len(vals)
            yy = y + 4 + k * 18
            el.append(_r(X(0), yy, X(max(min(m, 12), -6)) - X(0), 14, col))
            el.append(_t(X(max(m, 0)) + 6, yy + 11, f"{m:+.1f}", "start", 11))
    (CHARTS / "02-yearly.svg").write_text("\n".join(el + ["</svg>", ""]))

    # 3. 下一季營收年增
    w, h = 1040, 120 + 46 * len(ORDER)
    el = _svg(w, h, "合約負債有沒有領先營收？", "下一季單季營收年增率：訊號組中位數 − 母體中位數（百分點），以季平均")
    X = _axis(el, 470, 1000, 80, h - 30, -5, 20, 5)
    for i, s in enumerate(ORDER):
        y = 92 + 46 * i
        m = summary[s]["nextQRevYoY"]["medianDiffPct"]
        el.append(_t(460, y + 17, LABEL[s], "end", 12))
        el.append(_r(X(0), y + 4, X(m) - X(0), 18, "#2f8f5b" if m > 0 else "#b5484b"))
        el.append(_t(X(max(m, 0)) + 6, y + 18, f"{m:+.1f}", "start", 12))
    (CHARTS / "03-revenue.svg").write_text("\n".join(el + ["</svg>", ""]))


if __name__ == "__main__":
    main()
