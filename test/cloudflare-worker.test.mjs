import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/cloudflare-worker.mjs';

test('worker serves direct ops routes', async () => {
  const response = await worker.fetch(new Request('https://worker.example/ops/v1/overview'), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.version, 'v1');
  assert.equal(payload.data.status, 'healthy');
});

test('worker preserves hosted oak-chain-action compatibility routes', async () => {
  const response = await worker.fetch(
    new Request('https://worker.example/oak-chain-action?route=explorer/summary'),
    {},
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.version, 'v1');
  assert.equal(payload.data.contractVersion, 'explorer.v1');
});
