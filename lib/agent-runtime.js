// Durable, owner-bound runtime leases for user agent keys.
//
// A heartbeat never expands authority. Once an agent enrolls, new
// mission-scoped paper exposure fails closed while its lease is degraded,
// offline, draining, or bound to another mission. Existing positions remain
// protected by Position Guardian independently of the agent runtime.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'agent-runtimes.json');

export const AGENT_RUNTIME_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const DEGRADED_AFTER_MS = 45_000;
export const OFFLINE_AFTER_MS = 90_000;
const MAX_EVENTS = 100;
const STAGES = new Set(['idle', 'observe', 'analyze', 'risk-check', 'execute', 'verify', 'journal']);

function validStoredRuntime(runtime) {
  return runtime && typeof runtime === 'object'
    && typeof runtime.ownerId === 'string' && runtime.ownerId.length > 0
    && typeof runtime.keyId === 'string' && runtime.keyId.length > 0
    && /^rt_[a-f0-9]{24}$/.test(runtime.runtimeRef || '')
    && /^rs_[a-f0-9]{20}$/.test(runtime.sessionRef || '')
    && /^[a-f0-9]{64}$/.test(runtime.sessionHash || '')
    && Number.isFinite(runtime.lastHeartbeatAt)
    && Number.isSafeInteger(runtime.sequence) && runtime.sequence >= 1
    && ['ready', 'draining'].includes(runtime.declaredState)
    && runtime.checkpoint && /^cp_[a-f0-9-]{36}$/.test(runtime.checkpoint.checkpointId || '')
    && STAGES.has(runtime.checkpoint.stage);
}

function loadStore() {
  if (!existsSync(FILE)) return { version: AGENT_RUNTIME_VERSION, runtimes: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (error) {
    throw new Error(`agent runtime state is unreadable: ${error.message}`);
  }
  const identities = Array.isArray(parsed?.runtimes)
    ? parsed.runtimes.map((runtime) => `${runtime?.ownerId || ''}\u0000${runtime?.keyId || ''}`)
    : [];
  if (parsed?.version !== AGENT_RUNTIME_VERSION || !Array.isArray(parsed.runtimes)
      || parsed.runtimes.some((runtime) => !validStoredRuntime(runtime))
      || new Set(identities).size !== identities.length) {
    throw new Error('agent runtime state is invalid or uses an unsupported version');
  }
  return parsed;
}

let store = loadStore();

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}

const clean = (value, max) => String(value || '').trim().slice(0, max);
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const runtimeRef = (ownerId, keyId) => `rt_${digest(`${ownerId}:${keyId}`).slice(0, 24)}`;
const sessionRef = (sessionId) => `rs_${digest(sessionId).slice(0, 20)}`;

function health(runtime, now = Date.now()) {
  if (runtime.declaredState === 'draining') return { status: 'draining', ageMs: Math.max(0, now - runtime.lastHeartbeatAt) };
  const ageMs = Math.max(0, now - runtime.lastHeartbeatAt);
  if (ageMs <= DEGRADED_AFTER_MS) return { status: 'ready', ageMs };
  if (ageMs <= OFFLINE_AFTER_MS) return { status: 'degraded', ageMs };
  return { status: 'offline', ageMs };
}

function addEvent(runtime, type, now, extra = {}) {
  runtime.events ||= [];
  runtime.events.push({ eventId: crypto.randomUUID(), ts: now, type, ...extra });
  if (runtime.events.length > MAX_EVENTS) runtime.events.splice(0, runtime.events.length - MAX_EVENTS);
}

function publicRuntime(runtime, now = Date.now(), { replayed = false } = {}) {
  const current = health(runtime, now);
  return {
    runtimeRef: runtime.runtimeRef,
    name: runtime.agentName,
    status: current.status,
    ready: current.status === 'ready',
    enrolled: true,
    heartbeat: {
      intervalMs: HEARTBEAT_INTERVAL_MS,
      degradedAfterMs: DEGRADED_AFTER_MS,
      offlineAfterMs: OFFLINE_AFTER_MS,
      lastAt: runtime.lastHeartbeatAt,
      ageMs: current.ageMs,
      sequence: runtime.sequence,
      replayed,
    },
    session: {
      ref: runtime.sessionRef,
      startedAt: runtime.sessionStartedAt,
      recoveryCount: runtime.recoveryCount,
      lastRecoveredAt: runtime.lastRecoveredAt,
    },
    checkpoint: runtime.checkpoint ? { ...runtime.checkpoint } : null,
    recovery: {
      resumable: !!runtime.checkpoint,
      requiresExactCheckpoint: !!runtime.checkpoint,
      lastOutcome: runtime.lastRecoveryOutcome || 'initial-session',
    },
    execution: {
      newMissionExposureAllowed: current.status === 'ready',
      existingPositionProtection: 'position-guardian',
      authorityExpanded: false,
    },
    eventCount: runtime.events?.length || 0,
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

function validateHeartbeat(input) {
  const sessionId = clean(input.sessionId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(sessionId)) throw new Error('valid sessionId required');
  const sequence = Number(input.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2_147_483_647) throw new Error('sequence must be a positive integer');
  const stage = clean(input.stage || 'idle', 24);
  if (!STAGES.has(stage)) throw new Error('unsupported runtime stage');
  const missionId = clean(input.missionId, 128) || null;
  if (missionId && !/^msn_[a-z0-9]+$/.test(missionId)) throw new Error('invalid missionId');
  const state = clean(input.state || 'ready', 16);
  if (!['ready', 'draining'].includes(state)) throw new Error('unsupported runtime state');
  return {
    sessionId, sequence, stage, missionId, state,
    cursor: clean(input.cursor, 500) || null,
    resumeFromCheckpointId: clean(input.resumeFromCheckpointId, 80) || null,
  };
}

export function recordAgentHeartbeat({ ownerId, keyId, agentName, ...input }, now = Date.now()) {
  if (!ownerId || !keyId) throw new Error('user-bound agent identity required');
  const heartbeat = validateHeartbeat(input);
  const ref = runtimeRef(ownerId, keyId);
  let runtime = store.runtimes.find((item) => item.ownerId === ownerId && item.keyId === keyId) || null;
  const payloadHash = digest(JSON.stringify(heartbeat));

  if (!runtime) {
    if (heartbeat.sequence !== 1) throw new Error('initial heartbeat sequence must be 1');
    runtime = {
      runtimeRef: ref, ownerId, keyId, agentName: clean(agentName, 80) || 'Agent',
      sessionRef: sessionRef(heartbeat.sessionId), sessionHash: digest(heartbeat.sessionId),
      sessionStartedAt: now, lastHeartbeatAt: now, sequence: heartbeat.sequence,
      lastPayloadHash: payloadHash, declaredState: heartbeat.state,
      recoveryCount: 0, lastRecoveredAt: null, lastRecoveryOutcome: 'initial-session',
      checkpoint: null, events: [],
    };
    runtime.checkpoint = {
      checkpointId: `cp_${crypto.randomUUID()}`, missionId: heartbeat.missionId,
      stage: heartbeat.stage, cursor: heartbeat.cursor, recordedAt: now,
    };
    addEvent(runtime, 'enrolled', now, { stage: heartbeat.stage });
    store.runtimes.push(runtime);
    save();
    return publicRuntime(runtime, now);
  }

  const incomingSessionHash = digest(heartbeat.sessionId);
  if (incomingSessionHash === runtime.sessionHash) {
    if (heartbeat.sequence < runtime.sequence) throw new Error('heartbeat sequence is stale');
    if (heartbeat.sequence === runtime.sequence) {
      if (payloadHash !== runtime.lastPayloadHash) throw new Error('heartbeat sequence collision');
      return publicRuntime(runtime, now, { replayed: true });
    }
  } else {
    const previousHealth = health(runtime, now);
    if (!['offline', 'draining'].includes(previousHealth.status)) throw new Error('active runtime session conflict');
    if (heartbeat.sequence !== 1) throw new Error('recovery heartbeat sequence must restart at 1');
    if (runtime.checkpoint && heartbeat.resumeFromCheckpointId !== runtime.checkpoint.checkpointId) {
      throw new Error('exact recovery checkpoint required');
    }
    if (runtime.checkpoint && heartbeat.missionId !== runtime.checkpoint.missionId) {
      throw new Error('recovery mission must match checkpoint');
    }
    runtime.sessionHash = incomingSessionHash;
    runtime.sessionRef = sessionRef(heartbeat.sessionId);
    runtime.sessionStartedAt = now;
    runtime.recoveryCount += 1;
    runtime.lastRecoveredAt = now;
    runtime.lastRecoveryOutcome = 'exact-checkpoint-resumed';
    addEvent(runtime, 'recovered', now, { fromCheckpointId: runtime.checkpoint?.checkpointId || null });
  }

  runtime.agentName = clean(agentName, 80) || runtime.agentName;
  runtime.lastHeartbeatAt = now;
  runtime.sequence = heartbeat.sequence;
  runtime.lastPayloadHash = payloadHash;
  runtime.declaredState = heartbeat.state;
  runtime.checkpoint = {
    checkpointId: `cp_${crypto.randomUUID()}`, missionId: heartbeat.missionId,
    stage: heartbeat.stage, cursor: heartbeat.cursor, recordedAt: now,
  };
  addEvent(runtime, heartbeat.state === 'draining' ? 'draining' : 'heartbeat', now, { stage: heartbeat.stage });
  save();
  return publicRuntime(runtime, now);
}

export function agentRuntimeStatus(ownerId, keyId, now = Date.now()) {
  const runtime = store.runtimes.find((item) => item.ownerId === ownerId && item.keyId === keyId) || null;
  return runtime ? publicRuntime(runtime, now) : {
    status: 'not-enrolled', ready: false, enrolled: false,
    heartbeat: { intervalMs: HEARTBEAT_INTERVAL_MS, degradedAfterMs: DEGRADED_AFTER_MS, offlineAfterMs: OFFLINE_AFTER_MS, lastAt: null, ageMs: null, sequence: null, replayed: false },
    execution: { newMissionExposureAllowed: true, existingPositionProtection: 'position-guardian', authorityExpanded: false },
    liveScopeUsed: false, publicChainUsed: false,
  };
}

export function ownerRuntimeStatus(ownerId, now = Date.now()) {
  const runtimes = store.runtimes.filter((item) => item.ownerId === ownerId).map((runtime) => publicRuntime(runtime, now));
  const counts = { total: runtimes.length, ready: 0, degraded: 0, offline: 0, draining: 0 };
  for (const runtime of runtimes) if (Object.hasOwn(counts, runtime.status)) counts[runtime.status] += 1;
  return {
    ok: true, mode: 'paper-only', version: AGENT_RUNTIME_VERSION,
    policy: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, degradedAfterMs: DEGRADED_AFTER_MS, offlineAfterMs: OFFLINE_AFTER_MS },
    counts, runtimes, liveScopeUsed: false, publicChainUsed: false,
  };
}

export function missionRuntimeGate({ ownerId, keyId, missionId }, now = Date.now()) {
  if (!ownerId || !keyId || !missionId) return { ok: true, monitored: false, reason: null };
  const runtime = store.runtimes.find((item) => item.ownerId === ownerId && item.keyId === keyId) || null;
  if (!runtime) return { ok: true, monitored: false, reason: null };
  const current = health(runtime, now);
  if (current.status !== 'ready') return { ok: false, monitored: true, reason: `agent-runtime-${current.status}` };
  if (runtime.checkpoint?.missionId !== missionId) return { ok: false, monitored: true, reason: 'agent-runtime-mission-mismatch' };
  return { ok: true, monitored: true, reason: null, runtimeRef: runtime.runtimeRef, checkpointId: runtime.checkpoint.checkpointId };
}

export function secureAgentRuntimePermissions() {
  if (existsSync(FILE)) chmodSync(FILE, 0o600);
}

export const runtimeStorePathForTest = FILE;
