// Regression: customer-owned Kraken keys must not depend on platform keys.
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-live-self-custody-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;
process.env.KRAKEN_API_KEY = '';
process.env.KRAKEN_API_SECRET = '';

const { enableLive, getLiveState } = await import('../lib/live.js');
const state = { accountId: 'self-custody-test', positions: [], journal: [], account: {} };
const ownBroker = { configured: true };
const result = await enableLive(state, 'customer@test.local', ownBroker);

if (!result.ok || result.live?.venue !== 'kraken:self') {
  console.error('FAIL  customer broker should enable self-custody live mode', result);
  process.exit(1);
}
if (getLiveState(state, 'customer@test.local', ownBroker).krakenConfigured !== true) {
  console.error('FAIL  self-custody live state should report its own broker configured');
  process.exit(1);
}
if (!existsSync(join(SCRATCH, 'live-audit.jsonl'))) {
  console.error('FAIL  live audit did not use scratch data directory');
  process.exit(1);
}
rmSync(SCRATCH, { recursive: true, force: true });
console.log('PASS  customer broker enables self-custody live mode without platform keys');