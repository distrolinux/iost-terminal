import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMcpTools } from '../lib/mcp-protocol.js';
import { buildPaperTradePreflight, PAPER_PREFLIGHT_QUOTE_TTL_MS } from '../lib/trade-preflight.js';

const now = 1_788_131_500_000;
const order = {
  intentId: 'preflight-intent-0001', symbol: 'IOST', side: 'long', size: 100, entry: 0.004,
  stop: 0.0035, target: 0.005, walletId: 'private-wallet-id',
  pactId: 'private-pact-id', recipient: 'private-recipient', protocol: 'paper', maxSlippageBps: 50,
};
const ticker = {
  source: 'Test Venue', last: 0.004, bid: 0.00399, ask: 0.00401,
  observedAt: now - 250,
};
const authorization = {
  ok: true, tradePaperScope: true, walletPactRequired: true,
  walletOwned: true, walletActive: true, walletTradePaper: true,
  walletLimitsAuthorized: true, pactAuthorized: true,
  remainingDailyMinor: 5_000, remainingWeeklyMinor: 10_000,
};

const allowed = buildPaperTradePreflight({
  order, ticker, cashUsd: 100, authorization, accountScope: 'private-account-id',
  supportedSymbols: ['IOST'], now, bindingSecret: 'private-test-binding-secret',
});
assert.equal(allowed.ok, true);
assert.equal(allowed.mode, 'paper-only');
assert.equal(allowed.readOnly, true);
assert.equal(allowed.decision, 'allow');
assert.equal(allowed.reasonCode, 'preflight-passed');
assert.equal(allowed.market.fresh, true);
assert.equal(allowed.market.quoteAgeMs, 250);
assert.equal(allowed.market.expiresAt, ticker.observedAt + PAPER_PREFLIGHT_QUOTE_TTL_MS);
assert.equal(allowed.market.estimateModel, 'top-of-book-spread-only');
assert.equal(allowed.market.executionSide, 'ask');
assert.equal(allowed.market.adverseSlippageBps, 25);
assert.equal(allowed.request.maxSlippageBps, 50);
assert.equal(allowed.request.estimatedFillNotionalUsd, 0.4);
assert.equal(allowed.costs.estimatedFeeUsd, 0);
assert.equal(allowed.costs.feeModel, 'paper-zero-fee');
assert.equal(allowed.account.sufficient, true);
assert.equal(allowed.authorization.pactAuthorized, true);
assert.equal(allowed.authorization.remainingDailyUsd, 50);
assert.equal(allowed.authorization.liveScopeUsed, false);
assert.equal(allowed.authorization.publicChainUsed, false);
assert.deepEqual(allowed.execution, {
  attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false,
});
assert.match(allowed.preflightFingerprint, /^[a-f0-9]{64}$/);
assert.deepEqual(allowed.binding, {
  version: 1,
  intentProtected: true,
  oneExecutionIntent: true,
  expiresAt: ticker.observedAt + PAPER_PREFLIGHT_QUOTE_TTL_MS,
});

const serialized = JSON.stringify(allowed);
for (const secret of ['private-wallet-id', 'private-pact-id', 'private-recipient', 'private-account-id']) {
  assert(!serialized.includes(secret), `preflight output leaked ${secret}`);
}
const repeated = buildPaperTradePreflight({
  order, ticker, cashUsd: 100, authorization, accountScope: 'private-account-id',
  supportedSymbols: ['IOST'], now, bindingSecret: 'private-test-binding-secret',
});
assert.equal(repeated.preflightFingerprint, allowed.preflightFingerprint, 'same evidence must fingerprint identically');

const portfolioRisk = {
  decision: 'allow', reasonCode: 'portfolio-risk-passed',
  policy: { maxOrderPct: 10, normalMaxOrderPct: 7.5 },
  metrics: { volatilitySource: 'trusted-venue-24h-range', volatilityRegime: 'normal',
    volatilityEvidenceAgeMs: 100, dynamicMaxOrderPct: 7.5 },
  checks: [{ code: 'volatility-order-limit', pass: true }],
  capacity: { available: true, maximumNewOrderUsd: 7_500,
    maximumNewOrderPct: 7.5, limitingFactors: ['volatility-normal-limit'] },
};
const riskBound = buildPaperTradePreflight({
  order, ticker, cashUsd: 100, authorization, portfolioRisk,
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
  bindingSecret: 'private-test-binding-secret',
});
const agedRiskBound = buildPaperTradePreflight({
  order, ticker, cashUsd: 100, authorization,
  portfolioRisk: { ...portfolioRisk, metrics: { ...portfolioRisk.metrics, volatilityEvidenceAgeMs: 250 } },
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
  bindingSecret: 'private-test-binding-secret',
});
assert.equal(agedRiskBound.preflightFingerprint, riskBound.preflightFingerprint,
  'an advancing age timer must not invalidate unchanged volatility evidence');
const changedCapacity = buildPaperTradePreflight({
  order, ticker, cashUsd: 100, authorization,
  portfolioRisk: { ...portfolioRisk, capacity: { ...portfolioRisk.capacity, maximumNewOrderUsd: 5_000 } },
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
  bindingSecret: 'private-test-binding-secret',
});
assert.notEqual(changedCapacity.preflightFingerprint, riskBound.preflightFingerprint,
  'risk-capacity changes must invalidate the binding');

const otherIntent = buildPaperTradePreflight({
  order: { ...order, intentId: 'preflight-intent-0002' }, ticker, cashUsd: 100,
  authorization, accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
  bindingSecret: 'private-test-binding-secret',
});
assert.notEqual(otherIntent.preflightFingerprint, allowed.preflightFingerprint, 'one preflight must bind to one execution intent');

const changedPolicy = buildPaperTradePreflight({
  order, ticker, cashUsd: 100,
  authorization: { ...authorization, remainingDailyMinor: 4_999 },
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
  bindingSecret: 'private-test-binding-secret',
});
assert.notEqual(changedPolicy.preflightFingerprint, allowed.preflightFingerprint, 'authorization evidence changes must invalidate the binding');

const deniedWallet = buildPaperTradePreflight({
  order, ticker, cashUsd: 100,
  authorization: { ...authorization, ok: false, walletOwned: false, pactAuthorized: false, reason: 'agent-wallet-required' },
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
});
assert.equal(deniedWallet.decision, 'deny');
assert.equal(deniedWallet.reasonCode, 'agent-wallet-required');
assert.equal(deniedWallet.authorization.reasonCode, 'agent-wallet-required');

const stale = buildPaperTradePreflight({
  order, ticker: { ...ticker, observedAt: now - PAPER_PREFLIGHT_QUOTE_TTL_MS - 1 },
  cashUsd: 100, authorization, accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
});
assert.equal(stale.decision, 'deny');
assert.equal(stale.reasonCode, 'quote-fresh');

const insufficientCash = buildPaperTradePreflight({
  order, ticker, cashUsd: 0.01, authorization,
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
});
assert.equal(insufficientCash.decision, 'deny');
assert.equal(insufficientCash.reasonCode, 'paper-cash-sufficient');

const badProtection = buildPaperTradePreflight({
  order: { ...order, stop: 0.005 }, ticker, cashUsd: 100, authorization,
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
});
assert.equal(badProtection.decision, 'deny');
assert.equal(badProtection.reasonCode, 'stop-valid');

const tightSlippage = buildPaperTradePreflight({
  order: { ...order, maxSlippageBps: 10 }, ticker, cashUsd: 100, authorization,
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
});
assert.equal(tightSlippage.decision, 'deny');
assert.equal(tightSlippage.reasonCode, 'slippage-within-limit');

const wideSpread = buildPaperTradePreflight({
  order, ticker: { ...ticker, bid: 0.0039, ask: 0.0041 }, cashUsd: 100, authorization,
  accountScope: 'private-account-id', supportedSymbols: ['IOST'], now,
});
assert.equal(wideSpread.decision, 'deny');
assert.equal(wideSpread.reasonCode, 'spread-within-limit');

const failedQuorum = buildPaperTradePreflight({
  order,
  ticker: {
    ...ticker,
    quoteIntegrity: {
      required: true, quorumMet: false, minimumVenues: 2,
      quoteCount: 1, trustedVenueCount: 1, excludedVenueCount: 2,
      excludedVenues: [
        { source: 'KuCoin', reason: 'stale-quote' },
        { source: 'Gate', reason: 'consensus-outlier' },
      ],
      consensusPrice: 0.004, maximumOutlierBps: 100,
      maximumObservedDeviationBps: 0, routeVenue: null,
      routeLatencyMs: null, executionSide: 'ask', venues: [],
    },
  },
  cashUsd: 100, authorization, accountScope: 'private-account-id',
  supportedSymbols: ['IOST'], now,
});
assert.equal(failedQuorum.decision, 'deny');
assert.equal(failedQuorum.reasonCode, 'quote-quorum');
assert.equal(failedQuorum.execution.attempted, false);

const tools = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] });
const preflight = tools.find((tool) => tool.name === 'paper_trade_preflight');
assert(preflight, 'paper_trade_preflight must be discoverable to scoped agents');
assert.equal(preflight.annotations.readOnlyHint, true);
assert.equal(preflight.annotations.destructiveHint, false);
assert.equal(preflight.annotations.idempotentHint, true);
assert.match(preflight.description, /multi-venue quote integrity/i);
assert.match(preflight.description, /portfolio exposure/i);
assert.match(preflight.description, /volatility fallback/i);
assert.match(preflight.description, /dynamic risk-capacity/i);
for (const required of ['intentId', 'symbol', 'side', 'size', 'entry', 'maxSlippageBps', 'stop', 'walletId', 'pactId']) {
  assert(preflight.inputSchema.required.includes(required), `${required} must be required`);
}
const open = tools.find((tool) => tool.name === 'paper_trade_open');
assert(open.inputSchema.required.includes('preflightFingerprint'));
assert(open.inputSchema.required.includes('maxSlippageBps'));
assert(open.inputSchema.required.includes('stop'));
assert.match(open.description, /preflight fingerprint/i);
assert.match(open.description, /best fresh consensus-approved server ask/i);
assert(!buildMcpTools().some((tool) => tool.name === 'paper_trade_preflight'), 'public clients must not receive private preflight');
assert(!buildMcpTools({ authenticated: true, scopes: ['read'] }).some((tool) => tool.name === 'paper_trade_preflight'), 'read-only keys without trade-paper must not receive execution preflight');

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.match(server, /const DISCOVERY_VERSION = '1\.28\.0'/);
assert.match(server, /enforcePaperPreflightBinding/);
assert.match(server, /preflight-evidence-changed/);
assert.match(server, /case 'paper_trade_preflight'/);
assert.match(server, /app\.post\('\/api\/paper\/preflight'/);
const start = server.indexOf('function agentSpendPreflight');
const end = server.indexOf('// A per-user agent key', start);
const implementation = server.slice(start, end);
for (const requiredCall of ['previewSpend(', 'previewPactSpend(', 'previewMissionTrade(', 'getAccount(', 'buildVolatilitySentinel(']) {
  assert(implementation.includes(requiredCall), `preflight must use read-only ${requiredCall}`);
}
for (const forbiddenCall of ['reserveSpend(', 'reservePactSpend(', 'recordExecutionReceipt(', 'runExecutionIntent(', 'placeOrder(', 'openTrade(']) {
  assert(!implementation.includes(forbiddenCall), `preflight must not call ${forbiddenCall}`);
}

console.log('agent trade preflight checks passed');
