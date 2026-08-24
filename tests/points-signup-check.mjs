// Scratch-backed signup point eligibility and activation regression.
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, '.tmp-points-signup-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

const points = await import('../lib/points.js');
let passed = 0;
let failed = 0;
const ok = (name, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (condition) passed++;
  else failed++;
};

try {
  const ownerId = 'user:signup-test';
  const awardSignup = points.awardSignup || (() => ({ ok: false }));
  const activateSignup = points.activateSignup || (() => ({ ok: false }));
  const getPointBalances = points.getPointBalances || (() => ({ total: 0, eligible: 0, provisional: 0 }));

  const first = awardSignup(ownerId);
  const duplicate = awardSignup(ownerId);
  ok('signup awards exactly one provisional point', first.ok && first.entry.points === 1 && first.entry.meta?.provisional === true);
  ok('duplicate signup cannot award twice', duplicate.ok && duplicate.already === true && points.getBalance(ownerId) === 1);

  const beforeActivation = getPointBalances(ownerId);
  ok('unactivated signup is excluded from eligible balance', beforeActivation.total === 1 && beforeActivation.eligible === 0 && beforeActivation.provisional === 1);

  points.credit({ ownerId, event: 'signal', refId: 'legacy-signal' });
  const withLegacyEntry = getPointBalances(ownerId);
  ok('existing non-provisional entries remain eligible', withLegacyEntry.total === 11 && withLegacyEntry.eligible === 10 && withLegacyEntry.provisional === 1);

  const activated = activateSignup(ownerId);
  const activatedAgain = activateSignup(ownerId);
  const afterActivation = getPointBalances(ownerId);
  ok('activation makes the signup point eligible', activated.ok && afterActivation.total === 11 && afterActivation.eligible === 11 && afterActivation.provisional === 0);
  ok('activation is idempotent', activatedAgain.ok && activatedAgain.already === true && points.getBalance(ownerId) === 11);
  ok('eligible balance is distinguishable from total and provisional balance', Object.hasOwn(afterActivation, 'total') && Object.hasOwn(afterActivation, 'eligible') && Object.hasOwn(afterActivation, 'provisional'));
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
