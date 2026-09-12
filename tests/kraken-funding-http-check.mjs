import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'iost-funding-http-'));
process.env.IOST_DATA_DIR = scratch;
process.env.IOST_CREDENTIAL_VAULT_FILE = '';
process.env.IOST_CREDENTIAL_VAULT_KEYS = JSON.stringify({ v1: Buffer.alloc(32, 71).toString('base64') });
process.env.IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID = 'v1';
const auth = await import('../lib/auth.js');
const { setUserKrakenKey } = await import('../lib/keys.js');
const { createKey } = await import('../lib/agent-keys.js');
const { user } = await auth.registerUser('funding-fixture@example.com', 'fixture-password-only');
setUserKrakenKey(user, 'fixture-not-real-key', Buffer.alloc(64, 72).toString('base64')); auth.persistUsers();
const agent = createKey({ userId: user.id, name: 'fixture', scopes: ['read'] });
const port = 28000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', './tests/onboarding-fetch-fixture.mjs', 'server.js'], { env: { ...process.env, PORT: String(port), SITE_URL: base, SESSION_SECRET: 'fixture-session-only', LIVE_TRADING_ENABLED: 'false', PUBLIC_CHAIN_ACTIONS_ENABLED: 'false', KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', IOST_PIN_KEY: '' }, stdio: 'ignore' });
const exited = new Promise(resolve => child.once('exit', resolve));
const request = async (path, body, cookie, key) => {
  const r = await fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'X-API-Key': key } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, data: await r.json() };
};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert(ready);
  const path = '/api/exchange-connections/kraken/verify';
  assert.equal((await request(path, { includeFundingEvidence: true })).status, 401);
  const login = await request('/api/auth/login', { email: user.email, password: 'fixture-password-only' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(path, { includeFundingEvidence: true }, cookie, agent.key)).status, 403);
  assert.equal((await request(path, { includeFundingEvidence: 'true' }, cookie)).status, 400);
  const before = readFileSync(join(scratch, 'users.json'), 'utf8');
  const result = await request(path, { includeFundingEvidence: true }, cookie);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.data.fundingEvidence.usdCashStatus, 'positive');
  assert.equal(result.data.executionAuthorized, false);
  assert.doesNotMatch(JSON.stringify(result.data), /12\.34|ZUSD|fixture-not-real-key/);
  assert.equal(readFileSync(join(scratch, 'users.json'), 'utf8'), before);
} finally { child.kill('SIGTERM'); await exited; rmSync(scratch, { recursive: true, force: true }); }
console.log('Owner-only held-funds HTTP checks passed');
