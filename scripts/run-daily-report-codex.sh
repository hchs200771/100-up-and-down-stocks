#!/bin/bash
# Codex 專用的穩定入口。實際 pipeline 保留在 parallel runner，讓既有排程與參數相容。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/run-daily-report-codex-parallel.sh" "$@"
