import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { strict as assert } from 'node:assert';

const root = new URL('../', import.meta.url);
const budgets = JSON.parse(readFileSync(new URL('performance-budgets.json', root), 'utf8'));
const server = readFileSync(new URL('server.js', root), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

function asset(path) {
  const bytes = readFileSync(new URL(path, root));
  return { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}

function within(name, actual, limit) {
  assert.ok(actual <= limit, `${name}: ${actual} bytes exceeds ${limit}`);
  console.log(`PASS  ${name}: ${actual}/${limit} bytes`);
}

const landing = asset('public/index.html');
const operator = asset('public/img/ai-operator.webp');
const hub = asset('public/hub.html');
const three = asset('public/js/vendor/three.min.js');
const orbit = asset('public/js/vendor/OrbitControls.js');
const texture = asset('public/img/space-datacenter.png');
const webmcp = asset('public/js/webmcp.js');

within('landing HTML raw', landing.raw, budgets.landing.htmlRawBytes);
within('landing HTML gzip', landing.gzip, budgets.landing.htmlGzipBytes);
within('landing lazy operator image', operator.raw, budgets.landing.lazyOperatorImageBytes);
within('shared WebMCP raw', webmcp.raw, budgets.shared.webmcpRawBytes);
within('shared WebMCP gzip', webmcp.gzip, budgets.shared.webmcpGzipBytes);

within('Hub HTML raw', hub.raw, budgets.hub.htmlRawBytes);
within('Hub HTML gzip', hub.gzip, budgets.hub.htmlGzipBytes);
within('Three.js raw', three.raw, budgets.hub.threeRawBytes);
within('Three.js gzip', three.gzip, budgets.hub.threeGzipBytes);
within('OrbitControls raw', orbit.raw, budgets.hub.orbitControlsRawBytes);
within('OrbitControls gzip', orbit.gzip, budgets.hub.orbitControlsGzipBytes);
within('Hub texture', texture.raw, budgets.hub.textureBytes);

const hubInitialRaw = hub.raw + three.raw + orbit.raw + texture.raw + webmcp.raw;
const hubInitialTransfer = hub.gzip + three.gzip + orbit.gzip + texture.raw + webmcp.gzip;
within('Hub initial raw payload', hubInitialRaw, budgets.hub.initialRawBytes);
within('Hub initial compressed transfer', hubInitialTransfer, budgets.hub.initialTransferBytes);

assert.match(readFileSync(new URL('public/index.html', root), 'utf8'), /<img[^>]+ai-operator\.webp[^>]+loading="lazy"/);
assert.match(server, /import compression from 'compression'/);
assert.match(server, /req\.path !== '\/api\/events' && compression\.filter/);
assert.match(server, /express\.static\(join\(ROOT, 'public'\), \{ maxAge: '1h' \}\)/);
assert.ok(pkg.dependencies?.compression, 'compression must remain a production dependency');
console.log('PASS  compression, SSE bypass, static caching, and lazy-image contracts');
console.log('\nWeb performance budgets passed');
