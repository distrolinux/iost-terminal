// payments.js verification — scratch accounts; fee-config + payments restored after.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFeeConfig, setFeeConfig, walletOf } from '../lib/fees.js';
import { createPayment, listPayments, confirmPayment, rejectPayment, getPayment } from '../lib/payments.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = join(ROOT, 'data', 'fee-config.json');
const PAY = join(ROOT, 'data', 'payments.json');
const cfgBackup = readFileSync(CFG, 'utf8'); // restore at the end

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// no wallet configured yet → refused
const noWallet = createPayment({ accountId: 'scratch', owner: 'u' }, 'b10', { asset: 'USDT_TRC20', txRef: 't1' });
ok('refused without wallet addresses', !noWallet.ok && /wallet/i.test(noWallet.error));

// set wallet (persists — restored below)
const w = setFeeConfig({ wallet: { USDT_TRC20: 'TXtestwallet', IOST: 'iost_testwallet' } });
ok('wallet configured', w.ok);

// create payment
const p = createPayment({ accountId: 'scratch', owner: 'u' }, 'b10', { asset: 'USDT_TRC20', txRef: 'tx123abc' });
ok('createPayment ok', p.ok && p.payment.status === 'pending', p.error || p.payment.id);
ok('payment carries address+credits', p.ok && p.payment.address === 'TXtestwallet' && p.payment.credits === 1000 && p.payment.usd === 10);

// validation
ok('bad bundle refused', !createPayment({ accountId: 'x' }, 'nope', { asset: 'USDT_TRC20', txRef: 't' }).ok);
ok('missing txRef refused', !createPayment({ accountId: 'x' }, 'b10', { asset: 'USDT_TRC20' }).ok);
ok('bad asset refused', !createPayment({ accountId: 'x' }, 'b10', { asset: 'BTC', txRef: 't' }).ok);

// listing
ok('list filters by account', listPayments({ accountId: 'scratch' }).length === 1);
ok('list filters by status', listPayments({ status: 'pending' }).some(x => x.id === p.payment.id));

// confirm → grants credits to the account wallet
const acc = { accountId: 'scratch', owner: 'u', wallet: { credits: 0, history: [] } };
const c = confirmPayment(p.payment.id, (id) => id === 'scratch' ? acc : null);
ok('confirmPayment ok', c.ok && c.payment.status === 'confirmed' && c.credits === 1000);
ok('credits granted to wallet', walletOf(acc).credits === 1000);
ok('confirm twice refused', !confirmPayment(p.payment.id, (id) => acc).ok);

// reject path
const p2 = createPayment({ accountId: 'scratch', owner: 'u' }, 'b50', { asset: 'IOST', txRef: 'tx999' });
const rj = rejectPayment(p2.payment.id);
ok('rejectPayment ok', rj.ok && rj.payment.status === 'rejected');
ok('rejected payment not confirmable', !confirmPayment(p2.payment.id, (id) => acc).ok);

// ---- cleanup: restore config + drop test payments ----
writeFileSync(CFG, cfgBackup);
const store = JSON.parse(readFileSync(PAY, 'utf8'));
store.payments = store.payments.filter(p => !['scratch'].includes(p.accountId));
writeFileSync(PAY, JSON.stringify(store, null, 2));
console.log('cleanup: config + payments restored');

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
