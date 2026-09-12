import assert from 'node:assert/strict';
import { linkSpotFillLedgerEvidence } from '../lib/live-fill-ledger-link.js';
const order = { venueOrderId: 'O-FIXTURE', pair: 'XBTUSD', side: 'buy', tradeIds: ['T-1', 'T-2'], filledQuantity: '0.002', cost: '100', fee: '0.2' };
const market = { pair: 'XBTUSD', baseAsset: 'XXBT', quoteAsset: 'ZUSD' };
const trades = Object.fromEntries(order.tradeIds.map((id, i) => [id, { ordertxid: order.venueOrderId, pair: order.pair, type: 'buy', margin: '0', vol: '0.001', cost: '50', fee: '0.1', price: '50000', ledgers: ['L-B' + i, 'L-Q' + i] }]));
const rows = order.tradeIds.flatMap((refid, i) => [
  { id: 'L-B' + i, refid, type: 'trade', subtype: '', aclass: 'currency', asset: 'XXBT', amount: '0.001', fee: '0.000002' },
  { id: 'L-Q' + i, refid, type: 'trade', subtype: '', aclass: 'currency', asset: 'ZUSD', amount: '-50', fee: '0' }
]);
const result = linkSpotFillLedgerEvidence(order, trades, market, rows);
assert.equal(result.status, 'fill-ledger-links-matched');
assert.equal(result.fillCount, 2); assert.equal(result.ledgerCount, 4);
assert.equal(result.settlementVerified, false); assert.equal(result.releaseAllowed, false);
assert.equal(result.links[0].assets[0].netChange, '0.000998');
assert.deepEqual(linkSpotFillLedgerEvidence(order, trades, market, [...rows].reverse()), result);
for (const mutate of [
  (t, r) => delete t['T-1'].ledgers,
  (t, r) => t['T-1'].ledgers = 'L-B0,L-Q0',
  (t, r) => t['T-1'].ledgers = ['L-B0', 'L-B0'],
  (t, r) => t['T-2'].ledgers = t['T-1'].ledgers,
  (t, r) => t['T-1'].ordertxid = 'O-OTHER',
  (t, r) => r.pop(), (t, r) => r.push({ ...r[0] }),
  (t, r) => r[0].refid = 'T-2',
  (t, r) => r[0].amount = '0.002',
  (t, r) => r.push({ ...r[0], id: 'L-EXTRA' })
]) {
  const t = structuredClone(trades), r = structuredClone(rows); mutate(t, r);
  assert.equal(linkSpotFillLedgerEvidence(order, t, market, r).status, 'unknown');
}
assert.equal(linkSpotFillLedgerEvidence(order, trades, { ...market, pair: 'ETHUSD' }, rows).status, 'unknown');
assert.equal(linkSpotFillLedgerEvidence(null, null, null, null).status, 'unknown');
console.log('Explicit fill/ledger linkage and duplicate rejection passed (offline)');
