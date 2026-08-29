import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');

assert.match(server, /app\.get\('\/api\/agent-control',\s*requireUser/,
  'setup data must stay behind authenticated owner control');
assert.match(server, /agent-control[\s\S]{0,500}isOwnerSession\(req\)/,
  'setup data must stay owner-only');
assert.match(server, /parentWallet[\s\S]{0,180}balanceMinor/,
  'control snapshot must expose only the owner paper-wallet balance');
assert.match(server, /ownerPacts[\s\S]{0,1200}pactId[\s\S]{0,1200}intent/,
  'control snapshot must expose Pact status without raw credentials');
assert.match(server, /function agentWalletOwnerIds\(req\)[\s\S]{0,500}req\.userAgent\?\.userId/,
  'scoped user keys may use a wallet created by their signed-in owner');
assert.match(server, /function findAgentWalletForRequest[\s\S]{0,700}owners\.includes\(wallet\.ownerId\)/,
  'wallet lookup must reject another user or agent owner');
assert.match(server, /agentSpendGate[\s\S]{0,1100}findAgentWalletForRequest\(req, walletId\)/,
  'paper agent execution must use the owner-bound wallet lookup');
const controlRoute = server.slice(server.indexOf("app.get('/api/agent-control'"), server.indexOf("app.post('/api/agent-control/emergency-stop'"));
assert.doesNotMatch(controlRoute, /\b(hash|secret|apiKey)\s*:/,
  'control snapshot must not expose secrets or key hashes');

assert.match(app, /Paper trade setup[\s\S]{0,500}internal paper credits only/,
  'owner UI must label setup as paper-only');
assert.match(app, /capabilities: \['trade\.paper'\]/,
  'setup must create only paper-trading wallets');
assert.doesNotMatch(app, /capabilities:\s*\[[^\]]*trade\.live/,
  'setup must never grant live trading capability');
assert.match(app, /\/api\/wallets\/credit/,
  'setup may add internal paper credits through the guarded route');
assert.match(app, /\/api\/pacts[\s\S]{0,800}approvalRequired: true/,
  'Pact proposals must retain an owner-approval policy');
assert.match(app, /Approve paper Pact/,
  'owner UI must expose a separate Pact approval action');
assert.match(app, /live, token, or on-chain execution/,
  'Pact approval must disclose the execution boundary');
assert.match(app, /\/api\/pacts\/\$\{b\.dataset\.pactTerminate\}\/terminate/,
  'owner must be able to end an active Pact');
assert.match(css, /\.control-paper-setup/, 'paper-setup UI must have responsive styling');

console.log('owner paper setup UI checks passed');
