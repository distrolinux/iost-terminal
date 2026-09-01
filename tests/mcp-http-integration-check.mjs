import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, '.tmp-mcp-http-test');
const PORT = 18787 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

const auth = await import('../lib/auth.js');
const agentKeys = await import('../lib/agent-keys.js');
const wallets = await import('../lib/wallets.js');
const pacts = await import('../lib/pacts.js');
const { evaluateAgentStrategy } = await import('../lib/evaluation.js');
const evaluationHistory = await import('../lib/evaluation-history.js');

const registered = await auth.registerUser('mcp-test@example.com', 'correct-horse-battery-staple');
assert.equal(registered.ok, true);
const fixtureCandles = Array.from({ length: 260 }, (_, i) => {
  const base = 100 + i * 0.08; return { ts: 1_700_000_000_000 + i * 86_400_000, o: base, h: base + 1, l: base - 1, c: base + 0.4, v: 1000 + i };
});
const fixtureEvaluation = evaluateAgentStrategy({
  symbol: 'AAPL', timeframe: '1d', candles: fixtureCandles,
  strategy: { name: 'MCP app fixture', side: 'long', sizePct: 0.2, entry: { rule: 'breakout', params: { lookback: 8 } }, exit: { maxBars: 12 } },
  config: { trainBars: 80, testBars: 40, stepBars: 40, minimumTrades: 1 },
});
assert.equal(fixtureEvaluation.ok, true);
const fixtureRunA = evaluationHistory.saveEvaluation(registered.user.id, fixtureEvaluation, Date.now() - 2);
const fixtureRunB = evaluationHistory.saveEvaluation(registered.user.id, fixtureEvaluation, Date.now() - 1);
const keyA = agentKeys.createKey({ userId: registered.user.id, name: 'MCP test agent', scopes: ['read', 'trade-paper'] });
const keyReadOnly = agentKeys.createKey({ userId: registered.user.id, name: 'MCP read-only agent', scopes: ['read'] });
const keyB = agentKeys.createKey({ userId: 'different-user', name: 'Other agent', scopes: ['read'] });
const agentOwner = `agent:key:${keyA.entry.id}`;
const wallet = wallets.createAgentWallet({
  ownerId: agentOwner, name: 'MCP paper wallet', capabilities: ['trade.paper'],
  limits: { USD: { maxPerTxMinor: 100_000, dailyCapMinor: 500_000, weeklyCapMinor: 1_000_000 } },
});
const pact = pacts.proposePact({
  ownerId: agentOwner, agentWalletId: wallet.walletId, intent: 'Automated paper-only regression trade',
  plan: [{ step: 'Open and close one simulated position' }],
  policies: { approvalRequired: true, limits: { maxPerTxMinor: 100_000 } },
  completion: { type: 'time', deadlineTs: Date.now() + 10 * 60_000 },
});
pacts.approvePact(pact.pactId, 'test-owner');
const accountWallet = wallets.createAgentWallet({
  ownerId: `user:${registered.user.id}`, name: 'Owner control paper wallet', capabilities: ['trade.paper'],
  limits: { USD: { maxPerTxMinor: 100_000, dailyCapMinor: 500_000, weeklyCapMinor: 1_000_000 } },
});
const accountPact = pacts.proposePact({
  ownerId: `user:${registered.user.id}`, agentWalletId: accountWallet.walletId, intent: 'Owner-control MCP paper trade',
  policies: { approvalRequired: true, limits: { maxPerTxMinor: 100_000 } },
  completion: { type: 'time', deadlineTs: Date.now() + 10 * 60_000 },
});
pacts.approvePact(accountPact.pactId, 'test-owner');

let logs = '';
const child = spawn(process.execPath, ['--import', './tests/market-fetch-fixture.mjs', 'server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    IOST_DATA_DIR: SCRATCH,
    PORT: String(PORT),
    SITE_URL: BASE,
    SESSION_SECRET: 'mcp-http-integration-session-secret-32-bytes',
    LIVE_TRADING_ENABLED: 'false',
    AITT_CONVERSION_ENABLED: 'false',
    PUBLIC_CHAIN_ACTIONS_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`scratch server did not become ready\n${logs}`);
}

const protocolMeta = (tasks = false, apps = false) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { extensions: {
    ...(tasks ? { 'io.modelcontextprotocol/tasks': {} } : {}),
    ...(apps ? { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } : {}),
  } },
  'io.modelcontextprotocol/clientInfo': { name: 'iost-regression', version: '1.0.0' },
});

async function mcp(method, params = {}, { key = null, bearer = null, name = null, tasks = false, apps = false, methodHeader = method } = {}) {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': methodHeader,
      ...(name ? { 'Mcp-Name': name } : {}),
      ...(key ? { 'X-API-Key': key } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: protocolMeta(tasks, apps) } }),
  });
  return { status: response.status, body: await response.json() };
}

async function boundOpenArguments(intentId, overrides = {}, key = keyA.key) {
  const order = {
    intentId, symbol: 'IOST', side: 'long', size: 1, entry: 10, stop: 9.9, maxSlippageBps: 100,
    walletId: wallet.walletId, pactId: pact.pactId,
    reason: 'MCP integration test', ...overrides,
  };
  if (!Object.hasOwn(overrides, 'stop')) order.stop = order.side === 'short' ? 10.1 : 9.9;
  const { reason: _reason, confidence: _confidence, preflightFingerprint: _fingerprint, ...preflightOrder } = order;
  const preflight = await mcp('tools/call', {
    name: 'paper_trade_preflight', arguments: preflightOrder,
  }, { key, name: 'paper_trade_preflight' });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.result.isError, false, JSON.stringify(preflight.body));
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.decision, 'allow');
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.metrics.protectiveStopPresent, true);
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.metrics.volatilitySource, 'trusted-venue-24h-range');
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.metrics.volatilityRegime, 'normal');
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.metrics.dynamicMaxOrderPct, 7.5);
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.capacity.maximumNewOrderUsd, 7_500);
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.volatility.source, 'trusted-venue-24h-range');
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.volatility.venueCount, 2);
  assert(preflight.body.result.structuredContent.portfolioRisk.volatility.forecastVolDailyPct > 0);
  assert.equal(preflight.body.result.structuredContent.portfolioRisk.execution.attempted, false);
  const quality = preflight.body.result.structuredContent.market.quoteIntegrity.executionQuality;
  assert.equal(quality.decision, 'allow');
  assert.equal(quality.selectedVenue, preflight.body.result.structuredContent.market.quoteIntegrity.routeVenue);
  assert.equal(quality.policy.maximumPriceTradeoffBps, 10);
  assert.equal(quality.execution.attempted, false);
  assert.equal(quality.authorization.liveScopeUsed, false);
  return { ...order, preflightFingerprint: preflight.body.result.structuredContent.preflightFingerprint };
}

try {
  await waitForServer();

  const discover = await mcp('server/discover');
  assert.equal(discover.status, 200);
  assert.equal(discover.body.result.resultType, 'complete');
  assert(discover.body.result.supportedVersions.includes('2026-07-28'));

  const resources = await mcp('resources/list', {}, { apps: true });
  assert.equal(resources.status, 200);
  assert.equal(resources.body.result.resources[0].mimeType, 'text/html;profile=mcp-app');
  const resource = await mcp('resources/read', { uri: resources.body.result.resources[0].uri }, { name: resources.body.result.resources[0].uri, apps: true });
  assert.equal(resource.body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert(resource.body.result.contents[0]._meta.ui.csp);

  const mismatch = await mcp('tools/list', {}, { methodHeader: 'tools/call' });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, -32020);

  const publicTools = await mcp('tools/list');
  assert.equal(publicTools.body.result.cacheScope, 'public');
  assert(!publicTools.body.result.tools.some((tool) => tool.name === 'paper_trade_open'));

  const privateTools = await mcp('tools/list', {}, { key: keyA.key });
  assert.equal(privateTools.body.result.cacheScope, 'private');
  assert(privateTools.body.result.tools.some((tool) => tool.name === 'paper_trade_open'));
  const preflightTool = privateTools.body.result.tools.find((tool) => tool.name === 'paper_trade_preflight');
  assert(preflightTool);
  assert.equal(preflightTool.annotations.readOnlyHint, true);
  assert.equal(preflightTool.annotations.destructiveHint, false);
  assert(privateTools.body.result.tools.some((tool) => tool.name === 'paper_execution_receipts'));
  assert(privateTools.body.result.tools.some((tool) => tool.name === 'paper_execution_intents'));
  const guardianTool = privateTools.body.result.tools.find((tool) => tool.name === 'paper_position_guardian');
  assert(guardianTool);
  assert.equal(guardianTool.annotations.readOnlyHint, true);
  assert.equal(guardianTool.annotations.destructiveHint, false);
  assert.equal(guardianTool.annotations.idempotentHint, true);
  const runtimeStatusTool = privateTools.body.result.tools.find((tool) => tool.name === 'agent_runtime_status');
  const runtimeHeartbeatTool = privateTools.body.result.tools.find((tool) => tool.name === 'agent_runtime_heartbeat');
  const incidentStatusTool = privateTools.body.result.tools.find((tool) => tool.name === 'agent_incident_status');
  assert.equal(runtimeStatusTool.annotations.readOnlyHint, true);
  assert.equal(runtimeStatusTool.annotations.destructiveHint, false);
  assert.equal(runtimeHeartbeatTool.annotations.readOnlyHint, false);
  assert.equal(runtimeHeartbeatTool.annotations.destructiveHint, false);
  assert.equal(runtimeHeartbeatTool.annotations.idempotentHint, true);
  assert.equal(incidentStatusTool.annotations.readOnlyHint, true);
  assert.equal(incidentStatusTool.annotations.destructiveHint, false);
  assert.equal(incidentStatusTool.annotations.idempotentHint, true);
  const promotionTool = privateTools.body.result.tools.find((tool) => tool.name === 'strategy_promotion_scorecards');
  assert.equal(promotionTool.annotations.readOnlyHint, true);
  assert.equal(promotionTool.annotations.destructiveHint, false);
  assert(!privateTools.body.result.tools.some((tool) => /live|swap|convert/i.test(tool.name)));
  const appTools = await mcp('tools/list', {}, { key: keyA.key, apps: true });
  const reviewTool = appTools.body.result.tools.find((tool) => tool.name === 'evaluation_review');
  assert.equal(reviewTool._meta.ui.resourceUri, resources.body.result.resources[0].uri);

  const tokenResponse = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: keyA.entry.id, client_secret: keyA.key, resource: `${BASE}/mcp`,
    }),
  });
  const mcpToken = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200);
  assert.equal(mcpToken.resource, `${BASE}/mcp`);
  const bearerTools = await mcp('tools/list', {}, { bearer: mcpToken.access_token });
  assert(bearerTools.body.result.tools.some((tool) => tool.name === 'paper_trade_open'));

  const rootTokenResponse = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: keyA.entry.id, client_secret: keyA.key }),
  });
  const rootToken = await rootTokenResponse.json();
  const replayedTools = await mcp('tools/list', {}, { bearer: rootToken.access_token });
  assert.equal(replayedTools.status, 401);
  assert.equal(replayedTools.body.error.code, -32001);
  const rootTokenStillValid = await fetch(`${BASE}/api/paper`, {
    headers: { Authorization: `Bearer ${rootToken.access_token}` },
  });
  assert.equal(rootTokenStillValid.status, 200);

  const authStatus = await mcp('tools/call', { name: 'agent_authorization_status', arguments: {} }, {
    key: keyA.key, name: 'agent_authorization_status',
  });
  assert.equal(authStatus.body.result.structuredContent.canOpenPaperTrade, true);
  assert.equal(authStatus.body.result.structuredContent.wallet.walletId, wallet.walletId);

  const guardianStatus = await mcp('tools/call', { name: 'paper_position_guardian', arguments: {} }, {
    key: keyA.key, name: 'paper_position_guardian',
  });
  assert.equal(guardianStatus.status, 200);
  assert.equal(guardianStatus.body.result.isError, false);
  assert.equal(guardianStatus.body.result.structuredContent.mode, 'paper-only');
  assert.equal(guardianStatus.body.result.structuredContent.coverage.total, 0);
  assert.equal(guardianStatus.body.result.structuredContent.guarantees.serverEnforced, true);
  assert.equal(guardianStatus.body.result.structuredContent.guarantees.survivesAgentDisconnect, true);
  assert.equal(guardianStatus.body.result.structuredContent.guarantees.ocoSiblingCancellation, true);
  assert.equal(guardianStatus.body.result.structuredContent.liveScopeUsed, false);
  assert.equal(guardianStatus.body.result.structuredContent.publicChainUsed, false);

  const runtimeBefore = await mcp('tools/call', { name: 'agent_runtime_status', arguments: {} }, {
    key: keyA.key, name: 'agent_runtime_status',
  });
  assert.equal(runtimeBefore.body.result.structuredContent.status, 'not-enrolled');
  const incidentsBefore = await mcp('tools/call', { name: 'agent_incident_status', arguments: {} }, {
    key: keyA.key, name: 'agent_incident_status',
  });
  assert.equal(incidentsBefore.body.result.structuredContent.mode, 'paper-only');
  assert.equal(incidentsBefore.body.result.structuredContent.counts.open, 0);
  assert.equal(incidentsBefore.body.result.structuredContent.guarantees.authorityExpanded, false);
  assert.equal(incidentsBefore.body.result.structuredContent.liveScopeUsed, false);
  assert.equal(incidentsBefore.body.result.structuredContent.publicChainUsed, false);
  const otherIncidents = await mcp('tools/call', { name: 'agent_incident_status', arguments: {} }, {
    key: keyB.key, name: 'agent_incident_status',
  });
  assert.equal(otherIncidents.body.result.structuredContent.counts.total, 0, 'incident state must not cross owners');
  const heartbeatArguments = {
    sessionId: 'mcp-runtime-session-0001', sequence: 1, state: 'ready', stage: 'idle',
  };
  const runtimeHeartbeat = await mcp('tools/call', { name: 'agent_runtime_heartbeat', arguments: heartbeatArguments }, {
    key: keyA.key, name: 'agent_runtime_heartbeat',
  });
  assert.equal(runtimeHeartbeat.status, 200);
  assert.equal(runtimeHeartbeat.body.result.isError, false);
  assert.equal(runtimeHeartbeat.body.result.structuredContent.status, 'ready');
  assert.equal(runtimeHeartbeat.body.result.structuredContent.execution.authorityExpanded, false);
  assert.equal(runtimeHeartbeat.body.result.structuredContent.liveScopeUsed, false);
  assert.equal(runtimeHeartbeat.body.result.structuredContent.publicChainUsed, false);
  const runtimeReplay = await mcp('tools/call', { name: 'agent_runtime_heartbeat', arguments: heartbeatArguments }, {
    key: keyA.key, name: 'agent_runtime_heartbeat',
  });
  assert.equal(runtimeReplay.body.result.structuredContent.heartbeat.replayed, true);
  assert.equal(runtimeReplay.body.result.structuredContent.checkpoint.checkpointId, runtimeHeartbeat.body.result.structuredContent.checkpoint.checkpointId);
  const otherRuntime = await mcp('tools/call', { name: 'agent_runtime_status', arguments: {} }, {
    key: keyB.key, name: 'agent_runtime_status',
  });
  assert.equal(otherRuntime.body.result.structuredContent.status, 'not-enrolled', 'runtime state must not cross owners');
  const runtimeRestStatus = await fetch(`${BASE}/api/agent-runtime`, {
    headers: { 'X-API-Key': keyA.key },
  });
  assert.equal(runtimeRestStatus.status, 200);
  assert.match(runtimeRestStatus.headers.get('cache-control') || '', /no-store/);
  assert.equal((await runtimeRestStatus.json()).status, 'ready');
  const runtimeRestHeartbeat = await fetch(`${BASE}/api/agent-runtime/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': keyA.key },
    body: JSON.stringify({ ...heartbeatArguments, sequence: 2, stage: 'observe', ownerId: 'different-user', keyId: keyB.entry.id }),
  });
  assert.equal(runtimeRestHeartbeat.status, 200);
  const runtimeRestHeartbeatBody = await runtimeRestHeartbeat.json();
  assert.equal(runtimeRestHeartbeatBody.heartbeat.sequence, 2);
  assert.equal(runtimeRestHeartbeatBody.execution.authorityExpanded, false);
  assert.equal(runtimeRestHeartbeatBody.liveScopeUsed, false);
  assert.equal(runtimeRestHeartbeatBody.publicChainUsed, false);
  const otherRuntimeAfterSpoof = await mcp('tools/call', { name: 'agent_runtime_status', arguments: {} }, {
    key: keyB.key, name: 'agent_runtime_status',
  });
  assert.equal(otherRuntimeAfterSpoof.body.result.structuredContent.status, 'not-enrolled', 'REST payload must not override authenticated runtime identity');

  const scorecards = await mcp('tools/call', { name: 'strategy_promotion_scorecards', arguments: { limit: 5 } }, {
    key: keyReadOnly.key, name: 'strategy_promotion_scorecards',
  });
  assert.equal(scorecards.status, 200);
  assert.equal(scorecards.body.result.structuredContent.mode, 'paper-only');
  assert.equal(scorecards.body.result.structuredContent.scorecards.length, 2);
  assert.equal(scorecards.body.result.structuredContent.scorecards[0].scorecard.lifecycle.executionPermissionsChanged, false);
  const otherScorecards = await mcp('tools/call', { name: 'strategy_promotion_scorecards', arguments: { limit: 5 } }, {
    key: keyB.key, name: 'strategy_promotion_scorecards',
  });
  assert.equal(otherScorecards.body.result.structuredContent.scorecards.length, 0, 'scorecards must not cross owner boundaries');

  const preflightAccountBefore = await mcp('tools/call', { name: 'paper_account', arguments: {} }, {
    key: keyA.key, name: 'paper_account',
  });
  const preflightReceiptsBefore = await mcp('tools/call', { name: 'paper_execution_receipts', arguments: { limit: 20 } }, {
    key: keyA.key, name: 'paper_execution_receipts',
  });
  const preflightIntentsBefore = await mcp('tools/call', { name: 'paper_execution_intents', arguments: { limit: 20 } }, {
    key: keyA.key, name: 'paper_execution_intents',
  });
  const preflightStateFiles = ['accounts.json', 'limits.json', 'pacts.json', 'missions.json', 'agent-runtimes.json', 'agent-incidents.json', 'execution-intents.json', 'execution-receipts.jsonl'];
  const preflightFilesBefore = new Map(preflightStateFiles.map((name) => {
    const path = join(SCRATCH, name);
    return [name, existsSync(path) ? readFileSync(path, 'utf8') : null];
  }));
  const preflightResult = await mcp('tools/call', {
    name: 'paper_trade_preflight',
    arguments: { intentId: 'mcp-preflight-readonly-0000', symbol: 'ZZZUNKNOWN', side: 'long', size: 1, entry: 10, stop: 9.9, maxSlippageBps: 100, walletId: wallet.walletId, pactId: pact.pactId },
  }, { key: keyA.key, name: 'paper_trade_preflight' });
  assert.equal(preflightResult.status, 200);
  assert.equal(preflightResult.body.result.isError, false);
  assert.equal(preflightResult.body.result.structuredContent.readOnly, true);
  assert.equal(preflightResult.body.result.structuredContent.decision, 'deny');
  assert.equal(preflightResult.body.result.structuredContent.reasonCode, 'symbol-supported');
  assert.equal(preflightResult.body.result.structuredContent.execution.attempted, false);
  assert.equal(preflightResult.body.result.structuredContent.authorization.liveScopeUsed, false);
  assert.equal(preflightResult.body.result.structuredContent.authorization.publicChainUsed, false);
  assert.equal(JSON.stringify(preflightResult.body.result.structuredContent).includes(wallet.walletId), false);
  assert.equal(JSON.stringify(preflightResult.body.result.structuredContent).includes(pact.pactId), false);
  for (const name of preflightStateFiles) {
    const path = join(SCRATCH, name);
    assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, preflightFilesBefore.get(name), `${name} changed during read-only preflight`);
  }
  const preflightAccountAfter = await mcp('tools/call', { name: 'paper_account', arguments: {} }, {
    key: keyA.key, name: 'paper_account',
  });
  const preflightReceiptsAfter = await mcp('tools/call', { name: 'paper_execution_receipts', arguments: { limit: 20 } }, {
    key: keyA.key, name: 'paper_execution_receipts',
  });
  const preflightIntentsAfter = await mcp('tools/call', { name: 'paper_execution_intents', arguments: { limit: 20 } }, {
    key: keyA.key, name: 'paper_execution_intents',
  });
  assert.equal(preflightAccountAfter.body.result.structuredContent.account.cash, preflightAccountBefore.body.result.structuredContent.account.cash);
  assert.equal(preflightAccountAfter.body.result.structuredContent.positions.length, preflightAccountBefore.body.result.structuredContent.positions.length);
  assert.equal(preflightReceiptsAfter.body.result.structuredContent.receipts.length, preflightReceiptsBefore.body.result.structuredContent.receipts.length);
  assert.equal(preflightIntentsAfter.body.result.structuredContent.intents.length, preflightIntentsBefore.body.result.structuredContent.intents.length);

  const readOnlyPreflight = await fetch(`${BASE}/api/paper/preflight`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': keyReadOnly.key },
    body: JSON.stringify({ symbol: 'AAPL', side: 'long', size: 1, entry: 10, walletId: wallet.walletId, pactId: pact.pactId }),
  });
  assert.equal(readOnlyPreflight.status, 403);

  const restMissingIntent = await fetch(`${BASE}/api/paper/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': keyA.key },
    body: JSON.stringify({ symbol: 'AAPL', side: 'long', size: 1, entry: 10, walletId: wallet.walletId, pactId: pact.pactId }),
  });
  assert.equal(restMissingIntent.status, 400);
  assert.equal((await restMissingIntent.json()).reason, 'execution-intent-required');

  const restMismatchedIntent = await fetch(`${BASE}/api/paper/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': keyA.key, 'Idempotency-Key': 'rest-header-intent-0001' },
    body: JSON.stringify({ intentId: 'rest-body-intent-0002', symbol: 'AAPL', side: 'long', size: 1, entry: 10, walletId: wallet.walletId, pactId: pact.pactId }),
  });
  assert.equal(restMismatchedIntent.status, 400);
  assert.equal((await restMismatchedIntent.json()).reason, 'execution-intent-mismatch');

  const restMissingPreflight = await fetch(`${BASE}/api/paper/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': keyA.key },
    body: JSON.stringify({ intentId: 'rest-missing-preflight-0003', symbol: 'AAPL', side: 'long', size: 1, entry: 10, walletId: wallet.walletId, pactId: pact.pactId }),
  });
  const restMissingPreflightBody = await restMissingPreflight.json();
  assert.equal(restMissingPreflight.status, 428);
  assert.equal(restMissingPreflightBody.reason, 'preflight-fingerprint-required');
  assert.equal(restMissingPreflightBody.receipt.authorization.preflightAuthorized, false);

  const riskDeniedOrder = {
    intentId: 'mcp-risk-denied-0006', symbol: 'IOST', side: 'long', size: 2_000,
    entry: 10, stop: 9.99, maxSlippageBps: 100,
    walletId: wallet.walletId, pactId: pact.pactId,
  };
  const riskDeniedPreflight = await mcp('tools/call', {
    name: 'paper_trade_preflight', arguments: riskDeniedOrder,
  }, { key: keyA.key, name: 'paper_trade_preflight' });
  const deniedEvidence = riskDeniedPreflight.body.result.structuredContent;
  assert.equal(deniedEvidence.decision, 'deny');
  assert.equal(deniedEvidence.portfolioRisk.reasonCode, 'order-notional-limit');
  const riskAccountBefore = await mcp('tools/call', { name: 'paper_account', arguments: {} }, {
    key: keyA.key, name: 'paper_account',
  });
  const riskDeniedOpen = await mcp('tools/call', {
    name: 'paper_trade_open',
    arguments: { ...riskDeniedOrder, preflightFingerprint: deniedEvidence.preflightFingerprint },
  }, { key: keyA.key, name: 'paper_trade_open' });
  assert.equal(riskDeniedOpen.body.result.isError, true);
  assert.equal(riskDeniedOpen.body.result.structuredContent.reason, 'preflight-denied');
  assert.equal(riskDeniedOpen.body.result.structuredContent.receipt.portfolioRisk.decision, 'deny');
  assert.equal(riskDeniedOpen.body.result.structuredContent.receipt.portfolioRisk.reasonCode, 'order-notional-limit');
  const riskAccountAfter = await mcp('tools/call', { name: 'paper_account', arguments: {} }, {
    key: keyA.key, name: 'paper_account',
  });
  assert.equal(riskAccountAfter.body.result.structuredContent.account.cash, riskAccountBefore.body.result.structuredContent.account.cash);
  assert.equal(riskAccountAfter.body.result.structuredContent.positions.length, riskAccountBefore.body.result.structuredContent.positions.length);

  const review = await mcp('tools/call', {
    name: 'evaluation_review', arguments: { runIds: [fixtureRunA.id, fixtureRunB.id] },
  }, { key: keyA.key, name: 'evaluation_review', apps: true });
  assert.equal(review.body.result.structuredContent.selected.length, 2);
  assert.equal(review.body.result.structuredContent.comparison.runs.length, 2);
  const privateEvidenceMiss = await mcp('tools/call', {
    name: 'evaluation_get', arguments: { runId: fixtureRunA.id },
  }, { key: keyB.key, name: 'evaluation_get' });
  assert.equal(privateEvidenceMiss.body.error.code, -32602);
  const exported = await mcp('tools/call', {
    name: 'evaluation_export', arguments: { runId: fixtureRunA.id, format: 'json' },
  }, { key: keyA.key, name: 'evaluation_export', apps: true });
  assert.equal(exported.body.result.structuredContent.ok, true);
  assert.match(exported.body.result.structuredContent.data, /iost-terminal-agent-evaluation/);

  const openArguments = await boundOpenArguments('mcp-open-integration-0001');
  const opened = await mcp('tools/call', {
    name: 'paper_trade_open',
    arguments: openArguments,
  }, { key: keyA.key, name: 'paper_trade_open' });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.result.isError, false, JSON.stringify(opened.body));
  assert.equal(opened.body.result.structuredContent.ok, true);
  assert.equal(opened.body.result.structuredContent.receipt.outcome, 'accepted');
  assert.equal(opened.body.result.structuredContent.receipt.authorization.walletPactAuthorized, true);
  assert.equal(opened.body.result.structuredContent.receipt.authorization.preflightAuthorized, true);
  assert.equal(opened.body.result.structuredContent.receipt.order.preflightFingerprint, openArguments.preflightFingerprint);
  assert.equal(opened.body.result.structuredContent.position.entry, 10.01);
  assert.equal(opened.body.result.structuredContent.receipt.execution.fillPrice, 10.01);
  assert.equal(opened.body.result.structuredContent.receipt.execution.fillAuthority, 'server-top-of-book-ask');
  assert.equal(opened.body.result.structuredContent.receipt.execution.fillVenue, 'KuCoin');
  assert.equal(opened.body.result.structuredContent.receipt.market.quoteIntegrity.quorumMet, true);
  assert.equal(opened.body.result.structuredContent.receipt.market.quoteIntegrity.trustedVenueCount, 3);
  assert.equal(opened.body.result.structuredContent.receipt.market.quoteIntegrity.routeVenue, 'KuCoin');
  assert.equal(opened.body.result.structuredContent.receipt.market.quoteIntegrity.executionQuality.decision, 'allow');
  assert.equal(opened.body.result.structuredContent.receipt.market.quoteIntegrity.executionQuality.selectedVenue, 'KuCoin');
  assert.equal(opened.body.result.structuredContent.receipt.market.quoteIntegrity.executionQuality.policy.maximumPriceTradeoffBps, 10);
  assert.equal(opened.body.result.structuredContent.receipt.execution.slippageBps, 10);
  assert.equal(opened.body.result.structuredContent.receipt.execution.maxSlippageBps, 100);
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.decision, 'allow');
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.reasonCode, 'portfolio-risk-passed');
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.metrics.protectiveStopPresent, true);
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.metrics.volatilitySource, 'trusted-venue-24h-range');
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.metrics.dynamicMaxOrderPct, 7.5);
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.capacity.maximumNewOrderUsd, 7_500);
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.volatility.source, 'trusted-venue-24h-range');
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.volatility.venueCount, 2);
  assert.equal(opened.body.result.structuredContent.receipt.portfolioRisk.checks.every((check) => check.pass), true);
  assert.equal(opened.body.result.structuredContent.executionIntent.replayed, false);
  const positionId = opened.body.result.structuredContent.position.id;

  const unauthorizedReplay = await fetch(`${BASE}/api/paper/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': keyReadOnly.key, 'Idempotency-Key': 'mcp-open-integration-0001' },
    body: JSON.stringify(openArguments),
  });
  const unauthorizedReplayBody = await unauthorizedReplay.json();
  assert.equal(unauthorizedReplay.status, 403);
  assert.equal(unauthorizedReplayBody.reason, 'trade-paper-scope-required');
  assert.equal(unauthorizedReplayBody.position, undefined, 'read-only key must not receive cached execution data');

  const replayedOpen = await mcp('tools/call', {
    name: 'paper_trade_open',
    arguments: openArguments,
  }, { key: keyA.key, name: 'paper_trade_open' });
  assert.equal(replayedOpen.body.result.structuredContent.executionIntent.replayed, true);
  assert.equal(replayedOpen.body.result.structuredContent.position.id, positionId);

  const conflictingOpen = await mcp('tools/call', {
    name: 'paper_trade_open',
    arguments: { ...openArguments, size: 2 },
  }, { key: keyA.key, name: 'paper_trade_open' });
  assert.equal(conflictingOpen.body.result.isError, true);
  assert.equal(conflictingOpen.body.result.structuredContent.reason, 'execution-intent-conflict');

  const policyArguments = await boundOpenArguments('mcp-policy-reject-0002');
  const policyShifter = await boundOpenArguments('mcp-policy-shifter-0005');
  const shiftedPolicy = await mcp('tools/call', {
    name: 'paper_trade_open', arguments: policyShifter,
  }, { key: keyA.key, name: 'paper_trade_open' });
  assert.equal(shiftedPolicy.body.result.isError, false);
  const policyStateBefore = await mcp('tools/call', { name: 'paper_account', arguments: {} }, {
    key: keyA.key, name: 'paper_account',
  });
  const policyRejected = await mcp('tools/call', {
    name: 'paper_trade_open',
    arguments: policyArguments,
  }, { key: keyA.key, name: 'paper_trade_open' });
  assert.equal(policyRejected.body.result.isError, true);
  assert.equal(policyRejected.body.result.structuredContent.receipt.outcome, 'rejected');
  assert.equal(policyRejected.body.result.structuredContent.receipt.authorization.walletPactAuthorized, false);
  assert.equal(policyRejected.body.result.structuredContent.receipt.authorization.preflightAuthorized, false);
  assert.equal(policyRejected.body.result.structuredContent.reason, 'preflight-evidence-changed');
  const policyStateAfter = await mcp('tools/call', { name: 'paper_account', arguments: {} }, {
    key: keyA.key, name: 'paper_account',
  });
  assert.equal(policyStateAfter.body.result.structuredContent.account.cash, policyStateBefore.body.result.structuredContent.account.cash);
  assert.equal(policyStateAfter.body.result.structuredContent.positions.length, policyStateBefore.body.result.structuredContent.positions.length);

  const replayedRejection = await mcp('tools/call', {
    name: 'paper_trade_open',
    arguments: policyArguments,
  }, { key: keyA.key, name: 'paper_trade_open' });
  assert.equal(replayedRejection.body.result.isError, true);
  assert.equal(replayedRejection.body.result.structuredContent.executionIntent.replayed, true);
  assert.equal(replayedRejection.body.result.structuredContent.receipt.hash, policyRejected.body.result.structuredContent.receipt.hash);

  // Agent Control Center creates wallets under the signed-in account rather
  // than an individual key id. That account-owned wallet must remain usable
  // only by the same user's scoped key and an exact wallet-bound Pact.
  const accountWalletArguments = await boundOpenArguments('mcp-account-wallet-0003', {
    walletId: accountWallet.walletId, pactId: accountPact.pactId,
    side: 'short',
    reason: 'Owner-control wallet integration test',
  });
  const accountWalletOpened = await mcp('tools/call', {
    name: 'paper_trade_open',
    arguments: accountWalletArguments,
  }, { key: keyA.key, name: 'paper_trade_open' });
  assert.equal(accountWalletOpened.status, 200);
  assert.equal(accountWalletOpened.body.result.structuredContent.ok, true, JSON.stringify(accountWalletOpened.body));
  assert.equal(accountWalletOpened.body.result.structuredContent.position.entry, 9.99);
  assert.equal(accountWalletOpened.body.result.structuredContent.receipt.execution.fillPrice, 9.99);
  assert.equal(accountWalletOpened.body.result.structuredContent.receipt.execution.fillAuthority, 'server-top-of-book-bid');
  assert.equal(accountWalletOpened.body.result.structuredContent.receipt.execution.fillVenue, 'Gate');
  assert.equal(accountWalletOpened.body.result.structuredContent.receipt.market.quoteIntegrity.routeVenue, 'Gate');

  const closed = await mcp('tools/call', {
    name: 'paper_trade_close', arguments: { intentId: 'mcp-close-integration-0004', positionId, exitPrice: 11 },
  }, { key: keyA.key, name: 'paper_trade_close' });
  assert.equal(closed.body.result.structuredContent.ok, true);
  // The MCP client may not choose a profitable exit price. With a fresh quote
  // unavailable in this hermetic test, the broker falls back to its last
  // server-observed price (the $10 entry), never the supplied $11.
  assert.notEqual(closed.body.result.structuredContent.exitPrice, 11);
  assert.match(closed.body.result.structuredContent.exitAuthority, /^server-(market|last-observed)$/);
  assert.equal(closed.body.result.structuredContent.receipt.action, 'close');
  assert.equal(closed.body.result.structuredContent.receipt.outcome, 'accepted');

  const replayedClose = await mcp('tools/call', {
    name: 'paper_trade_close', arguments: { intentId: 'mcp-close-integration-0004', positionId, exitPrice: 999 },
  }, { key: keyA.key, name: 'paper_trade_close' });
  assert.equal(replayedClose.body.result.structuredContent.executionIntent.replayed, true);
  assert.equal(replayedClose.body.result.structuredContent.exitPrice, closed.body.result.structuredContent.exitPrice);

  const intentHistory = await mcp('tools/call', {
    name: 'paper_execution_intents', arguments: { limit: 20 },
  }, { key: keyA.key, name: 'paper_execution_intents' });
  assert.equal(intentHistory.body.result.structuredContent.ok, true);
  assert(intentHistory.body.result.structuredContent.intents.length >= 4);
  assert(intentHistory.body.result.structuredContent.intents.every((intent) => intent.replaySafe === true));

  const receiptHistory = await mcp('tools/call', {
    name: 'paper_execution_receipts', arguments: { limit: 20 },
  }, { key: keyA.key, name: 'paper_execution_receipts' });
  assert.equal(receiptHistory.body.result.structuredContent.ok, true);
  assert.equal(receiptHistory.body.result.structuredContent.verification.ok, true);
  assert(receiptHistory.body.result.structuredContent.receipts.length >= 4);
  const serializedReceipts = JSON.stringify(receiptHistory.body.result.structuredContent.receipts);
  assert.equal(serializedReceipts.includes(wallet.walletId), false);
  assert.equal(serializedReceipts.includes(pact.pactId), false);
  assert.equal(serializedReceipts.includes(positionId), false);

  const taskCreated = await mcp('tools/call', {
    name: 'evaluation_run', arguments: {
      symbol: 'AAPL',
      strategy: {
        name: 'cancel integration test', side: 'long', sizePct: 0.1,
        entry: { rule: 'rsi', params: { period: 14, oversold: 30 } },
        exit: { stopPct: 0.02, targetPct: 0.04 },
      },
    },
  }, { key: keyA.key, name: 'evaluation_run', tasks: true });
  assert.equal(taskCreated.body.result.resultType, 'task');
  const taskId = taskCreated.body.result.taskId;

  const privateMiss = await mcp('tasks/get', { taskId }, { key: keyB.key, name: taskId, tasks: true });
  assert.equal(privateMiss.body.error.code, -32602);

  const cancelled = await mcp('tasks/cancel', { taskId }, { key: keyA.key, name: taskId, tasks: true });
  assert.equal(cancelled.body.result.status, 'cancelled');
  const taskResult = await mcp('tasks/get', { taskId }, { key: keyA.key, name: taskId, tasks: true });
  assert.equal(taskResult.body.result.status, 'cancelled');

  console.log('MCP HTTP integration checks passed');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  rmSync(SCRATCH, { recursive: true, force: true });
}
