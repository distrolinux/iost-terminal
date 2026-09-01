// Durable client-side supervisor state for Agent Runtime Reliability.
//
// The supervisor owns no trading authority. It only proves liveness, records
// bounded checkpoints and performs exact, write-ahead heartbeat retries.

import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const AGENT_RUNTIME_SUPERVISOR_VERSION = 1;
export const DEFAULT_SUPERVISOR_CADENCE_MS = 20_000;
export const MIN_SUPERVISOR_CADENCE_MS = 5_000;
export const MAX_SUPERVISOR_CADENCE_MS = 30_000;

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SESSION_REF_PATTERN = /^rs_[a-f0-9]{20}$/;
const CHECKPOINT_PATTERN = /^cp_[a-f0-9-]{36}$/;
const STAGES = new Set(['idle', 'observe', 'analyze', 'risk-check', 'execute', 'verify', 'journal']);

export const supervisorSessionRef = (sessionId) => `rs_${crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 20)}`;
export const createSupervisorSessionId = () => `supervisor-${crypto.randomBytes(18).toString('hex')}`;

function validHeartbeatPayload(payload) {
  return payload && typeof payload === 'object'
    && SESSION_PATTERN.test(payload.sessionId || '')
    && Number.isSafeInteger(payload.sequence) && payload.sequence >= 1
    && ['ready', 'draining'].includes(payload.state)
    && STAGES.has(payload.stage)
    && (payload.missionId == null || (typeof payload.missionId === 'string' && /^msn_[a-z0-9]+$/.test(payload.missionId)))
    && (payload.cursor == null || (typeof payload.cursor === 'string' && payload.cursor.length <= 500))
    && (!payload.resumeFromCheckpointId || CHECKPOINT_PATTERN.test(payload.resumeFromCheckpointId))
    && payload.supervisorVersion === AGENT_RUNTIME_SUPERVISOR_VERSION
    && Number.isInteger(payload.cadenceMs)
    && payload.cadenceMs >= MIN_SUPERVISOR_CADENCE_MS
    && payload.cadenceMs <= MAX_SUPERVISOR_CADENCE_MS;
}

function validState(state) {
  return state && state.version === AGENT_RUNTIME_SUPERVISOR_VERSION
    && (!state.sessionId || SESSION_PATTERN.test(state.sessionId))
    && (!state.sessionRef || SESSION_REF_PATTERN.test(state.sessionRef))
    && (!state.sessionId || !state.sessionRef || supervisorSessionRef(state.sessionId) === state.sessionRef)
    && (!state.checkpoint || CHECKPOINT_PATTERN.test(state.checkpoint.checkpointId || ''))
    && (!state.pending || (Number.isFinite(state.pending.createdAt) && validHeartbeatPayload(state.pending.payload)))
    && (!state.lastAckAt || Number.isFinite(state.lastAckAt));
}

export function createSupervisorStateStore(file) {
  if (!file) throw new Error('supervisor state file required');
  return {
    load() {
      if (!existsSync(file)) return { version: AGENT_RUNTIME_SUPERVISOR_VERSION, sessionId: null, sessionRef: null, checkpoint: null, pending: null, lastAckAt: null };
      let parsed;
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
      catch (error) { throw new Error(`supervisor state is unreadable: ${error.message}`); }
      if (!validState(parsed)) throw new Error('supervisor state is invalid or unsupported');
      chmodSync(file, 0o600);
      if ((statSync(file).mode & 0o777) !== 0o600) throw new Error('supervisor state permissions are not private');
      return parsed;
    },
    save(state) {
      if (!validState(state)) throw new Error('refusing to persist invalid supervisor state');
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
      if ((statSync(file).mode & 0o777) !== 0o600) throw new Error('supervisor state permissions are not private');
    },
    path: file,
  };
}

function remoteAcceptedPending(remote, pending) {
  return remote?.enrolled
    && remote.session?.ref === supervisorSessionRef(pending.payload.sessionId)
    && remote.heartbeat?.sequence === pending.payload.sequence;
}

function acceptedState(previous, payload, response, now) {
  if (!response?.enrolled || response.session?.ref !== supervisorSessionRef(payload.sessionId)
      || response.heartbeat?.sequence !== payload.sequence || !response.checkpoint?.checkpointId) {
    throw new Error('heartbeat acknowledgement did not match the pending write-ahead record');
  }
  return {
    version: AGENT_RUNTIME_SUPERVISOR_VERSION,
    sessionId: payload.sessionId,
    sessionRef: response.session.ref,
    checkpoint: response.checkpoint,
    pending: null,
    lastAckAt: now,
    lastOutcome: response.heartbeat.replayed ? 'replayed'
      : payload.resumeFromCheckpointId ? 'recovered'
        : previous.sessionRef === response.session.ref ? 'renewed' : 'enrolled',
  };
}

function heartbeatFor({ remote, state, desired, cadenceMs, createSessionId }) {
  const hasMission = Object.hasOwn(desired, 'missionId');
  const hasCursor = Object.hasOwn(desired, 'cursor');
  const common = {
    state: desired.state || 'ready', stage: desired.stage || 'idle',
    missionId: hasMission ? (desired.missionId || null) : (remote?.checkpoint?.missionId || null),
    cursor: hasCursor ? (desired.cursor || null) : (remote?.checkpoint?.cursor || null),
    supervisorVersion: AGENT_RUNTIME_SUPERVISOR_VERSION, cadenceMs,
  };
  if (!remote?.enrolled) {
    const sessionId = state.sessionId || createSessionId();
    return { sessionId, sequence: 1, ...common, missionId: hasMission ? (desired.missionId || null) : null, resumeFromCheckpointId: null };
  }
  if (state.sessionId && supervisorSessionRef(state.sessionId) === remote.session?.ref) {
    return { sessionId: state.sessionId, sequence: Number(remote.heartbeat.sequence) + 1, ...common, resumeFromCheckpointId: null };
  }
  if (!['offline', 'draining'].includes(remote.status)) {
    throw new Error('safe supervisor takeover requires an offline or draining runtime');
  }
  if (!remote.checkpoint?.checkpointId) throw new Error('safe supervisor recovery requires an exact checkpoint');
  return {
    sessionId: createSessionId(), sequence: 1, ...common,
    missionId: remote.checkpoint.missionId || null,
    cursor: remote.checkpoint.cursor || null,
    resumeFromCheckpointId: remote.checkpoint.checkpointId,
  };
}

export async function runSupervisorCycle({
  getStatus, sendHeartbeat, store, desired = {}, cadenceMs = DEFAULT_SUPERVISOR_CADENCE_MS,
  now = Date.now(), createSessionId = createSupervisorSessionId,
}) {
  if (typeof getStatus !== 'function' || typeof sendHeartbeat !== 'function' || !store) throw new Error('supervisor transport and state store required');
  if (!Number.isInteger(cadenceMs) || cadenceMs < MIN_SUPERVISOR_CADENCE_MS || cadenceMs > MAX_SUPERVISOR_CADENCE_MS) {
    throw new Error('supervisor cadence is outside the fail-safe range');
  }
  let state = store.load();
  const remote = await getStatus();

  if (state.pending && remoteAcceptedPending(remote, state.pending)) {
    state = acceptedState(state, state.pending.payload, remote, now);
    store.save(state);
    return { ok: true, outcome: 'reconciled', heartbeatSent: false, runtime: remote, liveScopeUsed: false, publicChainUsed: false };
  }

  let payload = state.pending?.payload || heartbeatFor({ remote, state, desired, cadenceMs, createSessionId });
  if (state.pending) {
    const pendingRef = supervisorSessionRef(payload.sessionId);
    const initialRetry = !remote?.enrolled && payload.sequence === 1 && !payload.resumeFromCheckpointId;
    if (remote?.session?.ref === pendingRef && Number(remote.heartbeat?.sequence) > payload.sequence) {
      throw new Error('remote heartbeat sequence advanced beyond pending state');
    }
    if (!initialRetry && remote?.session?.ref !== pendingRef && !['offline', 'draining'].includes(remote?.status)) {
      throw new Error('pending recovery cannot replace an active runtime');
    }
  } else {
    state = { ...state, pending: { payload, createdAt: now } };
    store.save(state); // write-ahead before any network mutation
  }

  const response = await sendHeartbeat(payload);
  const next = acceptedState(state, payload, response, now);
  store.save(next);
  return {
    ok: true, outcome: response.heartbeat?.replayed ? 'replayed' : 'accepted', heartbeatSent: true,
    runtime: response, liveScopeUsed: false, publicChainUsed: false,
  };
}

export function supervisorHealth(state, now = Date.now(), maxAgeMs = 45_000) {
  const ageMs = state?.lastAckAt ? Math.max(0, now - state.lastAckAt) : null;
  return {
    ok: ageMs !== null && ageMs <= maxAgeMs && !state.pending,
    version: AGENT_RUNTIME_SUPERVISOR_VERSION,
    status: ageMs === null ? 'starting' : state.pending ? 'retrying' : ageMs <= maxAgeMs ? 'ready' : 'stale',
    lastAckAgeMs: ageMs, pending: !!state?.pending,
    authorityExpanded: false, liveScopeUsed: false, publicChainUsed: false,
  };
}
