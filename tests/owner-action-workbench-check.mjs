import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOwnerActionWorkbench, OWNER_ACTION_RECOVERY_PROBATION_MS } from '../lib/owner-action-workbench.js';

const now = 1_800_000_000_000;
const wallet = { walletId: 'wal_test', status: 'active', capabilities: ['trade.paper'] };
const pact = { pactId: 'pact_test', agentWalletId: wallet.walletId, status: 'active' };
const mission = { missionId: 'msn_test', walletId: wallet.walletId, pactId: pact.pactId, status: 'running' };
const runtime = { runtimes: [{ ready: true, supervisor: { managed: true, healthy: true }, checkpoint: { missionId: mission.missionId }, quarantine: { active: false } }] };
const safe = { incidents: { incidents: [] }, runtime,
  safetySlo: { burnRates: [{ name: 'fast', firing: false }, { name: 'slow', firing: false }] },
  guardian: { coverage: { degraded: 0, unprotected: 0 } }, dataTrust: { decision: 'allow' },
  reconciliation: { decision: 'allow' }, authorization: true, wallets: [wallet], pacts: [pact], missions: [mission], now };

const ready = buildOwnerActionWorkbench(safe);
assert.equal(ready.status, 'ready');
assert.equal(ready.nextAction.code, 'ready');
assert.equal(ready.guarantees.noAutomaticOwnerActions, true);
assert.equal(ready.execution.attempted, false);

const recovered = buildOwnerActionWorkbench({ ...safe, incidents: { incidents: [{
  incidentRef: 'inc_test', status: 'recovery-detected', recoveryReady: true, acknowledgedAt: null,
}] } });
assert.equal(recovered.nextAction.code, 'incident-acknowledge');
assert.deepEqual(recovered.nextAction.action, { kind: 'incident', operation: 'acknowledge', incidentRef: 'inc_test', requiresConfirmation: true });
const acknowledged = buildOwnerActionWorkbench({ ...safe, incidents: { incidents: [{
  incidentRef: 'inc_test', status: 'recovery-detected', recoveryReady: true, acknowledgedAt: now - 1,
}] } });
assert.equal(acknowledged.nextAction.code, 'incident-resolve');

const probation = buildOwnerActionWorkbench({ ...safe, incidents: { incidents: [{
  incidentRef: 'inc_old', status: 'resolved', resolvedAt: now - 60_000,
}] } });
assert.equal(probation.nextAction.code, 'recovery-probation');
assert.equal(probation.evidence.recoveryProbationRemainingMs, OWNER_ACTION_RECOVERY_PROBATION_MS - 60_000);

const noAuthority = buildOwnerActionWorkbench({ ...safe, authorization: false, pacts: [] });
assert.equal(noAuthority.nextAction.code, 'paper-pact');
assert.equal(noAuthority.nextAction.target.view, 'launchpad');
assert.equal(noAuthority.liveScopeUsed, false);
assert.equal(noAuthority.publicChainUsed, false);

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.match(server, /buildOwnerActionWorkbench/);
assert.match(app, /Owner Action Workbench/);
assert.match(app, /data-workbench-action/);
assert.match(app, /data-incident-toggle/);
assert.match(css, /\.owner-action-workbench/);
console.log('Owner Action Workbench checks passed');
