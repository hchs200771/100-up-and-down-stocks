/**
 * 單季毛利率與營業利益率。
 *
 * ## 兩個非做不可的處理
 *
 * **1. MOPS 的季報是累計數，不是單季。** season=2 是上半年合計、season=3 是前三季合計。
 * 直接拿來當單季用會把 Q1 的獲利重複算進 Q2。所以：
 *   Q1 單季 = 累計Q1
 *   Qn 單季 = 累計Qn − 累計Q(n-1)   (n = 2,3,4)
 *
 * **2. 財報有公布時滯，不能偷看未來。** 台灣的申報期限：
 *   Q1 → 5/15、Q2 → 8/14、Q3 → 11/14、Q4（年報）→ 次年 3/31
 * 回測在 5/11 進場時，Q1 還沒公布，只能用去年 Q4 的數字。少了這一層，回測會憑空
 * 多出好幾週的資訊優勢，結果整個作廢。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { FinSnapshot } from "../fetch-quarterly-financials";

export const FIN_DIR = "data/financials-history";

export function loadFinancials(root = process.cwd()): Map<string, FinSnapshot> {
  const dir = resolve(root, FIN_DIR);
  const out = new Map<string, FinSnapshot>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => /^\d{4}Q[1-4]\.json$/.test(f))) {
    const s: FinSnapshot = JSON.parse(readFileSync(resolve(dir, f), "utf-8"));
    out.set(s.quarter, s);
  }
  return out;
}

/** "2026Q2" → 前一季 "2026Q1" */
export function prevQuarter(q: string): string {
  const y = +q.slice(0, 4);
  const n = +q.slice(5);
  return n === 1 ? `${y - 1}Q4` : `${y}Q${n - 1}`;
}

/** 各季財報的申報期限（該季資料最晚在這天之前公布） */
export function deadlineOf(quarter: string): Date {
  const y = +quarter.slice(0, 4);
  const n = +quarter.slice(5);
  if (n === 1) return new Date(Date.UTC(y, 4, 15)); // 5/15
  if (n === 2) return new Date(Date.UTC(y, 7, 14)); // 8/14
  if (n === 3) return new Date(Date.UTC(y, 10, 14)); // 11/14
  return new Date(Date.UTC(y + 1, 2, 31)); // 年報 次年 3/31
}

/**
 * 在 asOf 這一天，「最新一季已經公布的財報」是哪一季。
 * 用申報期限判斷而不是「有沒有抓到資料」——後者會讓早報的公司提前被看見，
 * 在回測裡就是偷看未來。
 */
export function latestPublishedQuarter(asOf: Date, have: Map<string, FinSnapshot>): string | null {
  const cands = [...have.keys()].sort().reverse();
  for (const q of cands) if (deadlineOf(q).getTime() <= asOf.getTime()) return q;
  return null;
}

/** 目前手上有資料的最新一季（不管申報期限有沒有到）。 */
export function newestQuarter(fin: Map<string, FinSnapshot>): string | null {
  const ks = [...fin.keys()].sort();
  return ks.length ? ks[ks.length - 1] : null;
}

/**
 * 某檔「算得出毛利率的最新一季」。
 *
 * 跟 latestPublishedQuarter 的差別很重要：
 *   - **回測**要用 latestPublishedQuarter（申報期限），因為當時還沒公布的東西不能看；
 *   - **線上頁面**看的是「今天」，已經公布的就是已經公布了，沒有理由退回用舊的。
 * 台股是陸續申報的，期限前後那幾週有些公司報了、有些還沒，所以是逐檔往回找：
 * 先試最新一季，沒有就退一季。回傳 null 代表兩季都算不出來（金融業、新上市）。
 */
export function latestMarginQuarter(
  code: string,
  fin: Map<string, FinSnapshot>,
  newest: string,
): string | null {
  for (const q of [newest, prevQuarter(newest)]) {
    if (marginOf(code, q, fin) !== null) return q;
  }
  return null;
}

/**
 * 某檔在某一季的單季數字（營收、成本、營業利益），已從累計還原成單季。
 * 拿不到（缺季、營收為零、金融業不在表裡）就回 null。
 */
function singleQuarter(code: string, quarter: string, fin: Map<string, FinSnapshot>): { rev: number; cost: number; op: number | null } | null {
  const cur = fin.get(quarter)?.stocks[code];
  if (!cur) return null;
  const n = +quarter.slice(5);
  let rev = cur.rev;
  let cost = cur.cost;
  let op = cur.op ?? null;
  if (n > 1) {
    const prev = fin.get(prevQuarter(quarter))?.stocks[code];
    if (!prev) return null;
    rev = cur.rev - prev.rev;
    cost = cur.cost - prev.cost;
    op = op !== null && prev.op !== null && prev.op !== undefined ? op - prev.op : null;
  }
  // 單季營收太小（或相減後為負，代表更正過帳）就不給數字，別硬算出離譜的比率
  if (!(rev > 10_000)) return null;
  return { rev, cost, op };
}

const sane = (m: number) => (m > -2 && m < 1 ? m : null);

/** 某檔在某一季的單季毛利率。 */
export function marginOf(code: string, quarter: string, fin: Map<string, FinSnapshot>): number | null {
  const q = singleQuarter(code, quarter, fin);
  return q ? sane((q.rev - q.cost) / q.rev) : null;
}

/**
 * 某檔在某一季的單季營業利益率＝營業利益÷營收。
 * 跟毛利率差在多扣了營業費用——毛利率看議價權，這個多看費用紀律。
 * 舊快照沒有 op 欄位時回 null。
 */
export function opMarginOf(code: string, quarter: string, fin: Map<string, FinSnapshot>): number | null {
  const q = singleQuarter(code, quarter, fin);
  return q && q.op !== null ? sane(q.op / q.rev) : null;
}

/** 連續往回取 n 季的毛利率（含 quarter 自己），由新到舊；缺的用 null 佔位 */
export function marginSeries(code: string, quarter: string, n: number, fin: Map<string, FinSnapshot>): (number | null)[] {
  const out: (number | null)[] = [];
  let q = quarter;
  for (let i = 0; i < n; i++) {
    out.push(marginOf(code, q, fin));
    q = prevQuarter(q);
  }
  return out;
}
