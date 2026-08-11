// fees.js verification — free-trading model: no credit gate, nothing burned.
// Scratch account objects only; config file untouched.
import { getFeeConfig, setFeeConfig, walletOf, burnForOrder, canTrade, grantCredits, burnCredits, walletSummary, isFeeExempt } from '../lib/fees.js';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const cfg = getFeeConfig();
console.log('config: burn', cfg.burnRate, '| min', cfg.minCreditsToTrade, '| bundles', cfg.bundles.length, '| wallet', Object.keys(cfg.wallet || {}).length);
ok('config seeded with owner exempt', cfg.feeExemptAccounts.length >= 1);
ok('free model: burnRate 0', cfg.burnRate === 0);
ok('free model: minCreditsToTrade 0', cfg.minCreditsToTrade === 0);
ok('no deposit addresses configured', Object.keys(cfg.wallet || {}).length === 0);

// validation still rejects bad configs WITHOUT persisting
ok('rejects negative burnRate', !setFeeConfig({ burnRate: -1 }).ok);
ok('rejects bad bundles', !setFeeConfig({ bundles: [{ id: 'x' }] }).ok);
ok('rejects string min', !setFeeConfig({ minCreditsToTrade: 'many' }).ok);

// burn math: free model → 0 regardless of notional
ok('burnForOrder is 0', burnForOrder(100) === 0 && burnForOrder(65500) === 0, `${burnForOrder(100)} / ${burnForOrder(65500)}`);

// scratch accounts
const free = { accountId: 'scratch-free', positions: [], journal: [], account: {} };
const owner = { accountId: cfg.feeExemptAccounts[0], positions: [], journal: [], account: {} };

// wallet lazy-init with trial credits
ok('wallet init (0 trial)', walletOf(free).credits === 0);

// gate: free trading — ALWAYS passes, even with an empty wallet
ok('gate passes with empty wallet', canTrade(free).ok);
// grant still works (API compat) but nothing is required
ok('grant credits', grantCredits(free, 100, 'test').ok && walletOf(free).credits === 100);
ok('gate passes regardless', canTrade(free).ok);
// burn never deducts — free
const b = burnCredits(free, 100000); // $100k → 0 burn
ok('burn always 0', b.ok && b.burn === 0 && b.credits === 100, `burn ${b.burn} credits ${b.credits}`);
// history: grant recorded, no burn entry
ok('history has grant only', walletSummary(free).history.length === 1);
// owner exempt: gate ok, burn 0
ok('owner gate ok', canTrade(owner).ok);
const bo = burnCredits(owner, 100000);
ok('owner burns nothing', bo.ok && bo.burn === 0);
ok('isFeeExempt', isFeeExempt(owner.accountId) === true && isFeeExempt(free.accountId) === false);

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
