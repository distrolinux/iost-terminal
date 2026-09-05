import assert from 'node:assert/strict';
import './agent-capability-delegation-registry-check.mjs';
import { readFileSync } from 'node:fs';
import { buildAgentPortfolioOrchestrator, portfolioExecutionLaneStatus, runPortfolioExecution } from '../lib/agent-portfolio-orchestrator.js';
import { buildPortfolioRiskDecision } from '../lib/portfolio-risk-governor.js';
import { buildMcpTools } from '../lib/mcp-protocol.js';

const accountId = 'orchestrator-test-account';
let release;
const first = runPortfolioExecution({ accountId, action: 'open' }, async () => {
  await new Promise((resolve) => { release = resolve; });
  return 'open-1';
});
await new Promise((resolve) => setTimeout(resolve, 0));
const order = [];
const second = runPortfolioExecution({ accountId, action: 'open' }, async () => { order.push('open'); return 'open-2'; });
const close = runPortfolioExecution({ accountId, action: 'close' }, async () => { order.push('close'); return 'close'; });
const busy = portfolioExecutionLaneStatus(accountId);
assert.equal(busy.active, true);
assert.equal(busy.activeAction, 'open');
assert.equal(busy.queued, 2);
assert.equal(busy.queuedCloses, 1);
release();
assert.equal(await first, 'open-1');
assert.equal(await close, 'close');
assert.equal(await second, 'open-2');
assert.deepEqual(order, ['close', 'open']);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(portfolioExecutionLaneStatus(accountId).active, false);

const healthyReconciliation = { decision: 'allow', reasonCode: 'execution-state-reconciled' };
const base = buildAgentPortfolioOrchestrator({
  account: { accountId: 'a', positions: [{ symbol: 'IOST', side: 'long' }] },
  keys: [{ scopes: ['read', 'trade-paper'], revokedAt: null }],
  runtimes: { runtimes: [{ ready: true }] },
  missions: [{ status: 'running', walletId: 'w1', symbols: ['IOST'] }],
  reconciliation: healthyReconciliation,
});
assert.equal(base.decision, 'allow');
assert.equal(base.policy.centralArbiter, true);
assert.equal(base.policy.automaticAgentSubstitution, false);
assert.equal(base.guarantees.onePaperWriterPerAccount, true);
assert.equal(base.liveScopeUsed, false);

const conflicted = buildAgentPortfolioOrchestrator({
  account: { accountId: 'a', positions: [{ symbol: 'IOST', side: 'long' }, { symbol: 'IOST', side: 'short' }] },
  missions: [
    { status: 'running', walletId: 'w1', symbols: ['IOST'] },
    { status: 'running', walletId: 'w2', symbols: ['IOST'] },
  ],
  reconciliation: healthyReconciliation,
});
assert.equal(conflicted.decision, 'deny');
assert.equal(conflicted.reasonCode, 'opposing-symbol-exposure');
assert.equal(conflicted.counts.overlappingMandates, 1);

const risk = buildPortfolioRiskDecision({
  account: { initialCash: 1000, cash: 900 },
  positions: [{ symbol: 'IOST', side: 'short', entry: 1, lastPrice: 1, size: 100 }],
  order: { symbol: 'IOST', side: 'long', size: 10, stop: 0.9 }, fillPrice: 1,
  requireProtectiveStop: true,
});
assert.equal(risk.decision, 'deny');
assert.equal(risk.reasonCode, 'same-symbol-direction-consistent');

const tool = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] })
  .find((item) => item.name === 'agent_portfolio_orchestrator_status');
assert(tool);
assert.equal(tool.annotations.readOnlyHint, true);
assert.equal(tool.annotations.destructiveHint, false);
assert.equal(tool.annotations.idempotentHint, true);
assert(!buildMcpTools().some((item) => item.name === 'agent_portfolio_orchestrator_status'));

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(server, /runPortfolioExecution\(\{ accountId, action: 'open' \}/);
assert.match(server, /runPortfolioExecution\(\{ accountId, action: 'close' \}/);
assert.match(server, /case 'agent_portfolio_orchestrator_status'/);
assert.match(server, /app\.get\('\/api\/agent-portfolio-orchestrator', requireUser/);
assert.match(server, /const DISCOVERY_VERSION = '1\.42\.0'/);
assert.match(app, /Multi-Agent Portfolio Orchestrator/);
assert.match(app, /Risk-reducing closes move ahead of queued opens/);

console.log('multi-agent portfolio orchestrator checks passed');
