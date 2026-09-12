import assert from 'node:assert/strict';
import { readKrakenLedgerWindow } from '../lib/kraken-ledger-window.js';
const window = { start: 100, end: 200 };
const row = { refid: 'T-FIXTURE', time: 150, type: 'trade', subtype: '', aclass: 'currency', asset: 'ZUSD', amount: '-50', fee: '0.1', balance: 'PRIVATE' };
const all = Array.from({ length: 51 }, (_, i) => ['L-' + i, { ...row }]);
let calls = 0;
const read = async (method, params) => { calls++; assert.equal(method, 'Ledgers'); assert.equal(params.start, '100'); assert.equal(params.end, '200'); return { count: 51, ledger: Object.fromEntries(all.slice(Number(params.ofs), Number(params.ofs) + 50)) }; };
const good = await readKrakenLedgerWindow(read, window);
assert.equal(good.status, 'ledger-window-observed'); assert.equal(calls, 2);
assert.equal(good.rows.length, 51); assert.equal(good.snapshotComplete, false);
assert.equal(good.settlementVerified, false); assert.equal(good.releaseAllowed, false);
assert.ok(!JSON.stringify(good).includes('PRIVATE'));
for (const response of [
  { count: 201, ledger: {} }, { count: 2, ledger: { L: row } },
  { count: 1, ledger: { L: { ...row, time: 100 } } },
  { count: 1, ledger: { L: { ...row, fee: '-1' } } },
  { count: 1, ledger: { L: { ...row, amount: 50 } } },
  { count: 1, ledger: { L: { ...row, asset: 'USD.F' } } }
]) assert.equal((await readKrakenLedgerWindow(async () => response, window)).status, 'unknown');
let page = 0;
assert.equal((await readKrakenLedgerWindow(async () => ++page === 1 ? { count: 51, ledger: Object.fromEntries(all.slice(0, 50)) } : { count: 51, ledger: { 'L-0': row } }, window)).status, 'unknown');
page = 0;
assert.equal((await readKrakenLedgerWindow(async () => ++page === 1 ? { count: 51, ledger: Object.fromEntries(all.slice(0, 50)) } : { count: 50, ledger: {} }, window)).status, 'unknown');
assert.equal((await readKrakenLedgerWindow(async () => { throw Error('offline'); }, window)).status, 'unknown');
assert.equal((await readKrakenLedgerWindow(() => { assert.fail('invalid window called provider'); }, { start: 0, end: 100000 })).status, 'unknown');

// Real broker wiring with synthetic transport; no exchange requests.
const info = { apiKey: 'fixture-ledger', iban: 'FIXTURE ACCOUNT', validUntil: '0', permissions: ['query-open-trades', 'query-closed-trades', 'query-ledger'] };
let requests = [];
globalThis.fetch = async (url, options) => {
  assert.equal(options.headers['API-Key'], info.apiKey);
  const method = url.split('/').at(-1); requests.push(method);
  assert.ok(['GetApiKeyInfo', 'Ledgers'].includes(method));
  return new Response(JSON.stringify({ error: [], result: method === 'GetApiKeyInfo' ? info : { count: 1, ledger: { L: row } } }));
};
const { createKrakenBroker } = await import('../lib/broker/kraken.js');
const broker = createKrakenBroker({ ownerId: 'owner', apiKey: info.apiKey, apiSecret: 'fixture-secret' });
const identity = await broker.getVenueIdentity('owner');
const hold = { credentialBinding: broker.credentialBinding('owner'), venueAccountBinding: identity.venueAccountBinding };
requests = [];
assert.equal((await broker.getLedgerWindow(hold, 'owner', window)).status, 'ledger-window-observed');
assert.deepEqual(requests, ['GetApiKeyInfo', 'Ledgers']);
requests = [];
assert.equal((await broker.getLedgerWindow(hold, 'other', window)).status, 'unknown'); assert.equal(requests.length, 0);
info.iban = 'OTHER FIXTURE ACCOUNT'; requests = [];
assert.equal((await broker.getLedgerWindow(hold, 'owner', window)).status, 'unknown'); assert.deepEqual(requests, ['GetApiKeyInfo']);
info.iban = 'FIXTURE ACCOUNT';
info.permissions.pop(); requests = [];
assert.equal((await broker.getLedgerWindow(hold, 'owner', window)).status, 'unknown'); assert.deepEqual(requests, ['GetApiKeyInfo']);
console.log('Owner-bound ledger window, pagination and fail-closed fixtures passed');
