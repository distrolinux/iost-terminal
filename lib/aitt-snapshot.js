// Final eligible-points snapshot tooling. No token is issued by this module.
import {
  closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEligibleBalancesAt } from './points.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'aitt-points-snapshot.json');
const SCHEMA_VERSION = 1;

function loadFinalized() {
  try {
    if (!existsSync(FILE)) return null;
    const snapshot = JSON.parse(readFileSync(FILE, 'utf8'));
    return snapshot?.status === 'finalized' ? snapshot : null;
  } catch {
    return null;
  }
}

function hashBody(snapshot) {
  const body = {
    schemaVersion: snapshot.schemaVersion,
    status: snapshot.status,
    cutoff: snapshot.cutoff,
    fundedCapPoints: snapshot.fundedCapPoints,
    totalEligiblePoints: snapshot.totalEligiblePoints,
    entries: snapshot.entries,
  };
  return `0x${crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

function removeOwnedTemp(tmp, descriptor) {
  try {
    const opened = fstatSync(descriptor);
    const named = lstatSync(tmp);
    if (opened.dev === named.dev && opened.ino === named.ino) unlinkSync(tmp);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function saveFinalized(snapshot, { writeSnapshot = writeFileSync } = {}) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = openSync(tmp, 'wx', 0o600);
  try {
    writeSnapshot(descriptor, JSON.stringify(snapshot, null, 2), { encoding: 'utf8' });
    // A hard link publishes the complete temp file only when FILE does not exist.
    // Unlike rename, link never replaces a competing process's finalized artifact.
    linkSync(tmp, FILE);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      removeOwnedTemp(tmp, descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

export function verifySnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.status !== 'finalized') return false;
  if (!Number.isSafeInteger(snapshot.cutoff) || snapshot.cutoff < 0) return false;
  if (!Number.isSafeInteger(snapshot.fundedCapPoints) || snapshot.fundedCapPoints <= 0) return false;
  if (!Number.isSafeInteger(snapshot.totalEligiblePoints) || snapshot.totalEligiblePoints < 0) return false;
  if (!Array.isArray(snapshot.entries)) return false;

  let priorOwner = null;
  let total = 0;
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.ownerId !== 'string' || !entry.ownerId) return false;
    if (!Number.isSafeInteger(entry.points) || entry.points <= 0) return false;
    if (priorOwner !== null && priorOwner >= entry.ownerId) return false;
    priorOwner = entry.ownerId;
    total += entry.points;
    if (!Number.isSafeInteger(total)) return false;
  }
  return total === snapshot.totalEligiblePoints
    && total <= snapshot.fundedCapPoints
    && snapshot.snapshotHash === hashBody(snapshot);
}

export function finalizeSnapshot({ cutoff, fundedCapPoints } = {}, io = undefined) {
  const cutoffMs = Number(cutoff);
  const cap = Number(fundedCapPoints);
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
    return { ok: false, error: 'cutoff must be a non-negative UTC millisecond integer' };
  }
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    return { ok: false, error: 'funded cap must be a positive whole-point integer' };
  }

  const artifactExists = existsSync(FILE);
  const existing = loadFinalized();
  if (artifactExists && !existing) return { ok: false, error: 'stored snapshot artifact is invalid' };
  if (existing) {
    if (!verifySnapshot(existing)) return { ok: false, error: 'stored finalized snapshot is invalid' };
    if (existing.cutoff !== cutoffMs || existing.fundedCapPoints !== cap) {
      return { ok: false, error: 'finalized snapshot is immutable' };
    }
    return { ok: true, snapshot: existing, already: true };
  }

  const entries = getEligibleBalancesAt(cutoffMs);
  const totalEligiblePoints = entries.reduce((sum, entry) => sum + entry.points, 0);
  if (!Number.isSafeInteger(totalEligiblePoints)) {
    return { ok: false, error: 'eligible points total exceeds safe integer range' };
  }
  if (totalEligiblePoints > cap) {
    return {
      ok: false,
      error: 'eligible points exceed funded cap',
      totalEligiblePoints,
      fundedCapPoints: cap,
      oversubscribedByPoints: totalEligiblePoints - cap,
      behavior: 'snapshot not created; obtain owner-approved funding/cap or move the cutoff without changing the 1:1 rule',
    };
  }

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    status: 'finalized',
    cutoff: cutoffMs,
    fundedCapPoints: cap,
    totalEligiblePoints,
    entries,
  };
  snapshot.snapshotHash = hashBody(snapshot);
  if (!saveFinalized(snapshot, io)) {
    const competing = loadFinalized();
    if (!competing || !verifySnapshot(competing)) {
      return { ok: false, error: 'stored snapshot artifact is invalid' };
    }
    if (competing.cutoff !== cutoffMs || competing.fundedCapPoints !== cap) {
      return { ok: false, error: 'finalized snapshot is immutable' };
    }
    return { ok: true, snapshot: competing, already: true };
  }
  return { ok: true, snapshot };
}

export function getFinalizedSnapshot() {
  const snapshot = loadFinalized();
  return snapshot && verifySnapshot(snapshot) ? snapshot : null;
}