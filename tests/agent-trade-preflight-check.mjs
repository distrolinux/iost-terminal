import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMcpTools } from '../lib/mcp-protocol.js';
import { buildPaperTradePreflight, PAPER_PREFLIGHT_QUOTE_TTL_MS } from '../lib/trade-preflight.js';

const now = 1_788_131_500_000;
const order = {
  intentId: 'preflight-intent-0001', symbol: 'IOST', side: 'long', size: 100, entry: 0.004,
  stop: 0.0035, target: 0.005, walletId: 'private-wallet-id',
  pactId: 'private-pact-id', recipient: 'private-recipient', protocol: 'paper',
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

const tools = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] });
const preflight = tools.find((tool) => tool.name === 'paper_trade_preflight');
assert(preflight, 'paper_trade_preflight must be discoverable to scoped agents');
assert.equal(preflight.annotations.readOnlyHint, true);
assert.equal(preflight.annotations.destructiveHint, false);
assert.equal(preflight.annotations.idempotentHint, true);
for (const required of ['intentId', 'symbol', 'side', 'size', 'entry', 'walletId', 'pactId']) {
  assert(preflight.inputSchema.required.includes(required), `${required} must be required`);
}
const open = tools.find((tool) => tool.name === 'paper_trade_open');
assert(open.inputSchema.required.includes('preflightFingerprint'));
assert.match(open.description, /preflight fingerprint/i);
assert(!buildMcpTools().some((tool) => tool.name === 'paper_trade_preflight'), 'public clients must not receive private preflight');
assert(!buildMcpTools({ authenticated: true, scopes: ['read'] }).some((tool) => tool.name === 'paper_trade_preflight'), 'read-only keys without trade-paper must not receive execution preflight');

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.match(server, /const DISCOVERY_VERSION = '1\.24\.0'/);
assert.match(server, /enforcePaperPreflightBinding/);
assert.match(server, /preflight-evidence-changed/);
assert.match(server, /case 'paper_trade_preflight'/);
assert.match(server, /app\.post\('\/api\/paper\/preflight'/);
const start = server.indexOf('function agentSpendPreflight');
const end = server.indexOf('// A per-user agent key', start);
const implementation = server.slice(start, end);
for (const requiredCall of ['previewSpend(', 'previewPactSpend(', 'previewMissionTrade(', 'getAccount(']) {
  assert(implementation.includes(requiredCall), `preflight must use read-only ${requiredCall}`);
}
for (const forbiddenCall of ['reserveSpend(', 'reservePactSpend(', 'recordExecutionReceipt(', 'runExecutionIntent(', 'placeOrder(', 'openTrade(']) {
  assert(!implementation.includes(forbiddenCall), `preflight must not call ${forbiddenCall}`);
}

console.log('agent trade preflight checks passed');
