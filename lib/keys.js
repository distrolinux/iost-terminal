// lib/keys.js — encrypted per-user Kraken key store (v3, Phase 2).
// Keys are AES-256-GCM encrypted at rest with a key derived from the session
// secret (SESSION_SECRET env or data/session-secret file). NEVER plaintext on
// disk, NEVER returned by any API. If the session secret is rotated, user keys
// become undecryptable — document that (ops skill).
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function masterKey() {
  let secret = process.env.SESSION_SECRET || '';
  if (!secret) {
    const f = join(ROOT, 'data', 'session-secret');
    try { if (existsSync(f)) secret = readFileSync(f, 'utf8').trim(); } catch { /* keep empty */ }
  }
  if (!secret) throw new Error('SESSION_SECRET unavailable — cannot encrypt user keys');
  return createHash('sha256').update(`iost-userkeys:${secret}`).digest(); // 32 bytes
}

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') };
}

function decrypt(blob) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
  } catch { return null; } // wrong key / corrupt — treat as unavailable
}

/** Store a user's Kraken credentials encrypted on their user record. */
export function setUserKrakenKey(user, apiKey, apiSecret) {
  if (!user || !apiKey || !apiSecret) return { ok: false, error: 'apiKey and apiSecret required' };
  user.krakenKey = encrypt(`${apiKey}\n${apiSecret}`);
  user.krakenKeyStatus = { configured: true, lastVerified: Date.now(), maskedKey: apiKey.slice(0, 4) + '…' + apiKey.slice(-4) };
  return { ok: true };
}

/** Decrypt a user's Kraken credentials — CALLER MUST NOT LOG/RETURN THESE. */
export function getUserKrakenKeys(user) {
  if (!user?.krakenKey) return null;
  const dec = decrypt(user.krakenKey);
  if (!dec) return null;
  const [apiKey, apiSecret] = dec.split('\n');
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

export function clearUserKrakenKey(user) {
  if (user) { delete user.krakenKey; delete user.krakenKeyStatus; }
}

/** Masked status for APIs — never the key material. */
export function userKrakenStatus(user) {
  return user?.krakenKeyStatus || { configured: false };
}
