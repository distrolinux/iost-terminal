import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentReleaseTrust } from '../lib/agent-release-trust.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const packageLock = read('package-lock.json');
const dockerfile = read('Dockerfile');
const inputs = { revision: 'a'.repeat(40), packageLock, dockerfile, workflow: read('.github/workflows/safety.yml'),
  deployScript: read('deploy-host.sh'), expected: { packageLockSha256: sha(packageLock), dockerfileSha256: sha(dockerfile) } };

const status = buildAgentReleaseTrust(inputs);
assert.equal(status.status, 'verified');
assert.equal(status.decision, 'allow');
assert.equal(status.reasonCode, 'release-trust-passed');
assert.equal(status.sbom.integrityCoveragePercent, 100);
assert.ok(status.sbom.packageCount > 0);
assert.equal(status.container.baseDigestPinned, true);
assert.equal(status.pipeline.actionsPinned, true);
assert.equal(status.pipeline.immutableSbomArtifact, true);
assert.equal(status.checks.runtimeProvenanceMatches, true);
assert.deepEqual(status.failedChecks, []);
assert.deepEqual(status.execution, { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false });
assert.equal(status.liveScopeUsed, false);
assert.equal(status.publicChainUsed, false);

const mismatch = buildAgentReleaseTrust({ ...inputs, expected: { ...inputs.expected, dockerfileSha256: '0'.repeat(64) } });
assert.equal(mismatch.status, 'blocked');
assert.equal(mismatch.decision, 'deny');
assert.ok(mismatch.failedChecks.includes('runtimeProvenanceMatches'));

const unpinned = buildAgentReleaseTrust({ ...inputs, dockerfile: dockerfile.replace(/@sha256:[a-f0-9]{64}/, '') });
assert.equal(unpinned.status, 'blocked');
assert.ok(unpinned.failedChecks.includes('baseImageDigestPinned'));

const server = read('server.js');
const mcp = read('lib/mcp-protocol.js');
const ui = read('public/js/app.js');
assert.match(server, /agent_release_trust_status/);
assert.match(server, /\/api\/agent-release-trust/);
assert.match(mcp, /readTool\('agent_release_trust_status'/);
assert.match(ui, /Agent Release Trust/);
console.log('Agent release trust checks passed');
