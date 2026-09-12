import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createLiveSubmissionHold } from '../lib/live-submission-hold.js';
const scratch = mkdtempSync(join(tmpdir(), 'iost-hold-'));
const order = { symbol: 'BTC', side: 'long', size: 0.0001, entry: 50000 };
try {
  const dir = join(scratch, 'holds'), holds = createLiveSubmissionHold(dir);
  assert.equal(holds.claim('owner-a', order).ok, false, 'new unbound holds rejected');
  const a = holds.claim('owner-a', order, "a".repeat(64), "b".repeat(64)); assert.equal(a.ok, true);
  assert.equal(holds.claim('owner-a', order, "a".repeat(64), "b".repeat(64)).ok, false);
  const file = join(dir, readdirSync(dir)[0]);
  assert.equal(JSON.parse(readFileSync(file)).clientOrderId, a.clientOrderId);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const script = `import { createLiveSubmissionHold } from ${JSON.stringify(new URL('../lib/live-submission-hold.js', import.meta.url).href)}; const r = createLiveSubmissionHold(${JSON.stringify(dir)}).claim('owner-a', ${JSON.stringify(order)}, "a".repeat(64), "b".repeat(64)); process.exit(r.ok ? 1 : 0);`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script]).status, 0, 'new process blocks persisted owner');
  writeFileSync(file, '{broken');
  assert.equal(holds.claim('owner-a', order, "a".repeat(64), "b".repeat(64)).ok, false, 'corrupt hold cannot be cleared by retry');
  assert.equal(holds.claim('owner-b', order, "a".repeat(64), "b".repeat(64)).ok, true, 'separate owner');
  const race = script.replaceAll('owner-a', 'owner-race').replace('r.ok ? 1 : 0', 'r.ok ? 0 : 2');
  const run = () => new Promise(resolve => { const p = spawn(process.execPath, ['--input-type=module', '-e', race], { stdio: 'ignore' }); p.on('exit', resolve); });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), [0, 2]);
  const invalid = createLiveSubmissionHold(file).claim('owner-c', order, "a".repeat(64), "b".repeat(64)); assert.equal(invalid.ok, false);
  console.log('Submission hold restart, corruption, isolation and process-race checks passed');
} finally { rmSync(scratch, { recursive: true, force: true }); }
