import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCredentialMaintenance, credentialStorageStatus } from '../lib/credential-maintenance.js';
import { setUserKrakenKey, getUserKrakenKeys } from '../lib/keys.js';

const names = ['IOST_CREDENTIAL_VAULT_KEYS', 'IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID'];
const saved = names.map(n => process.env[n]);
try {
  delete process.env[names[0]]; delete process.env[names[1]];
  assert.equal(credentialStorageStatus({ id: 'fixture-owner' }).vaultConfigured, false);
  const a = Buffer.alloc(32, 31).toString('base64');
  const b = Buffer.alloc(32, 37).toString('base64');
  process.env[names[0]] = JSON.stringify({ first: a, second: b });
  process.env[names[1]] = 'first';
  const user = { id: 'fixture-owner' };
  assert.equal(setUserKrakenKey(user, 'fixture-key', 'fixture-secret').ok, true);
  process.env[names[1]] = 'second';
  const before = JSON.stringify(user);
  let clock = 1000, backups = 0, writes = 0;
  const service = createCredentialMaintenance({ now: () => clock,
    backup: record => { backups++; assert.equal(record.krakenKey.keyId, 'first'); },
    persist: (u, blob) => { writes++; u.krakenKey = blob; },
  });
  const plan = service.preview(user, 'session-a');
  assert.equal(plan.ok, true);
  assert.equal(JSON.stringify(user), before);
  assert.equal(backups, 0); assert.equal(writes, 0);
  assert.doesNotMatch(JSON.stringify(plan), /fixture|apiSecret|keyId|ciphertext/);
  assert.equal(service.apply(user, 'session-b', plan.token, true).ok, false);
  const renewed = service.preview(user, 'session-a');
  assert.equal(service.apply(user, 'session-a', renewed.token, false).ok, false);
  const valid = service.preview(user, 'session-a');
  assert.equal(service.apply(user, 'session-a', valid.token, true).ok, true);
  assert.equal(backups, 1); assert.equal(writes, 1);
  assert.equal(user.krakenKey.keyId, 'second');
  assert.equal(getUserKrakenKeys(user).apiKey, 'fixture-key');
  assert.equal(service.apply(user, 'session-a', valid.token, true).ok, false);
  assert.equal(credentialStorageStatus(user).migrationNeeded, false);

  process.env[names[1]] = 'first';
  const expired = service.preview(user, 'session-a'); clock += 300001;
  assert.equal(service.apply(user, 'session-a', expired.token, true).ok, false);
  const stale = service.preview(user, 'session-a');
  setUserKrakenKey(user, 'changed-fixture', 'changed-fixture');
  assert.equal(service.apply(user, 'session-a', stale.token, true).ok, false);
  process.env[names[1]] = 'second';
  const rotated = service.preview(user, 'session-a');
  process.env[names[0]] = JSON.stringify({ second: Buffer.alloc(32, 41).toString('base64') });
  assert.equal(service.apply(user, 'session-a', rotated.token, true).ok, false);
  process.env[names[0]] = JSON.stringify({ first: a, second: b });
  const failed = createCredentialMaintenance({ backup: () => { throw Error('private-path'); }, persist: () => assert.fail('must not write') });
  const unchanged = JSON.stringify(user);
  const failPlan = failed.preview(user, 'session-a');
  const failResult = failed.apply(user, 'session-a', failPlan.token, true);
  assert.equal(failResult.ok, false);
  assert.doesNotMatch(JSON.stringify(failResult), /private-path/);
  assert.equal(JSON.stringify(user), unchanged);
  const wrongOwner = { ...user, id: 'other-owner' };
  assert.equal(service.preview(wrongOwner, 'session-a').ok, false);
} finally {
  names.forEach((n, i) => saved[i] === undefined ? delete process.env[n] : process.env[n] = saved[i]);
}
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.doesNotMatch(server, /^\s+persistUsers\(\);/m, 'key handlers must use the imported auth namespace');
const routes = server.slice(server.indexOf("app.post('/api/exchange-connections/kraken/storage-preview'"), server.indexOf("app.get('/api/exchange-connections'"));
assert.match(routes, /req.userAgent \|\| !req.session\?\.userId/);
assert.match(routes, /private, no-store/);
assert.match(routes, /req.sessionID/);
console.log('Credential maintenance checks passed');
