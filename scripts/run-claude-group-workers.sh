#!/bin/bash
set -euo pipefail

# launchd 給的 PATH 很精簡，這裡補回 node / claude / codex 的常見安裝位置。
# 不寫死家目錄與 node 版本：換一台機器後路徑就不存在，整條流程會在第一步找不到 node。
_nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${_nvm_bin:+$_nvm_bin:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TASK_DIR="${CLAUDE_REPORT_TASK_DIR:-$PROJECT_DIR/data/tmp/group-tasks}"
RESULT_DIR="${CLAUDE_REPORT_RESULT_DIR:-$PROJECT_DIR/data/tmp/group-results}"
PROMPT_DIR="$PROJECT_DIR/scripts/prompts"
WORKER_TEMPLATE="$PROMPT_DIR/group-research-worker.md"
MAX_CONCURRENCY="${1:-4}"
POLL_INTERVAL="${CLAUDE_REPORT_POLL_INTERVAL:-1}"
WORKER_TIMEOUT_SECONDS="${CLAUDE_REPORT_WORKER_TIMEOUT_SECONDS:-180}"
WORKER_MAX_ATTEMPTS="${CLAUDE_REPORT_WORKER_MAX_ATTEMPTS:-2}"
# 族群故事屬輕量研究工作，預設用小模型省 token；可用環境變數覆寫
WORKER_MODEL="${CLAUDE_GROUP_WORKER_MODEL:-haiku}"
TMP_DIR="$PROJECT_DIR/data/tmp"
COST_FILE="$TMP_DIR/costs.tsv"

# 每個 worker 各自的輸出寫到自己專屬的暫存檔（mktemp 不加副檔名，
# macOS mktemp 只在 X 是檔名最後一段時才會隨機化，見 run-daily-report-claude.sh 的說明），
# 彼此互不干擾，所以就算 66 個平行跑也能各自安全記自己的花費。
record_worker_cost() {
  local name="$1" json_file="$2" cost
  cost="$(node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(j.total_cost_usd || 0));
    } catch (e) { process.stdout.write("0"); }
  ' "$json_file" 2>/dev/null || echo 0)"
  [ -z "$cost" ] && cost="0"
  printf '%s\t%s\n' "$name" "$cost" >> "$COST_FILE"
  echo "進度 3/5：${name} cost \$${cost}"
}

cd "$PROJECT_DIR" || exit 1

mkdir -p "$RESULT_DIR"

if [ ! -d "$TASK_DIR" ]; then
  echo "Task dir missing: $TASK_DIR" >&2
  exit 1
fi

if [ ! -f "$WORKER_TEMPLATE" ]; then
  echo "Worker template missing: $WORKER_TEMPLATE" >&2
  exit 1
fi

TASK_FILES=()
while IFS= read -r task_file; do
  TASK_FILES+=("$task_file")
done < <(find "$TASK_DIR" -type f -name '*.json' | sort)

if [ "${#TASK_FILES[@]}" -eq 0 ]; then
  echo "No task files found in $TASK_DIR" >&2
  exit 1
fi

FILTERED_TASKS_JSON="$(node - <<'NODE' "${TASK_FILES[@]}"
const fs = require('fs');

const files = process.argv.slice(2);
const tasks = files.map((file, index) => {
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  const memberCount = Array.isArray(task.members) ? task.members.length : 0;
  return {
    file,
    index,
    direction: task.direction,
    category: task.category || '未命名族群',
    memberCount,
    retreatSignal: task.retreatSignal === true,
  };
});

// 上漲、下跌都一樣：族群要有 3 檔以上成分股才值得花一次 worker 去查故事，
// 少於 3 檔的當個股事件看，直接用 controller 寫的 preliminaryStory，不個別深挖。
// retreatSignal（族群退潮）不受這條限制，人數再少也要查。
const MIN_MEMBERS_FOR_WORKER = 3;
const selected = tasks
  .filter((task) => task.memberCount >= MIN_MEMBERS_FOR_WORKER || task.retreatSignal === true)
  .map((task) => ({
    file: task.file,
    direction: task.direction,
    category: task.category,
    memberCount: task.memberCount,
    retreatSignal: task.retreatSignal,
  }));

process.stdout.write(JSON.stringify({
  selected,
  skipped: tasks
    .filter((task) => task.memberCount < MIN_MEMBERS_FOR_WORKER && task.retreatSignal !== true)
    .map((task) => ({ file: task.file, direction: task.direction, category: task.category, memberCount: task.memberCount })),
}));
NODE
)"

SELECTED_TASK_FILES=()
while IFS= read -r selected_file; do
  [ -n "$selected_file" ] && SELECTED_TASK_FILES+=("$selected_file")
done < <(printf '%s' "$FILTERED_TASKS_JSON" | node -e 'const input = JSON.parse(require("fs").readFileSync(0, "utf8")); for (const task of input.selected) console.log(task.file);')

if [ "${#SELECTED_TASK_FILES[@]}" -eq 0 ]; then
  echo "No eligible task files found in $TASK_DIR" >&2
  exit 1
fi

printf '%s' "$FILTERED_TASKS_JSON" | node -e '
const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (input.skipped.length > 0) {
  console.log("進度 3/5：以下族群不到 3 檔，不做個別 worker，沿用 controller 寫的 preliminaryStory：");
  for (const item of input.skipped) {
    const dir = item.direction === "gainer" ? "強勢" : "弱勢";
    console.log(`- [${dir}] ${item.category} (${item.memberCount} 檔): ${item.file}`);
  }
}
'

task_progress_label() {
  local task_file="$1"
  node -e 'const fs = require("fs"); const task = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const direction = task.direction === "gainer" ? "強勢" : task.direction === "loser" ? "弱勢" : task.direction; const category = task.category || "未命名族群"; const memberCount = Array.isArray(task.members) ? task.members.length : 0; process.stdout.write(`${direction} / ${category} / ${memberCount} 檔`);' "$task_file"
}

run_worker() {
  local task_file="$1"
  local base_name task_json prompt_file result_file
  base_name="$(basename "$task_file" .json)"
  result_file="$RESULT_DIR/${base_name}.json"

  # 中斷重跑（額度用盡等）時，已經成功寫出結果的族群不要再花錢重做一次。
  # 只信任有效 JSON，半途被砍掉留下的殘檔會被判定無效、照樣重跑。
  if [ -s "$result_file" ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$result_file" 2>/dev/null; then
    echo "進度 3/5：${base_name} 已有結果，跳過（沿用上次成功的結果，省 token）"
    return 0
  fi

  task_json="$(cat "$task_file")"
  prompt_file="$(mktemp)"

  cat "$WORKER_TEMPLATE" > "$prompt_file"
  {
    echo
    echo "Task file: $task_file"
    echo "請將結果寫入：data/tmp/group-results/${base_name}.json"
    echo
    echo '```json'
    echo "$task_json"
    echo '```'
  } >> "$prompt_file"

  local attempt exit_code pid elapsed out_file
  attempt=1
  while [ "$attempt" -le "$WORKER_MAX_ATTEMPTS" ]; do
    exit_code=0
    out_file="$(mktemp "$TMP_DIR/claude-json-XXXXXX")"
    echo "進度 3/5：${base_name} worker attempt ${attempt}/${WORKER_MAX_ATTEMPTS}，timeout ${WORKER_TIMEOUT_SECONDS}s"
    claude -p \
      --model "$WORKER_MODEL" \
      --output-format json \
      --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)' 'WebSearch(*)' 'WebFetch(*)' \
      < "$prompt_file" > "$out_file" &
    pid="$!"
    elapsed=0

    while kill -0 "$pid" 2>/dev/null; do
      if [ "$elapsed" -ge "$WORKER_TIMEOUT_SECONDS" ]; then
        echo "進度 3/5：${base_name} worker attempt ${attempt} 超過 ${WORKER_TIMEOUT_SECONDS}s，終止並準備重試/跳過"
        pkill -TERM -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
        sleep 2
        pkill -KILL -P "$pid" 2>/dev/null || true
        kill -9 "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        exit_code=124
        break
      fi
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
    done

    if kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || exit_code="$?"
    elif [ "${exit_code:-0}" -ne 124 ]; then
      wait "$pid" || exit_code="$?"
      exit_code="${exit_code:-0}"
    fi

    record_worker_cost "$base_name" "$out_file"
    rm -f "$out_file"

    if [ "$exit_code" -eq 0 ]; then
      rm -f "$prompt_file"
      return 0
    fi

    attempt=$((attempt + 1))
  done

  echo "進度 3/5：${base_name} worker 失敗或 timeout 已達上限，跳過；finalizer 會使用 task preliminaryStory fallback"
  rm -f "$prompt_file"
  return 0
}

declare -a running_pids=()

compact_running_pids() {
  local next_pids=()
  local pid
  for pid in "${running_pids[@]-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      next_pids+=("$pid")
    fi
  done
  running_pids=("${next_pids[@]-}")
}

TOTAL_SELECTED="${#SELECTED_TASK_FILES[@]}"
TASK_INDEX=0

for task_file in "${SELECTED_TASK_FILES[@]}"; do
  TASK_INDEX=$((TASK_INDEX + 1))
  compact_running_pids
  while [ "${#running_pids[@]}" -ge "$MAX_CONCURRENCY" ]; do
    sleep "$POLL_INTERVAL"
    compact_running_pids
  done

  echo "進度 3/5：開始第 ${TASK_INDEX}/${TOTAL_SELECTED} 個族群個別報告：$(task_progress_label "$task_file")"
  run_worker "$task_file" &
  running_pids+=("$!")
done

for pid in "${running_pids[@]-}"; do
  wait "$pid"
done

echo "進度 3/5：所有已派發的族群 worker 已結束"

# costs.tsv 是整條 pipeline 共用檔（controller/finalizer/intl 也會寫進去），
# 這裡只加總「族群 worker」自己那些行——它們的 name 固定是 task 檔名
# （例如 01-gainer-xxx），用開頭數字-方向 這個格式跟其他階段的名字區分開。
STAGE_COST="$(node -e '
  const fs = require("fs");
  if (!fs.existsSync(process.argv[1])) { console.log("0"); process.exit(0); }
  const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
  const isWorkerRow = (name) => /^\d+-(gainer|loser)-/.test(name);
  const total = rows
    .filter((l) => isWorkerRow(l.split("\t")[0]))
    .reduce((s, l) => s + (+l.split("\t")[1] || 0), 0);
  console.log(total.toFixed(4));
' "$COST_FILE" 2>/dev/null || echo 0)"
echo "進度 3/5：本階段（所有族群 worker）累計花費 \$${STAGE_COST}"
