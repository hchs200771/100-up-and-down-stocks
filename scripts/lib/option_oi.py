"""Parse cached TAIFEX TXO daily archives for Wednesday expiry OI research.

The public API is :func:`parse_archive`, which returns ``(records, audit)``.
Each record is one trading date, expiry, and strike. Records are never merged
across expiries; callers must select ``date < expiry`` before making a
pre-expiry prediction.
"""
import csv
import datetime as dt
import bisect
import io
import math
import re
import statistics
import zipfile


CONTRACT_RE = re.compile(r"^(\d{4})(\d{2})(?:W([1245]))?$")
CALL = "買權"
PUT = "賣權"


def _number(value):
    try:
        value = str(value).strip().replace(",", "")
        if not value or value == "-":
            return None
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _date(value):
    value = value.strip().replace("/", "-")
    if re.fullmatch(r"\d{8}", value):
        value = f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return dt.date.fromisoformat(value).isoformat()


def _wednesday_contract(contract):
    match = CONTRACT_RE.fullmatch(contract)
    if not match:
        return False
    year, month, series = match.groups()
    nth = int(series) if series else 3
    first = dt.date(int(year), int(month), 1)
    expiry = first + dt.timedelta(days=(2 - first.weekday()) % 7 + 7 * (nth - 1))
    return expiry.month == int(month)


def parse_archive(path, prices, expiry_fn):
    """Return ``(records, audit)`` for Wednesday TXO series near expiry.

    ``prices`` maps ISO trading dates to any price payload; it is used to
    establish observed sessions and discard dates without index prices.
    ``expiry_fn(contract)`` returns the actual expiry as an ISO date or a
    ``datetime.date`` (or ``None`` when it cannot be established).

    Records have ``date``, ``contract``, ``expiry``, ``strike``, and the six
    requested call/put OI, volume, and settlement fields. A missing/ambiguous
    side is represented by ``None`` in all its fields so it cannot enter a
    complete-pair maximum. Zero-volume rows are retained when they carry OI.
    Audit includes bad/missing OI counts, duplicate side counts, and per-expiry
    settlement reconstruction status/results.
    """
    sessions = sorted(_date(x) for x in prices)
    price_by_iso = {_date(day): value for day, value in prices.items()}
    audit = {"rows": 0, "missing_oi": 0, "nonnumeric_oi": 0,
             "duplicate_side_rows": 0, "missing_price_dates": 0,
             "settlement_reconstruction": {}}
    grouped = {}
    with zipfile.ZipFile(path) as archive:
        for name in sorted(archive.namelist()):
            with archive.open(name) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="big5", errors="strict"))
                for row in reader:
                    if row.get("契約", "").strip() != "TXO" or row.get("交易時段", "").strip() != "一般":
                        continue
                    contract = row.get("到期月份(週別)", "").strip()
                    if not _wednesday_contract(contract):
                        continue
                    try:
                        day = _date(row.get("交易日期", ""))
                    except (ValueError, AttributeError):
                        continue
                    expiry_value = expiry_fn(contract)
                    if isinstance(expiry_value, dt.date):
                        expiry = expiry_value.isoformat()
                    elif expiry_value:
                        expiry = _date(str(expiry_value))
                    else:
                        continue
                    # Only expiry eve (previous observed index session) and
                    # expiry day are needed for the stated short-term study.
                    expiry_index = bisect.bisect_left(sessions, expiry)
                    previous_session = sessions[expiry_index - 1] if expiry_index else None
                    if day not in (previous_session, expiry):
                        continue
                    if day not in price_by_iso:
                        audit["missing_price_dates"] += 1
                        continue
                    strike = _number(row.get("履約價"))
                    side = row.get("買賣權", "").strip()
                    if strike is None or side not in (CALL, PUT):
                        continue
                    audit["rows"] += 1
                    oi_raw = row.get("未沖銷契約數")
                    oi = _number(oi_raw)
                    if oi is None:
                        if str(oi_raw or "").strip() in ("", "-", "--"):
                            audit["missing_oi"] += 1
                        else:
                            audit["nonnumeric_oi"] += 1
                    volume = _number(row.get("成交量"))
                    settlement = _number(row.get("結算價"))
                    key = (day, contract, expiry, strike)
                    sides = grouped.setdefault(key, {})
                    if side in sides:
                        audit["duplicate_side_rows"] += 1
                        sides[side] = None
                    else:
                        sides[side] = {"oi": oi, "volume": volume,
                                       "settlement": settlement}

    records = []
    settlement_rows = {}
    for (day, contract, expiry, strike), sides in sorted(grouped.items()):
        record = {"date": day, "contract": contract, "expiry": expiry,
                  "strike": strike}
        for side, prefix in ((CALL, "call"), (PUT, "put")):
            value = sides.get(side)
            record[f"{prefix}_oi"] = value["oi"] if value else None
            record[f"{prefix}_volume"] = value["volume"] if value else None
            record[f"{prefix}_settlement"] = value["settlement"] if value else None
        records.append(record)
        # Infer final underlying settlement only from expiry-day paired
        # option settlement prices, never from OI or the prior session.
        if day == expiry:
            settlement_rows.setdefault(expiry, [])
        if day == expiry and sides.get(CALL) and sides.get(PUT):
            call_settle = sides[CALL]["settlement"]
            put_settle = sides[PUT]["settlement"]
            if call_settle is not None and put_settle is not None and call_settle + put_settle > 0:
                settlement_rows.setdefault(expiry, []).append(
                    (strike, strike + call_settle - put_settle))

    for expiry, values in settlement_rows.items():
        unique = {strike: inferred for strike, inferred in values}
        estimates = list(unique.values())
        if len(estimates) >= 3 and max(estimates) - min(estimates) <= 0.02:
            audit["settlement_reconstruction"][expiry] = {
                "value": statistics.median(estimates), "status": "ok",
                "strikes": len(estimates)}
        else:
            audit["settlement_reconstruction"][expiry] = {
                "value": None, "status": "inconsistent" if len(estimates) >= 3 else "insufficient_strikes",
                "strikes": len(estimates),
                "spread": max(estimates) - min(estimates) if estimates else None}
    return records, audit
