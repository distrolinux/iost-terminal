// KrakenBroker verification — READ-ONLY. Never calls placeOrder with valid
// params (that would place a REAL order). Tests: config, quotes, account,
// orders, positions (all read-only), plus invalid-order rejection.
import { getBroker, venues } from '../lib/broker/index.js';

const broker = getBroker('kraken');
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

console.log('venues:', venues.join(', '));
ok('configured (keys loaded from .env)', broker.configured === true);

// read-only: quotes (public)
const q = await broker.getQuotes(['BTC', 'ETH', 'SOL', 'IOST']);
ok('getQuotes live', q.ok && q.quotes.BTC?.last > 0, `BTC ${q.quotes.BTC?.last?.toFixed?.(2) ?? 'n/a'} ETH ${q.quotes.ETH?.last?.toFixed?.(2) ?? 'n/a'}`);
ok('getQuotes omits unsupported (IOST)', q.ok && !('IOST' in q.quotes));

// read-only: account balance
const a = await broker.getAccount();
ok('getAccount (Balance, read-only)', a.ok, a.ok ? `cashUsd ${a.account.cashUsd}` : a.error);
if (a.ok) console.log('       balances:', JSON.stringify(a.account.balances));

// read-only: open orders + positions
const o = await broker.getOrders();
ok('getOrders (OpenOrders, read-only)', o.ok && Array.isArray(o.orders));
const p = await broker.getPositions();
ok('getPositions (OpenPositions, read-only)', p.ok && Array.isArray(p.positions));

// validation: never reaches the API
const bad1 = await broker.placeOrder({});                       // no symbol
const bad2 = await broker.placeOrder({ symbol: 'BTC' });        // no size
const bad3 = await broker.placeOrder({ symbol: 'IOST', size: 1 }); // unsupported symbol
const bad4 = await broker.placeOrder({ symbol: 'BTC', size: -1 }); // negative size
ok('placeOrder rejects empty', !bad1.ok && /Symbol/.test(bad1.error));
ok('placeOrder rejects no-size', !bad2.ok && /size/i.test(bad2.error));
ok('placeOrder rejects unsupported symbol', !bad3.ok && /not supported/.test(bad3.error));
ok('placeOrder rejects negative size', !bad4.ok);

ok('cancelOrder rejects missing id', !(await broker.cancelOrder()).ok);

console.log(failures === 0 ? '\nALL PASS ✅ (no real orders placed)' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
