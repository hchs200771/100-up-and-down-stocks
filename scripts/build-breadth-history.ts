/** Breadth uses back-adjusted closes; missing reference prices fall back to no adjustment that day. */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { exRightRefs, tpexExRightRefs, refPricesOn } from "./lib/twse-closes.ts";

type Prices = Record<string, number>;
export interface BreadthPoint { date: string; pctAboveMa60: number; pctAboveMa20: number; n: number }
const round = (v: number) => Math.round(v * 10) / 10;
const validClose = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Newest-to-oldest adjustment, using only raw previous closes to detect each event. */
export function backAdjustCloses(window: (Prices | null)[], refs: (Prices | null)[]): (Prices | null)[] {
  const factors: Prices = {};
  const adjusted = window.map(p => p === null ? null : { ...p });
  for (let i = window.length - 1; i >= 0; i--) {
    for (const [code, close] of Object.entries(window[i] ?? {})) {
      if (validClose(close)) adjusted[i]![code] = close * (factors[code] ?? 1);
    }
    if (i === 0) continue;
    for (const [code, ref] of Object.entries(refs[i] ?? {})) {
      const prev = window[i - 1]?.[code];
      if (!validClose(ref) || !validClose(prev)) continue;
      const f = ref / prev;
      if (Math.abs(f - 1) > 0.0005 && f > 0.3 && f < 1.7) factors[code] = (factors[code] ?? 1) * f;
    }
  }
  return adjusted;
}

// Windows include today's close, as in the adjusted research series. Never bridge an unreadable file.
export function computeBreadth(date: string, window: (Prices | null)[]): BreadthPoint | null {
  if (window.length !== 60 || window.some(p => p === null)) return null;
  const prices = window as Prices[];
  const measure = (days: number) => {
    const rows = prices.slice(-days);
    let n = 0, above = 0;
    for (const [code, close] of Object.entries(rows[rows.length - 1])) {
      if (!/^\d{4}$/.test(code) || !validClose(close) || !rows.every(p => validClose(p[code]))) continue;
      n++;
      if (close > rows.reduce((sum, p) => sum + p[code], 0) / days) above++;
    }
    return { n, pct: n ? round(above / n * 100) : null };
  };
  const m60 = measure(60), m20 = measure(20);
  if (m60.pct === null || m20.pct === null) return null;
  return { date, pctAboveMa60: m60.pct, pctAboveMa20: m20.pct, n: m60.n };
}

export async function buildBreadthHistory() {
  const out = resolve("data/breadth-history.json");
  let history: BreadthPoint[];
  try { history = JSON.parse(readFileSync(out, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; history = []; }
  const byDate = new Map(history.map(p => [p.date, p]));
  if (process.argv.includes("--seed")) {
    const series = JSON.parse(readFileSync("data/backtest/credit-breadth/series.json", "utf8"));
    // The compact series omits denominators; recover research-grade MA60 eligibility from results.
    const results = JSON.parse(readFileSync("data/backtest/credit-breadth/results.json", "utf8"));
    const counts = new Map<string, number>(results.breadth.daily.map((p: { date: string; eligibleMa60: number }) => [p.date, p.eligibleMa60]));
    for (const p of series) {
      const n = counts.get(p.date);
      if (validClose(n) && Number.isFinite(p.pctAboveMa60) && Number.isFinite(p.pctAboveMa20))
        byDate.set(p.date, { date: p.date, pctAboveMa60: round(p.pctAboveMa60), pctAboveMa20: round(p.pctAboveMa20), n });
    }
  } else {
    const files = readdirSync("data/price-history").filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    const last = [...byDate.keys()].sort().at(-1) ?? "";
    const rows = files.map(f => {
      try {
        const p = JSON.parse(readFileSync(resolve("data/price-history", f), "utf8"));
        if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("invalid price map");
        return p as Prices;
      } catch { console.warn(`[warn] unreadable price-history ${f}; affected windows will be skipped`); return null; }
    });
    const refs = new Map<string, Prices | null>();
    const noFetch = process.argv.includes("--no-fetch");
    // Date -> code -> official TWSE + TPEx reference, merged across runs and usable offline.
    // Keep the legacy filename so existing TWSE references remain available without migration.
    const exRightPath = resolve("data/price-ref/twse-exright.json");
    let exRights: Record<string, Prices> = {};
    try {
      const cached = JSON.parse(readFileSync(exRightPath, "utf8"));
      if (!cached || typeof cached !== "object" || Array.isArray(cached)) throw new Error("invalid ex-right reference map");
      exRights = cached;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(`[warn] twse-exright cache: ${(e as Error).message}`);
    }
    const firstPending = files.findIndex(f => f.slice(0, 10) > last);
    if (!noFetch && firstPending >= 0) {
      const firstWindow = files[Math.max(0, firstPending - 59)].slice(0, 10);
      const lastDate = files[files.length - 1].slice(0, 10);
      const startYmd = firstWindow.replace(/-/g, ""), endYmd = lastDate.replace(/-/g, "");
      const results = await Promise.allSettled([
        exRightRefs(startYmd, endYmd),
        tpexExRightRefs(startYmd, endYmd),
      ]);
      for (const [i, result] of results.entries()) {
        if (result.status === "fulfilled") {
          for (const { date, code, reference } of result.value) (exRights[date] ??= {})[code] = reference;
        } else {
          console.warn(`[warn] ${i === 0 ? "twse" : "tpex"}-exright: ${result.reason?.message ?? result.reason}; continuing with cached references`);
        }
      }
      if (results.some(result => result.status === "fulfilled")) try {
        mkdirSync(resolve("data/price-ref"), { recursive: true });
        writeFileSync(exRightPath, JSON.stringify(exRights));
      } catch (e) { console.warn(`[warn] exright cache: ${(e as Error).message}; continuing with in-memory references`); }
    }
    const refsFor = async (file: string): Promise<Prices | null> => {
      if (refs.has(file)) return refs.get(file)!;
      const path = resolve("data/price-ref", file);
      let prices: Prices | null = null;
      try {
        const p = JSON.parse(readFileSync(path, "utf8"));
        if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("invalid reference map");
        prices = p;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          console.warn(`[warn] unreadable price-ref ${file}: ${(e as Error).message}`);
        if (!noFetch) {
          try {
            const p = await refPricesOn(file.slice(0, 10).replace(/-/g, ""));
            if (!Object.keys(p).length) throw new Error("empty reference prices");
            mkdirSync(resolve("data/price-ref"), { recursive: true });
            writeFileSync(path, JSON.stringify(p));
            prices = p;
          } catch (err) { console.warn(`[warn] price-ref ${file}: ${(err as Error).message}`); }
        }
      }
      if (!prices) console.warn(`[warn] price-ref ${file}: unavailable; no adjustment for this day`);
      refs.set(file, prices);
      return prices;
    };
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const date = file.slice(0, 10);
      if (date <= last) continue;
      const start = Math.max(0, i - 59);
      const window = rows.slice(start, i + 1);
      const windowRefs: (Prices | null)[] = [];
      if (window.length === 60 && window.every(p => p !== null)) {
        // Sequential requests; overlapping windows reuse both successful and failed reads.
        for (const f of files.slice(start, i + 1)) {
          const daily = await refsFor(f);
          const official = exRights[f.slice(0, 10)];
          windowRefs.push(official ? { ...daily, ...official } : daily);
        }
      }
      const point = computeBreadth(date, backAdjustCloses(window, windowRefs));
      if (point) byDate.set(date, point);
      else console.warn(`[warn] breadth ${date}: need 60 consecutive valid price-history files and eligible stocks; skipped`);
    }
  }
  history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-300);
  const text = JSON.stringify(history, null, 2) + "\n";
  let previous = "";
  try { previous = readFileSync(out, "utf8"); } catch { /* new history */ }
  if (previous !== text) writeFileSync(out, text);
  console.log(`Breadth history: ${history.length} entries, through ${history.at(-1)?.date ?? "none"}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  buildBreadthHistory().catch(e => { console.error(e); process.exitCode = 1; });
