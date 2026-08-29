import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  MCP_APP_MIME_TYPE,
  MCP_APP_RESOURCE_URI,
  listMcpAppResources,
  readMcpAppResource,
} = await import('../lib/mcp-apps.js');
const { buildMcpTools, validateToolArguments } = await import('../lib/mcp-protocol.js');

const ok = (name, fn) => { fn(); console.log(`ok - ${name}`); };
const access = { authenticated: true, scopes: ['read'], apps: true };

ok('the evaluation app resource is deterministic, self-contained and deny-by-default', () => {
  assert.equal(MCP_APP_RESOURCE_URI, 'ui://iost-terminal/evaluation-review-v1.html');
  assert.equal(MCP_APP_MIME_TYPE, 'text/html;profile=mcp-app');
  const listed = listMcpAppResources();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].uri, MCP_APP_RESOURCE_URI);
  assert.equal(listed[0].mimeType, MCP_APP_MIME_TYPE);
  assert.deepEqual(listed[0]._meta?.ui?.csp, {});
  assert.deepEqual(listed[0]._meta?.ui?.permissions, {});
  const first = readMcpAppResource(MCP_APP_RESOURCE_URI);
  const second = readMcpAppResource(MCP_APP_RESOURCE_URI);
  assert.deepEqual(first, second);
  assert.equal(first.contents[0].uri, MCP_APP_RESOURCE_URI);
  assert.equal(first.contents[0].mimeType, MCP_APP_MIME_TYPE);
  assert.doesNotMatch(first.contents[0].text, /<(?:script|img|link|iframe)[^>]+(?:src|href)=['"]https?:/i);
  assert.equal(first.contents[0].text.includes('localStorage'), false);
  assert.equal(first.contents[0].text.includes('document.cookie'), false);
  assert.equal(first.contents[0].text.includes('paper_trade_open'), false);
  assert(first.contents[0].text.includes('Paper-only evaluation evidence'));
  assert(first.contents[0].text.includes('aria-live'));
  assert(first.contents[0].text.includes('<table'));
  assert(gzipSync(first.contents[0].text).byteLength <= 128 * 1024, 'compressed official-SDK app must remain within its 128 KiB budget');
});

ok('only authenticated read clients discover app and private evidence tools', () => {
  const publicTools = buildMcpTools({ authenticated: false, scopes: [] });
  const privateTools = buildMcpTools(access);
  for (const name of ['evaluation_review', 'evaluation_get', 'evaluation_compare', 'evaluation_export']) {
    assert(!publicTools.some((tool) => tool.name === name));
    assert(privateTools.some((tool) => tool.name === name));
  }
  const launch = privateTools.find((tool) => tool.name === 'evaluation_review');
  assert.equal(launch._meta.ui.resourceUri, MCP_APP_RESOURCE_URI);
  assert.equal(launch.annotations.readOnlyHint, true);
});

ok('run selectors and export formats fail schema validation before dispatch', () => {
  const idA = 'ev_' + 'a'.repeat(24); const idB = 'ev_' + 'b'.repeat(24);
  assert.equal(validateToolArguments('evaluation_get', { runId: idA }, access).ok, true);
  assert.equal(validateToolArguments('evaluation_compare', { runIds: [idA, idB] }, access).ok, true);
  assert.match(validateToolArguments('evaluation_compare', { runIds: [idA] }, access).error, /at least 2 items/);
  assert.match(validateToolArguments('evaluation_export', { runId: idA, format: 'pdf' }, access).error, /unsupported value/);
  assert.match(validateToolArguments('evaluation_review', { runIds: [idA, idB, 'ev_' + 'c'.repeat(24)] }, access).error, /at most 2 items/);
});

ok('app resource loading and tool discovery stay within the local render-input budget', () => {
  const started = performance.now();
  for (let i = 0; i < 1_000; i++) {
    listMcpAppResources(); readMcpAppResource(MCP_APP_RESOURCE_URI); buildMcpTools(access);
  }
  assert(performance.now() - started < 1_500);
});

ok('the UI source uses text-only rendering and accessible chart/table controls', () => {
  const source = readFileSync(join(ROOT, 'mcp-apps', 'evaluation-review.js'), 'utf8');
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /callServerTool/);
  assert.match(source, /evaluation_history/);
  assert.match(source, /evaluation_get/);
  assert.match(source, /evaluation_compare/);
  assert.match(source, /evaluation_export/);
  assert.doesNotMatch(source, /paper_trade_open|live|swap|convert|sendTransaction/);
});

console.log('MCP Apps evaluation-review checks passed');
