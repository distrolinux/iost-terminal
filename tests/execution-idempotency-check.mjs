import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'iost-execution-intents-'));
process.env.IOST_DATA_DIR = scratch;

try {
  const intents = await import('../lib/execution-intents.js');
  const accountId = 'private-account-id';
  const intentId = 'retry-safe-open-0001';
  const request = { symbol: 'IOST', size: 1000, walletId: 'private-wallet', pactId: 'private-pact' };
  let calls = 0;

  const first = await intents.runExecutionIntent({ accountId, intentId, action: 'open', request }, async () => {
    calls += 1;
    return { ok: true, position: { id: 'private-position' }, receipt: { outcome: 'accepted', hash: 'a'.repeat(64) } };
  });
  assert.equal(first.executionIntent.replayed, false);
  assert.equal(first.executionIntent.replayProtected, true);

  const replay = await intents.runExecutionIntent({ accountId, intentId, action: 'open', request }, async () => {
    calls += 1;
    throw new Error('must not execute');
  });
  assert.equal(calls, 1, 'terminal retry must not execute again');
  assert.equal(replay.executionIntent.replayed, true);
  assert.equal(replay.position.id, first.position.id);

  await assert.rejects(
    intents.runExecutionIntent({ accountId, intentId, action: 'open', request: { ...request, size: 2000 } }, async () => ({ ok: true })),
    (error) => error.status === 409 && error.reason === 'execution-intent-conflict',
  );
  assert.equal(calls, 1, 'conflicting reuse must not execute');

  let release;
  let concurrentCalls = 0;
  const delayed = new Promise((resolve) => { release = resolve; });
  const concurrentInput = { accountId, intentId: 'retry-safe-open-0002', action: 'open', request: { symbol: 'BTC', size: 1 } };
  const a = intents.runExecutionIntent(concurrentInput, async () => {
    concurrentCalls += 1;
    await delayed;
    return { ok: true, receipt: { outcome: 'accepted', hash: 'b'.repeat(64) } };
  });
  const b = intents.runExecutionIntent(concurrentInput, async () => {
    concurrentCalls += 1;
    return { ok: false };
  });
  release();
  const [aResult, bResult] = await Promise.all([a, b]);
  assert.equal(concurrentCalls, 1, 'concurrent duplicates must share one execution');
  assert.equal(aResult.executionIntent.replayed, false);
  assert.equal(bResult.executionIntent.replayed, true);

  let failedCalls = 0;
  const failedInput = { accountId, intentId: 'retry-safe-fail-0003', action: 'open', request: { symbol: 'ETH', size: 1 } };
  const fail = async () => {
    failedCalls += 1;
    throw Object.assign(new Error('wallet denied'), {
      status: 402, reason: 'agent-wallet-required', receipt: { outcome: 'rejected', hash: 'c'.repeat(64) },
    });
  };
  await assert.rejects(intents.runExecutionIntent(failedInput, fail), (error) => error.reason === 'agent-wallet-required' && error.executionIntent.replayed === false);
  await assert.rejects(intents.runExecutionIntent(failedInput, fail), (error) => error.reason === 'agent-wallet-required' && error.executionIntent.replayed === true);
  assert.equal(failedCalls, 1, 'terminal failure retry must not execute again');

  const status = intents.getExecutionIntent(accountId, intentId);
  assert.equal(status.status, 'succeeded');
  assert.equal(status.replaySafe, true);
  assert.equal(intents.listExecutionIntents(accountId, 10).length, 3);
  assert.equal(intents.getExecutionIntent('different-account', intentId), null, 'intent status must remain account-private');

  const file = join(scratch, 'execution-intents.json');
  const raw = readFileSync(file, 'utf8');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const forbidden of [accountId, intentId, 'private-wallet', 'private-pact']) {
    assert.equal(raw.includes(forbidden), false, `${forbidden} must not be stored`);
  }

  const store = JSON.parse(raw);
  const ref = intents.executionIntentRef(accountId, intentId);
  store.intents[ref].status = 'pending';
  store.intents[ref].result = null;
  writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.equal(intents.getExecutionIntent(accountId, intentId).status, 'outcome-unknown');
  await assert.rejects(
    intents.runExecutionIntent({ accountId, intentId, action: 'open', request }, async () => ({ ok: true })),
    (error) => error.status === 409 && error.reason === 'execution-intent-outcome-unknown',
  );

  writeFileSync(file, '{malformed', { mode: 0o600 });
  assert.throws(() => intents.listExecutionIntents(accountId), /store is malformed/);

  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const intentSource = readFileSync(new URL('../lib/execution-intents.js', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../lib/mcp-protocol.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(server, /runExecutionIntent/);
  assert.match(intentSource, /execution-intent-outcome-unknown/);
  assert.match(protocol, /paper_execution_intents/);
  assert.match(protocol, /idempotentHint: idempotent/);
  assert.match(app, /idempotency-key/);
  assert.match(app, /retry protected/);

  console.log('execution idempotency and replay-protection checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
