import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'iost-owner-alert-router-'));
const secretFile = join(scratch, 'webhook-secret');
writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600 }); chmodSync(secretFile, 0o600);
process.env.IOST_DATA_DIR = scratch;
process.env.IOST_OWNER_ALERT_WEBHOOK_URL = 'https://alerts.example.test/iost';
process.env.IOST_OWNER_ALERT_WEBHOOK_SECRET_FILE = secretFile;

try {
  const router = await import(`../lib/owner-alert-router.js?test=${Date.now()}`);
  const now = 1_800_200_000_000;
  const incident = {
    incidentRef: 'inc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agentName: 'Hermes Paper Agent',
    category: 'runtime-offline', severity: 'critical', status: 'open',
    reasonCode: 'heartbeat-offline', summary: 'Runtime heartbeat lease expired.',
    occurrenceCount: 1,
  };
  const warming = { status: 'warming-up', reasonCode: 'insufficient-observation-window', burnRates: [] };
  assert.equal(router.reconcileOwnerAlerts({ ownerId: 'owner-a', keyId: 'key-a', incidents: { incidents: [incident] }, safetySlo: warming }, now), true);
  assert.equal(router.reconcileOwnerAlerts({ ownerId: 'owner-a', keyId: 'key-a', incidents: { incidents: [incident] }, safetySlo: warming }, now + 1), false, 'same signal must deduplicate');

  let status = router.ownerAlertStatus('owner-a', 'key-a');
  assert.equal(status.counts.total, 1);
  assert.equal(status.counts.critical, 1);
  assert.equal(status.counts.pending, 1);
  assert.equal(status.channels.signedWebhook.enabled, true);
  assert.equal(status.guarantees.notificationOnly, true);
  assert.equal(status.guarantees.authorityExpanded, false);
  assert.equal(status.liveScopeUsed, false);
  assert.equal(status.publicChainUsed, false);
  assert.equal(router.ownerAlertStatus('owner-a', 'key-other').counts.total, 0, 'alerts must not cross agent keys');
  assert.equal(router.ownerAlertStatus('owner-b').counts.total, 0, 'alerts must not cross owners');
  const historicalResolved = { ...incident, incidentRef: 'inc_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'resolved' };
  assert.equal(router.reconcileOwnerAlerts({ ownerId: 'owner-a', keyId: 'key-a', incidents: { incidents: [historicalResolved] }, safetySlo: warming }, now + 2), false);
  assert.equal(router.ownerAlertStatus('owner-a', 'key-a').counts.total, 1, 'pre-router resolved history must not page the owner');

  const stored = JSON.parse(readFileSync(router.ownerAlertStorePathForTest, 'utf8'));
  const request = router.buildSignedWebhookRequest(stored.alerts[0], process.env.IOST_OWNER_ALERT_WEBHOOK_URL, readFileSync(secretFile), now);
  assert.equal(request.headers['Idempotency-Key'], stored.alerts[0].eventId);
  assert.match(request.headers['Content-Digest'], /^sha-256=:[A-Za-z0-9+/]+=*:$/);
  assert.match(request.headers['Signature-Input'], /^iost=\("@method" "@target-uri"/);
  assert.match(request.headers.Signature, /^iost=:[A-Za-z0-9+/]+=*:$/);
  const event = JSON.parse(request.body);
  assert.equal(event.specversion, '1.0');
  assert.equal(event.id, stored.alerts[0].eventId);
  assert.equal(event.data.mode, 'paper-only');
  assert.equal(request.body.includes('owner-a'), false);
  assert.equal(request.body.includes('key-a'), false);

  let deliveries = 0;
  let result = await router.dispatchPendingAlerts(now, async () => { deliveries += 1; return { statusCode: 503 }; });
  assert.deepEqual(result, { attempted: 1, delivered: 0, retrying: 1, deadLetter: 0 });
  status = router.ownerAlertStatus('owner-a', 'key-a');
  assert.equal(status.alerts[0].delivery.webhook, 'retrying');
  assert(status.alerts[0].delivery.nextAttemptAt > now);

  result = await router.dispatchPendingAlerts(now + 1_000_000, async () => { deliveries += 1; return { statusCode: 204 }; });
  assert.deepEqual(result, { attempted: 1, delivered: 1, retrying: 0, deadLetter: 0 });
  assert.equal(deliveries, 2);
  status = router.ownerAlertStatus('owner-a', 'key-a');
  assert.equal(status.alerts[0].delivery.webhook, 'delivered');
  assert.equal(status.receiptChain.verified, true);
  assert.equal(status.receiptChain.count, 3, 'control-center plus retry and delivery receipts');

  const recovered = { ...incident, status: 'recovery-detected', severity: 'critical' };
  router.reconcileOwnerAlerts({ ownerId: 'owner-a', keyId: 'key-a', incidents: { incidents: [recovered] }, safetySlo: warming }, now + 2_000_000);
  status = router.ownerAlertStatus('owner-a', 'key-a');
  assert.equal(status.counts.total, 2, 'recovery transition must emit a distinct owner event');
  assert.equal(status.alerts[0].status, 'recovery-ready');

  const slo = { status: 'budget-at-risk', reasonCode: 'fast-burn-rate', burnRates: [{ name: 'fast', firing: true }] };
  router.reconcileOwnerAlerts({ ownerId: 'owner-a', incidents: { incidents: [] }, safetySlo: slo }, now + 3_000_000);
  router.reconcileOwnerAlerts({ ownerId: 'owner-a', incidents: { incidents: [] }, safetySlo: slo }, now + 3_000_001);
  assert.equal(router.ownerAlertStatus('owner-a').counts.total, 3, 'one SLO episode must emit once');
  router.reconcileOwnerAlerts({ ownerId: 'owner-a', incidents: { incidents: [] }, safetySlo: { status: 'healthy' } }, now + 4_000_000);
  router.reconcileOwnerAlerts({ ownerId: 'owner-a', incidents: { incidents: [] }, safetySlo: slo }, now + 5_000_000);
  assert.equal(router.ownerAlertStatus('owner-a').counts.total, 4, 'a later SLO episode may emit again');

  router.reconcileOwnerAlerts({ ownerId: 'owner-b', keyId: 'key-b', incidents: { incidents: [incident] }, safetySlo: warming }, now + 6_000_000);
  result = await router.dispatchPendingAlerts(now + 7_000_000, async () => ({ statusCode: 400 }));
  assert(result.deadLetter >= 1, 'permanent HTTP failure must enter dead letter without retry');
  assert.equal(router.ownerAlertStatus('owner-b').counts.deadLetter, 1);

  assert.equal(statSync(router.ownerAlertStorePathForTest).mode & 0o777, 0o600);
  const raw = readFileSync(router.ownerAlertStorePathForTest, 'utf8');
  assert(raw.includes('owner-a'), 'private store retains owner binding');
  assert.equal(JSON.stringify(router.ownerAlertStatus('owner-a')).includes('owner-a'), false);

  assert.throws(() => router.buildSignedWebhookRequest(stored.alerts[0], 'http://alerts.example.test/iost', readFileSync(secretFile), now), /HTTPS/);
  assert.throws(() => router.buildSignedWebhookRequest(stored.alerts[0], 'https://127.0.0.1/iost', readFileSync(secretFile), now), /not permitted/);

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  assert.match(server, /ownerAlerts\.dispatchPendingAlerts/);
  assert.match(server, /app\.get\('\/api\/agent-alerts',\s*requireUser/);
  assert.match(protocol, /agent_owner_alert_status/);
  assert.match(app, /Owner Alert Delivery &amp; Escalation Router/);
  assert.match(css, /\.owner-alert-router/);
  writeFileSync(router.ownerAlertStorePathForTest, '{broken', { mode: 0o600 });
  await assert.rejects(import(`../lib/owner-alert-router.js?corrupt=${Date.now()}`), /unreadable/, 'corrupt alert state must fail closed');
  console.log('owner alert delivery and escalation router checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
