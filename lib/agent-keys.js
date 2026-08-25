// lib/agent-keys.js — per-user AI-agent API keys ("connect your AI agent")
//
// owner-approved model (2026-08-10): every customer can create API keys for
// their own AI agents. A key is bound to ONE user account and can only trade
// THAT account (paper by default). Scopes:
//   read        — read platform state for the bound account (default, always on)
//   trade-paper — open/close paper trades on the bound account
//   trade-live  — REQUEST live trades (owner-only creation; executed ONLY after
//                 the owner approves the proposal — option C, human-in-the-loop)
//
// SECURITY: only the SHA-256 hash of a key is stored (plus a 10-char prefix
// for display). The full key ("itk_…") is returned EXACTLY ONCE at creation —
// like a wallet seed, the UI shows it one time and warns the user.
// Keys are revocable: revoke() makes resolve() return null immediately.

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, '..', 'data');
const STORE_FILE = join(DATA_DIR, 'agent-keys.json');

export const VALID_SCOPES = ['read', 'trade-paper', 'trade-live'];
export const KEY_PREFIX = 'itk_';

// store: data/agent-keys.json — { byId: { [id]: entry } }
// entry: { id, userId, name, prefix, hash, scopes[], createdAt, lastUsedAt?, revokedAt? }
function loadStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    if (parsed && parsed.byId && typeof parsed.byId === 'object') return parsed;
  } catch { /* corrupt -> fresh */ }
  return { byId: {} };
}
function saveStore(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, STORE_FILE);
  chmodSync(STORE_FILE, 0o600);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// constant-time compare of two hex sha256 digests (256-bit — timing attacks
// are negligible, but the cheap habit keeps the auth path honest)
function hashEq(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}
const rand = (bytes) => crypto.randomBytes(bytes).toString('base64url');

export function createKey({ userId, name, scopes }) {
  const store = loadStore();
  const clean = (scopes || ['read']).filter((s) => VALID_SCOPES.includes(s));
  if (!clean.includes('read')) clean.unshift('read'); // read is always on
  const secret = `${KEY_PREFIX}${rand(32)}`;
  const id = rand(8);
  store.byId[id] = {
    id, userId, name: String(name || 'My AI agent').slice(0, 60),
    prefix: secret.slice(0, 14), hash: sha256(secret),
    scopes: clean, createdAt: Date.now(), lastUsedAt: null, revokedAt: null,
  };
  saveStore(store);
  return { ok: true, key: secret, entry: publicEntry(store.byId[id]) };
}

export function listKeys(userId) {
  const store = loadStore();
  return Object.values(store.byId)
    .filter((k) => k.userId === userId)
    .map(publicEntry)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function revokeKey({ userId, id }) {
  const store = loadStore();
  const k = store.byId[id];
  if (!k || k.userId !== userId) return { ok: false, error: 'key not found' };
  k.revokedAt = Date.now();
  saveStore(store);
  return { ok: true };
}

// Resolve an apiKey header to a principal, or null. Also expires nothing —
// revocation is the only way to kill a key.
export function resolve(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith(KEY_PREFIX)) return null;
  const store = loadStore();
  const h = sha256(apiKey);
  const hit = Object.values(store.byId).find((k) => !k.revokedAt && hashEq(k.hash, h));
  if (!hit || hit.revokedAt) return null;
  return { userId: hit.userId, keyId: hit.id, name: hit.name, scopes: hit.scopes.slice() };
}

export function touch(keyId) {
  const store = loadStore();
  const k = store.byId[keyId];
  if (!k) return;
  k.lastUsedAt = Date.now();
  saveStore(store);
}

// OAuth 2.0 client_credentials support (v1.17): client_id = the key's public
// id, client_secret = the full "itk_…" secret. Verification is the same
// sha256-compare as resolve() — the secret is never stored, only its hash.
export function verifySecret(id, secret) {
  if (!id || !secret || typeof id !== 'string' || typeof secret !== 'string') return null;
  const store = loadStore();
  const k = store.byId[id];
  if (!k || k.revokedAt) return null;
  if (!hashEq(k.hash, sha256(secret))) return null;
  return { userId: k.userId, keyId: k.id, name: k.name, scopes: k.scopes.slice() };
}

/** Revalidate a credential derived from an agent key identity (for example an
 * OAuth bearer token). Revocation must invalidate every derived credential,
 * even when the derived token has not reached its own expiry yet. */
export function isActiveKey(id, userId = null) {
  if (!id || typeof id !== 'string') return false;
  const store = loadStore();
  const k = store.byId[id];
  if (!k || k.revokedAt) return false;
  return userId == null || k.userId === userId;
}

function publicEntry(k) {
  return {
    id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes.slice(),
    createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null, revokedAt: k.revokedAt ?? null,
  };
}
