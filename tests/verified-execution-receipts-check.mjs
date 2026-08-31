import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'iost-execution-receipts-'));
process.env.IOST_DATA_DIR = scratch;

try {
  const receipts = await import('../lib/execution-receipts.js');
  const intents = await import('../lib/execution-intents.js');
  const accountId = 'private-account-id';
  const walletId = 'private-wallet-id';
  const pactId = 'private-pact-id';
  const missionId = 'msn_acceptance123';
  const positionId = 'private-position-id';
  const intentId = 'private-execution-intent-0001';
  const preflightFingerprint = 'a'.repeat(64);

  const market = receipts.marketEvidence({
    ticker: {
      last: 0.004, bid: 0.00399, ask: 0.00401, source: 'KuCoin', observedAt: 1_000, ageMs: 25, fresh: true,
      quoteIntegrity: {
        required: true, quorumMet: true, minimumVenues: 2, quoteCount: 3,
        trustedVenueCount: 3, excludedVenueCount: 0, excludedVenues: [],
        consensusPrice: 0.004, maximumOutlierBps: 100, maximumVenueSpreadBps: 100, maximumObservedDeviationBps: 2,
        routeVenue: 'KuCoin', routeLatencyMs: 18, executionSide: 'ask',
        executionQuality: {
          required: true, decision: 'allow', reasonCode: 'execution-quality-passed', executionSide: 'ask',
          bestPriceVenue: 'OKX', bestPrice: 0.004, selectedVenue: 'KuCoin', selectedPrice: 0.00401,
          selectedScore: 96.5, selectedTier: 'excellent', selectedLatencyMs: 18,
          selectedReliabilityPct: 100, latencySloMet: true, failoverApplied: true,
          failoverFromVenue: 'OKX', failoverReason: 'quality-score', eligibleVenueCount: 2, degradedVenueCount: 0,
          policy: { maximumPriceTradeoffBps: 10, targetLatencyMs: 500, maximumLatencyMs: 2_500,
            minimumReliabilityPct: 90, minimumReliabilitySamples: 5, circuitBreakerFailures: 3,
            weights: { price: 0.45, latency: 0.35, reliability: 0.2 } },
          venues: [{ source: 'KuCoin', bid: 0.00399, ask: 0.00401, latencyMs: 18,
            reliabilityPct: 100, sampleCount: 20, consecutiveFailures: 0, circuitOpen: false,
            priceDeltaBps: 2.5, withinPriceProtection: true, reliabilitySloMet: true,
            latencySloMet: true, eligible: true, priceScore: 87.5, latencyScore: 96.4,
            reliabilityScore: 100, score: 93, tier: 'excellent', status: 'eligible' }],
        },
        venues: [{ source: 'KuCoin', bid: 0.00399, ask: 0.00401, high24h: 0.0041, low24h: 0.0039, observedAt: 1_000, ageMs: 25, latencyMs: 18, consensusDeviationBps: 1, spreadBps: 50 }],
      },
    },
    requestedEntry: 0.00402,
    side: 'long',
    size: 1_000,
    now: 1_025,
  });
  assert.equal(market.available, true);
  assert.equal(market.quoteAgeMs, 25);
  assert.equal(market.spreadBps, 50);
  assert.equal(market.entryDeviationBps, 50);
  assert.equal(market.quoteIntegrity.quorumMet, true);
  assert.equal(market.quoteIntegrity.routeVenue, 'KuCoin');
  assert.equal(market.quoteIntegrity.routeLatencyMs, 18);
  assert.equal(market.quoteIntegrity.executionQuality.selectedScore, 96.5);
  assert.equal(market.quoteIntegrity.executionQuality.failoverApplied, true);
  assert.equal(market.quoteIntegrity.executionQuality.policy.maximumPriceTradeoffBps, 10);
  assert.equal(market.quoteIntegrity.executionQuality.authorization.liveScopeUsed, false);
  assert.equal(market.quoteIntegrity.venues[0].high24h, 0.0041);
  assert.equal(market.quoteIntegrity.venues[0].low24h, 0.0039);

  const accepted = receipts.recordExecutionReceipt({
    accountId,
    now: 2_000,
    action: 'open',
    outcome: 'accepted',
    request: {
      symbol: 'IOST', side: 'long', size: 1_000, requestedEntry: 0.00402,
      requestedNotionalUsd: 4.02, confidence: 77,
      reasoningSummary: 'Momentum confirmation api_key=should-never-persist',
      missionAttached: true, missionId, positionId, intentProtected: true, intentId,
      preflightProtected: true, preflightFingerprint,
    },
    market,
    execution: {
      status: 'filled', fillPrice: 0.00401, fillAuthority: 'server-top-of-book-ask', fillVenue: 'KuCoin',
      maxSlippageBps: 50, slippageBps: 25, slippageUsd: 0.01,
      priceImprovementUsd: 0, feeUsd: 0,
    },
    authorization: {
      principal: 'user-agent', tradePaperScope: true, walletPactRequired: true,
      walletPactAuthorized: true, missionRequired: true, missionAuthorized: true,
      preflightRequired: true, preflightAuthorized: true,
      walletId, pactId,
    },
    policy: { decision: 'allow', reasonCode: 'paper-fill-verified' },
    portfolioRisk: {
      decision: 'allow', reasonCode: 'portfolio-risk-passed',
      policy: { maxOrderPct: 10, maxGrossExposurePct: 80, maxSymbolExposurePct: 25,
        maxCorrelatedExposurePct: 50, maxDrawdownPct: 10, maxDailyRealizedLossPct: 3,
        maxRiskAtStopPct: 1, maxOpenPositions: 10, normalMaxOrderPct: 7.5,
        stormMaxOrderPct: 5, unknownMaxOrderPct: 5 },
      metrics: { currentEquityUsd: 100_000, orderNotionalUsd: 4.01, orderPct: 0,
        projectedGrossExposurePct: 0, projectedSymbolExposurePct: 0,
        correlatedGroup: 'crypto', projectedCorrelatedExposurePct: 0,
        projectedOpenPositions: 1, drawdownPct: 0, dailyRealizedLossPct: 0,
        protectiveStopRequired: true, protectiveStopPresent: true, protectiveStopValid: true, riskAtStopPct: 0,
        volatilityRegime: 'normal', volatilityFresh: true,
        volatilitySource: 'trusted-venue-24h-range', volatilityQuality: 'high',
        volatilityEvidenceAgeMs: 25, volatilityVenueCount: 2, dynamicMaxOrderPct: 7.5 },
      checks: [{ code: 'portfolio-equity-valid', pass: true }, { code: 'protective-stop-required', pass: true }],
      capacity: { available: true, maximumNewOrderUsd: 7_500, maximumNewOrderPct: 7.5,
        limitingFactors: ['volatility-normal-limit'] },
      volatility: { available: true, fresh: true, source: 'trusted-venue-24h-range',
        quality: 'high', reasonCode: 'range-evidence-fresh', regime: 'normal',
        forecastVolDailyPct: 2.4, forecastVolAnnualizedPct: 45.85,
        evidenceAgeMs: 25, venueCount: 2, dynamicMaxOrderPct: 7.5 },
    },
    latency: { totalMs: 12, authorizationMs: 3, brokerMs: 7, settlementMs: 2 },
  });
  assert.equal(accepted.sequence, 1);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.order.reasoningSummary.includes('[REDACTED]'), true);
  assert.equal(accepted.authorization.walletPactAuthorized, true);
  assert.equal(accepted.execution.simulated, true);
  assert.equal(accepted.execution.feeUsd, 0);
  assert.equal(accepted.execution.fillAuthority, 'server-top-of-book-ask');
  assert.equal(accepted.execution.fillVenue, 'KuCoin');
  assert.equal(accepted.execution.maxSlippageBps, 50);
  assert.equal(accepted.execution.slippageBps, 25);
  assert.equal(accepted.execution.slippageUsd, 0.01);
  assert.equal(accepted.execution.priceImprovementUsd, 0);
  assert.equal(accepted.market.quoteIntegrity.executionQuality.selectedVenue, 'KuCoin');
  assert.equal(accepted.market.quoteIntegrity.executionQuality.selectedReliabilityPct, 100);
  assert.equal(accepted.market.quoteIntegrity.executionQuality.failoverReason, 'quality-score');
  assert.equal(accepted.order.intentProtected, true);
  assert.equal(accepted.order.intentRef, intents.executionIntentRef(accountId, intentId));
  assert.equal(accepted.order.preflightProtected, true);
  assert.equal(accepted.order.preflightFingerprint, preflightFingerprint);
  assert.equal(accepted.authorization.preflightRequired, true);
  assert.equal(accepted.authorization.preflightAuthorized, true);
  assert.equal(accepted.portfolioRisk.decision, 'allow');
  assert.equal(accepted.portfolioRisk.metrics.protectiveStopPresent, true);
  assert.equal(accepted.portfolioRisk.metrics.protectiveStopValid, true);
  assert.equal(accepted.portfolioRisk.metrics.volatilitySource, 'trusted-venue-24h-range');
  assert.equal(accepted.portfolioRisk.metrics.dynamicMaxOrderPct, 7.5);
  assert.equal(accepted.portfolioRisk.capacity.maximumNewOrderUsd, 7_500);
  assert.equal(accepted.portfolioRisk.volatility.source, 'trusted-venue-24h-range');
  assert.equal(accepted.portfolioRisk.volatility.forecastVolDailyPct, 2.4);
  assert.equal(accepted.portfolioRisk.checks.every((check) => check.pass), true);

  const rejected = receipts.recordExecutionReceipt({
    accountId,
    now: 3_000,
    action: 'open',
    outcome: 'rejected',
    request: { symbol: 'BTC', side: 'short', size: 0.01, requestedEntry: 100_000 },
    execution: { status: 'not-filled' },
    authorization: { principal: 'user-agent', tradePaperScope: true, walletPactRequired: true, walletPactAuthorized: false },
    policy: { decision: 'deny', reasonCode: 'mission-order-cap', detail: 'Order exceeds mission maximum.' },
    latency: { totalMs: 2, authorizationMs: 2 },
  });
  assert.equal(rejected.sequence, 2);
  assert.equal(rejected.previousHash, accepted.hash);
  assert.equal(receipts.verifyReceiptChain(accountId).ok, true);

  const listed = receipts.listExecutionReceipts(accountId, 10);
  assert.equal(listed.ok, true);
  assert.equal(listed.verification.count, 2);
  assert.equal(listed.receipts[0].outcome, 'rejected');
  assert.equal(listed.receipts[1].outcome, 'accepted');

  const raw = readFileSync(join(scratch, 'execution-receipts.jsonl'), 'utf8');
  for (const forbidden of [accountId, walletId, pactId, missionId, positionId, intentId, 'should-never-persist']) {
    assert.equal(raw.includes(forbidden), false, `${forbidden} must not be stored`);
  }
  assert.equal(statSync(join(scratch, 'execution-receipts.jsonl')).mode & 0o777, 0o600);

  const rows = raw.trim().split('\n').map(JSON.parse);
  rows[0].execution.fillPrice = 999;
  writeFileSync(join(scratch, 'execution-receipts.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 });
  chmodSync(join(scratch, 'execution-receipts.jsonl'), 0o600);
  assert.equal(receipts.verifyReceiptChain(accountId).ok, false, 'tampering must invalidate the chain');
  assert.equal(receipts.listExecutionReceipts(accountId).receipts.length, 0, 'invalid chain must fail closed');

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(server, /executePaperOpen\(req/);
  assert.match(server, /executePaperClose\(req/);
  assert.match(server, /\/api\/execution-receipts/);
  assert.match(protocol, /paper_execution_receipts/);
  assert.match(app, /Verified Execution Receipts/);
  assert.match(app, /quote age/);
  assert.match(app, /slippage.*maxSlippageBps/);
  assert.match(app, /quorum verified/);
  assert.match(app, /fillVenue/);
  assert.match(app, /risk .*passed/);
  assert.match(app, /maximumNewOrderUsd/);

  console.log('verified execution receipt checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
