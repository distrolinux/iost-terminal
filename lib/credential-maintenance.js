import { randomBytes } from 'node:crypto';
import { configuredCredentialVault } from './credential-vault.js';
import { getUserKrakenKeys, rewrapUserKrakenKey } from './keys.js';

// Browser projection only. No key IDs, ciphertext, credentials or owner IDs.
export function credentialStorageStatus(user) {
  let vaultConfigured = false;
  try { configuredCredentialVault(); vaultConfigured = true; } catch { /* unavailable */ }
  const blob = user?.krakenKey;
  const format = !blob ? 'none' : !Object.hasOwn(blob, 'version') ? 'legacy-session-bound'
    : blob.version === 1 ? 'account-bound-v1' : 'unsupported';
  const migrationNeeded = Boolean(blob) && (format !== 'account-bound-v1' || blob.keyId !== process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID);
  return { vaultConfigured, format, migrationNeeded, canPreview: vaultConfigured && Boolean(blob) && format !== 'unsupported' && migrationNeeded,
    integrity: 'not-checked', externalKmsVerified: false, executionAuthority: 'none' };
}

// Sole-process, owner-session plans: short-lived, one-use, bounded, ciphertext only.
// No timer or background migration. A restart invalidates all plans.
export function createCredentialMaintenance({ backup, persist, now = Date.now } = {}) {
  const plans = new Map();
  const prune = () => { for (const [key, p] of plans) if (now() >= p.expiresAt) plans.delete(key); };
  const fail = reasonCode => ({ ok: false, reasonCode, executionAuthority: 'none' });
  return {
    preview(user, sessionId) {
      prune();
      if (!user?.id || !sessionId || !credentialStorageStatus(user).canPreview) return fail('storage-upgrade-unavailable');
      const original = getUserKrakenKeys(user);
      if (!original) return fail('credential-unreadable');
      const candidate = { id: user.id, krakenKey: structuredClone(user.krakenKey) };
      if (!rewrapUserKrakenKey(candidate).ok || JSON.stringify(getUserKrakenKeys(candidate)) !== JSON.stringify(original)) return fail('roundtrip-failed');
      for (const [key, p] of plans) if (p.owner === user.id && p.sessionId === sessionId) plans.delete(key);
      if (plans.size >= 1000) return fail('maintenance-busy');
      const token = randomBytes(32).toString('hex');
      const expiresAt = now() + 300_000;
      plans.set(token, { owner: user.id, sessionId, before: JSON.stringify(user.krakenKey), replacement: candidate.krakenKey, expiresAt });
      return { ok: true, token, expiresAt, credentialCount: 1, roundtripVerified: true, persisted: false, backupCreated: false, executionAuthority: 'none' };
    },
    apply(user, sessionId, token, confirmed) {
      prune();
      const plan = typeof token === 'string' ? plans.get(token) : null;
      if (!plan || plan.owner !== user?.id || plan.sessionId !== sessionId || confirmed !== true) return fail('fresh-owner-confirmation-required');
      plans.delete(token);
      if (JSON.stringify(user.krakenKey) !== plan.before || plan.replacement.keyId !== process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID) return fail('credential-or-vault-changed');
      const original = getUserKrakenKeys(user);
      const reopened = getUserKrakenKeys({ id: user.id, krakenKey: plan.replacement });
      if (!original || !reopened || JSON.stringify(original) !== JSON.stringify(reopened)) return fail('credential-or-vault-changed');
      try {
        // Both callbacks must be synchronous. Persist commits atomically before
        // mutating the in-memory user, so a failed pre-commit write preserves it.
        backup({ version: 1, provider: 'kraken', ownerId: user.id, createdAt: now(), krakenKey: JSON.parse(plan.before) });
        persist(user, plan.replacement);
      } catch { return fail('storage-upgrade-failed'); }
      return { ok: true, reasonCode: 'storage-upgraded', backupCreated: true, roundtripVerified: true, persisted: true, executionAuthority: 'none', authorityExpanded: false };
    },
  };
}
