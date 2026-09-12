import assert from 'node:assert/strict';
import { createKrakenPairCatalog } from '../lib/kraken-draft-evidence.js';
import { buildOrderReview } from '../lib/order-review.js';
import { summarizeOrderReview } from '../public/js/order-review-summary.js';
const p = { wsname: 'XBT/USD', aclass_base: 'currency', aclass_quote: 'currency', status: 'online', lot_multiplier: 1, tick_size: '0.1', ordermin: '0.00005', costmin: '0.5', lot_decimals: 8, pair_decimals: 1 };
let clock = 1000, calls = 0, fail = false;
const catalog = createKrakenPairCatalog({ now: () => clock, fetchFn: async (url, options) => {
  assert.equal(url, 'https://api.kraken.com/0/public/AssetPairs'); assert.equal(options.method, 'GET');
  calls++; if (fail) throw Error('private upstream details');
  return new Response(JSON.stringify({ error: [], result: {
    XXBTZUSD: p, ETHUSD: { ...p, wsname: 'ETH/USD' },
    BADUSD: { ...p, wsname: 'BAD/USD', costmin: undefined },
    OFFUSD: { ...p, wsname: 'OFF/USD', status: 'cancel_only' },
    ETHUSDT: { ...p, wsname: 'ETH/USDT' },
    DUP1: { ...p, wsname: 'DUP/USD' }, DUP2: { ...p, wsname: 'DUP/USD' },
    'BAD.d': { ...p, wsname: 'DARK/USD' },
  } }));
} });
const [a, b] = await Promise.all([catalog(), catalog()]);
assert.equal(calls, 1); assert.deepEqual(a, b);
assert.deepEqual(a.pairs, [{ symbol: 'BTC', pair: 'XBT/USD' }, { symbol: 'ETH', pair: 'ETH/USD' }]);
assert.equal(a.executionAuthority, 'none');
await catalog(); assert.equal(calls, 1);
clock = 61001; fail = true;
const unavailable = await catalog(); assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.pairs, []);
assert.doesNotMatch(JSON.stringify(unavailable), /private upstream/);
const review = buildOrderReview({ symbol: 'BTC', quantity: '0.001', limitPrice: '50000' }, { maxOrderUsd: '25' });
review.market = { status: 'public-checks-passed', failures: [] };
const summary = summarizeOrderReview(review);
assert.match(summary.title, /needs changes/); assert.match(summary.blockers[0], /50\.00000000.*25\.00000000/);
assert.match(summary.approval, /not been requested/);
review.policy.notionalCap = 'within-configured-cap';
assert.match(summarizeOrderReview(review).title, /not authorization/);
review.market = { status: 'draft-invalid', failures: ['priceIncrement', 'minimumQuantity'] };
assert.equal(summarizeOrderReview(review).blockers.length, 2);
review.market = { status: 'unavailable' };
assert(summarizeOrderReview(review).unknowns.some(s => s.includes('not been verified')));
console.log('Pair catalog and draft summary checks passed');
