import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(ROOT, 'mcp-apps', 'evaluation-review.html'), 'utf8');
const result = await build({
  entryPoints: [join(ROOT, 'mcp-apps', 'evaluation-review.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  write: false,
  legalComments: 'none',
});
const bundle = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const output = template.replace('/*__APP_BUNDLE__*/', bundle);
if (output === template) throw new Error('MCP App bundle placeholder missing');
const outFile = join(ROOT, 'public', 'mcp-apps', 'evaluation-review.html');
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, output);
console.log(`built ${outFile} (${Buffer.byteLength(output)} bytes)`);
