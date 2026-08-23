// lib/live.js — live (real-money) mode manager.
// Per-account toggle, email allowlist (LIVE_EMAIL_ALLOWLIST in .env, comma-
// separated; empty = nobody can enable live — fail closed), venue keys must
// be configured, and every transition is appended to data/live-audit.jsonl.
// disableLive() is the kill switch: cancels all open venue orders.
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBroker } from './broker/index.js';
import { listAccounts } from './paper.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, 'data');
const AUDIT = join(DATA_DIR, 'live-audit.jsonl');

const ALLOWLIST = (process.env.LIVE_EMAIL_ALLOWLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export function isLiveAllowed(email) {
  if (!ALLOWLIST.length) return false; // fail closed
  return ALLOWLIST.includes(String(email || '').trim().toLowerCase());
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
    appendFileSync(AUDIT, JSON.stringify({ ts: Date.now(), accountId, event, ...detail }) + '\n');
  } catch { /* audit must never break trading */ }
}

/** Public audit writer — used by execution paths (fills, orders, halts). */
export function logLiveEvent(accountId, event, detail = {}) {
  audit(accountId, event, detail);
}

/** Enable live mode for an account. `ownBroker` = configured broker built from
 * the user's encrypted venue keys. Platform venue stays allowlist-only. */
export async function enableLive(state, ownerEmail, ownBroker = null) {
  if (liveOf(state).enabled) return { ok: false, error: 'live mode already enabled' };
  if (!ownBroker && !isLiveAllowed(ownerEmail)) return { ok: false, error: 'email not on live-trading allowlist' };
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
  try { return listAccounts().some(a => a.live?.enabled); } catch { return false; }
}

/** Masked live state — never returns keys. ownerEmail used for the allowlist flag. */
export function getLiveState(state, ownerEmail, ownBroker = null) {
  const l = liveOf(state);
  return {
    enabled: !!l.enabled,
    venue: l.enabled ? l.venue : null,
    pilot: !!l.pilot,
    enabledAt: l.enabledAt || null,
    allowlisted: isLiveAllowed(ownerEmail),
    krakenConfigured: ownBroker ? ownBroker.configured === true : liveConfigReady(),
  };
}

export const liveAuditFile = AUDIT;
