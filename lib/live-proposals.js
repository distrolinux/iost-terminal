// lib/live-proposals.js — human-in-the-loop queue for AGENT live trades
//
// owner-approved model (2026-08-10, option C): AI agents may REQUEST live
// trades, but nothing executes until the owner approves the proposal (in-app
// or via API). This is the live-money analogue of the autopilot proposal
// queue: reasoning travels WITH the order, execution happens only on approval,
// and every decision is journaled (status history + who decided).
//
// A proposal is created by an agent key with scope trade-live (owner-created
// keys only). It is validated AGAIN at approval time — venue reachability,
// risk rails (checkLiveOrder) and price are all re-checked then, because
// prices move between proposal and approval.

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, '..', 'data');
const STORE_FILE = join(DATA_DIR, 'live-proposals.json');
const DEFAULT_PROPOSAL_TTL_MS = 10 * 60_000;

function proposalTtlMs() {
  const raw = Number(process.env.LIVE_PROPOSAL_TTL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_PROPOSAL_TTL_MS;
}

// store: data/live-proposals.json — { byId: { [id]: entry } }
// entry: { id, userId, requesterKeyId, requesterName, symbol, side, size, entry?,
//          reason?, confidence?, createdAt, status, decidedAt?, decidedBy?,
//          error?, venueOrderId? }
// status: "pending" | "executing" | "approved" | "rejected"
function loadStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    if (parsed && parsed.byId && typeof parsed.byId === 'object') return parsed;
  } catch { /* corrupt -> fresh */ }
  return { byId: {}, seq: 1 };
}
function saveStore(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, STORE_FILE);
  chmodSync(STORE_FILE, 0o600);
}

export function addProposal({ userId, requesterKeyId, requesterName, symbol, side, size, entry, reason, confidence }) {
  const store = loadStore();
  const id = `lp_${store.seq++}_${crypto.randomBytes(3).toString('hex')}`;
  store.byId[id] = {
    id, userId, requesterKeyId: requesterKeyId || null, requesterName: requesterName || 'agent',
    symbol: String(symbol || '').toUpperCase().slice(0, 12),
    side: side === 'short' ? 'short' : 'long',
    size: Number(size) || null, entry: entry ? Number(entry) : null,
    reason: String(reason || '').slice(0, 300) || null,
    confidence: confidence ? Number(confidence) : null,
    createdAt: Date.now(), status: 'pending', decidedAt: null, decidedBy: null,
    error: null, venueOrderId: null,
  };
  saveStore(store);
  return store.byId[id];
}

export function getProposal(id) {
  return loadStore().byId[id] || null;
}

export function listProposals({ userId, status, limit = 20 }) {
  const store = loadStore();
  return Object.values(store.byId)
    .filter((p) => (!userId || p.userId === userId) && (!status || p.status === status))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function decide({ id, status, by }) {
  const store = loadStore();
  const p = store.byId[id];
  if (!p) return { ok: false, error: 'proposal not found' };
  if (p.status !== 'pending') return { ok: false, error: `proposal already ${p.status}` };
  p.status = status;
  p.decidedAt = Date.now();
  p.decidedBy = by || 'owner';
  saveStore(store);
  return { ok: true, proposal: p };
}

function validateExecutableProposal(p) {
  if (!p.userId) return 'proposal owner missing';
  if (!/^[A-Z0-9._-]{1,12}$/.test(String(p.symbol || ''))) return 'proposal symbol is invalid';
  if (!['long', 'short'].includes(p.side)) return 'proposal side is invalid';
  if (!Number.isFinite(p.size) || p.size <= 0) return 'proposal size is invalid';
  if (p.entry != null && (!Number.isFinite(p.entry) || p.entry <= 0)) return 'proposal entry is invalid';
  if (!Number.isFinite(p.createdAt) || p.createdAt <= 0) return 'proposal timestamp is invalid';
  if (Date.now() - p.createdAt > proposalTtlMs()) return 'proposal expired before approval';
  return null;
}

/** Persist an execution lease before contacting the venue. */
export function claimForExecution(id, by) {
  const store = loadStore();
  const p = store.byId[id];
  if (!p) return { ok: false, error: 'proposal not found' };
  if (p.status !== 'pending') return { ok: false, error: `proposal already ${p.status}` };
  const invalid = validateExecutableProposal(p);
  if (invalid) {
    p.status = 'rejected';
    p.decidedAt = Date.now();
    p.decidedBy = by || 'owner';
    p.error = invalid;
    saveStore(store);
    return { ok: false, error: invalid, proposal: p };
  }
  p.status = 'executing';
  p.decidedAt = Date.now();
  p.decidedBy = by || 'owner';
  saveStore(store);
  return { ok: true, proposal: p };
}

/** Finalize a proposal that previously acquired an execution lease. */
export function finalizeExecution(id, { status, by, error, venueOrderId } = {}) {
  if (!['approved', 'rejected'].includes(status)) return { ok: false, error: 'invalid execution result' };
  const store = loadStore();
  const p = store.byId[id];
  if (!p) return { ok: false, error: 'proposal not found' };
  if (p.status !== 'executing') return { ok: false, error: `proposal is not executing (${p.status})` };
  p.status = status;
  p.decidedAt = Date.now();
  p.decidedBy = by || p.decidedBy || 'owner';
  if (error) p.error = String(error).slice(0, 300);
  if (venueOrderId) p.venueOrderId = venueOrderId;
  saveStore(store);
  return { ok: true, proposal: p };
}

export function attachResult(id, { error, venueOrderId }) {
  const store = loadStore();
  const p = store.byId[id];
  if (!p) return;
  if (error) p.error = String(error).slice(0, 300);
  if (venueOrderId) p.venueOrderId = venueOrderId;
  saveStore(store);
}
