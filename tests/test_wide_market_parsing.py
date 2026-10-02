import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/fetch-wide-market-history.py"
SPEC = importlib.util.spec_from_file_location("wide_market_history", SCRIPT)
wide = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(wide)


class WideMarketParsingTests(unittest.TestCase):
    def test_twse_dynamic_columns_html_sign_and_missing_quotes(self):
        payload = {
            "date": "20200102",
            "stat": "OK",
            "tables": [
                {"fields": ["說明"], "data": []},
                {
                    "fields": ["收盤價", "成交金額", "證券名稱", "漲跌價差", "證券代號", "成交股數", "開盤價", "漲跌(+/-)", "最高價", "最低價"],
                    "data": [
                        ["--", "12,000,000", "測試一", "2.00", "2330", "100,000", "10", "<span>－</span>", "12", "9"],
                        ["10", "99,000,000", "量不足", "0", "1101", "99,999", "10", "+", "11", "9"],
                        ["10", "11,000,000", "ETF", "0", "0050", "200,000", "10", "+", "11", "9"],
                        ["10", "8,000,000", "缺量資料", "除息", "1301", "--", "10", "", "11", "9"],
                    ],
                },
            ],
        }
        rows = wide.parse_twse(payload, "20200102")
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["code"], "2330")
        self.assertEqual(rows[0]["change"], -2)
        self.assertEqual(rows[0]["changeLabel"], "－2.00")
        self.assertIsNone(rows[0]["close"])
        self.assertEqual(rows[0]["volume"], 100000)
        self.assertEqual(rows[1]["code"], "1101")
        self.assertEqual(rows[1]["volume"], 99999)
        self.assertEqual(rows[2]["code"], "1301")
        self.assertIsNone(rows[2]["volume"])
        self.assertIsNone(rows[2]["change"])
        self.assertEqual(rows[2]["changeLabel"], "除息")

    def test_tpex_preserves_ex_rights_label_and_next_reference(self):
        payload = {
            "date": "2020/01/02",
            "stat": "OK",
            "tables": [{
                "fields": ["成交金額(元)", "次日 參考價", "最低價", "證券 名稱", "漲跌", "成交股數", "收盤價", "最高價", "開盤價", "證券代號"],
                "data": [["20,000,000", "50.5", "--", "上櫃測試", "除息", "150,000", "--", "52", "51", "6488"]],
            }],
        }
        rows = wide.parse_tpex(payload, "20200102")
        self.assertEqual(rows[0]["code"], "6488")
        self.assertEqual(rows[0]["market"], "tpex")
        self.assertIsNone(rows[0]["change"])
        self.assertEqual(rows[0]["changeLabel"], "除息")
        self.assertEqual(rows[0]["nextReference"], 50.5)
        self.assertIsNone(rows[0]["low"])
        self.assertIsNone(rows[0]["close"])

    def test_rejects_mismatched_market_response_date(self):
        payload = {"date": "20200103", "stat": "OK", "tables": []}
        with self.assertRaisesRegex(wide.DataError, "date mismatch"):
            wide.parse_twse(payload, "20200102")
        with self.assertRaisesRegex(wide.DataError, "date mismatch"):
            wide.parse_tpex(payload, "20200102")

    def test_tpex_rejects_missing_status_and_zero_eligible_rows(self):
        missing_status = {"date": "20200102", "tables": []}
        with self.assertRaisesRegex(wide.DataError, "status"):
            wide.parse_tpex(missing_status, "20200102")
        zero = {"date": "20200102", "stat": "OK", "tables": [{
            "fields": ["證券代號", "證券名稱", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價"],
            "data": [["0050", "ETF", "200000", "10000000", "10", "10", "10", "10"]],
        }]}
        with self.assertRaisesRegex(wide.DataError, "zero eligible"):
            wide.parse_tpex(zero, "20200102")

    def test_missing_required_market_columns_are_schema_errors(self):
        payload = {"date": "20200102", "stat": "OK", "tables": [{
            "fields": ["證券代號", "證券名稱", "成交股數", "開盤價", "最高價", "最低價", "收盤價"],
            "data": [["2330", "台積電", "100000", "10", "11", "9", "10"]],
        }]}
        with self.assertRaisesRegex(wide.DataError, "成交金額"):
            wide.parse_twse(payload, "20200102")


if __name__ == "__main__":
    unittest.main()
