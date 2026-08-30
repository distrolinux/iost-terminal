import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, '.tmp-self-service-agent-launchpad-http');
const PORT = 19787 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

let logs = '';
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    IOST_DATA_DIR: SCRATCH,
    PORT: String(PORT),
    SITE_URL: BASE,
    SESSION_SECRET: 'launchpad-http-integration-session-secret-32-bytes',
    LIVE_TRADING_ENABLED: 'false',
    AITT_CONVERSION_ENABLED: 'false',
    PUBLIC_CHAIN_ACTIONS_ENABLED: 'false',
    AUTH_RATE_LIMIT: '50',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childExited = new Promise((resolve) => child.once('exit', resolve));
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`scratch server did not become ready\n${logs}`);
}

async function request(path, { method = 'GET', cookie = '', key = '', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-API-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, json: await response.json() };
}

async function register(email) {
  const result = await request('/api/auth/register', {
    method: 'POST', body: { email, password: 'correct-horse-battery-staple-42' },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.json));
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'registration must establish a signed-in human session');
  return cookie;
}

try {
  await waitForServer();
  const ownerCookie = await register('launchpad-owner@example.com');
  const outsiderCookie = await register('launchpad-outsider@example.com');

  const initial = await request('/api/agent-launchpad', { cookie: ownerCookie });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.json.mode, 'paper-only');
  assert.equal(initial.json.credit.lifetimeCapMinor, 10_000);

  // A pre-existing account wallet without a Pact must not hide the later
  // Launchpad wallet/Pact pair from agent authorization discovery.
  const legacyWallet = await request('/api/wallets', {
    method: 'POST', cookie: ownerCookie, body: {
      name: 'Older unpaired wallet',
      capabilities: ['trade.paper'],
      limits: { USD: { maxPerTxMinor: 1_000, dailyCapMinor: 2_000, weeklyCapMinor: 5_000 } },
    },
  });
  assert.equal(legacyWallet.response.status, 200, JSON.stringify(legacyWallet.json));

  const setupBody = { name: 'Bounded Paper Agent', fundMinor: 10_000, perOrderMinor: 2_500, dailyMinor: 5_000, expiryHours: 24 };
  const setup = await request('/api/agent-launchpad/setup', { method: 'POST', cookie: ownerCookie, body: setupBody });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.json));
  assert.equal(setup.json.wallets.length, 1);
  assert.deepEqual(setup.json.wallets[0].capabilities, ['trade.paper']);
  assert.equal(setup.json.credit.lifetimeGrantedMinor, 10_000);
  const pactId = setup.json.setup.pactId;

  const repeated = await request('/api/agent-launchpad/setup', { method: 'POST', cookie: ownerCookie, body: setupBody });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.json.wallets.length, 1, 'setup must be idempotent');
  assert.equal(repeated.json.credit.lifetimeGrantedMinor, 10_000, 'setup must not mint repeat credits');

  const keyResult = await request('/api/agent-keys', {
    method: 'POST', cookie: ownerCookie, body: { name: 'Launchpad regression agent', scopes: ['read', 'trade-paper'] },
  });
  assert.equal(keyResult.response.status, 200, JSON.stringify(keyResult.json));
  const keyBlocked = await request('/api/agent-launchpad', { key: keyResult.json.key });
  assert.equal(keyBlocked.response.status, 403, 'agent credentials cannot bootstrap their own authority');

  const outsiderApproval = await request(`/api/pacts/${pactId}/approve`, { method: 'POST', cookie: outsiderCookie, body: {} });
  assert.equal(outsiderApproval.response.status, 404, 'Pact ids must not grant cross-account approval authority');
  const ownerApproval = await request(`/api/pacts/${pactId}/approve`, { method: 'POST', cookie: ownerCookie, body: {} });
  assert.equal(ownerApproval.response.status, 200, JSON.stringify(ownerApproval.json));
  assert.equal(ownerApproval.json.pact.status, 'active');

  const authorizationResponse = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': keyResult.json.key,
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'agent_authorization_status',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'agent_authorization_status', arguments: {}, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { extensions: {} },
        'io.modelcontextprotocol/clientInfo': { name: 'launchpad-regression', version: '1.0.0' },
      } },
    }),
  });
  const authorization = await authorizationResponse.json();
  assert.equal(authorizationResponse.status, 200, JSON.stringify(authorization));
  assert.equal(authorization.result.structuredContent.wallet.walletId, setup.json.setup.walletId,
    'authorization must select the wallet that is actually bound to the active Pact');
  assert.equal(authorization.result.structuredContent.canOpenPaperTrade, true,
    'a valid Launchpad wallet/Pact pair must be reported ready even when an older wallet exists');

  const ownerTermination = await request(`/api/pacts/${pactId}/terminate`, { method: 'POST', cookie: ownerCookie, body: {} });
  assert.equal(ownerTermination.response.status, 200);
  const replacement = await request('/api/agent-launchpad/pact', { method: 'POST', cookie: ownerCookie, body: { expiryHours: 24 } });
  assert.equal(replacement.response.status, 201, JSON.stringify(replacement.json));
  assert.notEqual(replacement.json.setup.pactId, pactId);
  assert.equal(replacement.json.credit.lifetimeGrantedMinor, 10_000, 'replacement Pacts must never mint credits');

  console.log('self-service Agent Launchpad HTTP checks passed');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await childExited;
  rmSync(SCRATCH, { recursive: true, force: true });
}
