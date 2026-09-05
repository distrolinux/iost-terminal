// Deterministic, read-only reconciliation across the execution intent,
// receipt, position, journal and cash ledgers. Findings contain only opaque
// references and never trigger retries or mutate execution authority.
import { executionPositionRef } from './execution-receipts.js';

export const EXECUTION_RECONCILIATION_VERSION = 1;
const EPSILON = 1e-8;
const CASH_TOLERANCE_USD = 0.05;

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const close = (a, b, tolerance = EPSILON) => finite(a) != null && finite(b) != null
  && Math.abs(Number(a) - Number(b)) <= tolerance;

function finding(code, severity, subjectRef = null, detail = null) {
  return { code, severity, ...(subjectRef ? { subjectRef } : {}), ...(detail ? { detail } : {}) };
}

export function buildExecutionReconciliation({
  intents = [], receiptState = null, account = null, now = Date.now(),
} = {}) {
  const findings = [];
  const safeIntents = Array.isArray(intents) ? intents : [];
  const receipts = Array.isArray(receiptState?.receipts) ? receiptState.receipts : [];
  const positions = Array.isArray(account?.positions) ? account.positions : [];
  const journal = Array.isArray(account?.journal) ? account.journal : [];
  const intentByRef = new Map(safeIntents.filter((item) => item?.intentRef).map((item) => [item.intentRef, item]));
  const receiptsByIntent = new Map();

  if (!account?.account || finite(account.account.initialCash) == null || finite(account.account.cash) == null) {
    findings.push(finding('account-ledger-unavailable', 'critical'));
  }
  if (receiptState?.verification?.ok !== true) {
    findings.push(finding('receipt-chain-invalid', 'critical', null, receiptState?.verification?.error || 'Receipt chain is unavailable.'));
  }

  for (const intent of safeIntents) {
    if (intent?.status === 'outcome-unknown' || intent?.replaySafe !== true) {
      findings.push(finding('execution-intent-outcome-unknown', 'critical', intent?.intentRef));
    }
    if (['succeeded', 'failed'].includes(intent?.status) && !intent?.receiptRef) {
      findings.push(finding('terminal-intent-receipt-missing', 'critical', intent?.intentRef));
    } else if (intent?.receiptRef && !receipts.some((receipt) => receipt?.hash === intent.receiptRef)) {
      findings.push(finding('terminal-intent-receipt-not-found', 'critical', intent?.intentRef));
    }
  }

  for (const receipt of receipts) {
    const ref = receipt?.order?.intentRef;
    if (receipt?.order?.intentProtected === true) {
      if (!ref || !intentByRef.has(ref)) {
        findings.push(finding('protected-receipt-intent-missing', 'critical', ref || receipt?.hash));
      } else if (intentByRef.get(ref)?.action !== receipt?.action) {
        findings.push(finding('intent-receipt-action-mismatch', 'critical', ref));
      }
    }
    if (ref) receiptsByIntent.set(ref, [...(receiptsByIntent.get(ref) || []), receipt]);

    if (receipt?.outcome === 'accepted' && receipt?.action === 'open') {
      if (!receipt?.order?.positionRef) {
        findings.push(finding('legacy-open-position-link-unavailable', 'warning', receipt?.hash));
      } else if (!journal.some((entry) => executionPositionRef(entry?.id) === receipt.order.positionRef)) {
        findings.push(finding('accepted-open-journal-missing', 'critical', receipt.order.positionRef));
      }
    }
    if (receipt?.outcome === 'accepted' && receipt?.action === 'close' && receipt?.order?.positionRef) {
      const entry = journal.find((item) => executionPositionRef(item?.id) === receipt.order.positionRef);
      if (!entry || entry.status !== 'closed') findings.push(finding('accepted-close-journal-not-closed', 'critical', receipt.order.positionRef));
    }
  }
  for (const [ref, linked] of receiptsByIntent) {
    // Rejected authorization probes are audit evidence and may legitimately
    // reuse a known token without executing. Only multiple state-changing
    // terminal outcomes indicate duplicate execution.
    const stateChanging = linked.filter((receipt) => ['accepted', 'reversed'].includes(receipt?.outcome));
    if (stateChanging.length > 1) findings.push(finding('duplicate-intent-receipts', 'critical', ref));
  }

  const positionIds = new Set();
  const journalIds = new Set();
  for (const position of positions) {
    const ref = executionPositionRef(position?.id);
    if (!position?.id || positionIds.has(position.id)) findings.push(finding('duplicate-or-missing-position-id', 'critical', ref));
    if (position?.id) positionIds.add(position.id);
    const entry = journal.find((item) => item?.id === position?.id);
    if (!entry || entry.status !== 'open') findings.push(finding('open-position-journal-missing', 'critical', ref));
    else if (entry.symbol !== position.symbol || entry.side !== position.side
      || !close(entry.entry, position.entry) || !close(entry.size, position.size)) {
      findings.push(finding('position-journal-mismatch', 'critical', ref));
    }
    if (finite(position?.notional) == null || finite(position?.notional) < 0) {
      findings.push(finding('position-notional-invalid', 'critical', ref));
    }
  }
  for (const entry of journal) {
    const ref = executionPositionRef(entry?.id);
    if (!entry?.id || journalIds.has(entry.id)) findings.push(finding('duplicate-or-missing-journal-id', 'critical', ref));
    if (entry?.id) journalIds.add(entry.id);
    const active = positions.some((position) => position?.id === entry?.id);
    if (entry?.status === 'open' && !active) findings.push(finding('open-journal-position-missing', 'critical', ref));
    if (entry?.status === 'closed' && active) findings.push(finding('closed-journal-position-active', 'critical', ref));
    if (!['open', 'closed'].includes(entry?.status)) findings.push(finding('journal-status-invalid', 'critical', ref));
  }

  const initialCash = finite(account?.account?.initialCash);
  const actualCash = finite(account?.account?.cash);
  const closedPnl = journal.filter((entry) => entry?.status === 'closed').reduce((sum, entry) => sum + (finite(entry?.pnl) || 0), 0);
  const openNotional = positions.reduce((sum, position) => sum + (finite(position?.notional) || 0), 0);
  const expectedCash = initialCash == null ? null : initialCash + closedPnl - openNotional;
  const cashVarianceUsd = expectedCash == null || actualCash == null ? null : actualCash - expectedCash;
  const cashInvariant = cashVarianceUsd != null && Math.abs(cashVarianceUsd) <= CASH_TOLERANCE_USD;
  if (expectedCash != null && !cashInvariant) findings.push(finding('cash-ledger-mismatch', 'critical'));

  const critical = findings.filter((item) => item.severity === 'critical').length;
  const warning = findings.filter((item) => item.severity === 'warning').length;
  const decision = critical ? 'deny' : 'allow';
  return {
    ok: true, mode: 'paper-only', version: EXECUTION_RECONCILIATION_VERSION,
    readOnly: true, status: critical ? 'blocked' : warning ? 'attention' : 'healthy',
    decision, reasonCode: findings.find((item) => item.severity === 'critical')?.code || 'execution-state-reconciled',
    checkedAt: Math.trunc(now),
    counts: {
      intents: safeIntents.length,
      outcomeUnknown: safeIntents.filter((item) => item?.status === 'outcome-unknown').length,
      receipts: receipts.length, positions: positions.length, journal: journal.length,
      criticalFindings: critical, warningFindings: warning,
    },
    evidence: {
      receiptChainVerified: receiptState?.verification?.ok === true,
      receiptChainCount: Number(receiptState?.verification?.count || 0),
      cashInvariant, cashVarianceUsd: cashVarianceUsd == null ? null : Math.round(cashVarianceUsd * 10000) / 10000,
    },
    findings,
    policy: {
      failClosed: true, noAutomaticRetryForUnknown: true, ownerReviewRequiredForRepair: true,
      executionSemantics: 'at-most-once', terminalIntentReceiptRequired: true,
      sources: ['FIX-order-state', 'AWS-durable-idempotency'],
    },
    decisionEffects: { newExposureAllowed: decision === 'allow', executionPermissionsChanged: false, authorityExpanded: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false, publicChainUsed: false,
  };
}
