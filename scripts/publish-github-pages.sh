#!/bin/bash
set -u

# Publish the daily report to GitHub Pages.
# Assembles data/site/ from the latest report, commits it, and pushes to main;
# the "Deploy report to GitHub Pages" workflow then publishes it.
# Skips gracefully (exit 0) when there is nothing new to publish.

export PATH="/Users/huangguanxue/.nvm/versions/node/v20.20.2/bin:/Users/huangguanxue/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

SITE_DIR="$PROJECT_DIR/data/site"
HTML="$PROJECT_DIR/data/report-latest.html"

if [ ! -f "$HTML" ]; then
  echo "[publish] $HTML not found — nothing to deploy." >&2
  exit 1
fi

# Assemble the static site directory
rm -rf "$SITE_DIR"
mkdir -p "$SITE_DIR"
# Wrap the shared report fragment into a full HTML document with favicon + SEO
# metadata (email body stays untouched). Fall back to a plain copy if it fails.
if ! node --import tsx "$SCRIPT_DIR/build-site-html.ts" "$HTML" "$SITE_DIR/index.html"; then
  echo "[publish] build-site-html failed — falling back to plain copy." >&2
  cp "$HTML" "$SITE_DIR/index.html"
fi
[ -f "$PROJECT_DIR/data/analysis-latest.json" ] && cp "$PROJECT_DIR/data/analysis-latest.json" "$SITE_DIR/analysis-latest.json"
[ -f "$PROJECT_DIR/data/scorecard.json" ] && cp "$PROJECT_DIR/data/scorecard.json" "$SITE_DIR/scorecard.json"
# 族群輪動 RRG 已由 build-site-html.ts 直接內嵌進 index.html 的「🔄 族群輪動」分頁，
# 不再發佈獨立的 rrg.html 子頁（data/tw-rrg.html 只留給本地預覽）。
[ -f "$PROJECT_DIR/data/tw-rrg-alerts.json" ] && cp "$PROJECT_DIR/data/tw-rrg-alerts.json" "$SITE_DIR/tw-rrg-alerts.json"
# 董監設質+CB 事件池子頁（scripts/screen-cb-pledge.ts 產出；CB 日更、設質月更）
[ -f "$PROJECT_DIR/data/cb-pledge.html" ] && cp "$PROJECT_DIR/data/cb-pledge.html" "$SITE_DIR/cb-pledge.html"
# 月營收動能名單子頁（scripts/build-revenue-momentum.ts 產出，每日更新——
# 每月 1~10 號公司陸續公布，名單會天天長大）
[ -f "$PROJECT_DIR/data/revenue.html" ] && cp "$PROJECT_DIR/data/revenue.html" "$SITE_DIR/revenue.html"
# 月營收衰退名單子頁（scripts/build-revenue-decline.ts 產出；避開／放空候選，附個股期貨）
[ -f "$PROJECT_DIR/data/revenue-decline.html" ] && cp "$PROJECT_DIR/data/revenue-decline.html" "$SITE_DIR/revenue-decline.html"
# 營收產業族群子頁（scripts/build-revenue-industry.ts 產出；強弱勢是否集中在特定產業）
[ -f "$PROJECT_DIR/data/revenue-industry.html" ] && cp "$PROJECT_DIR/data/revenue-industry.html" "$SITE_DIR/revenue-industry.html"
[ -f "$PROJECT_DIR/data/theme-radar.html" ] && cp "$PROJECT_DIR/data/theme-radar.html" "$SITE_DIR/themes.html"
# 法人目標價子頁（scripts/fetch-target-prices.ts 產出，每日更新）
[ -f "$PROJECT_DIR/data/target-price.html" ] && cp "$PROJECT_DIR/data/target-price.html" "$SITE_DIR/target-price.html"
# 贏家分點子頁（scripts/fetch-broker-watch.ts 產出，每日更新）
[ -f "$PROJECT_DIR/data/broker-watch.html" ] && cp "$PROJECT_DIR/data/broker-watch.html" "$SITE_DIR/broker-watch.html"
node --import tsx "$SCRIPT_DIR/sync-site-nav.ts" "$SITE_DIR"

git add data/site

if git diff --cached --quiet -- data/site; then
  echo "[publish] data/site unchanged — nothing to publish."
  exit 0
fi

git commit -m "chore: publish daily report site $(date +%Y-%m-%d)" -- data/site
if ! git push origin main; then
  echo "[publish] git push failed — check network/auth." >&2
  exit 1
fi

echo "[publish] Pushed. GitHub Pages workflow will deploy: https://hchs200771.github.io/100-up-and-down-stocks/"
