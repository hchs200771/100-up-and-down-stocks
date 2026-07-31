#!/usr/bin/env npx tsx
/**
 * 台股族群 RRG（相對輪動圖）資料產生器。
 *
 * 讀 data/sector-baskets.json 的【固定】族群籃子，抓 Yahoo Finance 2 年還原收盤價，
 * 把每個族群編成等權指數，對加權指數(^TWII)算 RS-Ratio / RS-Momentum，
 * 輸出與 rrg-radar 專案相同結構的 data/tw-rrg-data.json（可直接餵它的 template.html）。
 *
 * 演算法沿用 rrg-radar/build_data.py（JdK RS-Ratio 的開源近似）。
 */
import fs from 'fs';
import path from 'path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const WINDOWS = [120, 60, 20];
const TAIL_POINTS = 45;
const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, 'data', 'cache', 'yahoo-tw');

type Prices = Record<string, number>; // date -> adjusted close

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 抓單一 Yahoo ticker 的 2 年日線還原收盤。回 null 表示查無資料。 */
async function fetchYahoo(ticker: string): Promise<Prices | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const j: any = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp) return null;
  const closes = r.indicators?.adjclose?.[0]?.adjclose ?? r.indicators?.quote?.[0]?.close;
  if (!closes) return null;
  const out: Prices = {};
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    out[new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10)] = c;
  }
  return Object.keys(out).length ? out : null;
}

/** 台股代號不知道在上市還上櫃 → 先試 .TW 再試 .TWO。帶本機快取。 */
async function fetchTwStock(code: string, label: string): Promise<Prices | null> {
  const cacheFile = path.join(CACHE_DIR, `${code}.json`);
  if (fs.existsSync(cacheFile)) {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < 12 * 3600 * 1000) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    }
  }
  for (const suffix of ['.TW', '.TWO']) {
    try {
      const p = await fetchYahoo(code + suffix);
      if (p && Object.keys(p).length > 300) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(p));
        console.log(`  ${code} ${label}: ${Object.keys(p).length} days (${suffix})`);
        return p;
      }
    } catch {
      /* try next suffix */
    }
    await sleep(300);
  }
  console.log(`  ${code} ${label}: NOT FOUND — skipped`);
  return null;
}

function ema(vals: (number | null)[], span: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (span + 1);
  let prev: number | null = null;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null) { prev = null; continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function mean(a: number[]) { return a.reduce((s, x) => s + x, 0) / a.length; }
function pstdev(a: number[]) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}

/** 100 + 滾動 z-score */
function zseries(vals: (number | null)[], w: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  for (let i = w - 1; i < vals.length; i++) {
    const win = vals.slice(i - w + 1, i + 1);
    if (win.some((v) => v == null)) continue;
    const nums = win as number[];
    const s = pstdev(nums);
    out[i] = s > 1e-12 ? 100 + ((vals[i] as number) - mean(nums)) / s : 100;
  }
  return out;
}

/** RS-Ratio / RS-Momentum（同 rrg-radar/build_data.py 的 rrg_series） */
function rrgSeries(sec: number[], bench: number[], w: number) {
  const rs = ema(sec.map((a, i) => (100 * a) / bench[i]), 5);
  const ratio = ema(zseries(rs, w), 3);
  const p = Math.max(3, Math.floor(w / 12));
  const roc: (number | null)[] = new Array(ratio.length).fill(null);
  for (let i = 0; i < ratio.length; i++) {
    if (ratio[i] != null && i - p >= 0 && ratio[i - p]) {
      roc[i] = (100 * (ratio[i] as number)) / (ratio[i - p] as number);
    }
  }
  const mom: (number | null)[] = new Array(roc.length).fill(null);
  for (let i = 0; i < roc.length; i++) {
    if (i - w + 1 < 0) continue;
    const win = roc.slice(i - w + 1, i + 1);
    if (win.some((v) => v == null)) continue;
    const nums = win as number[];
    const s = pstdev(nums);
    mom[i] = s > 1e-12 ? 100 + ((roc[i] as number) - mean(nums)) / s : 100;
  }
  return { ratio, mom: ema(mom, 3) };
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sector-baskets.json'), 'utf-8'));

  console.log(`Fetching benchmark ${cfg.benchmark.code}...`);
  const benchPrices = await fetchYahoo(cfg.benchmark.code);
  if (!benchPrices) throw new Error('benchmark fetch failed');

  // Yahoo 的最後一根可能是當日未收盤的即時報價 → 一律丟掉，避免污染。
  const benchDates = Object.keys(benchPrices).sort();
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (benchDates[benchDates.length - 1] >= todayUtc) {
    delete benchPrices[benchDates[benchDates.length - 1]];
    console.log(`  dropped incomplete last bar (${benchDates[benchDates.length - 1]})`);
  }

  const priceCache: Record<string, Prices> = {};
  for (const b of cfg.baskets) {
    console.log(`\n[${b.canonical}]`);
    for (const [code, label] of b.members) {
      if (priceCache[code]) continue;
      const p = await fetchTwStock(code, label);
      if (p) priceCache[code] = p;
      await sleep(250);
    }
  }

  // 每個族群：取成分股共同交易日，各股正規化為「相對起點的報酬指數」後等權平均。
  // 等權而非市值加權：族群輪動要看資金是否【普遍】進場，市值加權會被單一權值股綁架。
  const basketSeries: { canonical: string; prices: Prices; n: number }[] = [];
  for (const b of cfg.baskets) {
    const members = b.members.filter(([c]: [string, string]) => priceCache[c]);
    if (members.length < 3) {
      console.log(`SKIP ${b.canonical}: only ${members.length} members resolved`);
      continue;
    }
    let dates = Object.keys(benchPrices);
    for (const [c] of members) dates = dates.filter((d) => priceCache[c][d] != null);
    dates.sort();
    if (dates.length < 200) {
      console.log(`SKIP ${b.canonical}: only ${dates.length} common days`);
      continue;
    }
    const base: Record<string, number> = {};
    for (const [c] of members) base[c] = priceCache[c][dates[0]];
    const idx: Prices = {};
    for (const d of dates) {
      idx[d] = mean(members.map(([c]: [string, string]) => (100 * priceCache[c][d]) / base[c]));
    }
    basketSeries.push({ canonical: b.canonical, prices: idx, n: members.length });
  }

  // 全族群 + benchmark 的共同交易日
  let dates = Object.keys(benchPrices);
  for (const b of basketSeries) dates = dates.filter((d) => b.prices[d] != null);
  dates.sort();
  const bench = dates.map((d) => benchPrices[d]);
  console.log(`\nCommon trading days: ${dates.length} (${dates[0]} → ${dates[dates.length - 1]})`);

  const series = basketSeries.map((b) => {
    const sec = dates.map((d) => b.prices[d]);
    const tf: Record<string, ([number, number] | null)[]> = {};
    for (const w of WINDOWS) {
      const { ratio, mom } = rrgSeries(sec, bench, w);
      const pts: ([number, number] | null)[] = [];
      for (let i = dates.length - TAIL_POINTS; i < dates.length; i++) {
        pts.push(ratio[i] == null || mom[i] == null
          ? null
          : [+(ratio[i] as number).toFixed(3), +(mom[i] as number).toFixed(3)]);
      }
      tf[String(w)] = pts;
    }
    return { ticker: b.canonical, label: `${b.canonical} (${b.n})`, tf };
  });

  const out = {
    generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    windows: WINDOWS,
    universes: {
      tw_sectors: {
        name: '台股族群輪動',
        benchmark: cfg.benchmark.code,
        benchmark_name: cfg.benchmark.label,
        dates: dates.slice(-TAIL_POINTS),
        series,
      },
    },
  };
  const outPath = path.join(ROOT, 'data', 'tw-rrg-data.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 0));
  console.log(`\nWrote ${outPath}: ${series.length} sectors, basket version ${cfg.version}`);

  // 落地檢查：印出 120 日視窗最新象限，方便肉眼驗證是否合理
  const quad = (x: number, y: number) =>
    x >= 100 && y >= 100 ? '1 領先' : x < 100 && y >= 100 ? '2 改善' : x < 100 ? '3 落後' : '4 弱化';
  console.log('\n=== 120日視窗・最新象限 ===');
  const rows = series
    .map((s) => ({ label: s.ticker, p: s.tf['120'].filter(Boolean).slice(-1)[0] as [number, number] }))
    .filter((r) => r.p)
    .sort((a, b) => b.p[0] - a.p[0]);
  for (const r of rows) {
    console.log(`  ${quad(r.p[0], r.p[1])}  RS=${r.p[0].toFixed(2)} Mom=${r.p[1].toFixed(2)}  ${r.label}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
