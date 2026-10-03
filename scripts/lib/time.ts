/**
 * 時間格式：一律用台北時間（UTC+8），不要用 UTC。
 *
 * 看報告的都是台灣人，網頁上寫 UTC 等於逼讀者自己 +8——而且「產生於 09/06 17:09 UTC」
 * 對一個台灣時間 09/07 凌晨 01:09 在看的人來說，日期還差了一天。
 *
 * 台灣沒有日光節約時間，所以固定 +08:00 永遠正確，不需要 tz 資料庫。
 *
 * ⚠️ 這裡的東西**只給「現在幾點」與顯示用**。腳本裡其他 `Date.UTC(...)` /
 * `getUTC*()` 是內部日期運算（ISO 週次、月份加減、跟市場收盤時刻比較），那些刻意用
 * UTC 當固定基準，不要一起改掉。
 */

const TW_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 台灣時間的「現在」，回傳一個把時鐘撥快 8 小時的 Date。
 * 只能搭配 `getUTC*()` 讀取（它的 UTC 欄位才是台北時間），不要用 `getHours()`。
 */
export const twNow = (d: Date = new Date()) => new Date(d.getTime() + TW_OFFSET_MS);

/** 台北日期 YYYY-MM-DD。跨午夜時用 `toISOString()` 會差一天，一律走這支。 */
export const twDate = (d: Date = new Date()) => twNow(d).toISOString().slice(0, 10);

/**
 * 存進 JSON 的時間戳：ISO 8601 帶 +08:00 偏移，例如 2026-09-07T01:16:52+08:00。
 * 仍然是合法 ISO、`new Date()` 解得動，但人直接讀就是台北時間。
 */
export const twIso = (d: Date = new Date()) => `${twNow(d).toISOString().slice(0, 19)}+08:00`;

/**
 * 顯示用：2026-09-07 01:16。
 * 吃得下帶 +08:00 的新格式，也吃得下舊資料裡結尾是 Z 的 UTC 時間戳（會換算成台北）。
 */
export function fmtTw(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  return twNow(d).toISOString().slice(0, 16).replace("T", " ");
}
