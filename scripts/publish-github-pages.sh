#!/bin/bash
set -u

# Publish the daily report to GitHub Pages.
# Assembles data/site/ from the latest report, commits it together with the
# accumulated data history (HISTORY_PATHS below), and pushes to main;
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
# 法說會判讀子頁（scripts/fetch-investor-conferences.ts 在背景產出，跑到哪發佈到哪，沒跑完的下次補）
[ -f "$PROJECT_DIR/data/investor-conf.html" ] && cp "$PROJECT_DIR/data/investor-conf.html" "$SITE_DIR/investor-conf.html"
# 贏家分點子頁（scripts/fetch-broker-watch.ts 產出，每日更新）
[ -f "$PROJECT_DIR/data/broker-watch.html" ] && cp "$PROJECT_DIR/data/broker-watch.html" "$SITE_DIR/broker-watch.html"
# 私人子頁（交易檢討）：內容用 .env.local 的 SITE_PASSWORD 加密後才放進網站；
# 沒設密碼就只放說明頁。原始資料檔不進版控。
if ! node --import tsx "$SCRIPT_DIR/build-private-pages.ts" "$SITE_DIR"; then
  echo "[publish] build-private-pages failed — private pages skipped." >&2
  rm -f "$SITE_DIR/review.html"
fi
node --import tsx "$SCRIPT_DIR/sync-site-nav.ts" "$SITE_DIR"

# 累積型的歷史資料跟網站一起 commit，換一台機器 pull 下來就能接著跑、也能直接回測。
# 只放「重抓很慢或抓不回來」的：Google News 只能往回查約 30 天、FactSet 速報回補要一小時、
# 月營收 100 多個月；*-latest.json 與子頁 HTML 每次都會重產，不在這裡（網站副本在 data/site）。
HISTORY_PATHS=(
  data/target-price-history
  data/investor-conf-history
  data/revenue-history
  data/financials-history
  data/revenue-decline-history
  data/stock-picks-history
  data/tdcc-history
  data/cb-pledge-history
  data/broker-watch-history
  data/market-history.json
  data/margin-history.json
  data/sector-flows-history.json
)
COMMIT_PATHS=(data/site)
for p in "${HISTORY_PATHS[@]}"; do [ -e "$p" ] && COMMIT_PATHS+=("$p"); done

git add -- "${COMMIT_PATHS[@]}"

if git diff --cached --quiet -- "${COMMIT_PATHS[@]}"; then
  echo "[publish] data/site and history unchanged — nothing to publish."
  exit 0
fi

git commit -m "chore: publish daily report site $(date +%Y-%m-%d)" -- "${COMMIT_PATHS[@]}"
if ! git push origin main; then
  echo "[publish] git push failed — check network/auth." >&2
  exit 1
fi

echo "[publish] Pushed. GitHub Pages workflow will deploy: https://hchs200771.github.io/100-up-and-down-stocks/"
