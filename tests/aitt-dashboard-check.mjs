// Signed-in AITT dashboard contract and fail-closed claim regressions.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { shouldAllowClaim, requestClaimIfOpen } from '../public/js/wallet-claims.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
const app = readFileSync(join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const tokenPage = readFileSync(join(ROOT, 'public', 'token.html'), 'utf8');

assert.match(server, /app\.get\('\/api\/aitt\/wallet', requireUser/);
assert.match(server, /app\.post\('\/api\/aitt\/wallet\/challenge', authLimiter, requireUser/);
assert.match(server, /app\.post\('\/api\/aitt\/wallet\/verify', authLimiter, requireUser/);
assert.match(server, /app\.get\('\/api\/aitt\/claims', requireUser/);
assert.match(server, /listClaims\(userId\)/, 'claims must be tenant-scoped');
assert.match(server, /if \(!info\.conversion\.open\) return res\.status\(400\)/, 'claim must gate before writes');
assert.match(app, /challenge\.message/, 'the exact server challenge message must be rendered');
assert.match(app, /personal_sign/, 'wallet signing must use EIP-1193 personal_sign');
assert.doesNotMatch(app, /eth_sendTransaction/, 'pre-launch dashboard must not submit public-chain transactions');
assert.match(tokenPage, /<script src="\/js\/token\.js\?v=1\.1" defer><\/script>/, 'token dashboard must load the current cache-keyed script');

assert.equal(shouldAllowClaim({ conversion: { open: false, statusText: 'closed — pre-launch review hold' } }), false);
let calls = 0;
const closed = await requestClaimIfOpen({ gate: { conversion: { open: false, statusText: 'closed — pre-launch review hold' } }, request: async () => { calls++; } });
assert.equal(calls, 0, 'closed conversion must not send a claim request');
assert.equal(closed.sent, false);
assert.equal(closed.reason, 'closed — pre-launch review hold');

const open = await requestClaimIfOpen({ gate: { conversion: { open: true, releaseGate: { ready: true } } }, request: async () => { calls++; return { ok: true }; } });
assert.equal(open.sent, true);
assert.equal(calls, 1);
console.log('AITT dashboard contract checks passed');
