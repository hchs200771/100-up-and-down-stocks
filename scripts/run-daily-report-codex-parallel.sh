#!/bin/bash
set -u

# launchd 給的 PATH 很精簡，這裡補回 node / claude / codex 的常見安裝位置。
# 不寫死家目錄與 node 版本：換一台機器後路徑就不存在，整條流程會在第一步找不到 node。
_nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${_nvm_bin:+$_nvm_bin:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTROLLER_PROMPT="$PROJECT_DIR/scripts/prompts/group-task-controller.md"
STRUCTURED_CONTROLLER_PROMPT="$PROJECT_DIR/scripts/prompts/group-task-controller-codex.md"
FINALIZER_PROMPT="$PROJECT_DIR/scripts/prompts/group-finalizer.md"
WORKER_RUNNER="$PROJECT_DIR/scripts/run-codex-group-workers.sh"
CONTROLLER_SCHEMA="$PROJECT_DIR/scripts/schemas/codex-controller-groups.schema.json"
TMP_DIR="$PROJECT_DIR/data/tmp"
TASK_DIR="$TMP_DIR/group-tasks"
TASK_SNAPSHOT_DIR="$TMP_DIR/group-tasks-backup"
RESULT_DIR="$TMP_DIR/group-results"
START_STAGE="${CODEX_REPORT_START_STAGE:-fetch}"
CONTROLLER_MODEL="${CODEX_CONTROLLER_MODEL:-gpt-6.1-sol}"
CONTROLLER_SPLIT="${CODEX_CONTROLLER_SPLIT:-1}"
FINALIZER_MODEL="${CODEX_FINALIZER_MODEL:-gpt-5.6-sol}"
REFINE_GROUP_TASKS="${CODEX_REFINE_GROUP_TASKS:-1}"
CONTROLLER_TIMEOUT_SECONDS="${CODEX_CONTROLLER_TIMEOUT_SECONDS:-900}"
# 族群研究 worker 的同時執行數。研究階段是「一個族群一個 codex 子行程」，
# 每個都在等 API、幾乎不吃本機 CPU，所以瓶頸是併發數不是機器。
# 6 → 10：族群數通常 20~30 個，10 條大約兩輪就跑完。
# 再往上要留意 codex 端的速率限制，真的被擋就調回 8。
GROUP_CONCURRENCY="${CODEX_GROUP_MAX_CONCURRENCY:-10}"
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

# ── 階段計時 ────────────────────────────────────────────────────
# 每個步驟的耗時寫成一行 TSV，最後彙整成「最慢的在最上面」的表，
# 並存成 data/logs/timing-*.json 供跨日比較（要優化先看這張表，不要憑感覺猜）。
# 平行步驟由各自的子行程 append，單行寫入夠短，不會互相截斷。
RUN_T0="$(date +%s)"
TIMING_FILE="$TMP_DIR/timings.tsv"
mkdir -p "$TMP_DIR"
: > "$TIMING_FILE"

# timed <名稱> <指令...>：計時執行，回傳原本的 exit code。
# 加 & 就是背景平行版，計時一樣準（各自記錄自己的 wall-clock）。
timed() {
  local name="$1"; shift
  local t0 t1 rc
  t0="$(date +%s)"
  "$@"
  rc=$?
  t1="$(date +%s)"
  printf '%s\t%s\t%s\n' "$name" "$((t1 - t0))" "$rc" >> "$TIMING_FILE"
  # 變數一律用 ${} 包起來：後面接全形括號時，裸寫 $rc 會被 bash 連著 CJK 位元組
  # 一起當成變數名（實測 "rc）: unbound variable"）。
  log "⏱ ${name} 耗時 $((t1 - t0))s（rc=${rc}）"
  return $rc
}

# 輔助資料的背景 PID。這些步驟只依賴 market-latest.json，產出只有 send-report 要用，
# 中間的 controller 與 research 完全用不到，所以 fetch 後就放行、等到送信前才 wait，
# 整段（最慢的是 RRG 抓 245 檔，實測 ~6m30s）藏在 research 底下，不佔關鍵路徑。
# 用空白分隔字串而不是陣列：macOS 內建 bash 3.2 對空陣列 + set -u 會炸。
AUX_PIDS=""

timing_summary() {
  local total=$(( $(date +%s) - RUN_T0 ))
  log "──────── 階段耗時（由慢到快，wall-clock）────────"
  if [ -s "$TIMING_FILE" ]; then
    # 平行步驟的耗時相加會超過總時間，那是正常的（重疊執行）
    sort -t$'\t' -k2 -rn "$TIMING_FILE" | while IFS=$'\t' read -r name secs rc; do
      local mark=""
      [ "$rc" != "0" ] && mark=" ❌rc=$rc"
      printf '  %6ss  %s%s\n' "$secs" "$name" "$mark" | tee -a "$LOG_FILE"
    done
  fi
  log "總時間 ${total}s（$((total / 60))m$((total % 60))s）"
  node -e '
    const fs=require("fs");
    const [tsv,out,total,startedAt]=process.argv.slice(1);
    const rows=fs.existsSync(tsv)?fs.readFileSync(tsv,"utf8").trim().split("\n").filter(Boolean):[];
    const stages=rows.map(l=>{const [name,secs,rc]=l.split("\t");return{name,seconds:+secs,ok:rc==="0"};})
      .sort((a,b)=>b.seconds-a.seconds);
    fs.writeFileSync(out,JSON.stringify({startedAt,totalSeconds:+total,stages},null,1));
  ' "$TIMING_FILE" "$LOG_DIR/timing-$(date +%Y-%m-%d_%H%M%S).json" "$total" "$(date -r "$RUN_T0" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo unknown)" 2>/dev/null || true
}

market_trading_date() {
  node -e 'const fs = require("fs"); const p = "data/market-latest.json"; if (!fs.existsSync(p)) process.exit(0); const data = JSON.parse(fs.readFileSync(p, "utf8")); process.stdout.write(data.tradingDate || data.timestamp || "unknown");' 2>/dev/null
}

run_tsx() {
  node --import tsx "$@" >> "$LOG_FILE" 2>&1
}

fallback_controller_side() {
  local direction="$1"
  local side codes
  [ "$direction" = "gainer" ] && side="gainers" || side="losers"
  codes="$(node -e 'const fs=require("fs"); const side=process.argv[1]; const market=JSON.parse(fs.readFileSync("data/market-latest.json","utf8")); process.stdout.write((market[side]||[]).map((stock)=>stock.code).join(","));' "$side")"
  if [ -z "$codes" ]; then
    log "[error] $direction fallback 找不到市場股票代號"
    return 1
  fi
  log "[warn] $direction controller 無法使用，改用 deterministic fallback 補齊該側"
  run_tsx scripts/generate-group-tasks-fallback.ts "$TASK_DIR" "$codes"
}

run_codex_prompt() {
  local model="$1"
  local prompt_file="$2"
  codex exec --approve-for-me -m "$model" -C "$PROJECT_DIR" - < "$prompt_file" >> "$LOG_FILE" 2>&1
}

run_codex_prompt_with_timeout() {
  local model="$1"
  local prompt_file="$2"
  local timeout_seconds="$3"
  local pid started_at now

  codex exec --approve-for-me -m "$model" -C "$PROJECT_DIR" - < "$prompt_file" >> "$LOG_FILE" 2>&1 &
  pid="$!"
  started_at="$(date +%s)"

  while kill -0 "$pid" 2>/dev/null; do
    now="$(date +%s)"
    if [ "$((now - started_at))" -ge "$timeout_seconds" ]; then
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
  done

  wait "$pid"
}

run_codex_structured_with_timeout() {
  local model="$1"
  local prompt_file="$2"
  local timeout_seconds="$3"
  local schema_file="$4"
  local output_file="$5"
  local pid started_at now

  codex exec --approve-for-me --ephemeral --color never \
    --output-schema "$schema_file" -o "$output_file" \
    -m "$model" -C "$PROJECT_DIR" - < "$prompt_file" >> "$LOG_FILE" 2>&1 &
  pid="$!"
  started_at="$(date +%s)"

  while kill -0 "$pid" 2>/dev/null; do
    now="$(date +%s)"
    if [ "$((now - started_at))" -ge "$timeout_seconds" ]; then
      log "codex structured prompt timed out after ${timeout_seconds}s; killing pid $pid"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      sleep 2
      pkill -KILL -P "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 5
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

# 讀出 JSON 檔的 date 欄位（讀不到就回空字串）。給 finalizer 後的日期一致性檢查用。
read_json_date() {
  node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).date||""))}catch(e){}' "$1"
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

log "run-daily-report-codex-parallel.sh start"
log "START_STAGE=$START_STAGE"
log "CONTROLLER_MODEL=$CONTROLLER_MODEL FINALIZER_MODEL=$FINALIZER_MODEL CODEX_GROUP_WORKER_MODEL=${CODEX_GROUP_WORKER_MODEL:-gpt-5.6-luna} CONTROLLER_SPLIT=$CONTROLLER_SPLIT"
log "CONTROLLER_TIMEOUT_SECONDS=$CONTROLLER_TIMEOUT_SECONDS GROUP_CONCURRENCY=$GROUP_CONCURRENCY"

if ! command -v codex >/dev/null 2>&1; then
  log "codex command not found"
  notify "每日股市報告 ❌" "找不到 codex 指令，請先安裝並登入。Log: $LOG_FILE"
  exit 1
fi

if stage_enabled fetch; then
  log "進度 1/5：開始抓上市/上櫃市場資料"
  if ! timed fetch-market run_tsx scripts/fetch-market-data.ts; then
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

# 漏跑的日子先補：收盤價、融資、市場情緒序列，並列出補不回來的選股池日期。
# 必須在任何用到均線/報酬的步驟之前，也必須在背景輔助資料之前同步跑完
# （fetch-margin-options 也會寫 margin-history.json）。已補過的日子有快取，平常幾乎不打 API。
if stage_enabled fetch; then
  timed missed-days run_tsx scripts/backfill-missed-days.ts \
    || log "[warn] backfill-missed-days.ts failed; 均線與報酬率可能因缺格而失真"
fi

# 輔助資料：全部只依賴 market-latest.json（或完全獨立的外部來源），彼此之間沒有相依，
# 所以整批背景平行丟出去，這裡不 wait，直接往下跑分類與 research（見 AUX_PIDS）。
# 每個都用 timed 包起來，事後看 timing 表就知道該優化誰。
# 失敗一律只 warn：這些是加值分頁，不該擋住主流程。
if stage_enabled fetch; then
  log "進度 1.2/5：背景平行抓輔助資料（指數貢獻／融資選擇權／集保／國際／信用利差／RRG／設質+CB）"

  timed index-contribution run_tsx scripts/build-index-contribution.ts \
    || log "[warn] build-index-contribution.ts failed; 指數貢獻分頁略過，不影響其他區塊" &
  AUX_PIDS="$AUX_PIDS $!"
  timed margin-options run_tsx scripts/fetch-margin-options.ts \
    || log "[warn] fetch-margin-options.ts failed; 融資與外資選擇權區塊略過，不影響其他區塊" &
  AUX_PIDS="$AUX_PIDS $!"
  timed intl-market run_tsx scripts/fetch-intl-market.ts \
    || log "[warn] fetch-intl-market.ts failed; 國際數字略過，不影響台股報告" &
  AUX_PIDS="$AUX_PIDS $!"
  # 板塊熱圖：每天都要跑，因為 ETF 淨流量是靠自己累積的股數快照跨日相減算出來的，
  # 漏跑一天就少一筆基準（fetch-sector-flows.ts）。
  timed sector-flows run_tsx scripts/fetch-sector-flows.ts \
    || log "[warn] fetch-sector-flows.ts failed; 美股板塊熱圖略過，不影響台股報告" &
  AUX_PIDS="$AUX_PIDS $!"
  timed credit-spreads run_tsx scripts/fetch-credit-spreads.ts \
    || log "[warn] fetch-credit-spreads.ts failed; 信用利差略過，不影響台股報告" &
  AUX_PIDS="$AUX_PIDS $!"
  timed theme-radar run_tsx scripts/build-theme-radar.ts \
    || log "[warn] build-theme-radar.ts failed; 題材觀察欄位略過，不影響選股分數" &
  AUX_PIDS="$AUX_PIDS $!"

  # 集保是週資料且抓取冪等（同一週已存過就跳過），但 divergence 依賴 holders 的產出，
  # 這兩步必須依序，所以包成同一個子行程、與其他步驟平行。
  (
    timed tdcc-holders run_tsx scripts/fetch-tdcc-holders.ts \
      || log "[warn] fetch-tdcc-holders.ts failed; 大戶籌碼分頁略過"
    timed tdcc-divergence run_tsx scripts/build-tdcc-divergence.ts \
      || log "[warn] build-tdcc-divergence.ts failed（快照可能不足兩份）; 大戶籌碼分頁略過"
  ) &
  AUX_PIDS="$AUX_PIDS $!"

  # RRG：抓 245 檔 Yahoo，是這批裡最慢的，排進平行區才不會拖長總時間。
  # render 依賴 build 的輸出，同樣包成一個子行程。
  (
    timed rrg-build run_tsx scripts/build-tw-rrg.ts \
      || log "[warn] build-tw-rrg.ts failed; 族群輪動分頁略過"
    timed rrg-render run_tsx scripts/render-tw-rrg.ts \
      || log "[warn] render-tw-rrg.ts failed; 族群輪動互動圖略過"
    timed rrg-alerts run_tsx scripts/build-rrg-alerts.ts \
      || log "[warn] build-rrg-alerts.ts failed; RRG 警示略過"
  ) &
  AUX_PIDS="$AUX_PIDS $!"

  # 設質+CB：CB 行情日更，同一台北日內冪等；設質快照仍依官方月頻資料比較。
  timed cb-pledge run_tsx scripts/screen-cb-pledge.ts \
    || log "[warn] screen-cb-pledge.ts failed; 設質+CB 子頁沿用上次結果" &
  AUX_PIDS="$AUX_PIDS $!"

  # 贏家分點：名單在 Notion「分點追蹤名單」（讀不到就用 data/broker-watch-config.json），
  # 資料來自富邦 e01，約 45 日滾動窗，每天累積進 data/broker-watch-history/。
  timed broker-watch run_tsx scripts/fetch-broker-watch.ts \
    || log "[warn] fetch-broker-watch.ts failed; 贏家分點區塊略過" &
  AUX_PIDS="$AUX_PIDS $!"

fi

if stage_enabled classify; then
  log "進度 1.5/5：執行 score-report 快照與記分板更新"
  timed score-report run_tsx scripts/score-report.ts || log "[warn] score-report.ts failed; continuing"
  timed classify-input run_tsx scripts/build-codex-classify-input.ts || {
    log "build-codex-classify-input.ts exited non-zero"
    exit 1
  }
fi

if stage_enabled classify; then
  log "進度 2/5：開始做全部分類與族群 task"
  clear_dir_json "$TASK_DIR"
  clear_dir_json "$TASK_SNAPSHOT_DIR"
  clear_dir_json "$RESULT_DIR"

  log "進度 2/6：執行分類 controller (SPLIT=$CONTROLLER_SPLIT)"
  if [ "$CONTROLLER_SPLIT" = "1" ]; then
    GAINER_PROMPT="$(mktemp /tmp/controller-gainer-XXXXXX)"
    LOSER_PROMPT="$(mktemp /tmp/controller-loser-XXXXXX)"
    GAINER_OUTPUT="$TMP_DIR/controller-gainer.json"
    LOSER_OUTPUT="$TMP_DIR/controller-loser.json"
    rm -f "$GAINER_OUTPUT" "$LOSER_OUTPUT"
    cat "$STRUCTURED_CONTROLLER_PROMPT" > "$GAINER_PROMPT"
    printf '\n\n本次只處理 direction=gainer，只使用輸入的 gainers；JSON 的 direction 固定為 gainer。\n' >> "$GAINER_PROMPT"
    cat "$STRUCTURED_CONTROLLER_PROMPT" > "$LOSER_PROMPT"
    printf '\n\n本次只處理 direction=loser，只使用輸入的 losers；JSON 的 direction 固定為 loser。\n' >> "$LOSER_PROMPT"

    timed controller-gainer run_codex_structured_with_timeout "$CONTROLLER_MODEL" "$GAINER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_SCHEMA" "$GAINER_OUTPUT" &
    GAINER_PID="$!"
    timed controller-loser run_codex_structured_with_timeout "$CONTROLLER_MODEL" "$LOSER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_SCHEMA" "$LOSER_OUTPUT" &
    LOSER_PID="$!"

    wait "$GAINER_PID" || log "gainer controller exited non-zero"
    wait "$LOSER_PID" || log "loser controller exited non-zero"

    rm -f "$GAINER_PROMPT" "$LOSER_PROMPT"
    if [ -f "$GAINER_OUTPUT" ]; then
      run_tsx scripts/split-codex-controller-output.ts "$GAINER_OUTPUT" "$TASK_DIR" gainer \
        || fallback_controller_side gainer \
        || { log "gainer controller 與 fallback 都失敗"; exit 1; }
    else
      fallback_controller_side gainer || { log "gainer controller 沒有輸出且 fallback 失敗"; exit 1; }
    fi
    if [ -f "$LOSER_OUTPUT" ]; then
      run_tsx scripts/split-codex-controller-output.ts "$LOSER_OUTPUT" "$TASK_DIR" loser \
        || fallback_controller_side loser \
        || { log "loser controller 與 fallback 都失敗"; exit 1; }
    else
      fallback_controller_side loser || { log "loser controller 沒有輸出且 fallback 失敗"; exit 1; }
    fi
  else
    if ! timed controller run_codex_prompt_with_timeout "$CONTROLLER_MODEL" "$CONTROLLER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS"; then
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
    if ! timed refine-tasks run_tsx scripts/refine-group-tasks.ts "$TASK_DIR"; then
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
  if ! timed research-workers env CODEX_GROUP_TASK_DIR="$TASK_SNAPSHOT_DIR" CODEX_GROUP_RESULT_DIR="$RESULT_DIR" bash "$WORKER_RUNNER" "$GROUP_CONCURRENCY" > >(tee -a "$LOG_FILE") 2>&1; then
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

  # 先把 task + result 機械合併成單一骨架檔。finalizer prompt 已改成只讀這一份，
  # 不再逐一 Read 一百多個檔（每個 Read 都是一次 API round-trip）。骨架缺席的話
  # finalizer 會找不到任何族群資料，所以這裡直接當致命錯誤中止，不要放它產出半份報告。
  log "進度 3.9/5：組 analysis skeleton"
  if ! timed skeleton run_tsx scripts/build-analysis-skeleton.ts "$TASK_DIR" "$RESULT_DIR"; then
    log "build-analysis-skeleton.ts exited non-zero"
    notify "每日股市報告 ❌" "analysis skeleton 沒產出，finalizer 無法進行。Log: $LOG_FILE"
    exit 1
  fi

  log "進度 4/5：開始 finalizer 組裝盤後分析"
  if ! timed finalizer run_codex_prompt_with_timeout "$FINALIZER_MODEL" "$FINALIZER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS"; then
    log "finalizer exited non-zero"
  fi

  if [ ! -f "$PROJECT_DIR/data/analysis-latest.json" ]; then
    log "analysis-latest.json missing after finalizer"
    notify "每日股市報告 ❌" "分析結果檔沒有產出，請看 log: $LOG_FILE"
    exit 1
  fi

  # finalizer 非零退出時，前一交易日的 analysis-latest.json 仍可能留在原地。
  # skeleton 是本次執行機械合併出的安全 fallback；日期不一致時改用它，避免送出舊報告。
  SKELETON_FILE="$PROJECT_DIR/data/tmp/analysis-skeleton.json"
  if [ -f "$SKELETON_FILE" ]; then
    SKELETON_DATE="$(read_json_date "$SKELETON_FILE" 2>/dev/null || true)"
    ANALYSIS_DATE="$(read_json_date "$PROJECT_DIR/data/analysis-latest.json" 2>/dev/null || true)"
    if [ -n "$SKELETON_DATE" ] && [ "$SKELETON_DATE" != "$ANALYSIS_DATE" ]; then
      log "[warn] analysis-latest.json 日期 $ANALYSIS_DATE 與 skeleton $SKELETON_DATE 不符；改用本次 skeleton，避免送出舊報告"
      cp "$SKELETON_FILE" "$PROJECT_DIR/data/analysis-latest.json"
    fi
  fi
  if ! timed analysis-completeness run_tsx scripts/validate-analysis-completeness.ts \
    "$PROJECT_DIR/data/analysis-latest.json" "$SKELETON_FILE" "$PROJECT_DIR/data/market-latest.json"; then
    log "analysis completeness validation failed; refusing to generate or publish an incomplete report"
    notify "每日股市報告 ❌" "上漲／下跌族群資料不完整，已停止發布。Log: $LOG_FILE"
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
  # 終極選股池：統合大戶/CB設質/法人/RRG/分類/動能，需要 analysis-latest.json，所以排在 send 階段開頭
  # 到這裡才收輔助資料。正常情況它們早在 research 那十幾分鐘裡跑完了，這個 wait 是零成本。
  if [ -n "$AUX_PIDS" ]; then
    log "進度 4.5/5：等背景輔助資料收尾"
    for _p in $AUX_PIDS; do wait "$_p" 2>/dev/null || true; done
    log "進度 4.5/5：輔助資料全部結束"
  fi

  timed stock-picks run_tsx scripts/build-stock-picks.ts || log "[warn] build-stock-picks.ts failed; 終極選股池分頁略過，不影響其他區塊"
  # 前 5 名前瞻追蹤（docs/wide-market-scan-conclusion.md）：只更新 data/stock-picks-backtest.json，失敗不影響報告
  timed picks-tracking run_tsx scripts/backtest-stock-picks.ts --quiet \
    || log "[warn] backtest-stock-picks.ts failed; 前 5 名追蹤略過"
  log "進度 5/5：開始產生 HTML（Codex 流程不寄信）"
  if ! timed send-report run_tsx scripts/send-report.ts data/analysis-latest.json --no-email; then
    log "send-report.ts --no-email exited non-zero"
    notify "每日股市報告 ❌" "報告分析成功，但 HTML 產出失敗。Log: $LOG_FILE"
    exit 1
  fi
  log "進度 5/5：HTML 已產生，未寄信"
fi

if stage_enabled publish; then
  log "進度 6/6：部署到 GitHub Pages"
  if ! timed publish bash "$PROJECT_DIR/scripts/publish-github-pages.sh" > >(tee -a "$LOG_FILE") 2>&1; then
    log "[warn] publish-github-pages.sh 失敗（不中斷整體流程）"
  fi
fi

timing_summary
log "Done"
notify "每日股市報告 ✅" "Codex 平行 research 已完成並產出報告"
