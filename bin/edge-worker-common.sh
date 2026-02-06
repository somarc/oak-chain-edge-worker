#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

OPS_MOCK_MODE="${OPS_MOCK_MODE:-proxy}"
OPS_UPSTREAM_BASE="${OPS_UPSTREAM_BASE:-http://127.0.0.1:8090}"
OPS_MOCK_HOST="${OPS_MOCK_HOST:-127.0.0.1}"
OPS_MOCK_PORT="${OPS_MOCK_PORT:-8787}"

PID_DIR="${PID_DIR:-$HOME/oak-chain/pids}"
LOG_DIR="${LOG_DIR:-$HOME/oak-chain/logs}"
PID_FILE="${PID_FILE:-$PID_DIR/ops-proxy.pid}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/start-ops-proxy.log}"

mkdir -p "$PID_DIR" "$LOG_DIR"

is_pid_alive() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

cleanup_stale_pid_file() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if ! is_pid_alive "$pid"; then
      rm -f "$PID_FILE" 2>/dev/null || true
    fi
  fi
}

current_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE" 2>/dev/null || true
  fi
}
