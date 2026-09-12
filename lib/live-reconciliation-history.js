import { mkdirSync, lstatSync, readdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { previewLiveReconciliation } from './live-reconciliation-preview.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const units = value => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})(\.\d{1,10})?$/.test(value)) throw Error('decimal');
  const [w, f = ''] = value.split('.');
  return BigInt(w) * 10000000000n + BigInt(f.padEnd(10, '0'));
};
const decimal = value => { units(value); return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value; };
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(value)) throw Error('identity');
  return value;
};
function recordData(expected, observation, evidence) {
  if (previewLiveReconciliation(expected, observation).status === 'unknown') throw Error('observation');
  if (!['fill-totals-matched', 'no-fills-reported'].includes(evidence.status) || units(evidence.reportedFilledQuantity) !== units(observation.filledQuantity)) throw Error('fills');
  if (typeof expected.credentialBinding !== 'string' || !/^[a-f0-9]{64}$/.test(expected.credentialBinding)) throw Error('connection');
  const e = { clientOrderId: id(expected.clientOrderId), venueOrderId: id(expected.venueOrderId), pair: id(expected.pair), side: expected.side, quantity: decimal(expected.quantity), credentialBinding: expected.credentialBinding };
  const o = { ...e, status: observation.status, filledQuantity: decimal(observation.filledQuantity) };
  if (!Array.isArray(evidence.fills) || evidence.fills.length > 20) throw Error('fills');
  const fills = evidence.fills.map(f => {
    if (!/^[a-f0-9]{64}$/.test(f.digest)) throw Error('digest');
    return { id: id(f.id), digest: f.digest };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(fills.map(f => f.id)).size !== fills.length || (fills.length === 0) !== (units(o.filledQuantity) === 0n)) throw Error('fill IDs');
  if (!fills.length && (units(evidence.reportedCost) !== 0n || units(evidence.reportedFee) !== 0n)) throw Error('empty totals');
  return { expected: e, observation: o, evidence: { status: fills.length ? 'fill-totals-matched' : 'no-fills-reported', reportedFilledQuantity: o.filledQuantity, reportedCost: decimal(evidence.reportedCost), reportedFee: decimal(evidence.reportedFee), fills } };
}
function follows(previous, next) {
  if (!previous) return true;
  if (JSON.stringify(previous.expected) !== JSON.stringify(next.expected)) return false;
  if (previewLiveReconciliation(next.expected, next.observation, previous.observation).status === 'unknown') return false;
  if (['closed', 'canceled', 'expired'].includes(previous.observation.status)) return JSON.stringify(previous) === JSON.stringify(next);
  if (units(next.evidence.reportedCost) < units(previous.evidence.reportedCost) || units(next.evidence.reportedFee) < units(previous.evidence.reportedFee)) return false;
  if (previous.evidence.fills.some(old => !next.evidence.fills.some(f => f.id === old.id && f.digest === old.digest))) return false;
  // Existing fills cannot acquire a different aggregate without a new fill.
  if (previous.evidence.fills.length === next.evidence.fills.length && JSON.stringify(previous.evidence) !== JSON.stringify(next.evidence)) return false;
  return true;
}
const syncDirectory = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

// Internal evidence writer, NOT a ledger or execution permission. No release API.
// Exclusive next-sequence creation arbitrates concurrent processes; losers hold.
export function createLiveReconciliationHistory(root) {
  return { append(ownerId, expected, observation, evidence) {
    const held = { status: 'held', releaseAllowed: false, executionAuthorized: false };
    try {
      if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) throw Error('owner');
      const next = recordData(expected, observation, evidence);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const directory = join(root, hash(ownerId));
      mkdirSync(directory, { mode: 0o700, recursive: true });
      for (const path of [root, directory]) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw Error('directory');
      }
      syncDirectory(dirname(root)); syncDirectory(root);
      const names = readdirSync(directory).sort();
      if (names.length > 128) throw Error('capacity');
      let previous = null, previousHash = null;
      for (let i = 0; i < names.length; i++) {
        if (names[i] !== `${String(i + 1).padStart(8, '0')}.json`) throw Error('sequence');
        const fd = openSync(join(directory, names[i]), constants.O_RDONLY | constants.O_NOFOLLOW);
        let record;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o777) !== 0o600) throw Error('file');
          record = JSON.parse(readFileSync(fd, 'utf8'));
        } finally { closeSync(fd); }
        const data = recordData(record.data.expected, record.data.observation, record.data.evidence);
        const payload = { version: 1, sequence: i + 1, previousHash, data };
        if (record.version !== 1 || record.sequence !== i + 1 || record.previousHash !== previousHash || record.hash !== hash(JSON.stringify(payload)) || !follows(previous, data)) throw Error('integrity');
        previous = data; previousHash = record.hash;
      }
      if (!follows(previous, next)) return held;
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return { ...held, status: 'replay' };
      if (names.length === 128) return held;
      const sequence = names.length + 1;
      const payload = { version: 1, sequence, previousHash, data: next };
      const fd = openSync(join(directory, `${String(sequence).padStart(8, '0')}.json`), 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ ...payload, hash: hash(JSON.stringify(payload)) })); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(directory);
      return { ...held, status: 'recorded' };
    } catch { return held; }
  } };
}
