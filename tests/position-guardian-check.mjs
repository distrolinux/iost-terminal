import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(root, '.tmp-position-guardian');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
process.env.IOST_DATA_DIR = scratch;

const paper = await import('../lib/paper.js');
const management = await import('../lib/management.js');
const receipts = await import('../lib/execution-receipts.js');

const freshQuote = (last, now, overrides = {}) => ({
  last, bid: last, ask: last, source: 'TestVenue', observedAt: now, ageMs: 0, fresh: true,
  quoteIntegrity: {
    required: true, quorumMet: true, minimumVenues: 2, quoteCount: 3,
    trustedVenueCount: 3, excludedVenueCount: 0, routeVenue: 'TestVenue',
    routeLatencyMs: 5, executionSide: 'bid', venues: [], excludedVenues: [],
  },
  ...overrides,
});

try {
  const opened = await paper.openTrade({
    symbol: 'IOST', side: 'long', size: 1_000, entry: 1, stop: 0.95, target: 1.1,
    accountId: 'guardian-owner',
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.position.guardian.version, 1);
  assert.equal(opened.position.guardian.orderClass, 'bracket-oco');
  assert.equal(opened.position.guardian.status, 'armed');
  assert.equal(opened.position.guardian.legs.stopLoss.status, 'working');
  assert.equal(opened.position.guardian.legs.takeProfit.status, 'working');

  const staleNow = 10_000;
  const stale = await management.sweepManagement({
    nowFn: () => staleNow,
    quoteFn: async () => freshQuote(0.94, staleNow - 60_000, { ageMs: 60_000, fresh: false }),
  });
  assert.equal(stale.guardian.staleQuotes, 1);
  assert.equal(stale.guardian.triggered.length, 0);
  assert.equal(paper.getState('guardian-owner').positions.length, 1);
  assert.equal(paper.getState('guardian-owner').positions[0].guardian.status, 'degraded');
  assert.equal(paper.getState('guardian-owner').positions[0].guardian.lastDecision, 'quote-stale');

  const targetNow = 20_000;
  const target = await management.sweepManagement({
    nowFn: () => targetNow,
    quoteFn: async () => freshQuote(1.11, targetNow),
  });
  assert.equal(target.guardian.triggered.length, 1);
  assert.equal(target.guardian.triggered[0].triggerLeg, 'take-profit');
  assert.equal(target.guardian.triggered[0].cancelledLeg, 'stop-loss');
  assert.equal(paper.getState('guardian-owner').positions.length, 0);
  const journal = paper.getState('guardian-owner').journal[0];
  assert.equal(journal.status, 'closed');
  assert.equal(journal.exitReason, 'guardian take-profit (1.1)');
  assert.equal(journal.guardian.status, 'completed');
  assert.equal(journal.guardian.legs.takeProfit.status, 'filled');
  assert.equal(journal.guardian.legs.stopLoss.status, 'cancelled');

  const chain = receipts.listExecutionReceipts('guardian-owner', 10);
  assert.equal(chain.ok, true);
  assert.equal(chain.receipts.length, 1);
  assert.equal(chain.receipts[0].policy.reasonCode, 'guardian-take-profit-triggered');
  assert.equal(chain.receipts[0].authorization.principal, 'system-guardian');
  assert.equal(chain.receipts[0].guardian.orderClass, 'bracket-oco');
  assert.equal(chain.receipts[0].guardian.triggerLeg, 'take-profit');
  assert.equal(chain.receipts[0].guardian.cancelledLeg, 'stop-loss');
  assert.equal(chain.receipts[0].authorization.liveScopeUsed, false);
  assert.equal(chain.receipts[0].authorization.publicChainUsed, false);

  const repeated = await management.sweepManagement({
    nowFn: () => targetNow + 10_000,
    quoteFn: async () => freshQuote(1.12, targetNow + 10_000),
  });
  assert.equal(repeated.guardian.triggered.length, 0);
  assert.equal(receipts.listExecutionReceipts('guardian-owner', 10).receipts.length, 1);

  const short = await paper.openTrade({
    symbol: 'IOST', side: 'short', size: 100, entry: 1, stop: 1.05, target: 0.9,
    accountId: 'guardian-short',
  });
  assert.equal(short.ok, true);
  const stopNow = 40_000;
  await management.sweepManagement({
    nowFn: () => stopNow,
    quoteFn: async () => freshQuote(1.06, stopNow, { bid: 1.059, ask: 1.06 }),
  });
  assert.equal(paper.getState('guardian-short').positions.length, 0);
  assert.equal(paper.getState('guardian-short').journal[0].guardian.triggerLeg, 'stop-loss');
  assert.equal(paper.getState('guardian-short').journal[0].exitPrice, 1.06);

  const unprotected = await paper.openTrade({
    symbol: 'AAPL', side: 'long', size: 1, entry: 100, accountId: 'human-owner',
  });
  assert.equal(unprotected.position.guardian.status, 'unprotected');
  const status = management.positionGuardianStatus('human-owner');
  assert.equal(status.mode, 'paper-only');
  assert.equal(status.coverage.total, 1);
  assert.equal(status.coverage.unprotected, 1);
  assert.equal(status.liveScopeUsed, false);
  assert.equal(status.publicChainUsed, false);

  const rawReceipts = readFileSync(join(scratch, 'execution-receipts.jsonl'), 'utf8');
  assert.equal(rawReceipts.includes('guardian-owner'), false);
  assert.equal(rawReceipts.includes(opened.position.id), false);

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(server, /\/api\/position-guardian/);
  assert.match(protocol, /paper_position_guardian/);
  assert.match(app, /Position Guardian/);
  assert.match(app, /server-enforced/i);

  console.log('position guardian checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
