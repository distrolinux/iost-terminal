// lib/triggers.js — v1.14 user triggers/alerts (CryptoHopper-inspired)
//
// "When X happens → do Y". X = a market condition, Y = notify (visible in the
// app + pollable by the Hermes watcher for Telegram) or propose (a LIVE-trade
// proposal through the option-C queue, owner-only).
//
// Conditions (v1):
//   price   — symbol's last price vs a level   (e.g. BTC > 65000)
//   score   — symbol's AI composite score vs a threshold (e.g. IOST >= 70)
//   pct24h  — symbol's 24h % change vs a level (e.g. < -5)
// Operators: gt | lt | gte | lte
//
// Actions:
//   notify  — fires an event (UI bell/log + Hermes watcher can push to Telegram)
//   propose — fires a LIVE-trade proposal (owner-only; goes through the normal
//             approval flow — nothing executes without the owner)
//
// Design rules:
//   - A trigger never re-fires while its condition is STILL true (edge-trigger:
//     it re-arms only after the condition goes false again — no spam).
//   - Events are capped (last 200) and each carries the full context (what,
//     when, value seen) — agents and humans get identical transparency.
//   - Engine takes injectable price/score fns (deterministic tests).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, '..', 'data');
const STORE_FILE = join(DATA_DIR, 'triggers.json');

const TYPES = ['price', 'score', 'pct24h'];
const OPS = ['gt', 'lt', 'gte', 'lte'];
const ACTIONS = ['notify', 'propose'];
const MAX_EVENTS = 200;
export const SUPPORTED_SYMBOLS_HINT = 'any watchlist symbol (see /api/scanner)';

function loadStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    if (parsed && parsed.byId && typeof parsed.byId === 'object') return parsed;
  } catch { /* corrupt -> fresh */ }
  return { byId: {}, events: [], seq: 1 };
}
function saveStore(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, STORE_FILE);
}

export function createTrigger({ userId, name, symbol, condition, action, side, reason }) {
  const store = loadStore();
  const c = condition || {};
  const type = TYPES.includes(c.type) ? c.type : null;
  const op = OPS.includes(c.operator) ? c.operator : 'gt';
  const value = Number(c.value);
  if (!type || !Number.isFinite(value)) return { ok: false, error: 'condition requires type (price|score|pct24h) and a numeric value' };
  if (!symbol || typeof symbol !== 'string') return { ok: false, error: 'symbol required' };
  const act = ACTIONS.includes(action) ? action : 'notify';
  const id = `tr_${crypto.randomBytes(5).toString('hex')}`;
  store.byId[id] = {
    id, userId,
    name: String(name || `${symbol.toUpperCase()} ${op} ${value}`).slice(0, 60),
    symbol: String(symbol).toUpperCase().slice(0, 12),
    condition: { type, operator: op, value },
    action: act, side: side === 'short' ? 'short' : 'long',
    reason: String(reason || '').slice(0, 300) || null,
    enabled: true, armed: true, // armed = edge-trigger re-arm state
    lastTriggeredAt: null, triggerCount: 0, createdAt: Date.now(), lastValue: null,
  };
  saveStore(store);
  return { ok: true, trigger: store.byId[id] };
}

export function listTriggers(userId) {
  const store = loadStore();
  return Object.values(store.byId).filter((t) => t.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
}

export function setEnabled({ userId, id, enabled }) {
  const store = loadStore();
  const t = store.byId[id];
  if (!t || t.userId !== userId) return { ok: false, error: 'trigger not found' };
  t.enabled = !!enabled;
  t.armed = !!enabled; // re-arm on enable
  saveStore(store);
  return { ok: true, trigger: t };
}

export function deleteTrigger({ userId, id }) {
  const store = loadStore();
  const t = store.byId[id];
  if (!t || t.userId !== userId) return { ok: false, error: 'trigger not found' };
  delete store.byId[id];
  saveStore(store);
  return { ok: true };
}

export function listEvents({ userId, since = 0, limit = 20 }) {
  const store = loadStore();
  return store.events.filter((e) => e.userId === userId && e.ts > since).slice(-limit).reverse();
}

function evalCondition(type, operator, value, actual) {
  switch (operator) {
    case 'gt': return actual > value;
    case 'gte': return actual >= value;
    case 'lt': return actual < value;
    case 'lte': return actual <= value;
    default: return false;
  }
}

/**
 * Check all enabled triggers for all users. Edge-triggered: fires once per
 * condition-clear cycle. Inject price/score fns for deterministic tests.
 * @param {object} opts
 * @param {(symbol:string)=>Promise<number>} opts.getPrice
 * @param {(symbol:string)=>Promise<number|null>} opts.getScore
 * @param {Set<string>} opts.ownerIds — userIds allowed to fire 'propose' actions
 */
export async function checkTriggers({ getPrice, getScore, ownerIds = new Set() } = {}) {
  const store = loadStore();
  const fired = [];
  const failed = [];
  for (const t of Object.values(store.byId)) {
    if (!t.enabled) continue;
    let actual = null;
    try {
      if (t.condition.type === 'price') actual = await getPrice(t.symbol);
      else if (t.condition.type === 'score') actual = await getScore(t.symbol);
      else if (t.condition.type === 'pct24h') actual = await getPrice(t.symbol); // placeholder replaced below
      if (t.condition.type === 'pct24h') {
        // 24h % change needs open price — approximated from the last price fn if it returns {last, open24h}
        const full = await getPrice(t.symbol, true);
        if (full && full.open24h) actual = ((full.last - full.open24h) / full.open24h) * 100;
        else actual = null;
      }
      if (actual == null) { failed.push(`${t.id}: no data`); continue; }
      t.lastValue = actual;
      const hit = evalCondition(t.condition.type, t.condition.operator, t.condition.value, actual);
      if (hit && t.armed) {
        t.armed = false; // edge-trigger: wait for condition to clear
        t.lastTriggeredAt = Date.now();
        t.triggerCount += 1;
        const ev = {
          id: `ev_${t.id}_${t.triggerCount}`, userId: t.userId, triggerId: t.id,
          name: t.name, symbol: t.symbol, action: t.action,
          condition: { ...t.condition, actual: Math.round(actual * 100000) / 100000 },
          ts: t.lastTriggeredAt,
        };
        store.events.push(ev);
        if (store.events.length > MAX_EVENTS) store.events = store.events.slice(-MAX_EVENTS);
        fired.push(ev);
        // 'propose' — create a LIVE proposal via the option-C queue (owner only)
        if (t.action === 'propose' && ownerIds.has(t.userId)) {
          const size = t.condition.type === 'score' ? 0.001 : 0.001; // tiny pilot size; rails re-checked at approval
          try {
            const { addProposal } = await import('./live-proposals.js');
            const p = addProposal({
              userId: t.userId, requesterKeyId: null, requesterName: `Trigger: ${t.name}`,
              symbol: t.symbol, side: t.side, size, entry: null,
              reason: t.reason || `trigger ${t.condition.type} ${t.condition.operator} ${t.condition.value} (saw ${Math.round(actual * 100000) / 100000})`,
              confidence: t.condition.type === 'score' ? Math.round(actual) : null,
            });
            ev.proposalId = p.id;
          } catch (e) { failed.push(`${t.id}: propose ${e.message}`); }
        }
      } else if (!hit) {
        t.armed = true; // condition cleared → re-arm
      }
    } catch (e) {
      failed.push(`${t.id}: ${e.message}`);
    }
  }
  saveStore(store);
  return { fired, failed };
}
