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
if ! npx tsx "$SCRIPT_DIR/build-site-html.ts" "$HTML" "$SITE_DIR/index.html"; then
  echo "[publish] build-site-html failed — falling back to plain copy." >&2
  cp "$HTML" "$SITE_DIR/index.html"
fi
[ -f "$PROJECT_DIR/data/analysis-latest.json" ] && cp "$PROJECT_DIR/data/analysis-latest.json" "$SITE_DIR/analysis-latest.json"
[ -f "$PROJECT_DIR/data/scorecard.json" ] && cp "$PROJECT_DIR/data/scorecard.json" "$SITE_DIR/scorecard.json"
# 族群輪動 RRG 已由 build-site-html.ts 直接內嵌進 index.html 的「🔄 族群輪動」分頁，
# 不再發佈獨立的 rrg.html 子頁（data/tw-rrg.html 只留給本地預覽）。
[ -f "$PROJECT_DIR/data/tw-rrg-alerts.json" ] && cp "$PROJECT_DIR/data/tw-rrg-alerts.json" "$SITE_DIR/tw-rrg-alerts.json"

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
