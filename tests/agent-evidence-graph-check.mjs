import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAgentEvidenceGraph, verifyAgentEvidenceGraph } from '../lib/agent-evidence-graph.js';

const passport = {
  format: 'aitt-agent-evidence-passport+json', version: 1, mode: 'paper-only',
  subjectRef: 'agt_0123456789abcdef01234567', generatedAt: 1_800_000_000_000,
  evidenceRoot: 'a'.repeat(64), integrity: { verified: true },
  claims: [
    { id: 'authority', label: 'Bound authority', status: 'verified', evidenceHash: 'b'.repeat(64) },
    { id: 'runtime', label: 'Supervised runtime', status: 'verified', evidenceHash: 'c'.repeat(64) },
    { id: 'decisions', label: 'Decision provenance', status: 'verified', evidenceHash: 'd'.repeat(64) },
  ],
};
const decisionTrace = {
  status: 'healthy', evidence: { receiptChainVerified: true, approvalChainVerified: true, eventChainVerified: true },
  traces: [{
    traceRef: 'dtr_0123456789abcdef01234567', source: 'execution-receipt', occurredAt: 1_799_999_999_000,
    action: 'open', symbol: 'IOST', side: 'long', outcome: 'accepted', reasonCode: 'paper-fill-verified',
    evidenceCoveragePct: 100,
    stages: [
      { name: 'observe', status: 'pass', summary: 'Fresh market evidence retained.' },
      { name: 'analyze', status: 'pass', summary: 'Structured thesis retained.' },
      { name: 'risk-check', status: 'pass', summary: 'Risk controls passed.' },
      { name: 'approval', status: 'pass', summary: 'Owner mandate matched.' },
      { name: 'execute', status: 'pass', summary: 'Paper fill completed.' },
      { name: 'verify', status: 'pass', summary: 'Receipt integrity passed.' },
      { name: 'journal', status: 'pass', summary: 'Outcome retained.' },
    ],
  }],
};

const input = { passport, decisionTrace, generatedAt: 1_800_000_000_000 };
const graph = buildAgentEvidenceGraph(input);
assert.equal(graph.ok, true);
assert.equal(graph.mode, 'paper-only');
assert.equal(graph.status, 'verified');
assert.equal(graph.integrity.verified, true);
assert.equal(graph.provenance.profile, 'W3C-PROV-inspired');
assert.equal(graph.counts.agents, 1);
assert.equal(graph.counts.decisions, 1);
assert.equal(graph.counts.claims, 3);
assert.equal(graph.counts.stages, 7);
assert.equal(graph.counts.orphans, 0);
assert.equal(graph.latestDecision.stages.length, 7);
assert.equal(graph.latestDecision.stages[0].name, 'observe');
assert.equal(graph.latestDecision.stages.at(-1).name, 'journal');
assert.equal(verifyAgentEvidenceGraph(graph), true);
assert.deepEqual(buildAgentEvidenceGraph(input), graph, 'same evidence and timestamp must produce the same graph');
assert.equal(graph.guarantees.privateByDefault, true);
assert.equal(graph.guarantees.automaticPublication, false);
assert.equal(graph.guarantees.executionAuthority, 'none');
assert.equal(graph.execution.attempted, false);
assert.equal(graph.liveScopeUsed, false);
assert.equal(graph.publicChainUsed, false);

const tampered = structuredClone(graph);
tampered.nodes[0].status = 'blocked';
assert.equal(verifyAgentEvidenceGraph(tampered), false);

const partial = buildAgentEvidenceGraph({ passport: { ...passport, integrity: { verified: false }, claims: [] }, decisionTrace: {}, generatedAt: 1 });
assert.equal(partial.status, 'partial');
assert.equal(partial.integrity.verified, true, 'graph integrity can verify while source evidence remains partial');

const serialized = JSON.stringify(graph);
for (const privateValue of ['owner-secret', 'wallet-private', 'pact-private', 'mission-private', 'key-private']) {
  assert.equal(serialized.includes(privateValue), false);
}

const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(protocol, /readTool\('agent_evidence_graph'/);
assert.match(server, /case 'agent_evidence_graph'/);
assert.match(server, /app\.get\('\/api\/agent-evidence-graph', requireUser/);
assert.match(app, /AITT Decision Evidence Graph/);
assert.match(app, /downloadEvidenceGraph/);

console.log('AITT Decision Evidence Graph integrity, privacy and safety checks passed');
