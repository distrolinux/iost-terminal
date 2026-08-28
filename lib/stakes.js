// lib/stakes.js — Phase 2 off-chain stake ledger (trust-staking collateral)
//
// Works before the token deploys (AITT amounts in 8-decimal minor units,
// recorded as integers — mirror of the future on-chain staking contract).
// Params locked in TOKENOMICS §8: min 1,000 AITT · locks 7/30/90/365d ·
// multipliers 1×/1.25×/1.5×/2× · unstake cooldown 7d.
//
// Store: data/stakes.json

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'stakes.json');

export const AITT_DECIMALS = 8;
export const MIN_STAKE_MINOR = 1000n * 10n ** 8n; // 1,000 AITT
export const ALLOWED_LOCKS_DAYS = [7, 30, 90, 365];
export const LOCK_MULTIPLIERS = { 7: 1.0, 30: 1.25, 90: 1.5, 365: 2.0 };
export const UNSTAKE_COOLDOWN_MS = 7 * 24 * 3600 * 1000;

const id = () => `st_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function defaultStore() { return { stakes: [] }; }
let store = loadStore();
function loadStore() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.stakes)) return parsed;
    }
  } catch { /* corrupt → fresh */ }
  return defaultStore();
}
function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}

/** Create a stake. amountMinor is a BigInt-safe string or number in 8-decimal units. */
export function createStake({ ownerId, amountMinor, lockDays }) {
  if (!ownerId) throw new Error('ownerId required');
  const amount = BigInt(amountMinor);
  if (amount < MIN_STAKE_MINOR) throw new Error(`minimum stake is ${(MIN_STAKE_MINOR / 10n ** 8n)} AITT`);
  const days = Number(lockDays);
  if (!ALLOWED_LOCKS_DAYS.includes(days)) throw new Error(`lockDays must be one of ${ALLOWED_LOCKS_DAYS.join('/')}`);
  const now = Date.now();
  const stake = {
    stakeId: id(), ownerId, amountMinor: amount.toString(), lockDays: days,
    startTs: now, endTs: now + days * 24 * 3600 * 1000,
    status: 'active', unstakeStartTs: null,
  };
  store.stakes.push(stake);
  save();
  return stake;
}

/** Begin the 7-day unstake cooldown. */
export function requestUnstake(stakeId) {
  const s = store.stakes.find((x) => x.stakeId === stakeId);
  if (!s) throw new Error('stake not found');
  if (s.status !== 'active') throw new Error(`cannot unstake stake in status ${s.status}`);
  s.status = 'unstaking';
  s.unstakeStartTs = Date.now();
  save();
  return s;
}

/** Read-only fetch (ownership checks must happen BEFORE any mutation). */
export function getStake(stakeId) {
  return store.stakes.find((x) => x.stakeId === stakeId) || null;
}

/** Withdraw after cooldown. Returns the stake (amount returned to owner's ledger is the platform's job). */
export function withdraw(stakeId) {
  const s = store.stakes.find((x) => x.stakeId === stakeId);
  if (!s) throw new Error('stake not found');
  if (s.status !== 'unstaking') throw new Error('stake is not unstaking');
  if (Date.now() - s.unstakeStartTs < UNSTAKE_COOLDOWN_MS) throw new Error('cooldown not elapsed (7 days)');
  s.status = 'withdrawn';
  save();
  return s;
}

/**
 * Slash a stake by pct (e.g. 10 for 10%). Reduces amountMinor; stake stays active
 * with the reduced amount unless fully consumed (→ slashed). Returns reduction.
 */
export function slashStake({ stakeId, pct, reason = '' }) {
  const s = store.stakes.find((x) => x.stakeId === stakeId);
  if (!s) throw new Error('stake not found');
  if (s.status !== 'active') throw new Error(`cannot slash stake in status ${s.status}`);
  const p = Number(pct);
  if (!Number.isFinite(p) || p <= 0 || p > 100) throw new Error('pct must be 1-100');
  const amount = BigInt(s.amountMinor);
  const reduction = (amount * BigInt(Math.trunc(p * 100))) / 10000n;
  const remaining = amount - reduction;
  s.amountMinor = remaining.toString();
  if (remaining <= 0n) {
    s.status = 'slashed';
  }
  s.lastSlash = { pct: p, reason, ts: Date.now() };
  save();
  return { stakeId, reductionMinor: reduction.toString(), remainingMinor: remaining.toString(), status: s.status };
}

/** Restore a stake amount (appeal accepted). amountMinor in 8-dec units. */
export function restoreStake({ stakeId, amountMinor }) {
  const s = store.stakes.find((x) => x.stakeId === stakeId);
  if (!s) throw new Error('stake not found');
  if (s.status === 'withdrawn' || s.status === 'slashed') throw new Error(`cannot restore stake in status ${s.status}`);
  s.amountMinor = BigInt(s.amountMinor) + BigInt(amountMinor);
  s.lastSlash = null;
  save();
  return s;
}

export function activeStakes(ownerId) {
  return store.stakes.filter((s) => s.ownerId === ownerId && s.status === 'active');
}

export function activeStakeTotalMinor(ownerId) {
  return activeStakes(ownerId).reduce((a, s) => a + BigInt(s.amountMinor), 0n);
}

/** Trust-weight: sum of (amount × lock multiplier) — the numerator of the score. */
export function weightedStakeMinor(ownerId) {
  return activeStakes(ownerId).reduce((a, s) => a + BigInt(s.amountMinor) * BigInt(Math.round(LOCK_MULTIPLIERS[s.lockDays] * 100)), 0n) / 100n;
}

export function stakeStats(ownerId) {
  const rows = activeStakes(ownerId);
  return {
    count: rows.length,
    totalMinor: activeStakeTotalMinor(ownerId).toString(),
    weightedMinor: weightedStakeMinor(ownerId).toString(),
    breakdown: rows.map((s) => ({ stakeId: s.stakeId, amountMinor: s.amountMinor, lockDays: s.lockDays, endTs: s.endTs, multiplier: LOCK_MULTIPLIERS[s.lockDays] })),
  };
}
