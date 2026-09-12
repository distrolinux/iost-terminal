// Durable, conservative one-submission hold per owner. No release/expiry API.
// A new order remains blocked until a separately reviewed reconciler exists.
import { openSync, closeSync, writeFileSync, fsyncSync, mkdirSync, readFileSync, fstatSync, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

export function createLiveSubmissionHold(directory) {
  const pathFor = ownerId => {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) throw Error('owner');
    return join(directory, createHash('sha256').update(ownerId).digest('hex') + '.json');
  };
  const readRecord = file => {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o777) !== 0o600) throw Error('store');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  };
  const readHold = ownerId => {
    const hold = readRecord(pathFor(ownerId));
    if (hold.version !== 1 || hold.status !== 'submission-unreconciled' || typeof hold.clientOrderId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(hold.clientOrderId) || !hold.order) throw Error('hold');
    return hold;
  };
  return {
    // Immutable acknowledgement sidecar never replaces or removes the hold.
    acknowledge(ownerId, clientOrderId, venueOrderId) {
      try {
        const hold = readHold(ownerId);
        if (hold.clientOrderId !== clientOrderId || typeof venueOrderId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(venueOrderId)) throw Error('identity');
        const fd = openSync(pathFor(ownerId) + '.ack', 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ version: 1, clientOrderId, venueOrderId }));
          fsyncSync(fd);
        } finally { closeSync(fd); }
        const dir = openSync(directory, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
        return { ok: true };
      } catch { return { ok: false }; }
    },
    read(ownerId) {
      try {
        const hold = readHold(ownerId), ack = readRecord(pathFor(ownerId) + '.ack');
        if (ack.version !== 1 || ack.clientOrderId !== hold.clientOrderId || typeof ack.venueOrderId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(ack.venueOrderId)) throw Error('acknowledgement');
        return { ok: true, hold: { ...hold, venueOrderId: ack.venueOrderId } };
      } catch { return { ok: false }; }
    },
    claim(ownerId, order) {
      try {
        if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) throw Error('owner');
        if (!order || typeof order.symbol !== 'string' || !/^[A-Z0-9]{2,12}$/.test(order.symbol) || !['long', 'short'].includes(order.side) || !Number.isFinite(order.size) || order.size <= 0 || (order.entry != null && (!Number.isFinite(order.entry) || order.entry <= 0))) throw Error('order');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const parent = openSync(dirname(directory), 'r');
        try { fsyncSync(parent); } finally { closeSync(parent); }
        const file = join(directory, createHash('sha256').update(ownerId).digest('hex') + '.json');
        const clientOrderId = randomUUID();
        // Exclusive creation is the concurrency barrier across server processes.
        // An incomplete file is deliberately retained as a blocking hold.
        const fd = openSync(file, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ version: 1, clientOrderId, status: 'submission-unreconciled', order: { symbol: order.symbol, side: order.side, size: String(order.size), entry: order.entry == null ? null : String(order.entry) }, createdAt: Date.now() }));
          fsyncSync(fd);
        } finally { closeSync(fd); }
        const dir = openSync(directory, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
        return { ok: true, clientOrderId };
      } catch { return { ok: false, error: 'Submission held or storage unavailable; reconciliation required.' }; }
    },
  };
}
