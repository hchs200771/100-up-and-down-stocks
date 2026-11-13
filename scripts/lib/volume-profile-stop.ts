/** 價量分布停損；所有計算只使用 asOf（含）以前的有效 OHLCV，無 I/O。 */
import { roundToTick } from "../holdings-tech-check.ts";

export type Ohlcv = { date: string; open: number; max: number; min: number; close: number; Trading_Volume: number };
export type Bin = { low: number; high: number; volume: number };
export type Peak = { low: number; high: number; peakLow: number; peakHigh: number; volume: number };
export type StopCandidate = { kind: "量峰下緣" | "量峰上緣" | "未回補跳空" | "波段低點" | "波段高點" | "較小量峰"; date?: string; level: number; stop: number; distancePct: number };

export function twoYearsBefore(asOf: string): string {
  const date = new Date(`${asOf}T00:00:00Z`);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - 2);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

export function validOhlcv(rows: Ohlcv[], asOf: string): Ohlcv[] {
  const start = twoYearsBefore(asOf);
  return rows.filter((r) => r.date >= start && r.date <= asOf && [r.max, r.min, r.close, r.Trading_Volume].every(Number.isFinite)
    && r.max > 0 && r.min > 0 && r.max >= r.min && r.close > 0 && r.Trading_Volume >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function volumeProfileStop(input: { rows: Ohlcv[]; asOf: string; reference: number; direction: "多" | "空"; code?: string }) {
  const { asOf, reference: entry, direction, code = "" } = input;
  if (!Number.isFinite(entry) || entry <= 0) throw new Error("參考價須為正數");
  const rows = validOhlcv(input.rows, asOf);
  if (!rows.length) return null;
  const side = direction === "多" ? 1 : -1;
  const binWidth = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50].find((b) => b >= entry * 0.015);
  if (binWidth === undefined) throw new Error("參考價超出分箱寬度表範圍");
  const index = (price: number) => Math.floor(Number((price / binWidth).toFixed(10)));
  const entryBin = index(entry);
  const first = Math.min(entryBin, ...rows.map((r) => index(r.min)));
  const last = Math.max(entryBin, ...rows.map((r) => index(r.max)));
  const bins: Bin[] = Array.from({ length: last - first + 1 }, (_, i) => ({ low: Number(((first + i) * binWidth).toFixed(8)), high: Number(((first + i + 1) * binWidth).toFixed(8)), volume: 0 }));
  for (const row of rows) {
    const volume = row.Trading_Volume / 1000;
    if (row.max === row.min) bins[index(row.min) - first].volume += volume;
    else for (let k = index(row.min); k <= index(row.max); k++) {
      const bin = bins[k - first];
      bin.volume += volume * Math.max(0, Math.min(row.max, bin.high) - Math.max(row.min, bin.low)) / (row.max - row.min);
    }
  }
  const volume = (k: number) => bins[k - first]?.volume ?? 0;
  const localPeak = (k: number) => volume(k) > 0 && [-2, -1, 1, 2].every((offset) => volume(k) >= volume(k + offset));
  // 半開箱 [low, high)；量峰群只沿搜尋方向延伸，邊界外視為零量。
  const peakAt = (k: number, step: number): Peak => {
    let edge = k;
    while (edge + step >= first && edge + step <= last && volume(edge + step) >= volume(k) * 0.5) edge += step;
    return { low: bins[Math.min(k, edge) - first].low, high: bins[Math.max(k, edge) - first].high,
      peakLow: bins[k - first].low, peakHigh: bins[k - first].high, volume: volume(k) };
  };
  const scan = (step: number, requireValley: boolean) => {
    const peaks: Peak[] = [];
    let valley = volume(entryBin);
    for (let k = entryBin + step; k >= first && k <= last; k += step) {
      valley = Math.min(valley, volume(k));
      if (localPeak(k) && (!requireValley || volume(k) >= 1.5 * valley)) peaks.push(peakAt(k, step));
    }
    return peaks;
  };
  const peaks = scan(-side, true), target = scan(side, true)[0] ?? null;
  const structuralPeak = peaks[0] ?? null;
  const distance = (stop: number) => (entry - stop) * side / entry * 100;
  const candidate = (kind: StopCandidate["kind"], level: number, date?: string): StopCandidate => {
    const stop = roundToTick(level * (1 - side * 0.0075), code);
    return { kind, level, stop, distancePct: distance(stop), ...(date ? { date } : {}) };
  };
  const structural = structuralPeak ? candidate(side === 1 ? "量峰下緣" : "量峰上緣", side === 1 ? structuralPeak.low : structuralPeak.high) : null;
  const candidates: StopCandidate[] = [];
  let selected = structural && structural.distancePct > 0 && structural.distancePct <= 10 ? structural : null;
  if (!selected) {
    const add = (c: StopCandidate) => {
      if ((entry - c.level) * side > 0 && Math.abs(entry - c.level) / entry <= 0.1 && c.distancePct > 0 && c.distancePct <= 10) candidates.push(c);
    };
    for (let i = Math.max(1, rows.length - 60); i < rows.length; i++) {
      const row = rows[i], prev = rows[i - 1];
      const origin = side === 1 ? prev.max : prev.min;
      const gap = side === 1 ? row.min > origin : row.max < origin;
      if (gap && rows.slice(i).every((r) => side === 1 ? r.min > origin : r.max < origin)) add(candidate("未回補跳空", origin, row.date));
      if (i >= 3 && i + 3 < rows.length) {
        const level = side === 1 ? row.min : row.max;
        if (rows.slice(i - 3, i + 4).every((r) => side === 1 ? r.min >= level : r.max <= level)) add(candidate(side === 1 ? "波段低點" : "波段高點", level, row.date));
      }
    }
    for (const peak of scan(-side, false)) {
      const level = side === 1 ? peak.low : peak.high;
      if (!structural || (level - structural.stop) * side > 0) add(candidate("較小量峰", level));
    }
    selected = candidates.sort((a, b) => side * (a.level - b.level))[0] ?? null;
  }
  const stop = selected?.stop ?? roundToTick(entry * (1 - side * 0.1), code);
  const tr = rows.slice(1).map((r, i) => Math.max(r.max, rows[i].close) - Math.min(r.min, rows[i].close));
  const atr14 = tr.length >= 14 ? tr.slice(-14).reduce((a, b) => a + b, 0) / 14 : null;
  const risk = (entry - stop) * side;
  const tooTight = atr14 !== null && risk < 0.8 * atr14;
  const targetPrice = target ? (side === 1 ? target.low : target.high) : null;
  const reason = selected ? `${selected.kind} ${selected.level}，${side === 1 ? "下" : "上"}方留 0.75% 緩衝` : "結構支撐太遠，建議減碼或不進場";
  return { asOf, direction, reference: entry, historyDays: rows.length, binWidth, atr14, bins,
    peaks, valleys: bins.filter((bin, i) => i > 0 && i < bins.length - 1 && bin.volume < bins[i - 1].volume && bin.volume <= bins[i + 1].volume),
    structuralPeak, structuralStop: structural?.stop ?? null, structuralDistancePct: structural?.distancePct ?? null,
    candidates, selected, stop, reason, distancePct: distance(stop), atrMultiple: atr14 && atr14 > 0 ? risk / atr14 : null,
    tooFar: selected === null, tooTight, target, targetPrice, rewardRiskRatio: targetPrice !== null && risk > 0 ? (targetPrice - entry) * side / risk : null,
    explanation: `${direction === "多" ? "收盤價跌破" : "收盤價站上"}停損價為準${tooTight ? "；停損小於 0.8 倍 ATR，容易被洗" : ""}` };
}
