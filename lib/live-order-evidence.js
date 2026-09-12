import { previewLiveReconciliation } from './live-reconciliation-preview.js';

// Internal read-only inspection. Caller must supply this owner's broker, never
// a platform fallback. No HTTP/MCP exposure or automatic scheduler in this phase.
export async function inspectHeldLiveOrder(holds, ownerId, broker) {
  const unknown = { status: 'unknown', releaseAllowed: false, executionAuthorized: false };
  try {
    const stored = holds.read(ownerId);
    if (!stored.ok) return unknown;
    const { hold } = stored;
    const evidence = await broker.getOrderEvidence(hold);
    if (!evidence.ok) return unknown;
    return previewLiveReconciliation(evidence.expected, evidence.observation);
  } catch { return unknown; }
}
