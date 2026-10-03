#!/usr/bin/env python3
"""Restore the versioned public research checkpoint to ignored local cache paths."""
from pathlib import Path
import gzip,hashlib,json,re,tarfile,shutil
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'research'
TARGET=ROOT/'data/backtest'
archive=SOURCE/'wide-market/cache-2026-10-02.tar.xz'
provenance=json.loads((SOURCE/'wide-market/checkpoint.json').read_text())
actual=hashlib.sha256(archive.read_bytes()).hexdigest()
if actual!=provenance['archiveSha256']: raise RuntimeError('Research archive checksum mismatch')
count=0
with tarfile.open(archive,'r:xz') as tar:
 for member in tar:
  name=member.name
  allowed=re.fullmatch(r'daily/(twse|tpex)/\d{4}-\d{2}-\d{2}\.json',name) or re.fullmatch(r'actions/[\w-]+\.json',name) or name=='manifest.json'
  if not member.isfile() or not allowed or member.size>32*1024*1024: raise RuntimeError('Unexpected archive member '+name)
  payload=tar.extractfile(member).read()
  path=TARGET/'wide'/name
  if name.startswith('daily/'):
   path=path.with_suffix('.json.gz');path.parent.mkdir(parents=True,exist_ok=True)
   with gzip.open(path,'wb',compresslevel=6) as stream:stream.write(payload)
  else:
   path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(payload)
  count+=1
 if count!=provenance['archiveMembers']: raise RuntimeError('Research archive file count mismatch')
for source,destination in [
 ('wide-market/results.json.gz','wide/results.json'),
 ('pick-price-input.json.gz','price-input.json'),
 ('pick-filter-results.json.gz','pick-filter-results.json'),
 ('factor-evidence-audit.json.gz','factor-evidence-audit.json'),
 ('top60-pilot-input.json.gz','expanded/expanded-input.json'),
]:
 path=TARGET/destination;path.parent.mkdir(parents=True,exist_ok=True)
 path.write_bytes(gzip.decompress((SOURCE/source).read_bytes()))
print(f'Restored {count} cache files plus results and research inputs. Local cache: {TARGET}')
