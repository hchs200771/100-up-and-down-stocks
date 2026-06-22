#!/usr/bin/env python3
"""
凱基期貨持倉擷取模組（KGI SUPER PY）。

這支程式負責「連上凱基、登入、抓取保證金與期貨部位」，並輸出一份標準 JSON
(data/kgi-positions.json)，給 Mac 上的 TS pipeline (scripts/analyze-positions.ts) 消費。

────────────────────────────────────────────────────────────────────────
為什麼要獨立成 Python 程式？
- 凱基官方 kgisuperpy 只支援 Windows / Linux，且連線限「台灣 IP、平日 10:00–22:00」。
- 你的報告 pipeline 跑在 macOS，無法直接 import kgisuperpy。
- 所以這支程式要跑在「台灣的 Linux/Windows 主機」（或你本機的 Windows/Linux、或台灣 VPS），
  產生 kgi-positions.json，再讓 Mac 端讀檔分析。兩邊只靠這份 JSON 溝通。
────────────────────────────────────────────────────────────────────────

安裝：
    python -m pip install kgisuperpy        # 需 64-bit Python 3.9–3.13

環境變數（建議放 .env 或主機環境）：
    KGI_PERSON_ID     身分證字號 / 登入帳號
    KGI_PERSON_PWD    登入密碼
    KGI_SIMULATION    "1" 走模擬、"0" 走正式（預設 1，先用模擬測通）
    KGI_CA_PATH       憑證檔路徑（若 SDK 需要）
    KGI_CA_PWD        憑證密碼（若 SDK 需要）
    KGI_OUT_PATH      輸出路徑（預設 data/kgi-positions.json）

⚠️ 標了 TODO(confirm) 的兩個函式（_query_margin / _query_positions）裡的「實際方法名與欄位名」，
   需要你對照凱基 FutAccount 官方文件確認後微調——我用的是最合理的推測名稱，先讓骨架成立。
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone, timedelta

OUT_PATH = os.environ.get("KGI_OUT_PATH", "data/kgi-positions.json")
TPE = timezone(timedelta(hours=8))


def _login():
    """登入凱基，回傳 api 物件。"""
    import kgisuperpy as kgi  # 延遲 import：沒裝/不支援平台時才報錯

    person_id = os.environ["KGI_PERSON_ID"]
    person_pwd = os.environ["KGI_PERSON_PWD"]
    simulation = os.environ.get("KGI_SIMULATION", "1") == "1"

    api = kgi.login(person_id, person_pwd, simulation)

    # CA 憑證啟用：正式下單/帳務查詢前必須啟用憑證。
    # TODO(confirm): 確認 kgisuperpy 啟用憑證的實際呼叫（方法名/參數可能不同）。
    ca_path = os.environ.get("KGI_CA_PATH")
    if ca_path and hasattr(api, "activate_ca"):
        api.activate_ca(
            ca_path=ca_path,
            ca_passwd=os.environ.get("KGI_CA_PWD", ""),
            person_id=person_id,
        )
    return api


def _to_float(x, default=0.0):
    try:
        return float(str(x).replace(",", ""))
    except (TypeError, ValueError):
        return default


def _query_margin(api) -> dict:
    """
    查詢保證金 / 權益數 / 風險指標。
    TODO(confirm): FutAccount 取得保證金的實際方法與欄位名稱請對照凱基文件調整。
    回傳統一 schema（金額單位：元）。
    """
    acct = api.FutAccount(api) if hasattr(api, "FutAccount") else api  # 介面依 SDK 而定
    raw = acct.margin()  # ← 推測方法名，需確認

    # raw 可能是 dataclass / dict，下面用 getattr+dict 兩種方式都試。
    def g(*keys, default=None):
        for k in keys:
            if isinstance(raw, dict) and k in raw:
                return raw[k]
            if hasattr(raw, k):
                return getattr(raw, k)
        return default

    equity = _to_float(g("equity_amount", "equity", "EquityAmount"))
    initial = _to_float(g("initial_margin", "InitialMargin", "OrderMargin"))
    maintenance = _to_float(g("maintenance_margin", "MaintenanceMargin"))
    available = _to_float(g("available_margin", "AvailableMargin", "excess"))
    # 風險指標：凱基/期交所常見 = 權益總值 / 未沖銷部位所需維持保證金 ×100%
    risk_ratio = _to_float(g("risk_indicator", "risk_ratio", "RiskRatio"), default=0.0)
    if risk_ratio == 0.0 and maintenance > 0:
        risk_ratio = round(equity / maintenance * 100, 2)

    return {
        "equity": equity,
        "initialMargin": initial,
        "maintenanceMargin": maintenance,
        "available": available,
        "riskRatio": risk_ratio,  # 單位：%
        "currency": "TWD",
    }


def _classify(contract_code: str, category: str | None) -> str:
    """把部位分類成 stock_future / micro_taiex / option / index_future。"""
    c = (category or "").lower()
    code = (contract_code or "").upper()
    if "option" in c or code.endswith("O") or code in ("TXO", "TEO"):
        return "option"
    if code.startswith("MTX") or "微型臺指" in (category or "") or "微臺" in (category or ""):
        return "micro_taiex"
    # 個股期貨契約代碼通常為 2–3 碼英數，且對應到某檔股票
    if "stock" in c or "個股" in (category or ""):
        return "stock_future"
    if code in ("TX", "TXF", "MTX", "TE", "TF"):
        return "index_future"
    return "stock_future" if len(code) <= 3 else "index_future"


def _query_positions(api) -> list[dict]:
    """
    查詢期貨未平倉部位（含個股期貨 / 微臺 / 選擇權）。
    TODO(confirm): FutAccount 取得部位的實際方法與欄位名稱請對照凱基文件調整。
    """
    acct = api.FutAccount(api) if hasattr(api, "FutAccount") else api
    rows = acct.positions()  # ← 推測方法名，需確認；可能是 list_positions()/unrealized_positions()

    out = []
    for r in rows or []:
        def g(*keys, default=None):
            for k in keys:
                if isinstance(r, dict) and k in r:
                    return r[k]
                if hasattr(r, k):
                    return getattr(r, k)
            return default

        contract_code = str(g("contract_code", "symbol", "ContractCode", default="") or "")
        category = g("category", "product_type", "Category")
        side_raw = str(g("side", "bs", "Side", default="") or "").lower()
        side = "long" if side_raw in ("b", "buy", "long", "多") else "short"

        out.append({
            "type": _classify(contract_code, category),
            "contractCode": contract_code,
            "contractName": str(g("contract_name", "name", "ContractName", default="") or ""),
            # 個股期貨對應現股代號：凱基若有直接給就用；沒有則留空，由 Mac 端用對照表補。
            "underlyingCode": str(g("underlying_code", "stock_id", "UnderlyingCode", default="") or ""),
            "underlyingName": str(g("underlying_name", "UnderlyingName", default="") or ""),
            "side": side,
            "lots": int(_to_float(g("quantity", "lots", "Quantity"))),
            "avgPrice": _to_float(g("avg_price", "price", "AvgPrice")),
            "marketPrice": _to_float(g("market_price", "last_price", "MarketPrice")),
            "pnl": _to_float(g("pnl", "unrealized_pnl", "UnrealizedPnL")),
        })
    return out


def main() -> int:
    try:
        api = _login()
    except ModuleNotFoundError:
        print("[error] 未安裝 kgisuperpy，或此平台不支援（macOS 不支援，請在 Windows/Linux+台灣IP 執行）。", file=sys.stderr)
        return 2
    except KeyError as e:
        print(f"[error] 缺少環境變數 {e}。請設定 KGI_PERSON_ID / KGI_PERSON_PWD 等。", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001
        print(f"[error] 凱基登入失敗：{e}", file=sys.stderr)
        return 1

    try:
        margin = _query_margin(api)
        positions = _query_positions(api)
    except Exception as e:  # noqa: BLE001
        print(f"[error] 查詢保證金/部位失敗（多半是方法名需對照文件調整）：{e}", file=sys.stderr)
        return 1

    payload = {
        "fetchedAt": datetime.now(TPE).isoformat(),
        "margin": margin,
        "positions": positions,
    }
    os.makedirs(os.path.dirname(OUT_PATH) or ".", exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"[ok] 寫出 {len(positions)} 筆部位、保證金風險指標 {margin['riskRatio']}% → {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
