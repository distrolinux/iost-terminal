// Atomic-state off-chain mirror for EVM-bound points conversion.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getAddress } from 'ethers';
import { getBalance, debitForConversion } from './points.js';
import { getBinding } from './evm-wallets.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'aitt-claims-v2.json');
const ACTIVE = new Set(['reserved', 'approved_onchain']);
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

function load() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'));
      if (d && d.byId) return d;
    }
  } catch { /* fresh */ }
  return { byId: {} };
}
function save(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
}
const publicClaim = (claim) => claim ? { ...claim } : null;

export function availablePoints(userId) {
  const reserved = Object.values(load().byId)
    .filter((c) => c.userId === userId && ACTIVE.has(c.status))
    .reduce((sum, c) => sum + c.points, 0);
  return Math.max(0, getBalance(userId) - reserved);
}

export function reserveClaim({ userId, evmAddress, points, idempotencyKey }) {
  if (!userId || !idempotencyKey) return { ok: false, error: 'userId and idempotencyKey required' };
  let address;
  try { address = getAddress(String(evmAddress || '')); } catch { return { ok: false, error: 'valid EVM address required' }; }
  const binding = getBinding(userId);
  if (!binding || binding.address !== address) return { ok: false, error: 'verified EVM wallet binding required' };
  const amount = Math.trunc(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'positive whole points required' };
  const store = load();
  const prior = Object.values(store.byId).find((c) => c.userId === userId && c.idempotencyKey === idempotencyKey);
  if (prior) return { ok: true, claim: publicClaim(prior), already: true };
  if (availablePoints(userId) < amount) return { ok: false, error: 'insufficient available points' };
  const id = `aittc_${crypto.randomBytes(12).toString('hex')}`;
  store.byId[id] = {
    id, userId, evmAddress: address, points: amount, baseUnits: (BigInt(amount) * 10n ** 8n).toString(),
    idempotencyKey, status: 'reserved', createdAt: Date.now(), updatedAt: Date.now(),
    approvalTxHash: null, approvalBlock: null, claimTxHash: null, claimBlock: null, failureReason: null,
  };
  save(store);
  return { ok: true, claim: publicClaim(store.byId[id]) };
}

export function markApprovedOnchain({ claimId, txHash, blockNumber, expectedApprovalBaseUnits }) {
  if (!TX_RE.test(String(txHash || ''))) return { ok: false, error: 'valid approval tx hash required' };
  txHash = txHash.toLowerCase();
  if (!/^\d+$/.test(String(expectedApprovalBaseUnits ?? ''))) return { ok: false, error: 'expected cumulative approval required' };
  const store = load(); const c = store.byId[claimId];
  if (!c) return { ok: false, error: 'claim not found' };
  if (c.status === 'approved_onchain' && c.approvalTxHash === txHash) return { ok: true, claim: publicClaim(c), already: true };
  if (c.status !== 'reserved') return { ok: false, error: `invalid transition from ${c.status}` };
  c.status = 'approved_onchain'; c.approvalTxHash = txHash; c.approvalBlock = Number(blockNumber); c.expectedApprovalBaseUnits = String(expectedApprovalBaseUnits); c.updatedAt = Date.now();
  save(store); return { ok: true, claim: publicClaim(c) };
}

export function confirmClaimedOnchain({ claimId, txHash, blockNumber }) {
  if (!TX_RE.test(String(txHash || ''))) return { ok: false, error: 'valid claim tx hash required' };
  txHash = txHash.toLowerCase();
  const store = load(); const c = store.byId[claimId];
  if (!c) return { ok: false, error: 'claim not found' };
  if (c.status === 'claimed_onchain' && c.claimTxHash === txHash) return { ok: true, claim: publicClaim(c), already: true };
  const reused = Object.values(store.byId).find((other) => other.id !== c.id && other.claimTxHash === txHash);
  if (reused) return { ok: false, error: 'conversion transaction already reconciled to another claim' };
  if (c.status !== 'approved_onchain') return { ok: false, error: `invalid transition from ${c.status}` };
  const debit = debitForConversion({ ownerId: c.userId, points: c.points, claimId: c.id, txHash });
  if (!debit.ok) return { ok: false, error: debit.error };
  c.status = 'claimed_onchain'; c.claimTxHash = txHash; c.claimBlock = Number(blockNumber); c.updatedAt = Date.now();
  save(store); return { ok: true, claim: publicClaim(c) };
}

export function releaseClaim({ claimId, reason }) {
  const store = load(); const c = store.byId[claimId];
  if (!c) return { ok: false, error: 'claim not found' };
  if (c.status === 'released') return { ok: true, claim: publicClaim(c), already: true };
  if (c.status !== 'reserved') return { ok: false, error: `cannot release ${c.status} claim` };
  c.status = 'released'; c.failureReason = String(reason || 'released').slice(0, 300); c.updatedAt = Date.now();
  save(store); return { ok: true, claim: publicClaim(c) };
}

export function getClaim(claimId) { return publicClaim(load().byId[claimId]); }
export function listClaims(userId) { return Object.values(load().byId).filter((c) => !userId || c.userId === userId).map(publicClaim); }
