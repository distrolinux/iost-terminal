import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateAgentStrategy, promotionPolicy, verifyEvaluationEvidence } from '../lib/evaluation.js';

function candles(count = 260, mutateFuture = false) {
  const out = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = i % 28 < 20 ? 0.55 : -0.35;
    const open = price;
    price = Math.max(1, price + drift + Math.sin(i / 3) * 0.18);
    out.push({ ts: 1_700_000_000_000 + i * 86_400_000, o: open, h: Math.max(open, price) + 0.35,
      l: Math.min(open, price) - 0.35, c: price, v: 1000 + i * 3 });
  }
  if (mutateFuture) for (let i = 220; i < out.length; i++) out[i] = { ...out[i], o: out[i].o * 4, h: out[i].h * 4, l: out[i].l * 4, c: out[i].c * 4 };
  return out;
}

const strategy = { name: 'regression-breakout', side: 'long', sizePct: 0.5,
  entry: { rule: 'breakout', params: { lookback: 8 } }, exit: { stopPct: 0.025, targetPct: 0.05, maxBars: 12 } };
const config = { trainBars: 80, testBars: 40, stepBars: 40, minimumTrades: 1,
  costs: { feeBps: 10, spreadBps: 8, slippageBps: 6 } };

const base = evaluateAgentStrategy({ symbol: 'IOST', timeframe: '1d', strategy, candles: candles(), config });
assert.equal(base.ok, true);
assert.equal(base.mode, 'paper-only');
assert.equal(base.methodology.execution, 'next-bar-open');
assert.ok(base.folds.length >= 4);
assert.ok(base.folds.every((f) => f.train.toIndex < f.test.fromIndex));
assert.ok(base.trades.every((t) => t.signalIndex < t.entryIndex));
assert.ok(base.trades.every((t) => t.totalCosts > 0));
assert.ok(Number.isFinite(base.metrics.winRatePct));
assert.ok(Object.hasOwn(base.metrics, 'profitFactor'));
assert.ok(Number.isFinite(base.metrics.expectancy));
assert.ok(Number.isFinite(base.metrics.maxDrawdownPct));
assert.ok(Object.hasOwn(base.metrics, 'sharpeLike'));
assert.deepEqual(Object.keys(base.baselines).sort(), ['buyAndHold', 'cash', 'smaCross'].sort());
assert.ok(Number.isFinite(base.calibration.brierScore));
assert.ok(Number.isFinite(base.calibration.expectedCalibrationError));
assert.equal(base.promotion.scope, 'paper-strategy-candidate');
assert.equal(base.promotion.allowed, base.promotion.failures.length === 0);
assert.match(base.evidence.resultHash, /^[a-f0-9]{64}$/);
assert.equal(verifyEvaluationEvidence(base), true);
assert.ok(base.series.equity.length > 2);
assert.equal(base.series.equity.length, base.series.drawdown.length);
assert.deepEqual(Object.keys(base.series.baselines).sort(), ['buyAndHold', 'cash', 'smaCross'].sort());
assert.ok(base.series.equity.every((point, index, rows) => !index || point.index > rows[index - 1].index));

const changed = evaluateAgentStrategy({ symbol: 'IOST', timeframe: '1d', strategy, candles: candles(260, true), config });
assert.deepEqual(changed.folds[0], base.folds[0]);
assert.deepEqual(changed.trades.filter((t) => t.fold === 1), base.trades.filter((t) => t.fold === 1));
assert.equal(verifyEvaluationEvidence({ ...base, metrics: { ...base.metrics, trades: base.metrics.trades + 1 } }), false);

const tooSmall = evaluateAgentStrategy({ symbol: 'IOST', timeframe: '1d', strategy, candles: candles(100), config });
assert.equal(tooSmall.ok, false);
assert.equal(tooSmall.promotion.allowed, false);
const invalidSize = evaluateAgentStrategy({ symbol: 'IOST', timeframe: '1d', strategy: { ...strategy, sizePct: 'NaN' }, candles: candles(), config });
assert.equal(invalidSize.ok, false);
assert.equal(invalidSize.promotion.allowed, false);
const invalidSymbol = evaluateAgentStrategy({ symbol: '=IMPORTXML()', timeframe: '1d', strategy, candles: candles(), config });
assert.equal(invalidSymbol.ok, false);
assert.equal(invalidSymbol.promotion.allowed, false);

const gate = promotionPolicy({ metrics: { trades: 200, maxDrawdownPct: 5, sharpeLike: 2, cumulativeReturnPct: 20 },
  baselines: { buyAndHold: { returnPct: 2 }, smaCross: { returnPct: 1 } },
  calibration: { observations: 200, brierScore: 0.1, expectedCalibrationError: 0.05 }, folds: [{}, {}, {}], warnings: [], audit: { ok: true } });
assert.equal(gate.allowed, true);
assert.equal(gate.scope, 'paper-strategy-candidate');

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const route = server.slice(server.indexOf("app.post('/api/evaluation-lab'"), server.indexOf("// status endpoint", server.indexOf("app.post('/api/evaluation-lab'")));
assert.match(route, /requireUser/);
assert.match(route, /getKlines/);
assert.doesNotMatch(route, /enableLive|deploy|conversion|phase4|writeFile|appendFile|public-chain/);
assert.match(server, /evaluation\.run/);

console.log('Agent Evaluation Lab regression checks passed');
