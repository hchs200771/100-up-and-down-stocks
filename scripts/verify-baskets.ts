#!/usr/bin/env npx tsx
/**
 * 對帳 data/sector-baskets.json：把每個代號拿去 Yahoo 查回公司名，跟籃子裡寫的名字比對。
 *
 * 為什麼需要：代號打錯時，若那個代號剛好是另一檔【存在】的股票，build 不會報錯，
 * 那檔股票會靜靜地被算進錯誤的族群，整條 RRG 軌跡就是錯的而且看不出來。
 * 改完籃子一定要跑這支。
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

/** 去掉不影響辨識的雜訊字元後再比對（籃子寫「長科*」、交易所可能寫「長科」）。 */
const norm = (s: string) => s.replace(/[\s*＊]/g, '').replace(/-?KY$/i, '').toUpperCase();

/**
 * 代號 → 中文簡稱。用交易所自己的每日行情（跟 fetch-market-data.ts 同來源）。
 * 不要用 Yahoo 的 meta.longName —— 台股回的是英文公司名，跟中文簡稱比不了。
 */
async function loadNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const [twseRes, tpexRes] = await Promise.all([
    fetch('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json'),
    fetch('https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?response=json'),
  ]);
  // TWSE 這支已改回 CSV（即使帶 response=json 也一樣），欄位為 日期,證券代號,證券名稱,...
  const twseCsv = await twseRes.text();
  // 欄位可能帶引號、且數字欄位內含逗號，所以只用 regex 取前三欄，不要整行 split(',')。
  for (const line of twseCsv.split('\n').slice(1)) {
    const m = line.match(/^"?[^",]*"?,\s*"?(\d{4,6})"?,\s*"?([^",]+)"?/);
    if (m) names.set(m[1].trim(), m[2].trim());
  }
  const tpex: any = await tpexRes.json();
  for (const row of tpex?.tables?.[0]?.data ?? []) {
    if (row?.[0] && row?.[1]) names.set(String(row[0]).trim(), String(row[1]).trim());
  }
  return names;
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sector-baskets.json'), 'utf-8'));
  const bad: string[] = [];
  const missing: string[] = [];
  let ok = 0;

  const seen = new Map<string, string>(); // code -> canonical，抓同一檔被放進兩組
  for (const b of cfg.baskets) {
    for (const [code, label] of b.members) {
      if (seen.has(code)) bad.push(`重複：${label}(${code}) 同時在「${seen.get(code)}」與「${b.canonical}」`);
      else seen.set(code, b.canonical);
    }
  }

  const names = await loadNames();
  console.log(`交易所名冊：${names.size} 檔`);

  for (const [code, canonical] of seen) {
    const label = cfg.baskets.find((b: any) => b.canonical === canonical)
      .members.find((m: string[]) => m[0] === code)[1];
    const name = names.get(code);
    if (!name) { missing.push(`名冊查無：${label}(${code}) @ ${canonical}`); }
    else if (!norm(name).includes(norm(label)) && !norm(label).includes(norm(name))) {
      bad.push(`不符：${code} 籃子寫「${label}」但交易所是「${name}」 @ ${canonical}`);
    } else ok++;
  }

  console.log(`\n對帳完成：${ok} 檔相符 / 共 ${seen.size} 檔`);
  if (missing.length) { console.log('\n查無資料（會被 build 跳過）：'); missing.forEach((m) => console.log('  ' + m)); }
  if (bad.length) { console.log('\n【需要修正】'); bad.forEach((m) => console.log('  ' + m)); process.exitCode = 1; }
  else console.log('沒有名稱對不上的代號。');
})();
