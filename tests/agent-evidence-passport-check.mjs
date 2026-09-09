import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAgentEvidencePassport, verifyAgentEvidencePassport } from '../lib/agent-evidence-passport.js';

const input = {
  subjectSeed: 'owner-secret-id:key-private-id', generatedAt: 1_800_000_000_000,
  authorization: { canOpenPaperTrade: true, scopes: ['read', 'trade-paper'] },
  runtime: { runtimes: [{ enrolled: true, ready: true, supervisor: { managed: true, healthy: true }, checkpoint: { stage: 'idle' }, quarantine: { active: false } }] },
  capabilityRegistry: { agents: [{ effectiveCapabilities: ['paper.execute', 'market.observe'] }] },
  releaseTrust: { status: 'verified', decision: 'allow', reasonCode: 'release-trust-passed',
    checks: { runtimeProvenanceMatches: true, dependencyIntegrityComplete: true },
    sbom: { generatedAndRetainedInCi: true, integrityCoveragePercent: 100 } },
  securitySentinel: { status: 'healthy', reasonCode: 'security-observation-clear', evidenceSufficient: true, counts: {}, findings: [] },
  reconciliation: { decision: 'allow', reasonCode: 'execution-state-reconciled',
    evidence: { receiptChainVerified: true, cashInvariant: true }, counts: { criticalFindings: 0, warningFindings: 0 } },
  decisionTrace: { status: 'healthy', counts: { total: 3, verified: 3 },
    evidence: { receiptChainVerified: true, approvalChainVerified: true, eventChainVerified: true } },
  evaluation: { createdAt: 1_799_999_000_000, symbol: 'IOST', timeframe: '1d',
    evidence: { resultHash: 'a'.repeat(64) }, benchmark: { status: 'verified', evidenceHash: 'b'.repeat(64) },
    challenge: { decision: 'hold', evidenceHash: 'c'.repeat(64) } },
};

const passport = buildAgentEvidencePassport(input);
assert.equal(passport.version, 1);
assert.equal(passport.mode, 'paper-only');
assert.equal(passport.status, 'verified');
assert.equal(passport.coverage.percent, 100);
assert.equal(passport.claims.length, 7);
assert.equal(verifyAgentEvidencePassport(passport), true);
assert.deepEqual(buildAgentEvidencePassport(input), passport, 'same evidence and time must produce the same passport');
assert.equal(passport.guarantees.privateByDefault, true);
assert.equal(passport.guarantees.automaticPublication, false);
assert.equal(passport.guarantees.identityCredential, false);
assert.equal(passport.guarantees.executionAuthority, 'none');
assert.equal(passport.execution.attempted, false);
assert.equal(passport.liveScopeUsed, false);
assert.equal(passport.publicChainUsed, false);
const serialized = JSON.stringify(passport);
assert(!serialized.includes('owner-secret-id'));
assert(!serialized.includes('key-private-id'));
assert.equal(verifyAgentEvidencePassport({ ...passport, subjectRef: 'agt_tampered' }), false);
const changedClaim = structuredClone(passport);
changedClaim.claims[0].evidence.paperTradeAuthorized = false;
assert.equal(verifyAgentEvidencePassport(changedClaim), false);

const partial = buildAgentEvidencePassport({ subjectSeed: 'empty-owner', generatedAt: 1 });
assert.equal(partial.status, 'partial');
assert.equal(partial.decision, 'evidence-incomplete');
assert.equal(verifyAgentEvidencePassport(partial), true);

const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(protocol, /readTool\('agent_evidence_passport'/);
assert.match(server, /case 'agent_evidence_passport'/);
assert.match(server, /app\.get\('\/api\/agent-evidence-passport', requireUser/);
assert.match(app, /AITT Agent Evidence Passport/);
assert.match(app, /downloadEvidencePassport/);

console.log('AITT Agent Evidence Passport integrity, privacy and safety checks passed');
