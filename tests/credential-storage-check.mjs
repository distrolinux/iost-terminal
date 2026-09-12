import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createCredentialMaintenance } from '../lib/credential-maintenance.js';
import { writeCredentialBackup } from '../lib/credential-backup.js';
import { getUserKrakenKeys } from '../lib/keys.js';

const scratch = mkdtempSync(join(tmpdir(), 'iost-credential-storage-'));
const vars = ['IOST_DATA_DIR', 'SESSION_SECRET', 'IOST_CREDENTIAL_VAULT_KEYS', 'IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID'];
const saved = vars.map(n => process.env[n]);
try {
  process.env.IOST_DATA_DIR = scratch;
  process.env.SESSION_SECRET = 'fixture-session-only';
  process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID = 'next';
  process.env.IOST_CREDENTIAL_VAULT_KEYS = JSON.stringify({ next: Buffer.alloc(32, 71).toString('base64') });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('iost-userkeys:fixture-session-only').digest(), iv);
  const data = Buffer.concat([cipher.update('fixture-key\nfixture-secret'), cipher.final()]);
  const legacy = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  const users = [{ id: 'fixture-owner', krakenKey: legacy, krakenKeyStatus: { configured: true } }, { id: 'unrelated-owner', preferences: { keep: true } }];
  const path = join(scratch, 'users.json');
  writeFileSync(path, JSON.stringify(users), { mode: 0o600 });
  const auth = await import('../lib/auth.js');
  const user = auth.findById('fixture-owner');
  const service = createCredentialMaintenance({ backup: r => writeCredentialBackup(scratch, r), persist: auth.persistCredentialReplacement });
  const before = readFileSync(path, 'utf8');
  const plan = service.preview(user, 'fixture-session');
  assert.equal(plan.ok, true);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(service.apply(user, 'fixture-session', plan.token, true).ok, true);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(stored[0].krakenKey.version, 1);
  assert.equal(getUserKrakenKeys(stored[0]).apiKey, 'fixture-key');
  assert.deepEqual(stored[1], users[1]);
  assert.deepEqual(stored[0].krakenKeyStatus, users[0].krakenKeyStatus);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const dir = join(scratch, 'credential-backups');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const backupFile = join(dir, readdirSync(dir)[0]);
  assert.equal(statSync(backupFile).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(backupFile, 'utf8'));
  assert.equal(getUserKrakenKeys({ id: record.ownerId, krakenKey: record.krakenKey }).apiKey, 'fixture-key', 'backup is recoverable with original key');
  assert.doesNotMatch(readFileSync(backupFile, 'utf8'), /fixture-secret|fixture-key|preferences/);
  writeCredentialBackup(scratch, record);
  assert.equal(readdirSync(dir).length, 2, 'existing private directory supports later backups');
  chmodSync(dir, 0o755);
  assert.throws(() => writeCredentialBackup(scratch, record), /unsafe backup/);
  chmodSync(dir, 0o700);

  // A failed atomic commit must preserve the in-memory record and prior disk file.
  const current = JSON.stringify(user);
  renameSync(path, join(scratch, 'users.saved'));
  mkdirSync(path);
  assert.throws(() => auth.persistCredentialReplacement(user, legacy));
  assert.equal(JSON.stringify(user), current);
  assert.equal(JSON.parse(readFileSync(join(scratch, 'users.saved'), 'utf8'))[0].krakenKey.version, 1);
  assert.equal(readdirSync(scratch).some(n => n.endsWith('.tmp')), false);
} finally {
  vars.forEach((n, i) => saved[i] === undefined ? delete process.env[n] : process.env[n] = saved[i]);
  rmSync(scratch, { recursive: true, force: true });
}
console.log('Credential backup, persistence and recovery checks passed');
