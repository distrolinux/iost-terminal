// Pure multi-venue quote validation and routing. This module performs no I/O
// and never places or reserves an order.

export const EXECUTION_QUOTE_TTL_MS = 10_000;
export const EXECUTION_QUOTE_MIN_VENUES = 2;
export const EXECUTION_QUOTE_MAX_OUTLIER_BPS = 100;
export const EXECUTION_QUOTE_MAX_VENUE_SPREAD_BPS = 100;

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clean = (value, max = 80) => String(value || '').trim().slice(0, max);
const round = (value, places = 8) => {
  const number = finite(value);
  if (number == null) return null;
  const power = 10 ** places;
  return Math.round((number + Number.EPSILON) * power) / power;
};
const median = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

function normalizeQuote(quote, now, ttlMs, maxVenueSpreadBps) {
  const source = clean(quote?.source);
  const last = finite(quote?.last);
  const bid = finite(quote?.bid);
  const ask = finite(quote?.ask);
  const observedAt = Number.isSafeInteger(Number(quote?.observedAt)) ? Number(quote.observedAt) : null;
  const ageMs = observedAt == null ? null : Math.max(0, Math.trunc(now - observedAt));
  const latencyMs = Number.isFinite(Number(quote?.latencyMs))
    ? Math.max(0, Math.trunc(Number(quote.latencyMs))) : null;
  if (!source || !(last > 0) || !(bid > 0) || !(ask > 0) || bid > ask || observedAt == null) {
    return { ok: false, source: source || 'unknown', reason: 'invalid-market' };
  }
  if (ageMs > ttlMs) return { ok: false, source, reason: 'stale-quote' };
  const midpoint = (bid + ask) / 2;
  const spreadBps = (ask - bid) / midpoint * 10_000;
  if (spreadBps > maxVenueSpreadBps) {
    return { ok: false, source, reason: 'venue-spread-too-wide' };
  }
  return {
    ok: true, source, last, bid, ask, midpoint, spreadBps,
    observedAt, ageMs, latencyMs,
  };
}

export function buildMultiVenueExecutionQuote({
  symbol = '', side = 'long', quotes = [], now = Date.now(),
  ttlMs = EXECUTION_QUOTE_TTL_MS,
  minVenues = EXECUTION_QUOTE_MIN_VENUES,
  maxOutlierBps = EXECUTION_QUOTE_MAX_OUTLIER_BPS,
  maxVenueSpreadBps = EXECUTION_QUOTE_MAX_VENUE_SPREAD_BPS,
} = {}) {
  const normalized = quotes.map((quote) => normalizeQuote(quote, now, ttlMs, maxVenueSpreadBps));
  const eligible = normalized.filter((quote) => quote.ok);
  const excluded = normalized.filter((quote) => !quote.ok)
    .map(({ source, reason }) => ({ source, reason }));
  const consensus = eligible.length ? median(eligible.map((quote) => quote.midpoint)) : null;
  const withDeviation = eligible.map((quote) => ({
    ...quote,
    deviationBps: consensus > 0 ? Math.abs(quote.midpoint - consensus) / consensus * 10_000 : null,
  }));
  const trusted = withDeviation.filter((quote) => quote.deviationBps <= maxOutlierBps);
  for (const quote of withDeviation) {
    if (quote.deviationBps > maxOutlierBps) {
      excluded.push({ source: quote.source, reason: 'consensus-outlier' });
    }
  }
  const executionSide = side === 'short' ? 'bid' : 'ask';
  const ranked = [...trusted].sort((a, b) => {
    const priceDifference = executionSide === 'bid' ? b.bid - a.bid : a.ask - b.ask;
    if (priceDifference) return priceDifference;
    return (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER);
  });
  const route = ranked[0] || null;
  const quorumMet = trusted.length >= minVenues;
  const quoteIntegrity = {
    required: true,
    quorumMet,
    minimumVenues: minVenues,
    quoteCount: quotes.length,
    trustedVenueCount: trusted.length,
    excludedVenueCount: excluded.length,
    excludedVenues: excluded,
    consensusPrice: round(consensus, 8),
    maximumOutlierBps: maxOutlierBps,
    maximumVenueSpreadBps: maxVenueSpreadBps,
    maximumObservedDeviationBps: round(trusted.length
      ? Math.max(...trusted.map((quote) => quote.deviationBps)) : null, 2),
    routeVenue: route?.source || null,
    routeLatencyMs: route?.latencyMs ?? null,
    executionSide,
    venues: trusted.map((quote) => ({
      source: quote.source,
      bid: round(quote.bid, 8),
      ask: round(quote.ask, 8),
      observedAt: quote.observedAt,
      ageMs: quote.ageMs,
      latencyMs: quote.latencyMs,
      consensusDeviationBps: round(quote.deviationBps, 2),
      spreadBps: round(quote.spreadBps, 2),
    })),
  };
  if (!quorumMet || !route) {
    return {
      ok: false,
      reasonCode: 'quote-quorum',
      symbol: clean(symbol, 24).toUpperCase(),
      source: null,
      last: round(consensus, 8),
      bid: null,
      ask: null,
      observedAt: null,
      quoteIntegrity,
    };
  }
  return {
    ok: true,
    reasonCode: 'quote-integrity-passed',
    symbol: clean(symbol, 24).toUpperCase(),
    source: route.source,
    last: round(consensus, 8),
    bid: round(route.bid, 8),
    ask: round(route.ask, 8),
    observedAt: route.observedAt,
    ageMs: route.ageMs,
    fresh: route.ageMs <= ttlMs,
    quoteIntegrity,
  };
}
