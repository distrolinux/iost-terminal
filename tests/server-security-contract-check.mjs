// Route-wiring regressions for authorization and task-scoped spending.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
let failures = 0;
const ok = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};
const route = (needle, nextNeedle) => {
  const start = src.indexOf(needle);
  const end = src.indexOf(nextNeedle, start + needle.length);
  return start >= 0 && end > start ? src.slice(start, end) : '';
};

const closeRoute = route("app.post('/api/paper/close'", "app.post('/api/paper/reset'");
ok('paper close requires trade-paper scope', /userAgentHas\(req,\s*'trade-paper'\)/.test(closeRoute));

const reserveRoute = route("app.post('/api/spend/reserve'", "app.post('/api/spend/commit'");
ok('spend reserve requires a pact id', /pactId required/.test(reserveRoute));
ok('spend reserve checks pact policies', /checkPactSpend/.test(reserveRoute));
ok('spend reserve binds pact metadata to reservation', /pactId,\s*recipient,\s*protocol/.test(reserveRoute));

const commitRoute = route("app.post('/api/spend/commit'", "app.post('/api/spend/release'");
ok('spend commit uses the reserved pact identity', /r\.pactId/.test(commitRoute) && !/req\.body[^\n]*pactId/.test(commitRoute));

const aittAdminRoute = route("app.get('/api/admin/aitt/status'", "app.post('/api/admin/aitt/claims/:id/approved'");
ok('AITT owner dashboard endpoint requires owner session', /isOwnerSession\(req\)/.test(aittAdminRoute));
ok('AITT owner dashboard exposes release gates and claims without mutation controls', /releaseGate/.test(aittAdminRoute) && /listClaims\(\)/.test(aittAdminRoute) && !/conversionOpen\s*=|phase4Enabled\s*=|writeFile|child_process/.test(aittAdminRoute));
ok('whitepaper route serves the public distribution copy', /app\.get\('\/whitepaper'[\s\S]*AITT-Whitepaper-v1\.0\.md/.test(src));

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);