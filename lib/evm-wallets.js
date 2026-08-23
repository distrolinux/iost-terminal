// EIP-191 wallet binding for AITT conversion. Scratchable via IOST_DATA_DIR.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'evm-wallets.json');
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function load() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'));
      if (d && d.challenges && d.bindings) return d;
    }
  } catch { /* fresh */ }
  return { challenges: {}, bindings: {} };
}
function save(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
}
function challengeMessage({ domain, chainId, userId, address, nonce, issuedAt, expiresAt }) {
  return [
    'IOST Terminal AITT wallet binding', `Domain: ${domain}`, `Chain ID: ${chainId}`,
    `Account: ${userId}`, `Address: ${address}`, `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`, `Expires At: ${new Date(expiresAt).toISOString()}`,
    'Purpose: bind this EVM address for earned points to AITT conversion. No transaction or payment is authorized.',
  ].join('\n');
}

export function createChallenge({ userId, address, domain = 'iostcallister.com', chainId = 182 }) {
  if (!userId) throw new Error('userId required');
  const normalized = getAddress(String(address || ''));
  const store = load();
  const issuedAt = Date.now();
  for (const [id, prior] of Object.entries(store.challenges)) {
    if (prior.usedAt || prior.expiresAt < issuedAt) delete store.challenges[id];
  }
  const expiresAt = issuedAt + CHALLENGE_TTL_MS;
  const challengeId = `ewc_${crypto.randomBytes(12).toString('hex')}`;
  const row = { challengeId, userId, address: normalized, domain, chainId, nonce: crypto.randomBytes(16).toString('hex'), issuedAt, expiresAt, usedAt: null };
  row.message = challengeMessage(row);
  store.challenges[challengeId] = row;
  save(store);
  return { challengeId, address: normalized, message: row.message, expiresAt };
}

export function verifyChallenge({ challengeId, signature, expectedUserId = null }) {
  const store = load();
  const row = store.challenges[challengeId];
  if (!row) return { ok: false, error: 'challenge not found' };
  if (row.usedAt) return { ok: false, error: 'challenge already used' };
  if (row.expiresAt < Date.now()) return { ok: false, error: 'challenge expired' };
  if (expectedUserId && row.userId !== expectedUserId) return { ok: false, error: 'challenge account mismatch' };
  let recovered;
  try { recovered = getAddress(verifyMessage(row.message, signature)); }
  catch { return { ok: false, error: 'invalid signature' }; }
  if (recovered !== row.address) return { ok: false, error: 'signature address mismatch' };
  const collision = Object.entries(store.bindings).find(([uid, b]) => uid !== row.userId && b.address === row.address);
  if (collision) return { ok: false, error: 'address already bound to another account' };
  const current = store.bindings[row.userId];
  if (current && current.address !== row.address) return { ok: false, error: 'account already bound; rebinding requires review' };
  row.usedAt = Date.now();
  store.bindings[row.userId] = current || { userId: row.userId, address: row.address, boundAt: row.usedAt, challengeId };
  save(store);
  return { ok: true, binding: store.bindings[row.userId] };
}

export function getBinding(userId) { return load().bindings[userId] || null; }
