#!/bin/bash
set -euo pipefail

export PATH="/Users/max/.nvm/versions/node/v20.12.0/bin:/Users/max/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TASK_DIR="${CODEX_GROUP_TASK_DIR:-$PROJECT_DIR/data/tmp/group-tasks}"
RESULT_DIR="${CODEX_GROUP_RESULT_DIR:-$PROJECT_DIR/data/tmp/group-results}"
PROMPT_DIR="$PROJECT_DIR/scripts/prompts"
WORKER_TEMPLATE="$PROMPT_DIR/group-research-worker.md"
MODEL="${CODEX_GROUP_WORKER_MODEL:-gpt-5.4-mini}"
MAX_CONCURRENCY="${1:-4}"
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
  };
});

const loserTop3 = tasks
  .filter((task) => task.direction === 'loser')
  .sort((a, b) => {
    if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
    return a.index - b.index;
  })
  .slice(0, 3)
  .map((task) => task.file);
const loserTop3Set = new Set(loserTop3);

const selected = tasks
  .filter((task) => task.direction === 'gainer' || loserTop3Set.has(task.file))
  .map((task) => ({
    file: task.file,
    direction: task.direction,
    category: task.category,
    memberCount: task.memberCount,
  }));

process.stdout.write(JSON.stringify({
  selected,
  skippedLosers: tasks
    .filter((task) => task.direction === 'loser' && !loserTop3Set.has(task.file))
    .map((task) => ({ file: task.file, category: task.category, memberCount: task.memberCount })),
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
if (input.skippedLosers.length > 0) {
  console.log("進度 3/5：以下弱勢族群不做個別 worker，只交給 finalizer fallback：");
  for (const item of input.skippedLosers) {
    console.log(`- ${item.category} (${item.memberCount} 檔): ${item.file}`);
  }
}
'

task_progress_label() {
  local task_file="$1"
  node -e 'const fs = require("fs"); const task = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const direction = task.direction === "gainer" ? "強勢" : task.direction === "loser" ? "弱勢" : task.direction; const category = task.category || "未命名族群"; const memberCount = Array.isArray(task.members) ? task.members.length : 0; process.stdout.write(`${direction} / ${category} / ${memberCount} 檔`);' "$task_file"
}

run_worker() {
  local task_file="$1"
  local base_name task_json prompt_file
  base_name="$(basename "$task_file" .json)"
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

  local attempt exit_code pid elapsed
  attempt=1
  while [ "$attempt" -le "$WORKER_MAX_ATTEMPTS" ]; do
    exit_code=0
    echo "進度 3/5：${base_name} worker attempt ${attempt}/${WORKER_MAX_ATTEMPTS}，timeout ${WORKER_TIMEOUT_SECONDS}s"
    codex exec --full-auto -m "$MODEL" -C "$PROJECT_DIR" - < "$prompt_file" &
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
