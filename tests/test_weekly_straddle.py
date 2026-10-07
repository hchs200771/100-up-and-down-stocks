import importlib.util
import unittest
from datetime import date, timedelta
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/research-weekly-straddle.py"
SPEC = importlib.util.spec_from_file_location("weekly_straddle", SCRIPT)
study = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(study)


class WeeklyStraddleTests(unittest.TestCase):
    def test_weekly_and_monthly_expiries_are_wednesdays_only(self):
        self.assertEqual(study.scheduled_expiry("202410W1"), date(2024, 10, 2))
        self.assertEqual(study.scheduled_expiry("202410W2"), date(2024, 10, 9))
        self.assertEqual(study.scheduled_expiry("202410"), date(2024, 10, 16))
        self.assertEqual(study.scheduled_expiry("202410W4"), date(2024, 10, 23))
        self.assertEqual(study.scheduled_expiry("202410W5"), date(2024, 10, 30))
        self.assertIsNone(study.scheduled_expiry("202410W3"))
        self.assertIsNone(study.scheduled_expiry("202410W6"))
        self.assertIsNone(study.scheduled_expiry("202410F"))

    def test_expiry_moves_to_next_calendar_trading_day(self):
        calendar = {"2024-10-17", "2024-10-18"}
        self.assertEqual(study.actual_expiry("202410", calendar), "2024-10-17")
        self.assertIsNone(study.actual_expiry("202410", {"2024-10-25"}))

    def test_select_pairs_uses_same_strike_call_and_put_and_quote_mid(self):
        pairs = {
            100: {"買權": {"close": 8, "volume": 20, "oi": 11, "bid": 7.9, "ask": 8.1},
                  "賣權": {"close": 9, "volume": 30, "oi": 13, "bid": 8.9, "ask": 9.1}},
            110: {"買權": {"close": 2, "volume": 20, "oi": 5, "bid": 1.9, "ask": 2.1}},
        }
        selected = study.select_pairs(pairs, 101, {"non_atm_rejected": 0})
        self.assertEqual(selected["strike"], 100)
        self.assertEqual(selected["premium"], 17)
        self.assertEqual(selected["mid"], 17)
        self.assertEqual(selected["oi"], 24)

    def test_missing_leg_or_bad_quote_is_not_filled_with_zero(self):
        audit = {"non_atm_rejected": 0}
        self.assertIsNone(study.select_pairs({100: {"買權": {"close": 5, "volume": 2}}}, 100, audit))
        invalid = {100: {"買權": {"close": 5, "volume": 2, "oi": None, "bid": None, "ask": None},
                         "賣權": {"close": None, "volume": 2, "oi": None, "bid": None, "ask": None}}}
        self.assertIsNone(study.select_pairs(invalid, 100, audit))

    def test_expiry_roll_does_not_create_a_spike(self):
        days = [date(2024, 1, 1) + timedelta(days=i) for i in range(75)]
        prices = {d.isoformat(): {"open": 100, "close": 100, "max": 101, "min": 99} for d in days}
        # Consecutive observed sessions have different selected expiries, as at a roll.
        chains = {}
        for i in range(60, 66):
            expiry = (days[i] + timedelta(days=2 if i == 60 else 5)).isoformat()
            chains[days[i].isoformat()] = [{"expiry": expiry, "premium": 5 if i == 60 else 20,
                                            "mid": 5 if i == 60 else 20,
                                            "spot_atm_premium": 5 if i == 60 else 20}]
        rows = study.make_observations(chains, prices)
        by_date = {r["date"]: r for r in rows}
        self.assertFalse(by_date[days[61].isoformat()]["has_prior"])
        self.assertFalse(by_date[days[61].isoformat()]["raw_spike"])
        self.assertFalse(by_date[days[61].isoformat()]["adjusted_spike"])

    def test_future_labels_ignore_signal_day_range(self):
        days = [date(2024, 1, 1) + timedelta(days=i) for i in range(75)]
        prices = {d.isoformat(): {"open": 100, "close": 100, "max": 101, "min": 99} for d in days}
        chains = {days[60].isoformat(): [{"expiry": (days[64]).isoformat(), "premium": 5,
                                          "mid": 5, "spot_atm_premium": 5}]}
        baseline = study.make_observations(chains, prices)[0]
        prices[days[60].isoformat()].update({"max": 300, "min": 1})
        changed = study.make_observations(chains, prices)[0]
        for key in ("next_abs", "future_rv3", "future_excursion3", "big1", "big3"):
            self.assertEqual(baseline[key], changed[key], key)
        self.assertNotEqual(baseline["same_day_range"], changed["same_day_range"])

    def test_high_level_is_ineligible_until_sixty_prior_observations_exist(self):
        days = [date(2024, 1, 1) + timedelta(days=i) for i in range(130)]
        prices = {d.isoformat(): {"open": 100, "close": 100, "max": 101, "min": 99} for d in days}
        chains = {days[i].isoformat(): [{"expiry": "2030-01-01", "premium": 5,
                                        "mid": 5, "spot_atm_premium": 5}]
                  for i in range(60, 127)}
        rows = study.make_observations(chains, prices)
        self.assertFalse(rows[0]["high_eligible"])
        self.assertFalse(rows[59]["high_eligible"])
        self.assertTrue(rows[60]["high_eligible"])

    def test_bootstrap_suppresses_inference_below_twenty_matched_events(self):
        rows = [{"stratum": (1,), "has_prior": True, "raw_spike": i >= 5,
                 "adjusted_spike": i >= 5, "high_level": i >= 5,
                 "big1": float(i >= 5), "big3": float(i >= 5)} for i in range(24)]
        result = study.bootstrap(rows, draws=5)
        for key in ("raw_spike:big1", "adjusted_spike:big3", "high_level:big1"):
            self.assertEqual(result[key]["ci95"], [None, None])
            self.assertIsNone(result[key]["approx_centered_bootstrap_p"])
            self.assertIsNone(result[key]["bonferroni_p"])
            self.assertEqual(result[key]["successful_draws"], 0)
            self.assertIn("fewer than 20", result[key]["reason"])

    def test_matched_difference_requires_five_controls_and_returns_none_when_unmatched(self):
        rows = [{"stratum": (1,), "has_prior": True, "raw_spike": i == 5, "big1": float(i == 5)}
                for i in range(6)]
        result = study.matched_difference(rows, "raw_spike", "big1")
        self.assertEqual(result["matched_events"], 1)
        self.assertEqual(result["difference"], 1)
        self.assertEqual(result["control_mean"], 0)
        too_few = rows[:5]
        self.assertIsNone(study.matched_difference(too_few, "raw_spike", "big1")["difference"])


if __name__ == "__main__":
    unittest.main()
