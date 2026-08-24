// Scratch-backed final eligible-points snapshot and funded-cap regression.
import { readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, '.tmp-aitt-snapshot-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

const points = await import('../lib/points.js');
let snapshots = {};
try { snapshots = await import('../lib/aitt-snapshot.js'); } catch { /* RED: module not implemented */ }

let passed = 0;
let failed = 0;
const ok = (name, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (condition) passed++;
  else failed++;
};

const runFinalizer = ({ cutoff, fundedCapPoints }) => new Promise((resolve, reject) => {
  const worker = fork(join(ROOT, 'tests', 'aitt-snapshot-finalize-worker.mjs'), [], {
    env: {
      ...process.env,
      AITT_SNAPSHOT_RACE_DIR: SCRATCH,
      AITT_SNAPSHOT_RACE_CUTOFF: String(cutoff),
      AITT_SNAPSHOT_RACE_CAP: String(fundedCapPoints),
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  worker.once('error', reject);
  worker.once('exit', (code) => {
    if (code !== 0) reject(new Error(`snapshot race worker exited ${code}`));
  });
  worker.once('message', () => resolve({
    worker,
    result: new Promise((resultResolve) => worker.once('message', resultResolve)),
  }));
});

try {
  const finalizeSnapshot = snapshots.finalizeSnapshot || (() => ({ ok: false, error: 'snapshot tooling missing' }));
  const verifySnapshot = snapshots.verifySnapshot || (() => false);
  points.credit({ ownerId: 'user:zeta', event: 'signal', refId: 'eligible-zeta' });
  points.credit({ ownerId: 'user:alpha', event: 'follower', refId: 'eligible-alpha' });
  points.awardSignup('user:alpha');
  points.awardSignup('user:provisional-only');
  const cutoff = Date.now();

  const finalized = finalizeSnapshot({ cutoff, fundedCapPoints: 15 });
  ok('final snapshot includes only eligible points at or before cutoff',
    finalized.ok
      && finalized.snapshot.totalEligiblePoints === 15
      && JSON.stringify(finalized.snapshot.entries) === JSON.stringify([
        { ownerId: 'user:alpha', points: 5 },
        { ownerId: 'user:zeta', points: 10 },
      ]));
  ok('final snapshot records cutoff and configured funded cap',
    finalized.ok && finalized.snapshot.cutoff === cutoff && finalized.snapshot.fundedCapPoints === 15);
  ok('final snapshot has a deterministic verifiable hash',
    finalized.ok && /^0x[0-9a-f]{64}$/.test(finalized.snapshot.snapshotHash) && verifySnapshot(finalized.snapshot));

  const replay = finalizeSnapshot({ cutoff, fundedCapPoints: 15 });
  ok('identical snapshot creation is idempotent',
    replay.ok && replay.already === true && replay.snapshot.snapshotHash === finalized.snapshot.snapshotHash);

  points.credit({ ownerId: 'user:late', event: 'signal', refId: 'after-cutoff' });
  const immutableReplay = finalizeSnapshot({ cutoff, fundedCapPoints: 15 });
  ok('finalized snapshot remains immutable after later ledger activity',
    immutableReplay.ok
      && immutableReplay.snapshot.snapshotHash === finalized.snapshot.snapshotHash
      && !immutableReplay.snapshot.entries.some((entry) => entry.ownerId === 'user:late'));

  const changedInputs = finalizeSnapshot({ cutoff: cutoff + 1, fundedCapPoints: 15 });
  ok('finalized snapshot rejects different cutoff or cap inputs',
    !changedInputs.ok && changedInputs.error === 'finalized snapshot is immutable');

  const tampered = structuredClone(finalized.snapshot || {
    schemaVersion: 1, status: 'finalized', cutoff, fundedCapPoints: 15,
    totalEligiblePoints: 15, entries: [{ ownerId: 'user:alpha', points: 5 }],
    snapshotHash: `0x${'0'.repeat(64)}`,
  });
  tampered.entries[0].points += 1;
  ok('snapshot verification rejects accounting tampering', !verifySnapshot(tampered));

  writeFileSync(join(SCRATCH, 'aitt-points-snapshot.json'), '{malformed', { mode: 0o600 });
  const corruptStored = finalizeSnapshot({ cutoff, fundedCapPoints: 15 });
  ok('malformed finalized artifact fails closed instead of being overwritten',
    !corruptStored.ok && corruptStored.error === 'stored snapshot artifact is invalid');

  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  let injectedWriteError = null;
  try {
    finalizeSnapshot({ cutoff: Date.now(), fundedCapPoints: 25 }, {
      writeSnapshot(target, contents, options) {
        writeFileSync(target, String(contents).slice(0, 8), options);
        throw new Error('injected snapshot write failure');
      },
    });
  } catch (error) {
    injectedWriteError = error;
  }
  ok('failed snapshot write removes its partial non-authoritative temp file',
    injectedWriteError?.message === 'injected snapshot write failure'
      && !readdirSync(SCRATCH).some((name) => name.endsWith('.tmp'))
      && !readdirSync(SCRATCH).includes('aitt-points-snapshot.json'));

  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  let replacementTemp = null;
  try {
    finalizeSnapshot({ cutoff: Date.now(), fundedCapPoints: 25 }, {
      writeSnapshot() {
        const tempName = readdirSync(SCRATCH).find((name) => name.endsWith('.tmp'));
        replacementTemp = join(SCRATCH, tempName);
        rmSync(replacementTemp, { force: true });
        writeFileSync(replacementTemp, 'another process temp', { mode: 0o600 });
        throw new Error('injected replacement race');
      },
    });
  } catch { /* expected injected failure */ }
  ok('failed snapshot write does not delete another writer replacement temp file',
    replacementTemp !== null
      && readFileSync(replacementTemp, 'utf8') === 'another process temp'
      && !readdirSync(SCRATCH).includes('aitt-points-snapshot.json'));

  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  const oversubscribed = finalizeSnapshot({ cutoff: Date.now(), fundedCapPoints: 1 });
  ok('oversubscription fails explicitly without pro-rata reduction',
    !oversubscribed.ok
      && oversubscribed.error === 'eligible points exceed funded cap'
      && oversubscribed.totalEligiblePoints === 25
      && oversubscribed.fundedCapPoints === 1
      && oversubscribed.snapshot === undefined);

  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  const raceLedger = Array.from({ length: 100_000 }, (_, index) => ({
    id: `race-${index}`,
    ownerId: 'user:race',
    event: 'signup',
    points: 1,
    refId: null,
    ts: 1,
    meta: {},
  }));
  writeFileSync(join(SCRATCH, 'points.json'), JSON.stringify({
    ledger: raceLedger,
    referralCodes: {},
    refAwards: {},
    lastBountyWeek: null,
  }));
  const competitors = await Promise.all([
    runFinalizer({ cutoff: 10, fundedCapPoints: 100_000 }),
    runFinalizer({ cutoff: 11, fundedCapPoints: 100_000 }),
  ]);
  competitors.forEach(({ worker }) => worker.send('finalize'));
  const raceResults = await Promise.all(competitors.map(({ result }) => result));
  const storedRaceSnapshot = JSON.parse(readFileSync(join(SCRATCH, 'aitt-points-snapshot.json'), 'utf8'));
  const winners = raceResults.filter((result) => result.ok && result.already !== true);
  const losers = raceResults.filter((result) => !result.ok && result.error === 'finalized snapshot is immutable');
  ok('competing processes cannot replace a finalized snapshot',
    winners.length === 1
      && losers.length === 1
      && storedRaceSnapshot.snapshotHash === winners[0].snapshotHash
      && storedRaceSnapshot.cutoff === winners[0].cutoff,
    JSON.stringify(raceResults));
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
