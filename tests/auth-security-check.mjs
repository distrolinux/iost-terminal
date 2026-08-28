// Regression: production password-reset tokens must never be printed to logs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'production';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
const scratch = mkdtempSync(join(tmpdir(), 'iost-auth-security-'));
process.env.IOST_DATA_DIR = scratch;

const { registerUser, sendResetEmail } = await import('../lib/auth.js');
const token = 'sensitive-reset-token-for-regression';
const seen = [];
const originalLog = console.log;
console.log = (...args) => seen.push(args.join(' '));
let result;
try {
  result = await sendResetEmail('owner@test.local', token, 'iostcallister.com');
} finally {
  console.log = originalLog;
}

if (seen.join('\n').includes(token)) {
  console.error('FAIL  production reset token reached console output');
  process.exit(1);
}
if (result?.mode !== 'disabled') {
  console.error('FAIL  production without SMTP must fail closed', result);
  process.exit(1);
}
const multibyteOverflow = await registerUser('unicode-overflow@test.local', '🔐'.repeat(19));
assert.equal(multibyteOverflow.ok, false, 'passwords beyond 72 UTF-8 bytes must be rejected');
assert.match(multibyteOverflow.error, /72 UTF-8 bytes/);
const exactBoundary = await registerUser('boundary@test.local', 'a'.repeat(72));
assert.equal(exactBoundary.ok, true, 'a password exactly at bcrypt byte boundary remains valid');
rmSync(scratch, { recursive: true, force: true });
console.log('PASS  production reset delivery fails closed without logging tokens');
console.log('PASS  bcrypt byte boundary is enforced for ASCII and multibyte passwords');
