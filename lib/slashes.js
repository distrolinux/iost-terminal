// lib/slashes.js — Phase 2 slash events + appeals
//
// Slash rules (TOKENOMICS §8): unauthorized spend −10% + Trust reset ·
// failed settlement −5% · appeal window 14 days, DAO review (owner until DAO).
// Store: data/slashes.json (append-only records; stake mutation lives in stakes.js)

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeStakes, slashStake, restoreStake } from './stakes.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'slashes.json');

export const SLASH_RULES = {
  'unauthorized-spend': { pct: 10, trustReset: true, label: 'Unauthorized spend' },
  'failed-settlement': { pct: 5, trustReset: false, label: 'Failed settlement' },
};
export const APPEAL_WINDOW_MS = 14 * 24 * 3600 * 1000;

const id = () => `sl_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function defaultStore() { return { slashes: [] }; }
let store = loadStore();
function loadStore() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.slashes)) return parsed;
    }
  } catch { /* corrupt → fresh */ }
  return defaultStore();
}
function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, FILE);
}

/**
 * Create + apply a slash across the agent's active stakes (proportional).
 * Returns the record. trustReset = Trust score reset (handled by trust.js via
 * counting open slashes with trustReset).
 */
export function createSlash({ ownerId, reason, evidence = {} }) {
  const rule = SLASH_RULES[reason];
  if (!rule) throw new Error(`unknown slash reason: ${reason}`);
  const stakes = activeStakes(ownerId);
  if (stakes.length === 0) throw new Error('no active stakes to slash');
  let totalReduction = 0n;
  const perStake = [];
  for (const s of stakes) {
    const r = slashStake({ stakeId: s.stakeId, pct: rule.pct, reason });
    perStake.push({ stakeId: s.stakeId, reductionMinor: r.reductionMinor });
    totalReduction += BigInt(r.reductionMinor);
  }
  const now = Date.now();
  const rec = {
    slashId: id(), ownerId, reason, label: rule.label, pct: rule.pct,
    trustReset: rule.trustReset, perStake,
    totalReductionMinor: totalReduction.toString(),
    evidence, ts: now,
    appealDeadlineTs: now + APPEAL_WINDOW_MS,
    status: 'open', appeal: null, decidedBy: null, decidedTs: null,
  };
  store.slashes.push(rec);
  save();
  return rec;
}

/** Read-only fetch (ownership checks must happen BEFORE any mutation). */
export function getSlash(slashId) {
  return store.slashes.find((x) => x.slashId === slashId) || null;
}

export function fileAppeal(slashId, statement) {
  const s = store.slashes.find((x) => x.slashId === slashId);
  if (!s) throw new Error('slash not found');
  if (s.status !== 'open') throw new Error(`cannot appeal slash in status ${s.status}`);
  if (Date.now() > s.appealDeadlineTs) {
    s.status = 'expired';
    save();
    throw new Error('appeal window closed (14 days)');
  }
  s.appeal = { statement: String(statement).slice(0, 2000), ts: Date.now() };
  save();
  return s;
}

/** DAO/owner decision. accepted → restore the slashed amounts to the stakes. */
export function decideAppeal({ slashId, decision, by }) {
  const s = store.slashes.find((x) => x.slashId === slashId);
  if (!s) throw new Error('slash not found');
  if (s.status !== 'open' || !s.appeal) throw new Error('no open appeal to decide');
  if (Date.now() > s.appealDeadlineTs) {
    s.status = 'expired';
    save();
    throw new Error('appeal window closed');
  }
  if (decision === 'accepted') {
    for (const p of s.perStake) {
      try { restoreStake({ stakeId: p.stakeId, amountMinor: p.reductionMinor }); } catch { /* stake may have been withdrawn — skip */ }
    }
  }
  s.status = decision === 'accepted' ? 'accepted' : 'rejected';
  s.decidedBy = by;
  s.decidedTs = Date.now();
  save();
  return s;
}

/** Open (unresolved) slashes — trust.js uses this for score penalties. */
export function openSlashes(ownerId) {
  return store.slashes.filter((s) => s.ownerId === ownerId && s.status === 'open');
}

export function slashHistory(ownerId, limit = 20) {
  return store.slashes
    .filter((s) => s.ownerId === ownerId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}
