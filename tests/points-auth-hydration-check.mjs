// Regression: a signed-in session must hydrate Points after a hard refresh.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'public', 'js', 'app.js'), 'utf8');
let failures = 0;
const ok = (name, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures++;
};

const authChange = app.match(/window\.addEventListener\('authchange',[\s\S]*?\n\}\);\nsetTimeout\(applyAuthGate, 2500\)/)?.[0] || '';
ok('authchange handler exists', authChange.length > 0);
ok('auth hydration refreshes the active view', /refreshView\(state\.activeView\)/.test(authChange));
ok('Points is included in auth-gated hydration',
  /\[[^\]]*'points'[^\]]*\]\.includes\(state\.activeView\)/.test(authChange));

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
