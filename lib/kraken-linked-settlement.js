import { verifyLiveFillEvidence } from './live-fill-evidence.js';
import { linkSpotFillLedgerEvidence } from './live-fill-ledger-link.js';

// Internal read-only acquisition. BTC/USD default-wallet spot only in this phase.
export async function readLinkedKrakenSettlement(read, order, window) {
  const held = { status: 'unknown', settlementVerified: false, releaseAllowed: false, executionAuthorized: false };
  try {
    const { start, end } = window;
    if (order?.pair !== 'XBTUSD' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 86400 || end > Math.floor(Date.now() / 1000)) return held;
    const ids = order.tradeIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id))) return held;
    const history = await read('TradesHistory', { start: String(start), end: String(end), ledgers: 'true', consolidate_taker: 'false', trades: 'false', without_count: 'false', limit: '100', ofs: '0' });
    if (!Number.isSafeInteger(history?.count) || history.count < 1 || history.count > 100 || !history.trades || typeof history.trades !== 'object' || Array.isArray(history.trades) || Object.keys(history.trades).length !== history.count) return held;
    const trades = {}, ledgerIds = [];
    for (const id of ids) {
      if (!Object.hasOwn(history.trades, id)) return held;
      const t = history.trades[id];
      if (!t || !Number.isFinite(t.time) || t.time <= start || t.time > end || !Array.isArray(t.ledgers) || t.ledgers.length !== 2 || t.ledgers.some(l => typeof l !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(l))) return held;
      trades[id] = { ...t, pair: t.pair === 'XXBTZUSD' ? 'XBTUSD' : t.pair };
      ledgerIds.push(...t.ledgers);
    }
    // A new fill on the same order cannot be silently omitted from the snapshot.
    if (Object.entries(history.trades).some(([id, t]) => t?.ordertxid === order.venueOrderId && !ids.includes(id))) return held;
    if (new Set(ledgerIds).size !== ledgerIds.length || verifyLiveFillEvidence(order, trades).status !== 'fill-totals-matched') return held;
    const rows = [];
    for (let offset = 0; offset < ledgerIds.length; offset += 20) {
      const chunk = ledgerIds.slice(offset, offset + 20);
      const result = await read('QueryLedgers', { id: chunk.join(',') });
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== chunk.length) return held;
      for (const id of chunk) {
        if (!Object.hasOwn(result, id)) return held;
        const r = result[id];
        if (!r || !Number.isFinite(r.time) || r.time <= start || r.time > end) return held;
        rows.push({ ...r, id });
      }
    }
    return linkSpotFillLedgerEvidence(order, trades, { pair: 'XBTUSD', baseAsset: 'XXBT', quoteAsset: 'ZUSD' }, rows);
  } catch { return held; }
}
