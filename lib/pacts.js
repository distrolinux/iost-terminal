// lib/pacts.js — Phase 2 Pact lifecycle (Cobo research fold, PHASE2_SPEC §6.5)
//
// Pact = task-scoped agreement: intent + plan + policies + completion conditions.
// Auto-expiry: time limit, budget exhausted, or goal achieved ⇒ permissions revoke.
// Mandate chain (consent/intent/payment, AP2) lives INSIDE a pact in Phase 3.
// Store: data/pacts.json

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWallet } from './wallets.js';
import { isFrozen } from './freeze.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'pacts.json');

export const PACT_STATUSES = ['proposed', 'active', 'rejected', 'expired', 'terminated'];
const id = () => `pact_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function defaultStore() { return { pacts: [] }; }
let store = loadStore();
function loadStore() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.pacts)) return parsed;
    }
  } catch { /* corrupt → fresh */ }
  return defaultStore();
}
function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}

function computeExpiry(pact) {
  const c = pact.completion || {};
  if (c.type === 'time' && c.deadlineTs) return Number(c.deadlineTs);
  if (c.type === 'budget' && c.budgetMinor) return null; // budget-driven
  if (c.type === 'goal') return null; // goal-driven
  return null;
}

/**
 * Propose a pact. completion: {type:'time', deadlineTs} | {type:'budget', budgetMinor}
 * | {type:'goal', goal}. policies: {limits?, whitelist:{recipients:[], protocols:[]},
 * approvalRequired?}.
 */
export function proposePact({ ownerId, agentWalletId, intent, plan, policies = {}, completion }) {
  if (!ownerId || !intent) throw new Error('ownerId and intent required');
  const wallet = agentWalletId ? getWallet(agentWalletId) : null;
  if (agentWalletId && !wallet) throw new Error('wallet not found');
  if (agentWalletId && wallet.ownerId !== ownerId) throw new Error('wallet does not belong to owner');
  if (!completion || !completion.type || !['time', 'budget', 'goal'].includes(completion.type)) {
    throw new Error('completion.type must be time | budget | goal');
  }
  if (completion.type === 'time' && !completion.deadlineTs) throw new Error('completion.deadlineTs required for time');
  if (completion.type === 'budget' && !(completion.budgetMinor > 0)) throw new Error('completion.budgetMinor required for budget');
  const pact = {
    pactId: id(),
    ownerId,
    agentWalletId: agentWalletId || null,
    intent: String(intent).slice(0, 2000),
    plan: Array.isArray(plan) ? plan.slice(0, 20) : [],
    policies: {
      limits: policies.limits || null,
      whitelist: { recipients: policies.whitelist?.recipients || [], protocols: policies.whitelist?.protocols || [] },
      approvalRequired: policies.approvalRequired ?? true,
    },
    completion: { ...completion },
    status: 'proposed',
    createdAt: Date.now(),
    approvedAt: null,
    expiresAt: null,
    spentMinor: 0,
    reservations: [],
    events: [{ ts: Date.now(), type: 'proposed' }],
  };
  store.pacts.push(pact);
  save();
  return pact;
}

export function getPact(pactId) {
  const p = store.pacts.find((x) => x.pactId === pactId) || null;
  if (p) sweepExpiry(p);
  return p;
}

function effectiveStatus(pact, now = Date.now()) {
  if (!pact || pact.status !== 'active') return pact?.status || null;
  const completion = pact.completion || {};
  if (completion.type === 'time' && completion.deadlineTs && now >= Number(completion.deadlineTs)) return 'expired';
  if (completion.type === 'budget' && completion.budgetMinor > 0 && pact.spentMinor >= completion.budgetMinor) return 'expired';
  return pact.status;
}

/** Current Pact snapshot without lifecycle persistence. */
export function previewPact(pactId, now = Date.now()) {
  const pact = store.pacts.find((item) => item.pactId === pactId) || null;
  return pact ? { ...structuredClone(pact), status: effectiveStatus(pact, now) } : null;
}

/** Mark a pact expired when its completion conditions are met. */
function sweepExpiry(p) {
  if (p.status !== 'active') return p;
  let expired = false;
  const c = p.completion || {};
  if (c.type === 'time' && c.deadlineTs && Date.now() >= Number(c.deadlineTs)) expired = true;
  if (c.type === 'budget' && c.budgetMinor > 0 && p.spentMinor >= c.budgetMinor) expired = true;
  if (expired) {
    p.status = 'expired';
    p.events.push({ ts: Date.now(), type: 'expired' });
    save();
  }
  return p;
}

export function approvePact(pactId, by) {
  const p = getPact(pactId);
  if (!p) throw new Error('pact not found');
  if (p.status !== 'proposed') throw new Error(`cannot approve pact in status ${p.status}`);
  p.status = 'active';
  p.approvedAt = Date.now();
  p.expiresAt = computeExpiry(p);
  p.events.push({ ts: Date.now(), type: 'approved', by });
  save();
  return p;
}

export function rejectPact(pactId, by) {
  const p = getPact(pactId);
  if (!p) throw new Error('pact not found');
  if (p.status !== 'proposed') throw new Error(`cannot reject pact in status ${p.status}`);
  p.status = 'rejected';
  p.events.push({ ts: Date.now(), type: 'rejected', by });
  save();
  return p;
}

export function terminatePact(pactId, by) {
  const p = getPact(pactId);
  if (!p) throw new Error('pact not found');
  if (p.status !== 'active') throw new Error(`cannot terminate pact in status ${p.status}`);
  p.status = 'terminated';
  p.events.push({ ts: Date.now(), type: 'terminated', by });
  save();
  return p;
}

/**
 * Enforce a pact's policies for one spend. Returns {ok} or {ok:false, reason, message}.
 * Checks: active status, freeze, whitelist (recipient/protocol), budget.
 */
export function checkPactSpend({ pactId, walletId = null, ownerId = null, amountMinor, recipient = null, protocol = null }) {
  const p = getPact(pactId);
  if (!p) return { ok: false, reason: 'pact-not-found' };
  if (p.status !== 'active') return { ok: false, reason: `pact-${p.status}`, message: `Pact is ${p.status}.` };
  if (walletId && p.agentWalletId !== walletId) return { ok: false, reason: 'pact-wallet-mismatch', message: 'Pact is not bound to this wallet.' };
  if (ownerId && p.ownerId !== ownerId) return { ok: false, reason: 'pact-owner-mismatch', message: 'Pact does not belong to this owner.' };
  if (isFrozen()) return { ok: false, reason: 'frozen', message: 'Agent operations are frozen.' };
  const amt = Math.trunc(Number(amountMinor));
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'invalid-amount', message: 'Amount must be a positive integer.' };
  const wl = p.policies?.whitelist || {};
  if (wl.recipients?.length && (!recipient || !wl.recipients.includes(recipient))) {
    return { ok: false, reason: 'recipient-not-whitelisted', message: 'Recipient is not in the pact whitelist.' };
  }
  if (wl.protocols?.length && (!protocol || !wl.protocols.includes(protocol))) {
    return { ok: false, reason: 'protocol-not-whitelisted', message: 'Protocol is not in the pact whitelist.' };
  }
  if (p.policies?.limits?.maxPerTxMinor > 0 && amt > p.policies.limits.maxPerTxMinor) {
    return { ok: false, reason: 'per-tx-cap', message: 'Exceeds pact per-transaction cap.' };
  }
  const outstanding = (p.reservations || []).reduce((sum, r) => sum + (Number(r.amountMinor) || 0), 0);
  if (p.completion?.type === 'budget' && p.completion.budgetMinor > 0 && p.spentMinor + outstanding + amt > p.completion.budgetMinor) {
    return { ok: false, reason: 'budget-exhausted', message: 'Pact budget exhausted.' };
  }
  return { ok: true };
}

/** Same policy decision as checkPactSpend without expiry persistence. */
export function previewPactSpend({ pactId, walletId = null, ownerId = null, amountMinor, recipient = null, protocol = null }) {
  const p = previewPact(pactId);
  if (!p) return { ok: false, reason: 'pact-not-found' };
  if (p.status !== 'active') return { ok: false, reason: `pact-${p.status}`, message: `Pact is ${p.status}.` };
  if (walletId && p.agentWalletId !== walletId) return { ok: false, reason: 'pact-wallet-mismatch', message: 'Pact is not bound to this wallet.' };
  if (ownerId && p.ownerId !== ownerId) return { ok: false, reason: 'pact-owner-mismatch', message: 'Pact does not belong to this owner.' };
  if (isFrozen()) return { ok: false, reason: 'frozen', message: 'Agent operations are frozen.' };
  const amt = Math.trunc(Number(amountMinor));
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'invalid-amount', message: 'Amount must be a positive integer.' };
  const whitelist = p.policies?.whitelist || {};
  if (whitelist.recipients?.length && (!recipient || !whitelist.recipients.includes(recipient))) {
    return { ok: false, reason: 'recipient-not-whitelisted', message: 'Recipient is not in the pact whitelist.' };
  }
  if (whitelist.protocols?.length && (!protocol || !whitelist.protocols.includes(protocol))) {
    return { ok: false, reason: 'protocol-not-whitelisted', message: 'Protocol is not in the pact whitelist.' };
  }
  if (p.policies?.limits?.maxPerTxMinor > 0 && amt > p.policies.limits.maxPerTxMinor) {
    return { ok: false, reason: 'per-tx-cap', message: 'Exceeds pact per-transaction cap.' };
  }
  const outstanding = (p.reservations || []).reduce((sum, reservation) => sum + (Number(reservation.amountMinor) || 0), 0);
  if (p.completion?.type === 'budget' && p.completion.budgetMinor > 0 && p.spentMinor + outstanding + amt > p.completion.budgetMinor) {
    return { ok: false, reason: 'budget-exhausted', message: 'Pact budget exhausted.' };
  }
  return { ok: true };
}

/** Reserve Pact budget before an external action begins. */
export function reservePactSpend({ pactId, reservationId, walletId, ownerId, amountMinor, recipient = null, protocol = null }) {
  if (!reservationId) return { ok: false, reason: 'reservation-id-required' };
  const gate = checkPactSpend({ pactId, walletId, ownerId, amountMinor, recipient, protocol });
  if (!gate.ok) return gate;
  const p = getPact(pactId);
  p.reservations = p.reservations || [];
  if (p.reservations.some((r) => r.reservationId === reservationId)) return { ok: false, reason: 'reservation-exists' };
  const amount = Math.trunc(Number(amountMinor));
  p.reservations.push({ reservationId, amountMinor: amount, walletId, recipient, protocol, createdAt: Date.now() });
  p.events.push({ ts: Date.now(), type: 'spend-reserved', reservationId, amountMinor: amount });
  save();
  return { ok: true, pact: p };
}

/** Release Pact capacity when the external action does not settle. */
export function releasePactReservation(pactId, reservationId) {
  const p = getPact(pactId);
  if (!p) return { ok: false, reason: 'pact-not-found' };
  p.reservations = p.reservations || [];
  const idx = p.reservations.findIndex((r) => r.reservationId === reservationId);
  if (idx === -1) return { ok: false, reason: 'reservation-not-found' };
  const [released] = p.reservations.splice(idx, 1);
  p.events.push({ ts: Date.now(), type: 'spend-released', reservationId, amountMinor: released.amountMinor });
  save();
  return { ok: true, released: released.amountMinor, pact: p };
}

/** Convert previously reserved Pact capacity into committed spend. */
export function commitPactReservation(pactId, reservationId) {
  const p = getPact(pactId);
  if (!p) return { ok: false, reason: 'pact-not-found' };
  p.reservations = p.reservations || [];
  const idx = p.reservations.findIndex((r) => r.reservationId === reservationId);
  if (idx === -1) return { ok: false, reason: 'reservation-not-found' };
  const [settled] = p.reservations.splice(idx, 1);
  p.spentMinor += settled.amountMinor;
  p.events.push({ ts: Date.now(), type: 'spend', reservationId, amountMinor: settled.amountMinor });
  sweepExpiry(p);
  save();
  return { ok: true, amountMinor: settled.amountMinor, pact: p };
}

/** Record a spend against a pact (call after successful settlement). */
export function recordPactSpend(pactId, amountMinor) {
  const p = getPact(pactId);
  if (!p) throw new Error('pact not found');
  if (p.status !== 'active') throw new Error(`pact is ${p.status}`);
  p.spentMinor += Math.trunc(Number(amountMinor) || 0);
  p.events.push({ ts: Date.now(), type: 'spend', amountMinor });
  sweepExpiry(p);
  save();
  return p;
}

export function listPacts(ownerId, { includeAll = false } = {}) {
  // sweep all actives for expiry on read
  for (const p of store.pacts) sweepExpiry(p);
  return store.pacts
    .filter((p) => includeAll || p.ownerId === ownerId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => ({ ...p, plan: undefined }));
}
