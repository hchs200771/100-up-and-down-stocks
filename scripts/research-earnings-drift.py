#!/usr/bin/env python3
"""財報公布後漂移：在「實際公布日」隔天買進財報亮眼的公司，有沒有超額報酬？

執行（先跑 fetch-contract-liabilities.py、fetch-quarterly-financials.ts、research-factor-panel.py）：
  uv run --with numpy python scripts/research-earnings-drift.py

規則（跑結果前寫死，不中途改）：
  公布日：會計師核閱／查核報告日（tifrs-ar:ReviewAuditDate），缺的用董事會通過日。必須落在季底之後、
          申報期限 +7 天以內，否則丟掉（多半是更正重編）。
  進場：公布日「之後」第一個交易日開盤（公布常在盤後，當天不能買）。持有 20、60 個交易日後開盤賣出。
  對照：同一批公司改在申報期限隔天開盤買（舊研究的做法），看兩者差多少——差額就是早公布那段被跳過的漲幅。
  母體：進場前一天有成交、上市滿 60 日、近 20 日平均成交金額 ≥ 2,000 萬元、一般產業（有營業成本）。
  超額：個股報酬 − 同一進出場日全母體等權平均。
  驚喜指標（公布日當天都已知道；營收在月營收早已公布，所以重點放在獲利率）：
    gm_yoy       單季毛利率 − 去年同季
    opm_yoy      單季營業利益率 − 去年同季
    eps_yoy      (單季 EPS − 去年同季) ÷ 進場前一天收盤
    margin_surp  (單季 EPS − 去年同季 EPS × 單季營收 ÷ 去年同季營收) ÷ 收盤
                 ＝營收已知的情況下，獲利比「照去年利潤率」推估多出多少；只取去年同季 EPS > 0
    dcl          合約負債季增 ÷ 近四季營收（沿用合約負債研究）
  每季把當季所有公布事件依指標分五組（組界用當季全部事件，屬於事後組界，結論要再用前一季組界複驗），
  看最高組與最低組的超額。另外依公布時間分「提早（期限前 15 天以前）」與「接近期限」兩群。
  顯著性：每季平均當一筆，對季 t 檢定。主要比較 = 5 指標 × 2 持有期 × 最高／最低 = 20 項，Bonferroni p < 0.0025。
  成本：來回 0.585 個百分點。前後段切點 2023-01-01。
輸出：data/backtest/earnings-drift/results.json，stdout 精簡摘要。
"""
import importlib.util
import json
import math
from datetime import date, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("rf", ROOT / "scripts/research-factors.py")
rf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rf)

CL_DIR = ROOT / "data/contract-liabilities-history"
FIN_DIR = ROOT / "data/financials-history"
OUT = ROOT / "data/backtest/earnings-drift"
SPLIT = "2023-01-01"
HOLDS = (20, 60)
COST = 0.00585
MIN_MONEY = 2e7
MIN_AGE = 60
METRICS = ("gm_yoy", "opm_yoy", "eps_yoy", "margin_surp", "dcl")
QEND = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}


def deadline(qs):
    y, s = int(qs[:4]), int(qs[5])
    return {1: date(y, 5, 15), 2: date(y, 8, 14), 3: date(y, 11, 14), 4: date(y + 1, 3, 31)}[s]


def load_fin(codes):
    """單季數字（累計相減）。回傳 quarters 清單與 {rev,cost,op,eps} 矩陣。"""
    col = {c: j for j, c in enumerate(codes)}
    files = sorted(FIN_DIR.glob("*Q*.json"))
    qs = [f.stem for f in files]
    cum = {k: np.full((len(qs), len(codes)), np.nan) for k in ("rev", "cost", "op", "eps")}
    for q, f in enumerate(files):
        for code, r in json.loads(f.read_text())["stocks"].items():
            j = col.get(code)
            if j is None:
                continue
            for k in cum:
                if r.get(k) is not None:
                    cum[k][q, j] = r[k]
    single = {k: np.full_like(v, np.nan) for k, v in cum.items()}
    for q, name in enumerate(qs):
        s = int(name[-1])
        for k in cum:
            if s == 1:
                single[k][q] = cum[k][q]
            elif q > 0 and qs[q - 1] == f"{name[:4]}Q{s - 1}":
                single[k][q] = cum[k][q] - cum[k][q - 1]
    return qs, single


def load_cl(qs, codes):
    col = {c: j for j, c in enumerate(codes)}
    cl = np.full((len(qs), len(codes)), np.nan)
    when = {}
    for q, name in enumerate(qs):
        f = CL_DIR / f"{name}.json"
        if not f.exists():
            continue
        y, s = int(name[:4]), int(name[5])
        lo = date(y, *QEND[s])
        hi = deadline(name) + timedelta(days=7)
        for code, r in json.loads(f.read_text())["stocks"].items():
            j = col.get(code)
            if j is None:
                continue
            cl[q, j] = r["cl"]
            dt = r.get("reviewDate") or r.get("boardDate")
            if dt:
                try:
                    dd = date.fromisoformat(dt)
                except ValueError:
                    continue
                if lo < dd <= hi:
                    when[(q, j)] = dd.isoformat()
        # 財報檔沒有公布日的（2019Q1–2022Q2 只抓到第一版）改用重大訊息「董事會通過財報」日
        f2 = ROOT / "data/financial-report-dates" / f"{name}.json"
        if f2.exists():
            for code, r in json.loads(f2.read_text())["stocks"].items():
                j = col.get(code)
                if j is None or (q, j) in when:
                    continue
                dd = date.fromisoformat(r["date"])
                if lo < dd <= hi:
                    when[(q, j)] = dd.isoformat()
    return cl, when


def tstat(v):
    v = np.asarray([a for a in v if np.isfinite(a)])
    if len(v) < 3:
        return len(v), float("nan"), float("nan"), float("nan")
    m, s = v.mean(), v.std(ddof=1)
    t = m / (s / math.sqrt(len(v))) if s > 0 else float("nan")
    return len(v), float(m), float(t), float(math.erfc(abs(t) / math.sqrt(2))) if np.isfinite(t) else float("nan")


START = "2020Q3"


def main():
    dates, codes, d = rf.load_panel()
    x = rf.derived(d)
    x["age"] = d["age"]
    T = len(dates)
    qs, fin = load_fin(codes)
    cl, when = load_cl(qs, codes)
    rev, cost, op, eps = fin["rev"], fin["cost"], fin["op"], fin["eps"]
    with np.errstate(invalid="ignore", divide="ignore"):
        gm = (rev - cost) / np.where(rev > 0, rev, np.nan)
        opm = op / np.where(rev > 0, rev, np.nan)

    # 每個進場日 → 母體與報酬（快取）
    cache = {}

    def fwd(t, h):
        key = (t, h)
        if key not in cache:
            r = rf.forward_returns(x, t, t + h) if t + h < T else None
            if r is None:
                cache[key] = None
            else:
                money20 = x["money"][t - 20:t].mean(axis=0)
                univ = x["traded"][t - 1] & (d["age"][t - 1] >= MIN_AGE) & (money20 >= MIN_MONEY) & np.isfinite(r)
                ar = np.expm1(r)
                cache[key] = (ar - ar[univ].mean(), univ)
        return cache[key]

    rows = []  # 每筆事件
    for q, name in enumerate(qs):
        # 2020Q2 以前重大訊息只有約 300 家（偏大公司）自願公告，選樣偏誤，不用
        if q < 4 or name < START:
            continue
        dl_t = rf.next_trading_index(dates, (deadline(name) + timedelta(days=1)).isoformat())
        for j in range(len(codes)):
            dt = when.get((q, j))
            if dt is None:
                continue
            t = rf.next_trading_index(dates, (date.fromisoformat(dt) + timedelta(days=1)).isoformat())
            if t < 61 or t >= T - 1:
                continue
            px = d["close"][t - 1, j]
            if not (px > 0):
                continue
            ttm = np.nansum(rev[q - 3:q + 1, j]) if np.isfinite(rev[q - 3:q + 1, j]).all() else np.nan
            m = {
                "gm_yoy": gm[q, j] - gm[q - 4, j],
                "opm_yoy": opm[q, j] - opm[q - 4, j],
                "eps_yoy": (eps[q, j] - eps[q - 4, j]) / px,
                "margin_surp": (eps[q, j] - eps[q - 4, j] * rev[q, j] / rev[q - 4, j]) / px
                if eps[q - 4, j] > 0 and rev[q - 4, j] > 0 else np.nan,
                "dcl": (cl[q, j] - cl[q - 1, j]) / ttm if ttm and ttm > 0 and np.isfinite(cl[q - 1, j]) else np.nan,
            }
            if not np.isfinite(cost[q, j]):
                continue
            early = (deadline(name) - date.fromisoformat(dt)).days >= 15
            ev = {"q": name, "j": j, "t": t, "dl_t": dl_t, "date": dt, "early": early, **m}
            for h in HOLDS:
                fr = fwd(t, h)
                ev[f"ex{h}"] = float(fr[0][j]) if fr and fr[1][j] else np.nan
                fr2 = fwd(dl_t, h) if dl_t < T - 1 else None
                ev[f"dl{h}"] = float(fr2[0][j]) if fr2 and fr2[1][j] else np.nan
            rows.append(ev)

    # 依季分五組
    byq = {}
    for ev in rows:
        byq.setdefault(ev["q"], []).append(ev)
    res = {}
    for mname in METRICS:
        for side in ("top", "bottom"):
            for h in HOLDS:
                for key in (f"ex{h}", f"dl{h}"):
                    res.setdefault(mname, {}).setdefault(side, {}).setdefault(key, [])
    timing = {g: {h: [] for h in HOLDS} for g in ("early_top", "late_top", "early_all", "late_all")}
    counts = {}
    oos = {m: {side: {h: [] for h in HOLDS} for side in ("top", "bottom")} for m in METRICS}
    hist = {m: [] for m in METRICS}   # 前幾季的指標值（每天掃描時只知道過去的分布）
    for name, evs in sorted(byq.items()):
        for mname in METRICS:
            v = np.array([e[mname] for e in evs], dtype=float)
            ok = np.isfinite(v)
            if ok.sum() < 100:
                continue
            # 前 4 季組界（真正可以事前知道的門檻）
            if len(hist[mname]) >= 4:
                past = np.concatenate(hist[mname][-4:])
                plo, phi = np.percentile(past, [20, 80])
                for side, sel in (("top", v >= phi), ("bottom", v <= plo)):
                    for h in HOLDS:
                        a = [e[f"ex{h}"] for e, s_, o in zip(evs, sel, ok) if s_ and o and np.isfinite(e[f"ex{h}"])]
                        if len(a) >= 10:
                            oos[mname][side][h].append((name, float(np.mean(a))))
            hist[mname].append(v[ok])
            lo, hi = np.percentile(v[ok], [20, 80])
            for side, sel in (("top", v >= hi), ("bottom", v <= lo)):
                grp = [e for e, s, o in zip(evs, sel, ok) if s and o]
                counts.setdefault(mname, []).append(len(grp))
                for h in HOLDS:
                    for key in (f"ex{h}", f"dl{h}"):
                        a = [e[key] for e in grp if np.isfinite(e[key])]
                        if len(a) >= 10:
                            res[mname][side][key].append((name, float(np.mean(a))))
            if mname == "margin_surp":
                for h in HOLDS:
                    for g, cond in (("early_top", lambda e, s: e["early"] and s), ("late_top", lambda e, s: not e["early"] and s),
                                    ("early_all", lambda e, s: e["early"]), ("late_all", lambda e, s: not e["early"])):
                        a = [e[f"ex{h}"] for e, s, o in zip(evs, v >= hi, ok) if o and cond(e, s) and np.isfinite(e[f"ex{h}"])]
                        if len(a) >= 10:
                            timing[g][h].append((name, float(np.mean(a))))

    def summ(pairs):
        n, m, t, p = tstat([b for _, b in pairs])
        pre = [b for a, b in pairs if a < "2023"]
        post = [b for a, b in pairs if a >= "2023"]
        return {"quarters": n, "meanPct": round(m * 100, 2), "netPct": round((m - COST) * 100, 2), "t": round(t, 2), "p": round(p, 4),
                "hitPct": round(100 * float(np.mean([b > 0 for _, b in pairs])), 1) if pairs else None,
                "pre2023": round(float(np.mean(pre)) * 100, 2) if pre else None,
                "post2023": round(float(np.mean(post)) * 100, 2) if post else None,
                "byQuarter": {a: round(b * 100, 2) for a, b in pairs}}

    summary = {m: {s: {k: summ(v) for k, v in sides.items()} for s, sides in res[m].items()} for m in METRICS}
    for m in METRICS:
        summary[m]["avgGroupSize"] = round(float(np.mean(counts.get(m, [0]))))
    tsum = {g: {h: summ(v) for h, v in hh.items()} for g, hh in timing.items()}
    for m in METRICS:
        summary[m]["priorCutoff"] = {side: {f"ex{h}": summ(oos[m][side][h]) for h in HOLDS} for side in ("top", "bottom")}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps({"events": len(rows), "panelLast": dates[-1], "summary": summary, "timing": tsum}, ensure_ascii=False, indent=1))
    print(f"panel last={dates[-1]} events={len(rows)} quarters={len(byq)}")
    for m in METRICS:
        for s in ("top", "bottom"):
            line = " ".join(f"{k}={summary[m][s][k]['meanPct']:+.2f}(t{summary[m][s][k]['t']},pre{summary[m][s][k]['pre2023']},post{summary[m][s][k]['post2023']})" for k in ("ex20", "dl20", "ex60", "dl60"))
            print(f"{m:12s} {s:6s} n≈{summary[m]['avgGroupSize']} {line}")
    for m in METRICS:
        pc = summary[m]["priorCutoff"]
        print(f"{m:12s} 前4季組界 " + " ".join(f"{side}{h}={pc[side][f'ex{h}']['meanPct']:+.2f}(t{pc[side][f'ex{h}']['t']},n{pc[side][f'ex{h}']['quarters']})" for side in ("top", "bottom") for h in HOLDS))
    for g in tsum:
        print(g, {h: (tsum[g][h]["meanPct"], tsum[g][h]["t"]) for h in HOLDS})



# ---- 圖（借用合約負債研究的 SVG 小工具）----
def make_charts():
    import importlib.util
    spec = importlib.util.spec_from_file_location("clr", ROOT / "scripts/research-contract-liabilities.py")
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    out = ROOT / "research/factor-lab/charts/2026-11-25-earnings-drift"
    out.mkdir(parents=True, exist_ok=True)
    res = json.loads((OUT / "results.json").read_text())
    S = res["summary"]
    lab = {"margin_surp": "獲利驚喜", "eps_yoy": "EPS 年增", "gm_yoy": "毛利率年增", "opm_yoy": "營益率年增", "dcl": "合約負債季增"}
    order = ["margin_surp", "eps_yoy", "gm_yoy", "opm_yoy", "dcl"]
    CA, CD = "#397fc3", "#9aa3ad"
    # 1. 公布日進場 vs 期限進場，20 日
    rows = [(m, side) for m in order for side in ("top", "bottom")]
    w, h = 1040, 120 + 62 * len(rows)
    el = g._svg(w, h, "公布隔天買 vs 期限隔天買：20 個交易日平均超額報酬", "以季為單位平均（百分點，未扣成本）｜細線為 95% 信賴區間｜2020Q3–2026Q2")
    el += [f'<circle cx="360" cy="76" r="4" fill="{CA}"/>', g._t(372, 80, "公布隔天開盤買"), f'<circle cx="540" cy="76" r="4" fill="{CD}"/>', g._t(552, 80, "法定期限隔天開盤買")]
    X = g._axis(el, 330, 1000, 100, h - 30, -4, 3, 1)
    for i, (m, side) in enumerate(rows):
        y = 108 + 62 * i
        el.append(g._t(320, y + 26, f"{lab[m]} {'最高' if side == 'top' else '最低'} 20%", "end", 12))
        for k, (key, col) in enumerate((("ex20", CA), ("dl20", CD))):
            r = S[m][side][key]
            mm, t = r["meanPct"], r["t"]
            se = abs(mm / t) if t else 0
            yy = y + 6 + k * 22
            el.append(g._r(X(0), yy, X(mm) - X(0), 15, col))
            el.append(g._l(X(mm - 1.96 * se), yy + 7.5, X(mm + 1.96 * se), yy + 7.5, 0.9))
            el.append(g._t(X(max(mm + 1.96 * se, 0)) + 6, yy + 12, f"{mm:+.2f}", "start", 11))
    (out / "01-entry.svg").write_text("\n".join(el + ["</svg>", ""]))
    # 2. 逐年：獲利驚喜最高／最低 20%，公布隔天買、20 日
    ser = [("top", "#2f8f5b", "獲利驚喜最高 20%"), ("bottom", "#b5484b", "獲利驚喜最低 20%")]
    by = {}
    for side, _, _ in ser:
        for q, v in S["margin_surp"][side]["ex20"]["byQuarter"].items():
            by.setdefault(q[:4], {}).setdefault(side, []).append(v)
    years = sorted(by)
    w, h = 1040, 140 + 50 * len(years)
    el = g._svg(w, h, "逐年看：獲利驚喜組公布隔天買進 20 日超額", "依財報所屬年份分組，各季平均（百分點）")
    for k, (_, col, name) in enumerate(ser):
        el += [f'<circle cx="{300 + 240 * k}" cy="76" r="4" fill="{col}"/>', g._t(312 + 240 * k, 80, name, "start", 12)]
    X = g._axis(el, 120, 1000, 100, h - 30, -6, 6, 2)
    for i, yv in enumerate(years):
        y = 108 + 50 * i
        el.append(g._t(105, y + 22, yv, "end", 13))
        for k, (side, col, _) in enumerate(ser):
            v = by[yv].get(side)
            if not v:
                continue
            mm = sum(v) / len(v)
            yy = y + 4 + k * 18
            el.append(g._r(X(0), yy, X(max(min(mm, 6), -6)) - X(0), 14, col))
            el.append(g._t(X(max(mm, 0)) + 6, yy + 11, f"{mm:+.1f}", "start", 11))
    (out / "02-yearly.svg").write_text("\n".join(el + ["</svg>", ""]))


if __name__ == "__main__":
    import sys
    if "--charts-only" not in sys.argv:
        main()
    make_charts()
