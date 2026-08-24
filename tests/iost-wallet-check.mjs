// tests/iost-wallet-check.mjs — E2E verification of the free-IOST-wallet flow.
// Real HTTP against the running server (localhost:8787) with a real tweetnacl
// keypair. Verifies: public status, request→pending, store correctness, duplicate
// block, name/pubkey validation, honest GET, 401s, and that NO secret key ever
// reaches the server (store + server.log + audit).
// Run:  node tests/iost-wallet-check.mjs   (server must be running)
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:8787';
const STORE = join(ROOT, 'data', 'iost_accounts.json');
const LOG = join(ROOT, 'server.log');

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// minimal cookie jar
const jar = {};
function cookies(res) {
  const sc = res.headers.getSetCookie?.() || [];
  for (const c of sc) { const [pair] = c.split(';'); const [k, v] = pair.split('='); jar[k] = v; }
  return res;
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const jget = async (path) => cookies(await fetch(BASE + path, { headers: { cookie: cookieHeader() } }));
const jpost = async (path, body) => cookies(await fetch(BASE + path, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader() }, body: JSON.stringify(body || {}),
}));

// real Ed25519 keypair (the exact browser flow: tweetnacl sign keypair)
const kp = nacl.sign.keyPair();
const pubB64 = Buffer.from(kp.publicKey).toString('base64');
const secretB58 = bs58.encode(kp.secretKey); // used ONLY to prove it never reaches the server

const ts = Date.now();
const EMAIL = `wallet.test.${ts}@test.local`;
const PASS = 'WalletTest!2026';

console.log(`\n== free-IOST-wallet E2E (user ${EMAIL}) ==\n`);

// 1. public status endpoint — no auth, honest numbers
{
  const r = await jget('/api/account/iost/status');
  const d = await r.json();
  ok('public status 200', r.status === 200, `HTTP ${r.status}`);
  ok('public status body', d.subsidized === true && d.feeIost === 0 && d.configured === false,
    `subsidized=${d.subsidized} feeIost=${d.feeIost} configured=${d.configured}`);
  ok('public status action+explorer', d.action === 'auth.iost/signUp' && /^https:\/\/explorer\.iost\.io\/tx\//.test(d.explorer || ''));
}

// 2. unauthenticated access → 401 (both GET and POST)
{
  const g = await fetch(BASE + '/api/account/iost');
  const p = await fetch(BASE + '/api/account/iost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok('unauth GET 401', g.status === 401, `HTTP ${g.status}`);
  ok('unauth POST 401', p.status === 401, `HTTP ${p.status}`);
}

// 3. register a fresh user (auto-login session)
{
  const r = await jpost('/api/auth/register', { email: EMAIL, password: PASS });
  const d = await r.json();
  ok('register new user', r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(d).slice(0, 120)}`);
}

// 4. fresh wallet status → none
{
  const r = await jget('/api/account/iost');
  const d = await r.json();
  ok('fresh GET status none', r.status === 200 && d.status === 'none' && d.accountName === null, `HTTP ${r.status} ${JSON.stringify(d)}`);
}

// 5. request creation with a REAL pubkey → queued pending (no key configured)
let pendingName = null;
{
  const r = await jpost('/api/account/iost', { publicKey: pubB64 });
  const d = await r.json();
  ok('request → 202 queued', r.status === 202 && d.ok === true, `HTTP ${r.status} ${JSON.stringify(d).slice(0, 160)}`);
  ok('request status pending', d.status === 'pending', `status=${d.status}`);
  ok('request derived name u<hex>', /^u[0-9a-f]{8,10}$/.test(d.accountName || ''), `name=${d.accountName}`);
  pendingName = d.accountName;
}

// 6. store entry correct — publicKey present, NO secretKey field, status pending
{
  const store = JSON.parse(readFileSync(STORE, 'utf8'));
  const entry = Object.values(store.byUserId).find((e) => e.accountName === pendingName);
  ok('store entry exists', !!entry, pendingName);
  ok('store status pending + name', entry?.status === 'pending' && entry?.accountName === pendingName);
  ok('store publicKey == posted pubkey', entry?.publicKey === pubB64);
  ok('store has NO secretKey/seed field', !('secretKey' in (entry || {})) && !('seed' in (entry || {})) && !('privateKey' in (entry || {})),
    JSON.stringify(Object.keys(entry || {}).filter((k) => /secret|seed|private/i.test(k))));
  ok('store referrer null (queued)', entry?.referrer === null && entry?.tx === null);
}

// 7. GET status honest after request → pending
{
  const r = await jget('/api/account/iost');
  const d = await r.json();
  ok('GET after request pending', r.status === 200 && d.status === 'pending' && d.accountName === pendingName && d.tx === null,
    `HTTP ${r.status} ${JSON.stringify(d)}`);
}

// 8. duplicate request → 409 blocked
{
  const r = await jpost('/api/account/iost', { publicKey: pubB64 });
  const d = await r.json();
  ok('duplicate blocked 409', r.status === 409 && /already (pending|created)/.test(d.error || ''), `HTTP ${r.status} ${d.error}`);
}

// 9. validation: bad name → 400
{
  const r = await jpost('/api/account/iost', { accountName: 'BAD NAME!', publicKey: pubB64 });
  const d = await r.json();
  ok('bad name → 400', r.status === 400 && /invalid account name/.test(d.error || ''), `HTTP ${r.status} ${d.error}`);
}

// 10. validation: bad pubkey (wrong length) → 400
{
  const r = await jpost('/api/account/iost', { publicKey: Buffer.from(kp.publicKey.slice(0, 16)).toString('base64') });
  const d = await r.json();
  ok('short pubkey → 400', r.status === 400 && /32 bytes/.test(d.error || ''), `HTTP ${r.status} ${d.error}`);
}

// 11. validation: garbage pubkey → 400
{
  const r = await jpost('/api/account/iost', { publicKey: 'not-base64!!' });
  ok('garbage pubkey → 400', r.status === 400, `HTTP ${r.status}`);
}

// 12. custom valid name honored; second user claiming the same name → 409
{
  const r2 = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `wallet.test2.${ts}@test.local`, password: PASS }) });
  const jar2 = {};
  for (const c of (r2.headers.getSetCookie?.() || [])) { const [pair] = c.split(';'); const [k, v] = pair.split('='); jar2[k] = v; }
  const ck = () => Object.entries(jar2).map(([k, v]) => `${k}=${v}`).join('; ');
  const customName = `w${ts.toString(16).slice(-8)}`;
  const r3 = await fetch(BASE + '/api/account/iost', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck() }, body: JSON.stringify({ accountName: customName, publicKey: pubB64 }) });
  const d3 = await r3.json();
  ok('custom name honored', r3.status === 202 && d3.accountName === customName, `HTTP ${r3.status} name=${d3.accountName}`);
  // same user's status is pending — now a THIRD user claims the same name
  const r4 = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `wallet.test3.${ts}@test.local`, password: PASS }) });
  const jar3 = {};
  for (const c of (r4.headers.getSetCookie?.() || [])) { const [pair] = c.split(';'); const [k, v] = pair.split('='); jar3[k] = v; }
  const ck3 = () => Object.entries(jar3).map(([k, v]) => `${k}=${v}`).join('; ');
  const r5 = await fetch(BASE + '/api/account/iost', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck3() }, body: JSON.stringify({ accountName: customName, publicKey: pubB64 }) });
  const d5 = await r5.json();
  ok('claimed name → 409', r5.status === 409 && /already claimed/.test(d5.error || ''), `HTTP ${r5.status} ${d5.error}`);
}

// 13. no secret key ever reached the server: server.log + audit + store
{
  const secretChecks = [];
  const logText = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  secretChecks.push(['server.log', !logText.includes(secretB58)]);
  secretChecks.push(['store', !readFileSync(STORE, 'utf8').includes(secretB58)]);
  const audit = await (await fetch(BASE + '/api/audit')).json();
  const auditText = JSON.stringify(audit);
  secretChecks.push(['audit', !auditText.includes(secretB58)]);
  for (const [where, cond] of secretChecks) ok(`secret key absent from ${where}`, cond);
}

console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURES ❌'}`);
process.exit(failures === 0 ? 0 : 1);
