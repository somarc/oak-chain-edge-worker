# Oak Chain Edge Worker

Edge worker for Oak Chain operations APIs and dashboard integration.

## Local Run

```bash
npm run start
```

Default bind:
- `OPS_MOCK_HOST=127.0.0.1`
- `OPS_MOCK_PORT=8787`
- `OPS_MOCK_MODE=static` (set to `proxy` for upstream mode)

Upstream target (proxy mode):
- `OPS_UPSTREAM_BASE=http://127.0.0.1:8090`

## Health Check

```bash
curl http://127.0.0.1:8787/ops/v1/overview
```

## Deployment Note

Current mode is local process orchestration (validator lifecycle scripts).
Target hosting can move to Adobe I/O Runtime once auth/network/runtime constraints are finalized.
