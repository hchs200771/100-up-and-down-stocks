#!/usr/bin/env bash
# 盯 GitHub Pages 部署：push 後在背景跑，部署失敗就重跑，最多 3 次。
# GitHub 偶爾回「No artifacts named github-pages」這類暫時性錯誤，重跑就會好。
# 被後面的 push 取消（concurrency: cancel-in-progress）或後面已有成功部署時就不管。
#
# 用法：scripts/watch-pages-deploy.sh <commit sha>（publish-github-pages.sh push 成功後自動以背景啟動）
# 紀錄：data/logs/pages-deploy.log
set -uo pipefail
SHA="${1:?commit sha}"
MAX_RERUN=3
log() { echo "[$(date '+%F %T')] ${SHA:0:7} $*"; }
command -v gh >/dev/null || { log "沒有 gh，略過部署檢查"; exit 0; }

reruns=0
for _ in $(seq 1 60); do   # 每 20 秒看一次，最多 20 分鐘
  sleep 20
  read -r id status conclusion < <(gh run list --workflow pages.yml --commit "$SHA" --limit 1 \
    --json databaseId,status,conclusion -q '.[0] | "\(.databaseId) \(.status) \(.conclusion)"' 2>/dev/null) || true
  [ -z "${id:-}" ] || [ "${id}" = "null" ] && continue          # workflow 還沒建立
  [ "$status" != "completed" ] && continue
  case "${conclusion}" in
    success) log "部署成功（run ${id}）"; exit 0 ;;
    cancelled) log "被後面的部署取消（run ${id}），由後面那次負責"; exit 0 ;;
  esac
  # 失敗：如果之後已有成功的部署，網站已是新的，不用重跑
  newer=$(gh run list --workflow pages.yml --branch main --limit 5 --json databaseId,conclusion \
    -q "[.[] | select(.databaseId > ${id} and .conclusion == \"success\")] | length" 2>/dev/null || echo 0)
  if [ "${newer:-0}" -gt 0 ]; then log "run ${id} 失敗，但之後已有成功部署，不重跑"; exit 0; fi
  if [ "${reruns}" -ge "${MAX_RERUN}" ]; then log "run ${id} 重跑 ${MAX_RERUN} 次仍失敗，請手動檢查：gh run view ${id} --log-failed"; exit 1; fi
  reruns=$((reruns + 1))
  log "run ${id} 失敗（${conclusion}），第 ${reruns} 次重跑"
  gh run rerun "${id}" >/dev/null 2>&1 || log "重跑指令失敗"
  sleep 10
done
log "等了 20 分鐘仍未完成，請手動檢查"
exit 1
