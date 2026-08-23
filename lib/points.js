// lib/points.js — off-chain points ledger (tokenomics vision §6)
//
// NO TOKEN IS ISSUED. Points are accrual-only platform credits designed to be
// 1:1-convertible to a future AITT token at TGE (planned, not guaranteed — the
// UI labels this honestly). Balance is always computed from the ledger on read.
//
// Store: data/points.json (atomic tmp+rename writes)
//   { ledger: [{id, ownerId ('user:<id>' | 'agent:<key>' | 'default'), event,
//               points, refId, ts, meta}],
//     referralCodes: {<ownerId>: '<8-char code>'},
//     refAwards: {<refereeOwnerId>: <referrerOwnerId>},   // one credit per referee
//     lastBountyWeek: '<YYYY-Www>' | null }               // weekly bounty guard
//
// Events (rules from docs/tokenomics-vision.md §6):
//   signal           +10  per published signal (author)
//   follower         +5   per NEW follower (author; refollow after unfollow
//                         does NOT double-credit — tracked in ledger meta)
//   referral_referee +10  joining via a referral link
//   referral_referrer +50 referrer brings a new trader (self-referral blocked,
//                         one credit per referee)
//   feedback         +5   signal author (capped 1 per rater per signal; the
//                         rater gains nothing — honest)
//   bounty           +500 weekly top paper trader (realized PnL, trailing 7d,
//                         once per ISO week)

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAccounts } from './paper.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'points.json');

const BOUNTY_POINTS = 500;
const BOUNTY_WINDOW_MS = 7 * 24 * 3600 * 1000; // trailing 7 days
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

// event → points + human label (source of truth for ledger labels)
export const EVENTS = {
  signal: { points: 10, label: 'Signal published' },
  follower: { points: 5, label: 'New follower' },
  referral_referee: { points: 10, label: 'Referral — joined via your link' },
  referral_referrer: { points: 50, label: 'Referral — you brought a new trader' },
  feedback: { points: 5, label: 'Quality feedback on your signal' },
  bounty: { points: BOUNTY_POINTS, label: 'Weekly top paper trader bounty' },
};

function defaultStore() {
  return { ledger: [], referralCodes: {}, refAwards: {}, lastBountyWeek: null };
}

let store = loadStore();
function loadStore() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        parsed.ledger = Array.isArray(parsed.ledger) ? parsed.ledger : [];
        parsed.referralCodes = parsed.referralCodes && typeof parsed.referralCodes === 'object' ? parsed.referralCodes : {};
        parsed.refAwards = parsed.refAwards && typeof parsed.refAwards === 'object' ? parsed.refAwards : {};
        return parsed;
      }
    }
  } catch { /* corrupt -> fresh */ }
  return defaultStore();
}
function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, FILE);
}

const id = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// ---------------------------------------------------------------------------
// ledger core
// ---------------------------------------------------------------------------
export function getBalance(ownerId) {
  if (!ownerId) return 0;
  return store.ledger.filter((e) => e.ownerId === ownerId).reduce((a, e) => a + (e.points || 0), 0);
}

export function getLedger(ownerId, limit = 50) {
  return store.ledger
    .filter((e) => e.ownerId === ownerId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
    .map((e) => ({
      id: e.id, event: e.event, eventLabel: EVENTS[e.event]?.label || e.event,
      points: e.points, refId: e.refId, ts: e.ts, meta: e.meta || {},
    }));
}

/** Append one ledger entry. Returns the entry; callers decide when it's earned. */
export function credit({ ownerId, event, refId = null, meta = {} }) {
  const def = EVENTS[event];
  if (!def) return { ok: false, error: `unknown event: ${event}` };
  if (!ownerId) return { ok: false, error: 'ownerId required' };
  const entry = { id: id(), ownerId, event, points: def.points, refId, ts: Date.now(), meta: { ...(meta || {}) } };
  store.ledger.push(entry);
  save();
  return { ok: true, entry };
}

/** Permanently debit points only after a confirmed on-chain AITT conversion. */
export function debitForConversion({ ownerId, points, claimId, txHash }) {
  if (!ownerId || !claimId) return { ok: false, error: 'ownerId and claimId required' };
  const existing = store.ledger.find((e) => e.event === 'conversion_debit' && e.meta?.claimId === claimId);
  if (existing) return { ok: true, entry: existing, already: true };
  const amount = Math.trunc(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'positive points required' };
  if (getBalance(ownerId) < amount) return { ok: false, error: 'insufficient points' };
  const entry = {
    id: id(), ownerId, event: 'conversion_debit', points: -amount, refId: claimId,
    ts: Date.now(), meta: { claimId, txHash: txHash || null },
  };
  store.ledger.push(entry);
  save();
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// referral codes
// ---------------------------------------------------------------------------
function randomCode() {
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Get my code, creating one on first call. */
export function ensureReferralCode(ownerId) {
  if (!ownerId) return null;
  if (store.referralCodes[ownerId]) return store.referralCodes[ownerId];
  let code;
  const taken = new Set(Object.values(store.referralCodes));
  do { code = randomCode(); } while (taken.has(code));
  store.referralCodes[ownerId] = code;
  save();
  return code;
}

export function getReferralCode(ownerId) {
  return ownerId ? (store.referralCodes[ownerId] || null) : null;
}

export function ownerForCode(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  for (const [ownerId, v] of Object.entries(store.referralCodes)) {
    if (v === c) return ownerId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// referral award (called from registration flow)
// ---------------------------------------------------------------------------
/**
 * Apply a referral code for a freshly registered referee.
 * Anti-abuse: self-referral blocked (same ownerId), one credit per referee
 * (refAwards map) — re-registration/retries can never double-award.
 */
export function awardReferral({ refereeOwnerId, referrerOwnerId }) {
  if (!refereeOwnerId || !referrerOwnerId) return { ok: false, reason: 'missing referee or referrer' };
  if (refereeOwnerId === referrerOwnerId) return { ok: false, reason: 'self-referral blocked' };
  if (store.refAwards[refereeOwnerId]) return { ok: false, reason: 'referee already credited', already: true };
  store.refAwards[refereeOwnerId] = referrerOwnerId; // set BEFORE credits — never double-award
  const r1 = credit({ ownerId: referrerOwnerId, event: 'referral_referrer', refId: refereeOwnerId, meta: { referee: refereeOwnerId } });
  const r2 = credit({ ownerId: refereeOwnerId, event: 'referral_referee', refId: referrerOwnerId, meta: { referrer: referrerOwnerId } });
  return { ok: true, referrerPoints: r1.entry.points, refereePoints: r2.entry.points, referrer: referrerOwnerId, referee: refereeOwnerId };
}

/** Register-time wrapper: resolve code → award. Unknown code is a no-op (register still succeeds). */
export function applyReferralCode({ refCode, refereeOwnerId }) {
  const referrerOwnerId = ownerForCode(refCode);
  if (!referrerOwnerId) return { ok: false, reason: 'unknown referral code' };
  return awardReferral({ refereeOwnerId, referrerOwnerId });
}

// ---------------------------------------------------------------------------
// signal + follower awards (hooked into lib/signals.js)
// ---------------------------------------------------------------------------
export function awardSignal(ownerId, signalId) {
  return credit({ ownerId, event: 'signal', refId: signalId, meta: { signalId } });
}

/**
 * +5 to the followed author, once per follower EVER (unfollow + refollow does
 * not double-credit). Idempotency key: ownerId + meta.followerId in the ledger.
 */
export function awardFollower({ ownerId, followerId }) {
  if (!ownerId || !followerId) return { ok: false, reason: 'owner and follower required' };
  const seen = store.ledger.find((e) => e.event === 'follower' && e.ownerId === ownerId && e.meta?.followerId === followerId);
  if (seen) return { ok: false, reason: 'follower already credited', already: true };
  return credit({ ownerId, event: 'follower', refId: followerId, meta: { followerId } });
}

// ---------------------------------------------------------------------------
// feedback award (author gains, rater gains nothing — honest)
// ---------------------------------------------------------------------------
export function awardFeedback({ signalOwnerId, raterId, signalId, rating, comment }) {
  if (!signalOwnerId) return { ok: false, reason: 'signal has no author' };
  if (!signalId) return { ok: false, reason: 'signalId required' };
  if (signalOwnerId === raterId) return { ok: false, reason: 'cannot rate your own signal' };
  const seen = store.ledger.find(
    (e) => e.event === 'feedback' && e.meta?.signalId === signalId && e.meta?.raterId === raterId
  );
  if (seen) return { ok: false, reason: 'already rated this signal', already: true };
  return credit({ ownerId: signalOwnerId, event: 'feedback', refId: signalId, meta: { signalId, raterId, rating, comment: comment || '' } });
}

// ---------------------------------------------------------------------------
// weekly top paper trader bounty
// ---------------------------------------------------------------------------
/** ISO week string 'YYYY-Www' (UTC). */
export function isoWeek(ts = Date.now()) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// map a paper account to its points ownerId
//   account.owner is the raw userId / agentKey / 'default'; accountId is
//   'user:<id>' when created through accountFor(). Normalize both.
function normalizeOwner(owner, accountId) {
  const o = typeof owner === 'string' && owner ? owner : typeof accountId === 'string' && accountId ? accountId : 'default';
  if (o.startsWith('user:') || o.startsWith('agent:')) return o;
  if (o === 'default') return 'default';
  return `user:${o}`; // raw user id
}

/** Sum realized PnL per owner over the trailing 7 days (closed journal entries). */
export function topTraderLast7d(ts = Date.now()) {
  const since = ts - BOUNTY_WINDOW_MS;
  const byOwner = {};
  for (const acc of listAccounts()) {
    const ownerId = normalizeOwner(acc.owner, acc.accountId);
    for (const j of acc.journal || []) {
      if (j.status !== 'closed' || !j.closedAt || j.closedAt < since) continue;
      const cur = byOwner[ownerId] || (byOwner[ownerId] = { pnl: 0, trades: 0 });
      cur.pnl += j.pnl || 0;
      cur.trades += 1;
    }
  }
  const rows = Object.entries(byOwner).map(([ownerId, s]) => ({ ownerId, pnl: Math.round(s.pnl * 100) / 100, trades: s.trades }));
  rows.sort((a, b) => b.pnl - a.pnl);
  const top = rows[0] || null;
  return { since, week: isoWeek(ts), rows, topTrader: top && top.pnl > 0 ? top : null };
}

/** Award +500 to the top paper trader of the trailing 7d. Once per ISO week. */
export function runWeeklyBounty(ts = Date.now()) {
  const week = isoWeek(ts);
  if (store.lastBountyWeek === week) {
    return { ok: false, reason: 'bounty already awarded this week', week, lastBountyWeek: store.lastBountyWeek };
  }
  const { topTrader, rows } = topTraderLast7d(ts);
  if (!topTrader) {
    return { ok: false, reason: 'no profitable closed trades in the trailing 7 days', week, rows };
  }
  const r = credit({ ownerId: topTrader.ownerId, event: 'bounty', refId: week, meta: { week, pnl: topTrader.pnl, trades: topTrader.trades } });
  store.lastBountyWeek = week;
  save();
  return { ok: true, week, winner: topTrader.ownerId, pnl: topTrader.pnl, trades: topTrader.trades, points: r.entry.points };
}

export function bountyStatus(ts = Date.now()) {
  const week = isoWeek(ts);
  const { rows } = topTraderLast7d(ts);
  return {
    currentWeek: week,
    lastBountyWeek: store.lastBountyWeek,
    awarded: store.lastBountyWeek === week,
    points: BOUNTY_POINTS,
    leaderboard: rows.slice(0, 5), // trailing-7d realized PnL per owner
  };
}

// ---------------------------------------------------------------------------
// admin/introspection (agent-facing)
// ---------------------------------------------------------------------------
export function ledgerSize() { return store.ledger.length; }
export function stats() {
  return { entries: store.ledger.length, owners: new Set(store.ledger.map((e) => e.ownerId)).size, codes: Object.keys(store.referralCodes).length, awards: Object.keys(store.refAwards).length, lastBountyWeek: store.lastBountyWeek };
}
