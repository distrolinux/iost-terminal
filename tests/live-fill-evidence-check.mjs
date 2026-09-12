import assert from 'node:assert/strict';
import { verifyLiveFillEvidence } from '../lib/live-fill-evidence.js';
const order = { venueOrderId: 'order-fixture', pair: 'XBTUSD', side: 'buy', filledQuantity: '0.3', cost: '15000', fee: '15', tradeIds: ['fill-a', 'fill-b'] };
const a = { ordertxid: order.venueOrderId, pair: 'XBTUSD', type: 'buy', vol: '0.1', cost: '5000', fee: '5', price: '50000', margin: '0' };
const b = { ...a, vol: '0.2', cost: '10000', fee: '10' };
const trades = { 'fill-a': a, 'fill-b': b };
assert.equal(verifyLiveFillEvidence(order, trades).status, 'fill-totals-matched');
assert.equal(verifyLiveFillEvidence(order, trades).releaseAllowed, false);
assert.equal(verifyLiveFillEvidence(order, trades).feesVerified, false, 'matching reports does not prove settlement currency');
assert.deepEqual(verifyLiveFillEvidence(order, trades), verifyLiveFillEvidence(order, { 'fill-b': b, 'fill-a': a }), 'replay/order independent');
for (const bad of [{}, { 'fill-a': a }, { ...trades, 'fill-c': a }, ...[{ vol: '0.3' }, { cost: '10001' }, { fee: '-1' }, { fee: '11' }, { ordertxid: 'other' }, { pair: 'ETHUSD' }, { type: 'sell' }, { margin: '1' }, { price: 'NaN' }].map(change => ({ ...trades, 'fill-b': { ...b, ...change } }))]) {
  assert.equal(verifyLiveFillEvidence(order, bad).status, 'unknown');
}
assert.equal(verifyLiveFillEvidence({ ...order, tradeIds: ['fill-a', 'fill-a'] }, trades).status, 'unknown');
assert.equal(verifyLiveFillEvidence({ ...order, tradeIds: undefined }, trades).status, 'unknown');
assert.equal(verifyLiveFillEvidence({ ...order, tradeIds: Array(21).fill('fill-a') }, trades).status, 'unknown');
assert.equal(verifyLiveFillEvidence({ ...order, tradeIds: [], filledQuantity: '0', cost: '0', fee: '0' }, {}).status, 'no-fills-reported');
console.log('Exact fill totals, replay, missing evidence and conflict checks passed');
