// Durable idempotency and replay protection for paper execution. An intent is
// persisted before broker work. Terminal outcomes are replayed; a pending
// intent without an in-process owner is outcome-unknown and fails closed.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'execution-intents.json');
const INTENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_PER_ACCOUNT = 10_000;
const MAX_LIST = 200;
const inflight = new Map();

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
const accountRef = (accountId) => sha256(`iost-terminal:execution-intent-account:v1:${String(accountId || '')}`);
export const executionIntentRef = (accountId, intentId) => sha256(`iost-terminal:execution-intent:v1:${String(accountId || '')}:${String(intentId || '')}`);
export const executionRequestHash = (action, request) => sha256({ action, request });
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

export function validateExecutionIntentId(intentId) {
  const value = String(intentId || '').trim();
  if (!value) return { ok: false, error: 'execution intent id required' };
  if (!INTENT_RE.test(value)) return { ok: false, error: 'execution intent id must be 8-128 safe characters' };
  return { ok: true, intentId: value };
}

function load() {
  if (!existsSync(FILE)) return { version: 1, intents: {} };
  let parsed;
  try { parsed = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { throw new Error('execution intent store is malformed'); }
  if (parsed?.version !== 1 || !parsed.intents || typeof parsed.intents !== 'object' || Array.isArray(parsed.intents)) {
    throw new Error('execution intent store schema is invalid');
  }
  return parsed;
}

function save(store) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}

function publicRecord(record) {
  if (!record) return null;
  const terminal = record.status === 'succeeded' || record.status === 'failed';
  const receipt = record.status === 'succeeded' ? record.result?.receipt : record.error?.receipt;
  return {
    intentRef: record.intentRef,
    action: record.action,
    status: terminal ? record.status : 'outcome-unknown',
    replaySafe: terminal,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    outcome: receipt?.outcome || (record.status === 'failed' ? 'rejected' : null),
    reason: record.error?.reason || receipt?.policy?.reasonCode || null,
    receiptRef: receipt?.hash || null,
  };
}

function metadata(record, intentId, replayed) {
  return {
    intentId,
    intentRef: record.intentRef,
    action: record.action,
    status: record.status,
    replayed,
    replayProtected: true,
  };
}

function materializeError(record, intentId, replayed) {
  const stored = record.error || {};
  return Object.assign(new Error(stored.message || 'paper execution failed'), {
    status: Number(stored.status) || 500,
    ...(stored.reason ? { reason: stored.reason } : {}),
    ...(stored.receipt ? { receipt: clone(stored.receipt) } : {}),
    executionIntent: metadata(record, intentId, replayed),
  });
}

function conflictError(record, intentId) {
  return Object.assign(new Error('execution intent was already used for a different request'), {
    status: 409,
    reason: 'execution-intent-conflict',
    executionIntent: metadata(record, intentId, true),
  });
}

function uncertainError(record, intentId, replayed = true) {
  return Object.assign(new Error('execution intent outcome is unknown; automatic retry blocked'), {
    status: 409,
    reason: 'execution-intent-outcome-unknown',
    executionIntent: { ...metadata(record, intentId, replayed), status: 'outcome-unknown' },
  });
}

function materialize(outcome, record, intentId, replayed) {
  if (outcome.unknown) throw uncertainError(record, intentId, replayed);
  if (!outcome.ok) throw materializeError({ ...record, status: 'failed', error: outcome.error }, intentId, replayed);
  return { ...clone(outcome.result), executionIntent: metadata({ ...record, status: 'succeeded' }, intentId, replayed) };
}

function latestRecord(ref, fallback) {
  try { return load().intents[ref] || fallback; }
  catch { return fallback; }
}

export async function runExecutionIntent({ accountId, intentId, action, request }, operation) {
  if (!accountId) throw Object.assign(new Error('execution intent account required'), { status: 400, reason: 'execution-intent-account-required' });
  const validated = validateExecutionIntentId(intentId);
  if (!validated.ok) throw Object.assign(new Error(validated.error), { status: 400, reason: 'execution-intent-required' });
  intentId = validated.intentId;
  if (!['open', 'close'].includes(action)) throw Object.assign(new Error('execution intent action invalid'), { status: 400, reason: 'execution-intent-action-invalid' });

  const ref = executionIntentRef(accountId, intentId);
  const requestHash = executionRequestHash(action, request);
  const store = load();
  const existing = store.intents[ref];
  if (existing) {
    if (existing.accountRef !== accountRef(accountId) || existing.action !== action || existing.requestHash !== requestHash) {
      throw conflictError(existing, intentId);
    }
    if (existing.status === 'succeeded') return materialize({ ok: true, result: existing.result }, existing, intentId, true);
    if (existing.status === 'failed') throw materializeError(existing, intentId, true);
    const active = inflight.get(ref);
    if (!active) throw uncertainError(existing, intentId);
    return materialize(await active, latestRecord(ref, existing), intentId, true);
  }

  const ownedCount = Object.values(store.intents).filter((item) => item.accountRef === accountRef(accountId)).length;
  if (ownedCount >= MAX_PER_ACCOUNT) {
    throw Object.assign(new Error('execution intent capacity reached; operator archival required'), { status: 507, reason: 'execution-intent-capacity' });
  }
  const now = Date.now();
  const record = {
    version: 1,
    intentRef: ref,
    accountRef: accountRef(accountId),
    action,
    requestHash,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    result: null,
    error: null,
  };
  store.intents[ref] = record;
  save(store);

  const execution = (async () => {
    let result;
    try {
      result = clone(await operation());
    } catch (error) {
      const storedError = {
        message: String(error?.message || 'paper execution failed').slice(0, 500),
        status: Number(error?.status) || 500,
        reason: error?.reason ? String(error.reason).slice(0, 120) : null,
        receipt: error?.receipt ? clone(error.receipt) : null,
      };
      try {
        const current = load();
        current.intents[ref] = { ...current.intents[ref], status: 'failed', updatedAt: Date.now(), result: null, error: storedError };
        save(current);
        return { ok: false, error: storedError };
      } catch {
        return { ok: false, unknown: true };
      }
    }
    try {
      const current = load();
      current.intents[ref] = { ...current.intents[ref], status: 'succeeded', updatedAt: Date.now(), result, error: null };
      save(current);
      return { ok: true, result };
    } catch {
      return { ok: false, unknown: true };
    }
  })();
  inflight.set(ref, execution);
  try {
    const outcome = await execution;
    return materialize(outcome, latestRecord(ref, record), intentId, false);
  } finally {
    inflight.delete(ref);
  }
}

export function getExecutionIntent(accountId, intentId) {
  const validated = validateExecutionIntentId(intentId);
  if (!accountId || !validated.ok) return null;
  const record = load().intents[executionIntentRef(accountId, validated.intentId)];
  return record?.accountRef === accountRef(accountId) ? publicRecord(record) : null;
}

export function listExecutionIntents(accountId, limit = 50) {
  if (!accountId) return [];
  const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), MAX_LIST);
  const ref = accountRef(accountId);
  return Object.values(load().intents)
    .filter((record) => record.accountRef === ref)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, bounded)
    .map(publicRecord);
}

// Internal, owner-scoped reconciliation surface. It deliberately returns the
// same sanitized records as the public API, without the 200-row presentation
// cap, so the safety gate never mistakes incomplete history for consistency.
export function reconciliationExecutionIntents(accountId) {
  if (!accountId) return [];
  const ref = accountRef(accountId);
  return Object.values(load().intents)
    .filter((record) => record.accountRef === ref)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(publicRecord);
}

export function secureExecutionIntentPermissions() {
  if (existsSync(FILE)) {
    chmodSync(FILE, 0o600);
    load();
  }
}
