#!/usr/bin/env node

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.OPS_MOCK_PORT || 8787);
const HOST = process.env.OPS_MOCK_HOST || '127.0.0.1';
const CLUSTER_ID = process.env.OPS_MOCK_CLUSTER_ID || 'oak-local-a';
const MODE = process.env.OPS_MOCK_MODE || 'static';
const UPSTREAM_BASE = (process.env.OPS_UPSTREAM_BASE || 'http://127.0.0.1:8090').replace(/\/$/, '');
const UPSTREAM_CACHE_TTL_MS = Number(process.env.OPS_UPSTREAM_CACHE_TTL_MS || 10000);
const UPSTREAM_CACHE = new Map();
const CHAIN_MODE =
  process.env.OPS_CHAIN_MODE
  || process.env.OAK_BLOCKCHAIN_MODE
  || process.env.OAK_CHAIN_MODE
  || process.env.BLOCKCHAIN_MODE
  || 'mock';

function nowIso() {
  return new Date().toISOString();
}

function envelope(data) {
  return {
    version: 'v1',
    generatedAt: nowIso(),
    clusterId: CLUSTER_ID,
    data,
  };
}

function parseJsonSafe(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return fallback;
  }
}

function pick(obj, keys, fallback = null) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (let i = 0; i < keys.length; i += 1) {
    const v = obj[keys[i]];
    if (v !== undefined && v !== null) return v;
  }
  return fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePort(urlValue) {
  if (typeof urlValue !== 'string' || !urlValue.length) return null;
  try {
    const parsed = new URL(urlValue);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return Number.isFinite(port) ? port : null;
  } catch (_e) {
    return null;
  }
}

function normalizeNodeIds(rawNodes) {
  if (!Array.isArray(rawNodes)) return [];
  const used = new Set();
  const byPort = { 8090: 0, 8092: 1, 8094: 2 };
  return rawNodes.map((node, index) => {
    let nodeId = pick(node, ['nodeId', 'memberId', 'id'], null);
    nodeId = nodeId === null || nodeId === undefined ? null : Number(nodeId);
    if (!Number.isFinite(nodeId)) {
      nodeId = null;
    }
    const port = parsePort(pick(node, ['url'], null));
    if (nodeId === null || used.has(nodeId)) {
      if (port !== null && byPort[port] !== undefined && !used.has(byPort[port])) {
        nodeId = byPort[port];
      } else {
        let candidate = index;
        while (used.has(candidate)) candidate += 1;
        nodeId = candidate;
      }
    }
    used.add(nodeId);
    return { ...node, nodeId, port };
  });
}

function normalizeValidatorIdentities(payload) {
  const validators = Array.isArray(pick(payload, ['validators'], []))
    ? pick(payload, ['validators'], [])
    : [];
  const byPort = new Map();
  const byNodeId = new Map();
  const byMemberId = new Map();

  validators.forEach((validator) => {
    if (!validator || typeof validator !== 'object') return;
    const port = parsePort(pick(validator, ['url'], null));
    const nodeId = toNum(pick(validator, ['nodeId'], null), null);
    const memberId = toNum(pick(validator, ['memberId'], null), null);
    if (port !== null) byPort.set(port, validator);
    if (Number.isFinite(nodeId) && nodeId >= 0) byNodeId.set(nodeId, validator);
    if (Number.isFinite(memberId) && memberId >= 0) byMemberId.set(memberId, validator);
  });

  return { byPort, byNodeId, byMemberId };
}

function findValidatorIdentityForNode(node, identities) {
  if (!identities) return null;
  const port = toNum(pick(node, ['port'], parsePort(pick(node, ['url'], null))), null);
  if (Number.isFinite(port) && identities.byPort.has(port)) {
    return identities.byPort.get(port);
  }
  const nodeId = toNum(pick(node, ['nodeId'], null), null);
  if (Number.isFinite(nodeId) && identities.byNodeId.has(nodeId)) {
    return identities.byNodeId.get(nodeId);
  }
  const memberId = toNum(pick(node, ['memberId'], null), null);
  if (Number.isFinite(memberId) && identities.byMemberId.has(memberId)) {
    return identities.byMemberId.get(memberId);
  }
  return null;
}

function parsePendingEpochStats(statsText) {
  if (typeof statsText !== 'string') {
    return { pendingProposals: null, pendingEpochs: null, totalQueued: null };
  }
  const pendingProposalsMatch = statsText.match(/Pending Proposals:\s*(\d+)/i);
  const pendingEpochsMatch = statsText.match(/Pending Epochs:\s*(\d+)/i);
  const totalQueuedMatch = statsText.match(/Total Queued:\s*(\d+)/i);
  return {
    pendingProposals: pendingProposalsMatch ? Number(pendingProposalsMatch[1]) : null,
    pendingEpochs: pendingEpochsMatch ? Number(pendingEpochsMatch[1]) : null,
    totalQueued: totalQueuedMatch ? Number(totalQueuedMatch[1]) : null,
  };
}

function parseBackpressureStats(statsText) {
  if (typeof statsText !== 'string') {
    return {
      pending: null,
      max: null,
      active: null,
      sent: null,
      acked: null,
    };
  }
  const parseIntByKey = (key) => {
    const match = statsText.match(new RegExp(`${key}=(\\d+)`, 'i'));
    return match ? Number(match[1]) : null;
  };
  const activeMatch = statsText.match(/active=(true|false)/i);
  return {
    pending: parseIntByKey('pending'),
    max: parseIntByKey('max'),
    active: activeMatch ? activeMatch[1].toLowerCase() === 'true' : null,
    sent: parseIntByKey('sent'),
    acked: parseIntByKey('acked'),
  };
}

function resolveQueueSignals(queue) {
  const pendingStats = parsePendingEpochStats(pick(queue, ['pendingEpochStats'], ''));
  const backpressureStats = parseBackpressureStats(pick(queue, ['backpressureStats'], ''));

  const queuePending = Math.max(
    toNum(pick(queue, ['pendingCount', 'pending'], 0), 0),
    toNum(pick(queue, ['batchQueueSize'], 0), 0),
    toNum(pendingStats.pendingProposals, 0),
  );
  const mempool = toNum(
    pick(queue, ['mempoolPendingCount', 'mempoolCount', 'mempool', 'mempoolSize', 'unverifiedQueueSize'], 0),
    0,
  );
  const backpressurePending = Math.max(
    toNum(pick(queue, ['backpressurePendingCount'], 0), 0),
    toNum(backpressureStats.pending, 0),
  );
  const backpressureMax = Math.max(
    toNum(pick(queue, ['backpressureMaxPending'], 0), 0),
    toNum(backpressureStats.max, 0),
  );
  const pendingEpochs = toNum(pendingStats.pendingEpochs, 0);
  const totalQueuedFromStats = toNum(pendingStats.totalQueued, null);

  return {
    queuePending,
    mempool,
    backpressurePending,
    backpressureMax,
    backpressureActive: Boolean(
      pick(queue, ['backpressureActive'], false) || backpressureStats.active === true,
    ),
    backpressureSent: toNum(backpressureStats.sent, 0),
    backpressureAcked: toNum(backpressureStats.acked, 0),
    pendingEpochs,
    totalQueuedFromStats,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** exp);
  return `${scaled.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function severityFromThreshold(value, warn, critical, direction = 'high') {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'unknown';
  if (direction === 'low') {
    if (Number.isFinite(critical) && n <= critical) return 'critical';
    if (Number.isFinite(warn) && n <= warn) return 'warn';
    return 'ok';
  }
  if (Number.isFinite(critical) && n >= critical) return 'critical';
  if (Number.isFinite(warn) && n >= warn) return 'warn';
  return 'ok';
}

function buildSignal({
  id, label, category, value, unit = null,
  warnThreshold = null, criticalThreshold = null, direction = 'high',
  source = 'upstream', description = '', available = true,
}) {
  const severity = available
    ? severityFromThreshold(value, warnThreshold, criticalThreshold, direction)
    : 'unknown';
  return {
    id,
    label,
    category,
    value: available ? value : null,
    unit,
    severity,
    source,
    description,
    available,
    thresholds: { warn: warnThreshold, critical: criticalThreshold, direction },
    updatedAt: nowIso(),
  };
}

function shortWallet(wallet) {
  if (!wallet || typeof wallet !== 'string') return 'unknown';
  if (wallet.length <= 18) return wallet;
  return `${wallet.slice(0, 10)}...${wallet.slice(-8)}`;
}

async function upstreamGet(path) {
  const target = `${UPSTREAM_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(target, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`upstream ${path} HTTP ${response.status}`);
  }
  const text = await response.text();
  return parseJsonSafe(text, {});
}

async function upstreamGetFromBase(path, baseUrl) {
  const base = (baseUrl || UPSTREAM_BASE).replace(/\/$/, '');
  const cacheKey = `${base}|${path}`;
  const fallbackCacheKey = `${UPSTREAM_BASE}|${path}`;
  const target = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(target, { headers: { accept: 'application/json' } });
  if (response.status === 429) {
    const now = Date.now();
    const cached = UPSTREAM_CACHE.get(cacheKey) || UPSTREAM_CACHE.get(fallbackCacheKey);
    if (cached && (now - cached.ts) <= UPSTREAM_CACHE_TTL_MS) {
      return cached.data;
    }
  }
  if (!response.ok) {
    throw new Error(`upstream ${path} HTTP ${response.status}`);
  }
  const text = await response.text();
  const parsed = parseJsonSafe(text, {});
  UPSTREAM_CACHE.set(cacheKey, { ts: Date.now(), data: parsed });
  return parsed;
}

async function upstreamGetText(path) {
  const target = `${UPSTREAM_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(target, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`upstream ${path} HTTP ${response.status}`);
  }
  return response.text();
}

async function upstreamGetUnwrapped(path) {
  const payload = await upstreamGet(path);
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data ?? payload;
  }
  return payload;
}

async function upstreamGetSnapshot(path, fallbackPath, baseUrl = UPSTREAM_BASE) {
  try {
    const snapshot = await upstreamGetFromBase(path, baseUrl);
    const data = pick(snapshot, ['data'], null);
    if (data && typeof data === 'object') {
      return data;
    }
  } catch (_e) {
    // Fall through to fallback endpoint.
  }
  return upstreamGetFromBase(fallbackPath, baseUrl);
}

function maxField(records, field) {
  return records.reduce((max, record) => {
    const value = toNum(pick(record, [field], 0), 0);
    return value > max ? value : max;
  }, 0);
}

async function resolveClusterQueueSnapshot(leaderBase) {
  const primary = await upstreamGetSnapshot('/v1/ops/snapshots/queue', '/v1/proposals/queue/stats', leaderBase);
  let snapshots = [primary];

  try {
    const identities = await upstreamGetFromBase('/v1/aeron/validator-identities', leaderBase);
    const validators = Array.isArray(pick(identities, ['validators'], []))
      ? pick(identities, ['validators'], [])
      : [];
    const urls = validators
      .map((validator) => pick(validator, ['url'], null))
      .filter((value) => typeof value === 'string' && value.length > 0);

    if (urls.length > 0) {
      const settled = await Promise.allSettled(
        urls.map((base) => upstreamGetSnapshot('/v1/ops/snapshots/queue', '/v1/proposals/queue/stats', base)),
      );
      const fetched = settled
        .filter((result) => result.status === 'fulfilled' && result.value && typeof result.value === 'object')
        .map((result) => result.value);
      if (fetched.length > 0) {
        snapshots = fetched;
      }
    }
  } catch (_e) {
    // Keep primary snapshot when identity fan-out is unavailable.
  }

  const merged = { ...primary };
  const monotonicFields = [
    'totalVerifiedCount',
    'totalVerifiedCountLifetime',
    'totalFinalizedCount',
    'totalFinalizedCountLifetime',
    'totalProposals',
    'writeProposals',
    'deleteProposals',
    'totalRejectedCount',
    'totalRejectedCountLifetime',
    'verifierRejectedCount',
    'maxRetryCount',
    'totalProposalsSent',
    'totalProposalsSentLifetime',
  ];
  monotonicFields.forEach((field) => {
    merged[field] = maxField(snapshots, field);
  });

  merged.pendingCount = maxField(snapshots, 'pendingCount');
  merged.unverifiedQueueSize = maxField(snapshots, 'unverifiedQueueSize');
  merged.mempoolPendingCount = maxField(snapshots, 'mempoolPendingCount');
  merged.batchQueueSize = maxField(snapshots, 'batchQueueSize');

  return merged;
}

async function resolveLeaderUpstreamBase() {
  try {
    const consensus = await upstreamGet('/v1/consensus/status');
    const currentLeader = pick(consensus, ['currentLeader'], null);
    if (typeof currentLeader === 'string' && currentLeader.length > 0) {
      return currentLeader.replace(/\/$/, '');
    }
  } catch (_e) {
    // Fall through to cluster-state strategy.
  }
  try {
    const cluster = await upstreamGet('/v1/aeron/cluster-state');
    const directLeader = pick(cluster, ['currentLeader'], null);
    if (typeof directLeader === 'string' && directLeader.length > 0) {
      return directLeader.replace(/\/$/, '');
    }
    const members = pick(cluster, ['members', 'nodes', 'validators'], []);
    if (Array.isArray(members)) {
      const leader = members.find((m) => String(pick(m, ['role'], '')).toUpperCase() === 'LEADER');
      const leaderUrl = pick(leader, ['url'], null);
      if (typeof leaderUrl === 'string' && leaderUrl.length > 0) {
        return leaderUrl.replace(/\/$/, '');
      }
    }
  } catch (_e) {
    // Use fallback.
  }
  return UPSTREAM_BASE;
}

function extractBlobStoreFromMalformedDeepHealth(text) {
  if (typeof text !== 'string' || !text.length) return {};
  const blobStoreMatch = text.match(/"blobStore"\s*:\s*\{([\s\S]*?)\}\s*,/);
  if (!blobStoreMatch) return {};
  const body = blobStoreMatch[1];
  const typeMatch = body.match(/"type"\s*:\s*"([^"]+)"/i);
  const statusMatch = body.match(/"status"\s*:\s*"([^"]+)"/i);
  const gatewayMatch = body.match(/"ipfsGateway"\s*:\s*"([^"]+)"/i);
  return {
    blobStore: {
      type: typeMatch ? typeMatch[1] : null,
      status: statusMatch ? statusMatch[1] : null,
      ipfsGateway: gatewayMatch ? gatewayMatch[1] : null,
    },
  };
}

async function resolveOverview() {
  const leaderBase = await resolveLeaderUpstreamBase();
  const [consensus, cluster, queue, replication] = await Promise.all([
    upstreamGet('/v1/consensus/status'),
    upstreamGetSnapshot('/v1/ops/snapshots/cluster', '/v1/aeron/cluster-state', leaderBase),
    upstreamGetSnapshot('/v1/ops/snapshots/queue', '/v1/proposals/queue/stats', leaderBase),
    upstreamGetSnapshot('/v1/ops/snapshots/replication', '/v1/aeron/replication-lag', leaderBase),
  ]);

  const leaderNodeId = pick(cluster, ['leaderNodeId', 'leader', 'leaderId'], 0);
  const term = pick(cluster, ['term', 'currentTerm'], pick(raftLike(cluster), ['currentTerm'], 0));
  const nodes = pick(cluster, ['nodes', 'members', 'validators'], []);
  const reachableNodes = Array.isArray(nodes)
    ? nodes.filter((n) => pick(n, ['reachable', 'online'], true)).length
    : 0;
  const reachableValidators = toNum(
    pick(consensus, ['reachableValidators'], pick(cluster, ['reachableCount'], reachableNodes)),
    reachableNodes,
  );
  const currentRole = String(
    pick(cluster, ['role'], pick(consensus, ['currentRole'], pick(findLeader(nodes), ['role'], 'UNKNOWN'))),
  ).toUpperCase();
  const status = reachableValidators > 0 ? 'healthy' : 'degraded';
  const signals = resolveQueueSignals(queue);

  return {
    status,
    leader: {
      nodeId: toNum(leaderNodeId, 0),
      wallet: String(pick(consensus, ['leaderWallet', 'walletAddress'], pick(findLeader(nodes), ['walletAddress'], 'unknown'))),
      role: currentRole,
      term: toNum(term, 0),
      since: pick(consensus, ['leaderSince', 'lastLeaderChangeAt'], nowIso()),
    },
    cluster: {
      nodeCount: Array.isArray(nodes) ? nodes.length : toNum(pick(consensus, ['clusterSize'], 0), 0),
      quorum: toNum(pick(cluster, ['quorumSize'], pick(cluster.quorum || {}, ['required'], 0)), 0),
      reachableNodes: reachableValidators,
      role: currentRole,
    },
    queue: {
      pending: signals.queuePending,
      queuePending: signals.queuePending,
      mempool: signals.mempool,
      backpressurePending: signals.backpressurePending,
      oldestPendingAgeMs: toNum(pick(queue, ['oldestPendingAgeMs', 'oldestAgeMs'], 0), 0),
    },
    replication: {
      maxLagMs: toNum(pick(replication, ['maxLagMs', 'maxLag', 'replicationLag'], 0), 0),
      maxLagNodeId: toNum(pick(replication, ['maxLagNodeId', 'worstNodeId'], 0), 0),
      status: pick(replication, ['status'], pick(replication, ['healthy'], false) ? 'ok' : 'degraded'),
    },
    durability: {
      pendingAcks: toNum(pick(queue, ['persistencePendingChanges'], 0), 0),
      ackTimeouts: toNum(pick(queue, ['maxRetryCount'], 0), 0),
      status: 'ok',
    },
  };
}

async function resolveHeader() {
  const [cluster, consensus, healthSnapshot, deepRaw, shallow] = await Promise.all([
    upstreamGetSnapshot('/v1/ops/snapshots/cluster', '/v1/aeron/cluster-state'),
    upstreamGet('/v1/consensus/status'),
    upstreamGetSnapshot('/v1/ops/snapshots/health', '/health'),
    upstreamGetText('/health/deep').catch(() => ''),
    upstreamGet('/health').catch(() => ({})),
  ]);
  let deep = parseJsonSafe(deepRaw, {});
  if (!deep || Object.keys(deep).length === 0) {
    deep = extractBlobStoreFromMalformedDeepHealth(deepRaw);
  }

  const normalizedMembers = normalizeNodeIds(pick(cluster, ['members', 'nodes', 'validators'], []));
  const selfMemberId = toNum(pick(cluster, ['memberId'], pick(cluster, ['leaderNodeId', 'leader'], 0)), 0);
  const role = String(
    pick(cluster, ['role'], pick(consensus, ['currentRole'], 'FOLLOWER')),
  ).toUpperCase();
  const wallet = String(
    pick(cluster, ['validatorIdentity'], {}).walletAddress
    || pick(consensus, ['walletAddress', 'leaderWallet'], null)
    || pick(normalizedMembers.find((m) => toNum(m.nodeId, -1) === selfMemberId), ['walletAddress', 'wallet'], null)
    || pick(normalizedMembers.find((m) => String(pick(m, ['role'], '')).toUpperCase() === 'LEADER'), ['walletAddress', 'wallet'], null)
    || 'unknown'
  );
  const blobStore = pick(deep, ['blobStore'], {});
  const blobStoreType = String(
    pick(healthSnapshot, ['blobStoreType'], pick(blobStore, ['type'], 'file')),
  ).toUpperCase();
  const ipfsStatusRaw = String(pick(blobStore, ['status'], pick(healthSnapshot, ['status'], 'unknown')));
  const ipfsEnabled = blobStoreType === 'IPFS';
  const ipfsDaemonStatus = ipfsEnabled ? ipfsStatusRaw.toUpperCase() : 'DISABLED';
  const networkStatus = String(
    pick(cluster, ['health'], {}).status
    || pick(shallow, ['clusterStatus'], null)
    || pick(cluster, ['clusterState'], null)
    || 'unknown',
  ).toUpperCase();

  return {
    title: 'Blockchain AEM',
    subtitle: 'Global P2P Oak Repository',
    validator: {
      nodeId: selfMemberId,
      role,
      label: `Validator ${selfMemberId} ${role}`,
    },
    binaries: {
      type: blobStoreType,
      label: `Binaries ${blobStoreType}`,
    },
    ipfs: {
      daemonStatus: ipfsDaemonStatus,
      enabled: ipfsEnabled,
      gateway: pick(blobStore, ['ipfsGateway'], null),
    },
    mode: String(CHAIN_MODE).toLowerCase(),
    clusterWallet: wallet,
    clusterWalletShort: shortWallet(wallet),
    networkStatus,
  };
}

async function resolveExplorerSummary() {
  return upstreamGetUnwrapped('/v1/explorer/summary');
}

function findLeader(nodes) {
  if (!Array.isArray(nodes)) return null;
  return nodes.find((n) => String(pick(n, ['role'], '')).toUpperCase() === 'LEADER') || null;
}

function raftLike(cluster) {
  return pick(cluster, ['electionMetrics'], {});
}

async function resolveCluster() {
  const leaderBase = await resolveLeaderUpstreamBase();
  const [cluster, identitiesPayload] = await Promise.all([
    upstreamGetSnapshot('/v1/ops/snapshots/cluster', '/v1/aeron/cluster-state', leaderBase),
    upstreamGetFromBase('/v1/aeron/validator-identities', leaderBase).catch(() => ({ validators: [] })),
  ]);
  const identities = normalizeValidatorIdentities(identitiesPayload);
  const rawNodes = pick(cluster, ['nodes', 'members', 'validators'], []);
  const nodes = normalizeNodeIds(rawNodes);
  const leaderNode = nodes.find((n) => String(pick(n, ['role'], '')).toUpperCase() === 'LEADER');
  return {
    clusterState: pick(cluster, ['clusterState', 'state'], pick(cluster.health || {}, ['status'], 'unknown')),
    term: toNum(pick(cluster, ['term', 'currentTerm'], 0), 0),
    leaderNodeId: toNum(pick(cluster, ['leaderNodeId', 'leader', 'leaderId'], leaderNode ? leaderNode.nodeId : 0), 0),
    nodes: Array.isArray(nodes) ? nodes.map((node) => {
      const identity = findValidatorIdentityForNode(node, identities);
      return ({
      nodeId: toNum(pick(node, ['nodeId'], 0), 0),
      displayId: toNum(pick(node, ['nodeId'], 0), 0),
      wallet: String(
        pick(identity, ['walletAddress', 'wallet'], pick(node, ['wallet', 'walletAddress'], 'unknown')),
      ),
      url: String(pick(node, ['url'], '')),
      port: toNum(pick(node, ['port'], 0), 0),
      role: String(pick(node, ['role'], 'UNKNOWN')),
      status: String(pick(node, ['status'], 'unknown')),
      reachable: Boolean(pick(node, ['reachable', 'online'], true)),
      lastSeenAt: String(pick(node, ['lastSeenAt', 'lastHeartbeatAt'], nowIso())),
      });
    }) : [],
  };
}

async function resolveRaft() {
  const raft = await upstreamGet('/v1/aeron/raft-metrics');
  const election = pick(raft, ['electionMetrics'], {});
  const replication = pick(raft, ['replicationMetrics'], {});
  return {
    term: toNum(pick(election, ['currentTerm'], pick(raft, ['term', 'currentTerm'], 0)), 0),
    commitIndex: toNum(pick(raft, ['commitIndex'], 0), 0),
    appendRatePerSec: toNum(pick(raft, ['appendRatePerSec', 'appendRate'], 0), 0),
    electionCount24h: toNum(pick(election, ['electionCount24h', 'electionCount'], 0), 0),
    lastElectionAt: String(pick(election, ['lastElectionAt'], nowIso())),
    reachableValidators: toNum(pick(replication, ['reachableValidators'], 0), 0),
  };
}

async function resolveReplication() {
  const leaderBase = await resolveLeaderUpstreamBase();
  const replication = await upstreamGetSnapshot('/v1/ops/snapshots/replication', '/v1/aeron/replication-lag', leaderBase);
  const nodes = pick(replication, ['nodes', 'perNode'], []);
  return {
    status: String(pick(replication, ['status'], pick(replication, ['healthy'], false) ? 'ok' : 'degraded')),
    maxLagMs: toNum(pick(replication, ['maxLagMs', 'maxLag', 'replicationLag'], 0), 0),
    p95LagMs: toNum(pick(replication, ['p95LagMs', 'p95Lag'], 0), 0),
    nodes: Array.isArray(nodes) ? nodes.map((node) => ({
      nodeId: toNum(pick(node, ['nodeId', 'id'], 0), 0),
      lagMs: toNum(pick(node, ['lagMs', 'lag'], 0), 0),
      status: String(pick(node, ['status'], 'unknown')),
    })) : [],
  };
}

async function resolveQueue() {
  const leaderBase = await resolveLeaderUpstreamBase();
  const queue = await resolveClusterQueueSnapshot(leaderBase);
  const signals = resolveQueueSignals(queue);
  const epochDepthResolved = Math.max(
    toNum(pick(queue, ['epochQueueDepth', 'epochDepth', 'epochsUntilFinality'], 0), 0),
    signals.pendingEpochs,
  );

  return {
    pendingCount: signals.queuePending,
    queuePendingCount: signals.queuePending,
    mempoolCount: signals.mempool,
    backpressurePendingCount: signals.backpressurePending,
    backpressureMaxPending: signals.backpressureMax,
    backpressureActive: signals.backpressureActive,
    epochQueueDepth: epochDepthResolved,
    oldestPendingAgeMs: toNum(pick(queue, ['oldestPendingAgeMs', 'oldestAgeMs'], 0), 0),
    ingressRatePerSec: toNum(pick(queue, ['ingressRatePerSec', 'inRate'], 0), 0),
    egressRatePerSec: toNum(pick(queue, ['egressRatePerSec', 'outRate'], 0), 0),
  };
}

async function resolveProposalsQueueStats() {
  const leaderBase = await resolveLeaderUpstreamBase();
  return resolveClusterQueueSnapshot(leaderBase);
}

async function resolveProposals() {
  const leaderBase = await resolveLeaderUpstreamBase();
  const queue = await resolveClusterQueueSnapshot(leaderBase);
  const signals = resolveQueueSignals(queue);

  const writeTotal = toNum(pick(queue, ['writeProposals'], 0), 0);
  const deleteTotal = toNum(pick(queue, ['deleteProposals'], 0), 0);
  const totalProposals = Math.max(
    toNum(pick(queue, ['totalProposals'], 0), 0),
    writeTotal + deleteTotal,
  );
  const finalized = toNum(pick(queue, ['totalFinalizedCount'], 0), 0);
  const verified = Math.max(
    toNum(pick(queue, ['totalVerifiedCount', 'verifiedCount'], 0), 0),
    0,
  );
  const rejected = Math.max(
    toNum(pick(queue, ['totalRejectedCount', 'rejectedCount', 'verifierRejectedCount'], 0), 0),
    0,
  );
  const unverified = Math.max(
    toNum(pick(queue, ['unverifiedQueueSize'], 0), 0) + toNum(pick(queue, ['pendingCount'], 0), 0),
    0,
  );

  return {
    queuePressure: {
      pending: signals.queuePending,
      queuePending: signals.queuePending,
      mempool: signals.mempool,
      backpressurePending: signals.backpressurePending,
      backpressureMax: signals.backpressureMax,
      backpressureActive: signals.backpressureActive,
      backpressureSent: signals.backpressureSent,
      backpressureAcked: signals.backpressureAcked,
    },
    states: {
      unverified,
      verified,
      finalized,
      rejected,
    },
    types: {
      write: writeTotal,
      delete: deleteTotal,
      total: totalProposals,
    },
    // Current upstream queue stats expose per-state totals and per-type totals separately.
    // Per-type state slices are not yet available as first-class counters.
    stateByType: {
      write: {
        unverified: null,
        verified: null,
        finalized: null,
        rejected: null,
      },
      delete: {
        unverified: null,
        verified: null,
        finalized: null,
        rejected: null,
      },
      availability: 'needs_upstream_counters',
    },
    epochs: {
      currentEpoch: toNum(pick(queue, ['currentEpoch'], 0), 0),
      finalizedEpoch: toNum(pick(queue, ['finalizedEpoch'], 0), 0),
      epochsUntilFinality: toNum(pick(queue, ['epochsUntilFinality'], 0), 0),
      pendingEpochs: signals.pendingEpochs,
      totalQueued: signals.totalQueuedFromStats !== null ? signals.totalQueuedFromStats : totalProposals,
    },
  };
}

function staticProposalReleaseFlow() {
  return {
    contractVersion: 'proposal.release-flow.v1',
    source: 'mock-static',
    schedulerModel: 'adaptive-capacity',
    releaseMode: 'adaptive-active',
    requiredConfirmations: 1,
    priorityDirectReleaseEnabled: false,
    currentEpoch: 1057,
    finalizedEpoch: 1055,
    epochsUntilFinality: 2,
    releaseStages: {
      unverifiedMempoolCount: 148,
      verifiedPackingBufferCount: 96,
      releaseReadyProposalCount: 54,
      releaseReadyBatchCount: 6,
      backpressureOverflowProposalCount: 12,
      backpressureOverflowBatchCount: 2,
      verifiedResidentProposalCount: 162,
    },
    governor: {
      state: 'THROTTLED',
      action: 'PACK_AND_THROTTLE',
      reasonCodes: ['BACKPRESSURE_PENDING_HIGH'],
      backpressureActive: true,
      backpressurePendingCount: 18,
      backpressureMaxPending: 64,
      pendingOldestMs: 880,
      pendingStalledMs: 0,
    },
    packing: {
      walletCount: 5,
      queuedProposalCountTotal: 2180,
      drainedProposalCountTotal: 2018,
      createdBatchCountTotal: 186,
    },
    overflow: {
      separateBufferEnabled: true,
      bufferedBatchCountTotal: 8,
      bufferedProposalCountTotal: 43,
      promotedBatchCountTotal: 6,
      promotedProposalCountTotal: 31,
    },
    throughput: {
      priorityProposalsSent: 0,
      batchedProposalsSent: 11840,
      totalProposalsSent: 11840,
      totalFinalizedCount: 9440,
      totalRejectedCount: 24,
    },
    epochCompatibility: {
      source: 'compatibility-epoch-overlay',
      pendingEpochs: 3,
      pendingEpochStats: 'Pending Proposals: 270, Pending Epochs: 3, Total Queued: 12186',
      replacementEndpoint: '/ops/v1/proposals/release-flow',
    },
    note: 'Adaptive release view shown with epoch compatibility metadata for operators still tracking finality cadence.',
  };
}

async function resolveProposalReleaseFlow() {
  try {
    const leaderBase = await resolveLeaderUpstreamBase();
    const upstream = await upstreamGetFromBase('/v1/proposals/release-flow', leaderBase);
    if (upstream && typeof upstream === 'object' && pick(upstream, ['releaseStages'], null)) {
      return upstream;
    }
  } catch (_e) {
    // Fall back to aggregate queue stats if the canonical route is unavailable.
  }

  const leaderBase = await resolveLeaderUpstreamBase();
  const queue = await resolveClusterQueueSnapshot(leaderBase).catch(() => ({}));
  const stageCounts = pick(queue, ['runtimeStageCounts'], {});
  const signals = resolveQueueSignals(queue);

  return {
    contractVersion: 'proposal.release-flow.v1',
    source: 'proxy-fallback-aggregate-counters',
    schedulerModel: 'adaptive-capacity',
    releaseMode: pick(queue, ['releaseMode'], 'adaptive-active'),
    requiredConfirmations: toNum(pick(queue, ['requiredConfirmations'], 1), 1),
    priorityDirectReleaseEnabled: Boolean(pick(queue, ['priorityDirectReleaseEnabled'], false)),
    currentEpoch: toNum(pick(queue, ['currentEpoch'], 0), 0),
    finalizedEpoch: toNum(pick(queue, ['finalizedEpoch'], 0), 0),
    epochsUntilFinality: toNum(pick(queue, ['epochsUntilFinality'], 0), 0),
    releaseStages: {
      unverifiedMempoolCount: Math.max(
        toNum(pick(stageCounts, ['unverifiedMempoolCount'], 0), 0),
        toNum(pick(queue, ['mempoolPendingCount', 'unverifiedQueueSize', 'pendingCount'], 0), 0),
      ),
      verifiedPackingBufferCount: Math.max(
        toNum(pick(stageCounts, ['verifiedPackingBufferCount', 'adaptiveVerifiedPackingBufferCount'], 0), 0),
        toNum(pick(queue, ['verifiedPackingBufferCount', 'adaptiveVerifiedPackingBufferCount'], 0), 0),
      ),
      releaseReadyProposalCount: Math.max(
        toNum(pick(stageCounts, ['releaseReadyProposalCount'], 0), 0),
        toNum(pick(queue, ['releaseReadyProposalCount', 'batchQueueSize'], 0), 0),
      ),
      releaseReadyBatchCount: Math.max(
        toNum(pick(stageCounts, ['releaseReadyBatchCount'], 0), 0),
        toNum(pick(queue, ['releaseReadyBatchCount'], 0), 0),
      ),
      backpressureOverflowProposalCount: Math.max(
        toNum(pick(stageCounts, ['backpressureOverflowProposalCount'], 0), 0),
        toNum(pick(queue, ['backpressureOverflowProposalCount'], 0), 0),
      ),
      backpressureOverflowBatchCount: Math.max(
        toNum(pick(stageCounts, ['backpressureOverflowBatchCount'], 0), 0),
        toNum(pick(queue, ['backpressureOverflowBatchCount'], 0), 0),
      ),
      verifiedResidentProposalCount: Math.max(
        toNum(pick(stageCounts, ['verifiedResidentProposalCount'], 0), 0),
        toNum(pick(queue, ['verifiedResidentProposalCount'], 0), 0),
      ),
    },
    governor: {
      state: pick(queue, ['adaptiveReleaseGovernorState'], 'UNKNOWN'),
      action: pick(queue, ['adaptiveReleaseAction'], 'UNKNOWN'),
      reasonCodes: pick(queue, ['adaptiveReleaseReasonCodes'], []),
      backpressureActive: Boolean(pick(queue, ['backpressureActive'], false)),
      backpressurePendingCount: signals.backpressurePending,
      backpressureMaxPending: toNum(pick(queue, ['backpressureMaxPending'], 0), 0),
      pendingOldestMs: toNum(pick(queue, ['backpressurePendingOldestMs'], 0), 0),
      pendingStalledMs: toNum(pick(queue, ['backpressurePendingStalledMs'], 0), 0),
    },
    packing: {
      walletCount: toNum(pick(queue, ['adaptivePackingWalletCount'], 0), 0),
      queuedProposalCountTotal: toNum(pick(queue, ['adaptivePackingQueuedProposalCountTotal'], 0), 0),
      drainedProposalCountTotal: toNum(pick(queue, ['adaptivePackingDrainedProposalCountTotal'], 0), 0),
      createdBatchCountTotal: toNum(pick(queue, ['adaptivePackingCreatedBatchCountTotal'], 0), 0),
    },
    overflow: {
      separateBufferEnabled: Boolean(
        pick(stageCounts, ['backpressureOverflowSeparateBufferEnabled'], true),
      ),
      bufferedBatchCountTotal: toNum(pick(queue, ['backpressureOverflowBufferedBatchCountTotal'], 0), 0),
      bufferedProposalCountTotal: toNum(pick(queue, ['backpressureOverflowBufferedProposalCountTotal'], 0), 0),
      promotedBatchCountTotal: toNum(pick(queue, ['backpressureOverflowPromotedBatchCountTotal'], 0), 0),
      promotedProposalCountTotal: toNum(pick(queue, ['backpressureOverflowPromotedProposalCountTotal'], 0), 0),
    },
    throughput: {
      priorityProposalsSent: toNum(pick(queue, ['priorityProposalsSent'], 0), 0),
      batchedProposalsSent: toNum(pick(queue, ['batchedProposalsSent'], 0), 0),
      totalProposalsSent: toNum(pick(queue, ['totalProposalsSent'], 0), 0),
      totalFinalizedCount: toNum(pick(queue, ['totalFinalizedCount'], 0), 0),
      totalRejectedCount: toNum(pick(queue, ['totalRejectedCount'], 0), 0),
    },
    epochCompatibility: {
      source: 'compatibility-epoch-overlay',
      pendingEpochs: signals.pendingEpochs,
      pendingEpochStats: pick(queue, ['pendingEpochStats'], null),
      replacementEndpoint: '/ops/v1/proposals/release-flow',
    },
    note: 'Adaptive verified-release view derived from aggregate queue stats fallback.',
  };
}

async function resolveSignals() {
  const [overview, queue, replication, health] = await Promise.all([
    resolveOverview().catch(() => ({})),
    resolveProposalsQueueStats().catch(() => ({})),
    resolveReplication().catch(() => ({})),
    resolveHealth().catch(() => ({})),
  ]);

  const cluster = pick(overview, ['cluster'], {});
  const q = pick(overview, ['queue'], {});
  const durability = pick(overview, ['durability'], {});
  const replicationNodes = Array.isArray(pick(replication, ['nodes'], [])) ? pick(replication, ['nodes'], []) : [];
  const deep = pick(health, ['deep'], {});
  const deepMedia = pick(deep, ['mediaDriver'], {});
  const deepDisk = pick(deep, ['diskSpace'], {});

  const verifierQueueWaitAvgMs = toNum(pick(queue, ['verifierQueueWaitAvgMs'], 0), 0);
  const verifierQueueWaitMaxMs = toNum(pick(queue, ['verifierQueueWaitMaxMs'], 0), 0);
  const verifierErrorCount = toNum(pick(queue, ['verifierErrorCount'], 0), 0);

  const signals = [
    buildSignal({
      id: 'cluster.reachable_validators',
      label: 'Reachable Validators',
      category: 'cluster',
      value: toNum(pick(cluster, ['reachableNodes'], 0), 0),
      unit: 'count',
      warnThreshold: Math.max(toNum(pick(cluster, ['nodeCount'], 0), 0) - 1, 1),
      criticalThreshold: Math.max(toNum(pick(cluster, ['nodeCount'], 0), 0) - 2, 1),
      direction: 'low',
      source: '/v1/consensus/status',
      description: 'Validators currently reachable by consensus layer.',
    }),
    buildSignal({
      id: 'queue.pending',
      label: 'Queue Pending',
      category: 'queue',
      value: toNum(pick(q, ['queuePending', 'pending'], 0), 0),
      unit: 'count',
      warnThreshold: 2000,
      criticalThreshold: 8000,
      source: '/v1/proposals/queue/stats',
      description: 'Queued proposals waiting for processing.',
    }),
    buildSignal({
      id: 'queue.mempool',
      label: 'Mempool',
      category: 'queue',
      value: toNum(pick(q, ['mempool'], 0), 0),
      unit: 'count',
      warnThreshold: 2000,
      criticalThreshold: 8000,
      source: '/v1/proposals/queue/stats',
      description: 'Unverified proposal backlog.',
    }),
    buildSignal({
      id: 'queue.backpressure_pending',
      label: 'Backpressure Pending',
      category: 'queue',
      value: toNum(pick(q, ['backpressurePending'], 0), 0),
      unit: 'count',
      warnThreshold: 2000,
      criticalThreshold: 8000,
      source: '/v1/proposals/queue/stats',
      description: 'Sender backlog currently under backpressure management.',
    }),
    buildSignal({
      id: 'verifier.queue_wait_avg_ms',
      label: 'Verifier Queue Wait Avg',
      category: 'queue',
      value: verifierQueueWaitAvgMs,
      unit: 'ms',
      warnThreshold: 250,
      criticalThreshold: 1000,
      source: '/v1/proposals/queue/stats',
      description: 'Average time proposals wait before verifier processing.',
    }),
    buildSignal({
      id: 'verifier.queue_wait_max_ms',
      label: 'Verifier Queue Wait Max',
      category: 'queue',
      value: verifierQueueWaitMaxMs,
      unit: 'ms',
      warnThreshold: 2000,
      criticalThreshold: 10000,
      source: '/v1/proposals/queue/stats',
      description: 'Worst observed verifier queue wait.',
    }),
    buildSignal({
      id: 'verifier.error_count',
      label: 'Verifier Errors',
      category: 'queue',
      value: verifierErrorCount,
      unit: 'count',
      warnThreshold: 1,
      criticalThreshold: 10,
      source: '/v1/proposals/queue/stats',
      description: 'Verifier processing errors observed.',
    }),
    buildSignal({
      id: 'durability.pending_acks',
      label: 'Durability Pending Acks',
      category: 'durability',
      value: toNum(pick(durability, ['pendingAcks'], 0), 0),
      unit: 'count',
      warnThreshold: 200,
      criticalThreshold: 1000,
      source: '/v1/proposals/queue/stats',
      description: 'Pending durability acknowledgements.',
    }),
    buildSignal({
      id: 'durability.ack_timeouts',
      label: 'Durability Ack Timeouts',
      category: 'durability',
      value: toNum(pick(durability, ['ackTimeouts'], 0), 0),
      unit: 'count',
      warnThreshold: 1,
      criticalThreshold: 5,
      source: '/v1/proposals/queue/stats',
      description: 'Ack timeout retries observed in active window.',
    }),
    buildSignal({
      id: 'replication.max_lag_ms',
      label: 'Replication Max Lag',
      category: 'replication',
      value: toNum(pick(pick(overview, ['replication'], {}), ['maxLagMs'], 0), 0),
      unit: 'ms',
      warnThreshold: 1000,
      criticalThreshold: 5000,
      source: '/v1/aeron/replication-lag',
      description: 'Worst observed lag among replicas.',
    }),
    buildSignal({
      id: 'replication.degraded_nodes',
      label: 'Replication Degraded Nodes',
      category: 'replication',
      value: replicationNodes.filter((node) => String(pick(node, ['status'], '')).toLowerCase() !== 'ok').length,
      unit: 'count',
      warnThreshold: 1,
      criticalThreshold: 2,
      source: '/v1/aeron/replication-lag',
      description: 'Replica nodes currently reporting degraded replication.',
    }),
    buildSignal({
      id: 'media_driver.error_count',
      label: 'MediaDriver Errors',
      category: 'aeron',
      value: toNum(pick(deepMedia, ['errorCount'], 0), 0),
      unit: 'count',
      warnThreshold: 1,
      criticalThreshold: 10,
      source: '/health/deep',
      description: 'Media driver reported error events.',
    }),
    buildSignal({
      id: 'media_driver.timeout_count',
      label: 'MediaDriver Timeouts',
      category: 'aeron',
      value: toNum(pick(deepMedia, ['timeoutCount'], 0), 0),
      unit: 'count',
      warnThreshold: 1,
      criticalThreshold: 10,
      source: '/health/deep',
      description: 'Media driver timeout events.',
    }),
    buildSignal({
      id: 'media_driver.backpressure_count',
      label: 'MediaDriver Backpressure',
      category: 'aeron',
      value: toNum(pick(deepMedia, ['backpressureCount'], 0), 0),
      unit: 'count',
      warnThreshold: 1,
      criticalThreshold: 10,
      source: '/health/deep',
      description: 'Backpressure events tracked by media driver.',
    }),
    buildSignal({
      id: 'disk.usage_percent',
      label: 'Disk Usage',
      category: 'storage',
      value: toNum(pick(deepDisk, ['usagePercent'], 0), 0),
      unit: 'percent',
      warnThreshold: 80,
      criticalThreshold: 90,
      source: '/health/deep',
      description: 'Validator disk usage percentage.',
    }),
  ];

  const summary = signals.reduce((acc, signal) => {
    const key = signal.severity in acc ? signal.severity : 'unknown';
    acc[key] += 1;
    return acc;
  }, { critical: 0, warn: 0, ok: 0, unknown: 0 });

  return {
    status: summary.critical > 0 ? 'critical' : summary.warn > 0 ? 'warn' : 'ok',
    summary,
    categories: [...new Set(signals.map((signal) => signal.category))],
    signals,
    generatedAt: nowIso(),
  };
}

async function resolveDurability() {
  const leaderBase = await resolveLeaderUpstreamBase();
  const queue = await upstreamGetSnapshot('/v1/ops/snapshots/queue', '/v1/proposals/queue/stats', leaderBase);
  return {
    status: 'ok',
    pendingAcks: toNum(pick(queue, ['persistencePendingChanges'], 0), 0),
    ackTimeouts1h: toNum(pick(queue, ['maxRetryCount'], 0), 0),
    lastAckAt: nowIso(),
  };
}

async function resolveHealth() {
  const [opsHealth, shallow, deepRaw] = await Promise.all([
    upstreamGetSnapshot('/v1/ops/snapshots/health', '/health').catch(() => ({})),
    upstreamGet('/health'),
    upstreamGetText('/health/deep').catch(() => ''),
  ]);
  let deep = parseJsonSafe(deepRaw, {});
  if (!deep || Object.keys(deep).length === 0) {
    deep = extractBlobStoreFromMalformedDeepHealth(deepRaw);
  }
  const deepCluster = pick(deep, ['cluster'], {});
  const deepDisk = pick(deep, ['diskSpace'], {});
  const deepNodeStore = pick(deep, ['nodeStore'], {});
  const deepMedia = pick(deep, ['mediaDriver'], {});
  const deepConsensus = pick(deep, ['consensus'], {});
  const deepClients = pick(deep, ['clients'], {});
  const deepBlob = pick(deep, ['blobStore'], {});
  return {
    status: String(pick(opsHealth, ['status'], pick(shallow, ['status'], pick(deep, ['success'], false) ? 'healthy' : 'degraded')),
    ).toLowerCase(),
    checks: {
      cluster: String(pick(opsHealth, ['status'], pick(deepCluster, ['status'], 'unknown'))),
      storage: String(pick(deepNodeStore, ['status'], pick(deepDisk, ['status'], 'unknown'))),
      network: String(pick(shallow, ['clusterStatus'], 'unknown')),
      api: String(pick(shallow, ['status'], 'unknown')),
    },
    deep: {
      cluster: {
        status: String(pick(deepCluster, ['status'], 'unknown')),
        reachableCount: toNum(pick(deepCluster, ['reachableCount'], 0), 0),
        totalMembers: toNum(pick(deepCluster, ['totalMembers'], 0), 0),
        quorumSize: toNum(pick(deepCluster, ['quorumSize'], 0), 0),
      },
      diskSpace: {
        status: String(pick(deepDisk, ['status'], 'unknown')),
        usagePercent: toNum(pick(deepDisk, ['usagePercent'], 0), 0),
        usableGb: toNum(pick(deepDisk, ['usableGb'], 0), 0),
      },
      mediaDriver: {
        status: String(pick(deepMedia, ['status'], 'unknown')),
        healthStatus: String(pick(deepMedia, ['healthStatus'], 'unknown')),
        errorCount: toNum(pick(deepMedia, ['errorCount'], 0), 0),
        timeoutCount: toNum(pick(deepMedia, ['timeoutCount'], 0), 0),
        backpressureCount: toNum(pick(deepMedia, ['backpressureCount'], 0), 0),
      },
      consensus: {
        status: String(pick(deepConsensus, ['status'], 'unknown')),
        mode: String(pick(deepConsensus, ['mode'], 'unknown')),
        role: String(pick(deepConsensus, ['role'], 'unknown')),
        term: toNum(pick(deepConsensus, ['term'], 0), 0),
        epoch: toNum(pick(deepConsensus, ['epoch'], 0), 0),
      },
      clients: {
        status: String(pick(deepClients, ['status'], 'unknown')),
        registeredClients: toNum(pick(deepClients, ['registeredClients'], 0), 0),
        registeredValidators: toNum(pick(deepClients, ['registeredValidators'], 0), 0),
      },
      blobStore: {
        type: String(pick(deepBlob, ['type'], 'unknown')).toUpperCase(),
        status: String(pick(deepBlob, ['status'], 'unknown')).toUpperCase(),
        cidMappingAvailable: Boolean(pick(deepBlob, ['cidMappingAvailable'], false)),
        ipfsGateway: pick(deepBlob, ['ipfsGateway'], null),
      },
    },
  };
}

async function resolveEventsRecent(url) {
  const limit = Number(url.searchParams.get('limit') || 12);
  const recent = await upstreamGet(`/v1/events/recent?limit=${Math.max(1, Math.min(limit, 50))}`);
  const events = pick(recent, ['events', 'recentEvents'], []);
  return {
    events: Array.isArray(events) ? events.map((event, index) => ({
      id: String(pick(event, ['id'], `evt-${index + 1}`)),
      timestamp: String(pick(event, ['timestamp', 'time'], nowIso())),
      type: String(pick(event, ['type', 'eventType'], 'EVENT')),
      severity: String(pick(event, ['severity', 'level'], 'info')),
      message: String(pick(event, ['message', 'description'], '')),
      attributes: pick(event, ['attributes'], {}),
    })) : [],
  };
}

async function resolveEventsStats() {
  const stats = await upstreamGet('/v1/events/stats');
  return {
    total24h: toNum(pick(stats, ['total24h', 'totalEventsBroadcast', 'totalEvents', 'total'], 0), 0),
    bySeverity: pick(stats, ['bySeverity'], {}),
    byType: pick(stats, ['byType'], {}),
  };
}

async function resolveTransactionsSummary() {
  const consensus = await upstreamGet('/v1/consensus/status');
  return {
    states: {
      STARTED: toNum(pick(consensus, ['txStarted', 'startedCount'], 0), 0),
      COMMITTED: toNum(pick(consensus, ['txCommitted', 'committedCount'], 0), 0),
      ABORTED: toNum(pick(consensus, ['txAborted', 'abortedCount'], 0), 0),
      TIMED_OUT: toNum(pick(consensus, ['txTimedOut', 'timedOutCount'], 0), 0),
    },
    windowMinutes: 60,
  };
}

async function resolveFinality() {
  const [consensus, queue] = await Promise.all([
    upstreamGet('/v1/consensus/status'),
    upstreamGetSnapshot('/v1/ops/snapshots/queue', '/v1/proposals/queue/stats'),
  ]);
  const signals = resolveQueueSignals(queue);
  return {
    currentEpoch: toNum(pick(queue, ['currentEpoch'], pick(consensus, ['currentEpoch'], 0)), 0),
    ethereumEpoch: toNum(pick(consensus, ['ethereumEpoch'], 0), 0),
    finalizedEpoch: toNum(pick(queue, ['finalizedEpoch'], 0), 0),
    epochsUntilFinality: toNum(pick(queue, ['epochsUntilFinality'], 0), 0),
    pendingProposals: signals.queuePending,
    pendingEpochs: signals.pendingEpochs,
    totalQueued: signals.totalQueuedFromStats !== null
      ? signals.totalQueuedFromStats
      : toNum(pick(queue, ['totalProposals', 'writeProposals'], 0), 0),
    backpressurePending: signals.backpressurePending,
    totalFinalized: toNum(pick(queue, ['totalFinalizedCount'], 0), 0),
  };
}

async function resolveTarData() {
  const tarFiles = await upstreamGet('/api/segments/tars');
  return Array.isArray(tarFiles) ? tarFiles : [];
}

async function resolveTarmkGrowth() {
  const [tarFiles, deepHealth] = await Promise.all([
    resolveTarData(),
    upstreamGet('/health/deep').catch(() => ({})),
  ]);
  const sizes = tarFiles.map((t) => toNum(t.size, 0)).filter((s) => s >= 0);
  const totalSizeBytes = sizes.reduce((sum, n) => sum + n, 0);
  const tarFileCount = tarFiles.length;
  const avgSizeBytes = tarFileCount ? Math.round(totalSizeBytes / tarFileCount) : 0;
  const minSizeBytes = sizes.length ? Math.min(...sizes) : 0;
  const maxSizeBytes = sizes.length ? Math.max(...sizes) : 0;
  const segmentCount = tarFiles.reduce((sum, t) => sum + toNum(t.segmentCount, 0), 0);
  const targetTarBytes = 256 * 1024 * 1024;
  const packingEfficiency = targetTarBytes > 0 ? (avgSizeBytes / targetTarBytes) * 100 : 0;
  const packingEfficiencyPct = Math.round(Math.max(0, packingEfficiency) * 10) / 10;
  const packingStatus = packingEfficiencyPct >= 80
    ? 'Very high packing efficiency'
    : packingEfficiencyPct >= 50
      ? 'Moderate packing efficiency'
      : 'Low packing efficiency';
  const fileStore = pick(deepHealth, ['fileStore'], {});
  return {
    tarFileCount,
    segmentCount,
    totalSizeBytes,
    totalSizeFormatted: formatBytes(totalSizeBytes),
    avgSizeBytes,
    avgSizeFormatted: formatBytes(avgSizeBytes),
    minSizeBytes,
    minSizeFormatted: formatBytes(minSizeBytes),
    maxSizeBytes,
    maxSizeFormatted: formatBytes(maxSizeBytes),
    targetTarSizeBytes: targetTarBytes,
    targetTarSizeFormatted: formatBytes(targetTarBytes),
    packingEfficiencyPct,
    packingStatus,
    latestHead: String(pick(fileStore, ['latestHead', 'head'], 'unknown')),
  };
}

async function resolveTarChain() {
  const tarFiles = await resolveTarData();
  const maxTarSize = 256 * 1024 * 1024;
  const largestActual = tarFiles.length ? Math.max(...tarFiles.map((t) => toNum(t.size, 0))) : 0;
  const scalingMax = Math.max(maxTarSize, largestActual);
  return {
    maxTarSizeBytes: maxTarSize,
    maxTarSizeFormatted: formatBytes(maxTarSize),
    tarFiles: tarFiles.map((tar, index) => {
      const size = toNum(tar.size, 0);
      const efficiencyPct = scalingMax > 0 ? (size / maxTarSize) * 100 : 0;
      const widthPct = scalingMax > 0 ? (size / scalingMax) * 100 : 0;
      return {
        id: index,
        name: String(tar.name || `data${index}.tar`),
        sizeBytes: size,
        sizeFormatted: String(tar.sizeFormatted || formatBytes(size)),
        segmentCount: toNum(tar.segmentCount, 0),
        efficiencyPct: Math.round(efficiencyPct * 10) / 10,
        widthPct: Math.max(4, Math.round(widthPct * 100) / 100),
        created: String(pick(tar, ['created'], '')),
      };
    }),
  };
}

async function resolveTransactionDetail(transactionId) {
  const consensus = await upstreamGet('/v1/consensus/status');
  return {
    transactionId,
    correlationId: String(pick(consensus, ['correlationId'], 'unknown')),
    status: String(pick(consensus, ['transactionStatus'], 'UNKNOWN')),
    startedAt: String(pick(consensus, ['startedAt'], nowIso())),
    updatedAt: String(pick(consensus, ['updatedAt'], nowIso())),
    timeoutMs: toNum(pick(consensus, ['timeoutMs'], 0), 0),
    reason: pick(consensus, ['reason'], null),
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  sendJson(res, 404, {
    version: 'v1',
    generatedAt: nowIso(),
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found',
      retryable: false,
    },
  });
}

function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method !== 'GET') {
    sendJson(res, 405, {
      version: 'v1',
      generatedAt: nowIso(),
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Only GET supported by mock server',
        retryable: false,
      },
    });
    return;
  }

  if (path === '/ops/v1/overview' && MODE === 'static') {
    sendJson(res, 200, envelope({
      status: 'healthy',
      leader: { nodeId: 1, wallet: '0xabc123...def', term: 42, since: nowIso() },
      cluster: { nodeCount: 3, quorum: 2, reachableNodes: 3 },
      queue: { pending: 4, mempool: 11, oldestPendingAgeMs: 820 },
      replication: { maxLagMs: 55, maxLagNodeId: 2, status: 'ok' },
      durability: { pendingAcks: 2, ackTimeouts: 0, status: 'ok' },
    }));
    return;
  }

  if (path === '/ops/v1/header' && MODE === 'static') {
    sendJson(res, 200, envelope({
      title: 'Blockchain AEM',
      subtitle: 'Global P2P Oak Repository',
      validator: { nodeId: 0, role: 'LEADER', label: 'Validator 0 LEADER' },
      binaries: { type: 'IPFS', label: 'Binaries IPFS' },
      ipfs: { daemonStatus: 'UP', enabled: true, gateway: 'http://127.0.0.1:8080/ipfs/' },
      mode: 'mock',
      clusterWallet: '0xb677f46bf164d6b3c62fc1b643c3a294466bbc9d',
      clusterWalletShort: '0xb677f46b...466bbc9d',
      networkStatus: 'HEALTHY',
    }));
    return;
  }

  if (path === '/ops/v1/explorer/summary' && MODE === 'static') {
    sendJson(res, 200, envelope({
      contractVersion: 'explorer.v1',
      generatedAtMs: Date.now(),
      cluster: {
        consensusType: 'aeron-cluster',
        role: 'LEADER',
        isLeader: true,
        currentLeader: 'http://localhost:8090',
        currentTerm: 1,
        currentEpoch: 1002,
        ethereumEpoch: 1000,
        nodeCount: 3,
        quorum: 2,
        reachableValidators: 3,
        clusterState: 'HEALTHY',
      },
      queue: {
        compact: {
          queuePending: 0,
          pendingCount: 0,
          batchQueueSize: 0,
          mempoolPendingCount: 0,
          verified: 0,
          finalized: 0,
          gap: 0,
          rejected: 0,
          backpressurePending: 0,
          backpressurePendingRaw: 0,
          backpressureMax: 10000,
          backpressureActive: false,
          releaseMode: 'adaptive-active',
          requiredConfirmations: 1,
          verifiedResidentProposalCount: 0,
          releaseReadyProposalCount: 0,
          backpressureOverflowProposalCount: 0,
          adaptiveReleaseGovernorState: 'HEALTHY',
          adaptiveReleaseAction: 'DIRECT',
          currentEpoch: 1002,
          finalizedEpoch: 1000,
          epochsUntilFinality: 2,
        },
      },
    }));
    return;
  }

  if (path === '/ops/v1/cluster' && MODE === 'static') {
    sendJson(res, 200, envelope({
      clusterState: 'ACTIVE',
      term: 42,
      leaderNodeId: 1,
      nodes: [
        { nodeId: 0, wallet: '0x111...', role: 'FOLLOWER', status: 'ready', reachable: true, lastSeenAt: nowIso() },
        { nodeId: 1, wallet: '0x222...', role: 'LEADER', status: 'ready', reachable: true, lastSeenAt: nowIso() },
        { nodeId: 2, wallet: '0x333...', role: 'FOLLOWER', status: 'ready', reachable: true, lastSeenAt: nowIso() },
      ],
    }));
    return;
  }

  if (path === '/ops/v1/raft' && MODE === 'static') {
    sendJson(res, 200, envelope({
      term: 42,
      commitIndex: 12502,
      appendRatePerSec: 138,
      electionCount24h: 1,
      lastElectionAt: nowIso(),
    }));
    return;
  }

  if (path === '/ops/v1/replication' && MODE === 'static') {
    sendJson(res, 200, envelope({
      status: 'ok',
      maxLagMs: 55,
      p95LagMs: 31,
      nodes: [
        { nodeId: 0, lagMs: 24, status: 'ok' },
        { nodeId: 1, lagMs: 9, status: 'ok' },
        { nodeId: 2, lagMs: 55, status: 'ok' },
      ],
    }));
    return;
  }

  if (path === '/ops/v1/queue' && MODE === 'static') {
    sendJson(res, 200, envelope({
      pendingCount: 4,
      mempoolCount: 11,
      epochQueueDepth: 2,
      oldestPendingAgeMs: 820,
      ingressRatePerSec: 24,
      egressRatePerSec: 22,
    }));
    return;
  }

  if (path === '/ops/v1/proposals/queue/stats' && MODE === 'static') {
    sendJson(res, 200, envelope({
      unverifiedQueueSize: 0,
      mempoolPendingCount: 0,
      totalProposals: 12000,
      verifierRejectedCount: 0,
      currentEpoch: 1002,
      finalizedEpoch: 1000,
      batchQueueSize: 0,
      pendingCount: 0,
      epochsUntilFinality: 2,
      backpressureMaxPending: 10000,
      backpressureActive: false,
      backpressurePendingCount: 0,
      backpressureStats: 'BackpressureManager[sent=12000, acked=12000, pending=0, max=10000, active=false]',
      persistencePendingChanges: 0,
      verifierErrorCount: 0,
      verifierQueueWaitMaxMs: 2,
      verifierQueueWaitAvgMs: 0,
      writeProposals: 12000,
      totalFinalizedCount: 12000,
      pendingEpochStats: 'Current Epoch: 1002, Pending Epochs: 0, Pending Proposals: 0, Total Queued: 12000, Total Finalized: 12000, Batches Created: 480',
    }));
    return;
  }

  if (path === '/ops/v1/proposals' && MODE === 'static') {
    sendJson(res, 200, envelope({
      queuePressure: {
        pending: 2488,
        mempool: 217,
        backpressurePending: 92,
        backpressureMax: 10000,
        backpressureActive: false,
        backpressureSent: 9402,
        backpressureAcked: 9310,
      },
      states: {
        unverified: 2488,
        verified: 9698,
        finalized: 9440,
        rejected: 24,
      },
      types: {
        write: 12186,
        delete: 88,
        total: 12274,
      },
      stateByType: {
        write: {
          unverified: null,
          verified: null,
          finalized: null,
          rejected: null,
        },
        delete: {
          unverified: null,
          verified: null,
          finalized: null,
          rejected: null,
        },
        availability: 'needs_upstream_counters',
      },
      epochs: {
        currentEpoch: 1057,
        finalizedEpoch: 1055,
        epochsUntilFinality: 2,
        pendingEpochs: 3,
        totalQueued: 12186,
      },
    }));
    return;
  }

  if ((path === '/ops/v1/proposals/release-flow' || path === '/ops/v1/explorer/release-flow') && MODE === 'static') {
    sendJson(res, 200, envelope(staticProposalReleaseFlow()));
    return;
  }

  if (path === '/ops/v1/signals' && MODE === 'static') {
    sendJson(res, 200, envelope({
      status: 'ok',
      summary: { critical: 0, warn: 0, ok: 4, unknown: 0 },
      categories: ['cluster', 'queue', 'durability', 'storage'],
      signals: [
        buildSignal({
          id: 'cluster.reachable_validators',
          label: 'Reachable Validators',
          category: 'cluster',
          value: 3,
          unit: 'count',
          warnThreshold: 2,
          criticalThreshold: 1,
          direction: 'low',
          source: '/v1/consensus/status',
          description: 'Validators currently reachable by consensus layer.',
        }),
        buildSignal({
          id: 'queue.pending',
          label: 'Queue Pending',
          category: 'queue',
          value: 0,
          unit: 'count',
          warnThreshold: 2000,
          criticalThreshold: 8000,
          source: '/v1/proposals/queue/stats',
          description: 'Queued proposals waiting for processing.',
        }),
        buildSignal({
          id: 'durability.pending_acks',
          label: 'Durability Pending Acks',
          category: 'durability',
          value: 0,
          unit: 'count',
          warnThreshold: 200,
          criticalThreshold: 1000,
          source: '/v1/proposals/queue/stats',
          description: 'Pending durability acknowledgements.',
        }),
        buildSignal({
          id: 'disk.usage_percent',
          label: 'Disk Usage',
          category: 'storage',
          value: 42.5,
          unit: 'percent',
          warnThreshold: 80,
          criticalThreshold: 90,
          source: '/health/deep',
          description: 'Validator disk usage percentage.',
        }),
      ],
      generatedAt: nowIso(),
    }));
    return;
  }

  if (path === '/ops/v1/config/osgi/delta' && MODE === 'static') {
    sendJson(res, 200, envelope({
      contractVersion: 'config.osgi.delta.v1',
      generatedAtMs: Date.now(),
      summary: {
        totalKeys: 89,
        changedKeys: 3,
        unchangedKeys: 86,
        expertOnlyChanged: 1,
        guardedChanged: 2,
        safeChanged: 0,
      },
      changed: [
        {
          key: 'proposalQueueTuning.release_mode',
          current: 'adaptive-active',
          default: 'adaptive-active',
          risk: 'guarded',
          reloadMode: 'runtime-readable',
          changed: false,
          justification: 'Adaptive release is the canonical runtime policy.',
        },
      ],
    }));
    return;
  }

  if (path === '/ops/v1/gc/status' && MODE === 'static') {
    sendJson(res, 200, envelope({
      gcEnabled: true,
      pendingProposals: 0,
      lastGcRun: null,
      lastGcReclaimedMB: null,
      lastGcCostUSDC: null,
      gcConsensusRequired: true,
    }));
    return;
  }

  if (path === '/ops/v1/durability' && MODE === 'static') {
    sendJson(res, 200, envelope({
      status: 'ok',
      pendingAcks: 2,
      ackTimeouts1h: 0,
      lastAckAt: nowIso(),
    }));
    return;
  }

  if (path === '/ops/v1/health' && MODE === 'static') {
    sendJson(res, 200, envelope({
      status: 'healthy',
      checks: {
        cluster: 'pass',
        storage: 'pass',
        network: 'pass',
        api: 'pass',
      },
    }));
    return;
  }

  if (path === '/ops/v1/events/recent' && MODE === 'static') {
    const limit = Number(url.searchParams.get('limit') || 12);
    const events = Array.from({ length: Math.max(1, Math.min(limit, 50)) }, (_, i) => ({
      id: `evt-${i + 1}`,
      timestamp: nowIso(),
      type: i % 4 === 0 ? 'LEADERSHIP_CHANGE' : 'QUEUE_BACKPRESSURE',
      severity: i % 7 === 0 ? 'warn' : 'info',
      message: i % 4 === 0 ? 'Leader changed to node 1' : 'Queue pressure above baseline',
      attributes: i % 4 === 0 ? { previousLeader: 0, newLeader: 1 } : { pendingCount: 4 + i, mempoolCount: 11 + i },
    }));
    sendJson(res, 200, envelope({ events }));
    return;
  }

  if (path === '/ops/v1/events/stats' && MODE === 'static') {
    sendJson(res, 200, envelope({
      total24h: 211,
      bySeverity: { info: 192, warn: 17, error: 2 },
      byType: { LEADERSHIP_CHANGE: 2, QUEUE_BACKPRESSURE: 9 },
    }));
    return;
  }

  if (path === '/ops/v1/transactions/summary' && MODE === 'static') {
    sendJson(res, 200, envelope({
      states: { STARTED: 3, COMMITTED: 1201, ABORTED: 8, TIMED_OUT: 1 },
      windowMinutes: 60,
    }));
    return;
  }

  if (path === '/ops/v1/finality' && MODE === 'static') {
    sendJson(res, 200, envelope({
      currentEpoch: 1047,
      ethereumEpoch: 1046,
      finalizedEpoch: 1045,
      epochsUntilFinality: 2,
      pendingProposals: 2488,
      pendingEpochs: 3,
      totalQueued: 12186,
      totalFinalized: 9698,
    }));
    return;
  }

  if (path === '/ops/v1/tarmk' && MODE === 'static') {
    sendJson(res, 200, envelope({
      tarFileCount: 3,
      segmentCount: 1617,
      totalSizeBytes: 31628800,
      totalSizeFormatted: '30.2 MB',
      avgSizeBytes: 10542933,
      avgSizeFormatted: '10.1 MB',
      minSizeBytes: 11264,
      minSizeFormatted: '11.0 KB',
      maxSizeBytes: 31597056,
      maxSizeFormatted: '30.1 MB',
      targetTarSizeBytes: 268435456,
      targetTarSizeFormatted: '256.0 MB',
      packingEfficiencyPct: 3.9,
      packingStatus: 'Low packing efficiency',
      latestHead: 'c4d4d2b6-d4b8-4ab2-ae49-7c1e2d89633d:464',
    }));
    return;
  }

  if (path === '/ops/v1/tar-chain' && MODE === 'static') {
    sendJson(res, 200, envelope({
      maxTarSizeBytes: 268435456,
      maxTarSizeFormatted: '256.0 MB',
      tarFiles: [
        { id: 0, name: 'data00000a.tar', sizeBytes: 31597056, sizeFormatted: '30.1 MB', segmentCount: 1616, efficiencyPct: 11.8, widthPct: 11.8, created: '2026-02-05T04:28:17Z' },
        { id: 1, name: 'data00001a.tar', sizeBytes: 11264, sizeFormatted: '11.0 KB', segmentCount: 0, efficiencyPct: 0, widthPct: 4, created: '2026-02-06T15:53:41Z' },
      ],
    }));
    return;
  }

  if (path.startsWith('/ops/v1/transactions/') && MODE === 'static') {
    const transactionId = path.substring('/ops/v1/transactions/'.length);
    sendJson(res, 200, envelope({
      transactionId,
      correlationId: 'corr-123',
      status: 'COMMITTED',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      timeoutMs: 30000,
      reason: null,
    }));
    return;
  }

  (async () => {
    try {
      if (path === '/ops/v1/overview') {
        sendJson(res, 200, envelope(await resolveOverview()));
        return;
      }
      if (path === '/ops/v1/header') {
        sendJson(res, 200, envelope(await resolveHeader()));
        return;
      }
      if (path === '/ops/v1/explorer/summary') {
        sendJson(res, 200, envelope(await resolveExplorerSummary()));
        return;
      }
      if (path === '/ops/v1/cluster') {
        sendJson(res, 200, envelope(await resolveCluster()));
        return;
      }
      if (path === '/ops/v1/raft') {
        sendJson(res, 200, envelope(await resolveRaft()));
        return;
      }
      if (path === '/ops/v1/replication') {
        sendJson(res, 200, envelope(await resolveReplication()));
        return;
      }
      if (path === '/ops/v1/queue') {
        sendJson(res, 200, envelope(await resolveQueue()));
        return;
      }
      if (path === '/ops/v1/signals') {
        sendJson(res, 200, envelope(await resolveSignals()));
        return;
      }
      if (path === '/ops/v1/proposals/queue/stats') {
        sendJson(res, 200, envelope(await resolveProposalsQueueStats()));
        return;
      }
      if (path === '/ops/v1/proposals') {
        sendJson(res, 200, envelope(await resolveProposals()));
        return;
      }
      if (path === '/ops/v1/proposals/release-flow' || path === '/ops/v1/explorer/release-flow') {
        sendJson(res, 200, envelope(await resolveProposalReleaseFlow()));
        return;
      }
      if (path === '/ops/v1/durability') {
        sendJson(res, 200, envelope(await resolveDurability()));
        return;
      }
      if (path === '/ops/v1/health') {
        sendJson(res, 200, envelope(await resolveHealth()));
        return;
      }
      if (path === '/ops/v1/events/recent') {
        sendJson(res, 200, envelope(await resolveEventsRecent(url)));
        return;
      }
      if (path === '/ops/v1/events/stats') {
        sendJson(res, 200, envelope(await resolveEventsStats()));
        return;
      }
      if (path === '/ops/v1/transactions/summary') {
        sendJson(res, 200, envelope(await resolveTransactionsSummary()));
        return;
      }
      if (path === '/ops/v1/config/osgi/delta') {
        sendJson(res, 200, envelope(await upstreamGetUnwrapped('/v1/config/osgi/delta')));
        return;
      }
      if (path === '/ops/v1/gc/status') {
        sendJson(res, 200, envelope(await upstreamGetUnwrapped('/v1/gc/status')));
        return;
      }
      if (path === '/ops/v1/finality') {
        sendJson(res, 200, envelope(await resolveFinality()));
        return;
      }
      if (path === '/ops/v1/tarmk') {
        sendJson(res, 200, envelope(await resolveTarmkGrowth()));
        return;
      }
      if (path === '/ops/v1/tar-chain') {
        sendJson(res, 200, envelope(await resolveTarChain()));
        return;
      }
      if (path.startsWith('/ops/v1/transactions/')) {
        const transactionId = path.substring('/ops/v1/transactions/'.length);
        sendJson(res, 200, envelope(await resolveTransactionDetail(transactionId)));
        return;
      }
      notFound(res);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[ops-api-mock] ${path} failed: ${error?.message || error}`);
      sendJson(res, 502, {
        version: 'v1',
        generatedAt: nowIso(),
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: error.message,
          retryable: true,
        },
      });
    }
  })();
}

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Ops API adapter listening on http://${HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Mode=${MODE} Upstream=${UPSTREAM_BASE}`);
});
