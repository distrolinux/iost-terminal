// Pure, server-authoritative portfolio risk decision. No I/O or mutation.

export const PORTFOLIO_RISK_POLICY = Object.freeze({
  maxOrderPct: 10,
  maxGrossExposurePct: 80,
  maxSymbolExposurePct: 25,
  maxCorrelatedExposurePct: 50,
  maxDrawdownPct: 10,
  maxDailyRealizedLossPct: 3,
  maxRiskAtStopPct: 1,
  maxOpenPositions: 10,
  normalMaxOrderPct: 7.5,
  stormMaxOrderPct: 5,
  unknownMaxOrderPct: 5,
});

const CRYPTO = new Set(['IOST', 'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'SUI', 'ARB', 'OP', 'TON', 'NEAR', 'LTC']);
const MEGA_TECH = new Set(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META']);
const INDEX = new Set(['SPY', 'QQQ']);
const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, places = 2) => {
  const number = finite(value);
  if (number == null) return null;
  const power = 10 ** places;
  return Math.round((number + Number.EPSILON) * power) / power;
};
const groupFor = (symbol) => CRYPTO.has(symbol) ? 'crypto'
  : MEGA_TECH.has(symbol) ? 'mega-tech'
    : INDEX.has(symbol) ? 'index' : `asset:${symbol}`;

function positionValue(position) {
  const entry = finite(position?.entry);
  const last = finite(position?.lastPrice) ?? entry;
  const size = finite(position?.size);
  if (!(last > 0) || !(size > 0)) return Math.max(0, finite(position?.notional) || 0);
  return last * size;
}

function currentEquity(account, positions) {
  const cash = Math.max(0, finite(account?.cash) || 0);
  let value = 0;
  for (const position of positions) {
    const marketValue = positionValue(position);
    const entryNotional = (finite(position?.entry) || 0) * (finite(position?.size) || 0);
    const pnl = position?.side === 'short' ? entryNotional - marketValue : marketValue - entryNotional;
    value += Math.max(0, (finite(position?.notional) || entryNotional) + pnl);
  }
  return cash + value;
}

function drawdownEvidence(initialCash, equity, journal) {
  let running = initialCash;
  let peak = initialCash;
  for (const trade of [...journal].filter((row) => row?.status === 'closed')
    .sort((a, b) => Number(a.closedAt || 0) - Number(b.closedAt || 0))) {
    running += finite(trade?.pnl) || 0;
    peak = Math.max(peak, running);
  }
  peak = Math.max(peak, equity);
  const drawdown = Math.max(0, peak - equity);
  return { peak, drawdown, drawdownPct: peak > 0 ? drawdown / peak * 100 : null };
}

function dailyRealizedLoss(initialCash, journal, now) {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const pnl = journal.filter((row) => row?.status === 'closed'
      && Number(row.closedAt) >= dayStart.getTime() && Number(row.closedAt) <= now)
    .reduce((sum, row) => sum + (finite(row?.pnl) || 0), 0);
  const loss = Math.max(0, -pnl);
  return { pnl, loss, lossPct: initialCash > 0 ? loss / initialCash * 100 : null };
}

export function buildPortfolioRiskDecision({
  account = {}, positions = [], journal = [], order = {}, fillPrice = null,
  requireProtectiveStop = false, volatility = null, now = Date.now(), policy = {},
} = {}) {
  const limits = { ...PORTFOLIO_RISK_POLICY, ...policy };
  const initialCash = finite(account?.initialCash);
  const equity = currentEquity(account, positions);
  const price = finite(fillPrice);
  const size = finite(order?.size);
  const stop = finite(order?.stop);
  const symbol = String(order?.symbol || '').trim().toUpperCase();
  const side = order?.side === 'short' ? 'short' : 'long';
  const orderNotional = price > 0 && size > 0 ? price * size : null;
  const currentGross = positions.reduce((sum, position) => sum + positionValue(position), 0);
  const symbolGross = positions.filter((position) => String(position?.symbol || '').toUpperCase() === symbol)
    .reduce((sum, position) => sum + positionValue(position), 0);
  const group = groupFor(symbol);
  // Correlated sleeve risk is gross, not net: opposite directions can both
  // lose during dislocated markets and must not cancel each other here.
  const correlatedGross = positions.filter((position) => groupFor(String(position?.symbol || '').toUpperCase()) === group)
    .reduce((sum, position) => sum + positionValue(position), 0);
  const projectedCorrelated = correlatedGross + (orderNotional || 0);
  const drawdown = drawdownEvidence(initialCash || 0, equity, journal);
  const daily = dailyRealizedLoss(initialCash || 0, journal, now);
  const orderPct = equity > 0 && orderNotional != null ? orderNotional / equity * 100 : null;
  const protectiveStopValid = stop > 0 && price > 0
    && (side === 'short' ? stop > price : stop < price);
  const riskAtStop = protectiveStopValid && size > 0 ? Math.abs(price - stop) * size : null;
  const riskAtStopPct = equity > 0 && riskAtStop != null ? riskAtStop / equity * 100 : null;
  const volatilityAvailable = volatility?.available === true || Number.isFinite(Number(volatility?.forecastVolAnnualizedPct));
  const volatilityRegime = ['calm', 'normal', 'storm', 'unknown'].includes(volatility?.regime) ? volatility.regime : null;
  const fallbackVolatilityCap = volatilityRegime === 'storm' ? limits.stormMaxOrderPct
    : volatilityRegime === 'normal' ? limits.normalMaxOrderPct
      : volatilityRegime === 'unknown' ? limits.unknownMaxOrderPct : limits.maxOrderPct;
  const dynamicMaxOrderPct = volatility
    ? Math.min(limits.maxOrderPct, finite(volatility?.dynamicMaxOrderPct) ?? fallbackVolatilityCap)
    : limits.maxOrderPct;

  const metrics = {
    initialCashUsd: round(initialCash), currentEquityUsd: round(equity), currentCashUsd: round(account?.cash),
    orderNotionalUsd: round(orderNotional), orderPct: round(orderPct),
    currentGrossExposureUsd: round(currentGross), projectedGrossExposurePct: round(equity > 0 ? (currentGross + (orderNotional || 0)) / equity * 100 : null),
    projectedSymbolExposurePct: round(equity > 0 ? (symbolGross + (orderNotional || 0)) / equity * 100 : null),
    correlatedGroup: group, projectedCorrelatedExposurePct: round(equity > 0 ? projectedCorrelated / equity * 100 : null),
    openPositions: positions.length, projectedOpenPositions: positions.length + 1,
    peakEquityUsd: round(drawdown.peak), drawdownUsd: round(drawdown.drawdown), drawdownPct: round(drawdown.drawdownPct),
    dailyRealizedPnlUsd: round(daily.pnl), dailyRealizedLossUsd: round(daily.loss), dailyRealizedLossPct: round(daily.lossPct),
    protectiveStopRequired: requireProtectiveStop === true, protectiveStopPresent: stop > 0,
    protectiveStopValid,
    riskAtStopUsd: round(riskAtStop), riskAtStopPct: round(riskAtStopPct),
    volatilityAvailable, volatilityFresh: volatility?.fresh === true,
    volatilitySource: String(volatility?.source || '').slice(0, 80) || null,
    volatilityQuality: String(volatility?.quality || '').slice(0, 24) || null,
    volatilityRegime, volatilityEvidenceAgeMs: finite(volatility?.evidenceAgeMs),
    volatilityVenueCount: Number.isSafeInteger(Number(volatility?.venueCount)) ? Number(volatility.venueCount) : 0,
    dynamicMaxOrderPct: round(dynamicMaxOrderPct),
    forecastVolAnnualizedPct: round(volatility?.forecastVolAnnualizedPct),
  };
  const checks = [
    { code: 'portfolio-equity-valid', pass: initialCash > 0 && equity > 0 },
    { code: 'protective-stop-required', pass: !requireProtectiveStop || protectiveStopValid },
    { code: 'risk-at-stop-limit', pass: stop == null || (protectiveStopValid && riskAtStopPct != null && riskAtStopPct <= limits.maxRiskAtStopPct) },
    { code: 'drawdown-circuit-breaker', pass: drawdown.drawdownPct != null && drawdown.drawdownPct <= limits.maxDrawdownPct },
    { code: 'daily-loss-circuit-breaker', pass: daily.lossPct != null && daily.lossPct <= limits.maxDailyRealizedLossPct },
    { code: 'open-position-limit', pass: positions.length + 1 <= limits.maxOpenPositions },
    { code: 'order-notional-limit', pass: orderPct != null && orderPct <= limits.maxOrderPct },
    { code: 'volatility-order-limit', pass: orderPct != null && orderPct <= dynamicMaxOrderPct },
    { code: 'gross-exposure-limit', pass: metrics.projectedGrossExposurePct != null && metrics.projectedGrossExposurePct <= limits.maxGrossExposurePct },
    { code: 'symbol-exposure-limit', pass: metrics.projectedSymbolExposurePct != null && metrics.projectedSymbolExposurePct <= limits.maxSymbolExposurePct },
    { code: 'correlated-exposure-limit', pass: metrics.projectedCorrelatedExposurePct != null && metrics.projectedCorrelatedExposurePct <= limits.maxCorrelatedExposurePct },
  ];
  const failure = checks.find((check) => !check.pass);
  const stopDistancePct = protectiveStopValid && price > 0 ? Math.abs(price - stop) / price : null;
  const headroom = equity > 0 ? [
    { code: 'cash-available', usd: Math.max(0, finite(account?.cash) || 0) },
    { code: 'order-notional-limit', usd: equity * limits.maxOrderPct / 100 },
    { code: `volatility-${volatilityRegime || 'legacy'}-limit`, usd: equity * dynamicMaxOrderPct / 100 },
    { code: 'gross-exposure-limit', usd: Math.max(0, equity * limits.maxGrossExposurePct / 100 - currentGross) },
    { code: 'symbol-exposure-limit', usd: Math.max(0, equity * limits.maxSymbolExposurePct / 100 - symbolGross) },
    { code: 'correlated-exposure-limit', usd: Math.max(0, equity * limits.maxCorrelatedExposurePct / 100 - correlatedGross) },
    ...(stopDistancePct > 0 ? [{ code: 'risk-at-stop-limit', usd: equity * limits.maxRiskAtStopPct / 100 / stopDistancePct }] : []),
    ...(positions.length >= limits.maxOpenPositions ? [{ code: 'open-position-limit', usd: 0 }] : []),
    ...(drawdown.drawdownPct > limits.maxDrawdownPct ? [{ code: 'drawdown-circuit-breaker', usd: 0 }] : []),
    ...(daily.lossPct > limits.maxDailyRealizedLossPct ? [{ code: 'daily-loss-circuit-breaker', usd: 0 }] : []),
    ...(requireProtectiveStop && !protectiveStopValid ? [{ code: 'protective-stop-required', usd: 0 }] : []),
  ] : [];
  const maximumNewOrderUsd = headroom.length ? Math.max(0, Math.min(...headroom.map((row) => row.usd))) : 0;
  const capacity = {
    available: maximumNewOrderUsd > 0 && !['drawdown-circuit-breaker', 'daily-loss-circuit-breaker', 'open-position-limit', 'protective-stop-required'].includes(failure?.code),
    maximumNewOrderUsd: round(maximumNewOrderUsd),
    maximumNewOrderPct: round(equity > 0 ? maximumNewOrderUsd / equity * 100 : null),
    limitingFactors: headroom.filter((row) => Math.abs(row.usd - maximumNewOrderUsd) < 0.01).map((row) => row.code),
    headroomUsd: Object.fromEntries(headroom.map((row) => [row.code, round(row.usd)])),
  };
  const volatilityEvidence = volatility ? {
    available: volatilityAvailable,
    fresh: volatility?.fresh === true,
    source: String(volatility?.source || '').slice(0, 80) || null,
    quality: String(volatility?.quality || '').slice(0, 24) || null,
    reasonCode: String(volatility?.reasonCode || '').slice(0, 120) || null,
    regime: volatilityRegime,
    forecastVolDailyPct: round(volatility?.forecastVolDailyPct),
    forecastVolAnnualizedPct: round(volatility?.forecastVolAnnualizedPct),
    evidenceAgeMs: finite(volatility?.evidenceAgeMs),
    venueCount: Number.isSafeInteger(Number(volatility?.venueCount)) ? Number(volatility.venueCount) : 0,
    dynamicMaxOrderPct: round(dynamicMaxOrderPct),
    policy: volatility?.policy || null,
  } : null;
  return {
    ok: true,
    mode: 'paper-only',
    readOnly: true,
    decision: failure ? 'deny' : 'allow',
    reasonCode: failure?.code || 'portfolio-risk-passed',
    checkedAt: Math.trunc(now),
    policy: limits,
    metrics,
    checks,
    capacity,
    volatility: volatilityEvidence,
    authorization: { liveScopeUsed: false, publicChainUsed: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
  };
}
