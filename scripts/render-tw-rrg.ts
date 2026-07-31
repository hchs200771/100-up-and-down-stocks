#!/usr/bin/env npx tsx
/**
 * 把 data/tw-rrg-data.json 注入 templates/rrg-tw.html，產出自包含的 data/tw-rrg.html。
 *
 * template 是從隔壁 rrg-radar 專案 fork 過來的（原始檔完全資料驅動）。
 * fork 而非直接沿用的原因：這裡加了台股專屬的功能——成分股面板、Yahoo 股市連結、
 * 勾選框與全選／全不選——靠字串 patch 別人的檔案已經撐不住了。
 * 上游若有值得同步的改動，用 diff 手動挑進來。
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const TEMPLATE = path.resolve(ROOT, 'templates', 'rrg-tw.html');

if (!fs.existsSync(TEMPLATE)) {
  console.error(`找不到 template：${TEMPLATE}`);
  process.exit(1);
}

const tpl = fs.readFileSync(TEMPLATE, 'utf-8');
const raw = fs.readFileSync(path.join(ROOT, 'data', 'tw-rrg-data.json'), 'utf-8');
const parsed = JSON.parse(raw);
const data = JSON.stringify(parsed).replace(/<\//g, '<\\/');

if (!tpl.includes('__DATA__')) {
  console.error('template 少了 __DATA__ 佔位符，無法注入資料。');
  process.exit(1);
}

const out = tpl
  .replace('__DATA__', data)
  .replace('<title>資金輪動雷達 RRG</title>', '<title>台股・全球資金輪動雷達 RRG</title>');

const outPath = path.join(ROOT, 'data', 'tw-rrg.html');
fs.writeFileSync(outPath, out, 'utf-8');
const unis = Object.entries(parsed.universes as Record<string, any>)
  .map(([k, u]) => `${k}(${u.series.length})`)
  .join(' ');
console.log(`Wrote ${outPath} (${(out.length / 1024).toFixed(0)} KB) — universes: ${unis}`);
