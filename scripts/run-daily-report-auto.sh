#!/bin/bash
# 每日報告的統一進入點（launchd 與 npm run report 都走這裡）。
# 有裝 codex 就用 codex 流程，沒有就退回 Claude 流程，讓換機器 / 沒登入 OpenAI 時排程照樣跑得完。
set -u

# launchd 給的 PATH 很精簡，這裡補回 node / claude / codex 的常見安裝位置。
# 不寫死家目錄與 node 版本：換一台機器後路徑就不存在，整條流程會在第一步找不到 node。
_nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${_nvm_bin:+$_nvm_bin:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# DAILY_REPORT_ENGINE=codex|claude 可強制指定，預設 auto。
ENGINE="${DAILY_REPORT_ENGINE:-auto}"
if [ "$ENGINE" = "auto" ]; then
  if command -v codex >/dev/null 2>&1; then ENGINE="codex"; else ENGINE="claude"; fi
fi

case "$ENGINE" in
  codex)  RUNNER="$SCRIPT_DIR/run-daily-report-codex-parallel.sh" ;;
  claude) RUNNER="$SCRIPT_DIR/run-daily-report-claude.sh" ;;
  *) echo "unknown DAILY_REPORT_ENGINE=$ENGINE (expect codex|claude|auto)" >&2; exit 1 ;;
esac

echo "[$(date '+%Y-%m-%d %H:%M:%S')] engine=$ENGINE runner=$(basename "$RUNNER")"
exec bash "$RUNNER" "$@"
