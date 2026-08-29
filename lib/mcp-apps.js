// Static MCP Apps resources. User data is never embedded in these resources;
// private evidence arrives only through separately authorized MCP tool results.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_RESOURCE_URI = 'ui://iost-terminal/evaluation-review-v1.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_FILE = join(ROOT, 'public', 'mcp-apps', 'evaluation-review.html');
const APP_HTML = readFileSync(APP_FILE, 'utf8');
const APP_SHA256 = crypto.createHash('sha256').update(APP_HTML).digest('hex');
const UI_META = Object.freeze({
  ui: Object.freeze({ csp: Object.freeze({}), permissions: Object.freeze({}), prefersBorder: true }),
});

const RESOURCE = Object.freeze({
  uri: MCP_APP_RESOURCE_URI,
  name: 'IOST Terminal Evaluation Review',
  title: 'Paper-only evaluation evidence',
  description: 'Interactive private walk-forward evaluation history, comparison, charts and deterministic evidence exports.',
  mimeType: MCP_APP_MIME_TYPE,
  annotations: { audience: ['user'], priority: 1 },
  _meta: UI_META,
});

export function listMcpAppResources() {
  return [structuredClone(RESOURCE)];
}

export function readMcpAppResource(uri) {
  if (uri !== MCP_APP_RESOURCE_URI) return null;
  return {
    contents: [{
      uri: MCP_APP_RESOURCE_URI,
      mimeType: MCP_APP_MIME_TYPE,
      text: APP_HTML,
      _meta: structuredClone(UI_META),
    }],
    _meta: { sha256: APP_SHA256, cacheScope: 'public', ttlMs: 300_000 },
  };
}

export const mcpAppPathsForTest = Object.freeze({ appFile: APP_FILE, sha256: APP_SHA256 });
