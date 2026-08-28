// lib/live.js — live (real-money) mode manager.
// Per-account toggle, owner email allowlist, venue keys, and append-only audit.
// Live execution is intentionally single-owner for now: empty or multi-entry
// LIVE_EMAIL_ALLOWLIST configurations fail closed until server-side proposal
// execution is explicitly bound to a proposal owner's account.
// disableLive() is the kill switch: cancels all open venue orders.
import { appendFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBroker } from './broker/index.js';
import { listAccounts } from './paper.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, 'data');
const AUDIT = join(DATA_DIR, 'live-audit.jsonl');
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === '1';

const ALLOWLIST = [...new Set((process.env.LIVE_EMAIL_ALLOWLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];

/**
 * Live execution is owner-only today. Until the large server execution route is
 * refactored to carry an explicit proposal owner into account/broker selection,
 * allowing multiple owner identities could let owner A approve owner B's queued
 * proposal under A's session/account. Fail closed unless there is exactly one
 * configured owner identity.
 */
export function liveOwnerConfig() {
  if (!LIVE_TRADING_ENABLED) return { ok: false, owner: null, error: 'live trading is unavailable in the paper-only launch' };
  if (ALLOWLIST.length === 0) return { ok: false, owner: null, error: 'no live owner configured' };
  if (ALLOWLIST.length !== 1) return { ok: false, owner: null, error: 'exactly one live owner must be configured' };
  return { ok: true, owner: ALLOWLIST[0], error: null };
}

export function isLiveAllowed(email) {
  const cfg = liveOwnerConfig();
  if (!cfg.ok) return false; // fail closed
  return isOwnerIdentity(email);
}

/** Owner identity is independent of whether real-money trading is enabled.
 * This keeps paper-launch admin, audit and safety controls usable while every
 * live action continues to fail closed through isLiveAllowed(). */
export function isOwnerIdentity(email) {
  if (ALLOWLIST.length !== 1) return false;
  return ALLOWLIST[0] === String(email || '').trim().toLowerCase();
}

export function liveConfigReady() {
  const k = getBroker('kraken');
  return k.configured === true;
}

function liveOf(state) {
  return state.live || { enabled: false, venue: null, enabledAt: null, pilot: false };
}

function audit(accountId, event, detail) {
  try {
    mkdirSync(dirname(AUDIT), { recursive: true });
    appendFileSync(AUDIT, JSON.stringify({ ts: Date.now(), accountId, event, ...detail }) + '\n', { mode: 0o600 });
    chmodSync(AUDIT, 0o600);
  } catch { /* audit must never break trading */ }
}

/** Public audit writer — used by execution paths (fills, orders, halts). */
export function logLiveEvent(accountId, event, detail = {}) {
  audit(accountId, event, detail);
}

/** Enable live mode for an account. `ownBroker` = configured broker built from
 * the user's encrypted venue keys. Platform venue stays owner-only. */
export async function enableLive(state, ownerEmail, ownBroker = null) {
  if (liveOf(state).enabled) return { ok: false, error: 'live mode already enabled' };
  if (!isLiveAllowed(ownerEmail)) {
    const cfg = liveOwnerConfig();
    return { ok: false, error: cfg.error || 'email not on live-trading allowlist' };
  }
  const venueReady = ownBroker ? ownBroker.configured === true : liveConfigReady();
  if (!venueReady) return { ok: false, error: 'venue keys not configured' };
  state.live = { enabled: true, venue: ownBroker ? 'kraken:self' : 'kraken', enabledAt: Date.now(), pilot: true };
  audit(state.accountId, 'live.enable', { venue: state.live.venue, owner: ownerEmail });
  return { ok: true, live: state.live };
}

/** Kill switch: cancel every open venue order, then disable live mode.
 * `broker` defaults to the platform Kraken; pass the account's own broker
 * (per-user keys, v3) to cancel on the user's venue account. */
export async function disableLive(state, broker = null) {
  const wasEnabled = liveOf(state).enabled;
  const kraken = broker || getBroker('kraken');
  const cancelled = [];
  if (wasEnabled && kraken.configured) {
    const orders = await kraken.getOrders().catch(() => ({ ok: false, orders: [] }));
    if (orders.ok) {
      for (const o of orders.orders) {
        const r = await kraken.cancelOrder(o.txid).catch(() => ({ ok: false }));
        if (r.ok) cancelled.push(o.txid);
      }
    }
  }
  state.live = { enabled: false, venue: null, enabledAt: null, pilot: false };
  audit(state.accountId, 'live.disable', { cancelled });
  return { ok: true, cancelled, wasEnabled };
}

/** True when ANY account has live mode enabled — autopilot then forces approval. */
export function anyLiveEnabled() {
  if (!LIVE_TRADING_ENABLED) return false;
  try { return listAccounts().some(a => a.live?.enabled); } catch { return false; }
}

/** Masked live state — never returns keys. ownerEmail used for the owner flag. */
export function getLiveState(state, ownerEmail, ownBroker = null) {
  const l = liveOf(state);
  return {
    available: LIVE_TRADING_ENABLED,
    enabled: LIVE_TRADING_ENABLED && !!l.enabled,
    venue: LIVE_TRADING_ENABLED && l.enabled ? l.venue : null,
    pilot: LIVE_TRADING_ENABLED && !!l.pilot,
    enabledAt: LIVE_TRADING_ENABLED ? (l.enabledAt || null) : null,
    allowlisted: isLiveAllowed(ownerEmail),
    krakenConfigured: ownBroker ? ownBroker.configured === true : liveConfigReady(),
  };
}

export function liveTradingAvailable() {
  return LIVE_TRADING_ENABLED;
}

export const liveAuditFile = AUDIT;
