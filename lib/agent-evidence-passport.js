// Private, portable proof bundle for one authenticated AITT principal.
// The passport composes existing server-owned evidence and never persists,
// publishes, authorizes, predicts or executes anything.
import crypto from 'node:crypto';

const VERSION = 1;
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};
const digest = (value) => sha256(JSON.stringify(stable(value)));
const truth = (value) => value === true;

function claim(id, label, status, evidence) {
  const normalized = stable(evidence || {});
  return { id, label, status, evidence: normalized, evidenceHash: digest({ id, status, evidence: normalized }) };
}

function latestEvaluation(evaluation) {
  if (!evaluation) return { available: false };
  return {
    available: true,
    createdAt: Number(evaluation.createdAt) || null,
    symbol: evaluation.symbol || null,
    timeframe: evaluation.timeframe || null,
    resultHash: evaluation.resultHash || evaluation.evidence?.resultHash || null,
    benchmarkStatus: evaluation.benchmark?.status || null,
    benchmarkEvidenceHash: evaluation.benchmark?.evidenceHash || null,
    challengeDecision: evaluation.challenge?.decision || null,
    challengeEvidenceHash: evaluation.challenge?.evidenceHash || null,
  };
}

export function buildAgentEvidencePassport({
  subjectSeed, authorization = {}, runtime = {}, capabilityRegistry = {}, releaseTrust = {},
  securitySentinel = {}, reconciliation = {}, decisionTrace = {}, evaluation = null,
  generatedAt = Date.now(),
} = {}) {
  if (!subjectSeed) throw new Error('private passport subject required');
  const runtimeRows = Array.isArray(runtime.runtimes) ? runtime.runtimes : [runtime].filter((row) => row?.enrolled);
  const runtimeReady = runtimeRows.some((row) => row.ready === true && row.supervisor?.healthy === true
    && !!row.checkpoint && row.quarantine?.active !== true);
  const currentAgent = capabilityRegistry.currentAgent || null;
  const effectiveCapabilities = [...new Set(currentAgent?.effectiveCapabilities
    || capabilityRegistry.agents?.flatMap((row) => row.effectiveCapabilities || []) || [])].sort();
  const releasePassed = releaseTrust.decision === 'allow' || releaseTrust.status === 'healthy';
  const securityPassed = securitySentinel.status === 'healthy';
  const reconciliationPassed = reconciliation.decision === 'allow' && reconciliation.verification?.receiptChainVerified !== false;
  const tracePassed = decisionTrace.status !== 'blocked'
    && truth(decisionTrace.evidence?.receiptChainVerified)
    && truth(decisionTrace.evidence?.approvalChainVerified)
    && truth(decisionTrace.evidence?.eventChainVerified);
  const evaluationEvidence = latestEvaluation(evaluation);
  const claims = [
    claim('authority', 'Bound authority', authorization.canOpenPaperTrade === true ? 'verified' : 'limited', {
      paperTradeAuthorized: authorization.canOpenPaperTrade === true,
      tradePaperScope: authorization.scopes?.includes?.('trade-paper') === true,
      tradeLiveScope: authorization.scopes?.includes?.('trade-live') === true,
      effectiveCapabilities,
    }),
    claim('runtime', 'Supervised runtime', runtimeReady ? 'verified' : 'attention', {
      enrolled: runtimeRows.some((row) => row.enrolled === true), ready: runtimeReady,
      supervised: runtimeRows.some((row) => row.supervisor?.managed === true),
      checkpointPresent: runtimeRows.some((row) => !!row.checkpoint),
      quarantined: runtimeRows.some((row) => row.quarantine?.active === true),
    }),
    claim('release', 'Release integrity', releasePassed ? 'verified' : 'attention', {
      decision: releaseTrust.decision || null, reasonCode: releaseTrust.reasonCode || null,
      provenanceMatch: releaseTrust.checks?.runtimeProvenanceMatches === true,
      dependencyIntegrity: releaseTrust.checks?.dependencyIntegrityComplete === true,
      dependencyCoveragePct: releaseTrust.sbom?.integrityCoveragePercent ?? null,
      sbomPresent: releaseTrust.sbom?.generatedAndRetainedInCi === true,
    }),
    claim('security', 'Security observation', securityPassed ? 'verified' : 'attention', {
      status: securitySentinel.status || null, reasonCode: securitySentinel.reasonCode || null,
      evidenceSufficient: securitySentinel.evidenceSufficient === true,
      findingCount: securitySentinel.counts?.findings ?? securitySentinel.findings?.length ?? 0,
    }),
    claim('ledger', 'Execution ledger', reconciliationPassed ? 'verified' : 'attention', {
      decision: reconciliation.decision || null, reasonCode: reconciliation.reasonCode || null,
      receiptChainVerified: reconciliation.verification?.receiptChainVerified
        ?? reconciliation.evidence?.receiptChainVerified ?? false,
      criticalFindings: reconciliation.counts?.criticalFindings ?? reconciliation.counts?.critical ?? 0,
      warningFindings: reconciliation.counts?.warningFindings ?? reconciliation.counts?.warnings ?? 0,
      cashInvariant: reconciliation.invariants?.cash?.satisfied ?? reconciliation.evidence?.cashInvariant ?? null,
    }),
    claim('decisions', 'Decision provenance', tracePassed ? 'verified' : 'attention', {
      status: decisionTrace.status || null, traceCount: decisionTrace.counts?.total ?? 0,
      verifiedCount: decisionTrace.counts?.verified ?? 0,
      receiptChainVerified: decisionTrace.evidence?.receiptChainVerified === true,
      approvalChainVerified: decisionTrace.evidence?.approvalChainVerified === true,
      eventChainVerified: decisionTrace.evidence?.eventChainVerified === true,
    }),
    claim('evaluation', 'Evaluation evidence', evaluationEvidence.available && evaluationEvidence.resultHash ? 'verified' : 'unavailable', evaluationEvidence),
  ];
  const verifiedCount = claims.filter((item) => item.status === 'verified').length;
  const availableCount = claims.filter((item) => item.status !== 'unavailable').length;
  const core = {
    format: 'aitt-agent-evidence-passport+json', version: VERSION, mode: 'paper-only',
    subjectRef: `agt_${sha256(`aitt:evidence-passport:v1:${subjectSeed}`).slice(0, 24)}`,
    generatedAt: Number(generatedAt), claims,
    coverage: { claimCount: claims.length, availableCount, verifiedCount,
      percent: Math.round(verifiedCount / claims.length * 100) },
  };
  const evidenceRoot = digest(core);
  return {
    ok: true, ...core, status: verifiedCount === claims.length ? 'verified' : 'partial',
    decision: verifiedCount === claims.length ? 'evidence-complete' : 'evidence-incomplete',
    evidenceRoot,
    integrity: { algorithm: 'SHA-256', canonicalization: 'recursive-key-sort', verified: true, evidenceRoot },
    guarantees: {
      readOnly: true, deterministicClaims: true, privateByDefault: true, ownerIsolated: true,
      portableJson: true, automaticPublication: false, identityCredential: false,
      executionAuthority: 'none', executionPermissionsChanged: false, authorityExpanded: false,
      liveScopeUsed: false, publicChainUsed: false,
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false, publicChainUsed: false,
  };
}

export function verifyAgentEvidencePassport(passport) {
  if (!passport || passport.version !== VERSION || !Array.isArray(passport.claims)) return false;
  if (!passport.claims.every((item) => item.evidenceHash === digest({ id: item.id, status: item.status, evidence: item.evidence }))) return false;
  const core = {
    format: passport.format, version: passport.version, mode: passport.mode,
    subjectRef: passport.subjectRef, generatedAt: passport.generatedAt,
    claims: passport.claims, coverage: passport.coverage,
  };
  return passport.evidenceRoot === digest(core) && passport.integrity?.evidenceRoot === passport.evidenceRoot;
}

export const agentEvidencePassportConstants = Object.freeze({ version: VERSION, algorithm: 'SHA-256' });
