#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./edge-worker-common.sh
source "$SCRIPT_DIR/edge-worker-common.sh"

cleanup_stale_pid_file
pid="$(current_pid)"
if is_pid_alive "$pid"; then
  echo "✅ OPS proxy already running (pid=$pid)"
  exit 0
fi

cd "$ROOT_DIR"
echo "• Starting OPS proxy on ${OPS_MOCK_HOST}:${OPS_MOCK_PORT} (mode=${OPS_MOCK_MODE}, upstream=${OPS_UPSTREAM_BASE})"
OPS_MOCK_MODE="$OPS_MOCK_MODE" \
OPS_UPSTREAM_BASE="$OPS_UPSTREAM_BASE" \
OPS_MOCK_HOST="$OPS_MOCK_HOST" \
OPS_MOCK_PORT="$OPS_MOCK_PORT" \
nohup node src/ops-api-worker.mjs >> "$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" > "$PID_FILE"

sleep 1
if is_pid_alive "$pid"; then
  echo "✅ OPS proxy started (pid=$pid)"
  echo "   log: $LOG_FILE"
else
  echo "❌ OPS proxy failed to start"
  exit 1
fi
