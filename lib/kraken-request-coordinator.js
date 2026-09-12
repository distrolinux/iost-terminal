import { createHash } from 'node:crypto';

// Process-local only. No raw keys retained in the registry. No network retries.
// Never evict nonce history while this process is running: capacity fails closed.
const lanes = new Map();
export async function coordinateKrakenRequest(apiKey, operation, now = Date.now) {
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096) throw Error('Kraken coordination unavailable');
  const id = createHash('sha256').update(apiKey).digest('hex');
  if (!lanes.has(id)) {
    if (lanes.size >= 4096) throw Error('Kraken coordination capacity reached');
    lanes.set(id, { tail: Promise.resolve(), nonce: 0n, pending: 0 });
  }
  const lane = lanes.get(id);
  if (lane.pending >= 32) throw Error('Kraken request queue full');
  lane.pending++;
  const queuedAt = performance.now();
  const run = lane.tail.then(async () => {
    if (performance.now() - queuedAt > 10000) throw Error('Kraken request queue deadline reached');
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw Error('Kraken clock unavailable');
    const candidate = BigInt(time) * 1000n;
    lane.nonce = candidate > lane.nonce ? candidate : lane.nonce + 1n;
    return operation(String(lane.nonce));
  });
  lane.tail = run.catch(() => {});
  try { return await run; } finally { lane.pending--; }
}
