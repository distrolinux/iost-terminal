import { mkdirSync, lstatSync, openSync, closeSync, fsyncSync, fstatSync, readFileSync, writeFileSync, unlinkSync, constants } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';

const syncDirectory = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const requestClass = method => method === 'AddOrder' ? 'order-submission' : method === 'CancelOrder' ? 'order-cancellation' : ['GetApiKeyInfo', 'Balance', 'BalanceEx', 'OpenOrders', 'OpenPositions', 'QueryOrders', 'QueryTrades', 'Ledgers', 'TradeVolume'].includes(method) ? 'read-only' : 'unknown';
const readPrivate = (path, limit) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o777) !== 0o600) throw Error('Unsafe recovery evidence');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
};
// Local metadata only. No exchange query, lock removal, nonce disclosure or PID
// liveness inference. A lock can belong to a currently running request.
export function inspectKrakenRecovery(root, id) {
  const unavailable = { status: 'unavailable', requestClass: 'unknown', requestStillRunning: 'unknown', releaseAllowed: false, retryAllowed: false, executionAuthorized: false, ownerReviewRequired: true };
  try {
    if (!isAbsolute(root) || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return unavailable;
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) return unavailable;
    let lock = null;
    try { lock = readPrivate(join(root, id + '.lock'), 256); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let noncePresent = false;
    try {
      const nonce = readPrivate(join(root, id + '.nonce'), 20);
      if (!/^[1-9]\d{0,19}$/.test(nonce) || BigInt(nonce) > 18446744073709551615n) return unavailable;
      noncePresent = true;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (lock === null) return { ...unavailable, status: noncePresent ? 'no-lock-observed' : 'not-observed', ownerReviewRequired: false };
    let kind = 'unknown';
    if (lock !== 'held') {
      const data = JSON.parse(lock);
      if (data.version !== 1 || !['unknown', 'read-only', 'order-submission', 'order-cancellation'].includes(data.requestClass)) return unavailable;
      kind = data.requestClass;
    }
    return { ...unavailable, status: 'held', requestClass: kind, nonceEvidencePresent: noncePresent, reasonCode: kind === 'read-only' ? 'request-coordination-review-required' : 'exchange-outcome-review-required' };
  } catch { return unavailable; }
}
// Shared local filesystem required. No stale-lock expiry, retry, or recovery API.
// Callback failure/crash deliberately retains its lock until reviewed recovery.
export function createDurableKrakenLane(root) {
  if (!isAbsolute(root)) throw Error('Absolute coordination directory required');
  return async (id, operation, now = Date.now, method = null) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw Error('Invalid coordination identity');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw Error('Unsafe coordination directory');
    syncDirectory(dirname(root));
    const lock = join(root, id + '.lock'), nonceFile = join(root, id + '.nonce');
    const lockFd = openSync(lock, 'wx', 0o600);
    try { writeFileSync(lockFd, JSON.stringify({ version: 1, requestClass: requestClass(method) })); fsyncSync(lockFd); } finally { closeSync(lockFd); }
    syncDirectory(root);
    // Every failure after exclusive creation leaves the lock in place.
    let previous = 0n;
    try {
      const fd = openSync(nonceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || s.size > 20 || (s.mode & 0o777) !== 0o600) throw Error('Invalid nonce store');
        const value = readFileSync(fd, 'utf8');
        if (!/^[1-9]\d{0,19}$/.test(value)) throw Error('Invalid persisted nonce');
        previous = BigInt(value);
      } finally { closeSync(fd); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw Error('Invalid clock');
    const clock = BigInt(time) * 1000n;
    const next = clock > previous ? clock : previous + 1n;
    if (next > 18446744073709551615n) throw Error('Nonce exhausted');
    const fd = openSync(nonceFile, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, String(next)); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(root);
    const result = await operation(String(next));
    unlinkSync(lock);
    syncDirectory(root);
    return result;
  };
}
