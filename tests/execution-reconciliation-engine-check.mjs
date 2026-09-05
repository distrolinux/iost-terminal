import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExecutionReconciliation } from '../lib/execution-reconciliation.js';
import { executionPositionRef } from '../lib/execution-receipts.js';
import { buildMcpTools } from '../lib/mcp-protocol.js';

const intentRef = 'a'.repeat(64), receiptHash = 'b'.repeat(64), positionId = 'paper-position-1';
const base = {
  now: 1_788_600_000_000,
  intents: [{ intentRef, action: 'open', status: 'succeeded', replaySafe: true, receiptRef: receiptHash }],
  receiptState: { verification: { ok: true, count: 1, headHash: receiptHash }, receipts: [{
    hash: receiptHash, action: 'open', outcome: 'accepted',
    order: { intentProtected: true, intentRef, positionRef: executionPositionRef(positionId) },
  }] },
  account: {
    accountId: 'test', account: { initialCash: 100_000, cash: 99_900 },
    positions: [{ id: positionId, symbol: 'IOST', side: 'long', entry: 1, size: 100, notional: 100 }],
    journal: [{ id: positionId, symbol: 'IOST', side: 'long', entry: 1, size: 100, status: 'open' }],
  },
};

const healthy = buildExecutionReconciliation(base);
assert.equal(healthy.decision, 'allow');
assert.equal(healthy.status, 'healthy');
assert.equal(healthy.reasonCode, 'execution-state-reconciled');
assert.equal(healthy.evidence.receiptChainVerified, true);
assert.equal(healthy.evidence.cashInvariant, true);
assert.equal(healthy.policy.executionSemantics, 'at-most-once');
assert.equal(healthy.policy.noAutomaticRetryForUnknown, true);
assert.equal(healthy.decisionEffects.executionPermissionsChanged, false);
assert.deepEqual(healthy.execution, { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false });
assert.equal(healthy.liveScopeUsed, false);
assert.equal(healthy.publicChainUsed, false);

const denied = (patch, reason) => {
  const result = buildExecutionReconciliation({ ...base, ...patch });
  assert.equal(result.decision, 'deny', reason);
  assert(result.findings.some((item) => item.code === reason), reason);
};
denied({ intents: [{ ...base.intents[0], status: 'outcome-unknown', replaySafe: false, receiptRef: null }] }, 'execution-intent-outcome-unknown');
denied({ receiptState: { verification: { ok: false, error: 'test corruption' }, receipts: [] } }, 'receipt-chain-invalid');
denied({ intents: [{ ...base.intents[0], receiptRef: null }] }, 'terminal-intent-receipt-missing');
denied({ receiptState: { ...base.receiptState, receipts: [...base.receiptState.receipts, { ...base.receiptState.receipts[0], hash: 'c'.repeat(64) }] } }, 'duplicate-intent-receipts');
denied({ account: { ...base.account, journal: [] } }, 'accepted-open-journal-missing');
denied({ account: { ...base.account, account: { ...base.account.account, cash: 99_000 } } }, 'cash-ledger-mismatch');

const legacy = buildExecutionReconciliation({
  ...base, receiptState: { ...base.receiptState, receipts: [{
    ...base.receiptState.receipts[0], order: { intentProtected: true, intentRef, positionRef: null },
  }] },
});
assert.equal(legacy.decision, 'allow');
assert.equal(legacy.status, 'attention');
assert(legacy.findings.some((item) => item.code === 'legacy-open-position-link-unavailable'));

const tools = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] });
const tool = tools.find((item) => item.name === 'paper_execution_reconciliation');
assert(tool);
assert.equal(tool.annotations.readOnlyHint, true);
assert.equal(tool.annotations.destructiveHint, false);
assert.equal(tool.annotations.idempotentHint, true);
assert(!buildMcpTools().some((item) => item.name === 'paper_execution_reconciliation'));

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
assert.match(server, /case 'paper_execution_reconciliation'/);
assert.match(server, /app\.get\('\/api\/execution-reconciliation', requireUser/);
assert.match(server, /const DISCOVERY_VERSION = '1\.40\.0'/);
assert.match(server, /attempt\.request\.positionId = placed\.position\.id/);
assert.match(app, /Execution Reconciliation/);
assert.match(app, /Unknown execution outcomes are never retried automatically/);

console.log('execution reconciliation engine checks passed');
