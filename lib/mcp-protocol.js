// MCP 2026-07-28 protocol helpers. This module intentionally contains no
// trading logic: server.js supplies the authenticated, fail-closed executors.
import { MCP_APP_MIME_TYPE, MCP_APP_RESOURCE_URI, MCP_UI_EXTENSION } from './mcp-apps.js';

export const MCP_MODERN_VERSION = '2026-07-28';
export const MCP_LEGACY_VERSION = '2025-06-18';
export const MCP_SUPPORTED_VERSIONS = Object.freeze([MCP_MODERN_VERSION, MCP_LEGACY_VERSION]);
export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export { MCP_UI_EXTENSION };
export const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const objectSchema = (properties = {}, required = []) => ({
  $schema: JSON_SCHEMA_2020_12,
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const outputObject = {
  $schema: JSON_SCHEMA_2020_12,
};

const readTool = (name, title, description, inputSchema = objectSchema()) => ({
  name, title, description, inputSchema, outputSchema: outputObject,
  annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

const mutationTool = (name, title, description, inputSchema, { destructive = false, idempotent = false } = {}) => ({
  name, title, description, inputSchema, outputSchema: outputObject,
  annotations: { title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false },
});

const PUBLIC_TOOLS = [
  readTool('market_snapshot', 'Market snapshot', 'Cached market scores, sentiment and paper-safe platform status.'),
  readTool('asset_scores', 'Asset scores', 'Current 0-100 watchlist scores and component scores.'),
  readTool('analyze_symbol', 'Analyze symbol', 'Detailed analysis for one supported symbol.', objectSchema({
    symbol: { type: 'string', minLength: 1, maxLength: 24, pattern: '^[A-Za-z0-9._/-]+$' },
  }, ['symbol'])),
  readTool('news_sentiment', 'News sentiment', 'Latest headlines with deterministic sentiment classification.'),
  readTool('chain_status', 'Chain status', 'Read-only IOST network telemetry. This tool cannot submit public-chain actions.'),
  readTool('platform_help', 'Platform help', 'Connection, authentication and paper-only usage guidance.'),
  readTool('health', 'Health', 'Service liveness and deployed version.'),
];

const AUTHENTICATED_READ_TOOLS = [
  readTool('agent_authorization_status', 'Agent authorization status', 'Current key scopes plus owned paper authorization wallets and Pacts.'),
  readTool('paper_account', 'Paper account', 'Private paper cash, positions and journal for the authenticated user.'),
  readTool('paper_stats', 'Paper statistics', 'Private paper-trading performance statistics.'),
  readTool('paper_missions', 'Paper missions', 'Read the authenticated user’s supervised paper missions, exact wallet/Pact bindings, limits, status and trace checkpoints.'),
  readTool('paper_execution_receipts', 'Verified execution receipts', 'Read private, tamper-evident paper execution receipts with quote freshness, authorization, cost and latency evidence.', objectSchema({
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  })),
  readTool('paper_execution_intents', 'Execution intent status', 'Read private paper execution idempotency status. Omit intentId to list recent intents.', objectSchema({
    intentId: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  })),
  mutationTool('paper_mission_checkpoint', 'Record mission checkpoint', 'Append a bounded observe, analyze, risk-check, execute, verify or journal checkpoint to a running paper mission.', objectSchema({
    missionId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^msn_[a-z0-9]+$' },
    stage: { type: 'string', enum: ['observe', 'analyze', 'risk-check', 'execute', 'verify', 'journal'] },
    detail: { type: 'string', minLength: 1, maxLength: 500 },
    latencyMs: { type: ['integer', 'null'], minimum: 0, maximum: 300000 },
  }, ['missionId', 'stage', 'detail'])),
  readTool('evaluation_history', 'Evaluation history', 'Private retained paper evaluation history.', objectSchema({
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  })),
  {
    ...readTool('evaluation_review', 'Open evaluation review', 'Open the private paper-only Evaluation Review app. Text and structured evidence remain available in hosts without MCP Apps.', objectSchema({
      runIds: { type: 'array', minItems: 0, maxItems: 2, uniqueItems: true, items: { type: 'string', pattern: '^ev_[a-f0-9]{24}$' } },
      taskId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
    })),
    _meta: { ui: { resourceUri: MCP_APP_RESOURCE_URI, visibility: ['model', 'app'] }, 'ui/resourceUri': MCP_APP_RESOURCE_URI },
  },
  readTool('evaluation_get', 'Get evaluation evidence', 'Read one private retained evaluation and verified chart series.', objectSchema({
    runId: { type: 'string', pattern: '^ev_[a-f0-9]{24}$' },
  }, ['runId'])),
  readTool('evaluation_compare', 'Compare evaluations', 'Compare exactly two private same-owner evaluation runs.', objectSchema({
    runIds: { type: 'array', minItems: 2, maxItems: 2, uniqueItems: true, items: { type: 'string', pattern: '^ev_[a-f0-9]{24}$' } },
  }, ['runIds'])),
  readTool('evaluation_export', 'Export evaluation evidence', 'Return a deterministic private JSON or CSV evidence document with its SHA-256 hash.', objectSchema({
    runId: { type: 'string', pattern: '^ev_[a-f0-9]{24}$' },
    format: { type: 'string', enum: ['json', 'csv'] },
  }, ['runId', 'format'])),
  readTool('evaluation_task_status', 'Evaluation task status', 'Read one owner-bound evaluation task status.', objectSchema({
    taskId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
  }, ['taskId'])),
  mutationTool('evaluation_task_cancel', 'Cancel evaluation task', 'Cancel one owner-bound in-flight paper evaluation task.', objectSchema({
    taskId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
  }, ['taskId']), { destructive: true }),
  mutationTool('evaluation_run', 'Run evaluation', 'Run and retain a private causal walk-forward paper evaluation. Supports the MCP Tasks extension.', objectSchema({
    symbol: { type: 'string', minLength: 1, maxLength: 24, pattern: '^[A-Za-z0-9._/-]+$' },
    timeframe: { type: 'string', minLength: 1, maxLength: 12 },
    strategy: {
      type: 'object',
      required: ['entry'],
      properties: {
        name: { type: 'string', maxLength: 120 },
        side: { type: 'string', enum: ['long', 'short'] },
        sizePct: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        entry: {
          type: 'object', required: ['rule'],
          properties: { rule: { type: 'string', minLength: 1, maxLength: 80 }, params: { type: 'object' } },
          additionalProperties: false,
        },
        exit: { type: 'object' },
      },
      additionalProperties: false,
    },
    config: { type: 'object' },
  }, ['symbol', 'strategy'])),
];

const PAPER_TRADE_TOOLS = [
  readTool('paper_trade_preflight', 'Preflight paper trade', 'Read-only paper execution preflight with multi-venue quote integrity plus server-authoritative portfolio exposure, concentration, correlation, drawdown, daily-loss, protective-stop and volatility risk gates.', objectSchema({
    intentId: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
    symbol: { type: 'string', minLength: 1, maxLength: 24, pattern: '^[A-Za-z0-9._/-]+$' },
    side: { type: 'string', enum: ['long', 'short'] },
    size: { type: 'number', exclusiveMinimum: 0 },
    entry: { type: 'number', exclusiveMinimum: 0 },
    maxSlippageBps: { type: 'number', minimum: 0, maximum: 100 },
    stop: { type: ['number', 'null'] },
    target: { type: ['number', 'null'] },
    walletId: { type: 'string', minLength: 1, maxLength: 128 },
    pactId: { type: 'string', minLength: 1, maxLength: 128 },
    missionId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^msn_[a-z0-9]+$' },
    recipient: { type: ['string', 'null'], maxLength: 256 },
    protocol: { type: ['string', 'null'], maxLength: 128 },
  }, ['intentId', 'symbol', 'side', 'size', 'entry', 'maxSlippageBps', 'stop', 'walletId', 'pactId'])),
  mutationTool('paper_trade_open', 'Open paper trade', 'Open one idempotent simulated position using its unexpired preflight fingerprint only after quote integrity and server-authoritative portfolio risk pass. Agent opens require a protective stop and fill at the best fresh consensus-approved server ask or bid.', objectSchema({
    intentId: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
    preflightFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    symbol: { type: 'string', minLength: 1, maxLength: 24, pattern: '^[A-Za-z0-9._/-]+$' },
    side: { type: 'string', enum: ['long', 'short'] },
    size: { type: 'number', exclusiveMinimum: 0 },
    entry: { type: 'number', exclusiveMinimum: 0 },
    maxSlippageBps: { type: 'number', minimum: 0, maximum: 100 },
    stop: { type: ['number', 'null'] },
    target: { type: ['number', 'null'] },
    reason: { type: 'string', maxLength: 500 },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    walletId: { type: 'string', minLength: 1, maxLength: 128 },
    pactId: { type: 'string', minLength: 1, maxLength: 128 },
    missionId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^msn_[a-z0-9]+$' },
    recipient: { type: ['string', 'null'], maxLength: 256 },
    protocol: { type: ['string', 'null'], maxLength: 128 },
  }, ['intentId', 'preflightFingerprint', 'symbol', 'side', 'size', 'entry', 'maxSlippageBps', 'stop', 'walletId', 'pactId']), { idempotent: true }),
  mutationTool('paper_trade_close', 'Close paper trade', 'Close one position in the authenticated user’s simulated account at a server-observed market price. Any exitPrice supplied by an older client is ignored.', objectSchema({
    intentId: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
    positionId: { type: 'string', minLength: 1, maxLength: 128 },
    exitPrice: { type: ['number', 'null'], exclusiveMinimum: 0 },
  }, ['intentId', 'positionId']), { destructive: true, idempotent: true }),
];

export function buildMcpTools({ authenticated = false, scopes = [], apps = false } = {}) {
  const tools = [...PUBLIC_TOOLS];
  if (authenticated && scopes.includes('read')) tools.push(...AUTHENTICATED_READ_TOOLS);
  if (authenticated && scopes.includes('read') && scopes.includes('trade-paper')) tools.push(...PAPER_TRADE_TOOLS);
  return tools.map((tool) => {
    const copy = structuredClone(tool);
    if (copy.name === 'evaluation_review' && !apps) delete copy._meta;
    return copy;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateValue(value, schema, path, depth) {
  if (depth > 12) return `${path} exceeds maximum schema depth`;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => typeMatches(value, type))) return `${path} has invalid type`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} has unsupported value`;
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} is too long`;
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) return `${path} has invalid format`;
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return `${path} is below minimum`;
    if (schema.maximum != null && value > schema.maximum) return `${path} exceeds maximum`;
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) return `${path} must be greater than ${schema.exclusiveMinimum}`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    const unsafe = Object.keys(value).find((key) => ['__proto__', 'prototype', 'constructor'].includes(key));
    if (unsafe) return `${path}.${unsafe} is not allowed`;
    for (const required of schema.required || []) {
      if (!(required in value)) return `${path}.${required} is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !(key in properties));
      if (extra) return `${path}.${extra} is not allowed`;
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key] || {};
      const error = validateValue(child, childSchema, `${path}.${key}`, depth + 1);
      if (error) return error;
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items`;
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items`;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return `${path} must contain unique items`;
    for (let index = 0; index < value.length; index++) {
      const error = validateValue(value[index], schema.items || {}, `${path}[${index}]`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

export function validateToolArguments(name, args, access = {}) {
  const tool = buildMcpTools(access).find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, error: 'unknown or unauthorized tool' };
  const error = validateValue(args, tool.inputSchema, 'arguments', 0);
  return error ? { ok: false, error } : { ok: true };
}

function decodeHeaderValue(raw) {
  if (typeof raw !== 'string' || !raw.length) return null;
  if (!raw.startsWith('=?base64?') || !raw.endsWith('?=')) return raw;
  const encoded = raw.slice('=?base64?'.length, -2);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, '') ? decoded : null;
  } catch { return null; }
}

const headerError = (message) => ({ ok: false, status: 400, error: { code: -32020, message } });

export function validateModernRequest(message, headers = {}) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id == null) {
    return { ok: false, status: 400, error: { code: -32600, message: 'Invalid Request' } };
  }
  const versionHeader = headers['mcp-protocol-version'];
  const methodHeader = headers['mcp-method'];
  const meta = message.params?._meta;
  const bodyVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
  const capabilities = meta?.['io.modelcontextprotocol/clientCapabilities'];
  if (!versionHeader || !methodHeader) return headerError('Required MCP routing headers are missing');
  if (versionHeader !== bodyVersion) return headerError('MCP-Protocol-Version header does not match request metadata');
  if (methodHeader !== message.method) return headerError('Mcp-Method header does not match request method');
  if (versionHeader !== MCP_MODERN_VERSION) {
    return { ok: false, status: 400, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: MCP_SUPPORTED_VERSIONS, requested: versionHeader } } };
  }
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return { ok: false, status: 400, error: { code: -32602, message: 'Per-request client capabilities are required' } };
  }
  const namedMethod = ['tools/call', 'resources/read', 'prompts/get', 'tasks/get', 'tasks/update', 'tasks/cancel'].includes(message.method);
  if (namedMethod) {
    const bodyName = message.method.startsWith('tasks/') ? message.params?.taskId : (message.params?.name ?? message.params?.uri);
    const headerName = decodeHeaderValue(headers['mcp-name']);
    if (!headerName) return headerError('Required Mcp-Name header is missing or malformed');
    if (headerName !== bodyName) return headerError('Mcp-Name header does not match request body');
  }
  return { ok: true };
}

export function hasTasksCapability(message) {
  return !!message?.params?._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.[MCP_TASKS_EXTENSION];
}

export function hasMcpAppsCapability(message) {
  const capability = message?.params?._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.[MCP_UI_EXTENSION];
  return !!(capability && Array.isArray(capability.mimeTypes) && capability.mimeTypes.includes(MCP_APP_MIME_TYPE));
}

export function modernResult(data, serverInfo, { isError = false } = {}) {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

export function withModernMeta(result, serverInfo) {
  return {
    resultType: result?.resultType || 'complete',
    ...result,
    _meta: { ...(result?._meta || {}), 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}
