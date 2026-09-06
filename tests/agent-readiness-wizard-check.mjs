import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentReadinessWizard } from '../lib/agent-readiness-wizard.js';

const wallet = { walletId: 'wal_owner_agent', status: 'active', capabilities: ['trade.paper'] };
const pact = { pactId: 'pact_owner_agent', agentWalletId: wallet.walletId, status: 'active' };
const key = { id: 'key_owner_agent', scopes: ['read', 'trade-paper'], lastUsedAt: 10, revokedAt: null };
const mission = { missionId: 'msn_owner_agent', walletId: wallet.walletId, pactId: pact.pactId, status: 'running' };
const runtime = { runtimes: [{ ready: true, supervisor: { managed: true, healthy: true },
  checkpoint: { missionId: mission.missionId }, quarantine: { active: false }, execution: { newMissionExposureAllowed: true } }] };
const safe = { wallets: [wallet], pacts: [pact], keys: [key], runtime, missions: [mission],
  incidents: { counts: { open: 0, critical: 0 } }, safetySlo: { status: 'healthy', burnRates: { fast: { firing: false }, slow: { firing: false } } },
  guardian: { coverage: { degraded: 0, unprotected: 0 } }, sessionSecurity: { counts: { active: 0 } },
  releaseTrust: { status: 'verified' }, frozen: false };

const empty = buildAgentReadinessWizard();
assert.equal(empty.status, 'action-required');
assert.equal(empty.progress.completed, 0);
assert.equal(empty.nextAction.code, 'budget');

const ready = buildAgentReadinessWizard(safe);
assert.equal(ready.status, 'ready-for-preflight');
assert.deepEqual(ready.progress, { completed: 7, total: 7, percent: 100 });
assert.equal(ready.nextAction.code, 'preflight');
assert.equal(ready.evidence.missionBound, true);
assert.equal(ready.guarantees.advisoryOnly, true);
assert.equal(ready.execution.attempted, false);
assert.equal(ready.liveScopeUsed, false);
assert.equal(ready.publicChainUsed, false);

const disconnected = buildAgentReadinessWizard({ ...safe, keys: [{ ...key, lastUsedAt: null }] });
assert.equal(disconnected.nextAction.code, 'connection');
assert.equal(disconnected.steps.find((item) => item.code === 'runtime').pass, true,
  'later evidence remains visible without bypassing the first incomplete step');

const readOnlySession = buildAgentReadinessWizard({ ...safe, keys: [{ ...key, lastUsedAt: null }],
  sessionSecurity: { sessions: [{ status: 'active', resource: 'mcp', scopes: ['read'] }] } });
assert.equal(readOnlySession.nextAction.code, 'connection', 'a read-only session is not proof of a connected trading agent');
const paperSession = buildAgentReadinessWizard({ ...safe, keys: [{ ...key, lastUsedAt: null }],
  sessionSecurity: { sessions: [{ status: 'active', resource: 'mcp', scopes: ['read', 'trade-paper'] }] } });
assert.notEqual(paperSession.nextAction.code, 'connection', 'a resource-bound paper session establishes connection evidence');

const unbound = buildAgentReadinessWizard({ ...safe, runtime: { runtimes: [{ ...runtime.runtimes[0], checkpoint: { missionId: null } }] } });
assert.equal(unbound.nextAction.code, 'mission');

const unsafe = buildAgentReadinessWizard({ ...safe, incidents: { counts: { open: 1, critical: 1 } } });
assert.equal(unsafe.nextAction.code, 'safety');
assert.equal(unsafe.status, 'action-required');

const historicalBudgetExhausted = buildAgentReadinessWizard({ ...safe,
  safetySlo: { status: 'budget-exhausted', errorBudget: { exhausted: true }, burnRates: [
    { name: 'fast', firing: false }, { name: 'slow', firing: false }, { name: 'ticket', firing: true },
  ] } });
assert.equal(historicalBudgetExhausted.status, 'ready-for-preflight',
  'cumulative budget and ticket burn are advisory when current fast/slow burns are clear');

const activeFastBurn = buildAgentReadinessWizard({ ...safe,
  safetySlo: { status: 'budget-exhausted', burnRates: [
    { name: 'fast', firing: true }, { name: 'slow', firing: false },
  ] } });
assert.equal(activeFastBurn.nextAction.code, 'safety', 'an active fast burn must remain fail closed');

const incompleteBurnEvidence = buildAgentReadinessWizard({ ...safe,
  safetySlo: { status: 'healthy', burnRates: [{ name: 'fast', firing: false }] } });
assert.equal(incompleteBurnEvidence.nextAction.code, 'safety', 'missing blocking-burn evidence must fail closed');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
const app = readFileSync(join(ROOT, 'public/js/app.js'), 'utf8');
assert.match(server, /buildAgentReadinessWizard/);
assert.match(app, /Agent Readiness Wizard/);
assert.match(app, /Advisory only · never approves or trades/);
assert.match(app, /aria-current="step"/);
assert.match(app, /Math\.min\(requestedExpiry, pactExpiry\)/,
  'mission creation must cap its expiry to the selected Pact');
console.log('Agent Readiness Wizard checks passed');
