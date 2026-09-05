// Regression contract for the public IOSTCallister identity and strict L1/L2 split.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { iostChainIdentity } from '../lib/iost-node.js';

const identity = iostChainIdentity();
assert.equal(identity.operator.displayName, 'IOSTcallister');
assert.equal(identity.operator.account, 'iost_4_life');
assert.equal(identity.operator.role, 'IOST Layer 1 producer');
assert.equal(identity.operator.verified, true);
assert.equal(identity.operator.rankDynamic, true);
assert.equal('rank' in identity.operator, false, 'changing producer rank must not be hard-coded');
assert.match(identity.operator.explorer, /^https:\/\/iostscan\.com\/en\/account\/iost_4_life/);

assert.equal(identity.layers.l1.chainId, 1024);
assert.equal(identity.layers.l1.rpcInterface, 'IOST REST/RPC');
assert.match(identity.layers.l1.purpose.join(' '), /signal hash anchoring/);
assert.equal(identity.layers.l2.chainId, 182);
assert.equal(identity.layers.l2.rpcInterface, 'Ethereum JSON-RPC');
assert.equal(identity.layers.l2.token.symbol, 'AITT');
assert.equal(identity.layers.l2.token.status, 'pre-launch');
assert.equal(identity.layers.l2.token.issued, false);
assert.equal(identity.layers.l2.token.contractAddress, null);

const root = process.cwd();
const server = readFileSync(join(root, 'server.js'), 'utf8');
const onchain = readFileSync(join(root, 'lib/onchain.js'), 'utf8');
const app = readFileSync(join(root, 'public/js/app.js'), 'utf8');
const landing = readFileSync(join(root, 'public/index.html'), 'utf8');
const appHtml = readFileSync(join(root, 'public/app.html'), 'utf8');

assert.match(server, /app\.get\('\/api\/chain\/identity'/, 'server must expose the machine-readable chain identity');
assert.match(server, /chains: '\/api\/chain\/identity'/, 'agent manifest must advertise the chain identity');
assert.match(onchain, /identity: iostChainIdentity\(\)/, 'on-chain snapshot must carry the same identity');
assert.match(app, /IOST Dual-Chain Trust/);
assert.match(app, /Layer 1 node health[\s\S]*not the L2 token RPC/);
assert.match(app, /AITT status[\s\S]*NOT ISSUED/);
assert.match(landing, /IOSTcallister[\s\S]*verified Layer 1 producer identity/);
assert.match(landing, /AITT remains unissued[\s\S]*IOST Layer 2, EVM chain 182/);
assert.match(appHtml, /\/js\/app\.js\?v=2\.44\.0/, 'dual-chain UI must use a fresh asset version');

console.log('Dual-chain trust checks passed');
