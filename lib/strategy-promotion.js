// Strategy Promotion Engine — deterministic governance for paper-only evidence.
// This module scores an evaluation and recommends a lifecycle stage. It never
// mutates agent state, grants execution scope or authorizes financial activity.

const clamp = (value, minimum = 0, maximum = 100) => Math.min(maximum, Math.max(minimum, value));
const round = (value, precision = 2) => Number.isFinite(value)
  ? Math.round((value + Number.EPSILON) * 10 ** precision) / 10 ** precision : null;

export const STRATEGY_PROMOTION_WEIGHTS = Object.freeze({
  riskAdjustedPerformance: 25,
  drawdownControl: 20,
  benchmarkEdge: 20,
  confidenceCalibration: 15,
  foldConsistency: 10,
  evidenceDepth: 10,
});

export const STRATEGY_PROMOTION_DEFAULTS = Object.freeze({
  minimumTrades: 30,
  minimumFolds: 3,
  maximumDrawdownPct: 20,
  minimumSharpeLike: 0.5,
  maximumBrierScore: 0.25,
  maximumCalibrationError: 0.15,
  promotionScore: 75,
  shadowScore: 60,
  restrictionScore: 45,
});

function normalizedPolicy(policy = {}) {
  const value = (key, fallback) => Number.isFinite(Number(policy[key])) ? Number(policy[key]) : fallback;
  const promotionScore = clamp(Math.max(STRATEGY_PROMOTION_DEFAULTS.promotionScore, value('promotionScore', STRATEGY_PROMOTION_DEFAULTS.promotionScore)));
  const shadowScore = Math.min(promotionScore, clamp(Math.max(STRATEGY_PROMOTION_DEFAULTS.shadowScore, value('shadowScore', STRATEGY_PROMOTION_DEFAULTS.shadowScore))));
  const restrictionScore = Math.min(shadowScore, clamp(Math.max(STRATEGY_PROMOTION_DEFAULTS.restrictionScore, value('restrictionScore', STRATEGY_PROMOTION_DEFAULTS.restrictionScore))));
  return {
    minimumTrades: Math.ceil(Math.max(STRATEGY_PROMOTION_DEFAULTS.minimumTrades, value('minimumTrades', STRATEGY_PROMOTION_DEFAULTS.minimumTrades))),
    minimumFolds: Math.ceil(Math.max(STRATEGY_PROMOTION_DEFAULTS.minimumFolds, value('minimumFolds', STRATEGY_PROMOTION_DEFAULTS.minimumFolds))),
    maximumDrawdownPct: Math.min(STRATEGY_PROMOTION_DEFAULTS.maximumDrawdownPct, Math.max(1, value('maximumDrawdownPct', STRATEGY_PROMOTION_DEFAULTS.maximumDrawdownPct))),
    minimumSharpeLike: Math.max(STRATEGY_PROMOTION_DEFAULTS.minimumSharpeLike, value('minimumSharpeLike', STRATEGY_PROMOTION_DEFAULTS.minimumSharpeLike)),
    maximumBrierScore: Math.min(STRATEGY_PROMOTION_DEFAULTS.maximumBrierScore, Math.max(0.01, value('maximumBrierScore', STRATEGY_PROMOTION_DEFAULTS.maximumBrierScore))),
    maximumCalibrationError: Math.min(STRATEGY_PROMOTION_DEFAULTS.maximumCalibrationError, Math.max(0.01, value('maximumCalibrationError', STRATEGY_PROMOTION_DEFAULTS.maximumCalibrationError))),
    promotionScore,
    shadowScore,
    restrictionScore,
  };
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function componentScores(evaluation, thresholds) {
  const metrics = evaluation?.metrics || {};
  const folds = Array.isArray(evaluation?.folds) ? evaluation.folds : [];
  const calibration = evaluation?.calibration || {};
  const baselines = Object.values(evaluation?.baselines || {}).map((row) => Number(row?.returnPct)).filter(Number.isFinite);
  const bestBaselineReturnPct = baselines.length ? Math.max(...baselines) : null;
  const strategyReturnPct = Number(metrics.cumulativeReturnPct);
  const benchmarkAlphaPct = Number.isFinite(strategyReturnPct) && Number.isFinite(bestBaselineReturnPct)
    ? strategyReturnPct - bestBaselineReturnPct : null;
  const foldReturns = folds.map((fold) => Number(fold?.result?.returnPct)).filter(Number.isFinite);
  const positiveFolds = foldReturns.filter((value) => value > 0).length;
  const positiveFoldPct = foldReturns.length ? positiveFolds / foldReturns.length * 100 : 0;
  const foldDispersionPct = standardDeviation(foldReturns);

  const sharpe = Number(metrics.sharpeLike);
  const expectancyPct = Number(metrics.expectancyPct);
  const sharpeScore = Number.isFinite(sharpe) ? clamp((sharpe + 0.25) / 2.25 * 100) : 0;
  const expectancyScore = Number.isFinite(expectancyPct) ? clamp(50 + expectancyPct * 250) : 0;
  const riskAdjustedPerformance = sharpeScore * 0.7 + expectancyScore * 0.3;
  const drawdown = Number(metrics.maxDrawdownPct);
  const drawdownControl = Number.isFinite(drawdown) ? clamp(100 - drawdown / thresholds.maximumDrawdownPct * 100) : 0;
  const benchmarkEdge = Number.isFinite(benchmarkAlphaPct) ? clamp(50 + benchmarkAlphaPct * 5) : 0;
  const brier = Number(calibration.brierScore);
  const ece = Number(calibration.expectedCalibrationError);
  const confidenceCalibration = (
    (Number.isFinite(brier) ? clamp(100 * (1 - brier / thresholds.maximumBrierScore)) : 0)
    + (Number.isFinite(ece) ? clamp(100 * (1 - ece / thresholds.maximumCalibrationError)) : 0)
  ) / 2;
  const consistencyFromDispersion = clamp(100 - foldDispersionPct * 10);
  const foldConsistency = positiveFoldPct * 0.7 + consistencyFromDispersion * 0.3;
  const tradeDepth = clamp((Number(metrics.trades) || 0) / thresholds.minimumTrades * 100);
  const foldDepth = clamp(folds.length / thresholds.minimumFolds * 100);
  const calibrationDepth = clamp((Number(calibration.observations) || 0) / 100 * 100);
  const evidenceDepth = tradeDepth * 0.5 + foldDepth * 0.3 + calibrationDepth * 0.2;

  const raw = { riskAdjustedPerformance, drawdownControl, benchmarkEdge, confidenceCalibration, foldConsistency, evidenceDepth };
  const scores = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(clamp(value))]));
  const weightedScore = round(Object.entries(STRATEGY_PROMOTION_WEIGHTS)
    .reduce((sum, [key, weight]) => sum + scores[key] * weight / 100, 0));
  return {
    scores,
    weightedScore,
    robustness: {
      positiveFolds,
      totalFolds: foldReturns.length,
      positiveFoldPct: round(positiveFoldPct),
      foldReturnDispersionPct: round(foldDispersionPct, 4),
      worstFoldReturnPct: foldReturns.length ? round(Math.min(...foldReturns), 4) : null,
      bestFoldReturnPct: foldReturns.length ? round(Math.max(...foldReturns), 4) : null,
      bestBaselineReturnPct: round(bestBaselineReturnPct, 4),
      benchmarkAlphaPct: round(benchmarkAlphaPct, 4),
    },
  };
}

function gateFailures(evaluation, thresholds, robustness) {
  const metrics = evaluation?.metrics || {};
  const failures = [];
  if (!evaluation?.audit?.ok) failures.push('evaluation-audit-invalid');
  if ((evaluation?.folds?.length || 0) < thresholds.minimumFolds) failures.push('insufficient-walk-forward-folds');
  if ((metrics.trades || 0) < thresholds.minimumTrades) failures.push('insufficient-out-of-sample-trades');
  if (!Number.isFinite(metrics.maxDrawdownPct) || metrics.maxDrawdownPct > thresholds.maximumDrawdownPct) failures.push('drawdown-limit-failed');
  if (!Number.isFinite(metrics.sharpeLike) || metrics.sharpeLike < thresholds.minimumSharpeLike) failures.push('risk-adjusted-performance-failed');
  if (!Number.isFinite(evaluation?.calibration?.brierScore) || evaluation.calibration.brierScore > thresholds.maximumBrierScore) failures.push('confidence-brier-failed');
  if (!Number.isFinite(evaluation?.calibration?.expectedCalibrationError) || evaluation.calibration.expectedCalibrationError > thresholds.maximumCalibrationError) failures.push('confidence-calibration-failed');
  if (!Number.isFinite(robustness.benchmarkAlphaPct) || robustness.benchmarkAlphaPct <= 0) failures.push('baseline-comparison-failed');
  if (robustness.totalFolds && robustness.positiveFoldPct < 50) failures.push('fold-consistency-failed');
  return [...new Set(failures)];
}

function lifecycle(score, failures, evaluation, thresholds) {
  const metrics = evaluation?.metrics || {};
  const critical = failures.includes('evaluation-audit-invalid')
    || (Number.isFinite(metrics.maxDrawdownPct) && metrics.maxDrawdownPct > thresholds.maximumDrawdownPct * 1.5)
    || (Number.isFinite(metrics.cumulativeReturnPct) && metrics.cumulativeReturnPct <= -10);
  if (!failures.length && score >= thresholds.promotionScore) {
    return { targetStage: 'PAPER_REVIEW', action: 'PROMOTE_TO_PAPER_REVIEW', decision: 'ELIGIBLE_FOR_PAPER_REVIEW' };
  }
  if (critical || score < thresholds.restrictionScore) {
    return { targetStage: 'PAUSED', action: 'PAUSE_AND_DEMOTE', decision: 'HOLD' };
  }
  if (score < thresholds.shadowScore || failures.length >= 3) {
    return { targetStage: 'RESTRICTED', action: 'RESTRICT_AND_REEVALUATE', decision: 'HOLD' };
  }
  return { targetStage: 'SHADOW', action: 'KEEP_IN_SHADOW', decision: 'HOLD' };
}

export function strategyPromotionPolicy(evaluation, policy = {}) {
  const thresholds = normalizedPolicy(policy);
  const { scores, weightedScore, robustness } = componentScores(evaluation, thresholds);
  const failures = gateFailures(evaluation, thresholds, robustness);
  const state = lifecycle(weightedScore, failures, evaluation, thresholds);
  const trades = Number(evaluation?.metrics?.trades) || 0;
  const confidence = trades >= thresholds.minimumTrades * 2 && robustness.totalFolds >= thresholds.minimumFolds + 2
    ? 'high' : trades >= thresholds.minimumTrades && robustness.totalFolds >= thresholds.minimumFolds ? 'medium' : 'low';
  const overfitRiskProxy = robustness.positiveFoldPct < 50 || (robustness.benchmarkAlphaPct ?? -Infinity) <= 0
    ? 'high' : robustness.positiveFoldPct < 75 || robustness.foldReturnDispersionPct > 5 ? 'medium' : 'low';
  return {
    allowed: state.targetStage === 'PAPER_REVIEW',
    decision: state.decision,
    scope: 'paper-strategy-candidate',
    failures,
    thresholds,
    scorecard: {
      version: 1,
      score: weightedScore,
      grade: weightedScore >= 90 ? 'A' : weightedScore >= 80 ? 'B' : weightedScore >= 70 ? 'C' : weightedScore >= 60 ? 'D' : 'F',
      confidence,
      components: scores,
      weights: STRATEGY_PROMOTION_WEIGHTS,
      robustness: { ...robustness, overfitRiskProxy,
        note: 'Fold stability and benchmark edge are conservative overfitting warnings, not proof of future performance.' },
      lifecycle: { ...state, automaticRecommendation: true, applied: false,
        ownerReviewRequired: true, executionPermissionsChanged: false },
      remediation: failures,
    },
    boundary: 'Never authorizes live trading, token deployment, conversion, staking, liquidity, public-chain writes or execution-scope changes.',
  };
}
