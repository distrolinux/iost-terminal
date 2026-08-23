// Regression: one pending live proposal may obtain only one execution lease.
// Uses an isolated store, never production data.
import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-live-proposals-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

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

rmSync(SCRATCH, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);