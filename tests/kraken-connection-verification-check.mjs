import assert from 'node:assert/strict';
import { assessKrakenPermissions, verifyKrakenConnection } from '../lib/kraken-connection-verification.js';
assert.equal(assessKrakenPermissions({}).profile, 'unknown');
assert.equal(assessKrakenPermissions({ permissions: ['query-funds', 'withdraw-funds'] }).profile, 'unsupported');
assert.equal(assessKrakenPermissions({ permissions: ['new-permission'] }).profile, 'unsupported');
assert.equal(assessKrakenPermissions({ permissions: ['query-funds'] }).profile, 'read-only');
const calls = [];
const fetchFn = async (url, opts) => {
  calls.push(url);
  assert.equal(opts.redirect, 'error');
  assert.ok(opts.signal);
  return new Response(JSON.stringify({ error: [], result: url.endsWith('GetApiKeyInfo') ? { apiKey: 'private-fixture', iban: 'private-account', permissions: ['query-funds'] } : { ZUSD: '123.45' } }));
};
const keys = { apiKey: 'fixture-key', apiSecret: 'Zml4dHVyZQ==' };
const result = await verifyKrakenConnection(keys, { fetchFn, now: () => 10000 });
assert.equal(result.accountHealth, 'reachable');
assert.equal(result.executionAuthorized, false);
assert.deepEqual(calls, ['https://api.kraken.com/0/private/GetApiKeyInfo', 'https://api.kraken.com/0/private/Balance']);
assert.doesNotMatch(JSON.stringify(result), /private|123.45|fixture-key/);
const failure = await verifyKrakenConnection(keys, { fetchFn: async () => { throw Error('secret'); } });
assert.equal(failure.reasonCode, 'verification-unavailable');
assert.doesNotMatch(JSON.stringify(failure), /secret/);
let restrictedCalls = 0;
const restricted = await verifyKrakenConnection(keys, { requireReadOnly: true, fetchFn: async () => {
  restrictedCalls++;
  return new Response(JSON.stringify({ error: [], result: { permissions: ['query-funds', 'modify-trades'] } }));
} });
assert.equal(restricted.reasonCode, 'read-only-key-required');
assert.equal(restrictedCalls, 1, 'trade-capable credentials rejected before balance request');
console.log('Kraken connection verification checks passed');
const extendedCalls = [];
const extended = await verifyKrakenConnection(keys, { includeFundingEvidence: true, fetchFn: async (url, options) => {
  extendedCalls.push(url);
  if (url.endsWith('BalanceEx')) return new Response(JSON.stringify({ error: [], result: { ZUSD: { balance: '100.12', credit: '0', credit_used: '0', hold_trade: '10' } } }));
  return fetchFn(url, options);
} });
assert.equal(extended.fundingEvidence.usdCashStatus, 'positive');
assert.equal(extended.executionAuthorized, false);
assert.deepEqual(extendedCalls, ['https://api.kraken.com/0/private/GetApiKeyInfo', 'https://api.kraken.com/0/private/Balance', 'https://api.kraken.com/0/private/BalanceEx']);
assert.doesNotMatch(JSON.stringify(extended), /100\.12|ZUSD|fixture-key/);
const missing = await verifyKrakenConnection(keys, { includeFundingEvidence: true, fetchFn: async (url, options) => {
  if (url.endsWith('BalanceEx')) throw Error('private-upstream-fixture');
  return fetchFn(url, options);
} });
assert.equal(missing.accountHealth, 'reachable');
assert.equal(missing.fundingEvidence.usdCashStatus, 'unavailable');
assert.doesNotMatch(JSON.stringify(missing), /private-upstream-fixture/);
let unsafeCalls = 0;
const unsafe = await verifyKrakenConnection(keys, { includeFundingEvidence: true, fetchFn: async () => {
  unsafeCalls++;
  return new Response(JSON.stringify({ error: [], result: { permissions: ['query-funds', 'withdraw-funds'] } }));
} });
assert.equal(unsafeCalls, 1);
assert.equal(unsafe.fundingEvidence, undefined);
