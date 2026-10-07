#!/usr/bin/env python3
"""Forward check of the frozen weekly straddle rules on data after 2025.

Rules, thresholds, strata cuts and the intraday-range cuts all come from
research-weekly-straddle.py unchanged (cuts from 2019–2022 only). Only rows
dated on/after --since are evaluated. 2026 has no official annual archive yet;
data/backtest/weekly-straddle/2026.zip is packed from the official monthly
downloads (same CSV schema).
"""
import argparse
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("straddle", ROOT / "scripts/research-weekly-straddle.py")
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)

LABELS = {"raw_spike": "原始合價日增≥25%", "adjusted_spike": "正規化後日增≥25%",
          "high_level": "正規化值在過去60日最高一成"}


def pct(x):
    return "—" if x is None else f"{x * 100:.1f}%"


def pp(x):
    return "—" if x is None else f"{x * 100:+.1f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="2026-01-01")
    parser.add_argument("--end-year", type=int, default=2026)
    parser.add_argument("--draws", type=int, default=3000)
    args = parser.parse_args()
    benchmark = json.loads((ROOT / "research/wide-market/benchmark-input.json").read_text())
    prices = {r["date"]: r for r in benchmark["benchmarkTotalReturn"]["TaiwanStockPrice"]}
    calendar = set(prices)
    chains = {}
    for year in range(2019, args.end_year + 1):
        derived = S.CACHE / f"{year}-atm.json"
        if derived.exists():
            chain = json.loads(derived.read_text())["chains"]
        else:
            chain, audit = S.parse_year(S.CACHE / f"{year}.zip", prices, calendar)
            derived.write_text(json.dumps({"chains": chain, "audit": audit}, ensure_ascii=False))
        chains.update(chain)
    rows = S.make_observations(chains, prices)
    cuts = S.assign_strata(rows)
    dev = [r for r in rows if r["date"] < "2023-01-01"]
    range_cuts = [S.percentile([r["same_day_range"] for r in dev], q) for q in (1/3, 2/3)]
    forward = [r for r in rows if r["date"] >= args.since]
    stronger = [{**r, "stratum": (*r["stratum"], sum(r["same_day_range"] > c for c in range_cuts))} for r in forward]
    results = {"since": args.since, "dates": [forward[0]["date"], forward[-1]["date"]], "observations": len(forward),
               "stratum_cuts": cuts, "range_cuts": range_cuts,
               "summary": {rule: S.summarize(forward, rule) for rule in S.RULES},
               "intraday_control": {rule: S.summarize(stronger, rule) for rule in S.RULES},
               "bootstrap": S.bootstrap(forward, args.draws),
               "signals": {rule: [{k: r[k] for k in ("date", "contract", "dte", "level", "raw_change", "adjusted_change",
                                                     "today_abs", "same_day_range", "future_excursion3", "big1", "big3")}
                                  for r in forward if r[rule]] for rule in S.RULES}}
    out = S.CACHE / f"forward-{args.since[:4]}.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2))

    lines = [f"# 週三價平合前瞻檢查（{results['dates'][0]}～{results['dates'][1]}）", "",
             "由 `scripts/forward-weekly-straddle.py` 產生。規則、門檻與控制變數切點都沿用"
             "[原研究](weekly-straddle-risk-review.md)（切點只用2019–2022），沒有重新調整。", "",
             f"有效觀察日 {len(forward)} 日。三日大行情＝訊號收盤後三個交易日內，最高或最低距收盤至少2%；"
             "次日大波動＝次日收盤絕對漲跌至少1%。", "",
             "| 規則 | 可比日 | 訊號日 | 三日大行情：訊號日 | 三日大行情：非訊號日 | 控制後差(pp) | 配對訊號 | 加盤中振幅控制後差(pp) | 配對訊號 |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for rule in S.RULES:
        s, t = results["summary"][rule], results["intraday_control"][rule]
        lines.append(f"| {LABELS[rule]} | {s['eligible']} | {s['events']} | {pct(s['big3']['event'])} | {pct(s['big3']['control'])} | "
                     f"{pp(s['big3']['difference'])} | {s['big3']['matched_events']} | {pp(t['big3']['difference'])} | {t['big3']['matched_events']} |")
    lines += ["", "| 規則 | 次日大波動：訊號日 | 次日大波動：非訊號日 | 控制後差(pp) |", "| --- | ---: | ---: | ---: |"]
    for rule in S.RULES:
        s = results["summary"][rule]
        lines.append(f"| {LABELS[rule]} | {pct(s['big1']['event'])} | {pct(s['big1']['control'])} | {pp(s['big1']['difference'])} |")
    lines += ["", "## 區塊 bootstrap", "",
              "與原研究相同：10日區塊、依規則與結果共6項比較；配對訊號少於20日時不做推論。", "",
              "| 比較 | 95%區間(pp) | 6比較同時區間(pp) | 說明 |", "| --- | --- | --- | --- |"]
    for key, b in results["bootstrap"].items():
        rule, outcome = key.split(":")
        ci = "—" if b["ci95"][0] is None else f"{pp(b['ci95'][0])}～{pp(b['ci95'][1])}"
        fw = "—" if b["familywise_ci"][0] is None else f"{pp(b['familywise_ci'][0])}～{pp(b['familywise_ci'][1])}"
        lines.append(f"| {LABELS[rule]}／{'三日' if outcome == 'big3' else '次日'} | {ci} | {fw} | {b.get('reason', '')} |")
    lines += ["", "## 訊號日清單", ""]
    for rule in S.RULES:
        sig = results["signals"][rule]
        lines.append(f"**{LABELS[rule]}**（{len(sig)}日）：" + ("、".join(
            f"{r['date']}{'✔' if r['big3'] else '✘'}" for r in sig) or "無") + "")
        lines.append("")
    lines.append("✔＝之後三日出現±2%大行情，✘＝沒有。")
    dest = ROOT / "docs/weekly-straddle-forward-results.md"
    dest.write_text("\n".join(lines) + "\n")
    print(f"Wrote {dest}; {len(forward)} forward observations", flush=True)


if __name__ == "__main__":
    main()
