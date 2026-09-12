import { mkdirSync, lstatSync, readdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';
const hash = x => createHash('sha256').update(x).digest('hex');
const sync = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const id = x => { if (typeof x !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(x)) throw Error('id'); return x; };
const digest = x => { if (typeof x !== 'string' || !/^[a-f0-9]{64}$/.test(x)) throw Error('binding'); return x; };
const reviewPresent = path => {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
function decimal(x) {
  if (typeof x !== 'string' || !/^-?(0|[1-9]\d{0,19})(\.\d{1,10})?$/.test(x)) throw Error('decimal');
  const negative = x.startsWith('-'), [w, f = ''] = (negative ? x.slice(1) : x).split('.');
  return (negative ? -1n : 1n) * (BigInt(w) * 10000000000n + BigInt(f.padEnd(10, '0')));
}
function normalize(binding, evidence) {
  const b = { venueOrderId: id(binding.venueOrderId), credentialBinding: digest(binding.credentialBinding), venueAccountBinding: digest(binding.venueAccountBinding) };
  if (evidence.status !== 'fill-ledger-links-matched' || evidence.settlementVerified !== false || evidence.releaseAllowed !== false || evidence.executionAuthorized !== false || !Array.isArray(evidence.links) || !evidence.links.length || evidence.links.length > 20) throw Error('evidence');
  const links = evidence.links.map(l => {
    if (!Array.isArray(l.ledgerIds) || l.ledgerIds.length !== 2 || !Array.isArray(l.assets) || l.assets.length !== 2) throw Error('legs');
    const assets = l.assets.map(a => {
      if (typeof a.asset !== 'string' || !/^[A-Z0-9]{2,12}$/.test(a.asset) || decimal(a.fee) < 0n || decimal(a.amount) - decimal(a.fee) !== decimal(a.netChange)) throw Error('asset');
      // Canonical integer units, not monetary posting instructions.
      return { asset: a.asset, amount: decimal(a.amount).toString(), fee: decimal(a.fee).toString(), netChange: decimal(a.netChange).toString() };
    }).sort((a, b) => a.asset.localeCompare(b.asset));
    if (assets[0].asset === assets[1].asset) throw Error('assets');
    return { fillId: id(l.fillId), fillDigest: digest(l.fillDigest), ledgerIds: l.ledgerIds.map(id).sort(), assets };
  }).sort((a, b) => a.fillId.localeCompare(b.fillId));
  if (new Set(links.map(l => l.fillId)).size !== links.length || new Set(links.flatMap(l => l.ledgerIds)).size !== links.length * 2) throw Error('duplicates');
  return { binding: b, links };
}

// Private append-only evidence, NOT accounting. No balances or hold releases.
export function createLiveSettlementHistory(root) {
  return { append(ownerId, binding, evidence) {
    const held = { status: 'held', settlementVerified: false, releaseAllowed: false, executionAuthorized: false, ownerReviewRequired: true };
    try {
      if (!isAbsolute(root) || typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) return held;
      const next = normalize(binding, evidence);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const directory = join(root, hash(ownerId)); mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const path of [root, directory]) { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) throw Error('directory'); }
      sync(dirname(root)); sync(root);
      const reviewPath = join(directory, 'review-required.json');
      if (reviewPresent(reviewPath)) return { ...held, reasonCode: 'settlement-evidence-review-required' };
      const flagConflict = (reasonCode, previousEvidence, incomingEvidence) => {
        // Preserve the first conflict; no private identifiers or financial payload
        // in the marker. Existing history remains untouched. No automatic clear.
        const marker = { version: 1, reasonCode, previousDigest: hash(previousEvidence), incomingDigest: hash(incomingEvidence) };
        let fd;
        try {
          fd = openSync(reviewPath, 'wx', 0o600);
          writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd);
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { if (fd !== undefined) closeSync(fd); }
        sync(directory);
        return { ...held, reasonCode: 'settlement-evidence-review-required' };
      };
      const names = readdirSync(directory).sort(); if (names.length > 128) return held;
      const fills = new Map(), ledgers = new Set(); let previousHash = null;
      for (let i = 0; i < names.length; i++) {
        if (names[i] !== `${String(i + 1).padStart(8, '0')}.json`) throw Error('sequence');
        const fd = openSync(join(directory, names[i]), constants.O_RDONLY | constants.O_NOFOLLOW); let r;
        try { const s = fstatSync(fd); if (!s.isFile() || s.size > 32768 || (s.mode & 0o777) !== 0o600) throw Error('file'); r = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
        const payload = { version: 1, sequence: i + 1, previousHash, data: r.data };
        if (r.version !== 1 || r.sequence !== i + 1 || r.previousHash !== previousHash || r.hash !== hash(JSON.stringify(payload)) || !Array.isArray(r.data?.links) || !r.data.links.length || r.data.links.length > 20) throw Error('integrity');
        for (const l of r.data.links) {
          id(l.fillId); if (!Array.isArray(l.ledgerIds) || l.ledgerIds.length !== 2 || fills.has(l.fillId)) throw Error('duplicate fill');
          for (const key of l.ledgerIds) { id(key); if (ledgers.has(key)) throw Error('duplicate ledger'); ledgers.add(key); }
          fills.set(l.fillId, JSON.stringify({ binding: r.data.binding, link: l }));
        }
        previousHash = r.hash;
      }
      const additions = [];
      for (const link of next.links) {
        const old = fills.get(link.fillId), encoded = JSON.stringify({ binding: next.binding, link });
        if (old) { if (old !== encoded) return flagConflict('recorded-fill-changed', old, encoded); continue; }
        if (link.ledgerIds.some(key => ledgers.has(key))) return flagConflict('recorded-ledger-reused', previousHash, encoded);
        additions.push(link);
      }
      if (reviewPresent(reviewPath)) return { ...held, reasonCode: 'settlement-evidence-review-required' };
      if (!additions.length) return { ...held, status: 'replay', ownerReviewRequired: false };
      if (names.length === 128) return held;
      const sequence = names.length + 1, data = { binding: next.binding, links: additions };
      const payload = { version: 1, sequence, previousHash, data };
      const encoded = JSON.stringify({ ...payload, hash: hash(JSON.stringify(payload)) });
      if (Buffer.byteLength(encoded) > 32768) return held;
      const fd = openSync(join(directory, `${String(sequence).padStart(8, '0')}.json`), 'wx', 0o600);
      try { writeFileSync(fd, encoded); fsyncSync(fd); } finally { closeSync(fd); }
      sync(directory);
      if (reviewPresent(reviewPath)) return { ...held, reasonCode: 'settlement-evidence-review-required' };
      return { ...held, status: 'recorded', newEvidenceFills: additions.length, ownerReviewRequired: false };
    } catch { return held; }
  } };
}
