import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createLiveSettlementHistory } from '../lib/live-settlement-history.js';
import { recordHeldSettlementEvidence } from '../lib/live-order-evidence.js';
const scratch = mkdtempSync(join(tmpdir(), 'iost-settlement-'));
const root = join(scratch, 'history');
const binding = { venueOrderId: 'O-1', credentialBinding: 'a'.repeat(64), venueAccountBinding: 'b'.repeat(64) };
const link = { fillId: 'T-1', fillDigest: 'c'.repeat(64), ledgerIds: ['L-1', 'L-2'], assets: [{ asset: 'XXBT', amount: '0.001', fee: '0.000001', netChange: '0.000999' }, { asset: 'ZUSD', amount: '-50', fee: '0', netChange: '-50' }] };
const evidence = { status: 'fill-ledger-links-matched', settlementVerified: false, releaseAllowed: false, executionAuthorized: false, links: [link] };
try {
  const store = createLiveSettlementHistory(root);
  assert.equal(store.append('owner', binding, evidence).status, 'recorded');
  const directory = join(root, readdirSync(root)[0]);
  const file = join(directory, '00000001.json'); const bytes = readFileSync(file, 'utf8');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(store.append('owner', binding, evidence).status, 'replay');
  const script = `import {createLiveSettlementHistory} from ${JSON.stringify(new URL('../lib/live-settlement-history.js', import.meta.url).href)}; console.log(createLiveSettlementHistory(process.argv[1]).append('owner',JSON.parse(process.argv[2]),JSON.parse(process.argv[3])).status);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(binding), JSON.stringify(evidence)], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(child.stdout.trim(), 'replay');
  const raceRoot = join(scratch, 'race');
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, raceRoot, JSON.stringify(binding), JSON.stringify(evidence)]);
    let output = ''; child.stdout.on('data', d => output += d); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(Error('child failed')));
  });
  const outcomes = await Promise.all([run(), run()]);
  assert.equal(outcomes.filter(x => x === 'recorded').length, 1);
  assert.ok(outcomes.every(x => ['recorded', 'held', 'replay'].includes(x)));
  const helper = await recordHeldSettlementEvidence({ read: () => ({ ok: true, hold: binding }) }, 'owner', { getLinkedSettlementEvidence: async () => evidence }, store, {});
  assert.equal(helper.status, 'replay');
  assert.equal((await recordHeldSettlementEvidence({ read: () => ({ ok: false }) }, 'owner', { getLinkedSettlementEvidence: () => assert.fail('unexpected broker call') }, store, {})).status, 'held');
  assert.equal(readFileSync(file, 'utf8'), bytes);
  let conflictIndex = 0;
  for (const changed of [
    { ...link, fillDigest: 'd'.repeat(64) },
    { ...link, fillId: 'T-OTHER' },
    { ...link, ledgerIds: ['L-1', 'L-NEW'] },
    { ...link, assets: [{ ...link.assets[0], fee: '0.000002', netChange: '0.000998' }, link.assets[1]] },
    { ...link, assets: [{ ...link.assets[0], fee: '0' }, link.assets[1]] }
  ]) {
    const subject = 'conflict-' + conflictIndex++;
    assert.equal(store.append(subject, binding, evidence).status, 'recorded');
    const rejected = store.append(subject, binding, { ...evidence, links: [changed] });
    assert.equal(rejected.status, 'held');
    if (rejected.reasonCode === 'settlement-evidence-review-required') assert.equal(store.append(subject, binding, evidence).status, 'held');
  }
  const correctionRoot = join(scratch, 'correction');
  const correction = createLiveSettlementHistory(correctionRoot);
  correction.append('owner', binding, evidence);
  const originalDir = join(correctionRoot, readdirSync(correctionRoot)[0]);
  const originalBytes = readFileSync(join(originalDir, '00000001.json'), 'utf8');
  const conflict = correction.append('owner', { ...binding, venueOrderId: 'O-OTHER' }, evidence);
  assert.equal(conflict.status, 'held'); assert.equal(conflict.ownerReviewRequired, true);
  assert.equal(correction.append('owner', binding, evidence).status, 'held');
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', script, correctionRoot, JSON.stringify(binding), JSON.stringify(evidence)], { encoding: 'utf8' });
  assert.equal(restarted.status, 0); assert.equal(restarted.stdout.trim(), 'held');
  assert.equal(readFileSync(join(originalDir, '00000001.json'), 'utf8'), originalBytes);
  assert.equal(statSync(join(originalDir, 'review-required.json')).mode & 0o777, 0o600);
  const markerPath = join(originalDir, 'review-required.json');
  const marker = readFileSync(markerPath, 'utf8');
  assert.ok(!marker.includes(binding.venueOrderId)); assert.ok(!marker.includes(link.fillId));
  correction.append('owner', binding, { ...evidence, links: [{ ...link, fillDigest: 'e'.repeat(64) }] });
  assert.equal(readFileSync(markerPath, 'utf8'), marker);
  writeFileSync(markerPath, '{partial');
  assert.equal(correction.append('owner', binding, evidence).status, 'held');
  const second = { ...link, fillId: 'T-2', ledgerIds: ['L-3', 'L-4'] };
  assert.equal(store.append('owner', binding, { ...evidence, links: [link, second] }).newEvidenceFills, 1);
  assert.equal(readdirSync(directory).length, 2);
  assert.equal(JSON.parse(readFileSync(join(directory, '00000002.json'))).data.links.length, 1);
  assert.equal(store.append('owner', binding, { ...evidence, links: [second, link] }).status, 'replay');
  assert.equal(store.append('other-owner', binding, evidence).status, 'recorded');
  writeFileSync(file, '{broken');
  const result = store.append('owner', binding, evidence);
  assert.equal(result.status, 'held'); assert.equal(result.releaseAllowed, false); assert.equal(result.settlementVerified, false);
  assert.equal(readdirSync(directory).length, 2);
  console.log('Persistent settlement evidence deduplication/restart/corruption checks passed');
} finally { rmSync(scratch, { recursive: true, force: true }); }
