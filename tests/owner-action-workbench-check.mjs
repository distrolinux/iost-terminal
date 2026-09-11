import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOwnerActionWorkbench, OWNER_ACTION_RECOVERY_PROBATION_MS } from '../lib/owner-action-workbench.js';

const now = 1_800_000_000_000;
const wallet = { walletId: 'wal_test', status: 'active', capabilities: ['trade.paper'] };
const pact = { pactId: 'pact_test', agentWalletId: wallet.walletId, status: 'active' };
const mission = { missionId: 'msn_test', walletId: wallet.walletId, pactId: pact.pactId, status: 'running' };
const runtime = { runtimes: [{ runtimeRef: 'rt_test', ready: true, supervisor: { managed: true, healthy: true }, checkpoint: { missionId: mission.missionId }, quarantine: { active: false } }] };
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
  incidentRef: 'inc_test', runtimeRef: 'rt_test', status: 'recovery-detected', recoveryReady: true, acknowledgedAt: null,
}] } });
assert.equal(recovered.nextAction.code, 'incident-acknowledge');
assert.deepEqual(recovered.nextAction.action, { kind: 'incident', operation: 'acknowledge', incidentRef: 'inc_test', requiresConfirmation: true });
const acknowledged = buildOwnerActionWorkbench({ ...safe, incidents: { incidents: [{
  incidentRef: 'inc_test', runtimeRef: 'rt_test', status: 'recovery-detected', recoveryReady: true, acknowledgedAt: now - 1,
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

const unrelatedWallet = { walletId: 'wal_unrelated', status: 'active', capabilities: ['trade.paper'] };
const multipleWallets = buildOwnerActionWorkbench({ ...safe, wallets: [unrelatedWallet, wallet] });
assert.equal(multipleWallets.status, 'ready');
assert.equal(multipleWallets.nextAction.code, 'ready');
assert.equal(multipleWallets.evidence.walletPactAuthorized, true);
assert.equal(multipleWallets.actions.some((action) => action.code === 'paper-pact'), false);

const ownerTrustStatus = buildOwnerActionWorkbench({ ...safe, dataTrust: { status: 'healthy' } });
assert.equal(ownerTrustStatus.status, 'ready');
assert.equal(ownerTrustStatus.actions.some((action) => action.code === 'data-trust'), false);

// Missing or contradictory evidence must never make the recovery plan ready.
assert.notEqual(buildOwnerActionWorkbench({ ...safe, safetySlo: {} }).status, 'ready');
assert.notEqual(buildOwnerActionWorkbench({ ...safe, guardian: {} }).status, 'ready');
assert.notEqual(buildOwnerActionWorkbench({ ...safe, dataTrust: { status: 'healthy', decision: 'deny' } }).status, 'ready');
assert.equal(buildOwnerActionWorkbench({ ...safe, pacts: [{ ...pact, expiresAt: now - 1 }] }).nextAction.code, 'paper-pact');
assert.equal(buildOwnerActionWorkbench({ ...safe, missions: [{ ...mission, expiresAt: now - 1 }] }).nextAction.code, 'paper-mission');
const ordered = buildOwnerActionWorkbench({ ...safe, frozen: true, authorization: false, pacts: [] });
assert.equal(ordered.nextAction.code, 'emergency-freeze');
assert.equal(ordered.actions[0].code, ordered.nextAction.code);
assert.equal(ready.progress.percent, 100);
assert.ok(ready.checklist.every((check) => check.completionEvidence && check.actor));
const mismatchedIncident = buildOwnerActionWorkbench({ ...safe, incidents: { incidents: [{
  incidentRef: 'inc_other', runtimeRef: 'rt_other', status: 'recovery-detected', recoveryReady: true,
}] } });
assert.equal(mismatchedIncident.actions.some((action) => action.action?.operation), false,
  'an unrelated healthy runtime must not enable an incident release shortcut');
const history = buildOwnerActionWorkbench({ ...safe, decisionTrace: { traces: [{ reasonCode: 'preflight-evidence-changed' }] } });
assert.equal(history.status, 'ready', 'historical rejection is not a current safety blocker');
assert.equal(history.advisories[0].code, 'preflight-evidence-changed');
assert.equal(history.advisories[0].actor, 'agent');
const otherRuntime = { ...runtime.runtimes[0], runtimeRef: 'rt_other', checkpoint: { missionId: 'msn_other' } };
assert.equal(buildOwnerActionWorkbench({ ...safe, runtime: { runtimes: [otherRuntime, ...runtime.runtimes] } }).status, 'ready');
assert.equal(buildOwnerActionWorkbench({ ...safe, runtime: { runtimes: [{ ...runtime.runtimes[0], execution: { newMissionExposureAllowed: false } }] } }).status, 'action-required');
assert.equal(buildOwnerActionWorkbench({ ...safe, pacts: [{ ...pact, completion: { deadlineTs: now - 1 } }] }).nextAction.code, 'paper-pact');
assert.equal(buildOwnerActionWorkbench({ ...safe, safetySlo: { ...safe.safetySlo, errorBudget: { exhausted: true } } }).status, 'ready');
assert.equal(buildOwnerActionWorkbench({ ...safe, safetySlo: { burnRates: [{ name: 'fast', firing: false }] } }).nextAction.code, 'safety-burn');
assert.deepEqual(buildOwnerActionWorkbench(safe), buildOwnerActionWorkbench(safe), 'same snapshot is deterministic');
const snapshot = JSON.stringify(safe);
buildOwnerActionWorkbench(safe);
assert.equal(JSON.stringify(safe), snapshot, 'guidance never mutates its evidence');

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.match(server, /buildOwnerActionWorkbench/);
assert.match(app, /Owner Action Workbench/);
assert.match(app, /data-workbench-action/);
assert.match(app, /await switchView\(view\)/, 'navigation waits for its destination to render');
assert.match(app, /target\.focus/, 'keyboard focus follows recovery navigation');
assert.match(app, /id="recoveryProgress"/);
assert.match(app, /How we confirm this is done/);
assert.match(app, /executionAuthority: 'none'/);
assert.match(app, /data-incident-toggle/);
assert.match(css, /\.owner-action-workbench/);
console.log('Owner Action Workbench checks passed');
