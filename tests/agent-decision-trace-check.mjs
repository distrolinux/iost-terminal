import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAgentDecisionTrace } from '../lib/agent-decision-trace.js';
import { executionPositionRef } from '../lib/execution-receipts.js';

const positionId = 'private-position-id';
const receiptHash = 'a'.repeat(64);
const intentRef = 'b'.repeat(64);
const mandateDigest = 'c'.repeat(64);
const acceptedReceipt = {
  hash: receiptHash, sequence: 4, recordedAt: 10_000, action: 'open', outcome: 'accepted',
  order: { symbol: 'IOST', side: 'long', size: 10, confidence: 81, reasoningSummary: 'Structured momentum thesis.',
    intentProtected: true, intentRef, positionRef: executionPositionRef(positionId) },
  market: { available: true, source: 'OKX', observedPrice: 0.001, quoteAgeMs: 120, fresh: true,
    quoteIntegrity: { required: true, quorumMet: true, quoteCount: 3, trustedVenueCount: 3, routeVenue: 'OKX' } },
  portfolioRisk: { decision: 'allow', reasonCode: 'portfolio-risk-passed', metrics: {
    protectiveStopRequired: true, protectiveStopValid: true }, volatility: { regime: 'normal' } },
  dataTrust: { decision: 'allow', reasonCode: 'data-trust-passed' },
  executionReadiness: { decision: 'allow', reasonCode: 'execution-readiness-passed' },
  authorization: { approvalRequired: true, approvalAuthorized: true, approvalDigest: mandateDigest,
    walletPactAuthorized: true, missionAuthorized: true },
  execution: { status: 'filled', simulated: true, fillPrice: 0.001001, fillVenue: 'OKX', slippageBps: 1, feeUsd: 0 },
  policy: { decision: 'allow', reasonCode: 'paper-fill-verified', detail: 'Simulated fill verified.' },
  latency: { totalMs: 18 },
};
const approval = { mandateDigest, status: 'consumed', singleUse: true, action: 'open', createdAt: 9_000,
  order: { symbol: 'IOST', side: 'long', size: 10 }, evidence: { decision: 'allow' } };
const result = buildAgentDecisionTrace({
  receipts: [acceptedReceipt], receiptVerification: { ok: true },
  intents: [{ intentRef, receiptRef: receiptHash, replaySafe: true }], approvals: [approval],
  approvalVerification: { ok: true }, journal: [{ id: positionId, status: 'open', openedAt: 9_900 }],
  reconciliation: { decision: 'allow', reasonCode: 'execution-state-reconciled' },
  eventStream: { chain: { verified: true }, cursor: { latestSequence: 42 } },
});

assert.equal(result.ok, true);
assert.equal(result.mode, 'paper-only');
assert.equal(result.counts.total, 1);
assert.equal(result.counts.verified, 1);
assert.equal(result.traces[0].stages.length, 7);
assert.deepEqual(result.stages, ['observe', 'analyze', 'risk-check', 'approval', 'execute', 'verify', 'journal']);
assert.equal(result.traces[0].stages.every((item) => ['pass', 'not-required'].includes(item.status)), true);
assert.equal(result.traces[0].evidenceCoveragePct, 100);
assert.equal(result.evidence.eventLatestSequence, 42);
assert.equal(result.guarantees.missingEvidenceNeverInferred, true);
assert.equal(result.execution.attempted, false);
assert.equal(result.authorityExpanded, false);
assert.equal(result.liveScopeUsed, false);
assert.equal(result.publicChainUsed, false);

const pending = buildAgentDecisionTrace({
  receipts: [], receiptVerification: { ok: true }, intents: [],
  approvals: [{ ...approval, mandateDigest: 'd'.repeat(64), status: 'pending', createdAt: 20_000,
    ownerDecisionRequired: true, evidence: { decision: 'allow', quoteSource: 'Gate' } }],
  approvalVerification: { ok: true }, reconciliation: { decision: 'allow' },
  eventStream: { chain: { verified: true }, cursor: { latestSequence: 0 } },
});
assert.equal(pending.status, 'attention');
assert.equal(pending.counts.pending, 1);
assert.equal(pending.traces[0].stages.find((item) => item.name === 'approval').status, 'pending');
assert.equal(pending.traces[0].stages.find((item) => item.name === 'execute').status, 'pending');

const unavailable = buildAgentDecisionTrace({
  receipts: [{ ...acceptedReceipt, hash: 'e'.repeat(64), market: {}, portfolioRisk: null,
    dataTrust: null, executionReadiness: null, order: { symbol: '', side: null, size: null },
    authorization: {}, outcome: 'rejected' }], receiptVerification: { ok: true },
  approvalVerification: { ok: true }, reconciliation: { decision: 'allow' },
  eventStream: { chain: { verified: true } },
});
assert.equal(unavailable.traces[0].stages.find((item) => item.name === 'observe').status, 'unavailable');
assert.equal(unavailable.traces[0].stages.find((item) => item.name === 'analyze').status, 'unavailable');

const blocked = buildAgentDecisionTrace({ receiptVerification: { ok: false }, approvalVerification: { ok: true }, reconciliation: { decision: 'allow' } });
assert.equal(blocked.ok, false);
assert.equal(blocked.status, 'blocked');

const serialized = JSON.stringify(result);
for (const secret of [positionId, 'wallet-private', 'pact-private', 'mission-private', 'intent-private']) {
  assert.equal(serialized.includes(secret), false, `${secret} must not be exposed`);
}

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(server, /\/api\/agent-decision-trace/);
assert.match(server, /case 'agent_decision_trace'/);
assert.match(protocol, /readTool\('agent_decision_trace'/);
assert.match(app, /AUTHORITATIVE EVIDENCE ONLY/);
assert.match(app, /missing evidence is never inferred/i);

console.log('agent decision trace checks passed');
