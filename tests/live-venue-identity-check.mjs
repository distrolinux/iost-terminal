import assert from 'node:assert/strict';
process.env.KRAKEN_API_KEY = 'offline-only'; process.env.KRAKEN_API_SECRET = 'offline-only';
let calls = 0;
const base = { apiKey: 'fixture-key', iban: 'FIXTURE ACCOUNT A', validUntil: '0', permissions: ['query-open-trades', 'query-closed-trades', 'modify-trades', 'close-trades'] };
let info = base;
const originalNow = Date.now;
Date.now = () => 1780000000000;
let previousNonce = 0n;
globalThis.fetch = async (url, options) => {
  calls++; assert.equal(url, 'https://api.kraken.com/0/private/GetApiKeyInfo');
  const nonce = BigInt(new URLSearchParams(options.body).get('nonce'));
  assert.ok(nonce > previousNonce, 'same-millisecond requests have increasing nonces'); previousNonce = nonce;
  return new Response(JSON.stringify({ error: [], result: info }));
};
const { createKrakenBroker } = await import('../lib/broker/kraken.js');
const broker = createKrakenBroker({ ownerId: 'owner', apiKey: 'fixture-key', apiSecret: 'fixture-secret' });
const first = await broker.getVenueIdentity('owner');
assert.equal(first.ok, true); assert.equal(first.submissionPermissions, true);
assert.match(first.venueAccountBinding, /^[a-f0-9]{64}$/);
assert.ok(!JSON.stringify(first).includes(base.iban));
assert.ok(!JSON.stringify(first).includes(base.apiKey));
assert.equal((await broker.getVenueIdentity('owner')).venueAccountBinding, first.venueAccountBinding);
for (const change of [{ iban: '' }, { iban: null }, { apiKey: 'wrong' }, { validUntil: '1' }, { validUntil: 'bad' }, { permissions: ['withdraw-funds'] }]) {
  info = { ...base, ...change }; assert.equal((await broker.getVenueIdentity('owner')).ok, false);
}
info = { ...base, iban: 'FIXTURE ACCOUNT B' };
const hold = { credentialBinding: broker.credentialBinding('owner'), venueAccountBinding: first.venueAccountBinding };
assert.equal((await broker.getOrderEvidence(hold, 'owner')).ok, false);
info = base;
const before = calls;
assert.equal((await broker.getVenueIdentity('other')).ok, false);
assert.equal(calls, before);
Date.now = originalNow;
console.log('Venue-reported account identity, expiry and privacy checks passed');
