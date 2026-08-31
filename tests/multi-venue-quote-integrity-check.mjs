import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMultiVenueExecutionQuote,
  EXECUTION_QUOTE_MAX_OUTLIER_BPS,
  EXECUTION_QUOTE_MAX_VENUE_SPREAD_BPS,
  EXECUTION_QUOTE_MIN_VENUES,
} from '../lib/quote-integrity.js';

const now = 1_788_182_500_000;
const quote = (source, { last, bid, ask, high24h = 10.2, low24h = 9.8, ageMs = 100, latencyMs = 20 }) => ({
  source, last, bid, ask, high24h, low24h, observedAt: now - ageMs, latencyMs,
});

const venues = [
  quote('OKX', { last: 10, bid: 9.99, ask: 10.02, latencyMs: 18 }),
  quote('KuCoin', { last: 10, bid: 9.98, ask: 10.01, latencyMs: 22 }),
  quote('Gate', { last: 10.01, bid: 10, ask: 10.03, latencyMs: 28 }),
];

assert.equal(EXECUTION_QUOTE_MIN_VENUES, 2);
assert.equal(EXECUTION_QUOTE_MAX_OUTLIER_BPS, 100);
assert.equal(EXECUTION_QUOTE_MAX_VENUE_SPREAD_BPS, 100);

const long = buildMultiVenueExecutionQuote({ symbol: 'IOST', side: 'long', quotes: venues, now });
assert.equal(long.ok, true);
assert.equal(long.reasonCode, 'quote-integrity-passed');
assert.equal(long.source, 'KuCoin');
assert.equal(long.ask, 10.01);
assert.equal(long.bid, 9.98);
assert.equal(long.quoteIntegrity.quoteCount, 3);
assert.equal(long.quoteIntegrity.trustedVenueCount, 3);
assert.equal(long.quoteIntegrity.routeVenue, 'KuCoin');
assert.equal(long.quoteIntegrity.executionSide, 'ask');
assert.equal(long.quoteIntegrity.quorumMet, true);
assert.equal(long.quoteIntegrity.venues[0].high24h, 10.2);
assert.equal(long.quoteIntegrity.venues[0].low24h, 9.8);

const short = buildMultiVenueExecutionQuote({ symbol: 'IOST', side: 'short', quotes: venues, now });
assert.equal(short.ok, true);
assert.equal(short.source, 'Gate');
assert.equal(short.bid, 10);
assert.equal(short.quoteIntegrity.routeVenue, 'Gate');
assert.equal(short.quoteIntegrity.executionSide, 'bid');

const outlier = buildMultiVenueExecutionQuote({
  symbol: 'IOST', side: 'long', now,
  quotes: [...venues.slice(0, 2), quote('Gate', { last: 12, bid: 11.99, ask: 12.01 })],
});
assert.equal(outlier.ok, true);
assert.equal(outlier.quoteIntegrity.trustedVenueCount, 2);
assert.equal(outlier.quoteIntegrity.excludedVenueCount, 1);
assert.deepEqual(outlier.quoteIntegrity.excludedVenues, [{ source: 'Gate', reason: 'consensus-outlier' }]);

const stale = buildMultiVenueExecutionQuote({
  symbol: 'IOST', side: 'long', now,
  quotes: [venues[0], quote('KuCoin', { last: 10, bid: 9.99, ask: 10.01, ageMs: 10_001 })],
});
assert.equal(stale.ok, false);
assert.equal(stale.reasonCode, 'quote-quorum');
assert.equal(stale.quoteIntegrity.trustedVenueCount, 1);
assert.deepEqual(stale.quoteIntegrity.excludedVenues, [{ source: 'KuCoin', reason: 'stale-quote' }]);

const malformed = buildMultiVenueExecutionQuote({
  symbol: 'IOST', side: 'long', now,
  quotes: [venues[0], quote('KuCoin', { last: 10, bid: 10.02, ask: 10.01 })],
});
assert.equal(malformed.ok, false);
assert.equal(malformed.reasonCode, 'quote-quorum');
assert.deepEqual(malformed.quoteIntegrity.excludedVenues, [{ source: 'KuCoin', reason: 'invalid-market' }]);

const wideVenue = buildMultiVenueExecutionQuote({
  symbol: 'IOST', side: 'long', now,
  quotes: [venues[0], quote('KuCoin', { last: 10, bid: 9, ask: 11 })],
});
assert.equal(wideVenue.ok, false);
assert.equal(wideVenue.reasonCode, 'quote-quorum');
assert.deepEqual(wideVenue.quoteIntegrity.excludedVenues, [{ source: 'KuCoin', reason: 'venue-spread-too-wide' }]);

const disagreement = buildMultiVenueExecutionQuote({
  symbol: 'IOST', side: 'long', now,
  quotes: [
    quote('OKX', { last: 10, bid: 9.99, ask: 10.01 }),
    quote('KuCoin', { last: 11, bid: 10.99, ask: 11.01 }),
  ],
});
assert.equal(disagreement.ok, false);
assert.equal(disagreement.reasonCode, 'quote-quorum');
assert.equal(disagreement.quoteIntegrity.quorumMet, false);

const marketSource = readFileSync(new URL('../lib/market.js', import.meta.url), 'utf8');
assert.match(marketSource, /EXECUTION_QUOTE_TIMEOUT_MS = 2_500/);
assert.match(marketSource, /Promise\.all\(\[/);
assert.match(marketSource, /OKX.*KuCoin.*Gate/s);

console.log('multi-venue quote integrity checks passed');
