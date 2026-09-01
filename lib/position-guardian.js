// Paper-only server-enforced position protection.
//
// The guardian models an already-filled position plus its stop-loss and
// take-profit as a bracket OCO: once either exit leg triggers, the other is
// cancelled. It never opens a position, expands exposure, invokes a live
// venue, or touches a public chain. Quote validity is evaluated before any
// trigger so stale or untrusted observations cannot fabricate a paper fill.

export const POSITION_GUARDIAN_VERSION = 1;
export const POSITION_GUARDIAN_CADENCE_MS = 10_000;
export const POSITION_GUARDIAN_MAX_QUOTE_AGE_MS = 15_000;

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, places = 8) => {
  const number = finite(value);
  if (number == null) return null;
  const power = 10 ** places;
  return Math.round((number + Number.EPSILON) * power) / power;
};

function leg(status, triggerPrice, now) {
  return {
    status, triggerPrice: round(triggerPrice), armedAt: status === 'working' ? Math.trunc(now) : null,
    triggeredAt: null, completedAt: null,
  };
}

export function createPositionGuardian(position, now = Date.now()) {
  const hasStop = finite(position?.stop) > 0;
  const hasTarget = finite(position?.target) > 0;
  const protectedPosition = hasStop || hasTarget;
  return {
    version: POSITION_GUARDIAN_VERSION,
    mode: 'paper-only',
    orderClass: hasStop && hasTarget ? 'bracket-oco' : hasStop ? 'protective-stop' : hasTarget ? 'take-profit' : 'none',
    status: protectedPosition ? 'armed' : 'unprotected',
    armedAt: protectedPosition ? Math.trunc(now) : null,
    completedAt: null,
    lastCheckedAt: null,
    lastHealthyAt: null,
    lastDecision: protectedPosition ? 'armed' : 'no-protective-exit',
    consecutiveFailures: 0,
    maxQuoteAgeMs: POSITION_GUARDIAN_MAX_QUOTE_AGE_MS,
    triggerLeg: null,
    cancelledLeg: null,
    lastQuote: null,
    legs: {
      stopLoss: leg(hasStop ? 'working' : 'absent', position?.stop, now),
      takeProfit: leg(hasTarget ? 'working' : 'absent', position?.target, now),
    },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}

export function ensurePositionGuardian(position, now = Date.now()) {
  if (!position.guardian || position.guardian.version !== POSITION_GUARDIAN_VERSION) {
    position.guardian = createPositionGuardian(position, now);
  }
  return position.guardian;
}

export function normalizeGuardianQuote(position, input, now = Date.now()) {
  const quote = typeof input === 'number'
    ? { last: input, bid: input, ask: input, source: 'injected-test-quote', observedAt: now, ageMs: 0, fresh: true,
        quoteIntegrity: { required: false, quorumMet: true } }
    : (input || {});
  const observedAt = Number.isFinite(Number(quote.observedAt)) ? Number(quote.observedAt)
    : Number.isFinite(Number(quote.ts)) ? Number(quote.ts) : null;
  const ageMs = Number.isFinite(Number(quote.ageMs)) ? Math.max(0, Math.trunc(Number(quote.ageMs)))
    : observedAt != null ? Math.max(0, Math.trunc(now - observedAt)) : null;
  const exitSide = position?.side === 'short' ? 'ask' : 'bid';
  const price = finite(quote[exitSide]) || finite(quote.last);
  const maxAgeMs = Number(position?.guardian?.maxQuoteAgeMs) || POSITION_GUARDIAN_MAX_QUOTE_AGE_MS;
  const fresh = quote.fresh === true && ageMs != null && ageMs <= maxAgeMs;
  const integrity = quote.quoteIntegrity || {};
  const quorumRequired = position?.type === 'crypto' && integrity.required !== false;
  const quorumMet = !quorumRequired || integrity.quorumMet === true;
  return {
    price: round(price), source: String(quote.source || 'unknown').slice(0, 80),
    observedAt: observedAt == null ? null : Math.trunc(observedAt), ageMs,
    fresh, maxAgeMs, exitSide, quorumRequired, quorumMet,
    quoteCount: Number.isSafeInteger(Number(integrity.quoteCount)) ? Number(integrity.quoteCount) : null,
    trustedVenueCount: Number.isSafeInteger(Number(integrity.trustedVenueCount)) ? Number(integrity.trustedVenueCount) : null,
    routeVenue: String(integrity.routeVenue || quote.source || '').slice(0, 80) || null,
    raw: quote,
  };
}

function triggerDecision(position, price) {
  const long = position.side !== 'short';
  const stop = finite(position.stop);
  const target = finite(position.target);
  const stopHit = stop != null && (long ? price <= stop : price >= stop);
  const targetHit = target != null && (long ? price >= target : price <= target);
  // Conservative deterministic tie-break: protection wins if bar/quote models
  // ever report both legs touched in the same observation.
  if (stopHit) return { triggerLeg: 'stop-loss', cancelledLeg: target != null ? 'take-profit' : null, triggerPrice: stop };
  if (targetHit) return { triggerLeg: 'take-profit', cancelledLeg: stop != null ? 'stop-loss' : null, triggerPrice: target };
  return null;
}

export function evaluatePositionGuardian(position, quoteInput, now = Date.now()) {
  const guardian = ensurePositionGuardian(position, now);
  guardian.lastCheckedAt = Math.trunc(now);
  if (guardian.status === 'unprotected') {
    const quote = normalizeGuardianQuote(position, quoteInput, now);
    guardian.lastDecision = 'no-protective-exit';
    guardian.lastQuote = {
      source: quote.source, observedAt: quote.observedAt, ageMs: quote.ageMs,
      fresh: quote.fresh, exitSide: quote.exitSide, price: quote.price,
      quorumRequired: quote.quorumRequired, quorumMet: quote.quorumMet,
      quoteCount: quote.quoteCount, trustedVenueCount: quote.trustedVenueCount,
      routeVenue: quote.routeVenue,
    };
    return { action: 'none', reasonCode: 'no-protective-exit', guardian, quote };
  }
  if (guardian.status === 'completed') return { action: 'none', reasonCode: 'guardian-completed', guardian };

  const quote = normalizeGuardianQuote(position, quoteInput, now);
  guardian.lastQuote = {
    source: quote.source, observedAt: quote.observedAt, ageMs: quote.ageMs,
    fresh: quote.fresh, exitSide: quote.exitSide, price: quote.price,
    quorumRequired: quote.quorumRequired, quorumMet: quote.quorumMet,
    quoteCount: quote.quoteCount, trustedVenueCount: quote.trustedVenueCount,
    routeVenue: quote.routeVenue,
  };
  if (!(quote.price > 0)) {
    guardian.status = 'degraded'; guardian.lastDecision = 'quote-unavailable'; guardian.consecutiveFailures += 1;
    return { action: 'none', reasonCode: guardian.lastDecision, guardian, quote };
  }
  if (!quote.fresh) {
    guardian.status = 'degraded'; guardian.lastDecision = 'quote-stale'; guardian.consecutiveFailures += 1;
    return { action: 'none', reasonCode: guardian.lastDecision, guardian, quote };
  }
  if (!quote.quorumMet) {
    guardian.status = 'degraded'; guardian.lastDecision = 'quote-quorum-failed'; guardian.consecutiveFailures += 1;
    return { action: 'none', reasonCode: guardian.lastDecision, guardian, quote };
  }

  guardian.status = 'armed'; guardian.lastHealthyAt = Math.trunc(now);
  guardian.lastDecision = 'no-trigger'; guardian.consecutiveFailures = 0;
  const decision = triggerDecision(position, quote.price);
  if (!decision) return { action: 'none', reasonCode: 'no-trigger', guardian, quote };

  guardian.status = 'triggered'; guardian.lastDecision = `${decision.triggerLeg}-triggered`;
  guardian.triggerLeg = decision.triggerLeg; guardian.cancelledLeg = decision.cancelledLeg;
  const triggered = decision.triggerLeg === 'stop-loss' ? guardian.legs.stopLoss : guardian.legs.takeProfit;
  const cancelled = decision.cancelledLeg === 'stop-loss' ? guardian.legs.stopLoss
    : decision.cancelledLeg === 'take-profit' ? guardian.legs.takeProfit : null;
  triggered.status = 'triggered'; triggered.triggeredAt = Math.trunc(now);
  if (cancelled) { cancelled.status = 'cancel-pending'; cancelled.triggeredAt = null; }
  return { action: 'close', ...decision, fillPrice: quote.price, guardian, quote };
}

export function completePositionGuardian(guardian, now = Date.now()) {
  if (!guardian) return null;
  guardian.status = 'completed'; guardian.completedAt = Math.trunc(now);
  const triggered = guardian.triggerLeg === 'stop-loss' ? guardian.legs.stopLoss : guardian.legs.takeProfit;
  const cancelled = guardian.cancelledLeg === 'stop-loss' ? guardian.legs.stopLoss
    : guardian.cancelledLeg === 'take-profit' ? guardian.legs.takeProfit : null;
  if (triggered) { triggered.status = 'filled'; triggered.completedAt = Math.trunc(now); }
  if (cancelled) { cancelled.status = 'cancelled'; cancelled.completedAt = Math.trunc(now); }
  return guardian;
}

export function guardianCoverage(positions = []) {
  const coverage = { total: positions.length, protected: 0, armed: 0, degraded: 0, unprotected: 0 };
  for (const position of positions) {
    const guardian = position.guardian?.version === POSITION_GUARDIAN_VERSION
      ? position.guardian : createPositionGuardian(position);
    if (guardian.status === 'unprotected') coverage.unprotected += 1;
    else {
      coverage.protected += 1;
      if (guardian.status === 'degraded') coverage.degraded += 1;
      else coverage.armed += 1;
    }
  }
  return coverage;
}

export function publicGuardianPosition(position) {
  const guardian = position.guardian?.version === POSITION_GUARDIAN_VERSION
    ? position.guardian : createPositionGuardian(position);
  return {
    positionId: position.id, symbol: position.symbol, side: position.side,
    status: guardian.status, orderClass: guardian.orderClass,
    stop: round(position.stop), target: round(position.target),
    lastCheckedAt: guardian.lastCheckedAt, lastHealthyAt: guardian.lastHealthyAt,
    lastDecision: guardian.lastDecision, consecutiveFailures: guardian.consecutiveFailures,
    quote: guardian.lastQuote ? { ...guardian.lastQuote } : null,
    legs: structuredClone(guardian.legs),
  };
}
