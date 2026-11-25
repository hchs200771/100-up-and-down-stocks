#!/usr/bin/env python3
"""全市場季報的合約負債、存貨、總資產（研究用，不在每日報告裡跑）。

資料源：公開資訊觀測站整季財報打包（inline XBRL 的 HTML，一季一個 zip，約 100MB）
  https://mopsov.twse.com.tw/server-java/FileDownLoad?step=9&fileName=tifrs-2026Q2.zip&filePath=/home/html/nas/ifrs/2026/

⚠️ 伺服器很慢（約 200KB/s）而且常在中途斷線、不支援續傳；檔案沒有中央目錄就當作失敗重抓。
⚠️ 同一家公司可能同時有合併（-cr-）與個體（-ir-）報表，優先用合併。
資產負債表數字是「季底時點值」，不像損益表要相減。

輸出：data/contract-liabilities-history/<YYYYQn>.json，單位千元；boardDate＝董事會通過財報日（實際公布日），reviewDate＝會計師核閱／查核報告日。
用法：python3 scripts/fetch-contract-liabilities.py [--from 2019Q1] [--to 2026Q3] [--jobs 4]
"""
import argparse, json, os, re, subprocess, sys, tempfile, time, zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

OUT = "data/contract-liabilities-history"
TAGS = {
    "ifrs-full:CurrentContractLiabilities": "clCur",
    "ifrs-full:NoncurrentContractLiabilities": "clNon",
    "ifrs-full:ContractLiabilities": "clAll",
    "ifrs-full:Inventories": "inv",
    "ifrs-full:Assets": "assets",
}
END = {1: "0331", 2: "0630", 3: "0930", 4: "1231"}
NF = re.compile(r'<ix:nonFraction\b([^>]*)>(.*?)</ix:nonFraction>', re.S)
NN = re.compile(r'<ix:nonNumeric\b[^>]*name="(tifrs-ar:ReviewAuditDate|tifrs-notes:DateAndProceduresOfAuthorisationForIssueOfFinancialStatements)"[^>]*>(.*?)</ix:nonNumeric>', re.S)
ROC = re.compile(r'民國\s*(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日')
FILE = re.compile(r'tifrs-fr\d-m\d-[a-z]+-(cr|ir)-([0-9A-Z]+)-\d{4}Q\d\.html$')


def quarters(a, b):
    y, q = int(a[:4]), int(a[5])
    while (y, q) <= (int(b[:4]), int(b[5])):
        yield f"{y}Q{q}"
        y, q = (y + 1, 1) if q == 4 else (y, q + 1)


def download(qs, tmpdir, tries=4):
    """回傳 (路徑, 是否完整)。全部失敗時回傳最大的一份殘檔，交給 entries() 用串流讀出已完整的檔案。"""
    url = f"https://mopsov.twse.com.tw/server-java/FileDownLoad?step=9&fileName=tifrs-{qs}.zip&filePath=/home/html/nas/ifrs/{qs[:4]}/"
    path = os.path.join(tmpdir, f"{qs}.zip")
    best = os.path.join(tmpdir, f"{qs}.best.zip")
    for i in range(1, tries + 1):
        subprocess.run(["curl", "-s", "-A", "Mozilla/5.0", "--max-time", "2400", "-o", path, url])
        try:
            with zipfile.ZipFile(path) as z:
                if len(z.namelist()) > 100:
                    return path, True
        except (zipfile.BadZipFile, FileNotFoundError):
            pass
        if os.path.exists(path) and (not os.path.exists(best) or os.path.getsize(path) > os.path.getsize(best)):
            os.replace(path, best)
        print(f"{qs} 第 {i} 次下載不完整，重抓", file=sys.stderr, flush=True)
        time.sleep(15 * i)
    if os.path.exists(best):
        return best, False
    raise RuntimeError(f"{qs} 下載失敗")


def entries(path, complete):
    """逐一產生 (檔名, 內容)。殘檔用 bsdtar 串流解開，最後一個被截斷的檔案會解壓失敗而略過。"""
    if complete:
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                yield name, z.read(name)
        return
    out = path + ".d"
    os.makedirs(out, exist_ok=True)
    subprocess.run(["bsdtar", "-xf", path, "-C", out], stderr=subprocess.DEVNULL)
    for name in os.listdir(out):
        with open(os.path.join(out, name), "rb") as f:
            yield name, f.read()
        os.remove(os.path.join(out, name))
    os.rmdir(out)


def parse(html, asof):
    got = {}
    for attrs, body in NF.findall(html):
        name = re.search(r'name="([^"]+)"', attrs)
        if not name or name.group(1) not in TAGS:
            continue
        ctx = re.search(r'contextRef="([^"]+)"', attrs)
        if not ctx or ctx.group(1) != asof:
            continue
        txt = re.sub(r'<[^>]+>', '', body).replace(',', '').strip()
        try:
            v = float(txt or 0)
        except ValueError:
            continue
        sc = re.search(r'scale="(-?\d+)"', attrs)
        v *= 10 ** (int(sc.group(1)) if sc else 0) / 1000  # 統一成千元
        if 'sign="-"' in attrs:
            v = -v
        got.setdefault(TAGS[name.group(1)], v)
    # 董事會通過日＝實際公布日（重大訊息同日發布）；核閱報告日當備援
    for name, body in NN.findall(html):
        txt = re.sub(r'\s+', '', re.sub(r'<[^>]+>', '', body))
        if name.endswith("ReviewAuditDate"):
            m = re.search(r'(\d{4})-?(\d{2})-?(\d{2})', txt)
            if m:
                got.setdefault("reviewDate", "-".join(m.groups()))
        else:
            m = ROC.search(txt)
            if m:
                y, mo, d = m.groups()
                got.setdefault("boardDate", f"{int(y) + 1911}-{int(mo):02d}-{int(d):02d}")
    return got


def one(qs, tmpdir):
    out = f"{OUT}/{qs}.json"
    if os.path.exists(out) and json.load(open(out)).get("version", 1) >= 2:
        return f"{qs} 已有，略過"
    t0 = time.time()
    path, complete = download(qs, tmpdir)
    asof = f"AsOf{qs[:4]}{END[int(qs[5])]}"
    stocks, kinds = {}, {}
    if True:
        for name, raw in entries(path, complete):
            m = FILE.search(name)
            if not m:
                continue
            kind, code = m.groups()
            if code in kinds and kinds[code] == "cr":
                continue
            html = raw.decode("utf-8", "ignore")
            g = parse(html, asof)
            if not g:
                continue
            cl = (g.get("clCur") or 0) + (g.get("clNon") or 0)
            if not cl and g.get("clAll"):
                cl = g["clAll"]
            stocks[code] = {"cl": round(cl), "inv": round(g.get("inv") or 0), "assets": round(g.get("assets") or 0), "src": kind,
                            "boardDate": g.get("boardDate"), "reviewDate": g.get("reviewDate")}
            kinds[code] = kind
    os.remove(path)
    prev = json.load(open(out)) if os.path.exists(out) else None
    if not complete:
        # 殘檔：涵蓋率不到上次完整抓取的九成就不寫，下次再試；夠的話把殘檔缺的公司用上次的數字補上（只缺公布日）
        base = len(prev["stocks"]) if prev else 0
        if base and len(stocks) < 0.9 * base:
            raise RuntimeError(f"{qs} 殘檔只有 {len(stocks)}/{base} 家，不採用")
        for code, r in (prev or {}).get("stocks", {}).items():
            stocks.setdefault(code, {**r, "boardDate": None, "reviewDate": None})
    snap = {"version": 2, "complete": complete, "quarter": qs, "fetchedAt": datetime.now(timezone.utc).isoformat(), "unit": "千元", "stocks": stocks}
    with open(out, "w") as f:
        json.dump(snap, f, ensure_ascii=False)
    dated = sum(1 for r in stocks.values() if r.get("reviewDate") or r.get("boardDate"))
    return f"{qs} 完成 {len(stocks)} 家（有公布日 {dated}，{'完整' if complete else '殘檔'}），{time.time() - t0:.0f}s"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="a", default="2019Q1")
    ap.add_argument("--to", dest="b", default="2026Q3")
    ap.add_argument("--jobs", type=int, default=2)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="cl-zip-")
    with ThreadPoolExecutor(args.jobs) as ex:
        for f in [ex.submit(one, q, tmpdir) for q in reversed(list(quarters(args.a, args.b)))]:
            try:
                print(f.result(), flush=True)
            except Exception as e:
                print(f"失敗：{e}", flush=True)


if __name__ == "__main__":
    main()
