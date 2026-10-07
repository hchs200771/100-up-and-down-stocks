#!/bin/bash
set -u

# launchd 給的 PATH 很精簡，這裡補回 node / claude / codex 的常見安裝位置。
# 不寫死家目錄與 node 版本：換一台機器後路徑就不存在，整條流程會在第一步找不到 node。
_nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${_nvm_bin:+$_nvm_bin:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTROLLER_PROMPT="$PROJECT_DIR/scripts/prompts/group-task-controller.md"
STRUCTURED_CONTROLLER_PROMPT="$PROJECT_DIR/scripts/prompts/group-task-controller-claude.md"
CONTROLLER_SCHEMA="$PROJECT_DIR/scripts/schemas/codex-controller-groups.schema.json"
FINALIZER_PROMPT="$PROJECT_DIR/scripts/prompts/group-finalizer.md"
INTL_PROMPT="$PROJECT_DIR/scripts/prompts/intl-brief-worker.md"
# 國際情勢 brief 屬研究/敘事工作，不是判斷分類，2026-09 降級到 haiku 省 token
INTL_MODEL="${CLAUDE_INTL_MODEL:-haiku}"
KOL_PROMPT="$PROJECT_DIR/scripts/prompts/kol-brief-worker.md"
KOL_MODEL="${CLAUDE_KOL_MODEL:-sonnet}"
WORKER_RUNNER="$PROJECT_DIR/scripts/run-claude-group-workers.sh"
TMP_DIR="$PROJECT_DIR/data/tmp"
TASK_DIR="$TMP_DIR/group-tasks"
TASK_SNAPSHOT_DIR="$TMP_DIR/group-tasks-backup"
RESULT_DIR="$TMP_DIR/group-results"
START_STAGE="${CLAUDE_REPORT_START_STAGE:-fetch}"
REFINE_GROUP_TASKS="${CLAUDE_REPORT_REFINE_GROUP_TASKS:-1}"
# 分類是全流程地基，不可下放小模型（haiku 實測會把指標股歸錯族群）
CONTROLLER_MODEL="${CLAUDE_CONTROLLER_MODEL:-opus}"
# finalizer 要組出全站最大的判斷（盤後總結＋長線策略），明確鎖高階模型，
# 不要讓它偷偷跟著使用者當下 `/model` 的預設值飄動
FINALIZER_MODEL="${CLAUDE_FINALIZER_MODEL:-opus}"
CONTROLLER_BATCH_RUNNER="$PROJECT_DIR/scripts/run-claude-controller-batches.sh"
# structured：強弱各一個結構化輸出，由 TypeScript 驗證並拆檔（預設，最省 token）
# batch：分批小 call，中斷可續跑（舊版，見 run-claude-controller-batches.sh）
# 1：舊版，只切成強勢/弱勢兩個大 call，中斷等於整段作廢
# 0：不切，單一個 call 處理全部 200 檔
CONTROLLER_SPLIT="${CLAUDE_CONTROLLER_SPLIT:-structured}"
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

# ── 階段計時 ────────────────────────────────────────────────────
# 每個步驟的耗時寫成一行 TSV，最後彙整成「最慢的在最上面」的表，
# 並存成 data/logs/timing-*.json 供跨日比較（要優化先看這張表，不要憑感覺猜）。
# 平行步驟由各自的子行程 append，單行寫入夠短，不會互相截斷。
RUN_T0="$(date +%s)"
TIMING_FILE="$TMP_DIR/timings.tsv"
mkdir -p "$TMP_DIR"
: > "$TIMING_FILE"

# ── Token 花費追蹤 ──────────────────────────────────────────────
# 每一次 claude -p 呼叫的 total_cost_usd 記一行，跑完彙整成「哪一段最貴」，
# 不用再憑感覺猜該把哪個 worker 降模型。worker runner（run-claude-group-workers.sh）
# 也會 append 進同一份檔案，所以這裡先建立、不要清空由它自己管理的部分。
COST_FILE="$TMP_DIR/costs.tsv"
: > "$COST_FILE"

# record_claude_cost <名稱> <claude --output-format json 的輸出檔>：
# 從輸出裡取 total_cost_usd 記一行，抓不到就記 0（例如被 timeout 砍掉、輸出不完整）。
record_claude_cost() {
  local name="$1" json_file="$2" cost
  cost="$(node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(j.total_cost_usd || 0));
    } catch (e) { process.stdout.write("0"); }
  ' "$json_file" 2>/dev/null)"
  [ -z "$cost" ] && cost="0"
  printf '%s\t%s\n' "$name" "$cost" >> "$COST_FILE"
  log "💰 ${name} cost \$${cost}"
}

cost_summary() {
  [ -s "$COST_FILE" ] || return 0
  log "──────── Token 花費（由貴到便宜，USD）────────"
  node -e '
    const fs = require("fs");
    const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean)
      .map(l => { const [name, cost] = l.split("\t"); return { name, cost: +cost || 0 }; });
    const byName = {};
    for (const r of rows) byName[r.name] = (byName[r.name] || 0) + r.cost;
    const total = rows.reduce((s, r) => s + r.cost, 0);
    for (const [name, cost] of Object.entries(byName).sort((a, b) => b[1] - a[1])) {
      console.log(`  $${cost.toFixed(4)}  ${name}`);
    }
    console.log(`  總計 $${total.toFixed(4)}`);
  ' "$COST_FILE" | tee -a "$LOG_FILE"
}

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
# 整段（最慢的是 RRG 抓 245 檔）藏在 research 底下，不佔關鍵路徑。
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

# task_dir_is_fresh：TASK_DIR 裡是不是已經有「今天」的 task 檔——如果是，代表這是
# 中斷後的重跑（額度用盡等），要保留下來讓分批 controller 只補沒做完的批次；
# 如果目錄是空的、或裡面是前一個交易日留下的舊檔，就要清空重新開始，
# 不然舊資料會跟今天的混在一起流進報告。
task_dir_is_fresh() {
  local dir="$1" today sample file_date
  today="$(market_trading_date)"
  [ -z "$today" ] && return 1
  sample="$(find "$dir" -maxdepth 1 -type f -name '*.json' 2>/dev/null | head -1)"
  [ -z "$sample" ] && return 1
  file_date="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tradingDate||""))}catch(e){}' "$sample" 2>/dev/null)"
  [ -n "$file_date" ] && [ "$file_date" = "$today" ]
}

run_tsx() {
  node --import tsx "$@" >> "$LOG_FILE" 2>&1
}

run_claude_prompt() {
  local prompt_file="$1"
  local model_arg="${2:-}"
  local model_flag=()
  [ -n "$model_arg" ] && model_flag=(--model "$model_arg")
  local out_file rc
  out_file="$(mktemp "$TMP_DIR/claude-json-XXXXXX")"

  claude -p \
    "${model_flag[@]}" \
    --output-format json \
    --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' 'WebSearch(*)' 'WebFetch(*)' \
    < "$prompt_file" > "$out_file" 2>>"$LOG_FILE"
  rc=$?
  record_claude_cost "$(basename "$prompt_file" .md)" "$out_file"
  cat "$out_file" >> "$LOG_FILE" 2>/dev/null || true
  rm -f "$out_file"
  return $rc
}

run_claude_prompt_with_timeout() {
  local prompt_file="$1"
  local timeout_seconds="$2"
  local model_arg="${3:-}"
  local pid elapsed out_file
  local model_flag=()
  [ -n "$model_arg" ] && model_flag=(--model "$model_arg")
  out_file="$(mktemp "$TMP_DIR/claude-json-XXXXXX")"

  claude -p \
    "${model_flag[@]}" \
    --output-format json \
    --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' 'WebSearch(*)' 'WebFetch(*)' \
    < "$prompt_file" > "$out_file" 2>>"$LOG_FILE" &
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

run_claude_structured_with_timeout() {
  local prompt_file="$1"
  local timeout_seconds="$2"
  local model_arg="$3"
  local schema_file="$4"
  local output_file="$5"
  local cost_name="$6"
  local pid elapsed rc raw_file schema_json
  raw_file="$(mktemp "$TMP_DIR/claude-json-XXXXXX")"
  schema_json="$(cat "$schema_file")"

  claude -p \
    --model "$model_arg" \
    --effort medium \
    --no-session-persistence \
    --disable-slash-commands \
    --system-prompt '你是台股盤後分類器。只讀指定輸入檔，嚴格依使用者 prompt 與 JSON Schema 回傳結果；不要搜尋、寫檔或延伸執行其他工作。' \
    --output-format json \
    --json-schema "$schema_json" \
    --tools Read \
    --allowedTools Read \
    < "$prompt_file" > "$raw_file" 2>>"$LOG_FILE" &
  pid="$!"
  elapsed=0

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      log "claude structured prompt timed out after ${timeout_seconds}s; killing pid $pid"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      sleep 2
      pkill -KILL -P "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      record_claude_cost "$cost_name" "$raw_file"
      cat "$raw_file" >> "$LOG_FILE" 2>/dev/null || true
      rm -f "$raw_file"
      return 124
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  wait "$pid"
  rc=$?
  record_claude_cost "$cost_name" "$raw_file"
  cat "$raw_file" >> "$LOG_FILE" 2>/dev/null || true
  if [ "$rc" -eq 0 ]; then
    node -e '
      const fs = require("fs");
      const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let value = raw.structured_output;
      if (!value && typeof raw.result === "string") value = JSON.parse(raw.result);
      if (!value) throw new Error("Claude structured output missing");
      fs.writeFileSync(process.argv[2], `${JSON.stringify(value, null, 2)}\n`);
    ' "$raw_file" "$output_file" >> "$LOG_FILE" 2>&1 || rc=$?
  fi
  rm -f "$raw_file"
  return $rc
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
run_tsx_eval() {
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

log "run-daily-report-claude.sh start"
log "START_STAGE=$START_STAGE"
log "CONTROLLER_MODEL=$CONTROLLER_MODEL CONTROLLER_SPLIT=$CONTROLLER_SPLIT CONTROLLER_TIMEOUT_SECONDS=$CONTROLLER_TIMEOUT_SECONDS FINALIZER_MODEL=$FINALIZER_MODEL INTL_MODEL=$INTL_MODEL"

if ! command -v claude >/dev/null 2>&1; then
  log "claude command not found"
  notify "每日股市報告 ❌" "找不到 claude 指令，請先安裝並登入。Log: $LOG_FILE"
  exit 1
fi

if stage_enabled fetch; then
  log "進度 1/5：開始抓上市/上櫃市場資料"
  if ! timed fetch-market run_tsx scripts/fetch-market-data.ts; then
    log "fetch-market-data.ts exited non-zero"
    notify "每日股市報告 ❌" "抓市場資料失敗，請看 log: $LOG_FILE"
    exit 1
  fi

  # 補齊 price-history 的缺口——**必須在任何用到均線/報酬的步驟之前**。
  # price-history 只由 score-report.ts 在「報告有跑」的那天寫入，漏跑一天那個交易日
  # 就永久空一格；下游把它當連續日 K 用（MA10/MA20/20日高/20日報酬），缺格會讓
  # 「20 根 K 棒」實際橫跨二十幾個交易日，均線與報酬率全部失真。
  # 已補過的日子有快取，平常這步幾乎不打 API，所以放前景同步跑不會拖慢。
  # 同一步也補融資與市場情緒序列，並列出補不回來的選股池日期（見 backfill-missed-days.ts）。
  # 必須在背景輔助資料之前同步跑完：fetch-margin-options 也會寫 margin-history.json。
  timed missed-days run_tsx scripts/backfill-missed-days.ts \
    || log "[warn] backfill-missed-days.ts failed; 均線與報酬率可能因缺格而失真"

  # 法說會判讀：簡報下載慢、影音轉文字有額度，可能跑上一小時，所以完全脫離主流程（不進 AUX_PIDS、
  # 不等它）。它每判讀完一場就更新 data/investor-conf.html，publish 當下跑到哪就發佈到哪，剩下的下次補。
  bash "$PROJECT_DIR/scripts/start-investor-conf.sh" | tee -a "$LOG_FILE" \
    || log "[warn] 法說會判讀背景啟動失敗；法說會子頁沿用上次結果"

  # 輔助資料：全部只依賴 market-latest.json（或完全獨立的外部來源），彼此之間沒有相依，
  # 所以整批背景平行丟出去，這裡不 wait，直接往下跑分類與 research。
  # 它們的產出只有 send-report 要用，等到那之前才收（見 AUX_PIDS）。
  # 每個都用 timed 包起來，事後看 timing 表就知道該優化誰。
  # 失敗一律只 warn：這些是加值分頁，不該擋住主流程。
  log "進度 1.2/5：背景平行抓輔助資料（指數貢獻／融資選擇權／集保／國際／信用利差／RRG／設質+CB／KOL）"

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

  # RRG：抓 245 檔 Yahoo，實測 ~6m30s，是這批裡最慢的。
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

  # 法人目標價：鉅亨 FactSet 共識速報＋個別券商新聞，算跟收盤的空間，每天累積進
  # data/target-price-history/。純規則、只打新聞列表 API，幾十個請求。
  timed target-price run_tsx scripts/fetch-target-prices.ts \
    || log "[warn] fetch-target-prices.ts failed; 目標價子頁沿用上次結果" &
  AUX_PIDS="$AUX_PIDS $!"

  # 季報毛利率：季更，同一季抓過就 skip，平常這步是空轉。
  # 財報有兩個半月的公布時滯，所以就算天天跑，內容一季才會變一次。
  timed financials run_tsx scripts/fetch-quarterly-financials.ts \
    || log "[warn] fetch-quarterly-financials.ts failed; 毛利率欄位沿用上次結果" &
  AUX_PIDS="$AUX_PIDS $!"

  # 月營收：月更。fetch 每天重抓最近 3 個月（公司陸續補報、也會更正），只有 6 個請求。
  # momentum 會自己往回退到「已公布完」的月份，所以 1~10 號跑也不會拿半份資料排名。
  (
    timed revenue-fetch run_tsx scripts/fetch-monthly-revenue.ts \
      || log "[warn] fetch-monthly-revenue.ts failed; 月營收動能沿用上次結果"
    timed revenue-momentum run_tsx scripts/build-revenue-momentum.ts \
      || log "[warn] build-revenue-momentum.ts failed; 月營收動能沿用上次結果"
    timed revenue-decline run_tsx scripts/build-revenue-decline.ts \
      || log "[warn] build-revenue-decline.ts failed; 營收衰退名單沿用上次結果"
    timed revenue-industry run_tsx scripts/build-revenue-industry.ts \
      || log "[warn] build-revenue-industry.ts failed; 營收族群沿用上次結果"
  ) &
  AUX_PIDS="$AUX_PIDS $!"

  # 財經 KOL：抓 Podcast/YouTube 新節目（含字幕）→ worker 整理重點。整段跟主流程無關，
  # 背景跑、send 前才收；送信前由 attach-kol 併進 analysis。失敗只是沒有 KOL 分頁。
  (
    rm -f "$TMP_DIR/kol-items.json" "$TMP_DIR/kol-brief.json"
    timed kol-fetch run_tsx scripts/fetch-kol-feeds.ts \
      || log "[warn] fetch-kol-feeds.ts failed; KOL 分頁略過"
    if [ -f "$TMP_DIR/kol-items.json" ]; then
      timed kol-brief run_claude_prompt_with_timeout "$KOL_PROMPT" 600 "$KOL_MODEL" \
        || log "[warn] KOL worker 非零退出；KOL 分頁可能略過"
    fi
  ) &
  AUX_PIDS="$AUX_PIDS $!"
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
  timed score-report run_tsx scripts/score-report.ts || log "[warn] score-report.ts failed; continuing"
  timed classify-input run_tsx scripts/build-codex-classify-input.ts || {
    log "build-codex-classify-input.ts exited non-zero"
    exit 1
  }
fi

if stage_enabled classify; then
  log "進度 2/5：開始做全部分類與族群 task"

  if [ "$CONTROLLER_SPLIT" = "batch" ] && task_dir_is_fresh "$TASK_DIR"; then
    log "進度 2/5：偵測到今天的 task 檔還在（上次可能中斷），保留下來，只補跑沒完成的批次"
  else
    clear_dir_json "$TASK_DIR"
    clear_dir_json "$TASK_SNAPSHOT_DIR"
    clear_dir_json "$RESULT_DIR"
    rm -rf "$TMP_DIR/controller-batches" "$TMP_DIR/controller-batch-defs"
  fi

  log "進度 2/6：執行分類 controller (SPLIT=$CONTROLLER_SPLIT)"
  if [ "$CONTROLLER_SPLIT" = "structured" ]; then
    GAINER_PROMPT="$(mktemp /tmp/controller-gainer-XXXXXX)"
    LOSER_PROMPT="$(mktemp /tmp/controller-loser-XXXXXX)"
    GAINER_OUTPUT="$TMP_DIR/controller-gainer.json"
    LOSER_OUTPUT="$TMP_DIR/controller-loser.json"
    rm -f "$GAINER_OUTPUT" "$LOSER_OUTPUT"
    cat "$STRUCTURED_CONTROLLER_PROMPT" > "$GAINER_PROMPT"
    printf '\n\n本次只處理 direction=gainer，只使用輸入的 gainers；JSON 的 direction 固定為 gainer。\n' >> "$GAINER_PROMPT"
    cat "$STRUCTURED_CONTROLLER_PROMPT" > "$LOSER_PROMPT"
    printf '\n\n本次只處理 direction=loser，只使用輸入的 losers；JSON 的 direction 固定為 loser。\n' >> "$LOSER_PROMPT"

    timed controller-gainer run_claude_structured_with_timeout "$GAINER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_MODEL" "$CONTROLLER_SCHEMA" "$GAINER_OUTPUT" controller-gainer &
    GAINER_PID="$!"
    timed controller-loser run_claude_structured_with_timeout "$LOSER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_MODEL" "$CONTROLLER_SCHEMA" "$LOSER_OUTPUT" controller-loser &
    LOSER_PID="$!"

    wait "$GAINER_PID" || log "gainer controller exited non-zero"
    wait "$LOSER_PID" || log "loser controller exited non-zero"
    rm -f "$GAINER_PROMPT" "$LOSER_PROMPT"
    [ -f "$GAINER_OUTPUT" ] && run_tsx scripts/split-codex-controller-output.ts "$GAINER_OUTPUT" "$TASK_DIR" gainer
    [ -f "$LOSER_OUTPUT" ] && run_tsx scripts/split-codex-controller-output.ts "$LOSER_OUTPUT" "$TASK_DIR" loser
  elif [ "$CONTROLLER_SPLIT" = "batch" ]; then
    CLAUDE_REPORT_TASK_DIR="$TASK_DIR" CLAUDE_CONTROLLER_MODEL="$CONTROLLER_MODEL" CLAUDE_REPORT_LOG_FILE="$LOG_FILE" \
      timed controller-batches bash "$CONTROLLER_BATCH_RUNNER" > >(tee -a "$LOG_FILE") 2>&1
    if [ "$?" -ne 0 ]; then
      log "controller batch runner exited non-zero"
    fi

    # 分批跑完後做覆蓋率檢查：任何批次失敗或 timeout 放棄，都會留下沒被分類到的股票，
    # 這裡直接用 deterministic 規則把漏網的補進去，不用整批重跑。
    MISSING_CODES="$(node -e '
      const fs = require("fs"); const path = require("path");
      const market = JSON.parse(fs.readFileSync("data/market-latest.json", "utf8"));
      const dir = process.argv[1];
      const covered = new Set();
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!f.endsWith(".json")) continue;
        try {
          const task = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          for (const m of task.members || []) covered.add(m.code);
        } catch (e) {}
      }
      const all = [...(market.gainers || []), ...(market.losers || [])];
      process.stdout.write(all.filter((s) => !covered.has(s.code)).map((s) => s.code).join(","));
    ' "$TASK_DIR" 2>/dev/null)"
    if [ -n "$MISSING_CODES" ]; then
      MISSING_COUNT="$(printf '%s' "$MISSING_CODES" | tr ',' '\n' | grep -c .)"
      log "[warn] 分類覆蓋率檢查：$MISSING_COUNT 檔沒被任何批次分類到，用 deterministic 規則補上"
      run_tsx scripts/generate-group-tasks-fallback.ts "$TASK_DIR" "$MISSING_CODES" || log "[warn] 補漏 fallback 失敗"
    fi
  elif [ "$CONTROLLER_SPLIT" = "1" ]; then
    # ⚠️ macOS 的 mktemp 只在「XXXXXX 是檔名最後一段」時才會替換成隨機字元；
    # 只要後面接副檔名（.md），它會把整個字串當成字面路徑直接嘗試建立，完全不隨機化。
    # 這代表每次都是同一個檔名——只要 /tmp 裡曾經留過這個檔（上一輪殘留、或另一個
    # process 同時在跑），mktemp 就會回報 "File exists" 而整段指令替換成空字串，
    # 下面的 GAINER_PROMPT/LOSER_PROMPT 變空、claude 讀到空 prompt，幾秒內就 rc=1 收場，
    # 表面看起來像額度問題，其實是這裡。不要加副檔名，讓 X 留在檔名最後。
    GAINER_PROMPT="$(mktemp /tmp/controller-gainer-XXXXXX)"
    LOSER_PROMPT="$(mktemp /tmp/controller-loser-XXXXXX)"
    cat "$CONTROLLER_PROMPT" > "$GAINER_PROMPT"
    printf '\n\n## 本次執行範圍限制\n只處理 direction=gainer（強勢 100 檔），只輸出 gainer task 檔，檔名以 gainer 為主。完全不要處理 losers。不要清空 data/tmp/group-tasks/ 目錄（runner 已先清空，且此刻有另一個 process 正在同目錄切 loser task）。漏股檢查只需確認強勢 100 檔各出現一次。\n' >> "$GAINER_PROMPT"
    cat "$CONTROLLER_PROMPT" > "$LOSER_PROMPT"
    printf '\n\n## 本次執行範圍限制\n只處理 direction=loser（弱勢 100 檔），只輸出 loser task 檔，檔名以 loser 為主。完全不要處理 gainers。不要清空 data/tmp/group-tasks/ 目錄（runner 已先清空，且此刻有另一個 process 正在同目錄切 gainer task）。漏股檢查只需確認弱勢 100 檔各出現一次。\n' >> "$LOSER_PROMPT"

    timed controller-gainer run_claude_prompt_with_timeout "$GAINER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_MODEL" &
    GAINER_PID="$!"
    timed controller-loser run_claude_prompt_with_timeout "$LOSER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_MODEL" &
    LOSER_PID="$!"

    wait "$GAINER_PID" || log "gainer controller exited non-zero"
    wait "$LOSER_PID" || log "loser controller exited non-zero"

    rm -f "$GAINER_PROMPT" "$LOSER_PROMPT"
  else
    if ! timed controller run_claude_prompt_with_timeout "$CONTROLLER_PROMPT" "$CONTROLLER_TIMEOUT_SECONDS" "$CONTROLLER_MODEL"; then
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

  # ⚠️ 這裡故意不清 RESULT_DIR。classify 階段（line ~404）已經清過一次；
  # 如果是額度用盡中斷後用 CLAUDE_REPORT_START_STAGE=research 重跑，
  # 已經成功的族群結果要留著給下面的 run-claude-group-workers.sh 跳過，
  # 不然每次中斷都要把已經花錢做完的族群全部重做一遍。

  # 國際情勢 worker：與台股族群 research 同時平行跑，幾乎不增加整體 wall-clock。
  rm -f "$PROJECT_DIR/data/tmp/intl-brief.txt" "$PROJECT_DIR/data/tmp/intl-events.json"
  log "進度 3/5：背景平行啟動國際情勢 worker (model=$INTL_MODEL)"
  INTL_OUT_FILE="$(mktemp "$TMP_DIR/claude-json-intl-XXXXXX")"
  claude -p --model "$INTL_MODEL" \
    --output-format json \
    --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' 'WebSearch(*)' 'WebFetch(*)' \
    < "$INTL_PROMPT" > "$INTL_OUT_FILE" 2>>"$LOG_FILE" &
  INTL_PID="$!"

  log "進度 3/5：開始做各分類/族群的個別研究報告"
  if ! timed research-workers env CLAUDE_REPORT_TASK_DIR="$TASK_SNAPSHOT_DIR" CLAUDE_REPORT_RESULT_DIR="$RESULT_DIR" bash "$WORKER_RUNNER" "${CLAUDE_REPORT_MAX_CONCURRENCY:-10}" > >(tee -a "$LOG_FILE") 2>&1; then
    log "parallel workers exited non-zero; continuing with fallback stories where needed"
  fi

  RESULT_COUNT="$(count_json_files "$RESULT_DIR")"
  log "進度 3/5：個別研究報告完成，產出 $RESULT_COUNT 個 result 檔"

  # 等國際 worker 收尾（通常已隨族群 research 一起跑完）
  if ! wait "$INTL_PID"; then
    log "[warn] 國際情勢 worker 非零退出；intl-brief 可能沒寫出來，attach-intl 會自動略過"
  fi
  record_claude_cost "intl-brief" "$INTL_OUT_FILE"
  cat "$INTL_OUT_FILE" >> "$LOG_FILE" 2>/dev/null || true
  rm -f "$INTL_OUT_FILE"
  if [ -f "$PROJECT_DIR/data/tmp/intl-brief.txt" ]; then
    log "進度 3/5：國際情勢 worker 完成，已寫出 intl-brief.txt"
  else
    log "[warn] 國際情勢 worker 沒寫出 intl-brief.txt；報告國際區塊將只有數字表"
  fi
  if [ -f "$PROJECT_DIR/data/tmp/intl-events.json" ]; then
    log "進度 3/5：國際大事時間軸已寫出 intl-events.json"
  else
    log "[warn] 國際情勢 worker 沒寫出 intl-events.json；報告國際區塊將沒有大事時間軸"
  fi
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
  if ! timed finalizer run_claude_prompt "$FINALIZER_PROMPT" "$FINALIZER_MODEL"; then
    log "finalizer exited non-zero"
  fi

  if [ ! -f "$PROJECT_DIR/data/analysis-latest.json" ]; then
    log "analysis-latest.json missing after finalizer"
    notify "每日股市報告 ❌" "分析結果檔沒有產出，請看 log: $LOG_FILE"
    exit 1
  fi

  # ⚠️ finalizer 失敗時 analysis-latest.json 不會消失——**前一天的那份還躺在原地**，
  # 上面的 -f 檢查照樣通過，於是舊分析會一路流到 send-report 被當成今天的報告寄出去。
  # 2026-09-08 就是這樣把 9/04 的分析發上線的（額度用盡 → 全部 worker 失敗 → finalizer rc=1）。
  # skeleton 是機械合併的，不需要 LLM，日期一定是對的，而且每個族群都有 story
  # （worker 成功的用 worker 版，失敗的用 preliminaryStory）。日期對不上就改用它。
  SKELETON_FILE="$PROJECT_DIR/data/tmp/analysis-skeleton.json"
  if [ -f "$SKELETON_FILE" ]; then
    _skel_date="$(run_tsx_eval "$SKELETON_FILE" 2>/dev/null || true)"
    _anal_date="$(run_tsx_eval "$PROJECT_DIR/data/analysis-latest.json" 2>/dev/null || true)"
    if [ -n "$_skel_date" ] && [ "$_skel_date" != "$_anal_date" ]; then
      log "[warn] analysis-latest.json 日期 $_anal_date 與 skeleton $_skel_date 不符（finalizer 應該失敗了）；改用 skeleton，敘事為規則化 fallback"
      cp "$SKELETON_FILE" "$PROJECT_DIR/data/analysis-latest.json"
    fi
  fi
  # 與 Codex runner 一致：族群資料不完整就不發布
  if ! timed analysis-completeness run_tsx scripts/validate-analysis-completeness.ts \
    "$PROJECT_DIR/data/analysis-latest.json" "$SKELETON_FILE" "$PROJECT_DIR/data/market-latest.json"; then
    log "analysis completeness validation failed; refusing to generate or publish an incomplete report"
    notify "每日股市報告 ❌" "上漲／下跌族群資料不完整，已停止發布。Log: $LOG_FILE"
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
  # 到這裡才收輔助資料。正常情況它們早在 research 那 15 分鐘裡跑完了，這個 wait 是零成本；
  # 只有在 research 異常快時才會真的等。
  if [ -n "$AUX_PIDS" ]; then
    log "進度 4.5/5：等背景輔助資料收尾"
    for _p in $AUX_PIDS; do wait "$_p" 2>/dev/null || true; done
    log "進度 4.5/5：輔助資料全部結束"
  fi
  run_tsx scripts/attach-kol.ts || log "[warn] attach-kol.ts failed; 報告將沒有 KOL 分頁"

  # 選股池吃 analysis + scorecard + RRG + 設質CB，必須排在它們全部產出之後、送信之前。
  timed stock-picks run_tsx scripts/build-stock-picks.ts \
    || log "[warn] build-stock-picks.ts failed; 終極選股池分頁略過，不影響其他區塊"
  # 前 5 名前瞻追蹤（docs/wide-market-scan-conclusion.md）：只更新 data/stock-picks-backtest.json，失敗不影響報告
  timed picks-tracking run_tsx scripts/backtest-stock-picks.ts --quiet \
    || log "[warn] backtest-stock-picks.ts failed; 前 5 名追蹤略過"

  log "進度 5/5：開始產生 HTML 並寄送報告"
  # REPORT_DRY_RUN=1：只產 HTML 預覽，不寄信也不部署。驗證 prompt / 評分規則改動時用，
  # 避免把還沒比對過的報告直接送進信箱與 GitHub Pages。
  # 這裡不能只靠外面 unset GAS_WEBHOOK_URL：上面的 .env.local 是 set -a source，會蓋回來。
  # 2026-09-14 起使用者要求不再寄信，一律只產 HTML 給 publish 用。
  if ! timed send-report run_tsx scripts/send-report.ts data/analysis-latest.json --no-email; then
    log "send-report.ts --no-email exited non-zero"
    notify "每日股市報告 ❌" "報告產出成功，但 HTML 預覽失敗。Log: $LOG_FILE"
    exit 1
  fi
  log "進度 5/5：已產生 HTML 預覽（不寄信）"
fi

if stage_enabled publish && [ "${REPORT_DRY_RUN:-0}" != "1" ]; then
  log "進度 6/6：部署到 GitHub Pages"
  if ! timed publish bash "$PROJECT_DIR/scripts/publish-github-pages.sh" > >(tee -a "$LOG_FILE") 2>&1; then
    log "[warn] publish-github-pages.sh 失敗（不中斷整體流程）"
  fi
fi

timing_summary
cost_summary
log "Done"
notify "每日股市報告 ✅" "Claude Code 平行 research 已完成並產出報告"
