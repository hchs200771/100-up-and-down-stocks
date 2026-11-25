#!/usr/bin/env python3
"""財報實際公布日（含時間）：從公開資訊觀測站「每日重大訊息」找「董事會通過第X季財務報告」的公告。

資料源：POST https://mopsov.twse.com.tw/mops/web/ajax_t05st02
  encodeURIComponent=1&step=0&firstin=true&off=1&TYPEK=sii|otc&year=<民國>&month=MM&day=DD
  一次回傳那一天（含前一天盤後）的所有重大訊息：發言日期、時間、代號、名稱、主旨。
  ⚠️ step=1 會回「查無需求資料」，一定要 step=0、firstin=true。

判定：主旨含「財務報」且含「通過／承認／核准」、不含「更正／重編」，依公告日期落在哪個申報窗口決定是哪一季：
  Q1 4/1–5/25、Q2 7/1–8/24、Q3 10/1–11/24、年報 隔年 1/15–4/10。同一家公司同一季取最早一筆。
輸出：data/financial-report-dates/<YYYYQn>.json = {quarter, stocks: {code: {date, time}}}
用法：python3 scripts/fetch-financial-report-dates.py --from 2019Q1 --to 2022Q2
"""
import argparse, json, re, sys, time, urllib.parse, urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data/financial-report-dates"
CACHE = ROOT / "data/backtest/mops-material-info"  # 每日原始列，不進 git
URL = "https://mopsov.twse.com.tw/mops/web/ajax_t05st02"


def window(qs):
    y, s = int(qs[:4]), int(qs[5])
    return {1: (date(y, 4, 1), date(y, 5, 25)), 2: (date(y, 7, 1), date(y, 8, 24)),
            3: (date(y, 10, 1), date(y, 11, 24)), 4: (date(y + 1, 1, 15), date(y + 1, 4, 10))}[s]


def quarters(a, b):
    y, q = int(a[:4]), int(a[5])
    while (y, q) <= (int(b[:4]), int(b[5])):
        yield f"{y}Q{q}"
        y, q = (y + 1, 1) if q == 4 else (y, q + 1)


def fetch_day(d: date, typek: str):
    f = CACHE / f"{d.isoformat()}-{typek}.json"
    if f.exists():
        return json.loads(f.read_text())
    body = urllib.parse.urlencode({"encodeURIComponent": 1, "step": 0, "firstin": "true", "off": 1, "TYPEK": typek,
                                   "year": d.year - 1911, "month": f"{d.month:02d}", "day": f"{d.day:02d}"}).encode()
    for i in range(1, 5):
        try:
            req = urllib.request.Request(URL, data=body, headers={"User-Agent": "Mozilla/5.0"})
            t = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "ignore")
            break
        except Exception as e:  # noqa: BLE001
            if i == 4:
                raise
            time.sleep(5 * i)
    rows = []
    if "查無" not in t:
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S):
            c = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", x)).replace("&nbsp;", "").strip()
                 for x in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
            if len(c) >= 5 and re.fullmatch(r"\d{2,3}/\d{2}/\d{2}", c[0]):
                y, m, dd = map(int, c[0].split("/"))
                rows.append([f"{y + 1911}-{m:02d}-{dd:02d}", c[1], c[2], c[3], c[4]])
    CACHE.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(rows, ensure_ascii=False))
    time.sleep(1.0)
    return rows


FIN = re.compile(r"財務報")
OK = re.compile(r"通過|承認|核准|提報")
BAD = re.compile(r"更正|重編|補正|重新")


def subject_season(subj):
    """主旨寫明是哪一季就以主旨為準；年報（年度財務報告、沒有「季」）算第 4 季。判斷不出回傳 None。"""
    if re.search(r"第\s*[一1１]\s*季|[一1１]\s*季|Q1", subj):
        return 1
    if re.search(r"第\s*[二2２]\s*季|上半年|半年度|Q2", subj):
        return 2
    if re.search(r"第\s*[三3３]\s*季|前三季|Q3", subj):
        return 3
    if re.search(r"年度.{0,8}財務報", subj) and "季" not in subj:
        return 4
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="a", default="2019Q1")
    ap.add_argument("--to", dest="b", default="2022Q2")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for qs in quarters(args.a, args.b):
        lo, hi = window(qs)
        stocks = {}
        d = lo
        while d <= hi:
            if d.weekday() < 5:
                for typek in ("sii", "otc"):
                    try:
                        rows = fetch_day(d, typek)
                    except Exception as e:  # noqa: BLE001
                        print(f"{d} {typek} 失敗：{e}", file=sys.stderr, flush=True)
                        continue
                    for dt, tm, code, name, subj in rows:
                        if not (lo.isoformat() <= dt <= hi.isoformat()):
                            continue
                        ss = subject_season(subj)
                        if ss is not None and ss != int(qs[5]):
                            continue
                        if FIN.search(subj) and OK.search(subj) and not BAD.search(subj):
                            cur = stocks.get(code)
                            if cur is None or (dt, tm) < (cur["date"], cur["time"]):
                                stocks[code] = {"date": dt, "time": tm, "subject": subj[:60]}
            d += timedelta(days=1)
        (OUT / f"{qs}.json").write_text(json.dumps({"quarter": qs, "stocks": stocks}, ensure_ascii=False))
        print(f"{qs} {len(stocks)} 家", flush=True)


if __name__ == "__main__":
    main()
