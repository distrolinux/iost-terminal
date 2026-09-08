// Read-only decision explainability assembled from existing authoritative
// paper-execution evidence. This module never persists state and never calls a
// broker. Missing evidence is reported as unavailable rather than inferred.
import crypto from 'node:crypto';
import { executionPositionRef } from './execution-receipts.js';

const VERSION = 1;
const MAX_TRACES = 100;
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const traceRef = (kind, value) => `dtr_${sha256(`iost-terminal:decision-trace:${kind}:v1:${String(value || '')}`).slice(0, 24)}`;
const clean = (value, max = 240) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const stage = (name, status, summary, evidence = {}) => ({ name, status, summary: clean(summary), evidence });

function observeStage(receipt) {
  const market = receipt.market || {};
  if (!market.available) return stage('observe', 'unavailable', 'No authoritative market observation was retained.');
  const quorumRequired = market.quoteIntegrity?.required === true;
  const quorumMet = !quorumRequired || market.quoteIntegrity?.quorumMet === true;
  const passed = market.fresh === true && quorumMet;
  return stage('observe', passed ? 'pass' : 'block', passed
    ? `Fresh ${market.source || 'server'} market evidence was retained.`
    : 'Market freshness or quote quorum did not pass.', {
    source: market.source || null, observedPrice: finite(market.observedPrice),
    quoteAgeMs: finite(market.quoteAgeMs), fresh: market.fresh === true,
    quorumRequired, quorumMet, quoteCount: finite(market.quoteIntegrity?.quoteCount),
    trustedVenueCount: finite(market.quoteIntegrity?.trustedVenueCount),
    selectedVenue: market.quoteIntegrity?.routeVenue || null,
  });
}

function analyzeStage(receipt) {
  const order = receipt.order || {};
  if (!order.symbol || !order.side || !(finite(order.size) > 0)) {
    return stage('analyze', 'unavailable', 'No complete, sanitized order thesis was retained.');
  }
  return stage('analyze', 'pass', order.reasoningSummary || 'A structured paper order was evaluated.', {
    symbol: order.symbol, side: order.side, size: finite(order.size),
    confidence: finite(order.confidence), reasoningPresent: !!order.reasoningSummary,
  });
}

function riskStage(receipt) {
  const risk = receipt.portfolioRisk;
  const trust = receipt.dataTrust;
  const readiness = receipt.executionReadiness;
  if (!risk && !trust && !readiness) {
    return stage('risk-check', receipt.policy?.decision === 'allow' ? 'pass' : 'block',
      receipt.policy?.detail || 'Only the final policy decision was retained.', {
        policyDecision: receipt.policy?.decision || null, reasonCode: receipt.policy?.reasonCode || null,
      });
  }
  const decisions = [risk?.decision, trust?.decision, readiness?.decision].filter(Boolean);
  const passed = decisions.length > 0 && decisions.every((decision) => decision === 'allow');
  return stage('risk-check', passed ? 'pass' : 'block', passed
    ? 'Portfolio risk, data trust, and execution readiness passed.'
    : 'At least one retained risk or readiness control blocked execution.', {
    portfolioRisk: risk?.decision || null, portfolioReasonCode: risk?.reasonCode || null,
    dataTrust: trust?.decision || null, dataTrustReasonCode: trust?.reasonCode || null,
    executionReadiness: readiness?.decision || null, readinessReasonCode: readiness?.reasonCode || null,
    protectiveStopRequired: risk?.metrics?.protectiveStopRequired === true,
    protectiveStopValid: risk?.metrics?.protectiveStopValid === true,
    volatilityRegime: risk?.volatility?.regime || risk?.metrics?.volatilityRegime || null,
  });
}

function approvalStage(receipt, approval) {
  const authorization = receipt.authorization || {};
  if (!authorization.approvalRequired) {
    return stage('approval', 'not-required', 'The retained policy did not require per-order owner approval.', {
      walletPactAuthorized: authorization.walletPactAuthorized === true,
      missionAuthorized: authorization.missionAuthorized === true,
    });
  }
  const authorized = authorization.approvalAuthorized === true;
  return stage('approval', authorized ? 'pass' : 'block', authorized
    ? 'The exact owner mandate was authorized and bound to this receipt.'
    : 'The required exact owner mandate was not authorized.', {
    required: true, authorized, mandateMatched: !!approval,
    mandateStatus: approval?.status || null, singleUse: approval?.singleUse === true,
  });
}

function executeStage(receipt) {
  const accepted = receipt.outcome === 'accepted';
  const reversed = receipt.outcome === 'reversed';
  return stage('execute', accepted ? 'pass' : 'block', accepted
    ? 'A simulated paper fill completed inside the retained controls.'
    : reversed ? 'The simulated fill was reversed fail-closed.'
      : 'Execution was rejected before a retained paper fill.', {
    outcome: receipt.outcome || null, status: receipt.execution?.status || null,
    simulated: receipt.execution?.simulated === true, fillPrice: finite(receipt.execution?.fillPrice),
    fillVenue: receipt.execution?.fillVenue || null, slippageBps: finite(receipt.execution?.slippageBps),
    feeUsd: finite(receipt.execution?.feeUsd), totalLatencyMs: finite(receipt.latency?.totalMs),
  });
}

function verifyStage(receipt, intent, receiptChainVerified, reconciliation) {
  const intentMatched = !!intent;
  const reconciled = reconciliation?.decision === 'allow';
  const passed = receiptChainVerified && reconciled && (!receipt.order?.intentProtected || intentMatched);
  return stage('verify', passed ? 'pass' : 'block', passed
    ? 'Receipt integrity, idempotency evidence, and account reconciliation passed.'
    : 'One or more verification guarantees are unavailable or blocked.', {
    receiptChainVerified, receiptSequence: finite(receipt.sequence),
    intentRequired: receipt.order?.intentProtected === true, intentMatched,
    replaySafe: intent?.replaySafe === true, reconciliationDecision: reconciliation?.decision || null,
    reconciliationReasonCode: reconciliation?.reasonCode || null,
  });
}

function journalStage(receipt, journal) {
  if (receipt.outcome !== 'accepted') {
    return stage('journal', 'not-required', 'No completed fill required a journal entry.', { matched: false });
  }
  if (!journal) return stage('journal', 'block', 'A matching paper journal entry was not found.', { matched: false });
  return stage('journal', 'pass', `The paper journal retained this ${journal.status || 'recorded'} position outcome.`, {
    matched: true, status: journal.status || null, result: journal.result || null,
    pnlUsd: finite(journal.pnl), openedAt: finite(journal.openedAt), closedAt: finite(journal.closedAt),
  });
}

function receiptTrace(receipt, context) {
  const approval = context.approvals.find((item) => item.mandateDigest
    && item.mandateDigest === receipt.authorization?.approvalDigest);
  const intent = context.intents.find((item) => item.receiptRef === receipt.hash
    || (receipt.order?.intentRef && item.intentRef === receipt.order.intentRef));
  const journal = context.journal.find((item) => receipt.order?.positionRef
    && executionPositionRef(item.id) === receipt.order.positionRef);
  const stages = [observeStage(receipt), analyzeStage(receipt), riskStage(receipt),
    approvalStage(receipt, approval), executeStage(receipt),
    verifyStage(receipt, intent, context.receiptChainVerified, context.reconciliation),
    journalStage(receipt, journal)];
  return {
    traceRef: traceRef('receipt', receipt.hash), source: 'execution-receipt',
    occurredAt: finite(receipt.recordedAt), action: receipt.action || 'open',
    symbol: receipt.order?.symbol || null, side: receipt.order?.side || null,
    outcome: receipt.outcome || 'unknown', reasonCode: receipt.policy?.reasonCode || null,
    summary: clean(receipt.policy?.detail || receipt.policy?.reasonCode || 'Paper decision retained.'),
    stages,
    evidenceCoveragePct: Math.round(stages.filter((item) => item.status !== 'unavailable').length / stages.length * 100),
  };
}

function approvalTrace(approval) {
  const allowed = approval.evidence?.decision === 'allow';
  const stages = [
    stage('observe', approval.evidence?.quoteSource ? 'pass' : 'unavailable',
      approval.evidence?.quoteSource ? 'Fresh preflight market evidence was retained.' : 'Market evidence was not retained.', {
        source: approval.evidence?.quoteSource || null, quoteAgeMs: finite(approval.evidence?.quoteAgeMs),
      }),
    stage('analyze', 'pass', 'A structured paper order mandate was retained.', {
      symbol: approval.order?.symbol || null, side: approval.order?.side || null, size: finite(approval.order?.size),
    }),
    stage('risk-check', allowed ? 'pass' : 'block', allowed ? 'The bound preflight allowed this mandate.' : 'The bound preflight did not allow this mandate.', {
      decision: approval.evidence?.decision || null, reasonCode: approval.evidence?.reasonCode || null,
      portfolioRisk: approval.evidence?.riskDecision || null, dataTrust: approval.evidence?.dataTrustDecision || null,
    }),
    stage('approval', approval.status === 'approved' || approval.status === 'consumed' ? 'pass'
      : approval.status === 'pending' ? 'pending' : 'block',
    approval.status === 'pending' ? 'This exact paper mandate is waiting for owner review.' : `Owner mandate is ${approval.status}.`, {
      status: approval.status, singleUse: approval.singleUse === true, ownerDecisionRequired: approval.ownerDecisionRequired === true,
    }),
    stage('execute', 'pending', 'No execution receipt is yet linked to this mandate.'),
    stage('verify', 'pending', 'Receipt and reconciliation evidence will be required after execution.'),
    stage('journal', 'pending', 'Journal evidence will be checked after a verified paper fill.'),
  ];
  return {
    traceRef: traceRef('approval', approval.mandateDigest), source: 'approval-mandate',
    occurredAt: finite(approval.createdAt), action: approval.action || 'open',
    symbol: approval.order?.symbol || null, side: approval.order?.side || null,
    outcome: approval.status || 'pending', reasonCode: approval.evidence?.reasonCode || null,
    summary: approval.status === 'pending' ? 'Waiting for exact owner approval.' : `Owner mandate ${approval.status}.`,
    stages, evidenceCoveragePct: Math.round(stages.filter((item) => !['unavailable', 'pending'].includes(item.status)).length / stages.length * 100),
  };
}

export function buildAgentDecisionTrace({ receipts = [], receiptVerification = {}, intents = [], approvals = [],
  approvalVerification = {}, journal = [], reconciliation = {}, eventStream = {}, limit = 25 } = {}) {
  const boundedLimit = Math.min(Math.max(Math.trunc(Number(limit) || 25), 1), MAX_TRACES);
  const context = { intents, approvals, journal, reconciliation, receiptChainVerified: receiptVerification.ok === true };
  const linkedApprovalDigests = new Set(receipts.map((receipt) => receipt.authorization?.approvalDigest).filter(Boolean));
  const traces = [
    ...receipts.map((receipt) => receiptTrace(receipt, context)),
    ...approvals.filter((approval) => !linkedApprovalDigests.has(approval.mandateDigest)).map(approvalTrace),
  ].sort((a, b) => (b.occurredAt || 0) - (a.occurredAt || 0)).slice(0, boundedLimit);
  const blocked = traces.filter((trace) => trace.stages.some((item) => item.status === 'block')).length;
  const pending = traces.filter((trace) => trace.stages.some((item) => item.status === 'pending')).length;
  const verified = traces.filter((trace) => trace.stages.find((item) => item.name === 'verify')?.status === 'pass').length;
  return {
    ok: receiptVerification.ok !== false && approvalVerification.ok !== false && reconciliation.decision !== 'deny',
    mode: 'paper-only', version: VERSION,
    status: receiptVerification.ok === false || approvalVerification.ok === false ? 'blocked' : pending ? 'attention' : 'healthy',
    counts: { total: traces.length, verified, blocked, pending },
    evidence: {
      receiptChainVerified: receiptVerification.ok === true,
      approvalChainVerified: approvalVerification.ok === true,
      reconciliationDecision: reconciliation.decision || null,
      reconciliationReasonCode: reconciliation.reasonCode || null,
      eventChainVerified: eventStream.chain?.verified === true,
      eventLatestSequence: finite(eventStream.cursor?.latestSequence),
    },
    stages: ['observe', 'analyze', 'risk-check', 'approval', 'execute', 'verify', 'journal'],
    traces,
    guarantees: {
      authoritativeEvidenceOnly: true, missingEvidenceNeverInferred: true,
      receiptBound: true, idempotencyVisible: true, ownerApprovalVisible: true,
      ownerIsolated: true, readOnly: true,
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    executionPermissionsChanged: false, authorityExpanded: false,
    liveScopeUsed: false, publicChainUsed: false,
  };
}

export const agentDecisionTraceConstants = Object.freeze({ version: VERSION, maximumTraces: MAX_TRACES });
