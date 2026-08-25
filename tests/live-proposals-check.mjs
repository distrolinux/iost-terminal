// Regression: one pending live proposal may obtain only one execution lease.
// Also verifies malformed/stale proposals fail closed before venue execution.
// Uses an isolated store, never production data.
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-live-proposals-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;
process.env.LIVE_PROPOSAL_TTL_MS = '60000';

const { addProposal, claimForExecution, finalizeExecution, getProposal } = await import('../lib/live-proposals.js');

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

const proposal = addProposal({
  userId: 'owner-test', requesterKeyId: 'key-test', requesterName: 'Regression bot',
  symbol: 'BTC', side: 'long', size: 0.0001, entry: 60_000,
});
const first = claimForExecution(proposal.id, 'owner');
const second = claimForExecution(proposal.id, 'owner');
ok('first approval claims the execution lease', first.ok && first.proposal.status === 'executing', first.error);
ok('second approval cannot claim the same proposal', !second.ok && /executing/.test(second.error || ''), second.error);
const done = finalizeExecution(proposal.id, { status: 'approved', by: 'owner', venueOrderId: 'order-test' });
ok('claimed proposal finalizes with a venue order', done.ok && done.proposal.status === 'approved' && done.proposal.venueOrderId === 'order-test', done.error);
ok('final state persists', getProposal(proposal.id)?.status === 'approved');

const stale = addProposal({
  userId: 'owner-test', requesterKeyId: 'key-test', requesterName: 'Regression bot',
  symbol: 'ETH', side: 'long', size: 0.01, entry: 3_000,
});
const storePath = join(SCRATCH, 'live-proposals.json');
const store = JSON.parse(readFileSync(storePath, 'utf8'));
store.byId[stale.id].createdAt = Date.now() - 120_000;
writeFileSync(storePath, JSON.stringify(store, null, 2));
const staleClaim = claimForExecution(stale.id, 'owner');
ok('expired proposal cannot obtain an execution lease', !staleClaim.ok && /expired/.test(staleClaim.error || ''), staleClaim.error);
ok('expired proposal is permanently rejected', getProposal(stale.id)?.status === 'rejected');

const malformed = addProposal({
  userId: 'owner-test', requesterKeyId: 'key-test', requesterName: 'Regression bot',
  symbol: 'BTC', side: 'long', size: 0.01, entry: 60_000,
});
const store2 = JSON.parse(readFileSync(storePath, 'utf8'));
store2.byId[malformed.id].size = null;
writeFileSync(storePath, JSON.stringify(store2, null, 2));
const malformedClaim = claimForExecution(malformed.id, 'owner');
ok('malformed stored proposal fails closed before execution', !malformedClaim.ok && /size/.test(malformedClaim.error || ''), malformedClaim.error);
ok('malformed proposal is permanently rejected', getProposal(malformed.id)?.status === 'rejected');

rmSync(SCRATCH, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
