import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/cloudflare-worker.mjs';
import { resolveReachableUpstreamBase } from '../src/ops-api-worker.mjs';

test('worker serves direct ops routes', async () => {
  const response = await worker.fetch(new Request('https://worker.example/ops/v1/overview'), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.version, 'v1');
  assert.equal(payload.data.status, 'healthy');
});

test('private leader hints fall back to the public upstream base', () => {
  assert.equal(
    resolveReachableUpstreamBase('http://localhost:8094', 'https://9740-192-150-5-2.ngrok-free.app'),
    'https://9740-192-150-5-2.ngrok-free.app',
  );
  assert.equal(
    resolveReachableUpstreamBase('https://validator.example.com', 'https://9740-192-150-5-2.ngrok-free.app'),
    'https://validator.example.com',
  );
});
