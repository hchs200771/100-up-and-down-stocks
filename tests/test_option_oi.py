import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path


MODULE = Path(__file__).resolve().parents[1] / "scripts/lib/option_oi.py"
SPEC = importlib.util.spec_from_file_location("option_oi", MODULE)
option_oi = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(option_oi)


HEADER = "交易日期,契約,到期月份(週別),履約價,買賣權,成交量,結算價,未沖銷契約數,交易時段\n"


def row(day, contract, strike, side, volume="0", settlement="10", oi="5", session="一般"):
    return f"{day},TXO,{contract},{strike},{side},{volume},{settlement},{oi},{session}\n"


class OptionOITests(unittest.TestCase):
    def parse(self, lines, prices, expiries):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("sample.csv", (HEADER + "".join(lines)).encode("big5"))
            return option_oi.parse_archive(path, prices, lambda c: expiries.get(c))

    def test_zero_volume_open_interest_is_retained_and_friday_series_excluded(self):
        lines = [row("2024/10/01", "202410W1", 19000, "買權", volume="0", oi="17"),
                 row("2024/10/01", "202410W1", 19000, "賣權", volume="0", oi="23"),
                 row("2024/10/01", "202410F", 19000, "買權", oi="99")]
        records, _ = self.parse(lines, {"2024-10-01": {}}, {"202410W1": "2024-10-02"})
        self.assertEqual(len(records), 1)
        self.assertEqual((records[0]["call_oi"], records[0]["put_oi"]), (17, 23))
        self.assertEqual((records[0]["call_volume"], records[0]["put_volume"]), (0, 0))

    def test_keeps_expiries_separate_and_missing_side_is_incomplete(self):
        lines = [row("2024/10/01", "202410W1", 19000, "買權", oi="10"),
                 row("2024/10/01", "202410W1", 19000, "賣權", oi="20"),
                 row("2024/10/08", "202410W2", 19000, "買權", oi="30"),
                 row("2024/10/08", "202410W2", 19000, "賣權", oi="40")]
        records, _ = self.parse(lines, {"2024-10-01": {}, "2024-10-08": {}},
                                {"202410W1": "2024-10-02", "202410W2": "2024-10-09"})
        self.assertEqual(len(records), 2)
        self.assertEqual([r["contract"] for r in records], ["202410W1", "202410W2"])
        self.assertEqual([(r["call_oi"], r["put_oi"]) for r in records], [(10, 20), (30, 40)])

    def test_missing_pair_leg_remains_none_so_caller_can_skip_maximum(self):
        lines = [row("2024/10/01", "202410W1", 19000, "買權", oi="not-a-number")]
        records, audit = self.parse(lines, {"2024-10-01": {}}, {"202410W1": "2024-10-02"})
        self.assertIsNone(records[0]["put_oi"])
        self.assertIsNone(records[0]["call_oi"])
        self.assertEqual(audit["nonnumeric_oi"], 1)

    def test_expiry_day_is_included_as_distinct_record_date(self):
        lines = [row("2024/10/01", "202410W1", 19000, "買權"),
                 row("2024/10/02", "202410W1", 19000, "買權")]
        records, _ = self.parse(lines, {"2024-10-01": {}, "2024-10-02": {}},
                                {"202410W1": "2024-10-02"})
        self.assertEqual([r["date"] for r in records], ["2024-10-01", "2024-10-02"])

    def test_reconstructs_settlement_from_three_or_more_expiry_day_pairs(self):
        lines = []
        for strike, call, put in ((19900, 101, 1), (20000, 1, 1), (20100, 1, 101)):
            lines += [row("2024/10/02", "202410W1", strike, "買權", settlement=str(call)),
                      row("2024/10/02", "202410W1", strike, "賣權", settlement=str(put))]
        records, audit = self.parse(lines, {"2024-10-02": {}}, {"202410W1": "2024-10-02"})
        self.assertEqual(len(records), 3)
        self.assertEqual(audit["settlement_reconstruction"]["2024-10-02"],
                         {"value": 20000, "status": "ok", "strikes": 3})

    def test_duplicate_side_is_audited_and_invalidated(self):
        lines = [row("2024/10/02", "202410W1", 20000, "買權", oi="10"),
                 row("2024/10/02", "202410W1", 20000, "買權", oi="11"),
                 row("2024/10/02", "202410W1", 20000, "賣權", oi="20")]
        records, audit = self.parse(lines, {"2024-10-02": {}}, {"202410W1": "2024-10-02"})
        self.assertEqual(audit["duplicate_side_rows"], 1)
        self.assertIsNone(records[0]["call_oi"])
        self.assertEqual(records[0]["put_oi"], 20)


if __name__ == "__main__":
    unittest.main()
