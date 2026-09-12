import { randomBytes } from 'node:crypto';
import { configuredCredentialVault } from './credential-vault.js';
import { verifyKrakenConnection } from './kraken-connection-verification.js';

// Read-only key enrollment. Encrypted pending candidates only; no live authority.
export function createKrakenOnboarding({ persist, verify = verifyKrakenConnection, vault = configuredCredentialVault, enabled = () => process.env.KRAKEN_READONLY_ONBOARDING_ENABLED === '1', now = Date.now } = {}) {
  const plans = new Map(), pending = new Set();
  const fail = reasonCode => ({ ok: false, reasonCode, executionAuthority: 'none' });
  const prune = () => { for (const [token, plan] of plans) if (plan.expiresAt <= now()) plans.delete(token); };
  const available = () => { try { return enabled() && Boolean(vault().activeKeyId); } catch { return false; } };
  return {
    status(user) { return { enabled: available(), canConnect: available() && !user?.krakenKey, profile: 'read-only-only', credentialsAcceptedByAgent: false, executionAuthority: 'none' }; },
    async preview(user, sessionId, input) {
      prune();
      if (!available()) return fail('onboarding-disabled-or-vault-unavailable');
      if (!user?.id || !sessionId || user.krakenKey) return fail('existing-connection-or-owner-unavailable');
      if (!input || Object.keys(input).some(k => !['apiKey', 'apiSecret', 'consent'].includes(k)) || input.consent !== true) return fail('explicit-owner-consent-required');
      const { apiKey, apiSecret } = input;
      if (typeof apiKey !== 'string' || !/^[A-Za-z0-9+/=]{16,512}$/.test(apiKey) || typeof apiSecret !== 'string' || !/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(apiSecret) || Buffer.from(apiSecret, 'base64').toString('base64') !== apiSecret) return fail('invalid-credential-format');
      if (pending.has(user.id) || pending.size >= 20 || plans.size >= 100) return fail('onboarding-busy');
      pending.add(user.id);
      const passwordState = user.passHash;
      try {
        const result = await verify({ apiKey, apiSecret }, { requireReadOnly: true });
        if (!available() || user.krakenKey || user.passHash !== passwordState) return fail('account-or-vault-changed');
        if (result.accountHealth !== 'reachable' || result.profile !== 'read-only' || result.permissionStatus !== 'observed-allowed-permissions') return fail('read-only-permission-verification-required');
        const v = vault(), plaintext = JSON.stringify({ apiKey, apiSecret });
        const replacement = v.seal(user.id, 'kraken', plaintext);
        if (v.open(user.id, 'kraken', replacement) !== plaintext) return fail('encryption-check-failed');
        for (const [key, p] of plans) if (p.owner === user.id && p.sessionId === sessionId) plans.delete(key);
        if (plans.size >= 100) return fail('onboarding-busy');
        const token = randomBytes(32).toString('hex'), expiresAt = now() + 120000;
        plans.set(token, { owner: user.id, sessionId, replacement, passwordState, expiresAt });
        return { ok: true, token, expiresAt, profile: 'read-only', balanceAccess: 'verified-not-displayed', saved: false, executionAuthority: 'none' };
      } catch { return fail('onboarding-verification-unavailable'); }
      finally { pending.delete(user.id); }
    },
    commit(user, sessionId, input) {
      prune();
      if (!input || Object.keys(input).some(k => !['token', 'confirmed'].includes(k)) || input.confirmed !== true) return fail('owner-confirmation-required');
      const p = typeof input.token === 'string' ? plans.get(input.token) : null;
      if (!p || p.owner !== user?.id || p.sessionId !== sessionId) return fail('fresh-owner-verification-required');
      plans.delete(input.token);
      try {
        if (!available() || user.krakenKey || user.passHash !== p.passwordState || vault().activeKeyId !== p.replacement.keyId) return fail('account-or-vault-changed');
        vault().open(user.id, 'kraken', p.replacement);
        persist(user, p.replacement, { configured: true, profile: 'read-only', permissionsVerified: false, onboardingVerifiedAt: now() });
        return { ok: true, saved: true, profile: 'read-only', executionAuthority: 'none', authorityExpanded: false };
      } catch { return fail('save-unconfirmed-refresh-status'); }
    },
  };
}
