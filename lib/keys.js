// New writes use the dedicated, account-bound credential vault. Legacy blobs
// remain read-only compatible until explicitly rewrapped by the sole writer.
import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredCredentialVault } from './credential-vault.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, 'data');

function masterKey() {
  let secret = process.env.SESSION_SECRET || '';
  if (!secret) {
    const f = join(DATA_DIR, 'session-secret');
    try { if (existsSync(f)) secret = readFileSync(f, 'utf8').trim(); } catch { /* keep empty */ }
  }
  if (!secret) throw new Error('SESSION_SECRET unavailable — cannot encrypt user keys');
  return createHash('sha256').update(`iost-userkeys:${secret}`).digest(); // 32 bytes
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
  let blob;
  try { blob = configuredCredentialVault().seal(user.id, 'kraken', JSON.stringify({ apiKey, apiSecret })); }
  catch { return { ok: false, error: 'credential vault unavailable' }; }
  user.krakenKey = blob;
  user.krakenKeyStatus = { configured: true, lastVerified: Date.now(), maskedKey: apiKey.slice(0, 4) + '…' + apiKey.slice(-4) };
  return { ok: true };
}

/** Decrypt a user's Kraken credentials — CALLER MUST NOT LOG/RETURN THESE. */
export function getUserKrakenKeys(user) {
  if (!user?.krakenKey) return null;
  if (Object.hasOwn(user.krakenKey, 'version')) {
    try {
      const payload = JSON.parse(configuredCredentialVault().open(user.id, 'kraken', user.krakenKey));
      return typeof payload?.apiKey === 'string' && payload.apiKey && typeof payload.apiSecret === 'string' && payload.apiSecret
        ? { apiKey: payload.apiKey, apiSecret: payload.apiSecret } : null;
    } catch { return null; }
  }
  const dec = decrypt(user.krakenKey);
  if (!dec) return null;
  const [apiKey, apiSecret] = dec.split('\n');
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

export function clearUserKrakenKey(user) {
  if (user) { delete user.krakenKey; delete user.krakenKeyStatus; }
}

/** Explicit in-memory rewrap only; caller must persist via the sole writer. */
export function rewrapUserKrakenKey(user) {
  const keys = getUserKrakenKeys(user);
  if (!keys) return { ok: false, error: 'credential unavailable' };
  try {
    const blob = configuredCredentialVault().seal(user.id, 'kraken', JSON.stringify(keys));
    user.krakenKey = blob;
    return { ok: true };
  } catch { return { ok: false, error: 'credential vault unavailable' }; }
}

/** Masked status for APIs — never the key material. */
export function userKrakenStatus(user) {
  return user?.krakenKeyStatus || { configured: false };
}
