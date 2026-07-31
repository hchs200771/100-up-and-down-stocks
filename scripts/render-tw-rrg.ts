#!/usr/bin/env npx tsx
/**
 * 把 data/tw-rrg-data.json 注入 rrg-radar 專案的 template.html，
 * 產出自包含的 data/tw-rrg.html。
 *
 * template 完全是資料驅動的（讀 DATA.universes[key].series[].tf[window]），
 * 所以台股族群只要產出相同結構的 JSON 就能直接沿用，圖表端零修改。
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const TEMPLATE = path.resolve(ROOT, '..', 'rrg-radar', 'template.html');

if (!fs.existsSync(TEMPLATE)) {
  console.error(`找不到 template：${TEMPLATE}\n請確認 rrg-radar 專案與本專案在同一層目錄。`);
  process.exit(1);
}

const tpl = fs.readFileSync(TEMPLATE, 'utf-8');
const data = JSON.stringify(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tw-rrg-data.json'), 'utf-8'))
).replace(/<\//g, '<\\/');

// template 把預設 universe 硬寫成 "assets"（rrg-radar 自己的分頁 key）。
// 我們只有 tw_sectors，鍵名對不上會導致 DATA.universes[state.uni] === undefined，
// 然後圖表與明細表【靜默】全空、console 也不報錯。改成取第一個 key 才安全。
const PATCH_FROM = 'const state = { uni: "assets"';
const PATCH_TO = 'const state = { uni: Object.keys(DATA.universes)[0]';
if (!tpl.includes(PATCH_FROM)) {
  console.error(`template 的預設 universe 寫法已改變，找不到：${PATCH_FROM}\n請重新確認 render 腳本的 patch 是否還有效（否則會產出空白圖）。`);
  process.exit(1);
}

const out = tpl
  .replace(PATCH_FROM, PATCH_TO)
  .replace('__DATA__', data)
  .replace('<title>資金輪動雷達 RRG</title>', '<title>台股族群輪動雷達 RRG</title>');

const outPath = path.join(ROOT, 'data', 'tw-rrg.html');
fs.writeFileSync(outPath, out, 'utf-8');
console.log(`Wrote ${outPath} (${(out.length / 1024).toFixed(0)} KB)`);
