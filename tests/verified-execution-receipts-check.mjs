import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'iost-execution-receipts-'));
process.env.IOST_DATA_DIR = scratch;

try {
  const receipts = await import('../lib/execution-receipts.js');
  const accountId = 'private-account-id';
  const walletId = 'private-wallet-id';
  const pactId = 'private-pact-id';
  const missionId = 'msn_acceptance123';
  const positionId = 'private-position-id';

  const market = receipts.marketEvidence({
    ticker: { last: 0.004, bid: 0.00399, ask: 0.00401, source: 'TEST', observedAt: 1_000, ageMs: 25, fresh: true },
    requestedEntry: 0.00402,
    side: 'long',
    size: 1_000,
    now: 1_025,
  });
  assert.equal(market.available, true);
  assert.equal(market.quoteAgeMs, 25);
  assert.equal(market.spreadBps, 50);
  assert.equal(market.entryDeviationBps, 50);

  const accepted = receipts.recordExecutionReceipt({
    accountId,
    now: 2_000,
    action: 'open',
    outcome: 'accepted',
    request: {
      symbol: 'IOST', side: 'long', size: 1_000, requestedEntry: 0.00402,
      requestedNotionalUsd: 4.02, confidence: 77,
      reasoningSummary: 'Momentum confirmation api_key=should-never-persist',
      missionAttached: true, missionId, positionId,
    },
    market,
    execution: { status: 'filled', fillPrice: 0.00402, fillAuthority: 'client-supplied-paper-entry', feeUsd: 0 },
    authorization: {
      principal: 'user-agent', tradePaperScope: true, walletPactRequired: true,
      walletPactAuthorized: true, missionRequired: true, missionAuthorized: true,
      walletId, pactId,
    },
    policy: { decision: 'allow', reasonCode: 'paper-fill-verified' },
    latency: { totalMs: 12, authorizationMs: 3, brokerMs: 7, settlementMs: 2 },
  });
  assert.equal(accepted.sequence, 1);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.order.reasoningSummary.includes('[REDACTED]'), true);
  assert.equal(accepted.authorization.walletPactAuthorized, true);
  assert.equal(accepted.execution.simulated, true);
  assert.equal(accepted.execution.feeUsd, 0);

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
  for (const forbidden of [accountId, walletId, pactId, missionId, positionId, 'should-never-persist']) {
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

  console.log('verified execution receipt checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
