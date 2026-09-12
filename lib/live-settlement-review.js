import { lstatSync, readdirSync, openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const hash = x => createHash('sha256').update(x).digest('hex');
const validId = x => typeof x === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(x);
const validDigest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
function read(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!s.isFile() || s.size > limit || (s.mode & 0o777) !== 0o600) throw Error('private file'); return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
// Internal owner-scoped local inspection. No directory creation or repair.
// A future route must derive ownerId from the authenticated session, not input.
export function inspectLiveSettlementReview(root, ownerId) {
  const unknown = { status: 'unavailable', reasonCode: 'settlement-evidence-unavailable', historyIntegrity: 'unknown', ownerReviewRequired: true, readOnly: true, settlementVerified: false, releaseAllowed: false, executionAuthorized: false };
  try {
    if (!isAbsolute(root) || typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) return unknown;
    const directory = join(root, hash(ownerId));
    for (const path of [root, directory]) {
      let s; try { s = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return { ...unknown, status: 'not-observed', reasonCode: 'no-local-settlement-evidence' }; throw e; }
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) return unknown;
    }
    const initialNames = readdirSync(directory).sort();
    const marked = initialNames.includes('review-required.json');
    const names = initialNames.filter(n => n !== 'review-required.json');
    if (names.length > 128) return unknown;
    let previousHash = null; const fills = new Set(), ledgers = new Set();
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== `${String(i + 1).padStart(8, '0')}.json`) return unknown;
      const r = read(join(directory, names[i]), 32768);
      const payload = { version: 1, sequence: i + 1, previousHash, data: r.data };
      if (r.version !== 1 || r.sequence !== i + 1 || r.previousHash !== previousHash || r.hash !== hash(JSON.stringify(payload))) return unknown;
      const b = r.data?.binding;
      if (!b || !validId(b.venueOrderId) || !validDigest(b.credentialBinding) || !validDigest(b.venueAccountBinding) || !Array.isArray(r.data.links) || !r.data.links.length || r.data.links.length > 20) return unknown;
      for (const l of r.data.links) {
        if (!validId(l.fillId) || !validDigest(l.fillDigest) || fills.has(l.fillId) || !Array.isArray(l.ledgerIds) || l.ledgerIds.length !== 2) return unknown;
        fills.add(l.fillId);
        for (const id of l.ledgerIds) { if (!validId(id) || ledgers.has(id)) return unknown; ledgers.add(id); }
        if (!Array.isArray(l.assets) || l.assets.length !== 2 || l.assets[0].asset === l.assets[1].asset) return unknown;
        for (const a of l.assets) {
          if (typeof a.asset !== 'string' || !/^[A-Z0-9]{2,12}$/.test(a.asset)) return unknown;
          for (const f of ['amount', 'fee', 'netChange']) if (typeof a[f] !== 'string' || !/^-?(0|[1-9]\d{0,29})$/.test(a[f])) return unknown;
          if (BigInt(a.fee) < 0n || BigInt(a.amount) - BigInt(a.fee) !== BigInt(a.netChange)) return unknown;
        }
      }
      previousHash = r.hash;
    }
    let reasonCode = names.length ? 'no-recorded-settlement-conflict' : 'no-local-settlement-evidence';
    if (marked) {
      reasonCode = 'settlement-review-marker-unavailable';
      try {
        const m = read(join(directory, 'review-required.json'), 1024);
        if (m.version === 1 && ['recorded-fill-changed', 'recorded-ledger-reused'].includes(m.reasonCode) && validDigest(m.previousDigest) && validDigest(m.incomingDigest)) reasonCode = m.reasonCode;
      } catch { /* Even a corrupt marker requires review. */ }
    }
    // Detect observed concurrent append/marker creation; absence is not authority.
    if (JSON.stringify(initialNames) !== JSON.stringify(readdirSync(directory).sort())) return unknown;
    return { ...unknown, status: marked ? 'review-required' : names.length ? 'evidence-recorded' : 'not-observed', reasonCode, historyIntegrity: names.length ? 'verified-local-chain' : 'not-observed', ownerReviewRequired: marked || !names.length, recordCount: names.length, fillCount: fills.size, ledgerCount: ledgers.size };
  } catch { return unknown; }
}
