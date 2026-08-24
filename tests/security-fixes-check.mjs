// Regression contracts for the confirmed security fixes. Read-only: no app stores are imported.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const authRoutes = readFileSync(join(ROOT, 'lib', 'auth-routes.js'), 'utf8');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
const agentKeys = readFileSync(join(ROOT, 'lib', 'agent-keys.js'), 'utf8');
const auth = readFileSync(join(ROOT, 'lib', 'auth.js'), 'utf8');
const sessions = readFileSync(join(ROOT, 'lib', 'session-store.js'), 'utf8');
let failures = 0;
const ok = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`); if (!condition) failures++; };

ok('TOTP requires pending session state', /req\.session\?\.pendingTotp/.test(authRoutes) && /auth\.findById\(pending\.userId\)/.test(authRoutes));
ok('TOTP state expires and is cleared on failure/success', /expiresAt > Date\.now\(\)/.test(authRoutes) && (authRoutes.match(/clearPendingTotp\(req\)/g) || []).length >= 3);
ok('password success creates pending TOTP state', /savePendingTotp\(req, result\.user\)/.test(authRoutes));
ok('anonymous MCP has no proposals tool or handler', !/name: 'proposals'/.test(server) && !/case 'proposals'/.test(server));
ok('autopilot REST reads are owner-only', /app\.get\('\/api\/autopilot'[\s\S]*?owner only/.test(server) && /app\.get\('\/api\/autopilot\/proposals'[\s\S]*?owner only/.test(server));
ok('public SSR omits pending proposal reasoning', !/pendingProposals/.test(server) && !/<dt>Pending proposals<\/dt>/.test(server));
ok('agent-key atomic writes are 0600 before and after rename', /writeFileSync\(tmp, JSON\.stringify\(store, null, 2\), \{ mode: 0o600 \}\)/.test(agentKeys) && /renameSync\(tmp, STORE_FILE\);\s*chmodSync\(STORE_FILE, 0o600\)/.test(agentKeys));
ok('users and sessions retain 0600 after atomic rename', /renameSync\(tmp, FILE\);\s*chmodSync\(FILE, 0o600\)/.test(auth) && /renameSync\(tmp, FILE\);\s*chmodSync\(FILE, 0o600\)/.test(sessions));
ok('session-secret is chmod-checked and boot fails closed', /statSync\(f\)\.mode/.test(server) && /refusing boot/.test(server));

console.log(failures === 0 ? '\\nALL PASS ✅' : `\\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
