import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'iost-settlement-http-'));
process.env.IOST_DATA_DIR = scratch;
process.env.IOST_CREDENTIAL_VAULT_FILE = '';
process.env.IOST_CREDENTIAL_VAULT_KEYS = '';
const auth = await import('../lib/auth.js');
const { createKey } = await import('../lib/agent-keys.js');
const a = (await auth.registerUser('settlement-a@example.com', 'fixture-password-only')).user;
const b = (await auth.registerUser('settlement-b@example.com', 'fixture-password-only')).user;
const agent = createKey({ userId: a.id, name: 'fixture', scopes: ['read'] });
const directory = join(scratch, 'live-settlement-history', createHash('sha256').update(a.id).digest('hex'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const markerPath = join(directory, 'review-required.json');
const marker = JSON.stringify({ version: 1, reasonCode: 'recorded-fill-changed', previousDigest: 'a'.repeat(64), incomingDigest: 'b'.repeat(64) });
writeFileSync(markerPath, marker, { mode: 0o600 });
const port = 29000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', './tests/onboarding-fetch-fixture.mjs', 'server.js'], { env: { ...process.env, PORT: String(port), SITE_URL: base, SESSION_SECRET: 'fixture-session-only', LIVE_TRADING_ENABLED: 'false', KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', IOST_PIN_KEY: '' }, stdio: 'ignore' });
const exited = new Promise(resolve => child.once('exit', resolve));
const login = async user => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'fixture-password-only' }) });
  assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0];
};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready);
  const path = '/api/exchange-connections';
  assert.equal((await fetch(base + path)).status, 401);
  const cookieA = await login(a), cookieB = await login(b);
  assert.equal((await fetch(base + path, { headers: { Cookie: cookieA, 'X-API-Key': agent.key } })).status, 403);
  const response = await fetch(base + path + '?ownerId=' + encodeURIComponent(b.id), { headers: { Cookie: cookieA } });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const review = (await response.json()).settlementReview;
  assert.equal(review.status, 'review-required'); assert.equal(review.reasonCode, 'recorded-fill-changed');
  assert.equal(review.executionAuthorized, false); assert.equal(review.releaseAllowed, false);
  const other = await fetch(base + path + '?ownerId=' + encodeURIComponent(a.id), { headers: { Cookie: cookieB } });
  assert.equal((await other.json()).settlementReview.status, 'not-observed');
  assert.equal(readFileSync(markerPath, 'utf8'), marker);
  assert.ok(!JSON.stringify(review).includes('a'.repeat(64)));
  const ui = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.ok(ui.includes('Settlement evidence review · Read-only'));
  assert.ok(ui.includes('does not contact Kraken, collect new evidence, clear holds or authorize trading'));
} finally { child.kill('SIGTERM'); await exited; rmSync(scratch, { recursive: true, force: true }); }
console.log('Settlement review owner-session HTTP isolation and read-only checks passed');
