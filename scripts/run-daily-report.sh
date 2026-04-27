#!/bin/bash
# Wrapper for launchd: waits for network, runs the daily-stock-report skill,
# notifies via macOS notification on failure.
set -u

export PATH="/Users/max/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
PROJECT_DIR="/Users/max/Projects/100-up-and-down-stocks"
cd "$PROJECT_DIR" || exit 1

LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d_%H%M%S).log"

notify() {
  local title="$1"
  local msg="$2"
  osascript -e "display notification \"${msg//\"/\\\"}\" with title \"${title//\"/\\\"}\" sound name \"Basso\"" 2>/dev/null
}

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "run-daily-report.sh start"

# Wait for network: retry up to 15 times, 60s apart (≈15 min total)
MAX_ATTEMPTS=15
attempt=0
while ! curl -s --max-time 5 -o /dev/null https://www.twse.com.tw; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    log "No network after $MAX_ATTEMPTS attempts, giving up"
    notify "每日股市報告 ❌" "等了 15 分鐘還是沒網路，已放棄。Log: $LOG_FILE"
    exit 1
  fi
  log "No network (attempt $attempt/$MAX_ATTEMPTS), sleeping 60s"
  sleep 60
done
log "Network OK (after $attempt retries)"

# Run the skill via Claude Code in non-interactive mode
if ! claude -p "/daily-stock-report" >> "$LOG_FILE" 2>&1; then
  log "claude exited non-zero"
  notify "每日股市報告 ❌" "執行失敗，請看 log: $LOG_FILE"
  exit 1
fi

log "Done"
notify "每日股市報告 ✅" "已完成並寄信"
