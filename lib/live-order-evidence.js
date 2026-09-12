import { previewLiveReconciliation } from './live-reconciliation-preview.js';

// Explicit private evidence mutation, separate from read-only inspection.
export async function recordHeldSettlementEvidence(holds, ownerId, broker, history, window) {
  const held = { status: 'held', settlementVerified: false, releaseAllowed: false, executionAuthorized: false };
  try {
    const stored = holds.read(ownerId);
    if (!stored.ok) return held;
    const evidence = await broker.getLinkedSettlementEvidence(stored.hold, ownerId, window);
    if (evidence.status !== 'fill-ledger-links-matched') return held;
    return history.append(ownerId, stored.hold, evidence);
  } catch { return held; }
}

// Internal read-only inspection. Caller must supply this owner's broker, never
// a platform fallback. No HTTP/MCP exposure or automatic scheduler in this phase.
export async function inspectHeldLiveOrder(holds, ownerId, broker) {
  const unknown = { status: 'unknown', releaseAllowed: false, executionAuthorized: false };
  try {
    const stored = holds.read(ownerId);
    if (!stored.ok) return unknown;
    const { hold } = stored;
    const evidence = await broker.getOrderEvidence(hold, ownerId);
    if (!evidence.ok) return unknown;
    const preview = previewLiveReconciliation(evidence.expected, evidence.observation);
    if (preview.status === 'unknown') return preview;
    const fillEvidence = await broker.getFillEvidence(evidence.fillSummary);
    return { ...preview, fillEvidence };
  } catch { return unknown; }
}

// Deliberately separate from the read-only inspector: this records private
// evidence locally. Internal only; callers must provide this owner's broker.
// Never books a fill, changes a balance, releases a hold, or submits an order.
export async function recordHeldLiveOrderEvidence(holds, ownerId, broker, history) {
  const held = { status: 'held', releaseAllowed: false, executionAuthorized: false };
  try {
    const stored = holds.read(ownerId);
    if (!stored.ok) return held;
    const evidence = await broker.getOrderEvidence(stored.hold, ownerId);
    if (!evidence.ok || previewLiveReconciliation(evidence.expected, evidence.observation).status === 'unknown') return held;
    const fills = await broker.getFillEvidence(evidence.fillSummary);
    if (!['fill-totals-matched', 'no-fills-reported'].includes(fills.status)) return held;
    return history.append(ownerId, evidence.expected, evidence.observation, fills);
  } catch { return held; }
}
