#!/usr/bin/env python3
"""Cache official TAIEX 5-second quotes on fixed Wednesday validation dates."""
import argparse
import datetime as dt
import gzip
import hashlib
import html
import json
from pathlib import Path
import re
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/backtest/option-range/intraday"
ENDPOINT = "https://www.twse.com.tw/exchangeReport/MI_5MINS_INDEX"
SETTLEMENT_ENDPOINT = "https://www.taifex.com.tw/cht/5/optIndxFSP?start_year=2019&start_month=01&end_year=2025&end_month=12"


def parse_settlements(source, min_count=300):
    result = {}
    for tr in re.findall(r"<tr\b[^>]*>(.*?)</tr>", source, re.I | re.S):
        cells = [html.unescape(re.sub("<[^>]+>", "", x)).strip()
                 for x in re.findall(r"<td\b[^>]*>(.*?)</td>", tr, re.I | re.S)]
        if len(cells) >= 3 and re.fullmatch(r"\d{4}/\d{2}/\d{2}", cells[0]) and re.fullmatch(r"\d{6}(?:W[1245])?", cells[1]) and cells[2] != "-":
            result[cells[1]] = {"date": cells[0].replace("/", "-"), "value": float(cells[2].replace(",", ""))}
    if len(result) < min_count:
        raise ValueError(f"incomplete official settlement table: {len(result)} contracts (expected >= {min_count})")
    return result


def fetch_settlements():
    target = CACHE.parent / "settlements.json"
    if target.exists():
        return
    with urllib.request.urlopen(SETTLEMENT_ENDPOINT, timeout=45) as response:
        raw = response.read()
    source = raw.decode("utf-8")
    result = parse_settlements(source)
    (CACHE.parent / "settlements-source.html.gz").write_bytes(gzip.compress(raw, mtime=0))
    target.write_text(json.dumps({"source": SETTLEMENT_ENDPOINT,
                                  "source_sha256": hashlib.sha256(raw).hexdigest(), "data": result}, indent=2))
    print(f"Cached {len(result)} official final settlements", flush=True)


def parse_quotes(payload, date, daily):
    if payload.get("stat") != "OK" or payload.get("date") != date.replace("-", ""):
        raise ValueError(f"wrong date/status: {payload.get('stat')}, {payload.get('date')}")
    fields = payload["fields"]
    ti = fields.index("時間")
    pi = fields.index("發行量加權股價指數")
    points = []
    for row in payload["data"]:
        clock = row[ti]
        # 09:00:00 is the PREVIOUS close, not today's opening quote.
        if "09:00:00" < clock <= "13:30:00":
            value = float(row[pi].replace(",", ""))
            if value > 0:
                points.append([clock, value])
    if len(points) != 3240 or len({p[0] for p in points}) != 3240:
        raise ValueError(f"incomplete 5-second session: {len(points)} samples")
    observed = {"open": points[0][1], "close": points[-1][1],
                "max": max(x[1] for x in points), "min": min(x[1] for x in points)}
    differences = {key: observed[key] - daily[key] for key in observed}
    if any(abs(x) > 0.021 for x in differences.values()):
        raise ValueError(f"OHLC differs from archived daily index: {differences}")
    return points


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-year", type=int, default=2023)
    parser.add_argument("--end-year", type=int, default=2025)
    parser.add_argument("--delay", type=float, default=1)
    parser.add_argument("--settlements-only", action="store_true")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    fetch_settlements()
    if args.settlements_only:
        return
    prices = {x["date"]: x for x in json.loads((ROOT / "research/wide-market/benchmark-input.json").read_text())["benchmarkTotalReturn"]["TaiwanStockPrice"]}
    dates = [day for day in sorted(prices) if args.start_year <= int(day[:4]) <= args.end_year
             and dt.date.fromisoformat(day).weekday() == 2
             and (dt.date.fromisoformat(day)-dt.timedelta(days=1)).isoformat() in prices]
    audit = {"source": ENDPOINT, "requested": dates, "valid": [], "invalid": {}, "stopped": None}
    for index, date in enumerate(dates):
        target = CACHE / f"{date}.json.gz"
        compact = CACHE / f"{date}-quotes.json"
        try:
            if target.exists():
                raw = gzip.decompress(target.read_bytes())
            else:
                url = f"{ENDPOINT}?response=json&date={date.replace('-', '')}"
                with urllib.request.urlopen(url, timeout=45) as response:
                    raw = response.read()
                # A HTML challenge is not a data gap. Stop instead of retrying
                # around official blocking/rate limits.
                if not raw.lstrip().startswith(b"{"):
                    raise RuntimeError(f"non-JSON response {raw[:100]!r}; stop requests")
                target.write_bytes(gzip.compress(raw, mtime=0))
                time.sleep(args.delay)
            payload = json.loads(raw)
            points = parse_quotes(payload, date, prices[date])
            compact.write_text(json.dumps({"date": date, "source": ENDPOINT,
                                           "raw_sha256": hashlib.sha256(raw).hexdigest(), "points": points}))
            audit["valid"].append(date)
            print(f"{index+1}/{len(dates)} {date}: {len(points)} validated quotes", flush=True)
        except ValueError as error:
            audit["invalid"][date] = str(error)
            print(f"{date}: invalid: {error}", flush=True)
        except Exception as error:
            audit["stopped"] = {"date": date, "reason": str(error)}
            print(f"Stopped: {audit['stopped']}", flush=True)
            break
        (CACHE / "audit.json").write_text(json.dumps(audit, indent=2))
    (CACHE / "audit.json").write_text(json.dumps(audit, indent=2))


if __name__ == "__main__":
    main()
