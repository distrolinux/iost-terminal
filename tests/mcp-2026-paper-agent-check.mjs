import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, '.tmp-mcp-2026-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

const {
  MCP_MODERN_VERSION,
  MCP_LEGACY_VERSION,
  buildMcpTools,
  validateModernRequest,
  validateToolArguments,
  modernResult,
} = await import('../lib/mcp-protocol.js');
const { createMcpTaskStore } = await import('../lib/mcp-tasks.js');

const ok = (name, fn) => {
  fn();
  console.log(`ok - ${name}`);
};

const meta = {
  'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
};

ok('modern MCP version and bounded legacy compatibility are explicit', () => {
  assert.equal(MCP_MODERN_VERSION, '2026-07-28');
  assert.equal(MCP_LEGACY_VERSION, '2025-06-18');
});

ok('modern requests require matching protocol, method and name headers', () => {
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'health', arguments: {}, _meta: meta } };
  assert.deepEqual(validateModernRequest(message, {
    'mcp-protocol-version': MCP_MODERN_VERSION,
    'mcp-method': 'tools/call',
    'mcp-name': 'health',
  }), { ok: true });
  const mismatch = validateModernRequest(message, {
    'mcp-protocol-version': MCP_MODERN_VERSION,
    'mcp-method': 'tools/call',
    'mcp-name': 'paper_trade_open',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.error.code, -32020);
});

ok('base64 MCP names are decoded before comparison', () => {
  const name = 'health';
  const encoded = `=?base64?${Buffer.from(name).toString('base64')}?=`;
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {}, _meta: meta } };
  assert.equal(validateModernRequest(message, {
    'mcp-protocol-version': MCP_MODERN_VERSION,
    'mcp-method': 'tools/call',
    'mcp-name': encoded,
  }).ok, true);
});

ok('tool discovery is least privilege and never exposes live, token, or chain mutation', () => {
  const publicNames = buildMcpTools({ authenticated: false, scopes: [] }).map((tool) => tool.name);
  const readNames = buildMcpTools({ authenticated: true, scopes: ['read'] }).map((tool) => tool.name);
  const paperNames = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] }).map((tool) => tool.name);
  assert(!publicNames.includes('paper_account'));
  assert(readNames.includes('paper_account'));
  assert(!readNames.includes('paper_trade_open'));
  assert(paperNames.includes('paper_trade_open'));
  assert(paperNames.includes('paper_trade_close'));
  assert(readNames.includes('paper_execution_intents'));
  assert(paperNames.includes('evaluation_run'));
  for (const names of [publicNames, readNames, paperNames]) {
    assert(!names.some((name) => /live|token|chain.*(write|send|trade)|wallet.*send|swap|convert/i.test(name)));
  }
});

ok('all tools have deterministic schemas, structured outputs, and safety hints', () => {
  const tools = buildMcpTools({ authenticated: true, scopes: ['read', 'trade-paper'] });
  assert.deepEqual(tools.map((tool) => tool.name), [...tools.map((tool) => tool.name)].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(tool.inputSchema.type, 'object');
    assert(tool.outputSchema?.$schema);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
  }
  assert.equal(tools.find((tool) => tool.name === 'paper_trade_open').annotations.idempotentHint, true);
  assert.equal(tools.find((tool) => tool.name === 'paper_trade_close').annotations.idempotentHint, true);
});

ok('least-privilege discovery and schema validation stay within a local performance budget', () => {
  const access = { authenticated: true, scopes: ['read', 'trade-paper'] };
  const started = performance.now();
  for (let i = 0; i < 1_000; i++) {
    buildMcpTools(access);
    validateToolArguments('analyze_symbol', { symbol: 'AAPL' }, access);
  }
  assert(performance.now() - started < 1_500);
});

ok('tool arguments are bounded and validated before execution', () => {
  const access = { authenticated: true, scopes: ['read', 'trade-paper'] };
  const preflightFingerprint = 'a'.repeat(64);
  assert.equal(validateToolArguments('paper_trade_open', {
    intentId: 'paper-intent-0001', preflightFingerprint, symbol: 'AAPL', side: 'long', size: 1, entry: 10, stop: 9, maxSlippageBps: 50, walletId: 'wallet-1', pactId: 'pact-1',
  }, access).ok, true);
  assert.match(validateToolArguments('paper_trade_open', {
    intentId: 'paper-intent-0001', preflightFingerprint, symbol: 'AAPL', side: 'long', size: 1, entry: 10, stop: 9, maxSlippageBps: 50, walletId: 'wallet-1', pactId: 'pact-1', live: true,
  }, access).error, /live is not allowed/);
  assert.match(validateToolArguments('paper_trade_open', {
    symbol: 'AAPL', side: 'long', size: 1, entry: 10, walletId: 'wallet-1', pactId: 'pact-1',
  }, access).error, /intentId is required/);
  assert.match(validateToolArguments('paper_trade_open', {
    intentId: 'paper-intent-0001', symbol: 'AAPL', side: 'long', size: 1, entry: 10, stop: 9, maxSlippageBps: 50, walletId: 'wallet-1', pactId: 'pact-1',
  }, access).error, /preflightFingerprint is required/);
  assert.match(validateToolArguments('evaluation_run', {
    symbol: 'AAPL', strategy: {},
  }, access).error, /strategy\.entry is required/);
  let nested = {};
  for (let i = 0; i < 14; i++) nested = { next: nested };
  assert.match(validateToolArguments('evaluation_run', {
    symbol: 'AAPL', strategy: { entry: { rule: 'rsi' } }, config: nested,
  }, access).error, /maximum schema depth/);
  assert.equal(validateToolArguments('paper_trade_open', {}, { authenticated: false, scopes: [] }).error, 'unknown or unauthorized tool');
});

ok('modern results carry resultType, structured content, and server identity metadata', () => {
  const result = modernResult({ ok: true }, { name: 'iost-terminal', version: 'test' });
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.structuredContent, { ok: true });
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'iost-terminal');
});

const store = createMcpTaskStore({ dataDir: SCRATCH, ttlMs: 60_000, maxPerOwner: 3 });
const task = store.create({ ownerId: 'user-a', toolName: 'evaluation_run', requestHash: 'a'.repeat(64) });

ok('task creation is durable before its handle is returned', () => {
  assert.equal(store.get('user-a', task.taskId)?.status, 'working');
  const disk = JSON.parse(readFileSync(join(SCRATCH, 'mcp-tasks.json'), 'utf8'));
  assert(disk.tasks[task.taskId]);
});

ok('private task handles cannot cross user boundaries', () => {
  assert.equal(store.get('user-b', task.taskId), null);
  assert.equal(store.cancel('user-b', task.taskId), null);
  assert.equal(store.get('user-a', task.taskId)?.status, 'working');
});

ok('task completion retains a structured MCP result and cancellation is terminal', () => {
  const completed = store.complete('user-a', task.taskId, modernResult({ ok: true, evidenceHash: 'b'.repeat(64) }, { name: 'iost-terminal', version: 'test' }));
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.structuredContent.evidenceHash, 'b'.repeat(64));
  assert.equal(store.cancel('user-a', task.taskId), null);
});

const cancellable = store.create({ ownerId: 'user-a', toolName: 'evaluation_run', requestHash: 'c'.repeat(64) });
ok('owners can cancel in-flight tasks without deleting evidence from other tasks', () => {
  assert.equal(store.cancel('user-a', cancellable.taskId)?.status, 'cancelled');
  assert.equal(store.get('user-a', task.taskId)?.status, 'completed');
});

ok('server integration retains wallet and Pact authorization for MCP paper opens', () => {
  const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /case ['"]paper_trade_open['"]/);
  assert.match(server, /agentSpendGate\(req, notionalMinor/);
  assert.match(server, /settleAgentSpend\(gate/);
  assert.match(server, /MCP_MODERN_VERSION/);
  assert.match(server, /tasks\/get/);
  assert.match(server, /entry\.resource === expectedResource/);
  assert.match(server, /pacts\.listPacts\(ident\.agentId\)/);
  assert.doesNotMatch(server, /pacts\.listPacts\(ident\.agentId, \{ includeAll: true \}\)/);
  assert.doesNotMatch(server.slice(server.indexOf("app.post('/mcp'"), server.indexOf('// ---- ARD manifest')), /executeLiveOrder|convertAitt|sendTransaction/);
});

rmSync(SCRATCH, { recursive: true, force: true });
console.log('MCP 2026 paper-agent checks passed');
