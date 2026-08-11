// Broker smoke test — Phase 1 verification. Uses a scratch account, cleans up after.
// Run from /opt/data/iost-terminal: node tests/broker-smoke.mjs
import { getBroker, venues } from '../lib/broker/index.js';
import { closeTrade, getAccount } from '../lib/paper.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const broker = getBroker('paper');
const accountId = `smoke-${Date.now().toString(36)}`;
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

console.log('venues:', venues.join(', '));

// 1. getAccount creates + returns a fresh account
const acct = await broker.getAccount(accountId);
ok('getAccount', acct.ok && acct.account.cash === 100000 && acct.account.equity === 100000, `cash ${acct.account.cash}`);

// 2. getQuotes returns live prices
const q = await broker.getQuotes(['BTC', 'ETH']);
ok('getQuotes', q.ok && q.quotes.BTC?.last > 0 && q.quotes.ETH?.last > 0, `BTC ${q.quotes.BTC?.last}`);

// 3. placeOrder opens a position (tiny size)
const order = await broker.placeOrder({ symbol: 'BTC', side: 'long', size: 0.0001, accountId });
ok('placeOrder', order.ok && order.position?.id, order.ok ? `id ${order.position.id}` : order.error);

// 4. getPositions shows it
const pos = await broker.getPositions(accountId);
ok('getPositions', pos.ok && pos.positions.length === 1);

// 5. getOrders — paper has none
const orders = await broker.getOrders(accountId);
ok('getOrders', orders.ok && orders.orders.length === 0);

// 6. cancelOrder — honest not-found on paper
const cancel = await broker.cancelOrder('nope', accountId);
ok('cancelOrder (paper semantics)', !cancel.ok && /resting/.test(cancel.error));

// 7. engine settlement still works through the same account
const closed = await closeTrade(pos.positions[0].id, null, accountId);
ok('engine closeTrade (unchanged path)', closed.ok, `pnl ${closed.pnl}`);

// 8. getAccount reflects closed state (journal entry, no positions)
const after = await broker.getAccount(accountId);
ok('getAccount after close', after.ok && after.account.positions.length === 0 && after.account.journal.length === 1);

// cleanup: drop the scratch account from accounts.json
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'accounts.json');
const store = JSON.parse(readFileSync(DATA, 'utf8'));
delete store[accountId];
writeFileSync(DATA, JSON.stringify(store, null, 2));
console.log(`cleanup: removed scratch account ${accountId}`);

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
