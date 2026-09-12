import assert from 'node:assert/strict';
import { createKrakenDraftEvidence } from '../lib/kraken-draft-evidence.js';
import { buildOrderReview } from '../lib/order-review.js';
const pair = { wsname: 'XBT/USD', aclass_base: 'currency', aclass_quote: 'currency', lot_multiplier: 1, lot_decimals: 8, pair_decimals: 1, tick_size: '0.1', ordermin: '0.0001', costmin: '0.5', status: 'online' };
const draft = buildOrderReview({ symbol: 'BTC', quantity: '0.001', limitPrice: '50000.0' });
function fixture({ p = pair, ticker = { XXBTZUSD: { a: ['50001.0'], b: ['49999.0'] } }, error = [], advance = false, oversized = false } = {}) {
  const calls = []; let clock = 1000;
  const check = createKrakenDraftEvidence({ now: () => clock, fetchFn: async (url, options) => {
    calls.push(url);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert(url.startsWith('https://api.kraken.com/0/public/'));
    const result = url.includes('AssetPairs') ? { XXBTZUSD: p } : ticker;
    if (advance) clock += 9000;
    return new Response(oversized ? 'x'.repeat(262145) : JSON.stringify({ error, result }));
  } });
  return { check, calls };
}
const f = fixture(); const good = await f.check(draft);
assert.equal(good.status, 'public-checks-passed');
assert.equal(good.quote.spreadBps, '0.40');
assert.equal(good.quote.sourceQuoteAgeMs, null);
assert.equal(good.expiresAt, 31000);
assert.equal(good.executionAuthority, 'none');
assert.equal(good.fees, 'not-verified');
assert.deepEqual(f.calls, ['https://api.kraken.com/0/public/AssetPairs?pair=XBTUSD', 'https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD']);
const badDraft = buildOrderReview({ symbol: 'BTC', quantity: '0.00000001', limitPrice: '0.11' });
const invalid = await fixture().check(badDraft);
assert.equal(invalid.status, 'draft-invalid');
assert(invalid.failures.includes('minimumQuantity'));
assert(invalid.failures.includes('minimumNotional'));
assert(invalid.failures.includes('priceIncrement'));
assert.equal((await fixture({ p: { ...pair, status: 'cancel_only' } }).check(draft)).checks.pairOnline, false);
assert.equal((await fixture({ p: { ...pair, lot_decimals: 2 } }).check(draft)).checks.quantityIncrement, false);
for (const opts of [
  { p: { ...pair, wsname: 'XBT/USDT' } }, { p: { ...pair, costmin: undefined } },
  { p: { ...pair, tick_size: '0' } }, { p: { ...pair, lot_decimals: 99 } },
  { p: { ...pair, lot_multiplier: 2 } }, { ticker: { OTHER: { a: ['1'], b: ['1'] } } },
  { ticker: { XXBTZUSD: { a: ['1'], b: ['2'] } } }, { error: ['upstream failure'] },
  { advance: true }, { oversized: true },
]) assert.equal((await fixture(opts).check(draft)).status, 'unavailable');
const unavailable = createKrakenDraftEvidence({ fetchFn: async () => { throw Error('private upstream detail'); } });
assert.doesNotMatch(JSON.stringify(await unavailable(draft)), /private upstream/);
const aged = createKrakenDraftEvidence({ fetchFn: async () => new Response('{}', { headers: { Age: '31' } }) });
assert.equal((await aged(draft)).status, 'unavailable');
console.log('Kraken public draft evidence checks passed');
