#!/usr/bin/env python3
"""Forward check of the frozen option-range rules on 2026 data.

Same-weekday straddle levels (mean_high / mean_low) and Tuesday max-OI bands
for Wednesday expiry, exactly as research-option-range.py defines them. Strata
cuts still come from 2019–2022 only; nothing is refit. Only rows dated on/after
--since are evaluated.

Inputs (all cached under data/backtest/, git-ignored):
  weekly-straddle/2026.zip           packed from TAIFEX monthly downloads
  option-range/settlements-2026.json official final settlement prices
  option-range/intraday/<date>-quotes.json  TWSE 5-second TAIEX, Wednesdays
Use --fetch to download missing settlements / 5-second quotes; requests stop at
the first non-JSON (blocked) response instead of retrying.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load("option_range", "scripts/research-option-range.py")
F = load("expiry_intraday", "scripts/fetch-option-expiry-intraday.py")
common, oi_parser, CACHE = R.common, R.oi_parser, R.CACHE


def fetch_settlements(year):
    target = CACHE / f"settlements-{year}.json"
    if target.exists():
        return json.loads(target.read_text())
    url = (f"https://www.taifex.com.tw/cht/5/optIndxFSP?start_year={year}&start_month=01"
           f"&end_year={year}&end_month=12")
    with urllib.request.urlopen(url, timeout=45) as response:
        raw = response.read()
    data = F.parse_settlements(raw.decode("utf-8"), min_count=20)
    saved = {"source": url, "source_sha256": hashlib.sha256(raw).hexdigest(), "data": data}
    target.write_text(json.dumps(saved, indent=2))
    print(f"Cached {len(data)} {year} final settlements", flush=True)
    return saved


def fetch_intraday(dates, prices, delay, allow_fetch):
    audit = {"source": F.ENDPOINT, "requested": dates, "valid": [], "invalid": {}, "stopped": None, "missing": []}
    for date in dates:
        target = F.CACHE / f"{date}.json.gz"
        compact = F.CACHE / f"{date}-quotes.json"
        if compact.exists():
            audit["valid"].append(date)
            continue
        if not target.exists() and not allow_fetch:
            audit["missing"].append(date)
            continue
        try:
            if target.exists():
                raw = gzip.decompress(target.read_bytes())
            else:
                url = f"{F.ENDPOINT}?response=json&date={date.replace('-', '')}"
                with urllib.request.urlopen(url, timeout=45) as response:
                    raw = response.read()
                if not raw.lstrip().startswith(b"{"):
                    raise RuntimeError(f"non-JSON response {raw[:100]!r}; stop requests")
                target.write_bytes(gzip.compress(raw, mtime=0))
                time.sleep(delay)
            points = F.parse_quotes(json.loads(raw), date, prices[date])
            compact.write_text(json.dumps({"date": date, "source": F.ENDPOINT,
                                           "raw_sha256": hashlib.sha256(raw).hexdigest(), "points": points}))
            audit["valid"].append(date)
            print(f"{date}: {len(points)} validated quotes", flush=True)
        except ValueError as error:
            audit["invalid"][date] = str(error)
            print(f"{date}: invalid: {error}", flush=True)
        except Exception as error:
            audit["stopped"] = {"date": date, "reason": str(error)}
            print(f"Stopped: {audit['stopped']}", flush=True)
            break
    return audit


def pct(x, digits=1):
    return "—" if x is None else f"{x * 100:.{digits}f}%"


def pp(x):
    return "—" if x is None else f"{x * 100:+.1f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="2026-01-01")
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--delay", type=float, default=2)
    parser.add_argument("--draws", type=int, default=5000)
    args = parser.parse_args()
    year = int(args.since[:4])
    prices = {r["date"]: r for r in json.loads((ROOT / "research/wide-market/benchmark-input.json").read_text())
              ["benchmarkTotalReturn"]["TaiwanStockPrice"]}
    calendar = set(prices)

    # ---- inputs ----
    settlement_source = fetch_settlements(year) if args.fetch or (CACHE / f"settlements-{year}.json").exists() else None
    if settlement_source is None:
        raise SystemExit(f"missing settlements-{year}.json; rerun with --fetch")
    settlements = {**json.loads((CACHE / "settlements.json").read_text())["data"], **settlement_source["data"]}
    wednesdays = [d for d in sorted(prices) if d >= args.since and dt.date.fromisoformat(d).weekday() == 2
                  and (dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat() in prices]
    intraday = fetch_intraday(wednesdays, prices, args.delay, args.fetch)
    (F.CACHE / f"audit-forward-{year}.json").write_text(json.dumps(intraday, indent=2))

    chains = {}
    for y in range(2019, year + 1):
        derived = common.CACHE / f"{y}-atm.json"
        if not derived.exists():
            chain, audit = common.parse_year(common.CACHE / f"{y}.zip", prices, calendar)
            derived.write_text(json.dumps({"chains": chain, "audit": audit}, ensure_ascii=False))
        chains.update(json.loads(derived.read_text())["chains"])

    # ---- straddle level vs same weekday ----
    base_rows = common.make_observations(chains, prices)
    risk_rows = R.add_weekday_history(base_rows, prices)
    cuts = R.set_risk_strata(risk_rows)  # cuts from < 2023 only
    forward = [r for r in risk_rows if r["date"] >= args.since]
    risk = {"cuts": cuts, "dates": [forward[0]["date"], forward[-1]["date"]] if forward else None,
            "observations": len(forward),
            "summary": {s: R.summarize_risk(forward, s) for s in (*R.SIGNALS, "percentile_high", "percentile_low")},
            "bootstrap": R.risk_bootstrap(forward, args.draws)}

    # ---- max-OI band ----
    oi_cache = CACHE / f"{year}-oi.json"
    if not oi_cache.exists():
        recs, audit = oi_parser.parse_archive(common.CACHE / f"{year}.zip", prices, lambda c: settlements.get(c, {}).get("date"))
        oi_cache.write_text(json.dumps({"records": recs, "audit": audit,
                                        "archive_sha256": hashlib.sha256((common.CACHE / f"{year}.zip").read_bytes()).hexdigest()}))
    records = json.loads(oi_cache.read_text())["records"]
    oi_rows, oi_audit = R.oi_observations(records, settlements, prices, risk_rows, chain_years=range(2019, year + 1))
    oi_rows = [r for r in oi_rows if r["date"] >= args.since]
    oi = {"observations": len(oi_rows), "audit": oi_audit,
          "with_intraday": sum(r["has_intraday"] for r in oi_rows),
          "all": {m: R.summarize_oi(oi_rows, m) for m in ("global", "otm")},
          "weekly": R.summarize_oi([r for r in oi_rows if r["type"] == "weekly"], "global"),
          "monthly": R.summarize_oi([r for r in oi_rows if r["type"] == "monthly"], "global"),
          "bootstrap": R.oi_bootstrap(oi_rows, args.draws),
          "gaps": {m: R.gap_summary(oi_rows, m) for m in ("global", "otm")},
          "joint": {b: R.summarize_oi([r for r in oi_rows if r["risk_bucket"] == b], "global") for b in ("high10", "middle80", "low10")},
          "cases": [{"expiry": r["expiry"], "contract": r["contract"],
                     "lower": r["global"]["walls"]["lower"] if r["global"]["walls"] else None,
                     "upper": r["global"]["walls"]["upper"] if r["global"]["walls"] else None,
                     "outcomes": r["global"]["outcomes"]} for r in oi_rows]}
    results = {"since": args.since, "risk": risk, "oi": oi,
               "intraday": {k: (len(v) if isinstance(v, list) else v) for k, v in intraday.items() if k != "source"}}
    (CACHE / f"forward-{year}.json").write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str))

    # ---- compare with frozen 2023–2025 validation ----
    base = json.loads((CACHE / "results.json").read_text())
    bv_risk = base["risk"]["periods"]["validation"]
    bv_oi = base["oi"]["validation"]["all"]["global"]

    lines = [f"# 價平合同星期比較與最大OI區間：{year} 前瞻檢查", "",
             "由 `scripts/forward-option-range.py` 產生。規則、門檻與分層切點都沿用[原研究](option-range-review.md)"
             "（切點只用2019–2022），沒有重新調整；這裡只評估規則凍結後的資料。", ""]
    if risk["dates"]:
        lines.append(f"價平合：{risk['dates'][0]}～{risk['dates'][1]}，{risk['observations']}個有效觀察日。"
                     f"OI區間：{oi['observations']}個週二→週三結算案例，其中{oi['with_intraday']}期有5秒資料。")
    lines += ["", "## 價平合：同星期平均的高／低檔", "",
              "三日大行情＝訊號收盤後三個交易日內，指數最高或最低偏離訊號收盤至少2%。控制後差＝與同星期、同到期天數、"
              "相同近期波動／當日漲跌／盤中振幅分層的非訊號日相比。",
              "", "| 規則 | 期間 | 訊號日 | 三日大行情：訊號日 | 三日大行情：其他日 | 控制後差(pp) | 配對訊號 |",
              "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    names = {"mean_high": "同星期平均1.5倍以上", "mean_low": "同星期平均2/3以下"}
    for s in R.SIGNALS:
        for label, src in (("2023–2025", bv_risk[s]), (str(year), risk["summary"][s])):
            b = src["big3"]
            lines.append(f"| {names[s]} | {label} | {src['events']} | {pct(b['event'])} | {pct(b['control'])} | "
                         f"{pp(b['difference'])} | {b['matched_events']} |")
    lines += ["", "| 比較（{}） | 95%區間(pp) | 說明 |".format(year), "| --- | --- | --- |"]
    for key, b in risk["bootstrap"].items():
        s, o = key.split(":")
        if o != "big3":
            continue
        ci = "—" if b["ci95"][0] is None else f"{pp(b['ci95'][0])}～{pp(b['ci95'][1])}"
        lines.append(f"| {names[s]}／三日 | {ci} | {b.get('reason', '')} |")

    lines += ["", "## 最大OI區間：週二OI預測週三", "",
              "下界＝賣權最大OI履約價、上界＝買權最大OI履約價，只用週二一般盤結束後可知的OI。"
              "同寬對照＝相同寬度、以週二收盤為中心，用來看履約價「位置」有沒有額外效果。", "",
              "| 週三結果 | 2023–2025 OI | 2023–2025 同寬 | {y} OI | {y} 同寬 | {y} 配對差(pp) | {y} 95%區間(pp) |".format(y=year),
              "| --- | ---: | ---: | ---: | ---: | ---: | --- |"]
    labels = {"whole_inside": "全天高低都在內", "majority_inside": "超過一半盤中時間在內",
              "close_inside": "收盤在內", "settlement_inside": "最後結算價在內"}
    cur = oi["all"]["global"]
    for outcome in R.RANGE_OUTCOMES:
        b_old, b_new = bv_oi[outcome], cur[outcome]
        boot = oi["bootstrap"][f"global:{outcome}"]
        ci = "—" if boot["ci95"][0] is None else f"{pp(boot['ci95'][0])}～{pp(boot['ci95'][1])}"
        lines.append(f"| {labels[outcome]} | {pct(b_old['oi'])} | {pct(b_old['controls']['same_width']['mean'])} | "
                     f"{pct(b_new['oi'])}（n={b_new['n']}） | {pct(b_new['controls']['same_width']['mean'])} | "
                     f"{pp(b_new['controls']['same_width']['paired_difference'])} | {ci} |")
    lines += ["", f"OI區間中位寬度：2023–2025 約指數的 {pct(bv_oi['median_width_pct'], 2)}，{year} 約 {pct(cur['median_width_pct'], 2)}。"
              f"週選 {oi['weekly']['valid']} 期全天守住 {pct(oi['weekly']['whole_inside']['oi'])}；"
              f"月選 {oi['monthly']['valid']} 期 {pct(oi['monthly']['whole_inside']['oi'])}。", ""]
    lines += ["### 開盤突破（週二收盤在區間內、週三開盤跨出）", "", "| 方向 | 次數 | 盤中碰回界線 | 收盤回區間 | 開盤逆勢到收盤平均報酬 |", "| --- | ---: | ---: | ---: | ---: |"]
    for side, name in (("above", "開在上界以上"), ("below", "開在下界以下")):
        g = oi["gaps"]["global"][side]
        lines.append(f"| {name} | {g['n']} | {pct(g['touch_reentry'])} | {pct(g['close_inside'])} | {pct(g['fade_mean_return'], 2)} |")
    lines += ["", "### 依價平合風險分組（描述）", "", "| 價平合位置 | 期數 | 中位區間寬度 | 全天守住 |", "| --- | ---: | ---: | ---: |"]
    for b, name in (("high10", "歷史最高一成"), ("middle80", "中間八成"), ("low10", "歷史最低一成")):
        j = oi["joint"][b]
        lines.append(f"| {name} | {j['valid']} | {pct(j['median_width_pct'], 2)} | {pct(j['whole_inside']['oi'])} |")
    lines += ["", f"5秒資料：要求 {len(wednesdays)} 天、有效 {len(intraday['valid'])} 天"
              + (f"、無效 {len(intraday['invalid'])} 天" if intraday["invalid"] else "")
              + (f"、未抓 {len(intraday['missing'])} 天" if intraday["missing"] else "")
              + (f"；在 {intraday['stopped']['date']} 停止：{intraday['stopped']['reason']}" if intraday["stopped"] else "") + "。"]
    dest = ROOT / "docs/option-range-forward-results.md"
    dest.write_text("\n".join(lines) + "\n")
    print(f"Wrote {dest}", flush=True)


if __name__ == "__main__":
    main()
