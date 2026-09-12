import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialVault } from '../lib/credential-vault.js';
import { writeCredentialBackup } from '../lib/credential-backup.js';
const dir = mkdtempSync(join(tmpdir(), 'iost-recovery-fixture-'));
try {
  const ring = { activeKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 17).toString('base64') } };
  const payload = 'synthetic-recovery-payload';
  const record = { version: 1, provider: 'kraken', ownerId: 'fixture-owner', krakenKey: createCredentialVault(ring).seal('fixture-owner', 'kraken', payload) };
  writeCredentialBackup(dir, record);
  const file = join(dir, 'credential-backups', readdirSync(join(dir, 'credential-backups'))[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const serialized = readFileSync(file, 'utf8');
  assert(!serialized.includes(payload));
  const restored = JSON.parse(serialized);
  const recoveredVault = createCredentialVault(JSON.parse(JSON.stringify(ring)));
  assert.equal(recoveredVault.open(restored.ownerId, restored.provider, restored.krakenKey), payload);
  assert.equal(recoveredVault.open('wrong-owner', restored.provider, restored.krakenKey), null);
  const wrong = createCredentialVault({ activeKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 18).toString('base64') } });
  assert.equal(wrong.open(restored.ownerId, restored.provider, restored.krakenKey), null);
  restored.krakenKey.tag = Buffer.alloc(16).toString('base64');
  assert.equal(recoveredVault.open(restored.ownerId, restored.provider, restored.krakenKey), null);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Synthetic credential backup recovery checks passed; no production backup tested');
