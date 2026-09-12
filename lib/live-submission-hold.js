// Durable, conservative one-submission hold per owner. No release/expiry API.
// A new order remains blocked until a separately reviewed reconciler exists.
import { openSync, closeSync, writeFileSync, fsyncSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

export function createLiveSubmissionHold(directory) {
  return {
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
