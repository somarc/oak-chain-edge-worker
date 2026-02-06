#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./edge-worker-common.sh
source "$SCRIPT_DIR/edge-worker-common.sh"

cleanup_stale_pid_file
pid="$(current_pid)"
if ! is_pid_alive "$pid"; then
  rm -f "$PID_FILE" 2>/dev/null || true
  echo "✅ OPS proxy already stopped"
  exit 0
fi

echo "• Stopping OPS proxy (pid=$pid)"
kill "$pid" 2>/dev/null || true

for _ in $(seq 1 20); do
  if ! is_pid_alive "$pid"; then
    rm -f "$PID_FILE" 2>/dev/null || true
    echo "✅ OPS proxy stopped"
    exit 0
  fi
  sleep 0.2
done

echo "• Forcing OPS proxy stop (pid=$pid)"
kill -9 "$pid" 2>/dev/null || true
rm -f "$PID_FILE" 2>/dev/null || true
echo "✅ OPS proxy stopped (forced)"
