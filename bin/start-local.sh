#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OPS_MOCK_MODE="${OPS_MOCK_MODE:-proxy}" \
OPS_UPSTREAM_BASE="${OPS_UPSTREAM_BASE:-http://127.0.0.1:8090}" \
OPS_MOCK_PORT="${OPS_MOCK_PORT:-8787}" \
node src/ops-api-worker.mjs
