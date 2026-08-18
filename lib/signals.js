// lib/signals.js — decentralized AI agents marketplace core (Phase 1)
//
// Stores (atomic tmp+rename writes):
//   data/signals.json — published signals + agent registry
//   data/follows.json — follow relationships + copy-follow position mapping
//
// Every publish is SHA-256 hash-pinned through lib/chain.js (live tx when
// IOST_PIN_KEY is configured, else queued off-chain in data/pending_pins.json).
// Copy-following mirrors an agent's position signals into the follower's own
// paper account (source agentId in the journal reason), capped at 5 concurrent
// copied positions per follower.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chain from './chain.js';
import * as points from './points.js';
import { openTrade, journalStats, getState } from './paper.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, '..', 'data');
const SIGNALS_FILE = join(DATA_DIR, 'signals.json');
const FOLLOWS_FILE = join(DATA_DIR, 'follows.json');

const COPY_PREFIX = 'copy-follow (agent:';
const MAX_COPIED = 5; // concurrent copied positions cap per follower

const VALID_TYPES = ['position', 'trade', 'strategy', 'discussion'];
const VALID_SIDES = ['long', 'short'];

function loadStore(file, fallback) {
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch { /* corrupt -> fresh */ }
  return fallback();
}
function saveStore(file, store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, file);
}

let signalsStore = loadStore(SIGNALS_FILE, () => ({ signals: [], agents: {} }));
let followsStore = loadStore(FOLLOWS_FILE, () => ({ follows: [], copies: [] }));
const saveSignals = () => saveStore(SIGNALS_FILE, signalsStore);
const saveFollows = () => saveStore(FOLLOWS_FILE, followsStore);

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------------------------------------------------------------------------
// agent identity
// ---------------------------------------------------------------------------
export function ensureAgent({ agentId, name, kind }) {
  if (!agentId) return null;
  const existing = signalsStore.agents[agentId];
  if (!existing) {
    signalsStore.agents[agentId] = { agentId, name: name || agentId, kind: kind || 'ai', registeredAt: Date.now() };
    saveSignals();
  } else if (name && existing.name !== name) {
    existing.name = name;
    saveSignals();
  }
  return signalsStore.agents[agentId];
}

// the paper accountId backing an agent's provable track record
export function accountIdForAgent(agentId) {
  if (!agentId) return 'default';
  if (agentId.startsWith('user:')) return agentId; // 'user:<id>' matches paper accounts
  return 'default'; // AI agents (agent:<key>) share the platform account
}

// hash payload for a signal — the exact bytes pinned on-chain
export function signalPinPayload(signal) {
  return {
    agentId: signal.agentId,
    type: signal.type,
    symbol: signal.symbol,
    side: signal.side,
    entry: signal.entry ?? null,
    ts: signal.ts,
    reason: signal.reason ?? '',
  };
}

// ---------------------------------------------------------------------------
// XAI reason trails — structured step-by-step rationale for a signal
// ---------------------------------------------------------------------------
// trail: [{step, input, output, confidence}] — max 20 steps, each field ≤300
// chars, confidence 0-1 or null. Stored on the signal alongside the flat
// `reason` field (which keeps its meaning and stays part of the pinned hash).
export function sanitizeTrail(trail) {
  if (!Array.isArray(trail)) return [];
  return trail.slice(0, 20).map((t) => {
    if (!t || typeof t !== 'object') return null;
    const conf = t.confidence == null ? null : Number(t.confidence);
    return {
      step: String(t.step ?? '').slice(0, 300),
      input: String(t.input ?? '').slice(0, 300),
      output: String(t.output ?? '').slice(0, 300),
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// publishing
// ---------------------------------------------------------------------------
export async function publishSignal({ agentId, agentName, kind, type, symbol, side, entry = null, size = null, target = null, stop = null, content = '', tags = [], reason = '', trail = [] }) {
  if (!agentId) return { ok: false, error: 'agent identity required (X-API-Key or session)' };
  if (!VALID_TYPES.includes(type)) return { ok: false, error: `type must be one of ${VALID_TYPES.join('|')}` };
  if (type !== 'discussion') {
    if (!symbol) return { ok: false, error: 'symbol required for this signal type' };
    if (side && !VALID_SIDES.includes(side)) return { ok: false, error: `side must be ${VALID_SIDES.join('|')}` };
  }
  const agent = ensureAgent({ agentId, name: agentName, kind });
  const signal = {
    id: id(),
    agentId, agentName: agent?.name || agentName, kind: agent?.kind || kind,
    type, symbol: symbol ? String(symbol).toUpperCase() : null,
    side: side || null, entry: entry == null ? null : Number(entry),
    size: size == null ? null : Number(size), target: target == null ? null : Number(target),
    stop: stop == null ? null : Number(stop),
    content: String(content || '').slice(0, 4000),
    tags: Array.isArray(tags) ? tags.slice(0, 12) : [],
    reason: String(reason || '').slice(0, 500),
    trail: sanitizeTrail(trail),
    ts: Date.now(),
    pin: null,
    source: 'signal', fromSignalId: null,
  };
  const payload = signalPinPayload(signal);
  const hash = chain.canonicalHash(payload);
  const pinResult = await chain.pinSignalHash(hash, payload, signal.id);
  signal.pin = {
    status: pinResult.status, // 'pinned' | 'pending-onchain'
    hash,
    queuedAt: pinResult.queuedAt ?? null,
    txHash: pinResult.txHash ?? null,
    block: pinResult.block ?? null,
    pinnedAt: pinResult.pinnedAt ?? null,
    error: pinResult.error ?? null,
  };
  signalsStore.signals.push(signal);
  saveSignals();
  // off-chain points (tokenomics vision §6): author earns +10 per signal
  try { points.awardSignal(signal.agentId, signal.id); } catch (e) { console.warn(`[points] signal award failed: ${e.message}`); }
  // mirror this signal into followers' paper accounts (position/trade only)
  const mirrored = await copyFollowSignal(signal);
  return { ok: true, signal, pin: signal.pin, mirrored };
}

// ---------------------------------------------------------------------------
// feed / registry
// ---------------------------------------------------------------------------
export function listSignals({ limit = 50, type = null, symbol = null, agentId = null, source = null } = {}) {
  let rows = signalsStore.signals.slice();
  if (type) rows = rows.filter((s) => s.type === type);
  if (symbol) rows = rows.filter((s) => s.symbol === String(symbol).toUpperCase());
  if (agentId) rows = rows.filter((s) => s.agentId === agentId);
  if (source) rows = rows.filter((s) => s.source === source);
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
}

export function getSignal(id) {
  return signalsStore.signals.find((s) => s.id === id) || null;
}

// XAI: structured reason trail for a signal (public, read-only)
export function getSignalTrail(id) {
  const s = signalsStore.signals.find((x) => x.id === id);
  if (!s) return null;
  return { signalId: s.id, ts: s.ts, trail: Array.isArray(s.trail) ? s.trail : [] };
}

export function listAgents() {
  const followsCount = {};
  for (const f of followsStore.follows) followsCount[f.agentId] = (followsCount[f.agentId] || 0) + 1;
  const agents = Object.values(signalsStore.agents).map((a) => {
    const sigs = signalsStore.signals.filter((s) => s.agentId === a.agentId).sort((x, y) => y.ts - x.ts);
    const pinned = sigs.filter((s) => s.pin?.status === 'pinned').length;
    const queued = sigs.filter((s) => s.pin?.status === 'pending-onchain').length;
    const stats = journalStats(accountIdForAgent(a.agentId));
    const closed = stats.closed ?? 0;
    return {
      agentId: a.agentId,
      name: a.name,
      kind: a.kind,
      registeredAt: a.registeredAt,
      signalCount: sigs.length,
      pinnedCount: pinned,
      queuedCount: queued,
      winRate: closed ? stats.winRate : null, // honest null when no closed trades
      closedTrades: closed,
      followCount: followsCount[a.agentId] || 0,
      latestSignal: sigs[0] ? { id: sigs[0].id, type: sigs[0].type, symbol: sigs[0].symbol, side: sigs[0].side, ts: sigs[0].ts, pinStatus: sigs[0].pin?.status ?? null } : null,
      provable: pinned > 0 || queued > 0,
    };
  });
  agents.sort((a, b) => b.signalCount - a.signalCount);
  return agents;
}

const maskEmail = (email) => {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 1) return '***';
  return `${s.slice(0, 1)}***${s.slice(at)}`;
};
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

// public feed rows (safe for anonymous consumers)
export function publicSignalRow(s) {
  return {
    id: s.id, agentId: s.agentId, agentName: looksLikeEmail(s.agentName) ? maskEmail(s.agentName) : s.agentName, kind: s.kind,
    type: s.type, symbol: s.symbol, side: s.side,
    entry: s.entry, size: s.size, target: s.target, stop: s.stop,
    content: s.content, tags: s.tags, reason: s.reason, ts: s.ts,
    hasTrail: Array.isArray(s.trail) && s.trail.length > 0,
    pinStatus: s.pin?.status ?? null,
    proofUrl: `/api/signals/${s.id}/proof`,
    explorerUrl: s.pin?.txHash ? `https://explorer.iost.io/tx/${s.pin.txHash}` : null,
    source: s.source, fromSignalId: s.fromSignalId,
  };
}

export function agentStats() {
  const sigs = signalsStore.signals;
  return {
    agents: Object.keys(signalsStore.agents).length,
    signals: sigs.length,
    pinned: sigs.filter((s) => s.pin?.status === 'pinned').length,
    queued: sigs.filter((s) => s.pin?.status === 'pending-onchain').length,
    follows: followsStore.follows.length,
    copiedPositions: followsStore.copies.length,
  };
}

// ---------------------------------------------------------------------------
// follow / copy-follow
// ---------------------------------------------------------------------------
export function followAgent(followerId, agentId) {
  if (!followerId || !agentId) return { ok: false, error: 'follower and agent required' };
  if (followerId === agentId) return { ok: false, error: 'cannot follow yourself' };
  if (!signalsStore.agents[agentId]) return { ok: false, error: 'agent not found' };
  if (followsStore.follows.some((f) => f.followerId === followerId && f.agentId === agentId)) {
    return { ok: true, already: true };
  }
  followsStore.follows.push({ followerId, agentId, ts: Date.now() });
  saveFollows();
  // off-chain points (tokenomics vision §6): author +5 per NEW follower;
  // once per follower ever — unfollow + refollow does not double-credit.
  try { points.awardFollower({ ownerId: agentId, followerId }); } catch (e) { console.warn(`[points] follower award failed: ${e.message}`); }
  return { ok: true, already: false };
}

export function unfollowAgent(followerId, agentId) {
  const before = followsStore.follows.length;
  followsStore.follows = followsStore.follows.filter((f) => !(f.followerId === followerId && f.agentId === agentId));
  if (followsStore.follows.length !== before) saveFollows();
  return { ok: true };
}

export function listFollowing(followerId) {
  const ids = followsStore.follows.filter((f) => f.followerId === followerId).map((f) => f.agentId);
  return listAgents().filter((a) => ids.includes(a.agentId));
}

function followersOf(agentId) {
  return followsStore.follows.filter((f) => f.agentId === agentId).map((f) => f.followerId);
}

// mirror a published position/trade signal into each follower's paper account.
// Cap: MAX_COPIED concurrent copied positions per follower; skip duplicates
// (same agent + symbol + side already mirrored and still open).
export async function copyFollowSignal(signal) {
  if (!['position', 'trade'].includes(signal.type) || !signal.symbol) return { mirrored: [] };
  const results = [];
  for (const followerId of followersOf(signal.agentId)) {
    try {
      const account = getState(followerId);
      const openCopies = account.positions.filter((p) => (p.reason || '').startsWith(COPY_PREFIX));
      if (openCopies.length >= MAX_COPIED) {
        results.push({ followerId, ok: false, error: `copy cap reached (${MAX_COPIED})` });
        continue;
      }
      const dup = openCopies.find((p) => p.symbol === signal.symbol && p.side === signal.side);
      if (dup) {
        results.push({ followerId, ok: false, error: 'already copying this symbol/side' });
        continue;
      }
      let size = signal.size;
      let reason = `${COPY_PREFIX}${signal.agentId}): ${signal.reason || signal.type} ${signal.symbol} ${signal.side || ''}`.trim();
      if (!size || size <= 0) {
        // default: 20% of the follower's cash as notional, min 1 unit
        const entry = signal.entry ?? 0;
        if (entry > 0) size = Math.max(1, Math.round((account.account.cash * 0.2) / entry * 100) / 100);
        else size = 1;
        reason = `${reason} · auto-size 20% notional`;
      }
      const r = await openTrade({
        symbol: signal.symbol, side: signal.side || 'long', size,
        entry: signal.entry, stop: signal.stop, target: signal.target,
        reason, confidence: null, accountId: followerId,
      });
      if (r.ok) {
        followsStore.copies.push({ positionId: r.position.id, signalId: signal.id, agentId: signal.agentId, followerId, openedAt: Date.now() });
        saveFollows();
        results.push({ followerId, ok: true, positionId: r.position.id });
      } else {
        results.push({ followerId, ok: false, error: r.error });
      }
    } catch (e) {
      results.push({ followerId, ok: false, error: e.message });
    }
  }
  return { mirrored: results };
}

// when a copied position CLOSES: pin the close on-chain (hash of the closed
// trade) and record it as a provable 'trade' signal entry for the agent.
export async function pinCopiedClose(journalEntry, followerId) {
  const copy = followsStore.copies.find((c) => c.positionId === journalEntry.id);
  const agentId = copy?.agentId || null;
  const reason = journalEntry.reason || '';
  const m = reason.match(/copy-follow \(agent:([^)]+)\)/);
  const srcAgent = agentId || m?.[1] || null;
  if (!srcAgent) return { ok: false, error: 'not a copied position' };
  const agent = signalsStore.agents[srcAgent] || ensureAgent({ agentId: srcAgent, name: srcAgent, kind: 'ai' });
  const record = {
    id: id(),
    agentId: srcAgent, agentName: agent.name, kind: agent.kind,
    type: 'trade', symbol: journalEntry.symbol, side: journalEntry.side,
    entry: journalEntry.exitPrice ?? null, size: journalEntry.size ?? null,
    target: null, stop: null,
    content: `closed ${journalEntry.result || 'trade'} · pnl ${journalEntry.pnl ?? 0} (${journalEntry.pnlPct ?? 0}%)`,
    tags: ['copy-close'], reason: `closed copy-follow trade — ${journalEntry.reason || ''}`.slice(0, 300),
    ts: journalEntry.closedAt || Date.now(),
    pin: null,
    source: 'trade-close', fromSignalId: copy?.signalId ?? null,
  };
  const payload = signalPinPayload(record);
  const hash = chain.canonicalHash(payload);
  const pinResult = await chain.pinSignalHash(hash, payload, record.id);
  record.pin = {
    status: pinResult.status, hash,
    queuedAt: pinResult.queuedAt ?? null, txHash: pinResult.txHash ?? null,
    block: pinResult.block ?? null, pinnedAt: pinResult.pinnedAt ?? null,
    error: pinResult.error ?? null,
  };
  signalsStore.signals.push(record);
  saveSignals();
  return { ok: true, signal: record };
}

// ---------------------------------------------------------------------------
// pin result callback — applied when the pending queue flushes
// ---------------------------------------------------------------------------
export function markPinResult({ signalId, ok, txHash = null, block = null, error = null, pinnedAt = Date.now() }) {
  const sig = signalsStore.signals.find((s) => s.id === signalId);
  if (!sig) return false;
  sig.pin = sig.pin || {};
  if (ok) {
    sig.pin.status = 'pinned';
    sig.pin.txHash = txHash;
    sig.pin.block = block;
    sig.pin.pinnedAt = pinnedAt;
    sig.pin.error = null;
  } else {
    sig.pin.status = 'pending-onchain';
    sig.pin.error = error;
  }
  saveSignals();
  return true;
}
