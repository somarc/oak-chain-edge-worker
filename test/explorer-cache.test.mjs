import test from 'node:test';
import assert from 'node:assert/strict';

import { ExplorerNamespaceCache, walletPathFromAddress } from '../src/explorer-cache.mjs';

test('cache is disabled outside sepolia and mainnet', () => {
  const cache = new ExplorerNamespaceCache({ chainMode: 'mock' });
  cache.put({ cacheKey: 'wallet:1', namespace: '/oak-chain', scope: 'local' }, { ok: true });
  assert.equal(cache.get({ cacheKey: 'wallet:1' }), null);
});

test('local entries remain warm while invalidation health is good and evict on matching event', () => {
  let now = 1000;
  const cache = new ExplorerNamespaceCache({
    chainMode: 'sepolia',
    now: () => now,
    localFallbackTtlMs: 50,
    invalidationHealthWindowMs: 5000,
  });

  cache.noteInvalidationSuccess();
  cache.put({ cacheKey: 'tree:local', namespace: '/oak-chain/12', scope: 'local' }, { value: 'cached' });
  now = 5000;
  assert.deepEqual(cache.get({ cacheKey: 'tree:local' }), { value: 'cached' });

  cache.invalidateByEvent({ type: 'content', path: '/oak-chain/12/doc' });
  assert.equal(cache.get({ cacheKey: 'tree:local' }), null);
});

test('unrelated local events do not evict other namespaces', () => {
  const cache = new ExplorerNamespaceCache({ chainMode: 'mainnet' });
  cache.noteInvalidationSuccess();
  cache.put({ cacheKey: 'tree:a', namespace: '/oak-chain/12', scope: 'local' }, { value: 'a' });
  cache.invalidateByEvent({ type: 'content', path: '/oak-chain/34/doc' });
  assert.deepEqual(cache.get({ cacheKey: 'tree:a' }), { value: 'a' });
});

test('remote entries expire on hard ttl', () => {
  let now = 1000;
  const cache = new ExplorerNamespaceCache({
    chainMode: 'mainnet',
    now: () => now,
    remoteTtlMs: 100,
  });

  cache.put({ cacheKey: 'tree:remote', namespace: '/oak-chain/80', scope: 'remote' }, { value: 'remote' });
  now = 1050;
  assert.deepEqual(cache.get({ cacheKey: 'tree:remote' }), { value: 'remote' });
  now = 1205;
  assert.equal(cache.get({ cacheKey: 'tree:remote' }), null);
});

test('local entries fall back to ttl when invalidation health degrades', () => {
  let now = 1000;
  const cache = new ExplorerNamespaceCache({
    chainMode: 'sepolia',
    now: () => now,
    localFallbackTtlMs: 100,
    invalidationHealthWindowMs: 50,
  });

  cache.noteInvalidationSuccess();
  cache.put({ cacheKey: 'node:local', namespace: '/oak-chain/12/doc', scope: 'local' }, { value: 'local' });
  now = 1075;
  assert.deepEqual(cache.get({ cacheKey: 'node:local' }), { value: 'local' });
  now = 1205;
  assert.equal(cache.get({ cacheKey: 'node:local' }), null);
});

test('wallet invalidation uses the wallet-derived namespace', () => {
  const cache = new ExplorerNamespaceCache({ chainMode: 'mainnet' });
  cache.noteInvalidationSuccess();
  const wallet = '0x1234567890abcdef1234567890abcdef12345678';
  cache.put({ cacheKey: 'wallet:1', namespace: walletPathFromAddress(wallet), scope: 'local' }, { wallet });
  cache.invalidateByEvent({ type: 'wallet', wallet });
  assert.equal(cache.get({ cacheKey: 'wallet:1' }), null);
});
