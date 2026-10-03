#!/bin/bash
set -u

# 把「分類 controller」從 2 個大 call（強勢一次、弱勢一次）拆成一批批小 call，
# 每批只分類一小群股票。目的是中斷重跑（額度用盡等）時，已經跑完的批次不用重做——
# 跟 run-claude-group-workers.sh 對族群 worker 做的事是同一個道理，只是搬到分類這一步。
#
# 每批各自寫出 task 檔到 group-tasks/，彼此可能用到同樣的 category 名稱（例如兩批都
# 切出「AI伺服器/HDI高階PCB」），這是預期內的——下一步 refine-group-tasks.ts 本來就會
# 讀目錄裡「所有」task 檔、依 category 重新彙整成單一份，天生就會把它們合併回去。

_nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${_nvm_bin:+$_nvm_bin:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

TMP_DIR="$PROJECT_DIR/data/tmp"
TASK_DIR="${CLAUDE_REPORT_TASK_DIR:-$TMP_DIR/group-tasks}"
CONTROLLER_PROMPT="$PROJECT_DIR/scripts/prompts/group-task-controller.md"
MODEL="${CLAUDE_CONTROLLER_MODEL:-sonnet}"
BATCH_SIZE="${CLAUDE_CONTROLLER_BATCH_SIZE:-25}"
MAX_CONCURRENCY="${CLAUDE_CONTROLLER_BATCH_CONCURRENCY:-4}"
BATCH_TIMEOUT_SECONDS="${CLAUDE_REPORT_CONTROLLER_BATCH_TIMEOUT_SECONDS:-420}"
BATCH_MAX_ATTEMPTS="${CLAUDE_REPORT_CONTROLLER_BATCH_MAX_ATTEMPTS:-2}"
STATE_DIR="$TMP_DIR/controller-batches"
DEF_DIR="$TMP_DIR/controller-batch-defs"
COST_FILE="$TMP_DIR/costs.tsv"
LOG_FILE="${CLAUDE_REPORT_LOG_FILE:-/dev/stdout}"

mkdir -p "$TASK_DIR" "$STATE_DIR" "$DEF_DIR"
rm -f "$DEF_DIR"/*.json 2>/dev/null || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ ! -f "$PROJECT_DIR/data/market-latest.json" ]; then
  echo "market-latest.json missing" >&2
  exit 1
fi

# 把 gainers/losers 各切成一批批，每批寫一個定義檔到 DEF_DIR。
node -e '
const fs = require("fs");
const path = require("path");
const batchSize = parseInt(process.argv[1], 10);
const defDir = process.argv[2];
const market = JSON.parse(fs.readFileSync("data/market-latest.json", "utf8"));

function writeBatches(direction, stocks) {
  const chunks = [];
  for (let i = 0; i < stocks.length; i += batchSize) chunks.push(stocks.slice(i, i + batchSize));
  chunks.forEach((stocks, idx) => {
    const batchId = `${direction}-${idx + 1}`;
    fs.writeFileSync(
      path.join(defDir, `${batchId}.json`),
      JSON.stringify({
        tradingDate: market.tradingDate,
        timestamp: market.timestamp,
        direction,
        batchId,
        batchIndex: idx + 1,
        totalBatches: chunks.length,
        stocks,
      }, null, 2),
    );
  });
}

writeBatches("gainer", market.gainers || []);
writeBatches("loser", market.losers || []);
' "$BATCH_SIZE" "$DEF_DIR"

BATCH_FILES=()
while IFS= read -r f; do BATCH_FILES+=("$f"); done < <(find "$DEF_DIR" -type f -name '*.json' | sort)

if [ "${#BATCH_FILES[@]}" -eq 0 ]; then
  echo "No batches generated" >&2
  exit 1
fi

log "進度 2/6：分類切成 ${#BATCH_FILES[@]} 批（每批最多 $BATCH_SIZE 檔）"

record_cost() {
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

run_batch() {
  local def_file="$1"
  local batch_id trading_date done_marker
  batch_id="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).batchId)' "$def_file")"
  trading_date="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tradingDate)' "$def_file")"
  done_marker="$STATE_DIR/${trading_date}_${batch_id}.done"

  if [ -f "$done_marker" ]; then
    log "進度 2/6：批次 $batch_id 已完成，跳過（沿用上次成功結果）"
    return 0
  fi

  local prompt_file scope_json
  prompt_file="$(mktemp "$TMP_DIR/controller-batch-prompt-XXXXXX")"
  scope_json="$(cat "$def_file")"

  cat "$CONTROLLER_PROMPT" > "$prompt_file"
  {
    printf '\n\n## 本次批次限制（覆蓋上面「Step 1 讀取 market-latest.json」與「產出前檢查 100 檔」的規則）\n'
    printf '這是分批執行的其中一批，不要去讀 data/market-latest.json 的完整清單，也不要處理下面清單以外的股票，\n'
    printf '不要清空 data/tmp/group-tasks/ 目錄（runner 已處理，且此刻可能有其他批次在同目錄寫入）。\n'
    printf '完成後只需要驗證下面這份清單裡的股票是否都出現在你寫出的 task 檔中，不用管完整 100 檔的覆蓋率。\n\n'
    printf '```json\n%s\n```\n' "$scope_json"
  } >> "$prompt_file"

  local attempt=1 exit_code=0
  while [ "$attempt" -le "$BATCH_MAX_ATTEMPTS" ]; do
    local out_file pid elapsed
    out_file="$(mktemp "$TMP_DIR/claude-json-XXXXXX")"
    log "進度 2/6：批次 $batch_id attempt ${attempt}/${BATCH_MAX_ATTEMPTS}"

    claude -p \
      --model "$MODEL" \
      --output-format json \
      --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' 'WebSearch(*)' 'WebFetch(*)' \
      < "$prompt_file" > "$out_file" 2>>"$LOG_FILE" &
    pid="$!"
    elapsed=0

    while kill -0 "$pid" 2>/dev/null; do
      if [ "$elapsed" -ge "$BATCH_TIMEOUT_SECONDS" ]; then
        log "進度 2/6：批次 $batch_id 超過 ${BATCH_TIMEOUT_SECONDS}s，終止並準備重試"
        pkill -TERM -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
        sleep 2
        pkill -KILL -P "$pid" 2>/dev/null || true
        kill -9 "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        exit_code=124
        break
      fi
      sleep 2
      elapsed=$((elapsed + 2))
    done

    if [ "$exit_code" -ne 124 ]; then
      wait "$pid"
      exit_code=$?
    fi

    record_cost "controller-batch:$batch_id" "$out_file"
    rm -f "$out_file"

    if [ "$exit_code" -eq 0 ]; then
      touch "$done_marker"
      rm -f "$prompt_file"
      log "進度 2/6：批次 $batch_id 完成"
      return 0
    fi

    exit_code=0
    attempt=$((attempt + 1))
  done

  rm -f "$prompt_file"
  log "進度 2/6：批次 $batch_id 失敗或 timeout 已達上限，放棄（後面會用 deterministic 補漏）"
  return 1
}

declare -a running_pids=()
FAILED_BATCHES=0

compact_running_pids() {
  local next_pids=() pid
  for pid in "${running_pids[@]-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      next_pids+=("$pid")
    fi
  done
  running_pids=("${next_pids[@]-}")
}

for def_file in "${BATCH_FILES[@]}"; do
  compact_running_pids
  while [ "${#running_pids[@]}" -ge "$MAX_CONCURRENCY" ]; do
    sleep 2
    compact_running_pids
  done
  run_batch "$def_file" &
  running_pids+=("$!")
done

for pid in "${running_pids[@]-}"; do
  wait "$pid" || FAILED_BATCHES=$((FAILED_BATCHES + 1))
done

log "進度 2/6：所有批次已結束（失敗 $FAILED_BATCHES 批，下一步 refine 前會做覆蓋率檢查補漏）"
exit 0
