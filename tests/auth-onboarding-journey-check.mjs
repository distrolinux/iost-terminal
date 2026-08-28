// Static contracts for the account-entry and first-run journey. Runtime browser
// coverage is performed against a scratch IOST_DATA_DIR during release review.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const authUi = readFileSync(join(ROOT, 'public/js/auth.js'), 'utf8');
const authRoutes = readFileSync(join(ROOT, 'lib/auth-routes.js'), 'utf8');
const authStore = readFileSync(join(ROOT, 'lib/auth.js'), 'utf8');
const app = readFileSync(join(ROOT, 'public/app.html'), 'utf8');
const appUi = readFileSync(join(ROOT, 'public/js/app.js'), 'utf8');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');

assert.match(authStore, /process\.env\.IOST_DATA_DIR \|\| join\(ROOT, 'data'\)/,
  'auth audits must support an isolated scratch data directory');
assert.match(server, /process\.env\.SITE_URL \|\| 'https:\/\/iostcallister\.com'/,
  'browser security audits must support an explicit local same-origin target');
assert.match(authUi, /gate\.dataset\.authCovered = '1'[\s\S]*gate\.classList\.add\('hidden'\)/,
  'opening account entry must hide the underlying modal gate');
assert.match(appUi, /coveredByAuth = gate\.dataset\.authCovered === '1'[\s\S]*ok \|\| dismissed \|\| coveredByAuth/,
  'later gate refreshes must not reopen a gate covered by account entry');
assert.match(authUi, /gate\?\.dataset\.authCovered === '1'[\s\S]*!this\.state\.loggedIn\) gate\.classList\.remove\('hidden'\)/,
  'closing account entry must restore the gate only for anonymous users');
assert.match(authUi, /if \(r\.accountCreated\)[\s\S]*this\.show\('login'\)[\s\S]*Account created\. Sign in to continue\./,
  'a created account with a failed automatic sign-in must continue at sign-in');
assert.match(authRoutes, /accountCreated: true/,
  'registration must distinguish account creation from automatic sign-in');
assert.match(authRoutes, /req\.session\.destroy\(\(err\)[\s\S]*status\(503\)[\s\S]*untrackSession/,
  'logout must not claim success or untrack a session before destruction succeeds');
assert.match(authUi, /result\.status !== 200 \|\| !result\.ok[\s\S]*Sign out failed/,
  'the client must preserve authenticated state when logout fails');
assert.match(authUi, /const labels = \{[\s\S]*signup: 'Create account'[\s\S]*setAttribute\('aria-label', label\)/,
  'account dialogs must expose labels matching the active step');
assert.match(app, /\/js\/auth\.js\?v=2\.9\.0/,
  'account journey changes must be cache-versioned');
assert.match(app, /\/js\/app\.js\?v=2\.18\.0/,
  'gate journey changes must be cache-versioned');

console.log('Auth and onboarding journey contracts passed');
