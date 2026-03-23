#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./edge-worker-common.sh
source "$SCRIPT_DIR/edge-worker-common.sh"

usage() {
  cat <<'EOF'
Usage: set-upstream.sh <upstream-base-url> [--restart]

Examples:
  bin/set-upstream.sh https://abc123.ngrok-free.app
  bin/set-upstream.sh https://abc123.ngrok-free.app --restart

Notes:
  - Persists OPS_UPSTREAM_BASE in $HOME/oak-chain/ops-proxy.env by default.
  - Start/restart scripts load this file automatically.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

UPSTREAM="$1"
RESTART=false
if [ "${2:-}" = "--restart" ]; then
  RESTART=true
fi

if [[ ! "$UPSTREAM" =~ ^https?:// ]]; then
  echo "❌ upstream base must start with http:// or https://"
  exit 1
fi

UPSTREAM="${UPSTREAM%/}"
mkdir -p "$(dirname "$OPS_PROXY_ENV_FILE")"

cat > "$OPS_PROXY_ENV_FILE" <<EOF
OPS_MOCK_MODE=proxy
OPS_UPSTREAM_BASE=$UPSTREAM
OPS_MOCK_HOST=${OPS_MOCK_HOST}
OPS_MOCK_PORT=${OPS_MOCK_PORT}
EOF

echo "✅ Saved upstream config: $OPS_PROXY_ENV_FILE"
echo "   OPS_UPSTREAM_BASE=$UPSTREAM"

if [ "$RESTART" = true ]; then
  "$SCRIPT_DIR/restart.sh"
  "$SCRIPT_DIR/status.sh" || true
else
  echo "ℹ️  Run bin/restart.sh to apply."
fi
