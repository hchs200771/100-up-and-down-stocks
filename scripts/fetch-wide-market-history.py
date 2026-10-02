#!/usr/bin/env python3
"""Fetch cached daily TWSE/TPEx ordinary-share rows for wide-market backtests."""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import html
import http.client
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "research/wide-market/benchmark-input.json"
OUTPUT_DIR = ROOT / "data/backtest/wide"
DAILY_DIR = OUTPUT_DIR / "daily"
PARSER_VERSION = "all-ordinary-rows-v2"
RETRIES = 2
TIMEOUT_SECONDS = 45
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
STOP_REQUESTS = threading.Event()
STOP_REASON = ""


class DataError(Exception):
    pass


class RateLimited(DataError):
    pass


def clean_text(value: Any) -> str:
    text = html.unescape(str(value if value is not None else ""))
    text = re.sub(r"<[^>]*>", "", text)
    return re.sub(r"\s+", "", text).strip()


def normalize_date(value: Any) -> str | None:
    raw = clean_text(value)
    digits = re.sub(r"[-/]", "", raw)
    if re.fullmatch(r"\d{8}", digits):
        return digits
    roc = re.fullmatch(r"(\d{3})[-/](\d{1,2})[-/](\d{1,2})", raw)
    if roc:
        return f"{int(roc.group(1)) + 1911:04d}{int(roc.group(2)):02d}{int(roc.group(3)):02d}"
    return None


def numeric(value: Any) -> float | None:
    raw = clean_text(value).replace(",", "")
    if not raw or raw in {"--", "-", "—", "除息", "除權", "除權息", "X", "N/A"}:
        return None
    if raw.startswith("(") and raw.endswith(")"):
        raw = "-" + raw[1:-1]
    try:
        result = float(raw)
    except ValueError:
        return None
    return result if result == result and abs(result) != float("inf") else None


def table_candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = payload.get("tables")
    if isinstance(candidates, list):
        return [table for table in candidates if isinstance(table, dict)]
    if "fields" in payload and "data" in payload:
        return [payload]
    return []


def field_index(fields: list[Any], aliases: tuple[str, ...], required: bool = True) -> int | None:
    normalized = [clean_text(x) for x in fields]
    for alias in aliases:
        key = clean_text(alias)
        if key in normalized:
            return normalized.index(key)
    if required:
        raise DataError(f"missing required field: {'/'.join(aliases)}")
    return None


def get_cell(row: Any, index: int | None) -> Any:
    if index is None or not isinstance(row, (list, tuple)) or index >= len(row):
        return None
    return row[index]


def index_fields(fields: list[Any]) -> dict[str, int | None]:
    """Resolve and validate the table schema once, before processing its rows."""
    return {
        "code": field_index(fields, ("證券代號", "代號", "股票代號")),
        "name": field_index(fields, ("證券名稱", "名稱", "股票名稱")),
        # Required columns are schema requirements even when individual cells are blank.
        "volume": field_index(fields, ("成交股數", "成交數量")),
        "money": field_index(fields, ("成交金額", "成交金額(元)", "成交金額（元）")),
        "open": field_index(fields, ("開盤價", "開盤")),
        "high": field_index(fields, ("最高價", "最高")),
        "low": field_index(fields, ("最低價", "最低")),
        "close": field_index(fields, ("收盤價", "收盤")),
        "change": field_index(fields, ("漲跌價差", "漲跌", "漲跌價差(元)"), required=False),
        "sign": field_index(fields, ("漲跌(+/-)", "漲跌(＋/－)", "漲跌符號"), required=False),
        "nextReference": field_index(fields, ("次日參考價", "次日參考價格"), required=False),
    }


def normalized_row(row: Any, market: str, columns: dict[str, int | None], *, twse: bool) -> dict[str, Any] | None:
    code_i = columns["code"]
    name_i = columns["name"]
    volume_i = columns["volume"]
    money_i = columns["money"]
    open_i = columns["open"]
    high_i = columns["high"]
    low_i = columns["low"]
    close_i = columns["close"]
    change_i = columns["change"]
    sign_i = columns["sign"]
    next_i = columns["nextReference"]

    code_text = clean_text(get_cell(row, code_i))
    if not re.fullmatch(r"[1-9]\d{3}", code_text):
        return None
    volume = numeric(get_cell(row, volume_i))

    raw_change = get_cell(row, change_i)
    change_label = clean_text(raw_change)
    change = numeric(raw_change)
    if twse and change is not None:
        sign = clean_text(get_cell(row, sign_i))
        if sign in {"-", "－", "負"}:
            change = -abs(change)
        elif sign in {"+", "＋", "正"}:
            change = abs(change)
        if sign and change_label:
            change_label = f"{sign}{change_label}"
        elif not change_label and sign:
            change_label = sign

    return {
        "code": code_text,
        "name": clean_text(get_cell(row, name_i)),
        "market": market,
        "open": numeric(get_cell(row, open_i)),
        "high": numeric(get_cell(row, high_i)),
        "low": numeric(get_cell(row, low_i)),
        "close": numeric(get_cell(row, close_i)),
        "volume": volume,
        "money": numeric(get_cell(row, money_i)),
        "change": change,
        "changeLabel": change_label,
        "nextReference": numeric(get_cell(row, next_i)),
    }


def response_date(payload: dict[str, Any], requested: str, source: str) -> None:
    candidates = []
    for key in ("date", "date9", "queryDate", "dateString"):
        if key in payload:
            candidates.append(payload[key])
    matched = [normalize_date(value) for value in candidates]
    if requested not in matched:
        raise DataError(f"{source}: response date mismatch or missing; requested {requested}, got {candidates!r}")


def parse_twse(payload: dict[str, Any], requested_date: str) -> list[dict[str, Any]]:
    response_date(payload, requested_date, "TWSE")
    if payload.get("stat") and clean_text(payload["stat"]).upper() not in {"OK", "SUCCESS"}:
        raise DataError(f"TWSE: unsuccessful status {payload['stat']!r}")
    for table in table_candidates(payload):
        fields, rows = table.get("fields"), table.get("data")
        if not isinstance(fields, list) or not isinstance(rows, list):
            continue
        normalized_fields = [clean_text(x) for x in fields]
        if "證券代號" not in normalized_fields or "證券名稱" not in normalized_fields:
            continue
        columns = index_fields(fields)
        result = []
        for row in rows:
            item = normalized_row(row, "twse", columns, twse=True)
            if item is not None:
                result.append(item)
        if not result:
            raise DataError(f"TWSE: zero eligible ordinary stocks for {requested_date}")
        return result
    raise DataError("TWSE: no stock table with dynamic code/name fields")


def parse_tpex(payload: dict[str, Any], requested_date: str) -> list[dict[str, Any]]:
    response_date(payload, requested_date, "TPEx")
    if clean_text(payload.get("stat", "")).lower() not in {"ok", "success"}:
        raise DataError(f"TPEx: missing or unsuccessful status {payload.get('stat')!r}")
    for table in table_candidates(payload):
        fields, rows = table.get("fields"), table.get("data")
        if not isinstance(fields, list) or not isinstance(rows, list):
            continue
        normalized_fields = [clean_text(x) for x in fields]
        if not any(x in normalized_fields for x in ("證券代號", "代號", "股票代號")):
            continue
        columns = index_fields(fields)
        result = []
        for row in rows:
            item = normalized_row(row, "tpex", columns, twse=False)
            if item is not None:
                result.append(item)
        if not result:
            raise DataError(f"TPEx: zero eligible ordinary stocks for {requested_date}")
        return result
    raise DataError("TPEx: no quote table with dynamic code field")


def source_url(source: str, date: str) -> str:
    if source == "twse":
        return f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={date}&type=ALLBUT0999&response=json"
    slashed = f"{date[:4]}/{date[4:6]}/{date[6:8]}"
    return "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=" + urllib.parse.quote(slashed, safe="") + "&response=json"


def cache_path(source: str, date: str) -> Path:
    return DAILY_DIR / source / f"{date[:4]}-{date[4:6]}-{date[6:8]}.json.gz"


def read_cache(source: str, date: str) -> dict[str, Any] | None:
    path = cache_path(source, date)
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            value = json.load(stream)
        if value.get("parserVersion") == PARSER_VERSION and value.get("requestedDate") == date and value.get("url") == source_url(source, date) and isinstance(value.get("rows"), list) and value["rows"]:
            return value
    except (OSError, EOFError, json.JSONDecodeError):
        return None
    return None


def write_cache(source: str, date: str, rows: list[dict[str, Any]]) -> None:
    path = cache_path(source, date)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"parserVersion": PARSER_VERSION, "source": source, "requestedDate": date, "url": source_url(source, date), "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "rows": rows}
    with gzip.open(path, "wt", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))


def request_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 expanded-backtest-input/1.0", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise DataError(f"HTTP {response.status}")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise DataError("response exceeded size limit")
        if response.headers.get("Content-Encoding", "").lower() == "gzip":
            import io
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read(MAX_RESPONSE_BYTES + 1)
        payload = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(payload, dict):
            raise DataError("response JSON root is not an object")
        return payload


def fetch_source(source: str, date: str) -> tuple[list[dict[str, Any]] | None, str, bool]:
    global STOP_REASON
    cached = read_cache(source, date)
    if cached is not None:
        return cached["rows"], "cache", False
    if STOP_REQUESTS.is_set():
        return None, f"not requested after {STOP_REASON}", False
    url = source_url(source, date)
    parser = parse_twse if source == "twse" else parse_tpex
    for attempt in range(RETRIES + 1):
        if STOP_REQUESTS.is_set():
            return None, f"not requested after {STOP_REASON}", False
        try:
            payload = request_json(url)
            rows = parser(payload, date)
            write_cache(source, date, rows)
            return rows, "fetched", False
        except urllib.error.HTTPError as error:
            if error.code in {403, 429}:
                STOP_REASON = f"HTTP {error.code}"
                STOP_REQUESTS.set()
                return None, f"{STOP_REASON}; stopped new requests", True
            if (error.code >= 500 or error.code in {307, 308}) and attempt < RETRIES:
                time.sleep(0.5 * (attempt + 1))
                continue
            return None, f"HTTP {error.code}", False
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, http.client.HTTPException) as error:
            if attempt < RETRIES:
                time.sleep(0.5 * (attempt + 1))
                continue
            return None, f"temporary request error: {error}", False
        except (DataError, json.JSONDecodeError, UnicodeDecodeError) as error:
            return None, str(error), False
    return None, "retry budget exhausted", False


def load_calendar(path: Path) -> list[str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("benchmarkTotalReturn", {}).get("TaiwanStockPrice")
    if not isinstance(rows, list):
        raise DataError("input has no benchmarkTotalReturn.TaiwanStockPrice calendar")
    dates = set()
    for row in rows:
        date = normalize_date(row.get("date") if isinstance(row, dict) else None)
        if date and "2019-01-01".replace("-", "") <= date <= "2026-12-31".replace("-", ""):
            dates.add(date)
    if not dates:
        raise DataError("no 2019–2026 benchmark dates found")
    return sorted(dates)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", help="inclusive YYYY-MM-DD")
    parser.add_argument("--end", help="inclusive YYYY-MM-DD")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    args = parser.parse_args()
    if args.workers < 1 or args.workers > 16:
        parser.error("--workers must be between 1 and 16")
    dates = load_calendar(args.input)
    if args.start:
        dates = [d for d in dates if d >= args.start.replace("-", "")]
    if args.end:
        dates = [d for d in dates if d <= args.end.replace("-", "")]
    if not dates:
        parser.error("selected date range has no benchmark sessions")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    errors: list[dict[str, str]] = []
    status: dict[str, dict[str, Any]] = {"twse": {"success": 0, "failed": 0, "cached": 0}, "tpex": {"success": 0, "failed": 0, "cached": 0}}
    requested: list[tuple[str, str]] = [(source, date) for date in dates for source in ("twse", "tpex")]
    completed = 0
    lock = threading.Lock()

    def work(item: tuple[str, str]) -> None:
        nonlocal completed
        source, date = item
        rows, result, stopped = fetch_source(source, date)
        with lock:
            if rows is None:
                status[source]["failed"] += 1
                errors.append({"source": source, "date": date, "error": result})
            else:
                status[source]["success"] += 1
                if result == "cache":
                    status[source]["cached"] += 1
            if result in {"fetched", "cache"}:
                completed += 1
                if completed % 100 == 0:
                    print(f"successful source responses: {completed}/{len(requested)}", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(work, item) for item in requested]
        for future in as_completed(futures):
            future.result()

    manifest = {
        "source": "TWSE MI_INDEX + TPEx dailyQuotes",
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "requestedDates": dates,
        "sourceUrls": {"twse": "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=ALLBUT0999&response=json", "tpex": "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=YYYY%2FMM%2FDD&response=json"},
        "parserVersion": PARSER_VERSION,
        "retrievalPopulation": "all ordinary equities matching /^[1-9]\\d{3}$/; no volume threshold",
        "status": status,
        "stoppedAfter429": STOP_REASON == "HTTP 429",
        "stoppedAfterAccessBlock": STOP_REASON == "HTTP 403",
        "requestStopReason": STOP_REASON or None,
        "errors": errors,
    }
    (OUTPUT_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"dates": len(dates), "status": status, "stoppedAfter429": STOP_REQUESTS.is_set(), "errors": len(errors)}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
