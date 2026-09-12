import assert from 'node:assert/strict';
import { readLinkedKrakenSettlement } from '../lib/kraken-linked-settlement.js';
const order = { venueOrderId: 'O-1', pair: 'XBTUSD', side: 'buy', tradeIds: ['T-1'], filledQuantity: '0.001', cost: '50', fee: '0.1' };
const trade = { ordertxid: 'O-1', pair: 'XXBTZUSD', type: 'buy', vol: '0.001', cost: '50', fee: '0.1', price: '50000', margin: '0', time: 150, ledgers: ['L-B', 'L-Q'] };
const common = { refid: 'T-1', time: 150, type: 'trade', subtype: '', aclass: 'currency', balance: 'PRIVATE' };
const ledger = { 'L-B': { ...common, asset: 'XXBT', amount: '0.001', fee: '0.000002' }, 'L-Q': { ...common, asset: 'ZUSD', amount: '-50', fee: '0' } };
let history = { count: 1, trades: { 'T-1': trade } }, records = ledger, calls = [];
const read = async (method, args) => {
  calls.push(method);
  if (method === 'TradesHistory') { assert.equal(args.ledgers, 'true'); assert.equal(args.consolidate_taker, 'false'); assert.equal(args.limit, '100'); return history; }
  assert.equal(method, 'QueryLedgers'); assert.equal(args.id, 'L-B,L-Q'); return records;
};
const window = { start: 100, end: 200 };
const good = await readLinkedKrakenSettlement(read, order, window);
assert.equal(good.status, 'fill-ledger-links-matched'); assert.equal(good.settlementVerified, false);
assert.deepEqual(calls, ['TradesHistory', 'QueryLedgers']); assert.ok(!JSON.stringify(good).includes('PRIVATE'));
for (const bad of [
  { count: 101, trades: {} }, { count: 2, trades: { 'T-1': trade } },
  { count: 1, trades: { 'T-1': { ...trade, ledgers: undefined } } },
  { count: 1, trades: { 'T-1': { ...trade, ledgers: ['L-B', 'L-B'] } } },
  { count: 1, trades: { 'T-1': { ...trade, cost: '51' } } },
  { count: 2, trades: { 'T-1': trade, 'T-2': trade } }
]) { history = bad; calls = []; assert.equal((await readLinkedKrakenSettlement(read, order, window)).status, 'unknown'); assert.deepEqual(calls, ['TradesHistory']); }
history = { count: 1, trades: { 'T-1': trade } }; records = { 'L-B': ledger['L-B'] };
assert.equal((await readLinkedKrakenSettlement(read, order, window)).status, 'unknown');
records = ledger;
const manyTrades = {}, manyLedgers = {}, manyIds = [];
for (let i = 0; i < 11; i++) {
  const id = 'T-' + i; manyIds.push(id);
  manyTrades[id] = { ...trade, ledgers: ['LB-' + i, 'LQ-' + i] };
  manyLedgers['LB-' + i] = { ...ledger['L-B'], refid: id };
  manyLedgers['LQ-' + i] = { ...ledger['L-Q'], refid: id };
}
const batchSizes = [];
const batched = await readLinkedKrakenSettlement(async (method, args) => {
  if (method === 'TradesHistory') return { count: 11, trades: manyTrades };
  const ids = args.id.split(','); batchSizes.push(ids.length);
  return Object.fromEntries(ids.map(id => [id, manyLedgers[id]]));
}, { ...order, tradeIds: manyIds, filledQuantity: '0.011', cost: '550', fee: '1.1' }, window);
assert.equal(batched.status, 'fill-ledger-links-matched'); assert.deepEqual(batchSizes, [20, 2]);
assert.equal((await readLinkedKrakenSettlement(async () => { throw Error('offline failure'); }, order, window)).status, 'unknown');

// Broker account/hold binding and order evidence integration, all transport mocked.
const info = { apiKey: 'fixture-linked-key', iban: 'FIXTURE ACCOUNT', validUntil: '0', permissions: ['query-open-trades', 'query-closed-trades', 'query-ledger'] };
globalThis.fetch = async (url, options) => {
  const method = url.split('/').at(-1);
  let result;
  if (method === 'GetApiKeyInfo') result = info;
  else if (method === 'QueryOrders') result = { 'O-1': { cl_ord_id: 'client-fixture', descr: { pair: 'XXBTZUSD', type: 'buy', ordertype: 'market' }, vol: '0.001', vol_exec: '0.001', status: 'closed', cost: '50', fee: '0.1', trades: ['T-1'] } };
  else result = await read(method, Object.fromEntries(new URLSearchParams(options.body)));
  return new Response(JSON.stringify({ error: [], result }));
};
const { createKrakenBroker } = await import('../lib/broker/kraken.js');
const broker = createKrakenBroker({ ownerId: 'owner', apiKey: info.apiKey, apiSecret: 'fixture-secret' });
const identity = await broker.getVenueIdentity('owner');
const hold = { credentialBinding: broker.credentialBinding('owner'), venueAccountBinding: identity.venueAccountBinding, clientOrderId: 'client-fixture', venueOrderId: 'O-1', order: { symbol: 'BTC', side: 'long', size: '0.001', entry: null } };
assert.equal((await broker.getLinkedSettlementEvidence(hold, 'owner', window)).status, 'fill-ledger-links-matched');
assert.equal((await broker.getLinkedSettlementEvidence(hold, 'other', window)).status, 'unknown');
info.permissions.pop(); calls = [];
assert.equal((await broker.getLinkedSettlementEvidence(hold, 'owner', window)).status, 'unknown'); assert.equal(calls.length, 0);
console.log('Authenticated linked settlement acquisition fixtures passed; no real requests');
