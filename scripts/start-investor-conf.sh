#!/bin/bash
# 法說會判讀（scripts/fetch-investor-conferences.ts）的背景啟動器，兩個每日報告 runner 共用。
#
# 簡報下載很慢（MOPS 每份 2~8 分鐘）、影音轉文字有 Groq 額度，整批可能跑上一小時，
# 但每日報告要在 20 分鐘內完成，所以這裡用 setsid 完全脫離主流程：不進 AUX_PIDS、不等它。
# 腳本每判讀完一場就重寫 data/investor-conf.html，發佈當下跑到哪就發佈到哪；
# 沒跑完的會留在最近 7 天的視窗裡，下次執行接著補。上一次還在跑時，腳本自己會略過（run.pid 鎖）。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/investor-conf-$(date +%Y-%m-%d_%H%M%S).log"

cd "$PROJECT_DIR" || exit 1
# macOS 沒有 setsid：退回 nohup，launcher 結束後子程序由 launchd 收養，一樣不會被主流程等待或帶走。
if command -v setsid >/dev/null 2>&1; then
  setsid nohup node --import tsx scripts/fetch-investor-conferences.ts "$@" > "$LOG" 2>&1 < /dev/null &
else
  nohup node --import tsx scripts/fetch-investor-conferences.ts "$@" > "$LOG" 2>&1 < /dev/null &
fi
echo "法說會判讀已在背景啟動（pid $!），log: $LOG"
