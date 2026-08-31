import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXECUTION_QUALITY_POLICY,
  buildExecutionQualityDecision,
  createVenueHealthTracker,
} from '../lib/execution-quality.js';

const venues = [
  { source: 'OKX', bid: 99.98, ask: 100, latencyMs: 420 },
  { source: 'KuCoin', bid: 99.97, ask: 100.04, latencyMs: 45 },
  { source: 'Gate', bid: 99.95, ask: 100.20, latencyMs: 20 },
];

assert.equal(EXECUTION_QUALITY_POLICY.maximumPriceTradeoffBps, 10);
assert.equal(EXECUTION_QUALITY_POLICY.targetLatencyMs, 500);
assert.equal(EXECUTION_QUALITY_POLICY.minimumReliabilityPct, 90);

const balanced = buildExecutionQualityDecision({ side: 'long', venues });
assert.equal(balanced.decision, 'allow');
assert.equal(balanced.reasonCode, 'execution-quality-passed');
assert.equal(balanced.bestPriceVenue, 'OKX');
assert.equal(balanced.selectedVenue, 'KuCoin');
assert.equal(balanced.failoverApplied, true);
assert.equal(balanced.failoverReason, 'quality-score');
assert.equal(balanced.venues.find((venue) => venue.source === 'Gate').withinPriceProtection, false);
assert.equal(balanced.venues.find((venue) => venue.source === 'Gate').eligible, false);
assert.equal(balanced.latencySloMet, true);
assert.ok(balanced.selectedScore >= 0 && balanced.selectedScore <= 100);

const degradedBestPrice = buildExecutionQualityDecision({
  side: 'long',
  venues: venues.map((venue) => venue.source === 'OKX'
    ? { ...venue, reliabilityPct: 70, sampleCount: 20, consecutiveFailures: 3, circuitOpen: true }
    : { ...venue, reliabilityPct: 100, sampleCount: 20, consecutiveFailures: 0, circuitOpen: false }),
});
assert.equal(degradedBestPrice.decision, 'allow');
assert.equal(degradedBestPrice.selectedVenue, 'KuCoin');
assert.equal(degradedBestPrice.failoverApplied, true);
assert.equal(degradedBestPrice.failoverReason, 'venue-circuit-open');
assert.equal(degradedBestPrice.degradedVenueCount, 1);

const noSafeRoute = buildExecutionQualityDecision({
  side: 'long',
  venues: venues.map((venue) => ({
    ...venue, reliabilityPct: 50, sampleCount: 20, consecutiveFailures: 3, circuitOpen: true,
  })),
});
assert.equal(noSafeRoute.decision, 'deny');
assert.equal(noSafeRoute.reasonCode, 'execution-quality-unavailable');
assert.equal(noSafeRoute.selectedVenue, null);

const short = buildExecutionQualityDecision({
  side: 'short',
  venues: [
    { source: 'OKX', bid: 100, ask: 100.02, latencyMs: 300 },
    { source: 'KuCoin', bid: 99.98, ask: 100, latencyMs: 20 },
  ],
});
assert.equal(short.bestPriceVenue, 'OKX');
assert.equal(short.selectedVenue, 'KuCoin');
assert.equal(short.executionSide, 'bid');

const tracker = createVenueHealthTracker({ windowSize: 5 });
tracker.record('OKX', { ok: false, latencyMs: 900, now: 1 });
tracker.record('OKX', { ok: false, latencyMs: 900, now: 2 });
let health = tracker.record('OKX', { ok: false, latencyMs: 900, now: 3 });
assert.equal(health.circuitOpen, true);
assert.equal(health.consecutiveFailures, 3);
tracker.record('OKX', { ok: true, latencyMs: 100, now: 4 });
health = tracker.record('OKX', { ok: true, latencyMs: 100, now: 5 });
assert.equal(health.reliabilityPct, 40);
assert.equal(health.sampleCount, 5);
assert.equal(health.consecutiveFailures, 0);

const marketSource = readFileSync(new URL('../lib/market.js', import.meta.url), 'utf8');
assert.match(marketSource, /Promise\.all\(\[/, 'venue requests must remain concurrent');
assert.match(marketSource, /venueHealth\.record\(source, \{ ok: true/);
assert.match(marketSource, /venueHealth\.record\(source, \{ ok: false/);

console.log('execution quality engine checks passed');
