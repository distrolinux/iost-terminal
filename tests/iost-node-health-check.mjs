// Pure health derivation checks for the operator-node trust surface.
import assert from 'node:assert/strict';
import { deriveIostNodeHealth } from '../lib/iost-node.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const now = 1_700_000_000_000;
const ns = (ms) => String(BigInt(ms) * 1_000_000n);
const chain = {
  chain_id: 1024, net_name: 'mainnet', head_block: '200', lib_block: '197',
  head_block_time: ns(now - 2_000), lib_block_time: ns(now - 3_500),
};
const node = { code_version: '3.11.5', mode: 'ModeNormal', tx_pool_size: '4', network: { peer_count: 30, peer_count_inbound: 20, peer_count_outbound: 10 } };

const healthy = deriveIostNodeHealth(chain, node, now, 42);
assert.equal(healthy.status, 'healthy');
assert.equal(healthy.expectedNetwork, true);
assert.equal(healthy.fresh, true);
assert.equal(healthy.finalityGapBlocks, 3);
assert.equal(healthy.finalityLagSec, 1.5);
assert.equal(healthy.peerCount, 30);
assert.equal(healthy.responseMs, 42);

const stale = deriveIostNodeHealth({ ...chain, head_block_time: ns(now - 31_000) }, node, now);
assert.equal(stale.status, 'degraded');
assert.equal(stale.fresh, false);

const wrongNetwork = deriveIostNodeHealth({ ...chain, chain_id: 182, net_name: 'l2' }, node, now);
assert.equal(wrongNetwork.status, 'degraded');
assert.equal(wrongNetwork.expectedNetwork, false);

const offline = deriveIostNodeHealth(null, null, now);
assert.equal(offline.status, 'offline');
assert.equal(offline.headBlock, 0);

const chainSource = readFileSync(join(process.cwd(), 'lib/chain.js'), 'utf8');
const appSource = readFileSync(join(process.cwd(), 'public/js/app.js'), 'utf8');
assert.doesNotMatch(chainSource, /rpc:\s*RPC/, 'chain status must not expose a private RPC URL');
assert.match(appSource, /mainnet · \$\{nodeStatus\}/, 'on-chain UI must use derived node health');
assert.doesNotMatch(appSource, /c\.live \? '<span class="up">● live/, 'on-chain UI must not read live from the wrong object');
assert.match(appSource, /\$\{c\.sampleTransactions\} txs[\s\S]*sampled blocks/, 'sampled activity must not be labeled as 24h');

console.log('IOST node health checks passed');
