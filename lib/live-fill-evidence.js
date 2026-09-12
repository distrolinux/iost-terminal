// Compare provider-reported totals, without floating point or ledger writes.
// Fee amount agreement is NOT proof of the asset debited or final settlement.
import { createHash } from 'node:crypto';
export function verifyLiveFillEvidence(order, trades) {
  const unknown = { status: 'unknown', feesVerified: false, releaseAllowed: false, executionAuthorized: false };
  const units = value => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})(\.\d{1,10})?$/.test(value)) throw Error('decimal');
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 10000000000n + BigInt(fraction.padEnd(10, '0'));
  };
  try {
    const ids = order.tradeIds;
    if (typeof order.venueOrderId !== 'string' || !order.venueOrderId || typeof order.pair !== 'string' || !order.pair || !['buy', 'sell'].includes(order.side)) return unknown;
    if (!Array.isArray(ids) || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id))) return unknown;
    if (!trades || typeof trades !== 'object' || Array.isArray(trades) || Object.keys(trades).length !== ids.length) return unknown;
    let volume = 0n, cost = 0n, fee = 0n;
    const fills = [];
    for (const id of ids) {
      if (!Object.hasOwn(trades, id)) return unknown;
      const t = trades[id];
      if (t.ordertxid !== order.venueOrderId || t.pair !== order.pair || t.type !== order.side || units(t.margin) !== 0n) return unknown;
      const v = units(t.vol), c = units(t.cost);
      if (v <= 0n || c <= 0n || units(t.price) <= 0n) return unknown;
      volume += v; cost += c; fee += units(t.fee);
      const canonical = [t.ordertxid, t.pair, t.type, v.toString(), c.toString(), units(t.fee).toString(), units(t.price).toString()];
      fills.push({ id, digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') });
    }
    if (volume !== units(order.filledQuantity) || cost !== units(order.cost) || fee !== units(order.fee)) return unknown;
    fills.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { ...unknown, status: ids.length ? 'fill-totals-matched' : 'no-fills-reported', fillCount: ids.length, fills, reportedFilledQuantity: order.filledQuantity, reportedCost: order.cost, reportedFee: order.fee, feeSettlementVerified: false };
  } catch { return unknown; }
}
