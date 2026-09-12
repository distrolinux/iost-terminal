import { verifyLiveFillEvidence } from './live-fill-evidence.js';
import { previewSpotLedgerEvidence } from './live-settlement-evidence.js';

// Pure internal linkage check. Requires explicit provider ledger IDs per fill;
// never guesses links from amounts/timestamps or treats them as posting authority.
// Market metadata and account-bound evidence acquisition are caller obligations.
export function linkSpotFillLedgerEvidence(order, trades, market, rows) {
  const held = { status: 'unknown', settlementVerified: false, releaseAllowed: false, executionAuthorized: false };
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(id);
  try {
    const fills = verifyLiveFillEvidence(order, trades);
    if (fills.status !== 'fill-totals-matched' || market?.pair !== order.pair || !Array.isArray(rows) || rows.length !== fills.fillCount * 2) return held;
    const byId = new Map();
    for (const row of rows) {
      if (!row || !validId(row.id) || byId.has(row.id)) return held;
      byId.set(row.id, row);
    }
    const consumed = new Set(), links = [];
    for (const fill of fills.fills) {
      const trade = trades[fill.id], ids = trade.ledgers;
      if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => !validId(id) || consumed.has(id) || !byId.has(id)) || ids[0] === ids[1]) return held;
      const legs = ids.map(id => byId.get(id));
      // Explicit list and shared provider reference must agree. Never assume
      // referenceId equals an order ID or fabricate it when absent.
      if (legs[0].refid !== legs[1].refid) return held;
      const preview = previewSpotLedgerEvidence({ referenceId: legs[0].refid, baseAsset: market.baseAsset, quoteAsset: market.quoteAsset, side: trade.type, volume: trade.vol, cost: trade.cost }, legs);
      if (preview.status !== 'ledger-legs-matched') return held;
      for (const id of ids) consumed.add(id);
      links.push({ fillId: fill.id, fillDigest: fill.digest, ledgerIds: [...ids].sort(), assets: preview.assets });
    }
    if (consumed.size !== byId.size) return held;
    return { ...held, status: 'fill-ledger-links-matched', fillCount: links.length, ledgerCount: consumed.size, links };
  } catch { return held; }
}
