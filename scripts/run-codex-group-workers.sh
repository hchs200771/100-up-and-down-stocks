#!/bin/bash
set -euo pipefail

# launchd 給的 PATH 很精簡，這裡補回 node / claude / codex 的常見安裝位置。
# 不寫死家目錄與 node 版本：換一台機器後路徑就不存在，整條流程會在第一步找不到 node。
_nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${_nvm_bin:+$_nvm_bin:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TASK_DIR="${CODEX_GROUP_TASK_DIR:-$PROJECT_DIR/data/tmp/group-tasks}"
RESULT_DIR="${CODEX_GROUP_RESULT_DIR:-$PROJECT_DIR/data/tmp/group-results}"
PROMPT_DIR="$PROJECT_DIR/scripts/prompts"
WORKER_TEMPLATE="$PROMPT_DIR/group-research-worker-codex.md"
RESULT_SCHEMA="$PROJECT_DIR/scripts/schemas/codex-group-research.schema.json"
MODEL="${CODEX_GROUP_WORKER_MODEL:-gpt-5.6-luna}"
REASONING_EFFORT="${CODEX_GROUP_WORKER_REASONING_EFFORT:-low}"
MAX_WORKERS="${CODEX_GROUP_MAX_WORKERS:-30}"
MAX_CONCURRENCY="${1:-6}"
POLL_INTERVAL="${CODEX_GROUP_POLL_INTERVAL:-1}"
WORKER_TIMEOUT_SECONDS="${CODEX_GROUP_WORKER_TIMEOUT_SECONDS:-180}"
WORKER_MAX_ATTEMPTS="${CODEX_GROUP_WORKER_MAX_ATTEMPTS:-2}"

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

FILTERED_TASKS_JSON="$(node - "$MAX_WORKERS" "${TASK_FILES[@]}" <<'NODE'
const fs = require('fs');

const maxWorkers = Math.max(1, Number(process.argv[2]) || 30);
const files = process.argv.slice(3);
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
    avgPct: Math.abs(Number(task.stageSignals?.groupAvgPct) || 0),
  };
});

// 上漲、下跌都一樣：族群要有 3 檔以上成分股才值得花一次 worker 去查故事，
// 少於 3 檔的當個股事件看，直接用 controller 寫的 preliminaryStory，不個別深挖。
// retreatSignal（族群退潮）不受這條限制，人數再少也要查。
const MIN_MEMBERS_FOR_WORKER = 3;
const eligible = tasks
  .filter((task) => task.memberCount >= MIN_MEMBERS_FOR_WORKER || task.retreatSignal === true)
  .map((task) => ({
    ...task,
    priority: task.memberCount * 100 + (task.retreatSignal ? 120 : 0) + Math.min(50, task.avgPct * 5),
  }))
  .sort((a, b) => b.priority - a.priority || a.index - b.index);
const selected = eligible
  .slice(0, maxWorkers)
  .map((task) => ({
    file: task.file,
    direction: task.direction,
    category: task.category,
    memberCount: task.memberCount,
    retreatSignal: task.retreatSignal,
  }));

process.stdout.write(JSON.stringify({
  selected,
  maxWorkers,
  skipped: tasks
    .filter((task) => !selected.some((chosen) => chosen.file === task.file))
    .map((task) => ({
      file: task.file,
      direction: task.direction,
      category: task.category,
      memberCount: task.memberCount,
      reason: eligible.some((candidate) => candidate.file === task.file) ? 'capacity' : 'small',
    })),
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
  console.log(`進度 3/5：worker 上限 ${input.maxWorkers}；以下族群不做個別 research，沿用 controller preliminaryStory：`);
  for (const item of input.skipped) {
    const dir = item.direction === "gainer" ? "強勢" : "弱勢";
    const reason = item.reason === "capacity" ? "超出優先額度" : "不到 3 檔";
    console.log(`- [${dir}] ${item.category} (${item.memberCount} 檔，${reason}): ${item.file}`);
  }
}
'

task_progress_label() {
  local task_file="$1"
  node -e 'const fs = require("fs"); const task = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const direction = task.direction === "gainer" ? "強勢" : task.direction === "loser" ? "弱勢" : task.direction; const category = task.category || "未命名族群"; const memberCount = Array.isArray(task.members) ? task.members.length : 0; process.stdout.write(`${direction} / ${category} / ${memberCount} 檔`);' "$task_file"
}

run_worker() {
  local task_file="$1"
  local base_name task_json prompt_file output_file
  base_name="$(basename "$task_file" .json)"
  task_json="$(cat "$task_file")"
  prompt_file="$(mktemp)"
  output_file="$RESULT_DIR/${base_name}.json"

  cat "$WORKER_TEMPLATE" > "$prompt_file"
  {
    echo
    echo '```json'
    echo "$task_json"
    echo '```'
  } >> "$prompt_file"

  local attempt exit_code pid elapsed
  attempt=1
  while [ "$attempt" -le "$WORKER_MAX_ATTEMPTS" ]; do
    exit_code=0
    echo "進度 3/5：${base_name} worker attempt ${attempt}/${WORKER_MAX_ATTEMPTS}，timeout ${WORKER_TIMEOUT_SECONDS}s"
    rm -f "$output_file"
    codex exec --approve-for-me --ephemeral --color never \
      -c "model_reasoning_effort=\"$REASONING_EFFORT\"" \
      --output-schema "$RESULT_SCHEMA" -o "$output_file" \
      -m "$MODEL" -C "$PROJECT_DIR" - < "$prompt_file" &
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

    if [ "$exit_code" -eq 0 ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$output_file" 2>/dev/null; then
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
