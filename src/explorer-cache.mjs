const DEFAULT_REMOTE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCAL_FALLBACK_TTL_MS = 10 * 1000;
const DEFAULT_INVALIDATION_HEALTH_WINDOW_MS = 90 * 1000;

export function walletPathFromAddress(walletAddress) {
  const wallet = String(walletAddress || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return null;
  }
  const normalized = wallet.toLowerCase();
  return `/oak-chain/${normalized.slice(2, 4)}/${normalized.slice(4, 6)}/${normalized.slice(6, 8)}/${normalized}`;
}

function overlapNamespace(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export class ExplorerNamespaceCache {
  constructor({
    chainMode = 'mock',
    now = () => Date.now(),
    remoteTtlMs = DEFAULT_REMOTE_TTL_MS,
    localFallbackTtlMs = DEFAULT_LOCAL_FALLBACK_TTL_MS,
    invalidationHealthWindowMs = DEFAULT_INVALIDATION_HEALTH_WINDOW_MS,
  } = {}) {
    this.chainMode = String(chainMode || 'mock').toLowerCase();
    this.now = now;
    this.remoteTtlMs = remoteTtlMs;
    this.localFallbackTtlMs = localFallbackTtlMs;
    this.invalidationHealthWindowMs = invalidationHealthWindowMs;
    this.entries = new Map();
    this.lastInvalidationSuccessMs = 0;
  }

  isEnabled() {
    return this.chainMode === 'sepolia' || this.chainMode === 'mainnet';
  }

  get(spec = {}) {
    if (!this.isEnabled()) {
      return null;
    }

    const entry = this.entries.get(spec.cacheKey);
    if (!entry) {
      return null;
    }

    const ageMs = this.now() - entry.cachedAtMs;
    if (entry.scope === 'remote' && ageMs > this.remoteTtlMs) {
      this.entries.delete(spec.cacheKey);
      return null;
    }

    if (entry.scope === 'local' && !this.isInvalidationHealthy() && ageMs > this.localFallbackTtlMs) {
      this.entries.delete(spec.cacheKey);
      return null;
    }

    return entry.data;
  }

  put(spec = {}, data) {
    if (!this.isEnabled() || !spec.cacheKey) {
      return data;
    }

    this.entries.set(spec.cacheKey, {
      cacheKey: spec.cacheKey,
      namespace: spec.namespace || '/oak-chain',
      scope: spec.scope === 'remote' ? 'remote' : 'local',
      cachedAtMs: this.now(),
      data,
    });
    return data;
  }

  isInvalidationHealthy() {
    if (!this.isEnabled()) {
      return false;
    }
    if (!this.lastInvalidationSuccessMs) {
      return false;
    }
    return (this.now() - this.lastInvalidationSuccessMs) <= this.invalidationHealthWindowMs;
  }

  noteInvalidationSuccess(timestampMs = this.now()) {
    this.lastInvalidationSuccessMs = timestampMs;
  }

  invalidateByEvent(event = {}) {
    if (!this.isEnabled()) {
      return 0;
    }

    const namespaces = [];
    if (event.path) {
      namespaces.push(String(event.path));
    }
    if (event.wallet) {
      const walletPath = walletPathFromAddress(event.wallet);
      if (walletPath) {
        namespaces.push(walletPath);
      }
    }

    let evicted = 0;
    const legacyType = String(event.type || event.legacyType || '').toLowerCase();
    if (legacyType === 'consensus' && namespaces.length === 0) {
      for (const [cacheKey, entry] of this.entries.entries()) {
        if (entry.scope === 'local') {
          this.entries.delete(cacheKey);
          evicted += 1;
        }
      }
      return evicted;
    }

    for (const [cacheKey, entry] of this.entries.entries()) {
      if (entry.scope !== 'local') {
        continue;
      }
      const shouldEvict = namespaces.some((namespace) => overlapNamespace(entry.namespace, namespace));
      if (shouldEvict) {
        this.entries.delete(cacheKey);
        evicted += 1;
      }
    }

    return evicted;
  }

  size() {
    return this.entries.size;
  }
}
