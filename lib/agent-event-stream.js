// Private, owner-scoped Agent Event Stream.
//
// Events are deliberately small and sanitized: the durable log contains no
// credentials or raw wallet, Pact, mission, account, intent, receipt or
// position identifiers. Per-owner monotonic sequences make reconnect/replay
// deterministic, while an anchored SHA-256 chain makes retained history
// tamper-evident even after bounded retention trims old events.
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'agent-event-stream.json');
const VERSION = 1;
const MAX_EVENTS_PER_OWNER = Math.min(Math.max(Number.parseInt(process.env.IOST_AGENT_EVENT_RETENTION || '1000', 10) || 1_000, 3), 10_000);
const MAX_REPLAY = 200;
const ZERO_HASH = '0'.repeat(64);
const listeners = new Map();

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const ownerRef = (ownerId) => sha256(`iost-terminal:agent-event-owner:v1:${String(ownerId || '')}`);
const clean = (value, max = 200) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const safeToken = (value, fallback, max = 80) => {
  const token = clean(value, max).toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return token || fallback;
};
const opaqueSourceRef = (value) => value ? sha256(`iost-terminal:agent-event-source:v1:${String(value)}`).slice(0, 24) : null;

function emptyStore() { return { version: VERSION, owners: {} }; }

function loadStore() {
  if (!existsSync(FILE)) return emptyStore();
  let parsed;
  try { parsed = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { throw new Error('agent event stream state is unreadable'); }
  if (parsed?.version !== VERSION || !parsed.owners || typeof parsed.owners !== 'object' || Array.isArray(parsed.owners)) {
    throw new Error('agent event stream state is invalid or uses an unsupported version');
  }
  for (const owner of Object.values(parsed.owners)) {
    if (!Number.isSafeInteger(owner?.nextSequence) || owner.nextSequence < 1 || !Array.isArray(owner.events)
      || !/^[a-f0-9]{64}$/.test(owner.anchorHash || '')) {
      throw new Error('agent event stream owner state is invalid');
    }
  }
  return parsed;
}

let store = loadStore();

function persist() {
  mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, FILE);
  chmodSync(FILE, 0o600);
}

function ownerState(ownerId) {
  const ref = ownerRef(ownerId);
  if (!store.owners[ref]) store.owners[ref] = { nextSequence: 1, anchorHash: ZERO_HASH, events: [] };
  return { ref, state: store.owners[ref] };
}

function eventEnvelope(event) {
  return {
    version: event.version, sequence: event.sequence, occurredAt: event.occurredAt,
    type: event.type, category: event.category, severity: event.severity,
    actor: event.actor, outcome: event.outcome, summary: event.summary,
    sourceRef: event.sourceRef, metadata: event.metadata, previousHash: event.previousHash,
  };
}

function sanitizeMetadata(input) {
  const metadata = {};
  const allowed = ['tool', 'method', 'stage', 'statusCode', 'readOnly', 'replayed', 'missionBound'];
  for (const key of allowed) {
    const value = input?.[key];
    if (typeof value === 'boolean' || (Number.isSafeInteger(value) && value >= 0)) metadata[key] = value;
    else if (typeof value === 'string') metadata[key] = clean(value, 100);
  }
  return metadata;
}

export function recordAgentEvent(ownerId, input = {}, now = Date.now()) {
  if (!ownerId) throw new Error('event owner is required');
  if (!Number.isSafeInteger(Number(now)) || Number(now) <= 0) throw new Error('event time is invalid');
  const { ref, state } = ownerState(ownerId);
  const previousHash = state.events.at(-1)?.hash || state.anchorHash;
  const event = {
    version: VERSION,
    sequence: state.nextSequence,
    occurredAt: Number(now),
    type: safeToken(input.type, 'agent.activity'),
    category: safeToken(input.category, 'operations', 40),
    severity: ['info', 'warning', 'critical'].includes(input.severity) ? input.severity : 'info',
    actor: ['agent', 'owner', 'system'].includes(input.actor) ? input.actor : 'system',
    outcome: safeToken(input.outcome, 'observed', 40),
    summary: clean(input.summary || 'Agent activity recorded.', 240),
    sourceRef: opaqueSourceRef(input.sourceRef),
    metadata: sanitizeMetadata(input.metadata),
    previousHash,
  };
  event.hash = sha256(stableStringify(eventEnvelope(event)));
  state.nextSequence += 1;
  state.events.push(event);
  if (state.events.length > MAX_EVENTS_PER_OWNER) {
    const removed = state.events.splice(0, state.events.length - MAX_EVENTS_PER_OWNER);
    state.anchorHash = removed.at(-1).hash;
  }
  persist();
  for (const listener of listeners.get(ref) || []) {
    try { listener(structuredClone(event)); } catch { /* one client cannot block the stream */ }
  }
  return structuredClone(event);
}

export function verifyAgentEventChain(ownerId) {
  const { state } = ownerState(ownerId);
  let previousHash = state.anchorHash;
  let previousSequence = state.events.length ? state.events[0].sequence - 1 : state.nextSequence - 1;
  for (const event of state.events) {
    if (event.version !== VERSION || event.sequence !== previousSequence + 1 || event.previousHash !== previousHash
      || event.hash !== sha256(stableStringify(eventEnvelope(event)))) {
      return { verified: false, retainedCount: state.events.length, headHashPresent: false };
    }
    previousSequence = event.sequence;
    previousHash = event.hash;
  }
  return { verified: true, retainedCount: state.events.length, headHashPresent: state.events.length > 0 };
}

export function replayAgentEvents(ownerId, { afterSequence = 0, limit = 50 } = {}) {
  const { state } = ownerState(ownerId);
  const cursor = Number(afterSequence);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('afterSequence must be a non-negative integer');
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), MAX_REPLAY);
  const earliestSequence = state.events[0]?.sequence || state.nextSequence;
  const latestSequence = state.nextSequence - 1;
  const cursorBeforeRetention = cursor > 0 && cursor < earliestSequence - 1;
  const cursorAheadOfStream = cursor > latestSequence;
  const gapDetected = cursorBeforeRetention || cursorAheadOfStream;
  const effectiveCursor = cursorBeforeRetention ? earliestSequence - 1 : cursorAheadOfStream ? latestSequence : cursor;
  const events = state.events.filter((event) => event.sequence > effectiveCursor).slice(0, boundedLimit);
  return {
    events: structuredClone(events),
    cursor: {
      requested: cursor, resumedFrom: effectiveCursor, earliestSequence, latestSequence,
      nextSequence: events.at(-1)?.sequence || effectiveCursor,
    },
    replay: {
      gapDetected, reasonCode: cursorBeforeRetention ? 'cursor-before-retention'
        : cursorAheadOfStream ? 'cursor-ahead-of-stream' : 'replay-complete',
      hasMore: events.length > 0 && events.at(-1).sequence < latestSequence,
    },
  };
}

export function agentEventStreamStatus(ownerId, options = {}) {
  const replay = replayAgentEvents(ownerId, options);
  const chain = verifyAgentEventChain(ownerId);
  return {
    ok: chain.verified,
    mode: 'paper-only',
    version: VERSION,
    status: chain.verified ? 'healthy' : 'blocked',
    transport: { protocol: 'sse', heartbeatIntervalMs: 15_000, resumable: true, lastEventIdSupported: true },
    retention: { maximumEventsPerOwner: MAX_EVENTS_PER_OWNER, retainedCount: chain.retainedCount },
    chain,
    ...replay,
    guarantees: {
      ownerIsolated: true, monotonicSequence: true, replaySafeCursor: true,
      gapDetection: true, boundedRetention: true, tamperEvident: true,
      credentialsExcluded: true, executionAuthority: 'none',
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    authorityExpanded: false,
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

export function subscribeAgentEvents(ownerId, listener) {
  if (!ownerId || typeof listener !== 'function') throw new Error('event subscription is invalid');
  const ref = ownerRef(ownerId);
  const ownerListeners = listeners.get(ref) || new Set();
  ownerListeners.add(listener);
  listeners.set(ref, ownerListeners);
  return () => {
    ownerListeners.delete(listener);
    if (!ownerListeners.size) listeners.delete(ref);
  };
}

export function secureAgentEventPermissions() {
  if (existsSync(FILE)) chmodSync(FILE, 0o600);
}

export const agentEventStorePathForTest = FILE;
export const agentEventConstants = Object.freeze({ version: VERSION, maximumEventsPerOwner: MAX_EVENTS_PER_OWNER, maximumReplay: MAX_REPLAY });
