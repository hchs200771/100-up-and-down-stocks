#!/bin/bash
set -u

# Publish the daily report as a static Vercel deployment.
# Skips gracefully (exit 0) when VERCEL_TOKEN is absent, so the pipeline never
# fails just because publishing is not configured.

export PATH="/Users/max/.nvm/versions/node/v20.12.0/bin:/Users/max/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

# Load .env.local (VERCEL_TOKEN, optional VERCEL_PROJECT_NAME)
if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env.local"
  set +a
fi

if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo "[publish] VERCEL_TOKEN not set — skipping Vercel deploy."
  exit 0
fi

PROJECT_NAME="${VERCEL_PROJECT_NAME:-daily-stock-report}"
SITE_DIR="$PROJECT_DIR/data/site"
HTML="$PROJECT_DIR/data/report-latest.html"

if [ ! -f "$HTML" ]; then
  echo "[publish] $HTML not found — nothing to deploy." >&2
  exit 1
fi

# Assemble the static site directory
rm -rf "$SITE_DIR"
mkdir -p "$SITE_DIR"
cp "$HTML" "$SITE_DIR/index.html"
[ -f "$PROJECT_DIR/data/analysis-latest.json" ] && cp "$PROJECT_DIR/data/analysis-latest.json" "$SITE_DIR/analysis-latest.json"
[ -f "$PROJECT_DIR/data/scorecard.json" ] && cp "$PROJECT_DIR/data/scorecard.json" "$SITE_DIR/scorecard.json"

# Ensure the project exists (first run creates it; subsequent runs no-op).
if ! vercel project ls --token "$VERCEL_TOKEN" 2>/dev/null | grep -qw "$PROJECT_NAME"; then
  echo "[publish] Project '$PROJECT_NAME' not found — creating it."
  vercel project add "$PROJECT_NAME" --token "$VERCEL_TOKEN" 2>&1 | grep -avE "_encode|_decode" || true
fi

echo "[publish] Deploying $SITE_DIR to Vercel project '$PROJECT_NAME' ..."
DEPLOY_URL="$(vercel deploy "$SITE_DIR" \
  --prod --yes \
  --token "$VERCEL_TOKEN" \
  --project "$PROJECT_NAME" 2>&1 | tee /dev/stderr | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | tail -1)"

if [ -z "$DEPLOY_URL" ]; then
  echo "[publish] Deploy did not return a URL — check output above." >&2
  exit 1
fi

echo "[publish] Live: $DEPLOY_URL"
