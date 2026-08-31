// Pure execution-quality scoring plus a small in-memory venue-health tracker.
// This module performs no I/O and never places, reserves, or approves an order.

export const EXECUTION_QUALITY_POLICY = Object.freeze({
  maximumPriceTradeoffBps: 10,
  targetLatencyMs: 500,
  maximumLatencyMs: 2_500,
  minimumReliabilityPct: 90,
  minimumReliabilitySamples: 5,
  circuitBreakerFailures: 3,
  weights: Object.freeze({ price: 0.45, latency: 0.35, reliability: 0.20 }),
});

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clean = (value, max = 80) => String(value || '').trim().slice(0, max);
const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const round = (value, places = 2) => {
  const number = finite(value);
  if (number == null) return null;
  const power = 10 ** places;
  return Math.round((number + Number.EPSILON) * power) / power;
};

export function createVenueHealthTracker({ windowSize = 20 } = {}) {
  const boundedWindow = Math.min(Math.max(Math.trunc(Number(windowSize) || 20), 5), 100);
  const records = new Map();

  function snapshot(source) {
    const name = clean(source) || 'unknown';
    const row = records.get(name) || { samples: [], consecutiveFailures: 0, lastObservedAt: null };
    const successes = row.samples.filter((sample) => sample.ok).length;
    const successfulLatencies = row.samples.filter((sample) => sample.ok && sample.latencyMs != null)
      .map((sample) => sample.latencyMs);
    return {
      source: name,
      sampleCount: row.samples.length,
      reliabilityPct: row.samples.length ? round(successes / row.samples.length * 100, 2) : 100,
      averageLatencyMs: successfulLatencies.length
        ? Math.round(successfulLatencies.reduce((sum, value) => sum + value, 0) / successfulLatencies.length) : null,
      consecutiveFailures: row.consecutiveFailures,
      circuitOpen: row.consecutiveFailures >= EXECUTION_QUALITY_POLICY.circuitBreakerFailures,
      lastObservedAt: row.lastObservedAt,
    };
  }

  return {
    record(source, { ok, latencyMs = null, now = Date.now() } = {}) {
      const name = clean(source) || 'unknown';
      const row = records.get(name) || { samples: [], consecutiveFailures: 0, lastObservedAt: null };
      row.samples.push({
        ok: ok === true,
        latencyMs: finite(latencyMs) == null ? null : Math.max(0, Math.trunc(Number(latencyMs))),
      });
      if (row.samples.length > boundedWindow) row.samples.splice(0, row.samples.length - boundedWindow);
      row.consecutiveFailures = ok === true ? 0 : row.consecutiveFailures + 1;
      row.lastObservedAt = Math.trunc(Number(now) || Date.now());
      records.set(name, row);
      return snapshot(name);
    },
    snapshot,
    list() {
      return [...records.keys()].sort().map(snapshot);
    },
  };
}

function priceDeltaBps(price, bestPrice, executionSide) {
  if (!(price > 0) || !(bestPrice > 0)) return null;
  const adverse = executionSide === 'bid' ? bestPrice - price : price - bestPrice;
  return Math.max(0, adverse / bestPrice * 10_000);
}

export function buildExecutionQualityDecision({
  side = 'long', venues = [], policy = EXECUTION_QUALITY_POLICY,
} = {}) {
  const executionSide = side === 'short' ? 'bid' : 'ask';
  const normalized = venues.flatMap((venue) => {
    const source = clean(venue?.source);
    const price = finite(venue?.[executionSide]);
    if (!source || !(price > 0)) return [];
    const latencyMs = finite(venue?.latencyMs) == null ? null : Math.max(0, Math.trunc(Number(venue.latencyMs)));
    const sampleCount = Math.max(0, Math.trunc(finite(venue?.sampleCount) || 0));
    const reliabilityPct = clamp(finite(venue?.reliabilityPct) ?? 100);
    const consecutiveFailures = Math.max(0, Math.trunc(finite(venue?.consecutiveFailures) || 0));
    const circuitOpen = venue?.circuitOpen === true
      || consecutiveFailures >= policy.circuitBreakerFailures;
    return [{ source, price, bid: finite(venue?.bid), ask: finite(venue?.ask), latencyMs,
      sampleCount, reliabilityPct, consecutiveFailures, circuitOpen }];
  });
  const priceRanked = [...normalized].sort((a, b) => {
    const delta = executionSide === 'bid' ? b.price - a.price : a.price - b.price;
    return delta || (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER);
  });
  const best = priceRanked[0] || null;
  const scored = normalized.map((venue) => {
    const deltaBps = priceDeltaBps(venue.price, best?.price, executionSide);
    const withinPriceProtection = deltaBps != null && deltaBps <= policy.maximumPriceTradeoffBps;
    const reliabilitySloMet = venue.sampleCount < policy.minimumReliabilitySamples
      || venue.reliabilityPct >= policy.minimumReliabilityPct;
    const latencySloMet = venue.latencyMs != null && venue.latencyMs <= policy.targetLatencyMs;
    const latencyWithinMaximum = venue.latencyMs == null || venue.latencyMs <= policy.maximumLatencyMs;
    const eligible = withinPriceProtection && !venue.circuitOpen && reliabilitySloMet && latencyWithinMaximum;
    const priceScore = clamp(100 - (deltaBps || 0) * 5);
    const latencyScore = venue.latencyMs == null ? 50
      : clamp(100 - venue.latencyMs / policy.targetLatencyMs * 100);
    const reliabilityScore = venue.reliabilityPct;
    const score = round(priceScore * policy.weights.price
      + latencyScore * policy.weights.latency
      + reliabilityScore * policy.weights.reliability, 2);
    return {
      ...venue, priceDeltaBps: round(deltaBps, 2), withinPriceProtection,
      reliabilitySloMet, latencySloMet, eligible,
      priceScore: round(priceScore, 2), latencyScore: round(latencyScore, 2),
      reliabilityScore: round(reliabilityScore, 2), score,
      tier: score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 60 ? 'degraded' : 'poor',
      status: venue.circuitOpen ? 'circuit-open'
        : !reliabilitySloMet ? 'reliability-degraded'
          : !latencyWithinMaximum ? 'latency-degraded'
            : withinPriceProtection ? 'eligible' : 'price-protected',
    };
  });
  const candidates = scored.filter((venue) => venue.eligible).sort((a, b) =>
    b.score - a.score
      || (executionSide === 'bid' ? b.price - a.price : a.price - b.price)
      || (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER));
  const selected = candidates[0] || null;
  const bestScored = scored.find((venue) => venue.source === best?.source) || null;
  const failoverApplied = !!selected && selected.source !== best?.source;
  const failoverReason = !failoverApplied ? null
    : bestScored?.circuitOpen ? 'venue-circuit-open'
      : bestScored && !bestScored.reliabilitySloMet ? 'reliability-below-slo'
        : bestScored?.latencyMs > policy.maximumLatencyMs ? 'latency-above-maximum'
          : 'quality-score';

  return {
    required: true,
    decision: selected ? 'allow' : 'deny',
    reasonCode: selected ? 'execution-quality-passed' : 'execution-quality-unavailable',
    executionSide,
    bestPriceVenue: best?.source || null,
    bestPrice: round(best?.price, 8),
    selectedVenue: selected?.source || null,
    selectedPrice: round(selected?.price, 8),
    selectedScore: selected?.score ?? null,
    selectedTier: selected?.tier || null,
    selectedLatencyMs: selected?.latencyMs ?? null,
    selectedReliabilityPct: selected?.reliabilityPct ?? null,
    latencySloMet: selected?.latencySloMet === true,
    failoverApplied,
    failoverFromVenue: failoverApplied ? best?.source || null : null,
    failoverReason,
    eligibleVenueCount: candidates.length,
    degradedVenueCount: scored.filter((venue) => !venue.reliabilitySloMet || venue.circuitOpen
      || venue.latencyMs > policy.maximumLatencyMs).length,
    policy: {
      maximumPriceTradeoffBps: policy.maximumPriceTradeoffBps,
      targetLatencyMs: policy.targetLatencyMs,
      maximumLatencyMs: policy.maximumLatencyMs,
      minimumReliabilityPct: policy.minimumReliabilityPct,
      minimumReliabilitySamples: policy.minimumReliabilitySamples,
      circuitBreakerFailures: policy.circuitBreakerFailures,
      weights: { ...policy.weights },
    },
    venues: scored.map((venue) => ({
      source: venue.source, bid: round(venue.bid, 8), ask: round(venue.ask, 8),
      latencyMs: venue.latencyMs, reliabilityPct: round(venue.reliabilityPct, 2),
      sampleCount: venue.sampleCount, consecutiveFailures: venue.consecutiveFailures,
      circuitOpen: venue.circuitOpen, priceDeltaBps: venue.priceDeltaBps,
      withinPriceProtection: venue.withinPriceProtection, reliabilitySloMet: venue.reliabilitySloMet,
      latencySloMet: venue.latencySloMet, eligible: venue.eligible,
      priceScore: venue.priceScore, latencyScore: venue.latencyScore,
      reliabilityScore: venue.reliabilityScore, score: venue.score,
      tier: venue.tier, status: venue.status,
    })),
    authorization: { liveScopeUsed: false, publicChainUsed: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
  };
}

export function sanitizeExecutionQualityEvidence(input) {
  if (!input || typeof input !== 'object') return null;
  const policy = input.policy || {};
  return {
    required: input.required === true,
    decision: input.decision === 'allow' ? 'allow' : 'deny',
    reasonCode: clean(input.reasonCode, 120) || null,
    executionSide: input.executionSide === 'bid' ? 'bid' : 'ask',
    bestPriceVenue: clean(input.bestPriceVenue, 80) || null,
    bestPrice: round(input.bestPrice, 8),
    selectedVenue: clean(input.selectedVenue, 80) || null,
    selectedPrice: round(input.selectedPrice, 8),
    selectedScore: round(input.selectedScore, 2),
    selectedTier: ['excellent', 'good', 'degraded', 'poor'].includes(input.selectedTier)
      ? input.selectedTier : null,
    selectedLatencyMs: finite(input.selectedLatencyMs) == null
      ? null : Math.max(0, Math.trunc(Number(input.selectedLatencyMs))),
    selectedReliabilityPct: round(input.selectedReliabilityPct, 2),
    latencySloMet: input.latencySloMet === true,
    failoverApplied: input.failoverApplied === true,
    failoverFromVenue: clean(input.failoverFromVenue, 80) || null,
    failoverReason: clean(input.failoverReason, 120) || null,
    eligibleVenueCount: Math.max(0, Math.trunc(finite(input.eligibleVenueCount) || 0)),
    degradedVenueCount: Math.max(0, Math.trunc(finite(input.degradedVenueCount) || 0)),
    policy: {
      maximumPriceTradeoffBps: round(policy.maximumPriceTradeoffBps, 2),
      targetLatencyMs: finite(policy.targetLatencyMs) == null ? null : Math.max(0, Math.trunc(Number(policy.targetLatencyMs))),
      maximumLatencyMs: finite(policy.maximumLatencyMs) == null ? null : Math.max(0, Math.trunc(Number(policy.maximumLatencyMs))),
      minimumReliabilityPct: round(policy.minimumReliabilityPct, 2),
      minimumReliabilitySamples: Math.max(0, Math.trunc(finite(policy.minimumReliabilitySamples) || 0)),
      circuitBreakerFailures: Math.max(0, Math.trunc(finite(policy.circuitBreakerFailures) || 0)),
      weights: {
        price: round(policy.weights?.price, 4),
        latency: round(policy.weights?.latency, 4),
        reliability: round(policy.weights?.reliability, 4),
      },
    },
    venues: Array.isArray(input.venues) ? input.venues.slice(0, 8).map((venue) => ({
      source: clean(venue?.source, 80) || 'unknown',
      bid: round(venue?.bid, 8), ask: round(venue?.ask, 8),
      latencyMs: finite(venue?.latencyMs) == null ? null : Math.max(0, Math.trunc(Number(venue.latencyMs))),
      reliabilityPct: round(venue?.reliabilityPct, 2),
      sampleCount: Math.max(0, Math.trunc(finite(venue?.sampleCount) || 0)),
      consecutiveFailures: Math.max(0, Math.trunc(finite(venue?.consecutiveFailures) || 0)),
      circuitOpen: venue?.circuitOpen === true,
      priceDeltaBps: round(venue?.priceDeltaBps, 2),
      withinPriceProtection: venue?.withinPriceProtection === true,
      reliabilitySloMet: venue?.reliabilitySloMet === true,
      latencySloMet: venue?.latencySloMet === true,
      eligible: venue?.eligible === true,
      priceScore: round(venue?.priceScore, 2), latencyScore: round(venue?.latencyScore, 2),
      reliabilityScore: round(venue?.reliabilityScore, 2), score: round(venue?.score, 2),
      tier: ['excellent', 'good', 'degraded', 'poor'].includes(venue?.tier) ? venue.tier : null,
      status: clean(venue?.status, 80) || null,
    })) : [],
    authorization: { liveScopeUsed: false, publicChainUsed: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
  };
}
