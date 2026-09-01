import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(root, '.tmp-paper-position-management');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
process.env.IOST_DATA_DIR = scratch;

const { getState, openTrade } = await import('../lib/paper.js');
const { checkStaticExit, sweepManagement, updatePositionManagement } = await import('../lib/management.js');

try {
  const invalidStop = await openTrade({ symbol: 'AAPL', side: 'long', size: 1, entry: 100, stop: 101, accountId: 'guard' });
  assert.equal(invalidStop.ok, false);
  assert.match(invalidStop.error, /stop must be below entry/);

  const invalidTarget = await openTrade({ symbol: 'AAPL', side: 'short', size: 1, entry: 100, target: 101, accountId: 'guard' });
  assert.equal(invalidTarget.ok, false);
  assert.match(invalidTarget.error, /target must be below entry/);

  const opened = await openTrade({ symbol: 'AAPL', side: 'long', size: 2, entry: 100, stop: 95, target: 110, accountId: 'owner-position' });
  assert.equal(opened.ok, true);
  assert.deepEqual(checkStaticExit(opened.position, 94), { exit: true, reason: 'stop-loss (95)' });
  assert.deepEqual(checkStaticExit(opened.position, 111), { exit: true, reason: 'take-profit (110)' });

  const swept = await sweepManagement({ priceFn: async () => 111 });
  assert.equal(swept.trailingExits.some((x) => x.reason === 'guardian take-profit (110)'), true);
  const state = getState('owner-position');
  assert.equal(state.positions.length, 0);
  assert.equal(state.journal[0].status, 'closed');
  assert.equal(state.journal[0].exitReason, 'guardian take-profit (110)');
  assert.match(state.journal[0].exitAuthority, /^guardian-/);
  assert.equal(state.journal[0].guardian.legs.takeProfit.status, 'filled');
  assert.equal(state.journal[0].guardian.legs.stopLoss.status, 'cancelled');

  const again = await openTrade({ symbol: 'AAPL', side: 'long', size: 1, entry: 100, accountId: 'owner-position' });
  assert.equal(again.ok, true);
  const changed = updatePositionManagement('owner-position', again.position.id, { trailStopPct: 0.05 });
  assert.equal(changed.ok, true);
  assert.equal(getState('owner-position').positions[0].trailStopPct, 0.05);
  console.log('paper position management checks passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
