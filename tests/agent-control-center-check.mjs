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
assert.match(html, /\/js\/app\.js\?v=2\.43\.0/,
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
assert.match(app, /item\.supervisor\?\.managed/,
  'control center must distinguish continuously supervised runtimes from manual heartbeats');
assert.match(app, /Agent Data Trust Firewall/,
  'control center must expose external-content and execution-evidence trust status');
assert.match(app, /Agent Execution Readiness/,
  'control center must expose the new-exposure readiness gate');
assert.match(app, /runtime supervision, incident quarantine, the 30-minute recovery probation, current fast\/slow SLO burn/,
  'control center must explain the composed fail-closed evidence');
assert.match(app, /cumulative SLO budget remains visible as advisory history/,
  'control center must distinguish historical SLO evidence from present execution safety');
assert.match(app, /content cannot authorize execution/,
  'control center must state that external content has no execution authority');
assert.match(app, /Agent Capability &amp; Delegation Registry/,
  'control center must expose effective agent capability evidence');
assert.match(app, /Effective authority is derived[\s\S]{0,400}self-declared skills never grant permission/,
  'control center must distinguish descriptive claims from server authority');

console.log('agent control center checks passed');
