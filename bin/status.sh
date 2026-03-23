#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./edge-worker-common.sh
source "$SCRIPT_DIR/edge-worker-common.sh"

cleanup_stale_pid_file
pid="$(current_pid)"
if is_pid_alive "$pid"; then
  code="$(curl -s -o /tmp/oak-edge-worker-status.json -w "%{http_code}" "http://${OPS_MOCK_HOST}:${OPS_MOCK_PORT}/ops/v1/overview" || echo 000)"
  echo "ops-proxy:UP pid=${pid} url=http://${OPS_MOCK_HOST}:${OPS_MOCK_PORT} http=${code} upstream=${OPS_UPSTREAM_BASE} log=${LOG_FILE}"
else
  echo "ops-proxy:DOWN url=http://${OPS_MOCK_HOST}:${OPS_MOCK_PORT} upstream=${OPS_UPSTREAM_BASE} log=${LOG_FILE}"
  exit 1
fi
