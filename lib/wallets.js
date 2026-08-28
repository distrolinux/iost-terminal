// lib/wallets.js — Phase 2 agent wallet registry (parent-child hierarchy)
//
// Off-chain engine (works before the token deploys; on-chain escrow in Phase 3).
// Wallet = identity + limits + capabilities + internal USD-minor balance ledger.
// All money values are INTEGER MINOR UNITS (cents) — no floats (audited from
// ChiMoney's reference implementation, see docs/PHASE2_SPEC.md §6.7).
//
// Store: data/wallets.json (atomic tmp+rename) — DATA_DIR overridable via
// process.env.IOST_DATA_DIR for tests.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'wallets.json');

// Capability whitelist (finance.* / wallet.* — ChiMoney-compatible scope strings)
export const VALID_CAPABILITIES = new Set([
  'finance.payment.payout',
  'finance.payment.charge',
  'finance.payment.refund',
  'wallet.transfer',
  'wallet.fund',
  'trade.paper',
  'trade.live',
  'mandate.sign',
]);

export const DEFAULT_LIMITS = { USD: { maxPerTxMinor: 0, dailyCapMinor: 0, weeklyCapMinor: 0 } }; // 0 = unlimited

const id = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function defaultStore() {
  return { wallets: [], nextSeq: 1 };
}

let store = loadStore();
function loadStore() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.wallets)) {
        parsed.nextSeq = parsed.nextSeq || 1;
        return parsed;
      }
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

const zeroAddr = (v) => !v || typeof v !== 'string' || v.length < 3;

// ---------------------------------------------------------------------------
// wallet CRUD
// ---------------------------------------------------------------------------

/** Auto-create a user (parent) wallet on first use. */
export function ensureUserWallet(ownerId) {
  if (zeroAddr(ownerId)) throw new Error('ownerId required');
  let w = store.wallets.find((x) => x.kind === 'user' && x.ownerId === ownerId);
  if (w) return w;
  w = {
    walletId: `uw_${store.nextSeq++}`,
    kind: 'user',
    parentWalletId: null,
    ownerId,
    name: `User ${ownerId}`,
    limits: structuredClone(DEFAULT_LIMITS),
    capabilities: [],
    regions: [],
    approvalRequired: false,
    status: 'active',
    balances: { USD: 0 },
    createdAt: Date.now(),
  };
  store.wallets.push(w);
  save();
  return w;
}

/** Create an agent wallet as a child of the caller's user wallet. */
export function createAgentWallet({ ownerId, name, limits, capabilities = [], regions = [], approvalRequired = false }) {
  if (zeroAddr(ownerId)) throw new Error('ownerId required');
  const parent = ensureUserWallet(ownerId);
  if (!name) throw new Error('name required');
  const caps = [...new Set(capabilities.map((c) => (typeof c === 'string' ? c : c?.id)).filter(Boolean))];
  for (const c of caps) {
    if (!VALID_CAPABILITIES.has(c)) throw new Error(`unknown capability: ${c}`);
  }
  const w = {
    walletId: `aw_${store.nextSeq++}`,
    kind: 'agent',
    parentWalletId: parent.walletId,
    ownerId,
    name,
    limits: normalizeLimits(limits),
    capabilities: caps,
    regions: Array.isArray(regions) ? regions : [],
    approvalRequired: !!approvalRequired,
    status: 'active',
    balances: { USD: 0 },
    createdAt: Date.now(),
  };
  store.wallets.push(w);
  save();
  return w;
}

export function normalizeLimits(limits) {
  const out = structuredClone(DEFAULT_LIMITS);
  if (!limits) return out;
  for (const [cur, l] of Object.entries(limits)) {
    if (!l) continue;
    out[cur] = {
      maxPerTxMinor: intOr(l.maxPerTxMinor, l.maxPerTx, 0),
      dailyCapMinor: intOr(l.dailyCapMinor, l.dailyCap, 0),
      weeklyCapMinor: intOr(l.weeklyCapMinor, l.weeklyCap, 0),
    };
  }
  return out;
}
// accept both {maxPerTxMinor} (canonical) and {maxPerTx} (ChiMoney shape)
const intOr = (a, b, d) => {
  const v = a ?? b ?? d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : d;
};

export function getWallet(walletId) {
  return store.wallets.find((w) => w.walletId === walletId) || null;
}

/** Wallet of a given kind for an owner (agent wallets: first match). */
export function findWallet(ownerId, kind) {
  return store.wallets.find((w) => w.ownerId === ownerId && w.kind === kind) || null;
}

/** Full wallet tree for an owner: parent + all children (children include agent children recursively-shaped flat list). */
export function walletTree(ownerId) {
  const all = store.wallets.filter((w) => w.ownerId === ownerId);
  const parent = all.find((w) => w.kind === 'user') || null;
  return {
    parent,
    agents: all.filter((w) => w.kind === 'agent').map((w) => ({ ...w, balances: undefined })),
  };
}

// ---------------------------------------------------------------------------
// balances + funding (internal ledger, USD minor units)
// ---------------------------------------------------------------------------
export function balanceOf(walletId) {
  const w = getWallet(walletId);
  return w ? (w.balances?.USD || 0) : 0;
}

/** Fund an agent wallet from its parent wallet (internal transfer — no fees). */
export function fundAgentWallet({ walletId, amountMinor, currency = 'USD' }) {
  const w = getWallet(walletId);
  if (!w) throw new Error('wallet not found');
  if (w.kind !== 'agent') throw new Error('only agent wallets can be funded');
  const parent = getWallet(w.parentWalletId);
  if (!parent) throw new Error('parent wallet missing');
  if (currency !== 'USD') throw new Error('only USD supported in Phase 2 engine');
  const amt = Math.trunc(Number(amountMinor));
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive integer (minor units)');
  if ((parent.balances?.USD || 0) < amt) throw new Error(`insufficient parent balance (${(parent.balances?.USD || 0)} minor)`);
  parent.balances.USD -= amt;
  w.balances.USD = (w.balances?.USD || 0) + amt;
  save();
  return { walletId, funded: amt, balanceMinor: w.balances.USD };
}

export function creditUserWallet(ownerId, amountMinor) {
  const w = ensureUserWallet(ownerId);
  w.balances.USD = (w.balances?.USD || 0) + Math.trunc(Number(amountMinor) || 0);
  save();
  return w.balances.USD;
}

/** Debit a wallet (spend). Returns new balance. Throws if insufficient. */
export function debitWallet(walletId, amountMinor) {
  const w = getWallet(walletId);
  if (!w) throw new Error('wallet not found');
  const amt = Math.trunc(Number(amountMinor));
  if ((w.balances?.USD || 0) < amt) throw new Error('insufficient wallet balance');
  w.balances.USD -= amt;
  save();
  return w.balances.USD;
}

// ---------------------------------------------------------------------------
// policies + status
// ---------------------------------------------------------------------------
export function updatePolicies(walletId, { limits, capabilities, regions, approvalRequired } = {}) {
  const w = getWallet(walletId);
  if (!w) throw new Error('wallet not found');
  if (limits) w.limits = normalizeLimits(limits);
  if (capabilities) {
    const caps = [...new Set(capabilities.map((c) => (typeof c === 'string' ? c : c?.id)).filter(Boolean))];
    for (const c of caps) {
      if (!VALID_CAPABILITIES.has(c)) throw new Error(`unknown capability: ${c}`);
    }
    w.capabilities = caps;
  }
  if (regions) w.regions = Array.isArray(regions) ? regions : [];
  if (approvalRequired !== undefined) w.approvalRequired = !!approvalRequired;
  save();
  return w;
}

export function setWalletStatus(walletId, status) {
  if (!['active', 'suspended'].includes(status)) throw new Error('invalid status');
  const w = getWallet(walletId);
  if (!w) throw new Error('wallet not found');
  w.status = status;
  save();
  return w;
}

export function stats() {
  return { wallets: store.wallets.length, users: new Set(store.wallets.map((w) => w.ownerId)).size, agents: store.wallets.filter((w) => w.kind === 'agent').length };
}
