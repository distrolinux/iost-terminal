import assert from 'node:assert/strict';
import {
  buildVolatilitySentinel,
  VOLATILITY_SENTINEL_POLICY,
} from '../lib/volatility-sentinel.js';

const now = Date.UTC(2026, 7, 31, 18);

assert.deepEqual(VOLATILITY_SENTINEL_POLICY, {
  garchMaxAgeMs: 6 * 60 * 60 * 1_000,
  rangeMaxAgeMs: 10_000,
  cryptoCalmMaxDailyPct: 2,
  cryptoStormMinDailyPct: 5,
  stockCalmMaxDailyPct: 1,
  stockStormMinDailyPct: 3,
  calmMaxOrderPct: 10,
  normalMaxOrderPct: 7.5,
  stormMaxOrderPct: 5,
  unknownMaxOrderPct: 5,
});

const garch = buildVolatilitySentinel({
  symbol: 'IOST', now,
  garch: {
    available: true, regime: 'normal', forecastVolDailyPct: 3,
    forecastVolAnnualizedPct: 57.31, observedAt: now - 1_000,
  },
});
assert.equal(garch.available, true);
assert.equal(garch.fresh, true);
assert.equal(garch.source, 'garch-1d');
assert.equal(garch.regime, 'normal');
assert.equal(garch.dynamicMaxOrderPct, 7.5);
assert.equal(garch.evidenceAgeMs, 1_000);

const rangeMarket = (high, low, ageMs = 200) => ({
  quoteIntegrity: {
    venues: [
      { source: 'OKX', high24h: high, low24h: low, ageMs },
      { source: 'Gate', high24h: high * 1.001, low24h: low * 0.999, ageMs: ageMs + 20 },
    ],
  },
});

const calm = buildVolatilitySentinel({ symbol: 'IOST', market: rangeMarket(101, 99), now });
assert.equal(calm.source, 'trusted-venue-24h-range');
assert.equal(calm.regime, 'calm');
assert.equal(calm.quality, 'high');
assert.equal(calm.venueCount, 2);
assert.equal(calm.dynamicMaxOrderPct, 10);

const normal = buildVolatilitySentinel({ symbol: 'IOST', market: rangeMarket(103, 97), now });
assert.equal(normal.regime, 'normal');
assert.equal(normal.dynamicMaxOrderPct, 7.5);

const storm = buildVolatilitySentinel({ symbol: 'IOST', market: rangeMarket(105, 95), now });
assert.equal(storm.regime, 'storm');
assert.equal(storm.dynamicMaxOrderPct, 5);

const stockStorm = buildVolatilitySentinel({ symbol: 'AAPL', market: rangeMarket(103, 97), now });
assert.equal(stockStorm.regime, 'storm', 'stock thresholds must be more conservative than crypto');

const staleGarchFallsBack = buildVolatilitySentinel({
  symbol: 'IOST', now, market: rangeMarket(103, 97),
  garch: { available: true, regime: 'calm', forecastVolDailyPct: 1,
    forecastVolAnnualizedPct: 19, observedAt: now - (7 * 60 * 60 * 1_000) },
});
assert.equal(staleGarchFallsBack.source, 'trusted-venue-24h-range');
assert.equal(staleGarchFallsBack.regime, 'normal');

const unknown = buildVolatilitySentinel({ symbol: 'IOST', market: rangeMarket(103, 97, 10_001), now });
assert.equal(unknown.available, false);
assert.equal(unknown.fresh, false);
assert.equal(unknown.regime, 'unknown');
assert.equal(unknown.reasonCode, 'volatility-evidence-unavailable');
assert.equal(unknown.dynamicMaxOrderPct, 5);
assert.equal(unknown.authorization.liveScopeUsed, false);
assert.equal(unknown.execution.attempted, false);

console.log('volatility sentinel checks passed');
