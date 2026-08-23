// tests/agent-wallet-check.mjs — Phase 2 agent-wallet engine checks
// Runs against a SCRATCH data dir (never production data).
// Usage: node tests/agent-wallet-check.mjs

import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-agentwallet-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

const { createAgentWallet, ensureUserWallet, creditUserWallet, fundAgentWallet, getWallet, walletTree, updatePolicies, setWalletStatus, balanceOf, stats } = await import('../lib/wallets.js');
const limits = await import('../lib/limits.js');
const freeze = await import('../lib/freeze.js');
const stakes = await import('../lib/stakes.js');
const slashes = await import('../lib/slashes.js');
const trust = await import('../lib/trust.js');
const pacts = await import('../lib/pacts.js');

let passed = 0, failed = 0;
const ok = (cond, label) => { if (cond) { passed++; console.log(`  ✅ ${label}`); } else { failed++; console.log(`  ❌ ${label}`); } };
const throws = (fn, label) => { try { fn(); ok(false, `${label} (did NOT throw)`); } catch { ok(true, label); } };
const isErr = (r, reason, label) => ok(r && r.ok === false && r.reason === reason, `${label} (→ ${r?.reason})`);

const OWNER = 'user:test-owner';
const AITT = (n) => (BigInt(n) * 10n ** 8n).toString(); // AITT → 8-dec minor
const mkWallet = (name, lim) => createAgentWallet({ ownerId: OWNER, name, limits: lim, capabilities: ['trade.paper'] });

console.log('Phase 2 agent-wallet engine checks (scratch dir)\n');

// ---- wallets ----
console.log('1. wallets (parent-child)');
const parent = ensureUserWallet(OWNER);
ok(parent.kind === 'user' && parent.parentWalletId === null, 'user (parent) wallet auto-created');
const aw = mkWallet('TraderBot', { USD: { maxPerTxMinor: 5000, dailyCapMinor: 10000 } });
ok(aw.kind === 'agent' && aw.parentWalletId === parent.walletId, 'agent wallet created as child');
ok(aw.limits.USD.maxPerTxMinor === 5000 && aw.limits.USD.dailyCapMinor === 10000, 'limits stored (minor units)');
throws(() => createAgentWallet({ ownerId: OWNER, name: 'Bad', capabilities: ['nope.nope'] }), 'unknown capability rejected');
throws(() => createAgentWallet({ ownerId: OWNER, name: '', capabilities: [] }), 'nameless wallet rejected');

creditUserWallet(OWNER, 100000); // $1,000 into parent
ok(balanceOf(parent.walletId) === 100000, 'parent credited $1,000');
const fund = fundAgentWallet({ walletId: aw.walletId, amountMinor: 5000 });
ok(fund.funded === 5000 && balanceOf(aw.walletId) === 5000 && balanceOf(parent.walletId) === 95000, 'parent→child funding (internal)');
throws(() => fundAgentWallet({ walletId: aw.walletId, amountMinor: 99999999 }), 'funding beyond parent balance rejected');
const tree = walletTree(OWNER);
ok(tree.parent && tree.agents.length === 1, 'wallet tree shows parent + 1 agent');

// ---- limits (isolated wallet) ----
console.log('\n2. spend limits (per-tx / daily / weekly, UTC windows)');
const lw = mkWallet('LimitsBot', { USD: { maxPerTxMinor: 5000, dailyCapMinor: 10000, weeklyCapMinor: 0 } });
let c = limits.checkSpend({ walletId: lw.walletId, amountMinor: 6000 });
isErr(c, 'per-tx-cap', 'per-tx cap enforced (6000 > 5000)');
c = limits.checkSpend({ walletId: lw.walletId, amountMinor: 4000 });
ok(c.ok, 'within per-tx cap passes check');
const r1 = limits.reserveSpend({ walletId: lw.walletId, amountMinor: 4000 });
ok(r1.ok && r1.reserveId, 'reserve 1 succeeds (4000)');
const r2 = limits.reserveSpend({ walletId: lw.walletId, amountMinor: 4000 });
ok(r2.ok, 'reserve 2 succeeds (8000 ≤ 10000 daily)');
const r3 = limits.reserveSpend({ walletId: lw.walletId, amountMinor: 3000 });
isErr(r3, 'daily-cap', 'daily cap enforced (8000+3000 > 10000)');
ok(limits.releaseReserve({ walletId: lw.walletId, reserveId: r1.reserveId }).ok, 'release rolls back usage');
c = limits.checkSpend({ walletId: lw.walletId, amountMinor: 3000 });
ok(c.ok, 'after release, capacity restored (6000+3000 ≤ 10000)');
// weekly cap on a fresh wallet
const lw2 = mkWallet('WeeklyBot', { USD: { maxPerTxMinor: 1500, dailyCapMinor: 5000, weeklyCapMinor: 2000 } });
const w1 = limits.reserveSpend({ walletId: lw2.walletId, amountMinor: 1200 });
const w2 = limits.reserveSpend({ walletId: lw2.walletId, amountMinor: 700 });
ok(w1.ok && w2.ok, 'two reserves within weekly cap (1900 ≤ 2000)');
const w3 = limits.reserveSpend({ walletId: lw2.walletId, amountMinor: 200 });
isErr(w3, 'weekly-cap', 'weekly cap enforced (1900+200 > 2000)');
limits.releaseReserve({ walletId: lw2.walletId, reserveId: w1.reserveId });
limits.releaseReserve({ walletId: lw2.walletId, reserveId: w2.reserveId });

// ---- freeze (isolated wallet) ----
console.log('\n3. emergency freeze');
const fw = mkWallet('FreezeBot', { USD: { maxPerTxMinor: 1000, dailyCapMinor: 5000 } });
freeze.setFrozen(true, { reason: 'test' });
isErr(limits.checkSpend({ walletId: fw.walletId, amountMinor: 100 }), 'frozen', 'freeze blocks spending');
freeze.setFrozen(false);
ok(limits.checkSpend({ walletId: fw.walletId, amountMinor: 100 }).ok, 'unfreeze restores spending');

// ---- stakes ----
console.log('\n4. trust staking');
const st = stakes.createStake({ ownerId: OWNER, amountMinor: AITT(5000), lockDays: 90 });
ok(st.status === 'active' && st.lockDays === 90, 'stake created (5,000 AITT, 90d)');
throws(() => stakes.createStake({ ownerId: OWNER, amountMinor: AITT(500), lockDays: 30 }), 'below-minimum stake rejected (500 < 1,000)');
throws(() => stakes.createStake({ ownerId: OWNER, amountMinor: AITT(2000), lockDays: 45 }), 'invalid lock duration rejected');
const st2 = stakes.createStake({ ownerId: OWNER, amountMinor: AITT(5000), lockDays: 30 });
const st3 = stakes.createStake({ ownerId: OWNER, amountMinor: AITT(1000), lockDays: 7 });
ok(stakes.activeStakeTotalMinor(OWNER) === BigInt(AITT(11000)), 'active stake total (11,000 AITT)');
ok(stakes.weightedStakeMinor(OWNER) === BigInt(AITT(5000)) * 15n / 10n + BigInt(AITT(5000)) * 125n / 100n + BigInt(AITT(1000)), 'weighted by lock multipliers (90d 1.5× · 30d 1.25× · 7d 1×)');
const unst = stakes.requestUnstake(st3.stakeId);
ok(unst.status === 'unstaking', 'unstake starts 7-day cooldown');
throws(() => stakes.withdraw(st3.stakeId), 'withdraw before cooldown rejected');

// ---- slashes + appeals (st and st2 remain active: 10,000 AITT) ----
console.log('\n5. slashing + appeal');
const slash = slashes.createSlash({ ownerId: OWNER, reason: 'unauthorized-spend', evidence: { tx: 'x' } });
ok(slash.pct === 10 && slash.totalReductionMinor === AITT(1000), 'unauthorized-spend slashes 10% across active stakes (10,000 → 1,000)');
ok(slashes.openSlashes(OWNER).length === 1, 'slash recorded as open');
const appeal = slashes.fileAppeal(slash.slashId, 'I did not authorize that');
ok(appeal.status === 'open' && !!appeal.appeal, 'appeal filed');
const decided = slashes.decideAppeal({ slashId: slash.slashId, decision: 'accepted', by: 'owner' });
ok(decided.status === 'accepted', 'appeal accepted');
ok(stakes.activeStakeTotalMinor(OWNER) === BigInt(AITT(10000)), 'stakes restored after accepted appeal (10,000)');

// ---- trust score ----
console.log('\n6. trust score (derived)');
const t = trust.computeTrust(OWNER);
ok(t.score >= 0 && t.score <= 100, `score in range (${t.score})`);
ok(t.stakeAITT === '10000', 'stakeAITT reflects restored stakes');
ok(t.components.stakeTierPoints === 25, 'tier points 25 for 10k AITT');
ok(t.components.lockMultiplier > 1, 'lock multiplier > 1 from mixed locks');
ok(t.creditLineMinor === 0 && t.config.priceUSD === 0, 'credit line 0 without a price (honest)');
ok(t.components.penalties.trustReset === false, 'no unresolved trust-reset slash');

// ---- pacts ----
console.log('\n7. pacts (task-scoped, auto-expiry)');
const pact = pacts.proposePact({
  ownerId: OWNER, agentWalletId: aw.walletId, intent: 'Buy research data',
  plan: [{ step: 'call api' }], completion: { type: 'time', deadlineTs: Date.now() + 3600_000 },
  policies: { whitelist: { recipients: ['0xDataVendor'], protocols: ['x402'] }, limits: { maxPerTxMinor: 1000 } },
});
ok(pact.status === 'proposed', 'pact proposed');
isErr(pacts.checkPactSpend({ pactId: pact.pactId, amountMinor: 500 }), 'pact-proposed', 'spend on unapproved pact rejected');
pacts.approvePact(pact.pactId, 'owner');
ok(pacts.getPact(pact.pactId).status === 'active', 'pact approved by human');
ok(pacts.checkPactSpend({ pactId: pact.pactId, amountMinor: 500, recipient: '0xDataVendor', protocol: 'x402' }).ok, 'pact spend within whitelist+limit allowed');
isErr(pacts.checkPactSpend({ pactId: pact.pactId, amountMinor: 500, recipient: '0xEvil' }), 'recipient-not-whitelisted', 'non-whitelisted recipient rejected');
isErr(pacts.checkPactSpend({ pactId: pact.pactId, amountMinor: 5000, recipient: '0xDataVendor', protocol: 'x402' }), 'per-tx-cap', 'pact per-tx cap enforced');
isErr(pacts.checkPactSpend({ pactId: pact.pactId, walletId: lw.walletId, ownerId: OWNER, amountMinor: 500, recipient: '0xDataVendor', protocol: 'x402' }), 'pact-wallet-mismatch', 'pact cannot authorize another wallet');
isErr(pacts.checkPactSpend({ pactId: pact.pactId, walletId: aw.walletId, ownerId: 'user:other', amountMinor: 500, recipient: '0xDataVendor', protocol: 'x402' }), 'pact-owner-mismatch', 'pact cannot authorize another owner');
pacts.recordPactSpend(pact.pactId, 500);
const past = pacts.proposePact({ ownerId: OWNER, intent: 'Old task', completion: { type: 'time', deadlineTs: Date.now() - 1000 } });
pacts.approvePact(past.pactId, 'owner');
ok(pacts.getPact(past.pactId).status === 'expired', 'time-expired pact auto-expires');
const budget = pacts.proposePact({ ownerId: OWNER, intent: 'Budgeted task', completion: { type: 'budget', budgetMinor: 1000 } });
pacts.approvePact(budget.pactId, 'owner');
pacts.recordPactSpend(budget.pactId, 1000);
ok(pacts.getPact(budget.pactId).status === 'expired', 'budget-exhausted pact auto-expires');
const reservedBudget = pacts.proposePact({ ownerId: OWNER, agentWalletId: aw.walletId, intent: 'Reserved budget task', completion: { type: 'budget', budgetMinor: 100 } });
pacts.approvePact(reservedBudget.pactId, 'owner');
const pr1 = pacts.reservePactSpend({ pactId: reservedBudget.pactId, reservationId: 'pact-r1', walletId: aw.walletId, ownerId: OWNER, amountMinor: 80 });
const pr2 = pacts.reservePactSpend({ pactId: reservedBudget.pactId, reservationId: 'pact-r2', walletId: aw.walletId, ownerId: OWNER, amountMinor: 80 });
ok(pr1.ok, 'first Pact budget reservation succeeds');
isErr(pr2, 'budget-exhausted', 'outstanding Pact reservations count against budget');
ok(pacts.releasePactReservation(reservedBudget.pactId, 'pact-r1').ok, 'releasing a Pact reservation restores budget');
const pr3 = pacts.reservePactSpend({ pactId: reservedBudget.pactId, reservationId: 'pact-r3', walletId: aw.walletId, ownerId: OWNER, amountMinor: 80 });
ok(pr3.ok, 'Pact budget can be reserved again after release');
const pc = pacts.commitPactReservation(reservedBudget.pactId, 'pact-r3');
ok(pc.ok && pc.pact.spentMinor === 80 && pc.pact.reservations.length === 0, 'commit converts outstanding Pact capacity to spent');
const term = pacts.proposePact({ ownerId: OWNER, intent: 'Stop me', completion: { type: 'goal', goal: 'done' } });
pacts.approvePact(term.pactId, 'owner');
pacts.terminatePact(term.pactId, 'owner');
ok(pacts.getPact(term.pactId).status === 'terminated', 'human can terminate an active pact');

// ---- wallet status (isolated wallet) ----
console.log('\n8. wallet status');
const sw = mkWallet('StatusBot', { USD: { maxPerTxMinor: 5000, dailyCapMinor: 10000 } });
setWalletStatus(sw.walletId, 'suspended');
isErr(limits.checkSpend({ walletId: sw.walletId, amountMinor: 100 }), 'wallet-suspended', 'suspended wallet cannot spend');
setWalletStatus(sw.walletId, 'active');
ok(limits.checkSpend({ walletId: sw.walletId, amountMinor: 100 }).ok, 'reactivated wallet can spend');

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(SCRATCH, { recursive: true, force: true });
if (failed > 0) process.exit(1);
