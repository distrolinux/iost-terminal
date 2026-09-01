import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strategyPromotionPolicy, STRATEGY_PROMOTION_WEIGHTS } from '../lib/strategy-promotion.js';

const strong = {
  audit: { ok: true },
  metrics: { trades: 120, maxDrawdownPct: 4, sharpeLike: 1.8, cumulativeReturnPct: 18, expectancyPct: 0.25 },
  folds: [2.1, 2.2, 2.3, 2.4, 2.5].map((returnPct, index) => ({ id: index + 1, result: { returnPct } })),
  baselines: { buyAndHold: { returnPct: 5 }, smaCross: { returnPct: 3 }, cash: { returnPct: 0 } },
  calibration: { observations: 120, brierScore: 0.08, expectedCalibrationError: 0.04 },
};

const promoted = strategyPromotionPolicy(strong);
assert.equal(promoted.allowed, true);
assert.equal(promoted.decision, 'ELIGIBLE_FOR_PAPER_REVIEW');
assert.equal(promoted.scorecard.lifecycle.targetStage, 'PAPER_REVIEW');
assert.equal(promoted.scorecard.lifecycle.action, 'PROMOTE_TO_PAPER_REVIEW');
assert.equal(promoted.scorecard.lifecycle.applied, false);
assert.equal(promoted.scorecard.lifecycle.ownerReviewRequired, true);
assert.equal(promoted.scorecard.lifecycle.executionPermissionsChanged, false);
assert(promoted.scorecard.score >= 75 && promoted.scorecard.score <= 100);
assert.equal(Object.values(STRATEGY_PROMOTION_WEIGHTS).reduce((sum, value) => sum + value, 0), 100);
assert.deepEqual(Object.keys(promoted.scorecard.components).sort(), Object.keys(STRATEGY_PROMOTION_WEIGHTS).sort());
assert.equal(promoted.scorecard.robustness.overfitRiskProxy, 'low');
assert.equal(promoted.failures.length, 0);

const sparse = strategyPromotionPolicy({
  ...strong,
  metrics: { ...strong.metrics, trades: 8 },
  folds: strong.folds.slice(0, 2),
  calibration: { ...strong.calibration, observations: 8 },
});
assert.equal(sparse.allowed, false);
assert(sparse.failures.includes('insufficient-out-of-sample-trades'));
assert(sparse.failures.includes('insufficient-walk-forward-folds'));
assert.notEqual(sparse.scorecard.lifecycle.targetStage, 'PAPER_REVIEW');

const degraded = strategyPromotionPolicy({
  ...strong,
  metrics: { ...strong.metrics, maxDrawdownPct: 42, sharpeLike: -0.5, cumulativeReturnPct: -12, expectancyPct: -0.3 },
  folds: [-8, -3, 1, -5].map((returnPct, index) => ({ id: index + 1, result: { returnPct } })),
  calibration: { observations: 120, brierScore: 0.4, expectedCalibrationError: 0.3 },
});
assert.equal(degraded.allowed, false);
assert.equal(degraded.scorecard.lifecycle.targetStage, 'PAUSED');
assert.equal(degraded.scorecard.lifecycle.action, 'PAUSE_AND_DEMOTE');
assert.equal(degraded.scorecard.robustness.overfitRiskProxy, 'high');

const weakened = strategyPromotionPolicy(strong, { minimumTrades: 1, minimumFolds: 1, maximumDrawdownPct: 99 });
assert.equal(weakened.thresholds.minimumTrades, 30, 'client policy cannot weaken evidence floor');
assert.equal(weakened.thresholds.minimumFolds, 3);
assert.equal(weakened.thresholds.maximumDrawdownPct, 20);

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
assert.match(server, /const DISCOVERY_VERSION = '1\.33\.0'/);
assert.match(server, /app\.get\('\/api\/strategy-governance', requireUser/);
assert.match(server, /case 'strategy_promotion_scorecards'/);
assert.match(protocol, /readTool\('strategy_promotion_scorecards'/);
assert.doesNotMatch(protocol.match(/readTool\('strategy_promotion_scorecards'[\s\S]{0,500}/)?.[0] || '', /mutationTool|trade-live|public-chain writes/);

console.log('Strategy Promotion Engine checks passed');
