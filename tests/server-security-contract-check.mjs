// Route-wiring regressions for authorization and task-scoped spending.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
const tokenUi = readFileSync(join(ROOT, 'public', 'js', 'token.js'), 'utf8');
const appUi = readFileSync(join(ROOT, 'public', 'js', 'app.js'), 'utf8');
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
const closeExecution = route('async function executePaperClose', '// queue flush:');
const paperScopeGate = route('function missingPaperExecutionScope', 'async function executePaperOpen');
ok('paper close requires trade-paper scope and returns receipt evidence',
  /userAgentHas\(req,\s*'trade-paper'\)/.test(paperScopeGate)
  && /missingPaperExecutionScope\(req, source\)/.test(closeExecution)
  && /trade-paper-scope-required/.test(closeExecution)
  && /executePaperClose\(req/.test(closeRoute));

const liveDisableRoute = route("app.post('/api/account/live/disable'", "// ---- live execution");
ok('live disable requires an allowlisted owner browser session',
  /req\.session\?\.userId/.test(liveDisableRoute) && /isOwnerSession\(req\)/.test(liveDisableRoute));

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
ok('public Add Token requires a successful live deployment probe', /releaseGate\?\.live\?\.verified === true/.test(tokenUi));
ok('conversion wallet flow enforces IOST L2 before signing or sending', /ensureIostL2Wallet/.test(appUi) && /wallet_switchEthereumChain/.test(appUi) && /await ensureIostL2Wallet\(\)/.test(appUi));

const globalOriginGuard = src.indexOf('app.use(sameOriginMutation(SITE_URL))');
const firstAccountMutation = src.indexOf("app.post('/api/paper/open'");
ok('same-origin mutation guard covers the full browser API surface',
  globalOriginGuard > 0 && firstAccountMutation > globalOriginGuard);

ok('OAuth bearer authentication revalidates the source agent key',
  /agentKeys\.isActiveKey\(entry\.keyId, entry\.userId\)/.test(src));

const agentSpendGate = route('function agentSpendGate(', '// queue flush:');
ok('agent spend gate covers platform and per-user agent credentials',
  /req\.agentKey\s*\|\|\s*req\.userAgent/.test(agentSpendGate));
ok('agent spend gate fails closed without wallet, price, or Pact',
  /agent-wallet-required/.test(agentSpendGate)
  && /trusted-entry-required/.test(agentSpendGate)
  && /pact-required/.test(agentSpendGate)
  && !/AGENT_SPEND_ENFORCE/.test(agentSpendGate));
ok('agent paper execution reserves both limits and Pact capacity',
  /checkPactSpend/.test(agentSpendGate)
  && /reserveSpend/.test(agentSpendGate)
  && /reservePactSpend/.test(agentSpendGate));

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
