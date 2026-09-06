// Short-lived, resource-bound OAuth sessions for autonomous agents.
//
// Long-lived itk_ credentials authenticate the workload at the token endpoint,
// but never need to accompany normal MCP/API requests. Access tokens are opaque,
// held only as SHA-256 digests, restricted to one resource and may only reduce
// the source key's scopes. A process restart intentionally invalidates them all.

import crypto from 'node:crypto';

export const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
export const SESSION_RETENTION_MS = 60 * 60_000;

const sessions = new Map(); // sha256(token) -> server-owned session evidence
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const tokenRef = () => `ats_${crypto.randomBytes(12).toString('hex')}`;

function normalizeScopes(scopes) {
  return [...new Set((Array.isArray(scopes) ? scopes : [])
    .map((scope) => String(scope || '').trim())
    .filter(Boolean))];
}

function resourceScopes(resource, sourceScopes) {
  const scopes = normalizeScopes(sourceScopes);
  return resource.endsWith('/mcp') ? scopes.filter((scope) => scope !== 'trade-live') : scopes;
}

export function selectSessionScopes({ resource, sourceScopes, requestedScopes }) {
  const allowed = resourceScopes(resource, sourceScopes);
  const requested = requestedScopes == null ? allowed : normalizeScopes(requestedScopes);
  if (!requested.length || requested.some((scope) => !allowed.includes(scope))) {
    return { ok: false, error: 'invalid_scope', allowed };
  }
  return { ok: true, scopes: requested };
}

export function issueAgentSession({ principal, resource, scopes, now = Date.now() }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const entry = {
    sessionRef: tokenRef(), userId: principal.userId, keyId: principal.keyId,
    resource, scopes: normalizeScopes(scopes), createdAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_MS, lastUsedAt: null, revokedAt: null,
  };
  sessions.set(sha256(token), entry);
  cleanupAgentSessions(now);
  return { token, entry: { ...entry, scopes: entry.scopes.slice() } };
}

export function resolveAgentSession(token, { resource, isKeyActive, now = Date.now() } = {}) {
  if (!token || typeof token !== 'string') return null;
  const entry = sessions.get(sha256(token));
  if (!entry || entry.revokedAt || entry.expiresAt <= now || entry.resource !== resource) return null;
  if (typeof isKeyActive === 'function' && !isKeyActive(entry.keyId, entry.userId)) return null;
  entry.lastUsedAt = now;
  return {
    userId: entry.userId, keyId: entry.keyId, name: 'oauth-session',
    scopes: entry.scopes.slice(), sessionRef: entry.sessionRef,
    credentialType: 'short-lived-resource-bound', expiresAt: entry.expiresAt,
  };
}

export function revokeAgentSession(token, now = Date.now()) {
  if (!token || typeof token !== 'string') return false;
  const entry = sessions.get(sha256(token));
  if (!entry || entry.revokedAt) return false;
  entry.revokedAt = now;
  return true;
}

export function cleanupAgentSessions(now = Date.now()) {
  for (const [digest, entry] of sessions) {
    const terminalAt = Number(entry.revokedAt || entry.expiresAt || 0);
    if (terminalAt && now - terminalAt > SESSION_RETENTION_MS) sessions.delete(digest);
  }
}

export function agentSessionSecurityStatus({ userId, keyId = null, isKeyActive = null, now = Date.now() } = {}) {
  cleanupAgentSessions(now);
  const rows = [...sessions.values()].filter((entry) => entry.userId === userId && (!keyId || entry.keyId === keyId));
  const statusOf = (entry) => {
    if (entry.revokedAt) return 'revoked';
    if (typeof isKeyActive === 'function' && !isKeyActive(entry.keyId, entry.userId)) return 'source-key-revoked';
    return entry.expiresAt <= now ? 'expired' : 'active';
  };
  const active = rows.filter((entry) => statusOf(entry) === 'active');
  return {
    ok: true,
    mode: 'paper-only',
    version: 1,
    status: 'healthy',
    counts: {
      total: rows.length,
      active: active.length,
      expired: rows.filter((entry) => !entry.revokedAt && entry.expiresAt <= now).length,
      revoked: rows.filter((entry) => ['revoked', 'source-key-revoked'].includes(statusOf(entry))).length,
      mcpBound: active.filter((entry) => entry.resource.endsWith('/mcp')).length,
      apiBound: active.filter((entry) => !entry.resource.endsWith('/mcp')).length,
    },
    sessions: rows.map((entry) => ({
      sessionRef: entry.sessionRef,
      status: statusOf(entry),
      resource: entry.resource.endsWith('/mcp') ? 'mcp' : 'api',
      scopes: entry.scopes.slice(),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      lastUsedAt: entry.lastUsedAt,
    })),
    policy: {
      accessTokenTtlMs: ACCESS_TOKEN_TTL_MS,
      resourceBound: true,
      audienceValidated: true,
      scopeDownscoping: true,
      mcpLiveScopeExcluded: true,
      plaintextTokensStored: false,
      sourceKeyRevocationFailClosed: true,
      restartInvalidatesSessions: true,
      directApiKeyCompatibility: true,
      preferredTransport: 'short-lived-oauth-session',
    },
    guarantees: {
      authorityExpanded: false,
      executionPermissionsChanged: false,
      tokenPassthroughAllowed: false,
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

export function resetAgentSessionsForTests() { sessions.clear(); }
