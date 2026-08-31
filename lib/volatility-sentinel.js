// Pure, network-free volatility evidence selector for execution preflight.
// Prefer a recent cached GARCH forecast; otherwise derive a Parkinson range
// proxy from the same trusted venue quotes already collected for execution.

export const VOLATILITY_SENTINEL_POLICY = Object.freeze({
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

const STOCKS = new Set(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'SPY', 'QQQ']);
const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, places = 2) => {
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

function regimeFor(symbol, dailyPct, policy) {
  const stock = STOCKS.has(symbol);
  const calmMax = stock ? policy.stockCalmMaxDailyPct : policy.cryptoCalmMaxDailyPct;
  const stormMin = stock ? policy.stockStormMinDailyPct : policy.cryptoStormMinDailyPct;
  return dailyPct < calmMax ? 'calm' : dailyPct >= stormMin ? 'storm' : 'normal';
}

function capFor(regime, policy) {
  if (regime === 'calm') return policy.calmMaxOrderPct;
  if (regime === 'normal') return policy.normalMaxOrderPct;
  if (regime === 'storm') return policy.stormMaxOrderPct;
  return policy.unknownMaxOrderPct;
}

function baseResult(symbol, now, policy) {
  return {
    ok: true, mode: 'paper-only', readOnly: true, symbol,
    checkedAt: Math.trunc(now), policy,
    authorization: { liveScopeUsed: false, publicChainUsed: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
  };
}

export function buildVolatilitySentinel({
  symbol = '', garch = null, market = null, now = Date.now(), policy = {},
} = {}) {
  const sym = String(symbol || '').trim().toUpperCase().slice(0, 24);
  const limits = { ...VOLATILITY_SENTINEL_POLICY, ...policy };
  const base = baseResult(sym, now, limits);
  const garchDaily = finite(garch?.forecastVolDailyPct);
  const garchAnnual = finite(garch?.forecastVolAnnualizedPct);
  const garchObservedAt = Number.isSafeInteger(Number(garch?.observedAt)) ? Number(garch.observedAt) : null;
  const garchAgeMs = garchObservedAt == null ? null : Math.max(0, Math.trunc(now - garchObservedAt));
  const garchRegime = ['calm', 'normal', 'storm'].includes(garch?.regime) ? garch.regime : null;
  if (garchRegime && garchAnnual > 0 && garchAgeMs != null && garchAgeMs <= limits.garchMaxAgeMs) {
    return {
      ...base, available: true, fresh: true, source: 'garch-1d', quality: 'model',
      reasonCode: 'garch-evidence-fresh', regime: garchRegime,
      forecastVolDailyPct: round(garchDaily), forecastVolAnnualizedPct: round(garchAnnual),
      evidenceAgeMs: garchAgeMs, venueCount: 0,
      dynamicMaxOrderPct: capFor(garchRegime, limits),
    };
  }

  const ranges = (market?.quoteIntegrity?.venues || []).flatMap((venue) => {
    const high = finite(venue?.high24h);
    const low = finite(venue?.low24h);
    const ageMs = finite(venue?.ageMs);
    if (!(high > 0) || !(low > 0) || high < low || ageMs == null || ageMs > limits.rangeMaxAgeMs) return [];
    const dailyPct = Math.log(high / low) / Math.sqrt(4 * Math.log(2)) * 100;
    return Number.isFinite(dailyPct) ? [{ source: String(venue?.source || 'unknown').slice(0, 80), dailyPct, ageMs }] : [];
  });
  if (ranges.length) {
    const dailyPct = median(ranges.map((row) => row.dailyPct));
    const annualizationDays = STOCKS.has(sym) ? 252 : 365;
    const regime = regimeFor(sym, dailyPct, limits);
    return {
      ...base, available: true, fresh: true,
      source: 'trusted-venue-24h-range', quality: ranges.length >= 2 ? 'high' : 'medium',
      reasonCode: 'range-evidence-fresh', regime,
      forecastVolDailyPct: round(dailyPct),
      forecastVolAnnualizedPct: round(dailyPct * Math.sqrt(annualizationDays)),
      evidenceAgeMs: Math.max(...ranges.map((row) => row.ageMs)),
      venueCount: ranges.length,
      dynamicMaxOrderPct: capFor(regime, limits),
    };
  }

  return {
    ...base, available: false, fresh: false,
    source: 'conservative-unknown', quality: 'unavailable',
    reasonCode: 'volatility-evidence-unavailable', regime: 'unknown',
    forecastVolDailyPct: null, forecastVolAnnualizedPct: null,
    evidenceAgeMs: null, venueCount: 0,
    dynamicMaxOrderPct: limits.unknownMaxOrderPct,
  };
}
