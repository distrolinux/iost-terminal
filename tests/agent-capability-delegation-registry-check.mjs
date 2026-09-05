import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAgentCapabilityRegistry, registryEvidenceForPrincipal } from '../lib/agent-capability-registry.js';
import { buildMcpTools } from '../lib/mcp-protocol.js';

const now = 1_800_000_000_000;
const registry = buildAgentCapabilityRegistry({
  now,
  keys: [
    { id: 'key-ready', name: 'Executor', scopes: ['read', 'trade-paper'], revokedAt: null },
    { id: 'key-observe', name: 'Observer', scopes: ['read'], revokedAt: null },
    { id: 'key-revoked', name: 'Old agent', scopes: ['read', 'trade-paper'], revokedAt: now - 1 },
  ],
  wallets: [{ walletId: 'wallet-1', status: 'active', capabilities: ['trade.paper'] }],
  pacts: [{ pactId: 'pact-1', agentWalletId: 'wallet-1', status: 'active', completion: { type: 'time', deadlineTs: now + 60_000 }, expiresAt: now + 60_000 }],
  missions: [{ status: 'running', walletId: 'wallet-1', pactId: 'pact-1' }],
  runtimesByKey: {
    'key-ready': { enrolled: true, ready: true, status: 'ready', supervisor: { managed: true, healthy: true }, quarantine: { active: false } },
    'key-observe': { enrolled: false, ready: false, status: 'not-enrolled', supervisor: { managed: false, healthy: false }, quarantine: { active: false } },
  },
});

assert.equal(registry.mode, 'paper-only');
assert.equal(registry.status, 'healthy');
assert.equal(registry.counts.total, 3);
assert.equal(registry.counts.active, 2);
assert.equal(registry.counts.revoked, 1);
assert.equal(registry.counts.executionReady, 1);
assert.equal(registry.counts.observeOnly, 1);
assert.equal(registry.counts.activeWalletPactBindings, 1);
assert.equal(registry.counts.runningMissions, 1);

const ready = registry.agents.find((agent) => agent.agentRef === 'key-ready');
assert.deepEqual(ready.effectiveCapabilities, [
  'market.observe', 'mission.checkpoint', 'paper.execute', 'paper.preflight', 'portfolio.inspect', 'risk.assess', 'strategy.analyze',
]);
assert.equal(ready.delegation.ownerApprovedCredential, true);
assert.equal(ready.delegation.runtimeReady, true);
assert.equal(ready.delegation.walletPactAuthorityAvailable, true);
assert.equal(ready.delegation.completionBound, true);
assert.equal(ready.delegation.expiresAt, now + 60_000);

const observer = registry.agents.find((agent) => agent.agentRef === 'key-observe');
assert.equal(observer.status, 'observe-only');
assert(!observer.effectiveCapabilities.includes('paper.execute'));
assert(observer.withheldCapabilities.some((item) => item.capability === 'paper.execute' && item.reasonCode === 'trade-paper-scope-required'));

const revoked = registry.agents.find((agent) => agent.agentRef === 'key-revoked');
assert.equal(revoked.status, 'revoked');
assert.deepEqual(revoked.effectiveCapabilities, []);

const evidence = registryEvidenceForPrincipal(registry, 'key-ready');
assert.equal(evidence.currentAgent.status, 'execution-ready');
assert.equal(evidence.currentAgent.agentRef, undefined);
assert.equal(evidence.currentAgent.name, undefined);
assert.equal(evidence.agents, undefined);
assert.equal(evidence.guarantees.selfAssertedAuthorityAccepted, false);
assert.equal(evidence.liveScopeUsed, false);
assert.equal(evidence.publicChainUsed, false);

const missing = registryEvidenceForPrincipal(registry, 'not-registered');
assert.equal(missing.currentAgent.status, 'not-registered');
assert.deepEqual(missing.currentAgent.effectiveCapabilities, []);

const tool = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] })
  .find((item) => item.name === 'agent_capability_registry_status');
assert(tool);
assert.equal(tool.annotations.readOnlyHint, true);
assert.equal(tool.annotations.destructiveHint, false);
assert.equal(tool.annotations.idempotentHint, true);
assert(!buildMcpTools().some((item) => item.name === 'agent_capability_registry_status'));

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(server, /case 'agent_capability_registry_status'/);
assert.match(server, /app\.get\('\/api\/agent-capability-registry', requireUser/);
assert.match(server, /const DISCOVERY_VERSION = '1\.42\.0'/);
assert.match(app, /Agent Capability &amp; Delegation Registry/);
assert.match(app, /Effective authority is derived/);

console.log('agent capability and delegation registry checks passed');
