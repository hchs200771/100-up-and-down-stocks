#!/bin/bash
set -u

# Publish the daily report to GitHub Pages.
# Assembles data/site/ from the latest report, commits it together with the
# accumulated data history (HISTORY_PATHS below), and pushes to main;
# the "Deploy report to GitHub Pages" workflow then publishes it.
# Skips gracefully (exit 0) when there is nothing new to publish.

_nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="${_nvm_bin:+$_nvm_bin:}$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

# 主流程與背景工作共用鎖；mkdir 在 macOS 也能原子取得。
LOCK_DIR="$PROJECT_DIR/data/tmp/publish.lock"
mkdir -p "$(dirname "$LOCK_DIR")"
lock_started=$SECONDS
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if { [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; } \
    || { [ -z "$owner" ] && [ -n "$(find "$LOCK_DIR" -prune -mmin +0 2>/dev/null)" ]; }; then
    # 同時發現失效鎖時，只讓一個等待者清理，並再次確認持有者。
    if mkdir "$LOCK_DIR/reap" 2>/dev/null; then
      current="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
      if [ "$current" = "$owner" ] && { [ -z "$current" ] || ! kill -0 "$current" 2>/dev/null; }; then
        rm -f "$LOCK_DIR/pid"
        if rmdir "$LOCK_DIR/reap" "$LOCK_DIR" 2>/dev/null; then
          echo "[publish] 已清理失效鎖（pid ${owner:-未寫入}）"
          continue
        fi
      fi
      rmdir "$LOCK_DIR/reap" 2>/dev/null || true
    fi
  fi
  if [ $((SECONDS - lock_started)) -ge 120 ]; then
    echo "[publish] 等待發布鎖超過 120 秒（pid ${owner:-尚未寫入}），停止本次發布。" >&2
    exit 1
  fi
  sleep 1
done
release_lock() {
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$$" > "$LOCK_DIR/pid"

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
[ -f "$PROJECT_DIR/data/theme-radar.html" ] && cp "$PROJECT_DIR/data/theme-radar.html" "$SITE_DIR/themes.html"
# 法人目標價子頁（scripts/fetch-target-prices.ts 產出，每日更新）
[ -f "$PROJECT_DIR/data/target-price.html" ] && cp "$PROJECT_DIR/data/target-price.html" "$SITE_DIR/target-price.html"
# 法說會判讀子頁（scripts/fetch-investor-conferences.ts 在背景產出，跑到哪發佈到哪，沒跑完的下次補）
[ -f "$PROJECT_DIR/data/investor-conf.html" ] && cp "$PROJECT_DIR/data/investor-conf.html" "$SITE_DIR/investor-conf.html"
[ -f "$PROJECT_DIR/data/strong-tracking.html" ] && cp "$PROJECT_DIR/data/strong-tracking.html" "$SITE_DIR/strong-tracking.html"
# 舊掃描網址保留重新導向（scripts/build-strong-tracking.ts 產出）
[ -f "$PROJECT_DIR/data/pullback-scan.html" ] && cp "$PROJECT_DIR/data/pullback-scan.html" "$SITE_DIR/pullback-scan.html"

[ -f "$PROJECT_DIR/data/new-high-scan.html" ] && cp "$PROJECT_DIR/data/new-high-scan.html" "$SITE_DIR/new-high-scan.html"
# 選股池前 5 檔深挖子頁（scripts/start-pick-deepdive.sh 背景產出，跑到哪發佈到哪）
[ -f "$PROJECT_DIR/data/pick-deepdive.html" ] && cp "$PROJECT_DIR/data/pick-deepdive.html" "$SITE_DIR/pick-deepdive.html"
# 背景語音完成後更新播放器來源與 Podcast 訂閱（音訊放 GitHub Release）。
[ -f "$PROJECT_DIR/data/audio-latest.json" ] && cp "$PROJECT_DIR/data/audio-latest.json" "$SITE_DIR/audio-latest.json"
[ -f "$PROJECT_DIR/data/audio-status.json" ] && cp "$PROJECT_DIR/data/audio-status.json" "$SITE_DIR/audio-status.json"
[ -f "$PROJECT_DIR/data/podcast.xml" ] && cp "$PROJECT_DIR/data/podcast.xml" "$SITE_DIR/podcast.xml"
# 贏家分點子頁（scripts/fetch-broker-watch.ts 產出，每日更新）
[ -f "$PROJECT_DIR/data/broker-watch.html" ] && cp "$PROJECT_DIR/data/broker-watch.html" "$SITE_DIR/broker-watch.html"
# 因子驗證子頁：scripts/build-factor-lab.ts 從 research/factor-lab/ 重產，不是每日更新
node --import tsx "$SCRIPT_DIR/build-factor-lab.ts" "$SITE_DIR/factor-lab.html" || echo "[publish] build-factor-lab failed — factor-lab.html skipped." >&2
# 私人子頁（交易檢討）：內容用 .env.local 的 SITE_PASSWORD 加密後才放進網站；
# 沒設密碼就只放說明頁。原始資料檔不進版控。
if ! node --import tsx "$SCRIPT_DIR/build-private-pages.ts" "$SITE_DIR"; then
  echo "[publish] build-private-pages failed — private pages skipped." >&2
  rm -f "$SITE_DIR/review.html"
fi
# 換到資料不全的機器（沒有 SITE_PASSWORD、少了某些子頁的產生器）時，不讓上一版網站的頁面消失：
# 沒密碼就沿用上一版已加密的 review.html；這次沒產出的子頁一律從 HEAD 還原。
if [ -z "${SITE_PASSWORD:-}" ] && ! grep -qsE '^SITE_PASSWORD=.+' "$PROJECT_DIR/.env.local" \
  && git cat-file -e HEAD:data/site/review.html 2>/dev/null; then
  git show HEAD:data/site/review.html > "$SITE_DIR/review.html"
  echo "[publish] 沒有 SITE_PASSWORD — 沿用上一版加密的 review.html"
fi
while IFS= read -r f; do
  # 已下架頁面不可從 HEAD 補回；site 每次重建時也會移除舊副本。
  case "$f" in data/site/revenue-picks.html|data/site/revenue-industry.html) continue ;; esac
  [ -e "$f" ] && continue
  mkdir -p "$(dirname "$f")"
  git show "HEAD:$f" > "$f" && echo "[publish] 這次沒產出 $f — 沿用上一版"
done < <(git ls-tree -r --name-only HEAD -- data/site)
node --import tsx "$SCRIPT_DIR/sync-site-nav.ts" "$SITE_DIR"

# 累積型的歷史資料跟網站一起 commit，換一台機器 pull 下來就能接著跑、也能直接回測。
# 只放「重抓很慢或抓不回來」的：Google News 只能往回查約 30 天、FactSet 速報回補要一小時、
# 月營收 100 多個月；*-latest.json 與子頁 HTML 每次都會重產，不在這裡（網站副本在 data/site）。
HISTORY_PATHS=(
  data/tx-intraday-history
  data/target-price-history
  data/investor-conf-history
  data/investor-conf-overview
  data/revenue-history
  data/financials-history
  data/revenue-decline-history
  data/stock-picks-history
  data/tdcc-history
  data/cb-pledge-history
  data/broker-watch-history
  data/pullback-scan-history
  data/pullback-scan-positions.json
  data/new-high-scan-history
  data/pick-deepdive-history
  data/new-high-scan-positions.json
  data/market-history.json
  data/margin-history.json
  data/sector-flows-history.json
)
# research/factor-lab 是手寫的追蹤內容（不是重產的資料），改了也要跟網站一起 commit。
COMMIT_PATHS=(data/site research/factor-lab)
for p in "${HISTORY_PATHS[@]}"; do [ -e "$p" ] && COMMIT_PATHS+=("$p"); done

git add -- "${COMMIT_PATHS[@]}"

if git diff --cached --quiet -- "${COMMIT_PATHS[@]}"; then
  echo "[publish] data/site and history unchanged — nothing to publish."
  exit 0
fi

git commit -m "chore: publish daily report site $(date +%Y-%m-%d)" -- "${COMMIT_PATHS[@]}"
if ! git push origin main; then
  echo "[publish] git push failed — check network/auth." >&2
  echo "[publish] 嘗試 pull --rebase --autostash 後重推一次。" >&2
  if ! git pull --rebase --autostash -X theirs origin main; then
    echo "[publish] pull/rebase 失敗，取消 rebase，保留本機提交。" >&2
    git rebase --abort || true
    exit 1
  fi
  if ! git push origin main; then
    echo "[publish] git push failed — check network/auth." >&2
    exit 1
  fi
fi

echo "[publish] Pushed. GitHub Pages workflow will deploy: https://hchs200771.github.io/100-up-and-down-stocks/"
