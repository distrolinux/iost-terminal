import { openSync, closeSync, writeFileSync, readFileSync, fsyncSync, fchmodSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Only encrypted credential envelopes, never a full account or decrypted secret.
export function writeCredentialBackup(dataDir, record) {
  const dir = join(dataDir, 'credential-backups');
  mkdirSync(dir, { mode: 0o700, recursive: true });
  writeBackupInDirectory(dir, record);
  const parent = openSync(dataDir, 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function writeBackupInDirectory(dir, record) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw Error('unsafe backup directory');
  const file = join(dir, `${randomUUID()}.json`);
  const fd = openSync(file, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    const serialized = JSON.stringify(record);
    writeFileSync(fd, serialized);
    fsyncSync(fd);
    if (readFileSync(file, 'utf8') !== serialized) throw Error('backup verification failed');
  } finally { closeSync(fd); }
  const directory = openSync(dir, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
