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

/** 同時在跑的 Yahoo 請求數上限。抓價全是網路等待、CPU 閒置，序列跑純粹浪費 wall-clock。 */
const FETCH_CONCURRENCY = 6;

/**
 * 有限併發的 map：開 `limit` 條 worker 從同一個 queue 取件，回傳結果順序與輸入一致。
 *
 * 為什麼需要：245 檔成分股原本是一檔接一檔抓、每檔之間還 sleep 250ms，
 * 光這一段就佔掉整份 RRG 的絕大部分時間，而且全程只是在等網路。
 * 不用無上限的 Promise.all 是怕一次打幾百個請求被 Yahoo 擋。
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchRange(ticker: string, range: string): Promise<Prices | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
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

/**
 * 抓單一 Yahoo ticker 的 2 年日線還原收盤。回 null 表示查無資料。
 *
 * 為什麼要再抓一次 range=1mo 疊上去：Yahoo 的長區間查詢對「最新一根」常常回 null
 * （同一支用 range=1mo 查就有值）。只用 2y 的話全部標的都會缺當日，
 * 族群指數在大漲/大跌日原地不動、RRG 會做出完全相反的判讀。短區間優先覆蓋。
 */
async function fetchYahoo(ticker: string): Promise<Prices | null> {
  // 兩個區間互不相依，同時發出、短區間覆蓋長區間，省掉一趟往返。
  const [long, recent] = await Promise.all([fetchRange(ticker, '2y'), fetchRange(ticker, '1mo')]);
  if (!long) return null;
  if (recent) Object.assign(long, recent);
  return Object.keys(long).length ? long : null;
}

/** 哪一檔在上市(.TW)、哪一檔在上櫃(.TWO) —— 給前端組 Yahoo 股市連結用。 */
const suffixOf: Record<string, string> = {};

/**
 * 全球／美股的三組輪動（標的定義沿用隔壁 rrg-radar 專案的 build_data.py）。
 * 改用本專案的 TS 管線重跑，是為了讓四組 universe 出自同一份資料、同一個時間戳，
 * 而不是一半新一半舊——rrg-radar 是手動跑的 Python，它的 rrg_data.json 常常過期。
 * 這些成分是單一 ETF（不是籃子），所以 members 只有自己一檔，連到美股 Yahoo。
 */
const GLOBAL_UNIVERSES: {
  key: string; name: string; benchmark: string; benchmarkName: string;
  members: [string, string][];
}[] = [
  {
    key: 'assets', name: '全球資產輪動', benchmark: 'ACWI', benchmarkName: '全球股票 ACWI',
    members: [
      ['SPY', '美股'], ['EFA', '成熟市場股'], ['EEM', '新興市場股'],
      ['VNQ', '房地產REIT'], ['GLD', '黃金'], ['DBC', '大宗商品'],
      ['TLT', '美長天期公債'], ['LQD', '投資級公司債'], ['HYG', '高收益債'],
      ['UUP', '美元'], ['BTC-USD', '比特幣'],
    ],
  },
  {
    key: 'us_sectors', name: '美股板塊輪動', benchmark: 'SPY', benchmarkName: '標普500 SPY',
    members: [
      ['XLK', '科技'], ['XLC', '通訊'], ['XLY', '非必需消費'],
      ['XLP', '必需消費'], ['XLV', '醫療保健'], ['XLF', '金融'],
      ['XLI', '工業'], ['XLE', '能源'], ['XLB', '原物料'],
      ['XLU', '公用事業'], ['XLRE', '房地產'],
    ],
  },
  {
    key: 'markets', name: '全球市場輪動', benchmark: 'ACWI', benchmarkName: '全球股票 ACWI',
    members: [
      ['SPY', '美股'], ['VGK', '歐股'], ['EWJ', '日股'], ['EWT', '台股'],
      ['MCHI', '陸股'], ['EWY', '韓股'], ['INDA', '印度'],
    ],
  },
];

const US_CACHE_DIR = path.join(ROOT, 'data', 'cache', 'yahoo-us');

/** 美股/全球標的：單純快取版的 fetchYahoo。 */
async function fetchUs(ticker: string): Promise<Prices | null> {
  const cacheFile = path.join(US_CACHE_DIR, `${ticker.replace(/[^\w.-]/g, '_')}.json`);
  if (fs.existsSync(cacheFile)) {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < 12 * 3600 * 1000) return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  }
  const p = await fetchYahoo(ticker);
  if (p && Object.keys(p).length > 300) {
    fs.mkdirSync(US_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(p));
    return p;
  }
  console.log(`  ${ticker}: NOT FOUND — skipped`);
  return null;
}

/** 台股代號不知道在上市還上櫃 → 先試 .TW 再試 .TWO。帶本機快取。 */
async function fetchTwStock(code: string, label: string): Promise<Prices | null> {
  const cacheFile = path.join(CACHE_DIR, `${code}.json`);
  if (fs.existsSync(cacheFile)) {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < 12 * 3600 * 1000) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      // 舊版快取直接存價格表、沒有 suffix；讀到就先當上市，下次過期重抓時會補正。
      if (cached && typeof cached === 'object' && cached.prices) {
        suffixOf[code] = cached.suffix || '.TW';
        return cached.prices;
      }
      suffixOf[code] = '.TW';
      return cached;
    }
  }
  for (const suffix of ['.TW', '.TWO']) {
    try {
      const p = await fetchYahoo(code + suffix);
      if (p && Object.keys(p).length > 300) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ suffix, prices: p }));
        suffixOf[code] = suffix;
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

/**
 * 把「若干單一標的 vs 一個 benchmark」組成一個 universe。
 * closeUtcMin：該市場收盤的 UTC 分鐘數（+緩衝）；當天還沒收完就丟掉最後一根。
 * 美股 16:00 ET ≈ 20:00/21:00 UTC，而盤後報告多在 15:00 UTC 前後跑，所以正常會丟掉當日。
 */
async function buildGlobalUniverse(def: (typeof GLOBAL_UNIVERSES)[number], closeUtcMin: number) {
  console.log(`\n[${def.name}] benchmark ${def.benchmark}`);
  const benchPrices = await fetchUs(def.benchmark);
  if (!benchPrices) { console.log(`  SKIP ${def.key}: benchmark fetch failed`); return null; }

  const bd = Object.keys(benchPrices).sort();
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const last = bd[bd.length - 1];
  if (last > todayUtc || (last === todayUtc && utcMinutes < closeUtcMin)) {
    delete benchPrices[last];
    console.log(`  dropped incomplete last bar (${last})`);
  }

  const prices: Record<string, Prices> = {};
  const fetchedUs = await mapPool(def.members, FETCH_CONCURRENCY, ([t]) => fetchUs(t));
  def.members.forEach(([t, label], i) => {
    const p = fetchedUs[i];
    if (p) prices[t] = p;
    else console.log(`  ${t} ${label}: missing`);
  });
  const members = def.members.filter(([t]) => prices[t]);
  if (members.length < 3) { console.log(`  SKIP ${def.key}: only ${members.length} members`); return null; }

  let dates = Object.keys(benchPrices);
  for (const [t] of members) dates = dates.filter((d) => prices[t][d] != null);
  dates.sort();
  if (dates.length < 200) { console.log(`  SKIP ${def.key}: only ${dates.length} common days`); return null; }
  const bench = dates.map((d) => benchPrices[d]);

  const series = members.map(([t, label]) => {
    const sec = dates.map((d) => prices[t][d]);
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
    // 'US' 是給前端判斷要連到哪個 Yahoo 網域的標記，不是交易所後綴。
    return { ticker: t, label, tf, members: [[t, label, 'US']] };
  });

  console.log(`  ${series.length} series, ${dates.length} days (${dates[0]} → ${dates[dates.length - 1]})`);
  return {
    key: def.key,
    uni: {
      name: def.name,
      benchmark: def.benchmark,
      benchmark_name: def.benchmarkName,
      dates: dates.slice(-TAIL_POINTS),
      series,
    },
  };
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sector-baskets.json'), 'utf-8'));

  console.log(`Fetching benchmark ${cfg.benchmark.code}...`);
  const benchPrices = await fetchYahoo(cfg.benchmark.code);
  if (!benchPrices) throw new Error('benchmark fetch failed');

  // Yahoo 的最後一根若是「當日尚未收盤」的即時報價就要丟掉，否則會污染整條序列。
  // 但台股 13:30 (TWT) = 05:30 UTC 就收盤了，盤後報告都在那之後才跑——
  // 無條件丟掉當日會讓 RRG 永遠落後一個交易日（實際踩過這個坑）。
  // 規則：只有在「台股當天還沒收完」時才丟。留 30 分鐘緩衝給 Yahoo 落檔。
  const benchDates = Object.keys(benchPrices).sort();
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const TW_CLOSE_UTC_MIN = 6 * 60; // 05:30 收盤 + 30 分鐘緩衝
  const lastBar = benchDates[benchDates.length - 1];
  if (lastBar > todayUtc || (lastBar === todayUtc && utcMinutes < TW_CLOSE_UTC_MIN)) {
    delete benchPrices[lastBar];
    console.log(`  dropped incomplete last bar (${lastBar})`);
  }

  // 成分股跨籃子會重複（例如權值股同時在好幾個籃子裡），先去重再併發抓。
  // 去重與併發都不影響結果：fetchTwStock 是純讀取 + 本機快取，籃子的組成在後面才用得到。
  const uniqueMembers: [string, string][] = [];
  const seen = new Set<string>();
  for (const b of cfg.baskets) {
    for (const [code, label] of b.members as [string, string][]) {
      if (seen.has(code)) continue;
      seen.add(code);
      uniqueMembers.push([code, label]);
    }
  }

  console.log(
    `\nFetching ${uniqueMembers.length} unique constituents across ${cfg.baskets.length} baskets (concurrency ${FETCH_CONCURRENCY})...`,
  );
  const priceCache: Record<string, Prices> = {};
  const fetchedTw = await mapPool(uniqueMembers, FETCH_CONCURRENCY, ([code, label]) =>
    fetchTwStock(code, label),
  );
  uniqueMembers.forEach(([code], i) => {
    const p = fetchedTw[i];
    if (p) priceCache[code] = p;
  });

  // 個股缺值往 benchmark 的日期軸上補（沿用前一日收盤，最多補 MAX_FFILL 天）。
  // 不補的話：只要有【一檔】成分股在 Yahoo 落檔較慢，全部 25 個族群的最新一天就會一起消失
  // ——實際發生過（寶雅 5904 慢一天，整份 RRG 就停在前一個交易日）。
  const MAX_FFILL = 3;
  const filledOn: Record<string, number> = {}; // 日期 -> 有幾檔是補出來的
  {
    const axis = Object.keys(benchPrices).sort();
    for (const code of Object.keys(priceCache)) {
      const p = priceCache[code];
      let prev: number | null = null;
      let gap = 0;
      for (const d of axis) {
        if (p[d] != null) {
          prev = p[d];
          gap = 0;
        } else if (prev != null && gap < MAX_FFILL) {
          p[d] = prev;
          gap++;
          filledOn[d] = (filledOn[d] || 0) + 1;
        }
      }
    }
    // 前向填補只該用來補「個別落檔慢的股票」。若最新一天有一大票個股都靠補，
    // 代表整個資料源當日尚未落檔——此時填補會讓族群指數在大漲日原地不動，
    // 做出與事實相反的相對強弱。寧可不出這一天。
    const nCodes = Object.keys(priceCache).length;
    const FILL_LIMIT = 0.2;
    for (let i = axis.length - 1; i >= 0; i--) {
      const d = axis[i];
      if ((filledOn[d] || 0) / nCodes <= FILL_LIMIT) break;
      console.log(`  dropped ${d}: ${filledOn[d]}/${nCodes} 檔靠前向填補，資料源當日尚未落檔`);
      delete benchPrices[d];
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
    basketSeries.push({
      canonical: b.canonical,
      short: b.short || b.canonical,
      prices: idx,
      n: members.length,
      // 成分股帶到前端：點族群時要列出個股並連到 Yahoo 股市，上市/上櫃網址不同所以帶 suffix。
      members: members.map(([c, l]: [string, string]) => [c, l, suffixOf[c] || '.TW']),
    });
  }

  // 全族群 + benchmark 的共同交易日
  let dates = Object.keys(benchPrices);
  for (const b of basketSeries) dates = dates.filter((d) => b.prices[d] != null);
  dates.sort();
  const bench = dates.map((d) => benchPrices[d]);
  console.log(`\nCommon trading days: ${dates.length} (${dates[0]} → ${dates[dates.length - 1]})`);
  // 共同起點由「上市最晚的那一檔」決定，全族群一起被截短。列出來，免得哪天歷史莫名變短查不到原因。
  {
    const start = dates[0];
    const latecomers = Object.entries(priceCache)
      .map(([c, p]) => [c, Object.keys(p).sort()[0]] as [string, string])
      .filter(([, f]) => f >= start)
      .sort((a, b) => b[1].localeCompare(a[1]));
    if (latecomers.length) {
      console.log(`  共同起點受限於：${latecomers.slice(0, 3).map(([c, f]) => `${c}(${f})`).join('、')}`);
    }
  }

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
    return { ticker: b.canonical, label: `${b.canonical} (${b.n})`, short: b.short, tf, members: b.members };
  });

  // 台股族群一定要排在最前面：前端預設取第一個 key，這是每日報告的主角。
  const universes: Record<string, unknown> = {
    tw_sectors: {
      name: '台股族群輪動',
      benchmark: cfg.benchmark.code,
      benchmark_name: cfg.benchmark.label,
      dates: dates.slice(-TAIL_POINTS),
      series,
    },
  };

  // 全球／美股三組：任何一組失敗就跳過該組，不影響台股族群與整份報告。
  const US_CLOSE_UTC_MIN = 21 * 60 + 30; // 16:00 ET + 緩衝（夏令 20:00 UTC、冬令 21:00 UTC）
  for (const def of GLOBAL_UNIVERSES) {
    try {
      const r = await buildGlobalUniverse(def, US_CLOSE_UTC_MIN);
      if (r) universes[r.key] = r.uni;
    } catch (e) {
      console.log(`  SKIP ${def.key}: ${(e as Error).message}`);
    }
  }

  const out = {
    generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    windows: WINDOWS,
    universes,
  };
  const outPath = path.join(ROOT, 'data', 'tw-rrg-data.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 0));
  console.log(`\nWrote ${outPath}: ${series.length} sectors + ${Object.keys(universes).length - 1} global universes, basket version ${cfg.version}`);

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
