import assert from 'node:assert/strict';
import {
  ACCESS_TOKEN_TTL_MS, agentSessionSecurityStatus, issueAgentSession,
  resetAgentSessionsForTests, resolveAgentSession, revokeAgentSession,
  selectSessionScopes,
} from '../lib/agent-sessions.js';

resetAgentSessionsForTests();
const principal = { userId: 'owner-a', keyId: 'key-a', scopes: ['read', 'trade-paper', 'trade-live'] };
const mcp = 'https://example.test/mcp';
const api = 'https://example.test/';

const defaults = selectSessionScopes({ resource: mcp, sourceScopes: principal.scopes });
assert.deepEqual(defaults.scopes, ['read', 'trade-paper'], 'MCP sessions must remove live scope');
const narrowed = selectSessionScopes({ resource: mcp, sourceScopes: principal.scopes, requestedScopes: ['read'] });
assert.deepEqual(narrowed.scopes, ['read']);
assert.equal(selectSessionScopes({ resource: mcp, sourceScopes: principal.scopes, requestedScopes: ['trade-live'] }).ok, false);
assert.equal(selectSessionScopes({ resource: api, sourceScopes: ['read'], requestedScopes: ['read', 'trade-paper'] }).ok, false);
assert.equal(selectSessionScopes({ resource: api, sourceScopes: ['read'], requestedScopes: [] }).ok, false);

const start = 1_800_000_000_000;
const issued = issueAgentSession({ principal, resource: mcp, scopes: narrowed.scopes, now: start });
assert.equal(issued.entry.expiresAt - issued.entry.createdAt, ACCESS_TOKEN_TTL_MS);
assert(!JSON.stringify(issued.entry).includes(issued.token), 'session evidence must not retain plaintext token');
assert.equal(resolveAgentSession(issued.token, { resource: api, now: start + 1, isKeyActive: () => true }), null, 'token must be audience bound');
const resolved = resolveAgentSession(issued.token, { resource: mcp, now: start + 1, isKeyActive: () => true });
assert.equal(resolved.userId, principal.userId);
assert.deepEqual(resolved.scopes, ['read']);
assert.equal(resolveAgentSession(issued.token, { resource: mcp, now: start + 2, isKeyActive: () => false }), null, 'source-key revocation must fail closed');

let status = agentSessionSecurityStatus({ userId: principal.userId, now: start + 3 });
assert.equal(status.counts.active, 1);
assert.equal(status.counts.mcpBound, 1);
assert.equal(status.policy.accessTokenTtlMs, 900_000);
assert.equal(status.policy.plaintextTokensStored, false);
assert.equal(status.policy.scopeDownscoping, true);
assert.equal(status.guarantees.authorityExpanded, false);
assert.equal(status.execution.tradeCreated, false);
assert.equal(status.liveScopeUsed, false);
assert.equal(status.publicChainUsed, false);
const sourceRevokedStatus = agentSessionSecurityStatus({
  userId: principal.userId, now: start + 3, isKeyActive: () => false,
});
assert.equal(sourceRevokedStatus.counts.active, 0);
assert.equal(sourceRevokedStatus.counts.revoked, 1, 'source-key revocation must be visible in sanitized status');

assert.equal(revokeAgentSession(issued.token, start + 4), true);
assert.equal(revokeAgentSession(issued.token, start + 5), false, 'revocation must be idempotently terminal');
assert.equal(resolveAgentSession(issued.token, { resource: mcp, now: start + 6, isKeyActive: () => true }), null);
status = agentSessionSecurityStatus({ userId: principal.userId, now: start + 6 });
assert.equal(status.counts.active, 0);
assert.equal(status.counts.revoked, 1);

const expiring = issueAgentSession({ principal, resource: api, scopes: ['read'], now: start });
assert.equal(resolveAgentSession(expiring.token, { resource: api, now: start + ACCESS_TOKEN_TTL_MS, isKeyActive: () => true }), null);

console.log('agent session security check: ok');
