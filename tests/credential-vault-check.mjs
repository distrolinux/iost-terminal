import assert from 'node:assert/strict';
import { createCredentialVault } from '../lib/credential-vault.js';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { setUserKrakenKey, getUserKrakenKeys, rewrapUserKrakenKey } from '../lib/keys.js';
const key1 = Buffer.alloc(32, 17).toString('base64');
const key2 = Buffer.alloc(32, 23).toString('base64');
const first = createCredentialVault({ activeKeyId: 'v1', keys: { v1: key1 } });
const blob = first.seal('owner-a', 'kraken', 'fixture-credential');
assert.equal(first.open('owner-a', 'kraken', blob), 'fixture-credential');
assert.equal(first.open('owner-b', 'kraken', blob), null);
assert.equal(first.open('owner-a', 'other', blob), null);
assert.equal(first.open('owner-a', 'kraken', { ...blob, keyId: 'other' }), null);
assert.equal(first.open('owner-a', 'kraken', { ...blob, version: 99 }), null);
assert.ok(!JSON.stringify(blob).includes('fixture-credential'));
const rotated = createCredentialVault({ activeKeyId: 'v2', keys: { v1: key1, v2: key2 } });
assert.equal(rotated.open('owner-a', 'kraken', blob), 'fixture-credential');
const rewrapped = rotated.seal('owner-a', 'kraken', rotated.open('owner-a', 'kraken', blob));
assert.equal(rewrapped.keyId, 'v2');
assert.equal(createCredentialVault({ activeKeyId: 'v2', keys: { v2: key2 } }).open('owner-a', 'kraken', rewrapped), 'fixture-credential');
assert.throws(() => createCredentialVault({ activeKeyId: 'v1', keys: { v1: 'invalid' } }), /vault configuration unavailable/);
assert.throws(() => first.seal('', 'kraken', 'x'));
const savedEnv = { session: process.env.SESSION_SECRET, ring: process.env.IOST_CREDENTIAL_VAULT_KEYS, active: process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID };
try {
  process.env.SESSION_SECRET = 'legacy-fixture-only';
  delete process.env.IOST_CREDENTIAL_VAULT_KEYS;
  delete process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID;
  const user = { id: 'owner-a' };
  assert.equal(setUserKrakenKey(user, 'fixture', 'fixture').ok, false);
  assert.equal(user.krakenKey, undefined);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('iost-userkeys:legacy-fixture-only').digest(), iv);
  const data = Buffer.concat([cipher.update('fixture-key\nfixture-secret'), cipher.final()]);
  user.krakenKey = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  const legacy = JSON.stringify(user);
  assert.equal(getUserKrakenKeys(user).apiKey, 'fixture-key');
  assert.equal(rewrapUserKrakenKey(user).ok, false);
  assert.equal(JSON.stringify(user), legacy);
  process.env.IOST_CREDENTIAL_VAULT_KEYS = JSON.stringify({ v1: key1 });
  process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID = 'v1';
  assert.equal(rewrapUserKrakenKey(user).ok, true);
  process.env.SESSION_SECRET = 'rotated-fixture-only';
  assert.equal(getUserKrakenKeys(user).apiKey, 'fixture-key');
  assert.equal(getUserKrakenKeys({ ...user, id: 'owner-b' }), null);
  assert.equal(setUserKrakenKey(user, 'next-fixture', 'next-secret').ok, true);
  assert.equal(getUserKrakenKeys(user).apiKey, 'next-fixture');
} finally {
  for (const [name, value] of [['SESSION_SECRET', savedEnv.session], ['IOST_CREDENTIAL_VAULT_KEYS', savedEnv.ring], ['IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID', savedEnv.active]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
console.log('Credential vault checks passed');
