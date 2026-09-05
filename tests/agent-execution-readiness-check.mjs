import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AGENT_EXECUTION_RECOVERY_PROBATION_MS,
  buildAgentExecutionReadiness,
} from '../lib/agent-execution-readiness.js';
import { buildMcpTools } from '../lib/mcp-protocol.js';

const now = 1_788_560_000_000;
const base = {
  agentRequired: true,
  runtime: {
    enrolled: true, ready: true, status: 'ready', checkpoint: { stage: 'idle' },
    supervisor: { managed: true, healthy: true },
    quarantine: { active: false }, execution: { newMissionExposureAllowed: true },
  },
  incidents: { counts: { open: 0, critical: 0, quarantined: 0, recoveryReady: 0 }, incidents: [] },
  safetySlo: {
    ok: true,
    status: 'warming-up', reasonCode: 'insufficient-observation-window',
    evidence: { sufficient: false }, errorBudget: { exhausted: false },
    burnRates: [
      { name: 'fast', firing: false },
      { name: 'slow', firing: false },
      { name: 'ticket', firing: false },
    ],
    decision: { ownerActionRequired: false },
  },
  guardian: { total: 0, protected: 0, armed: 0, degraded: 0, unprotected: 0 },
  dataTrust: { decision: 'allow', reasonCode: 'data-trust-passed', evidence: { trustedCount: 3 } },
  reconciliation: { decision: 'allow', status: 'healthy', counts: {}, evidence: { receiptChainVerified: true, cashInvariant: true } },
  emergencyFreeze: { frozen: false }, authorization: { ok: true }, now,
};

const ready = buildAgentExecutionReadiness(base);
assert.equal(ready.decision, 'allow');
assert.equal(ready.reasonCode, 'agent-execution-ready');
assert.equal(ready.readOnly, true);
assert.equal(ready.policy.failClosed, true);
assert.equal(ready.policy.supervisedRuntimeRequired, true);
assert.equal(ready.policy.recoveryProbationMs, 30 * 60_000);
assert.deepEqual(ready.policy.blockingBurnRates, ['fast', 'slow']);
assert.equal(ready.policy.cumulativeErrorBudgetAdvisoryOnly, true);
assert.equal(ready.policy.ticketBurnAdvisoryOnly, true);
assert.equal(ready.evidence.runtime.supervised, true);
assert.equal(ready.evidence.dataTrust.trustedEvidenceCount, 3);
assert.equal(ready.decisionEffects.newExposureAllowed, true);
assert.equal(ready.decisionEffects.executionPermissionsChanged, false);
assert.equal(ready.decisionEffects.authorityExpanded, false);
assert.deepEqual(ready.execution, { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false });
assert.equal(ready.liveScopeUsed, false);
assert.equal(ready.publicChainUsed, false);

const denyCases = [
  ['runtime-enrolled', { runtime: { ...base.runtime, enrolled: false } }],
  ['runtime-ready', { runtime: { ...base.runtime, ready: false, status: 'degraded' } }],
  ['runtime-supervised', { runtime: { ...base.runtime, supervisor: { managed: false, healthy: false } } }],
  ['runtime-checkpoint-present', { runtime: { ...base.runtime, checkpoint: null } }],
  ['runtime-not-quarantined', { runtime: { ...base.runtime, quarantine: { active: true } } }],
  ['runtime-new-exposure-allowed', { runtime: { ...base.runtime, execution: { newMissionExposureAllowed: false } } }],
  ['incidents-clear', { incidents: { counts: { open: 1, critical: 0, quarantined: 0 } } }],
  ['recovery-probation-clear', { incidents: { counts: base.incidents.counts, incidents: [{ status: 'resolved', resolvedAt: now - 60_000 }] } }],
  ['safety-evidence-available', { safetySlo: { ...base.safetySlo, ok: false, status: 'not-enrolled' } }],
  ['safety-burn-rate-clear', { safetySlo: { ...base.safetySlo, burnRates: [{ name: 'fast', firing: true }] } }],
  ['safety-burn-rate-clear', { safetySlo: { ...base.safetySlo, burnRates: [] } }],
  ['position-guardian-healthy', { guardian: { total: 1, protected: 0, armed: 0, degraded: 0, unprotected: 1 } }],
  ['data-trust-authorized', { dataTrust: { decision: 'deny', reasonCode: 'quote-quorum' } }],
  ['execution-reconciliation-clear', { reconciliation: { decision: 'deny', reasonCode: 'cash-ledger-mismatch' } }],
  ['emergency-freeze-clear', { emergencyFreeze: { frozen: true } }],
  ['wallet-pact-authorized', { authorization: { ok: false } }],
];
for (const [reason, patch] of denyCases) {
  const result = buildAgentExecutionReadiness({ ...base, ...patch });
  assert.equal(result.decision, 'deny', reason);
  assert.equal(result.reasonCode, reason);
  assert.equal(result.execution.attempted, false);
}

const probationComplete = buildAgentExecutionReadiness({
  ...base,
  incidents: {
    counts: base.incidents.counts,
    incidents: [{ status: 'resolved', resolvedAt: now - AGENT_EXECUTION_RECOVERY_PROBATION_MS }],
  },
});
assert.equal(probationComplete.decision, 'allow');
assert.equal(probationComplete.evidence.incidents.probationClear, true);

const cumulativeBudgetExhausted = buildAgentExecutionReadiness({
  ...base,
  safetySlo: { ...base.safetySlo, status: 'budget-exhausted', errorBudget: { exhausted: true } },
});
assert.equal(cumulativeBudgetExhausted.decision, 'allow');
assert.equal(cumulativeBudgetExhausted.evidence.safetySlo.errorBudgetExhausted, true);

const ticketBurnOnly = buildAgentExecutionReadiness({
  ...base,
  safetySlo: { ...base.safetySlo, burnRates: [
    { name: 'fast', firing: false }, { name: 'slow', firing: false }, { name: 'ticket', firing: true },
  ] },
});
assert.equal(ticketBurnOnly.decision, 'allow');
assert.equal(ticketBurnOnly.evidence.safetySlo.operationalBurnFiring, false);

const owner = buildAgentExecutionReadiness({ agentRequired: false, now });
assert.equal(owner.decision, 'allow');
assert.equal(owner.reasonCode, 'owner-manual-exempt');

const tools = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] });
const statusTool = tools.find((tool) => tool.name === 'agent_execution_readiness');
assert(statusTool);
assert.equal(statusTool.annotations.readOnlyHint, true);
assert.equal(statusTool.annotations.destructiveHint, false);
assert.equal(statusTool.annotations.idempotentHint, true);
assert(!buildMcpTools().some((tool) => tool.name === 'agent_execution_readiness'));

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('../lib/trade-preflight.js', import.meta.url), 'utf8');
const receipts = readFileSync(new URL('../lib/execution-receipts.js', import.meta.url), 'utf8');
assert.match(server, /peekAgentIncidentStatus/);
assert.match(server, /agentExecutionReadinessFor/);
assert.match(server, /case 'agent_execution_readiness'/);
assert.match(server, /app\.get\('\/api\/agent-execution-readiness',\s*requireUser/);
assert.match(server, /const DISCOVERY_VERSION = '1\.42\.0'/);
assert.match(preflight, /code: 'agent-execution-ready'/);
assert.match(preflight, /executionReadiness: stableExecutionReadiness/);
assert.match(preflight, /recoveryAgeMs: null/);
assert.match(receipts, /payload\.executionReadiness/);

console.log('agent execution readiness gate checks passed');
