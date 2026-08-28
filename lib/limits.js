// lib/limits.js — Phase 2 spend-limit engine (rails, never agent code)
//
// Enforced server-side before any execution, per PHASE2_SPEC §4/§5:
//   - per-tx cap (maxPerTxMinor) · daily cap (UTC window) · weekly cap (UTC window)
//   - reserve → check → commit (atomic pattern; concurrent calls cannot overspend)
//   - integer minor units only (cents) — no float drift (ChiMoney §6.7)
//   - reject, never silently truncate: 402-style {ok:false, reason}
//
// Store: data/limits.json — usage windows keyed by UTC day/week.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { getWallet } from './wallets.js';
import { isFrozen } from './freeze.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'limits.json');

function defaultStore() {
  return { usage: {} }; // usage[walletId] = { day: {key, used}, week: {key, used}, reserved: [{reserveId, amount, dayKey, weekKey}] }
}

let store = loadStore();
function loadStore() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && typeof parsed.usage === 'object') return parsed;
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

export function utcDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}
export function utcWeekKey(ts = Date.now()) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function usageRow(walletId) {
  if (!store.usage[walletId]) store.usage[walletId] = { day: { key: '', used: 0 }, week: { key: '', used: 0 }, reserved: [] };
  return store.usage[walletId];
}

/** Reset usage rows whose window key is stale (call on every read). */
function rollWindows(row) {
  const day = utcDayKey();
  const week = utcWeekKey();
  if (row.day.key !== day) { row.day = { key: day, used: 0 }; }
  if (row.week.key !== week) { row.week = { key: week, used: 0 }; }
}

function effective(row, key, cap) {
  const used = key === 'day' ? row.day.used : row.week.used;
  return cap > 0 ? Math.max(0, cap - used) : Infinity; // 0 cap = unlimited
}

/**
 * Check a spend against wallet limits + freeze + status.
 * Returns {ok:true, remainingDailyMinor, remainingWeeklyMinor} or
 * {ok:false, reason, message} — NEVER truncates.
 */
export function checkSpend({ walletId, amountMinor, purpose = '' }) {
  const w = getWallet(walletId);
  if (!w) return { ok: false, reason: 'no-wallet', message: 'No wallet for this principal.' };
  if (w.status !== 'active') return { ok: false, reason: 'wallet-suspended', message: 'Wallet is suspended.' };
  if (isFrozen()) return { ok: false, reason: 'frozen', message: 'Agent operations are frozen.' };
  const amt = Math.trunc(Number(amountMinor));
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'invalid-amount', message: 'Amount must be a positive integer (minor units).' };

  const lim = w.limits?.USD || {};
  const maxPerTx = lim.maxPerTxMinor || 0;
  if (maxPerTx > 0 && amt > maxPerTx) {
    return { ok: false, reason: 'per-tx-cap', message: `Exceeds per-transaction cap (${maxPerTx} minor).` };
  }
  const row = usageRow(walletId);
  rollWindows(row);
  const remDaily = effective(row, 'day', lim.dailyCapMinor || 0);
  const remWeekly = effective(row, 'week', lim.weeklyCapMinor || 0);
  if (remDaily !== Infinity && amt > remDaily) {
    return { ok: false, reason: 'daily-cap', message: `Exceeds remaining daily cap (${remDaily} minor).` };
  }
  if (remWeekly !== Infinity && amt > remWeekly) {
    return { ok: false, reason: 'weekly-cap', message: `Exceeds remaining weekly cap (${remWeekly} minor).` };
  }
  return { ok: true, remainingDailyMinor: remDaily === Infinity ? -1 : remDaily, remainingWeeklyMinor: remWeekly === Infinity ? -1 : remWeekly, purpose };
}

/**
 * Reserve a spend (atomic): records intent against both windows so concurrent
 * calls cannot overspend. Returns {ok, reserveId} or {ok:false, reason}.
 */
export function reserveSpend({ walletId, amountMinor, purpose = '', pactId = null, recipient = null, protocol = null }) {
  const check = checkSpend({ walletId, amountMinor, purpose });
  if (!check.ok) return check;
  const amt = Math.trunc(Number(amountMinor));
  const row = usageRow(walletId);
  rollWindows(row);
  row.day.used += amt;
  row.week.used += amt;
  const reserveId = `r_${randomBytes(6).toString('hex')}`;
  row.reserved.push({ reserveId, amount: amt, dayKey: row.day.key, weekKey: row.week.key, pactId, recipient, protocol });
  save();
  return { ok: true, reserveId, remainingDailyMinor: effective(row, 'day', 0), remainingWeeklyMinor: effective(row, 'week', 0) };
}

/** Release a reservation (rollback on failed settlement). */
export function releaseReserve({ walletId, reserveId }) {
  const row = usageRow(walletId);
  const idx = row.reserved.findIndex((r) => r.reserveId === reserveId);
  if (idx === -1) return { ok: false, reason: 'reserve-not-found' };
  const [r] = row.reserved.splice(idx, 1);
  // only refund windows that still match (a UTC rollover between reserve/commit
  // means the usage already belongs to the new window — leave it)
  if (row.day.key === r.dayKey) row.day.used = Math.max(0, row.day.used - r.amount);
  if (row.week.key === r.weekKey) row.week.used = Math.max(0, row.week.used - r.amount);
  save();
  return { ok: true, released: r.amount, pactId: r.pactId || null, recipient: r.recipient || null, protocol: r.protocol || null };
}

/** Settle a reservation (keeps usage, clears the reserve record). Returns the settled amount. */
export function commitReserve({ walletId, reserveId }) {
  const row = usageRow(walletId);
  const idx = row.reserved.findIndex((r) => r.reserveId === reserveId);
  if (idx === -1) return { ok: false, reason: 'reserve-not-found' };
  const [settled] = row.reserved.splice(idx, 1);
  save();
  return { ok: true, amount: settled.amount, pactId: settled.pactId || null, recipient: settled.recipient || null, protocol: settled.protocol || null };
}

/** Read a reservation before settlement so policy can be revalidated. */
export function getReservation({ walletId, reserveId }) {
  const row = usageRow(walletId);
  const r = row.reserved.find((x) => x.reserveId === reserveId);
  return r ? { ...r } : null;
}

export function usageSnapshot(walletId) {
  const row = usageRow(walletId);
  rollWindows(row);
  return { dailyUsedMinor: row.day.used, weeklyUsedMinor: row.week.used, dayKey: row.day.key, weekKey: row.week.key };
}
