#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./edge-worker-common.sh
source "$SCRIPT_DIR/edge-worker-common.sh"

MODE="static"
UPSTREAM=""
CHAIN_MODE="${OPS_CHAIN_MODE:-mock}"
CLUSTER_ID="${OPS_MOCK_CLUSTER_ID:-oak-local-a}"
DRY_RUN=false
MESSAGE=""
USE_LOCAL_ENV=false
UPSTREAM_AUTH_TOKEN="${OPS_UPSTREAM_AUTH_TOKEN:-${OAK_OPS_UPSTREAM_AUTH_TOKEN:-}}"

usage() {
  cat <<'EOF'
Usage:
  bin/deploy-cloudflare.sh
  bin/deploy-cloudflare.sh https://abc123.ngrok-free.app
  bin/deploy-cloudflare.sh --proxy https://abc123.ngrok-free.app
  bin/deploy-cloudflare.sh --from-local-env
  bin/deploy-cloudflare.sh --static --dry-run

Behavior:
  - No arguments: deploy current static-mode worker.
  - Positional URL or --proxy URL: deploy proxy-mode worker against that upstream.
  - --from-local-env: reuse OPS_* values from $HOME/oak-chain/ops-proxy.env.

Options:
  --proxy URL           Deploy in proxy mode against the given upstream base.
  --static              Deploy in static mode.
  --from-local-env      Load upstream config from OPS_PROXY_ENV_FILE.
  --chain-mode MODE     Override OPS_CHAIN_MODE (default: mock).
  --cluster-id ID       Override OPS_MOCK_CLUSTER_ID (default: oak-local-a).
  --upstream-auth TOKEN Upload/update OPS_UPSTREAM_AUTH_TOKEN as a Worker secret.
  --message TEXT        Attach a deploy message to the Wrangler deployment.
  --dry-run             Bundle and validate without deploying.
  -h, --help            Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --proxy)
      MODE="proxy"
      UPSTREAM="${2:-}"
      shift 2
      ;;
    --static)
      MODE="static"
      UPSTREAM=""
      shift
      ;;
    --from-local-env)
      USE_LOCAL_ENV=true
      shift
      ;;
    --chain-mode)
      CHAIN_MODE="${2:-}"
      shift 2
      ;;
    --cluster-id)
      CLUSTER_ID="${2:-}"
      shift 2
      ;;
    --upstream-auth)
      UPSTREAM_AUTH_TOKEN="${2:-}"
      shift 2
      ;;
    --message)
      MESSAGE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    http://*|https://*)
      MODE="proxy"
      UPSTREAM="$1"
      shift
      ;;
    *)
      echo "❌ Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [ "$USE_LOCAL_ENV" = true ]; then
  load_env_file
  MODE="${OPS_MOCK_MODE:-$MODE}"
  if [ -n "${OPS_UPSTREAM_BASE:-}" ]; then
    UPSTREAM="${OPS_UPSTREAM_BASE}"
  fi
fi

if [ "$MODE" = "proxy" ]; then
  if [ -z "$UPSTREAM" ]; then
    echo "❌ proxy mode requires an upstream URL"
    exit 1
  fi
  if [[ ! "$UPSTREAM" =~ ^https?:// ]]; then
    echo "❌ upstream base must start with http:// or https://"
    exit 1
  fi
  UPSTREAM="${UPSTREAM%/}"
fi

DEPLOY_CMD=(
  npx wrangler deploy
  --config "$ROOT_DIR/wrangler.toml"
  --var "OPS_MOCK_MODE:${MODE}"
  --var "OPS_MOCK_CLUSTER_ID:${CLUSTER_ID}"
  --var "OPS_CHAIN_MODE:${CHAIN_MODE}"
)

if [ "$MODE" = "proxy" ]; then
  DEPLOY_CMD+=(--var "OPS_UPSTREAM_BASE:${UPSTREAM}")
fi

if [ -n "$MESSAGE" ]; then
  DEPLOY_CMD+=(--message "$MESSAGE")
fi

if [ "$DRY_RUN" = true ]; then
  DEPLOY_CMD+=(--dry-run)
fi

TMP_SECRETS_FILE=""
cleanup() {
  if [ -n "$TMP_SECRETS_FILE" ] && [ -f "$TMP_SECRETS_FILE" ]; then
    rm -f "$TMP_SECRETS_FILE"
  fi
}
trap cleanup EXIT

if [ -n "$UPSTREAM_AUTH_TOKEN" ]; then
  TMP_SECRETS_FILE="$(mktemp)"
  cat > "$TMP_SECRETS_FILE" <<EOF
OPS_UPSTREAM_AUTH_TOKEN=${UPSTREAM_AUTH_TOKEN}
EOF
  DEPLOY_CMD+=(--secrets-file "$TMP_SECRETS_FILE")
fi

cd "$ROOT_DIR"
echo "• Deploying Cloudflare worker (mode=${MODE}, cluster=${CLUSTER_ID}, chain=${CHAIN_MODE})"
if [ "$MODE" = "proxy" ]; then
  echo "  upstream=${UPSTREAM}"
fi

"${DEPLOY_CMD[@]}"
