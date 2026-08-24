// Real child-process participant for the snapshot finalization race regression.
process.env.IOST_DATA_DIR = process.env.AITT_SNAPSHOT_RACE_DIR;

const { finalizeSnapshot } = await import('../lib/aitt-snapshot.js');

process.send?.({ ready: true });
process.on('message', (message) => {
  if (message !== 'finalize') return;
  const result = finalizeSnapshot({
    cutoff: Number(process.env.AITT_SNAPSHOT_RACE_CUTOFF),
    fundedCapPoints: Number(process.env.AITT_SNAPSHOT_RACE_CAP),
  });
  process.send?.({
    ok: result.ok,
    error: result.error,
    already: result.already,
    cutoff: result.snapshot?.cutoff,
    fundedCapPoints: result.snapshot?.fundedCapPoints,
    snapshotHash: result.snapshot?.snapshotHash,
  });
  process.disconnect?.();
});
