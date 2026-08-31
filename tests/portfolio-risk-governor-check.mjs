import assert from 'node:assert/strict';
import {
  buildPortfolioRiskDecision,
  PORTFOLIO_RISK_POLICY,
} from '../lib/portfolio-risk-governor.js';

const now = Date.UTC(2026, 7, 31, 15);
const account = { initialCash: 100_000, cash: 95_000 };
const position = (symbol, notional, side = 'long', entry = 100, lastPrice = 100) => ({
  symbol, notional, side, entry, lastPrice, size: notional / entry,
});
const order = { symbol: 'IOST', side: 'long', size: 1_000, stop: 0.9 };

assert.deepEqual(PORTFOLIO_RISK_POLICY, {
  maxOrderPct: 10,
  maxGrossExposurePct: 80,
  maxSymbolExposurePct: 25,
  maxCorrelatedExposurePct: 50,
  maxDrawdownPct: 10,
  maxDailyRealizedLossPct: 3,
  maxRiskAtStopPct: 1,
  maxOpenPositions: 10,
  stormMaxOrderPct: 5,
});

const allowed = buildPortfolioRiskDecision({
  account, positions: [position('BTC', 5_000)], journal: [], order,
  fillPrice: 1, requireProtectiveStop: true, now,
  volatility: { available: true, regime: 'normal', forecastVolAnnualizedPct: 45 },
});
assert.equal(allowed.decision, 'allow');
assert.equal(allowed.reasonCode, 'portfolio-risk-passed');
assert.equal(allowed.metrics.currentEquityUsd, 100_000);
assert.equal(allowed.metrics.projectedGrossExposurePct, 6);
assert.equal(allowed.metrics.projectedSymbolExposurePct, 1);
assert.equal(allowed.metrics.riskAtStopPct, 0.1);
assert.equal(allowed.authorization.liveScopeUsed, false);
assert.equal(allowed.execution.attempted, false);

const noStop = buildPortfolioRiskDecision({
  account, positions: [], journal: [], order: { ...order, stop: null },
  fillPrice: 1, requireProtectiveStop: true, now,
});
assert.equal(noStop.decision, 'deny');
assert.equal(noStop.reasonCode, 'protective-stop-required');

const wrongSideStop = buildPortfolioRiskDecision({
  account, positions: [], journal: [], order: { ...order, stop: 1.1 },
  fillPrice: 1, requireProtectiveStop: true, now,
});
assert.equal(wrongSideStop.decision, 'deny');
assert.equal(wrongSideStop.reasonCode, 'protective-stop-required');

const stopRisk = buildPortfolioRiskDecision({
  account, positions: [], journal: [], order: { ...order, size: 20_000, stop: 0.9 },
  fillPrice: 1, requireProtectiveStop: true, now,
  policy: { maxOrderPct: 100 },
});
assert.equal(stopRisk.reasonCode, 'risk-at-stop-limit');

const concentration = buildPortfolioRiskDecision({
  account: { initialCash: 100_000, cash: 80_000 },
  positions: [position('IOST', 20_000, 'long', 1, 1)], journal: [],
  order: { ...order, size: 10_000 }, fillPrice: 1, now,
  policy: { maxOrderPct: 100 },
});
assert.equal(concentration.reasonCode, 'symbol-exposure-limit');

const correlation = buildPortfolioRiskDecision({
  account: { initialCash: 100_000, cash: 60_000 },
  positions: [position('BTC', 40_000, 'short')], journal: [],
  order: { ...order, size: 15_000 }, fillPrice: 1, now,
  policy: { maxOrderPct: 100, maxSymbolExposurePct: 100, maxRiskAtStopPct: 100 },
});
assert.equal(correlation.reasonCode, 'correlated-exposure-limit');

const gross = buildPortfolioRiskDecision({
  account: { initialCash: 100_000, cash: 30_000 },
  positions: [position('AAPL', 35_000), position('BTC', 35_000)], journal: [],
  order: { symbol: 'SPY', side: 'long', size: 15_000, stop: null }, fillPrice: 1, now,
  policy: { maxOrderPct: 100, maxSymbolExposurePct: 100, maxCorrelatedExposurePct: 100 },
});
assert.equal(gross.reasonCode, 'gross-exposure-limit');

const drawdown = buildPortfolioRiskDecision({
  account: { initialCash: 100_000, cash: 89_000 }, positions: [], journal: [],
  order, fillPrice: 1, now,
});
assert.equal(drawdown.reasonCode, 'drawdown-circuit-breaker');

const dailyLoss = buildPortfolioRiskDecision({
  account, positions: [position('BTC', 5_000)],
  journal: [{ status: 'closed', closedAt: now - 1_000, pnl: -3_500 }],
  order, fillPrice: 1, now,
});
assert.equal(dailyLoss.reasonCode, 'daily-loss-circuit-breaker');

const storm = buildPortfolioRiskDecision({
  account, positions: [position('BTC', 5_000)], journal: [],
  order: { ...order, size: 6_000, stop: null }, fillPrice: 1, now,
  volatility: { available: true, regime: 'storm', forecastVolAnnualizedPct: 110 },
});
assert.equal(storm.reasonCode, 'volatility-order-limit');

console.log('portfolio risk governor checks passed');
