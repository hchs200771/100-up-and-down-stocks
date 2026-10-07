import datetime as dt
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


study = load("option_range", "scripts/research-option-range.py")
intraday = load("option_expiry_intraday", "scripts/fetch-option-expiry-intraday.py")


class OptionRangeTests(unittest.TestCase):
    def test_weekday_dte_history_has_26_observation_warmup_and_excludes_current_day(self):
        dates = [dt.date(2020, 1, 7) + dt.timedelta(days=7 * i) for i in range(32)]
        prices = {}
        rows = []
        for index, day in enumerate(dates):
            key = day.isoformat()
            prices[key] = {"close": 100, "max": 101, "min": 99}
            rows.append({"date": key, "dte": 1, "contract": "202001W1", "premium": 10,
                         "rv20": 0.01, "today_abs": 0, "same_day_range": 0.02})
        # Future prices are needed for the final five-session outcome label.
        last = dates[-1]
        for i in range(1, 6):
            d = last + dt.timedelta(days=i)
            prices[d.isoformat()] = {"close": 100, "max": 101, "min": 99}
        output = study.add_weekday_history(rows, prices)
        eligible = {row["date"]: row for row in output}
        self.assertNotIn(dates[25].isoformat(), eligible)
        row = eligible[dates[26].isoformat()]
        self.assertEqual(row["history_count"], 26)
        self.assertEqual(row["history_last_date"], dates[25].isoformat())

    def test_weekday_mean_compares_premium_after_dividing_by_index(self):
        first = dt.date(2020, 1, 7)
        rows, prices = [], {}
        for i in range(32):
            day = first + dt.timedelta(days=7 * i)
            date = day.isoformat()
            close = 100 if i < 31 else 200
            prices[date] = {"close": close, "max": close + 1, "min": close - 1}
            rows.append({"date": date, "dte": 1, "contract": "202001W1",
                         "premium": 10 if i < 31 else 20,
                         "rv20": 0.01, "today_abs": 0, "same_day_range": 0.02})
        last = first + dt.timedelta(days=7 * 31)
        for i in range(1, 6):
            day = last + dt.timedelta(days=i)
            prices[day.isoformat()] = {"close": 200, "max": 201, "min": 199}
        result = {r["date"]: r for r in study.add_weekday_history(rows, prices)}[last.isoformat()]
        self.assertAlmostEqual(result["mean_ratio"], 1)
        self.assertAlmostEqual(result["raw_mean_ratio"], 2)

    def test_global_and_otm_walls_use_preselected_expiry_group_and_keep_roles(self):
        records = [
            {"contract": "same-expiry", "strike": 90, "call_oi": 100, "put_oi": 2,
             "call_volume": 0, "put_volume": 0},
            {"contract": "same-expiry", "strike": 110, "call_oi": 8, "put_oi": 10,
             "call_volume": 0, "put_volume": 0},
            {"contract": "same-expiry", "strike": 100, "call_oi": 1, "put_oi": 1,
             "call_volume": 0, "put_volume": 0},
            {"contract": "other-expiry", "strike": 1000, "call_oi": 999, "put_oi": 888,
             "call_volume": 0, "put_volume": 0},
        ]
        expiry_group = [row for row in records if row["contract"] == "same-expiry"]
        global_walls = study.oi_walls(expiry_group, 100)
        otm_walls = study.oi_walls(expiry_group, 100, otm=True)
        self.assertEqual((global_walls["upper"], global_walls["lower"]), (90, 110))
        self.assertFalse(global_walls["valid"])  # Preserve inverted call/put roles.
        self.assertEqual((otm_walls["upper"], otm_walls["lower"]), (110, 90))
        self.assertTrue(otm_walls["valid"])

    def test_max_oi_does_not_require_trading_volume(self):
        records = [
            {"strike": 90, "call_oi": 1, "put_oi": 20, "call_volume": 0, "put_volume": 0},
            {"strike": 110, "call_oi": 30, "put_oi": 1, "call_volume": 0, "put_volume": 0},
        ]
        walls = study.oi_walls(records, 100)
        self.assertEqual((walls["lower"], walls["upper"]), (90, 110))
        self.assertEqual((walls["put_oi"], walls["call_oi"]), (20, 30))

    def test_open_breakout_touch_and_close_inside_are_distinct_outcomes(self):
        daily = {"open": 105, "max": 106, "min": 99, "close": 101}
        points = [("09:00:05", 105), ("09:00:10", 100), ("13:30:00", 101)]
        outcomes = study.band_outcomes(90, 100, daily, 101, points)
        self.assertTrue(outcomes["open_above"])
        self.assertTrue(outcomes["any_breach_reentry"])
        self.assertFalse(outcomes["close_inside"])

    def test_quote_parser_excludes_previous_close_and_requires_3240_samples(self):
        fields = ["時間", "發行量加權股價指數"]
        data = [["09:00:00", "999"]]
        start = dt.datetime(2024, 1, 3, 9, 0, 5)
        for i in range(3240):
            clock = (start + dt.timedelta(seconds=5 * i)).strftime("%H:%M:%S")
            data.append([clock, "100"])
        payload = {"stat": "OK", "date": "20240103", "fields": fields, "data": data}
        daily = {"open": 100, "close": 100, "max": 100, "min": 100}
        points = intraday.parse_quotes(payload, "2024-01-03", daily)
        self.assertEqual(len(points), 3240)
        self.assertEqual(points[0], ["09:00:05", 100])
        with self.assertRaisesRegex(ValueError, "incomplete 5-second session"):
            intraday.parse_quotes({**payload, "data": data[:-1]}, "2024-01-03", daily)

    def test_quote_parser_rejects_daily_ohlc_mismatch(self):
        fields = ["時間", "發行量加權股價指數"]
        start = dt.datetime(2024, 1, 3, 9, 0, 5)
        data = [["09:00:00", "999"]]
        for i in range(3240):
            clock = (start + dt.timedelta(seconds=5 * i)).strftime("%H:%M:%S")
            data.append([clock, "101"])
        payload = {"stat": "OK", "date": "20240103", "fields": fields, "data": data}
        daily = {"open": 100, "close": 100, "max": 100, "min": 100}
        with self.assertRaisesRegex(ValueError, "OHLC differs"):
            intraday.parse_quotes(payload, "2024-01-03", daily)

    def test_oi_bootstrap_has_no_interval_below_twenty_paired_dates(self):
        rows = []
        for i in range(19):
            outcomes = {key: float(i % 2) for key in study.RANGE_OUTCOMES}
            row = {}
            for mode in ("global", "otm"):
                row[mode] = {"outcomes": outcomes,
                             "controls": {"same_width": outcomes}}
            rows.append(row)
        result = study.oi_bootstrap(rows, draws=5)
        for mode in ("global", "otm"):
            for outcome in study.RANGE_OUTCOMES:
                interval = result[f"{mode}:{outcome}"]
                self.assertEqual(interval["n"], 19)
                self.assertEqual(interval["ci95"], [None, None])
                self.assertEqual(interval["familywise_ci"], [None, None])
                self.assertEqual(interval["reason"], "fewer than 20 paired expiry dates")


if __name__ == "__main__":
    unittest.main()
