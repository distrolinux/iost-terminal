import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'iost-pr30-data-'));
try {
  const startedAt = performance.now();
  const worker = `
    const freeze = await import('./lib/freeze.js');
    const stakes = await import('./lib/stakes.js');
    const slashes = await import('./lib/slashes.js');
    const points = await import('./lib/points.js');
    const paper = await import('./lib/paper.js');
    const triggers = await import('./lib/triggers.js');
    const pacts = await import('./lib/pacts.js');
    const chain = await import('./lib/chain.js');
    const signals = await import('./lib/signals.js');
    const fees = await import('./lib/fees.js');
    freeze.setFrozen(true, { reason: 'test', by: 'test' });
    stakes.createStake({ ownerId: 'owner:test', amountMinor: '100000000000', lockDays: 7 });
    slashes.createSlash({ ownerId: 'owner:test', reason: 'failed-settlement' });
    points.awardSignup('owner:test');
    paper.ensureAccount('user:test', 'test');
    triggers.createTrigger({ userId: 'test', name: 'test', symbol: 'IOST', condition: { type: 'price', op: 'gt', value: 1 }, action: 'notify' });
    pacts.proposePact({ ownerId: 'owner:test', agentWalletId: null, intent: 'test', plan: [], completion: { type: 'time', deadlineTs: Date.now() + 60000 } });
    chain.queuePin({ signalId: 'signal:test', hash: 'a'.repeat(64), payload: { test: true } });
    signals.ensureAgent({ agentId: 'agent:test', name: 'test', kind: 'ai' });
    fees.setFeeConfig({ burnRate: 0.01, minCreditsToTrade: 50, bundles: [] });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', worker], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, IOST_DATA_DIR: scratch, PUBLIC_CHAIN_ACTIONS_ENABLED: '0', IOST_PIN_KEY: '' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const files = readdirSync(scratch).filter((name) => statSync(join(scratch, name)).isFile());
  assert.deepEqual(new Set(files), new Set([
    'fee-config.json', 'freeze.json', 'stakes.json', 'slashes.json', 'points.json',
    'accounts.json', 'triggers.json', 'pacts.json', 'pending_pins.json', 'signals.json',
  ]), 'all exercised stores must stay inside IOST_DATA_DIR');
  for (const name of files) {
    assert.equal(statSync(join(scratch, name)).mode & 0o777, 0o600, `${name} must be mode 0600`);
  }
  assert.ok(performance.now() - startedAt < 3_000, 'isolated private-store operations must finish within 3 seconds');
  console.log(`PASS  ${files.length} exercised stores stayed isolated and mode 0600`);
  console.log('PASS  private-store security checks stayed within the 3-second performance budget');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
