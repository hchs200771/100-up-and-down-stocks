#!/usr/bin/env python3
"""Cache official TWSE ex-right/dividend references, effective dates only."""
import json,re,urllib.request,time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'data/backtest/wide/actions'
OUT.mkdir(parents=True,exist_ok=True)
def fetch(year):
 path=OUT/f'twse-ex-{year}.json'
 url=f'https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate={year}0101&endDate={year}1231&response=json'
 if path.exists(): return json.loads(path.read_text())
 with urllib.request.urlopen(url,timeout=45) as r: p=json.load(r)
 if p.get('stat')!='OK' or not p.get('data'): raise RuntimeError(f'{year}: {p.get("stat")}')
 path.write_text(json.dumps(p,ensure_ascii=False))
 return p
with ThreadPoolExecutor(max_workers=2) as pool:
 payloads=list(pool.map(fetch,range(2019,2027)))
rows=[]
for p in payloads:
 f=p['fields']
 for r in p['data']:
  code=r[f.index('股票代號')].strip()
  if not re.fullmatch(r'[1-9]\d{3}',code): continue
  ds=re.fullmatch(r'(\d+)年(\d+)月(\d+)日',r[f.index('資料日期')])
  if not ds: raise RuntimeError('Unknown date '+r[0])
  y,m,d=map(int,ds.groups()); date=f'{y+1911:04d}-{m:02d}-{d:02d}'
  def number(key): return float(r[f.index(key)].replace(',',''))
  rows.append({'code':code,'date':date,'reference':number('除權息參考價'),'before':number('除權息前收盤價'),'kind':r[f.index('權/息')]})
# Official capital-reduction reference prices across the same historical range.
reduction_path=OUT/'twse-capital-reductions.json'
if reduction_path.exists():
 reduction=json.loads(reduction_path.read_text())
else:
 reduction_url='https://www.twse.com.tw/rwd/zh/reducation/TWTAUU?startDate=20190101&endDate=20260930&response=json'
 with urllib.request.urlopen(reduction_url,timeout=45) as response: reduction=json.load(response)
 if reduction.get('stat')!='OK': raise RuntimeError('Invalid capital-reduction response')
 reduction_path.write_text(json.dumps(reduction,ensure_ascii=False))
f=reduction['fields']
for r in reduction['data']:
 code=r[f.index('股票代號')].strip()
 if not re.fullmatch(r'[1-9]\d{3}',code): continue
 y,m,d=map(int,r[f.index('恢復買賣日期')].split('/'))
 rows.append({'code':code,'date':f'{y+1911:04d}-{m:02d}-{d:02d}',
  'reference':float(r[f.index('恢復買賣參考價')].replace(',','')),
  'before':float(r[f.index('停止買賣前收盤價格')].replace(',','')),
  'kind':'減資:'+r[f.index('減資原因')]})
# TPEx yearly result sheets avoid the large all-year response.
import urllib.parse
for year in range(2019,2027):
 cache=OUT/f'tpex-ex-{year}.json'
 if cache.exists(): payload=json.loads(cache.read_text())
 else:
  url='https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?'+urllib.parse.urlencode({'startDate':f'{year}/01/01','endDate':f'{year}/12/31','response':'json'})
  with urllib.request.urlopen(url,timeout=45) as response: payload=json.load(response)
  if payload.get('stat')!='ok': raise RuntimeError(f'TPEx {year}: bad status')
  cache.write_text(json.dumps(payload,ensure_ascii=False))
 for table in payload.get('tables',[]):
  f=table['fields']
  for r in table['data']:
   code=r[f.index('代號')].strip()
   if not re.fullmatch(r'[1-9]\d{3}',code): continue
   y,m,d=map(int,r[f.index('除權息日期')].split('/'))
   rows.append({'code':code,'date':f'{y+1911:04d}-{m:02d}-{d:02d}',
    'reference':float(r[f.index('除權息參考價')].replace(',','')),
    'before':float(r[f.index('除權息前收盤價')].replace(',','')),
    'kind':r[f.index('權/息')]})
# The global face-value changes dataset is publicly available without paid access.
split_path=OUT/'finmind-splits.json'
if split_path.exists(): split=json.loads(split_path.read_text())
else:
 url='https://api.finmindtrade.com/api/v4/data?'+urllib.parse.urlencode({'dataset':'TaiwanStockSplitPrice','start_date':'2019-01-01','end_date':'2026-09-30'})
 with urllib.request.urlopen(url,timeout=45) as response: split=json.load(response)
 if split.get('status')!=200: raise RuntimeError('Incomplete face-value change data')
 split_path.write_text(json.dumps(split,ensure_ascii=False))
for r in split['data']:
 rows.append({'code':r['stock_id'],'date':r['date'],'reference':r['after_price'],'before':r['before_price'],'kind':'面額變更'})
path=OUT/'twse-ex-references.json'
path.write_text(json.dumps({'source':'TWSE TWT49U + TWTAUU; TPEx exDailyQ; FinMind TaiwanStockSplitPrice','years':list(range(2019,2027)),'rows':rows},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'file':str(path),'ordinaryStockEvents':len(rows)},ensure_ascii=False))
