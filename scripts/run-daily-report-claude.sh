#!/bin/bash
set -u

export PATH="/Users/max/.nvm/versions/node/v20.12.0/bin:/Users/max/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTROLLER_PROMPT="$PROJECT_DIR/scripts/prompts/group-task-controller.md"
FINALIZER_PROMPT="$PROJECT_DIR/scripts/prompts/group-finalizer.md"
INTL_PROMPT="$PROJECT_DIR/scripts/prompts/intl-brief-worker.md"
INTL_MODEL="${CLAUDE_INTL_MODEL:-sonnet}"
WORKER_RUNNER="$PROJECT_DIR/scripts/run-claude-group-workers.sh"
TMP_DIR="$PROJECT_DIR/data/tmp"
TASK_DIR="$TMP_DIR/group-tasks"
TASK_SNAPSHOT_DIR="$TMP_DIR/group-tasks-backup"
RESULT_DIR="$TMP_DIR/group-results"
START_STAGE="${CLAUDE_REPORT_START_STAGE:-fetch}"
REFINE_GROUP_TASKS="${CLAUDE_REPORT_REFINE_GROUP_TASKS:-1}"
CONTROLLER_MODEL="${CLAUDE_CONTROLLER_MODEL:-sonnet}"
CONTROLLER_SPLIT="${CLAUDE_CONTROLLER_SPLIT:-1}"
CONTROLLER_TIMEOUT_SECONDS="${CLAUDE_REPORT_CONTROLLER_TIMEOUT_SECONDS:-900}"
cd "$PROJECT_DIR" || exit 1

LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d_%H%M%S)-claude-parallel.log"

notify() {
  local title="$1"
  local msg="$2"
  osascript -e "display notification \"${msg//\"/\\\"}\" with title \"${title//\"/\\\"}\" sound name \"Basso\"" 2>/dev/null
}

log() {
  local line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$line" | tee -a "$LOG_FILE"
}

market_trading_date() {
  node -e 'const fs = require("fs"); const p = "data/market-latest.json"; if (!fs.existsSync(p)) process.exit(0); const data = JSON.parse(fs.readFileSync(p, "utf8")); process.stdout.write(data.tradingDate || data.timestamp || "unknown");' 2>/dev/null
}

run_tsx() {
  node --import tsx "$@" >> "$LOG_FILE" 2>&1
}

run_claude_prompt() {
  local prompt_file="$1"
  claude -p \
    --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' 'WebSearch(*)' 'WebFetch(*)' \
    < "$prompt_file" >> "$LOG_FILE" 2>&1
}

run_claude_prompt_with_timeout() {
  local prompt_file="$1"
  local timeout_seconds="$2"
  local model_arg="${3:-}"
  local pid elapsed
  local model_flag=()
  [ -n "$model_arg" ] && model_flag=(--model "$model_arg")

  claude -p \
    "${model_flag[@]}" \
    --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' 'WebSearch(*)' 'WebFetch(*)' \
    < "$prompt_file" >> "$LOG_FILE" 2>&1 &
  pid="$!"
  elapsed=0

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      log "claude prompt timed out after ${timeout_seconds}s; killing pid $pid"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      sleep 2
      pkill -KILL -P "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  wait "$pid"
}

count_json_files() {
  local target_dir="$1"
  if [ ! -d "$target_dir" ]; then
    echo 0
    return
  fi
  find "$target_dir" -type f -name '*.json' | wc -l | tr -d ' '
}

clear_dir_json() {
  local target_dir="$1"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
}

snapshot_tasks() {
  rm -rf "$TASK_SNAPSHOT_DIR"
  mkdir -p "$TASK_SNAPSHOT_DIR"
  if [ -d "$TASK_DIR" ]; then
    find "$TASK_DIR" -type f -name '*.json' -exec cp {} "$TASK_SNAPSHOT_DIR"/ \;
  fi
}

restore_task_snapshot() {
  if [ ! -d "$TASK_SNAPSHOT_DIR" ]; then
    return 1
  fi
  local snapshot_count
  snapshot_count="$(count_json_files "$TASK_SNAPSHOT_DIR")"
  if [ "$snapshot_count" -eq 0 ]; then
    return 1
  fi
  rm -rf "$TASK_DIR"
  mkdir -p "$TASK_DIR"
  find "$TASK_SNAPSHOT_DIR" -type f -name '*.json' -exec cp {} "$TASK_DIR"/ \;
}

ensure_tasks_available() {
  local live_count
  live_count="$(count_json_files "$TASK_DIR")"
  if [ "$live_count" -gt 0 ]; then
    return 0
  fi
  restore_task_snapshot
}

stage_enabled() {
  local stage_name="$1"
  case "$START_STAGE" in
    fetch)
      return 0
      ;;
    classify)
      [ "$stage_name" != "fetch" ]
      return
      ;;
    research)
      [ "$stage_name" = "research" ] || [ "$stage_name" = "finalize" ] || [ "$stage_name" = "send" ] || [ "$stage_name" = "publish" ]
      return
      ;;
    finalize)
      [ "$stage_name" = "finalize" ] || [ "$stage_name" = "send" ] || [ "$stage_name" = "publish" ]
      return
      ;;
    send)
      [ "$stage_name" = "send" ] || [ "$stage_name" = "publish" ]
      return
      ;;
    publish)
      [ "$stage_name" = "publish" ]
      return
      ;;
    *)
      return 0
      ;;
  esac
}

if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env.local"
  set +a
fi

log "run-daily-report-claude.sh start"
log "START_STAGE=$START_STAGE"
log "CONTROLLER_MODEL=$CONTROLLER_MODEL CONTROLLER_SPLIT=$CONTROLLER_SPLIT CONTROLLER_TIMEOUT_SECONDS=$CONTROLLER_TIMEOUT_SECONDS"

if ! command -v claude >/dev/null 2>&1; then
  log "claude command not found"
  notify "每日股市報告 ❌" "找不到 claude 指令，請先安裝並登入。Log: $LOG_FILE"
  exit 1
fi

if stage_enabled fetch; then
  log "進度 1/5：開始抓上市/上櫃市場資料"
  if ! run_tsx scripts/fetch-market-data.ts; then
    log "fetch-market-data.ts exited non-zero"
    notify "每日股市報告 ❌" "抓市場資料失敗，請看 log: $LOG_FILE"
    exit 1
  fi

  log "進度 1.6/5：抓國際市場數字 (Yahoo Finance)"
  run_tsx scripts/fetch-intl-market.ts || log "[warn] fetch-intl-market.ts failed; 國際數字略過，不影響台股報告"
fi

if [ ! -f "$PROJECT_DIR/data/market-latest.json" ]; then
  log "data/market-latest.json missing after fetch"
  notify "每日股市報告 ❌" "市場資料檔沒有產出，請看 log: $LOG_FILE"
  exit 1
fi

log "進度 1/5：已經抓回上市/上櫃資料，交易日 $(market_trading_date)"

# score-report: run after fetch/classify, skip when resuming from research or later
if stage_enabled classify; then
  log "進度 1.5/5：執行 score-report 快照與記分板更新"
  run_tsx scripts/score-report.ts || log "[warn] score-report.ts failed; continuing"
fi

if stage_enabled classify; then
  log "進度 2/5：開始做全部分類與族群 task"
  clear_dir_json "$TASK_DIR"
  clear_dir_json "$TASK_SNAPSHOT_DIR"
  clear_dir_json "$RESULT_DIR"

  log "進度 2/6：執行分類 controller (SPLIT=$CONTROLLER_SPLIT)"
  if [ "$CONTROLLER_SPLIT" = "1" ]; then
    GAINER_PROMPT="$(mktemp /tmp/controller-gainer-XXXXXX.md)"
    LOSER_PROMPT="$(mktemp /tmp/controller-loser-XXXXXX.md)"
    cat "$CONTROLLER_PROMPT" > "$GAINER_PROMPT"
    printf '\n\n## 本次執行範圍限制\n只處理 direction=gainer（強勢 100 檔），只輸出 gainer task 檔，檔名以 gainer 為主。完全不要處理 losers。不要清空 data/tmp/group-tasks/ 目錄（runner 已先清空，且此刻有另一個 process 正在同目錄切 loser task）。漏股檢查只需確認強勢 100 檔各出現一次。\n' >> "$GAINER_PROMPT"
    cat "$CONTROLLER_PROMPT" > "$LOSER_PROMPT"
    printf '\n\n## 本次執行範圍限制\n只處理 direction=loser（弱勢 100 檔），只輸出 loser task 檔，檔名以 loser 為主。完全不要處理 gainers。不要清空 data/tmp/group-tasks/ 目錄（runner 已先清空，且此刻有另一個 process 正在同目錄切 gainer task）。漏股檢查只需確認弱勢 100 檔各出現一次。\n' >> "$LOSER_PROMPT"

    run_claude_prompt_with_timeout "$GAINER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_MODEL" &
    GAINER_PID="$!"
    run_claude_prompt_with_timeout "$LOSER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_MODEL" &
    LOSER_PID="$!"

    wait "$GAINER_PID" || log "gainer controller exited non-zero"
    wait "$LOSER_PID" || log "loser controller exited non-zero"

    rm -f "$GAINER_PROMPT" "$LOSER_PROMPT"
  else
    if ! run_claude_prompt_with_timeout "$CONTROLLER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_MODEL"; then
      log "task controller exited non-zero"
    fi
  fi

  TASK_COUNT="$(count_json_files "$TASK_DIR")"
  if [ "$TASK_COUNT" -eq 0 ]; then
    log "進度 2/5：controller 沒有產出 task，改用 deterministic fallback 產生分類"
    if ! run_tsx scripts/generate-group-tasks-fallback.ts "$TASK_DIR"; then
      log "generate-group-tasks-fallback.ts exited non-zero"
      notify "每日股市報告 ❌" "族群 fallback task 產生失敗，請看 log: $LOG_FILE"
      exit 1
    fi
  fi

  if [ "$REFINE_GROUP_TASKS" != "0" ]; then
    log "進度 2/5：套用 deterministic 分類修正"
    if ! run_tsx scripts/refine-group-tasks.ts "$TASK_DIR"; then
      log "refine-group-tasks.ts exited non-zero"
      notify "每日股市報告 ❌" "族群細分修正失敗，請看 log: $LOG_FILE"
      exit 1
    fi
  fi

  TASK_COUNT="$(count_json_files "$TASK_DIR")"
  if [ "$TASK_COUNT" -eq 0 ]; then
    notify "每日股市報告 ❌" "族群切 task 失敗，沒有產出 task 檔。Log: $LOG_FILE"
    exit 1
  fi
  snapshot_tasks
  SNAPSHOT_COUNT="$(count_json_files "$TASK_SNAPSHOT_DIR")"
  log "進度 2/5：已經做好全部分類，共 $TASK_COUNT 個族群 task；snapshot $SNAPSHOT_COUNT 個檔案"
else
  if ! ensure_tasks_available; then
    log "No task files available for stage $START_STAGE"
    notify "每日股市報告 ❌" "找不到 task snapshot，無法從 $START_STAGE 接續。Log: $LOG_FILE"
    exit 1
  fi
fi

if stage_enabled research; then
  if ! ensure_tasks_available; then
    log "Task files unavailable before research"
    notify "每日股市報告 ❌" "research 前找不到 task snapshot。Log: $LOG_FILE"
    exit 1
  fi

  clear_dir_json "$RESULT_DIR"

  # 國際情勢 worker：與台股族群 research 同時平行跑，幾乎不增加整體 wall-clock。
  rm -f "$PROJECT_DIR/data/tmp/intl-brief.txt"
  log "進度 3/5：背景平行啟動國際情勢 worker (model=$INTL_MODEL)"
  claude -p --model "$INTL_MODEL" \
    --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' 'WebSearch(*)' 'WebFetch(*)' \
    < "$INTL_PROMPT" >> "$LOG_FILE" 2>&1 &
  INTL_PID="$!"

  log "進度 3/5：開始做各分類/族群的個別研究報告"
  if ! CLAUDE_REPORT_TASK_DIR="$TASK_SNAPSHOT_DIR" CLAUDE_REPORT_RESULT_DIR="$RESULT_DIR" bash "$WORKER_RUNNER" "${CLAUDE_REPORT_MAX_CONCURRENCY:-6}" > >(tee -a "$LOG_FILE") 2>&1; then
    log "parallel workers exited non-zero; continuing with fallback stories where needed"
  fi

  RESULT_COUNT="$(count_json_files "$RESULT_DIR")"
  log "進度 3/5：個別研究報告完成，產出 $RESULT_COUNT 個 result 檔"

  # 等國際 worker 收尾（通常已隨族群 research 一起跑完）
  if ! wait "$INTL_PID"; then
    log "[warn] 國際情勢 worker 非零退出；intl-brief 可能沒寫出來，attach-intl 會自動略過"
  fi
  if [ -f "$PROJECT_DIR/data/tmp/intl-brief.txt" ]; then
    log "進度 3/5：國際情勢 worker 完成，已寫出 intl-brief.txt"
  else
    log "[warn] 國際情勢 worker 沒寫出 intl-brief.txt；報告國際區塊將只有數字表"
  fi
fi

if stage_enabled finalize; then
  if ! restore_task_snapshot; then
    log "Task snapshot missing before finalizer"
    notify "每日股市報告 ❌" "finalizer 前找不到 task snapshot。Log: $LOG_FILE"
    exit 1
  fi

  log "進度 4/5：開始 finalizer 組裝盤後分析"
  if ! run_claude_prompt "$FINALIZER_PROMPT"; then
    log "finalizer exited non-zero"
  fi

  if [ ! -f "$PROJECT_DIR/data/analysis-latest.json" ]; then
    log "analysis-latest.json missing after finalizer"
    notify "每日股市報告 ❌" "分析結果檔沒有產出，請看 log: $LOG_FILE"
    exit 1
  fi
  log "進度 4/5：finalizer 已產出 data/analysis-latest.json"

  # finalizer 自己寫 analysis-latest.json、不走 assemble，所以這裡再把國際情勢併進 intl 欄位
  run_tsx scripts/attach-intl.ts || log "[warn] attach-intl.ts failed; 報告將沒有國際區塊"
fi

if [ ! -f "$PROJECT_DIR/data/analysis-latest.json" ]; then
  log "analysis-latest.json missing before send stage"
  notify "每日股市報告 ❌" "寄信前找不到 analysis-latest.json。Log: $LOG_FILE"
  exit 1
fi

if stage_enabled send; then
  log "進度 5/5：開始產生 HTML 並寄送報告"
  if [ -n "${GAS_WEBHOOK_URL:-}" ]; then
    if ! run_tsx scripts/send-report.ts; then
      log "send-report.ts exited non-zero"
      notify "每日股市報告 ❌" "報告產出成功，但寄信失敗。Log: $LOG_FILE"
      exit 1
    fi
    log "進度 5/5：報告已寄出"
  else
    if ! run_tsx scripts/send-report.ts data/analysis-latest.json --no-email; then
      log "send-report.ts --no-email exited non-zero"
      notify "每日股市報告 ❌" "報告產出成功，但 HTML 預覽失敗。Log: $LOG_FILE"
      exit 1
    fi
    log "進度 5/5：未設定 GAS_WEBHOOK_URL，已產生 HTML 預覽但未寄信"
  fi
fi

if stage_enabled publish; then
  log "進度 6/6：部署到 Vercel"
  if ! bash "$PROJECT_DIR/scripts/publish-vercel.sh" > >(tee -a "$LOG_FILE") 2>&1; then
    log "[warn] publish-vercel.sh 失敗（不中斷整體流程）"
  fi
fi

log "Done"
notify "每日股市報告 ✅" "Claude Code 平行 research 已完成並產出報告"
