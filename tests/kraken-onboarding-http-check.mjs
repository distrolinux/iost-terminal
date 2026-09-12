import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'iost-onboarding-http-'));
process.env.IOST_DATA_DIR = scratch;
const auth = await import('../lib/auth.js');
const agentKeys = await import('../lib/agent-keys.js');
const { user } = await auth.registerUser('onboarding-fixture@example.com', 'fixture-password-only');
const agent = agentKeys.createKey({ userId: user.id, name: 'fixture', scopes: ['read'] });
const port = 24000 + Math.floor(Math.random() * 2000), base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', './tests/onboarding-fetch-fixture.mjs', 'server.js'], { env: { ...process.env, PORT: String(port), SITE_URL: base, SESSION_SECRET: 'fixture-session-only', KRAKEN_READONLY_ONBOARDING_ENABLED: '1', IOST_CREDENTIAL_VAULT_FILE: '', IOST_CREDENTIAL_VAULT_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 15).toString('base64') }), IOST_CREDENTIAL_VAULT_ACTIVE_KEY_ID: 'v1', LIVE_TRADING_ENABLED: 'false', KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '', IOST_PIN_KEY: '', PUBLIC_CHAIN_ACTIONS_ENABLED: 'false' }, stdio: 'ignore' });
const exited = new Promise(resolve => child.once('exit', resolve));
const request = async (path, { body, cookie, key, method = body ? 'POST' : 'GET', origin = base } = {}) => {
  const r = await fetch(base + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'X-API-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, headers: r.headers, data: await r.json() };
};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert(ready);
  const path = '/api/exchange-connections/kraken/onboarding-preview';
  assert.equal((await request(path, { body: {} })).status, 401);
  const login = await request('/api/auth/login', { body: { email: 'onboarding-fixture@example.com', password: 'fixture-password-only' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/account/kraken', { method: 'PUT', cookie, body: {} })).status, 403);
  assert.equal((await request('/api/account/kraken', { method: 'DELETE', cookie, key: agent.key })).status, 403);
  assert.equal((await request(path, { cookie, body: {}, origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await request(path, { cookie, key: agent.key, body: {} })).status, 403);
  const status = await request('/api/exchange-connections', { cookie });
  assert.equal(status.data.onboarding.canConnect, true);
  const input = { apiKey: 'fixtureKeyForTestingOnly', apiSecret: Buffer.alloc(64, 6).toString('base64'), consent: true };
  const before = readFileSync(join(scratch, 'users.json'), 'utf8');
  const plan = await request(path, { cookie, body: input });
  assert.equal(plan.status, 200); assert.equal(plan.headers.get('cache-control'), 'private, no-store');
  assert.equal(readFileSync(join(scratch, 'users.json'), 'utf8'), before);
  const saved = await request('/api/exchange-connections/kraken/onboarding-commit', { cookie, body: { token: plan.data.token, confirmed: true } });
  assert.equal(saved.status, 200); assert.equal(saved.data.saved, true);
  const after = readFileSync(join(scratch, 'users.json'), 'utf8');
  assert(!after.includes(input.apiKey)); assert(!after.includes(input.apiSecret));
  assert.equal(JSON.parse(after)[0].krakenKey.version, 1);
  assert.equal(JSON.parse(after)[0].krakenKeyStatus.permissionsVerified, false);
  assert.equal((await request('/api/exchange-connections', { cookie })).data.onboarding.canConnect, false);
  const removed = await request('/api/account/kraken', { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  assert.equal(JSON.parse(readFileSync(join(scratch, 'users.json'), 'utf8'))[0].krakenKey, undefined);
} finally { child.kill('SIGTERM'); await exited; rmSync(scratch, { recursive: true, force: true }); }
console.log('Kraken onboarding HTTP checks passed');
