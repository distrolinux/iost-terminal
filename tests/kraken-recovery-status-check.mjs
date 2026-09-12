import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableKrakenLane, inspectKrakenRecovery } from '../lib/kraken-durable-lane.js';
const root = mkdtempSync(join(tmpdir(), 'iost-recovery-')), id = 'a'.repeat(64);
try {
  assert.equal(inspectKrakenRecovery(root, id).status, 'not-observed');
  const lane = createDurableKrakenLane(root);
  await assert.rejects(lane(id, async () => { throw Error('fixture'); }, Date.now, 'AddOrder'));
  const before = readdirSync(root).map(name => [name, readFileSync(join(root, name), 'utf8')]);
  const report = inspectKrakenRecovery(root, id);
  assert.equal(report.status, 'held'); assert.equal(report.requestClass, 'order-submission');
  assert.equal(report.releaseAllowed, false); assert.equal(report.retryAllowed, false);
  assert.equal(report.requestStillRunning, 'unknown');
  assert.ok(!JSON.stringify(report).includes(id));
  assert.deepEqual(readdirSync(root).map(name => [name, readFileSync(join(root, name), 'utf8')]), before);
  writeFileSync(join(root, id + '.lock'), 'held');
  assert.equal(inspectKrakenRecovery(root, id).requestClass, 'unknown');
  writeFileSync(join(root, id + '.nonce'), 'bad');
  assert.equal(inspectKrakenRecovery(root, id).status, 'unavailable');
  assert.equal(inspectKrakenRecovery(root, '../bad').status, 'unavailable');
  const other = 'b'.repeat(64);
  await assert.rejects(lane(other, async () => { throw Error('fixture'); }, Date.now, 'Balance'));
  assert.equal(inspectKrakenRecovery(root, other).requestClass, 'read-only');
  console.log('Read-only recovery classification, legacy locks, corruption and privacy checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
