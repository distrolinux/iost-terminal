// lib/payments.js — crypto credit purchases (v3, Phase 3).
// User picks a bundle → pays crypto to the owner's wallet (addresses in
// fee-config.json) → submits tx reference → payment sits PENDING until the
// owner confirms (human verification, zero payment-processor dependency).
// Confirmation grants credits to the account wallet (lib/fees.js).
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFeeConfig, grantCredits } from './fees.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, 'data');
const FILE = join(DATA_DIR, 'payments.json');

let payments = load();

function load() {
  try {
    if (existsSync(FILE)) {
      const p = JSON.parse(readFileSync(FILE, 'utf8'));
      return Array.isArray(p.payments) ? p.payments : [];
    }
  } catch { /* corrupt -> empty */ }
  return [];
}

function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ payments }, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
    chmodSync(FILE, 0o600);
  } catch { /* payments writes must never crash trading */ }
}

const pid = () => 'pay_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Create a pending payment. `asset` must be a key in fee-config wallet. */
export function createPayment(account, bundleId, { asset, txRef } = {}) {
  const cfg = getFeeConfig();
  const bundle = cfg.bundles.find(b => b.id === bundleId);
  if (!bundle) return { ok: false, error: 'unknown bundle' };
  const address = cfg.wallet?.[asset];
  if (!address) return { ok: false, error: `no wallet address configured for ${asset} — contact owner` };
  if (!txRef || !String(txRef).trim()) return { ok: false, error: 'transaction reference required' };
  const payment = {
    id: pid(), accountId: account.accountId, owner: account.owner,
    bundleId: bundle.id, usd: bundle.usd, credits: bundle.credits,
    asset, address, txRef: String(txRef).trim().slice(0, 200),
    status: 'pending', createdAt: Date.now(), confirmedAt: null, note: null,
  };
  payments.push(payment);
  persist();
  return { ok: true, payment };
}

export function listPayments({ accountId = null, status = null } = {}) {
  return payments
    .filter(p => (!accountId || p.accountId === accountId) && (!status || p.status === status))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getPayment(id) {
  return payments.find(p => p.id === id) || null;
}

/** Owner confirms receipt → grants credits to the account wallet. */
export function confirmPayment(paymentId, getAccountFn, note = '') {
  const p = getPayment(paymentId);
  if (!p) return { ok: false, error: 'payment not found' };
  if (p.status !== 'pending') return { ok: false, error: `payment already ${p.status}` };
  const account = getAccountFn(p.accountId);
  if (!account) return { ok: false, error: 'account not found' };
  const g = grantCredits(account, p.credits, `bundle ${p.bundleId} ($${p.usd}) ${p.asset} ${p.txRef}`);
  if (!g.ok) return { ok: false, error: g.error };
  p.status = 'confirmed'; p.confirmedAt = Date.now(); p.note = note || null;
  persist();
  return { ok: true, payment: p, credits: g.credits };
}

export function rejectPayment(paymentId, note = '') {
  const p = getPayment(paymentId);
  if (!p) return { ok: false, error: 'payment not found' };
  if (p.status !== 'pending') return { ok: false, error: `payment already ${p.status}` };
  p.status = 'rejected'; p.note = note || null;
  persist();
  return { ok: true, payment: p };
}
