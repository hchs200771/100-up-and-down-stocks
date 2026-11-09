#!/bin/bash
# 發佈階段後啟動；完全脫離主流程，不加入 AUX_PIDS、不等待。鎖由 TS 工作持有。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/audio-brief-$(date +%Y-%m-%d_%H%M%S).log"
export AUDIO_LOG="$LOG"
cd "$PROJECT_DIR" || exit 1
if command -v setsid >/dev/null 2>&1; then
  setsid nohup node --import tsx scripts/build-audio-brief.ts "$@" > "$LOG" 2>&1 < /dev/null &
else
  nohup node --import tsx scripts/build-audio-brief.ts "$@" > "$LOG" 2>&1 < /dev/null &
fi
echo "盤後語音版已在背景啟動（pid $!），log: $LOG"
