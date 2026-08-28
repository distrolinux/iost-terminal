// Agent Evaluation Lab — deterministic, paper-only walk-forward evidence.
// Signals see bars through index i; fills occur at i+1 open. Strategy parameters
// are frozen before folds are created and are never optimized on test data.
import crypto from 'node:crypto';
import { aiProxyScore, entrySignal, STARTING_EQUITY } from './backtest.js';
import { sma } from './indicators.js';

const round = (n, p = 2) => Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 10 ** p) / 10 ** p : null;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const stableStringify = (v) => Array.isArray(v) ? `[${v.map(stableStringify).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}` : JSON.stringify(v);
export const evidenceHash = (v) => crypto.createHash('sha256').update(stableStringify(v)).digest('hex');

const DEFAULTS = Object.freeze({ trainBars: 120, testBars: 40, stepBars: 40, minimumTrades: 30,
  costs: { feeBps: 10, spreadBps: 8, slippageBps: 5 } });

function normalizeConfig(config = {}) {
  const costs = { ...DEFAULTS.costs, ...(config.costs || {}) };
  for (const [key, value] of Object.entries(costs)) {
    if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 500) throw new Error(`${key} must be between 0 and 500 bps`);
    costs[key] = Number(value);
  }
  const integer = (key, fallback, min) => {
    const n = Number(config[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > 5000) throw new Error(`${key} must be an integer between ${min} and 5000`);
    return n;
  };
  return { trainBars: integer('trainBars', DEFAULTS.trainBars, 40), testBars: integer('testBars', DEFAULTS.testBars, 10),
    stepBars: integer('stepBars', DEFAULTS.stepBars, 10), minimumTrades: integer('minimumTrades', DEFAULTS.minimumTrades, 1), costs };
}

function validateCandles(candles) {
  if (!Array.isArray(candles)) throw new Error('candles required');
  return candles.map((bar, i) => {
    const row = { ts: Number(bar.ts), o: Number(bar.o), h: Number(bar.h), l: Number(bar.l), c: Number(bar.c), v: Number(bar.v || 0) };
    if (![row.ts, row.o, row.h, row.l, row.c, row.v].every(Number.isFinite) || row.o <= 0 || row.h <= 0 || row.l <= 0 || row.c <= 0
      || row.h < Math.max(row.o, row.c) || row.l > Math.min(row.o, row.c) || (i && row.ts <= Number(candles[i - 1].ts))) {
      throw new Error(`invalid candle at index ${i}`);
    }
    return Object.freeze(row);
  });
}

function validateStrategy(strategy) {
  const allowedRules = new Set(['ma-cross', 'rsi', 'breakout', 'ai-score']);
  if (!strategy || !allowedRules.has(strategy.entry?.rule)) throw new Error('unsupported strategy entry rule');
  const sizePct = Number(strategy.sizePct ?? 0.5);
  if (!Number.isFinite(sizePct) || sizePct < 0.05 || sizePct > 1) throw new Error('strategy.sizePct must be between 0.05 and 1');
  for (const key of ['stopPct', 'targetPct', 'trailingPct']) {
    if (strategy.exit?.[key] != null && (!Number.isFinite(Number(strategy.exit[key])) || Number(strategy.exit[key]) <= 0 || Number(strategy.exit[key]) > 1)) {
      throw new Error(`strategy.exit.${key} must be between 0 and 1`);
    }
  }
  if (strategy.exit?.maxBars != null && (!Number.isInteger(Number(strategy.exit.maxBars)) || Number(strategy.exit.maxBars) < 1 || Number(strategy.exit.maxBars) > 5000)) {
    throw new Error('strategy.exit.maxBars must be an integer between 1 and 5000');
  }
}

function adverseFill(price, side, action, costs) {
  const direction = (side === 'long') === (action === 'entry') ? 1 : -1;
  return price * (1 + direction * ((costs.spreadBps / 2 + costs.slippageBps) / 10_000));
}

function confidenceAt(strategy, i, candles) {
  if (strategy.entry.rule === 'ai-score') {
    const score = aiProxyScore(candles[i], candles.slice(0, i + 1).map((b) => b.c), candles.slice(0, i + 1).map((b) => b.v));
    return clamp(score / 100, 0.01, 0.99);
  }
  return 0.55; // uncalibrated rule prior; reported and tested, never presented as certainty
}

function closeTrade(pos, rawExit, exitIndex, reason, equity, costs) {
  const exit = adverseFill(rawExit, pos.side, 'exit', costs);
  const exitFee = exit * pos.size * costs.feeBps / 10_000;
  const grossPnl = (exit - pos.entry) * pos.size * (pos.side === 'long' ? 1 : -1);
  const pnl = grossPnl - pos.entryFee - exitFee;
  return { trade: { ...pos.public, exitIndex, exitTs: pos.candles[exitIndex].ts, exit: round(exit, 6), reason,
    grossPnl: round(grossPnl), pnl: round(pnl), pnlPct: round(pnl / pos.notional * 100, 4),
    totalCosts: round(pos.entryFee + exitFee + Math.abs(pos.public.rawEntry - pos.entry) * pos.size + Math.abs(rawExit - exit) * pos.size) },
    equity: equity + pnl };
}

function runFold({ candles, strategy, fold, costs, startingEquity }) {
  const closes = candles.map((b) => b.c);
  const side = strategy.side === 'short' ? 'short' : 'long';
  const sizePct = clamp(Number(strategy.sizePct || 0.5), 0.05, 1);
  const exit = strategy.exit || {};
  let equity = startingEquity;
  let pos = null;
  const trades = [];
  const curve = [{ index: fold.test.fromIndex, equity }];
  for (let signalIndex = fold.test.fromIndex; signalIndex < fold.test.toIndex; signalIndex++) {
    const bar = candles[signalIndex];
    if (pos) {
      pos.peak = side === 'long' ? Math.max(pos.peak, bar.h) : Math.min(pos.peak, bar.l);
      let rawExit = null; let reason = null;
      const stopHit = exit.stopPct && (side === 'long' ? bar.l <= pos.stop : bar.h >= pos.stop);
      const targetHit = exit.targetPct && (side === 'long' ? bar.h >= pos.target : bar.l <= pos.target);
      if (stopHit) { rawExit = pos.stop; reason = targetHit ? 'stop-conservative-ambiguous-bar' : 'stop'; }
      else if (targetHit) { rawExit = pos.target; reason = 'target'; }
      else if (exit.maxBars && signalIndex - pos.entryIndex >= exit.maxBars) { rawExit = bar.c; reason = 'time'; }
      if (rawExit != null) {
        const closed = closeTrade(pos, rawExit, signalIndex, reason, equity, costs);
        equity = closed.equity; trades.push(closed.trade); pos = null;
      }
    }
    const markedEquity = pos ? equity + (bar.c - pos.entry) * pos.size * (side === 'long' ? 1 : -1) - pos.entryFee : equity;
    curve.push({ index: signalIndex, equity: markedEquity });
    if (!pos && signalIndex + 1 <= fold.test.toIndex) {
      const signal = entrySignal(strategy.entry, signalIndex, closes.slice(0, signalIndex + 1), candles.slice(0, signalIndex + 1));
      if (signal === side) {
        const entryIndex = signalIndex + 1;
        const rawEntry = candles[entryIndex].o;
        const entry = adverseFill(rawEntry, side, 'entry', costs);
        const notional = equity * sizePct;
        const size = notional / entry;
        const entryFee = entry * size * costs.feeBps / 10_000;
        pos = { side, entry, rawEntry, entryIndex, size, notional, entryFee, peak: entry, candles,
          stop: exit.stopPct ? entry * (side === 'long' ? 1 - exit.stopPct : 1 + exit.stopPct) : null,
          target: exit.targetPct ? entry * (side === 'long' ? 1 + exit.targetPct : 1 - exit.targetPct) : null,
          public: { fold: fold.id, signalIndex, signalTs: candles[signalIndex].ts, entryIndex, entryTs: candles[entryIndex].ts,
            side, rawEntry: round(rawEntry, 6), entry: round(entry, 6), size: round(size, 8), notional: round(notional),
            predictedConfidence: round(confidenceAt(strategy, signalIndex, candles), 4) } };
      }
    }
  }
  if (pos) {
    const i = fold.test.toIndex;
    const closed = closeTrade(pos, candles[i].c, i, 'fold-end', equity, costs);
    equity = closed.equity; trades.push(closed.trade);
  }
  curve.push({ index: fold.test.toIndex, equity });
  return { trades, curve, finalEquity: equity };
}

function metrics(trades, curve) {
  const wins = trades.filter((t) => t.pnl > 0); const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((n, t) => n + t.pnl, 0); const grossLoss = Math.abs(losses.reduce((n, t) => n + t.pnl, 0));
  const returns = trades.map((t) => t.pnl / t.notional);
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((a, n) => a + (n - mean) ** 2, 0) / (returns.length - 1) : 0;
  let peak = STARTING_EQUITY; let maxDrawdown = 0;
  for (const p of curve) { peak = Math.max(peak, p.equity); maxDrawdown = Math.max(maxDrawdown, peak ? (peak - p.equity) / peak : 1); }
  const finalEquity = curve.at(-1)?.equity ?? STARTING_EQUITY;
  return { trades: trades.length, wins: wins.length, losses: losses.length,
    winRatePct: round(trades.length ? wins.length / trades.length * 100 : 0, 1),
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : (grossProfit > 0 ? null : 0),
    expectancy: round(trades.length ? trades.reduce((n, t) => n + t.pnl, 0) / trades.length : 0),
    expectancyPct: round(mean * 100, 4), maxDrawdownPct: round(maxDrawdown * 100),
    sharpeLike: variance > 0 ? round(mean / Math.sqrt(variance) * Math.sqrt(returns.length)) : null,
    cumulativeReturnPct: round((finalEquity / STARTING_EQUITY - 1) * 100), finalEquity: round(finalEquity),
    totalCosts: round(trades.reduce((n, t) => n + t.totalCosts, 0)) };
}

function calibration(trades) {
  const observations = trades.map((t) => ({ p: t.predictedConfidence, y: t.pnl > 0 ? 1 : 0 }));
  const brier = observations.length ? observations.reduce((n, x) => n + (x.p - x.y) ** 2, 0) / observations.length : 1;
  const buckets = [];
  let ece = 0;
  for (let lo = 0; lo < 1; lo += 0.1) {
    const rows = observations.filter((x) => x.p >= lo && (lo >= 0.9 ? x.p <= 1 : x.p < lo + 0.1));
    if (!rows.length) continue;
    const predicted = rows.reduce((n, x) => n + x.p, 0) / rows.length;
    const observed = rows.reduce((n, x) => n + x.y, 0) / rows.length;
    ece += rows.length / observations.length * Math.abs(predicted - observed);
    buckets.push({ range: `${round(lo, 1)}-${round(lo + 0.1, 1)}`, count: rows.length, predicted: round(predicted, 3), observed: round(observed, 3) });
  }
  return { observations: observations.length, brierScore: round(brier, 4), expectedCalibrationError: round(ece, 4), buckets,
    note: 'Confidence is calibrated only against out-of-sample trade outcomes; sparse buckets are warnings, not proof.' };
}

function baselines(candles, folds, costs) {
  let buy = STARTING_EQUITY; let smaValue = STARTING_EQUITY; let priorExposure = false;
  const series = { buyAndHold: [], smaCross: [], cash: [] };
  const turnoverCost = (costs.feeBps + costs.spreadBps / 2 + costs.slippageBps) / 10_000;
  for (const fold of folds) {
    const start = fold.test.fromIndex; const end = fold.test.toIndex;
    const buyStart = buy;
    for (let i = start; i <= end; i++) {
      const marked = buyStart * candles[i].c / candles[start].o;
      const equity = i === end ? marked * (1 - turnoverCost * 2) : marked * (1 - turnoverCost);
      series.buyAndHold.push({ index: i, ts: candles[i].ts, equity: round(equity) });
    }
    buy = series.buyAndHold.at(-1).equity;
    for (let i = start; i < end; i++) {
      const fast = sma(candles.slice(0, i + 1).map((b) => b.c), 20);
      const slow = sma(candles.slice(0, i + 1).map((b) => b.c), 50);
      const exposure = fast != null && slow != null && fast > slow;
      if (exposure !== priorExposure) smaValue *= 1 - turnoverCost;
      if (exposure) smaValue *= candles[i + 1].c / candles[i].c;
      priorExposure = exposure;
      series.smaCross.push({ index: i + 1, ts: candles[i + 1].ts, equity: round(smaValue) });
      series.cash.push({ index: i + 1, ts: candles[i + 1].ts, equity: STARTING_EQUITY });
    }
  }
  if (priorExposure) smaValue *= 1 - turnoverCost;
  if (series.smaCross.length) series.smaCross.at(-1).equity = round(smaValue);
  return { summary: {
    buyAndHold: { returnPct: round((buy / STARTING_EQUITY - 1) * 100), description: 'long each out-of-sample fold, same modeled costs' },
    smaCross: { returnPct: round((smaValue / STARTING_EQUITY - 1) * 100), description: '20/50 SMA long-or-cash, causal observations, same modeled costs' },
    cash: { returnPct: 0, description: 'uninvested paper cash' },
  }, series };
}

function normalizeCurve(curve, candles) {
  const byIndex = new Map();
  for (const point of curve) byIndex.set(point.index, { index: point.index, ts: candles[point.index].ts, equity: round(point.equity) });
  const equity = [...byIndex.values()].sort((a, b) => a.index - b.index);
  let peak = equity[0]?.equity ?? STARTING_EQUITY;
  const drawdown = equity.map((point) => {
    peak = Math.max(peak, point.equity);
    return { index: point.index, ts: point.ts, drawdownPct: round(peak ? (point.equity / peak - 1) * 100 : -100, 4) };
  });
  return { equity, drawdown };
}

export function promotionPolicy(evaluation, policy = {}) {
  const thresholds = { minimumTrades: 30, minimumFolds: 3, maximumDrawdownPct: 20, minimumSharpeLike: 0.5,
    maximumBrierScore: 0.25, maximumCalibrationError: 0.15, ...(policy || {}) };
  // Callers may demand stricter evidence, never weaken the safety floor.
  thresholds.minimumTrades = Math.max(30, Number(thresholds.minimumTrades) || 30);
  thresholds.minimumFolds = Math.max(3, Number(thresholds.minimumFolds) || 3);
  const failures = [];
  if (!evaluation?.audit?.ok) failures.push('evaluation-audit-invalid');
  if ((evaluation?.folds?.length || 0) < thresholds.minimumFolds) failures.push('insufficient-walk-forward-folds');
  if ((evaluation?.metrics?.trades || 0) < thresholds.minimumTrades) failures.push('insufficient-out-of-sample-trades');
  if (!Number.isFinite(evaluation?.metrics?.maxDrawdownPct) || evaluation.metrics.maxDrawdownPct > thresholds.maximumDrawdownPct) failures.push('drawdown-limit-failed');
  if (!Number.isFinite(evaluation?.metrics?.sharpeLike) || evaluation.metrics.sharpeLike < thresholds.minimumSharpeLike) failures.push('risk-adjusted-performance-failed');
  if (!Number.isFinite(evaluation?.calibration?.brierScore) || evaluation.calibration.brierScore > thresholds.maximumBrierScore) failures.push('confidence-brier-failed');
  if (!Number.isFinite(evaluation?.calibration?.expectedCalibrationError) || evaluation.calibration.expectedCalibrationError > thresholds.maximumCalibrationError) failures.push('confidence-calibration-failed');
  if (!Number.isFinite(evaluation?.metrics?.cumulativeReturnPct)
    || evaluation.metrics.cumulativeReturnPct <= (evaluation?.baselines?.buyAndHold?.returnPct ?? Infinity)
    || evaluation.metrics.cumulativeReturnPct <= (evaluation?.baselines?.smaCross?.returnPct ?? Infinity)) failures.push('baseline-comparison-failed');
  return { allowed: failures.length === 0, decision: failures.length ? 'HOLD' : 'ELIGIBLE_FOR_PAPER_REVIEW',
    scope: 'paper-strategy-candidate', failures: [...new Set(failures)], thresholds,
    boundary: 'Never authorizes live trading, token deployment, conversion, staking, liquidity, or public-chain writes.' };
}

export function evaluateAgentStrategy({ symbol, timeframe = '1d', strategy, candles: input, config = {} }) {
  try {
    if (!symbol || !strategy?.entry?.rule) throw new Error('symbol and strategy.entry.rule required');
    const normalizedSymbol = String(symbol).toUpperCase();
    if (!/^[A-Z0-9._-]{1,12}$/.test(normalizedSymbol)) throw new Error('invalid symbol');
    if (!['1d', '4h', '1h', '15m'].includes(timeframe)) throw new Error('unsupported timeframe');
    validateStrategy(strategy);
    const candles = validateCandles(input); const cfg = normalizeConfig(config);
    const frozenStrategy = JSON.parse(JSON.stringify(strategy));
    const folds = [];
    for (let testStart = cfg.trainBars; testStart + cfg.testBars < candles.length; testStart += cfg.stepBars) {
      folds.push({ id: folds.length + 1,
        train: { fromIndex: Math.max(0, testStart - cfg.trainBars), toIndex: testStart - 1, from: candles[Math.max(0, testStart - cfg.trainBars)].ts, to: candles[testStart - 1].ts },
        test: { fromIndex: testStart, toIndex: testStart + cfg.testBars, from: candles[testStart].ts, to: candles[testStart + cfg.testBars].ts } });
    }
    if (!folds.length) throw new Error(`insufficient history: need more than ${cfg.trainBars + cfg.testBars} bars`);
    let equity = STARTING_EQUITY; const trades = []; const curve = [{ index: folds[0].test.fromIndex, equity }];
    for (const fold of folds) {
      const foldStartingEquity = equity;
      const result = runFold({ candles, strategy: frozenStrategy, fold, costs: cfg.costs, startingEquity: equity });
      equity = result.finalEquity; trades.push(...result.trades); curve.push(...result.curve);
      const foldTrades = result.trades;
      fold.result = { trades: foldTrades.length, returnPct: round((result.finalEquity / foldStartingEquity - 1) * 100) };
    }
    const summary = metrics(trades, curve); const calibrationResult = calibration(trades); const baselineResult = baselines(candles, folds, cfg.costs);
    const strategySeries = normalizeCurve(curve, candles);
    const warnings = [];
    if (summary.trades < cfg.minimumTrades) warnings.push(`Only ${summary.trades} out-of-sample trades; configured minimum is ${cfg.minimumTrades}.`);
    if (calibrationResult.observations < 100) warnings.push('Confidence calibration has fewer than 100 out-of-sample observations.');
    if (folds.length < 3) warnings.push('Fewer than three walk-forward folds.');
    const core = { version: 2, mode: 'paper-only', symbol: normalizedSymbol, timeframe, strategy: frozenStrategy, config: cfg,
      methodology: { split: 'rolling walk-forward', parameters: 'frozen before evaluation', execution: 'next-bar-open',
        informationBoundary: 'signal at index i receives candles[0..i] only', ambiguousBarPolicy: 'stop before target (conservative)', compounding: 'sequential out-of-sample folds' },
      folds, metrics: summary, baselines: baselineResult.summary, calibration: calibrationResult,
      series: { ...strategySeries, baselines: baselineResult.series }, warnings,
      audit: { ok: true, source: 'validated immutable candle snapshot', strategyHash: evidenceHash(frozenStrategy), dataHash: evidenceHash(candles) } };
    const promotion = promotionPolicy(core, { minimumTrades: cfg.minimumTrades });
    return { ok: true, ...core, promotion, evidence: { resultHash: evidenceHash({ ...core, promotion, trades }) }, trades };
  } catch (error) {
    const failed = { audit: { ok: false }, folds: [], metrics: {}, baselines: {}, calibration: {}, warnings: [error.message] };
    return { ok: false, mode: 'paper-only', error: error.message, promotion: promotionPolicy(failed) };
  }
}

export function verifyEvaluationEvidence(evaluation) {
  if (!evaluation?.ok || evaluation.version !== 2 || !evaluation.evidence?.resultHash) return false;
  const { evidence, ok: _ok, history: _history, ...rest } = evaluation;
  return evidenceHash(rest) === evidence.resultHash;
}
