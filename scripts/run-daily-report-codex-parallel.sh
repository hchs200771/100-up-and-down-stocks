#!/bin/bash
set -u

export PATH="/Users/max/.nvm/versions/node/v20.12.0/bin:/Users/max/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTROLLER_PROMPT="$PROJECT_DIR/scripts/prompts/group-task-controller.md"
FINALIZER_PROMPT="$PROJECT_DIR/scripts/prompts/group-finalizer.md"
WORKER_RUNNER="$PROJECT_DIR/scripts/run-codex-group-workers.sh"
TMP_DIR="$PROJECT_DIR/data/tmp"
TASK_DIR="$TMP_DIR/group-tasks"
TASK_SNAPSHOT_DIR="$TMP_DIR/group-tasks-backup"
RESULT_DIR="$TMP_DIR/group-results"
START_STAGE="${CODEX_REPORT_START_STAGE:-fetch}"
CONTROLLER_MODEL="${CODEX_CONTROLLER_MODEL:-gpt-5.5}"
FINALIZER_MODEL="${CODEX_FINALIZER_MODEL:-gpt-5.5}"
REFINE_GROUP_TASKS="${CODEX_REFINE_GROUP_TASKS:-1}"
CONTROLLER_TIMEOUT_SECONDS="${CODEX_CONTROLLER_TIMEOUT_SECONDS:-900}"
cd "$PROJECT_DIR" || exit 1

LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d_%H%M%S)-codex-parallel.log"

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

run_codex_prompt() {
  local model="$1"
  local prompt_file="$2"
  codex exec --full-auto -m "$model" -C "$PROJECT_DIR" - < "$prompt_file" >> "$LOG_FILE" 2>&1
}

run_codex_prompt_with_timeout() {
  local model="$1"
  local prompt_file="$2"
  local timeout_seconds="$3"
  local pid elapsed

  codex exec --full-auto -m "$model" -C "$PROJECT_DIR" - < "$prompt_file" >> "$LOG_FILE" 2>&1 &
  pid="$!"
  elapsed=0

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      log "codex prompt timed out after ${timeout_seconds}s; killing pid $pid"
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
      [ "$stage_name" = "research" ] || [ "$stage_name" = "finalize" ] || [ "$stage_name" = "send" ]
      return
      ;;
    finalize)
      [ "$stage_name" = "finalize" ] || [ "$stage_name" = "send" ]
      return
      ;;
    send)
      [ "$stage_name" = "send" ]
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

log "run-daily-report-codex-parallel.sh start"
log "START_STAGE=$START_STAGE"
log "CONTROLLER_MODEL=$CONTROLLER_MODEL FINALIZER_MODEL=$FINALIZER_MODEL CODEX_GROUP_WORKER_MODEL=${CODEX_GROUP_WORKER_MODEL:-gpt-5.4-mini}"
log "CONTROLLER_TIMEOUT_SECONDS=$CONTROLLER_TIMEOUT_SECONDS"

if ! command -v codex >/dev/null 2>&1; then
  log "codex command not found"
  notify "每日股市報告 ❌" "找不到 codex 指令，請先安裝並登入。Log: $LOG_FILE"
  exit 1
fi

if stage_enabled fetch; then
  log "進度 1/5：開始抓上市/上櫃市場資料"
  if ! run_tsx scripts/fetch-market-data.ts; then
    log "fetch-market-data.ts exited non-zero"
    notify "每日股市報告 ❌" "抓市場資料失敗，請看 log: $LOG_FILE"
    exit 1
  fi
fi

if [ ! -f "$PROJECT_DIR/data/market-latest.json" ]; then
  log "data/market-latest.json missing after fetch"
  notify "每日股市報告 ❌" "市場資料檔沒有產出，請看 log: $LOG_FILE"
  exit 1
fi

log "進度 1/5：已經抓回上市/上櫃資料，交易日 $(market_trading_date)"

if stage_enabled classify; then
  log "進度 2/5：開始做全部分類與族群 task"
  clear_dir_json "$TASK_DIR"
  clear_dir_json "$TASK_SNAPSHOT_DIR"
  clear_dir_json "$RESULT_DIR"

  log "進度 2/5：執行分類 controller"
  if ! run_codex_prompt_with_timeout "$CONTROLLER_MODEL" "$CONTROLLER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS"; then
    log "task controller exited non-zero"
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
  log "進度 3/5：開始做各分類/族群的個別研究報告"
  if ! CODEX_GROUP_TASK_DIR="$TASK_SNAPSHOT_DIR" CODEX_GROUP_RESULT_DIR="$RESULT_DIR" bash "$WORKER_RUNNER" "${CODEX_GROUP_MAX_CONCURRENCY:-4}" > >(tee -a "$LOG_FILE") 2>&1; then
    log "parallel workers exited non-zero; continuing with fallback stories where needed"
  fi

  RESULT_COUNT="$(count_json_files "$RESULT_DIR")"
  log "進度 3/5：個別研究報告完成，產出 $RESULT_COUNT 個 result 檔"
fi

if stage_enabled finalize; then
  if ! restore_task_snapshot; then
    log "Task snapshot missing before finalizer"
    notify "每日股市報告 ❌" "finalizer 前找不到 task snapshot。Log: $LOG_FILE"
    exit 1
  fi

  log "進度 4/5：開始 finalizer 組裝盤後分析"
  if ! run_codex_prompt "$FINALIZER_MODEL" "$FINALIZER_PROMPT"; then
    log "finalizer exited non-zero"
  fi

  if [ ! -f "$PROJECT_DIR/data/analysis-latest.json" ]; then
    log "analysis-latest.json missing after finalizer"
    notify "每日股市報告 ❌" "分析結果檔沒有產出，請看 log: $LOG_FILE"
    exit 1
  fi
  log "進度 4/5：finalizer 已產出 data/analysis-latest.json"
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

log "Done"
notify "每日股市報告 ✅" "Codex 平行 research 已完成並產出報告"
