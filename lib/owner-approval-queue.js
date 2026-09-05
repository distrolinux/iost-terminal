// Durable, owner-controlled closed mandates for paper execution. Agents may
// request approval but only a signed-in owner surface may approve or reject.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from './execution-receipts.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'owner-approvals.json');
const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_TTL_MS = 10 * 60_000;
const ZERO_HASH = '0'.repeat(64);
const MAX_RECORDS = 1_000;

const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
const ref = (kind, value) => sha256(`iost-terminal:owner-approval:${kind}:v1:${String(value || '')}`);
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clean = (value, max = 200) => String(value || '').trim().slice(0, max);

function emptyStore() { return { version: 1, approvals: [], events: [] }; }
function loadStore() {
  if (!existsSync(FILE)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    if (parsed?.version === 1 && Array.isArray(parsed.approvals) && Array.isArray(parsed.events)) return parsed;
  } catch { /* fail closed below */ }
  throw new Error('owner approval store is malformed');
}
let store = loadStore();

function save() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temp = `${FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, FILE);
  chmodSync(FILE, 0o600);
}

export function secureOwnerApprovalPermissions() {
  if (existsSync(FILE)) chmodSync(FILE, 0o600);
}

function normalizeOrder(order = {}) {
  return {
    symbol: clean(order.symbol, 24).toUpperCase(), side: order.side === 'short' ? 'short' : 'long',
    size: finite(order.size), entry: finite(order.entry), stop: finite(order.stop), target: finite(order.target),
    maxSlippageBps: finite(order.maxSlippageBps), confidence: finite(order.confidence),
    walletRef: ref('wallet', order.walletId), pactRef: ref('pact', order.pactId),
    missionRef: order.missionId ? ref('mission', order.missionId) : null,
    recipientRef: order.recipient ? ref('recipient', order.recipient) : null,
    protocolRef: order.protocol ? ref('protocol', order.protocol) : null,
    reasoningDigest: order.reason ? sha256(clean(order.reason, 500)) : null,
  };
}

function mandateFor(input = {}) {
  return {
    accountRef: ref('account', input.accountId), requesterRef: ref('requester', input.requesterId),
    intentRef: ref('intent', input.intentId), action: 'open',
    preflightFingerprint: clean(input.preflightFingerprint, 64).toLowerCase(),
    order: normalizeOrder(input.order),
  };
}

function publicOrder(order) {
  return { symbol: order.symbol, side: order.side, size: order.size, entry: order.entry, stop: order.stop,
    target: order.target, maxSlippageBps: order.maxSlippageBps, confidence: order.confidence };
}

function publicEvidence(evidence = {}) {
  return {
    decision: evidence.decision === 'allow' ? 'allow' : 'deny', reasonCode: clean(evidence.reasonCode, 120) || null,
    quoteSource: clean(evidence.quoteSource, 80) || null, quoteAgeMs: finite(evidence.quoteAgeMs),
    estimatedFillPrice: finite(evidence.estimatedFillPrice), estimatedTotalUsd: finite(evidence.estimatedTotalUsd),
    riskDecision: evidence.riskDecision === 'allow' ? 'allow' : 'deny',
    dataTrustDecision: evidence.dataTrustDecision === 'allow' ? 'allow' : 'deny',
  };
}

function appendEvent(record, type, at) {
  const accountEvents = store.events.filter((event) => event.accountRef === record.accountRef);
  const previousHash = accountEvents.at(-1)?.hash || ZERO_HASH;
  const payload = { approvalId: record.approvalId, accountRef: record.accountRef, type, at, mandateDigest: record.mandateDigest };
  const event = { version: 1, sequence: accountEvents.length + 1, ...payload, previousHash };
  event.hash = sha256(event);
  store.events.push(event);
}

function expose(record, now = Date.now()) {
  const status = record.status === 'pending' && now > record.expiresAt ? 'expired' : record.status;
  return {
    approvalId: record.approvalId, status, action: 'open', mandateDigest: record.mandateDigest,
    order: record.order, evidence: record.evidence, createdAt: record.createdAt, expiresAt: record.expiresAt,
    decidedAt: record.decidedAt || null, consumedAt: record.consumedAt || null,
    singleUse: true, ownerDecisionRequired: status === 'pending', executionAttempted: false,
    authorityExpanded: false, liveScopeUsed: false, publicChainUsed: false,
  };
}

function expire(now) {
  let changed = false;
  for (const record of store.approvals) {
    if (['pending', 'approved'].includes(record.status) && now > record.expiresAt) {
      record.status = 'expired';
      appendEvent(record, 'expired', now);
      changed = true;
    }
  }
  if (changed) save();
}

function requireHexDigest(value, label) {
  const normalized = clean(value, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} required`);
  return normalized;
}

function sameDigest(a, b) {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b)
    && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function requestOwnerApproval(input, now = Date.now(), { ttlMs = DEFAULT_TTL_MS } = {}) {
  const mandate = mandateFor(input);
  if (!input.accountId || !input.requesterId || !input.intentId) throw new Error('account, requester and intent required');
  requireHexDigest(mandate.preflightFingerprint, 'preflight fingerprint');
  if (!mandate.order.symbol || !(mandate.order.size > 0) || !(mandate.order.entry > 0) || !(mandate.order.stop > 0)) {
    throw new Error('complete paper order required');
  }
  if (input.evidence?.decision !== 'allow') throw new Error('allowed preflight evidence required');
  expire(now);
  const mandateDigest = sha256(mandate);
  const existing = store.approvals.find((item) => item.accountRef === mandate.accountRef && item.intentRef === mandate.intentRef);
  if (existing) {
    if (!sameDigest(existing.mandateDigest, mandateDigest)) throw new Error('approval intent conflict');
    return { ok: true, mode: 'paper-only', replayed: true, approval: expose(existing, now) };
  }
  const ttl = Math.max(5_000, Math.min(MAX_TTL_MS, Math.trunc(Number(ttlMs) || DEFAULT_TTL_MS)));
  const record = {
    approvalId: `apr_${crypto.randomUUID()}`, accountRef: mandate.accountRef, requesterRef: mandate.requesterRef,
    intentRef: mandate.intentRef, mandateDigest, preflightFingerprint: mandate.preflightFingerprint,
    orderDigest: sha256(mandate.order), order: publicOrder(mandate.order), evidence: publicEvidence(input.evidence),
    status: 'pending', createdAt: now, expiresAt: now + ttl, decidedAt: null, consumedAt: null,
  };
  store.approvals.push(record);
  if (store.approvals.length > MAX_RECORDS) store.approvals.splice(0, store.approvals.length - MAX_RECORDS);
  appendEvent(record, 'requested', now);
  save();
  return { ok: true, mode: 'paper-only', replayed: false, approval: expose(record, now) };
}

export function listOwnerApprovals(accountId, { status = null, limit = 100, now = Date.now() } = {}) {
  expire(now);
  const accountRef = ref('account', accountId);
  return store.approvals.filter((item) => item.accountRef === accountRef && (!status || item.status === status))
    .slice(-Math.max(1, Math.min(200, Number(limit) || 100))).reverse().map((item) => expose(item, now));
}

export function decideOwnerApproval({ accountId, approvalId, decision, expectedDigest }, now = Date.now()) {
  expire(now);
  const record = store.approvals.find((item) => item.approvalId === approvalId && item.accountRef === ref('account', accountId));
  if (!record) throw new Error('approval not found');
  if (record.status === 'expired') throw new Error('approval expired');
  if (!['approved', 'rejected'].includes(decision)) throw new Error('owner decision invalid');
  if (!sameDigest(record.mandateDigest, requireHexDigest(expectedDigest, 'expected digest'))) throw new Error('approval evidence changed');
  if (record.status !== 'pending') {
    if (record.status === decision) return expose(record, now);
    throw new Error(`approval already ${record.status}`);
  }
  record.status = decision;
  record.decidedAt = now;
  appendEvent(record, decision, now);
  save();
  return expose(record, now);
}

export function consumeOwnerApproval(input, now = Date.now()) {
  expire(now);
  const record = store.approvals.find((item) => item.approvalId === input.approvalId && item.accountRef === ref('account', input.accountId));
  if (!record) throw new Error('owner approval not found');
  if (record.status === 'consumed') throw new Error('owner approval already consumed');
  if (record.status !== 'approved') throw new Error(`owner approval is ${record.status}`);
  const mandate = mandateFor(input);
  const digest = sha256(mandate);
  if (!sameDigest(record.mandateDigest, digest)) throw new Error('owner approval evidence changed');
  record.status = 'consumed';
  record.consumedAt = now;
  appendEvent(record, 'consumed', now);
  save();
  return expose(record, now);
}

export function verifyOwnerApprovalChain(accountId) {
  const accountRef = ref('account', accountId);
  const events = store.events.filter((event) => event.accountRef === accountRef);
  let previousHash = ZERO_HASH;
  let sequence = 0;
  for (const event of events) {
    const expectedPrevious = events[event.sequence - 2]?.hash || ZERO_HASH;
    const envelope = { version: event.version, sequence: event.sequence, approvalId: event.approvalId,
      accountRef: event.accountRef, type: event.type, at: event.at, mandateDigest: event.mandateDigest,
      previousHash: event.previousHash };
    if (event.version !== 1 || event.sequence !== ++sequence || event.previousHash !== expectedPrevious || event.hash !== sha256(envelope)) {
      return { ok: false, count: sequence - 1 };
    }
    previousHash = event.hash;
  }
  return { ok: true, count: events.length, headHash: previousHash };
}
