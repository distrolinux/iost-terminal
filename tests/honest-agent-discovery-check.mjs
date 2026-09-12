import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('public/agents.html');
for (const phrase of ['Platform fee: $0 currently.', 'Unknown costs are not zero', 'real-money execution remains locked', 'not execution authority', 'private by default', '/auth.md', '/llms.txt', '/.well-known/agent.json']) assert.ok(page.includes(phrase), phrase);
assert.ok(!/<script|<form|<input/i.test(page), 'discovery page has no executable or credential-collection surface');
assert.ok(read('public/index.html').includes('href="/agents.html"'));
assert.ok(read('server.js').includes("agentGuide: '/agents.html'"));
assert.ok(read('server.js').includes("platformFee: 0"));
for (const path of ['public/llms.txt', 'public/llms-full.txt']) {
  assert.ok(read(path).includes('platform fee: $0 currently'));
  assert.ok(!read(path).includes('decentralized agent signals hash-pinned on the IOST mainnet'));
}
console.log('Honest agent discovery checks passed');
const kit = read('public/agent-connection-kit.md');
for (const text of ['tools/list', 'inputSchema', 'X-API-Key', 'read-only', 'outside IOST', 'Platform fee: $0']) assert.ok(kit.includes(text), text);
assert.ok(page.includes('/agent-connection-kit.md'));
assert.ok(read('server.js').includes("connectionKit: '/agent-connection-kit.md'"));
