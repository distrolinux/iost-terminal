import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const live = readFileSync(new URL('../lib/live.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

assert.match(server, /app\.get\('\/api\/agent-control',\s*requireUser/,
  'agent-control snapshot must require authentication');
assert.match(server, /\/api\/agent-control[\s\S]{0,500}isOwnerSession\(req\)/,
  'agent-control snapshot must be owner-session-only');
assert.match(server, /app\.post\('\/api\/agent-control\/emergency-stop',\s*requireUser/,
  'emergency stop must require authentication');
assert.match(server, /emergency-stop[\s\S]{0,1800}stopAutopilot\(\)/,
  'emergency stop must stop autopilot');
assert.match(server, /emergency-stop[\s\S]{0,1800}setWalletStatus\([^,]+,\s*'suspended'\)/,
  'emergency stop must suspend owner agent wallets');
assert.match(server, /emergency-stop[\s\S]{0,1800}disableLive\(/,
  'emergency stop must invoke the live kill switch');
assert.doesNotMatch(server, /agent-control[\s\S]{0,3000}\b(hash|secret|apiKey)\s*:/,
  'agent-control response must not expose key hashes or secrets');
assert.match(server, /function isOwnerSession\(req\)[\s\S]{0,180}isOwnerIdentity\(u\.email\)/,
  'paper-launch owner controls must not depend on live trading being enabled');
assert.match(live, /export function isOwnerIdentity\(email\)/,
  'owner identity must be explicit and separately reusable');
assert.match(live, /export function isLiveAllowed\(email\)[\s\S]{0,180}liveOwnerConfig\(\)/,
  'real-money eligibility must remain behind the live feature gate');

assert.match(html, /data-view="control"/,
  'sidebar must expose the owner control center');
assert.match(html, /id="view-control"/,
  'app must include the control-center view');
assert.match(html, /\/js\/app\.js\?v=2\.34\.0/,
  'app asset cache key must be bumped');

assert.match(app, /async function renderAgentControl\(\)/,
  'control-center renderer must exist');
assert.match(app, /Execution boundary[\s\S]{0,500}PAPER/,
  'control center must state the paper-only boundary');
assert.match(app, /Current task[\s\S]{0,800}Last action/,
  'control center must show current and last agent activity');
assert.match(app, /confirm\([^)]+emergency/i,
  'emergency stop must require explicit confirmation');
assert.match(app, /\/api\/agent-control\/emergency-stop/,
  'control center must call the guarded emergency endpoint');
assert.match(app, /dailyUsedMinor[\s\S]{0,800}weeklyUsedMinor/,
  'control center must display enforced budget usage');
assert.match(app, /scopes/,
  'control center must display agent-key permissions');

console.log('agent control center checks passed');
