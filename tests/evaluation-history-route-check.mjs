import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const routes = server.slice(server.indexOf("app.post('/api/evaluation-lab'"), server.indexOf('// status endpoint', server.indexOf("app.post('/api/evaluation-lab'")));

assert.match(routes, /app\.post\('\/api\/evaluation-lab', publicLimiter, requireUser/);
assert.match(routes, /app\.get\('\/api\/evaluation-lab\/history', requireUser/);
assert.match(routes, /app\.get\('\/api\/evaluation-lab\/history\/compare', requireUser/);
assert.match(routes, /app\.get\('\/api\/evaluation-lab\/history\/:id\/export', requireUser/);
assert.match(routes, /app\.get\('\/api\/evaluation-lab\/history\/:id', requireUser/);
assert.equal((routes.match(/evaluationOwner\(req\)/g) || []).length, 5, 'every evaluation route must resolve a private owner');
assert.match(server, /function evaluationOwner\(req\)[\s\S]{0,420}req\.userAgent\?\.userId[\s\S]{0,180}return null/);
assert.match(routes, /Cache-Control', 'private, no-store'/);
assert.match(routes, /format must be json or csv/);
assert.match(routes, /X-Content-Type-Options': 'nosniff'/);
assert.doesNotMatch(routes, /enableLive|liveTrading|placeOrder|deploy|conversion|phase4|public-chain|broadcast|sendTransaction/);
assert.match(server, /app\.use\(sameOriginMutation\(SITE_URL\)\)/, 'global same-origin mutation guard must protect evaluation POST');

console.log('Evaluation history authorization and route security checks passed');
