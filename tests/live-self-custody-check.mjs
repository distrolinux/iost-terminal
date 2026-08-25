// Regression: customer-owned Kraken keys do not bypass the single-owner live
// policy. A configured owner may use a self-custody broker without platform
// keys, while every other identity still fails closed.
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-live-self-custody-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;
process.env.KRAKEN_API_KEY = '';
process.env.KRAKEN_API_SECRET = '';
process.env.LIVE_EMAIL_ALLOWLIST = 'owner@test.local';

const { enableLive, getLiveState } = await import('../lib/live.js');
const state = { accountId: 'self-custody-owner-test', positions: [], journal: [], account: {} };
const ownBroker = { configured: true };
const denied = await enableLive(
  { accountId: 'self-custody-non-owner-test', positions: [], journal: [], account: {} },
  'customer@test.local',
  ownBroker,
);
if (denied.ok || !/allowlist/.test(denied.error || '')) {
  console.error('FAIL  customer broker bypassed the single-owner live policy', denied);
  process.exit(1);
}

const result = await enableLive(state, 'owner@test.local', ownBroker);

if (!result.ok || result.live?.venue !== 'kraken:self') {
  console.error('FAIL  configured owner should enable self-custody live mode', result);
  process.exit(1);
}
if (getLiveState(state, 'owner@test.local', ownBroker).krakenConfigured !== true) {
  console.error('FAIL  self-custody live state should report its own broker configured');
  process.exit(1);
}
if (!existsSync(join(SCRATCH, 'live-audit.jsonl'))) {
  console.error('FAIL  live audit did not use scratch data directory');
  process.exit(1);
}
rmSync(SCRATCH, { recursive: true, force: true });
console.log('PASS  self-custody broker remains bound to the single-owner live policy');
