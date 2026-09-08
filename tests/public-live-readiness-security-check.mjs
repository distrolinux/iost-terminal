import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSecuritySentinel } from '../lib/security-sentinel.js';
import { buildPublicLiveReadiness } from '../lib/public-live-readiness.js';

const now = Date.now();
const warm = buildSecuritySentinel({ events: [], observationStartedAt: now - 60_000, now });
assert.equal(warm.status, 'warming-up');
assert.equal(warm.evidenceSufficient, false);

const healthy = buildSecuritySentinel({ events: [], observationStartedAt: now - 16 * 60_000, now });
assert.equal(healthy.status, 'healthy');
assert.equal(healthy.evidenceSufficient, true);
assert.equal(healthy.guarantees.monitorOnly, true);
assert.equal(healthy.guarantees.storesIpAddresses, false);
assert.equal(healthy.guarantees.storesCredentials, false);
assert.equal(healthy.guarantees.storesRequestBodies, false);
assert.equal(healthy.authorityExpanded, false);
assert.equal(healthy.liveScopeUsed, false);

const attack = buildSecuritySentinel({
  events: Array.from({ length: 20 }, (_, index) => ({ at: now - index, kind: 'auth-rejected' })),
  observationStartedAt: now - 16 * 60_000,
  now,
});
assert.equal(attack.status, 'attention');
assert.equal(attack.reasonCode, 'authentication-rejection-spike');

const locked = buildPublicLiveReadiness({ security: healthy, releaseTrust: { decision: 'allow' } });
assert.equal(locked.status, 'locked');
assert.equal(locked.decision, 'deny');
assert.equal(locked.progress.passed, 2);
assert.equal(locked.execution.attempted, false);
assert.equal(locked.execution.tradeCreated, false);
assert.equal(locked.launchModel.platformCustody, false);
assert.equal(locked.launchModel.agentSelfAuthorization, false);

const ready = buildPublicLiveReadiness({
  security: healthy,
  releaseTrust: { decision: 'allow' },
  venueConnected: true,
  liveFeatureAvailable: true,
  venuePermissionVerified: true,
  secretVaultReady: true,
  transactionAuthorizationReady: true,
  independentAuditVerified: true,
  complianceApproved: true,
  jurisdictionControlsReady: true,
});
assert.equal(ready.status, 'ready-for-controlled-canary');
assert.equal(ready.decision, 'allow-controlled-canary');
assert.deepEqual(ready.progress, { passed: 10, total: 10, percent: 100 });
assert.equal(ready.execution.attempted, false);
assert.equal(ready.authorityExpanded, false);
assert.equal(ready.liveScopeUsed, false);

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const docs = readFileSync(new URL('../docs/PUBLIC_LIVE_READINESS_SECURITY.md', import.meta.url), 'utf8');
for (const route of ['/api/security-sentinel', '/api/public-live-readiness']) assert.ok(server.includes(route));
for (const tool of ['agent_security_sentinel_status', 'public_execution_launch_readiness']) assert.ok(protocol.includes(tool));
for (const phrase of ['Public live readiness', 'Security Sentinel', 'live locked', 'IP addresses']) assert.ok(ui.includes(phrase));
assert.ok(docs.includes('Real-money public execution is locked'));

console.log('public live readiness and Security Sentinel: ok');
