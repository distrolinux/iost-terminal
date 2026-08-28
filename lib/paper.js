// lib/paper.js — Paper trading engine + AI Trading Journal (JSON persistence)
// v1.8: per-account paper trading. Every owner (logged-in user, agent, platform)
// has its OWN account: cash / positions / journal. The shared 'default' account
// is the platform/agent account (autopilot trades it). Legacy data/paper.json is
// migrated into the 'default' account on first boot.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTicker, WATCHLIST } from './market.js';
import { calculateRisk } from './risk.js';

const DATA_DIR = process.env.IOST_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'accounts.json');   // per-account store (authoritative)
const LEGACY_FILE = join(DATA_DIR, 'paper.json'); // v1.7 single-account store (migrated once)

const DEFAULT_CASH = 100000;
const DEFAULT_ACCOUNT_ID = 'default';

function newAccount(accountId, owner) {
  return {
    accountId,
    owner, // '<userId>' | '<agentKey>' | 'default'
    account: { name: 'Paper Account', initialCash: DEFAULT_CASH, cash: DEFAULT_CASH },
    positions: [], // { id, symbol, type, side, entry, stop, target, size, notional, reason, confidence, openedAt, lastPrice }
    journal: [],   // { id, symbol, side, entry, stop, target, size, reason, confidence, status, openedAt, closedAt, exitPrice, pnl, pnlPct, result }
    createdAt: Date.now(),
  };
}

// ---- store: atomic writes (tmp + rename), same style as users.json ----
let accounts = loadAccounts();
let dirty = false;
function persist() {
  if (!dirty) return;
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
  dirty = false;
}
const save = () => { dirty = true; persist(); };
/** Force a persist now (used by external modules mutating account records). */
export function persistAccounts() { persist(); }
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// v1.7 → v1.8 migration: seed the 'default' account from the legacy single
// paper.json so agent/autopilot history is not lost. Runs only when the new
// store does not exist yet.
function migrateFromLegacy() {
  const out = {};
  let legacy = null;
  try {
    if (existsSync(LEGACY_FILE)) legacy = JSON.parse(readFileSync(LEGACY_FILE, 'utf8'));
  } catch { /* corrupt legacy -> fresh default */ }
  if (legacy && legacy.account && typeof legacy.account === 'object') {
    out[DEFAULT_ACCOUNT_ID] = {
      accountId: DEFAULT_ACCOUNT_ID,
      owner: 'default',
      account: {
        name: 'Paper Account',
        initialCash: legacy.account.initialCash || DEFAULT_CASH,
        cash: typeof legacy.account.cash === 'number' ? legacy.account.cash : DEFAULT_CASH,
      },
      positions: Array.isArray(legacy.positions) ? legacy.positions : [],
      journal: Array.isArray(legacy.journal) ? legacy.journal : [],
      createdAt: Date.now(),
    };
  } else {
    out[DEFAULT_ACCOUNT_ID] = newAccount(DEFAULT_ACCOUNT_ID, 'default');
  }
  return out;
}

function loadAccounts() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // tolerate a missing 'default' account (should not happen, but never crash on it)
        if (!parsed[DEFAULT_ACCOUNT_ID]) parsed[DEFAULT_ACCOUNT_ID] = newAccount(DEFAULT_ACCOUNT_ID, 'default');
        return parsed;
      }
    }
  } catch { /* corrupt -> rebuild from legacy */ }
  return migrateFromLegacy();
}

// ---- account accessors ----
// Returns the account for `accountId`, creating it (fresh $100K) on first access.
export function ensureAccount(accountId = DEFAULT_ACCOUNT_ID, owner = accountId) {
  if (!accounts[accountId]) {
    accounts[accountId] = newAccount(accountId, owner);
    save();
  }
  return accounts[accountId];
}
export function getAccount(accountId = DEFAULT_ACCOUNT_ID) {
  return accounts[accountId] || null;
}
export function listAccounts() {
  return Object.values(accounts);
}
export function getState(accountId = DEFAULT_ACCOUNT_ID) {
  return ensureAccount(accountId, accountId);
}

// ---- trading ----
export async function openTrade({ symbol, side = 'long', size, entry = null, stop = null, target = null, reason = '', confidence = null, accountSize = null, maxRiskPct = null, accountId = DEFAULT_ACCOUNT_ID, trailStopPct = null, trailTpPct = null, dca = null }) {
  // coerce + validate client-supplied numbers: NaN/'abc' would poison the
  // account ledger and let users fabricate P&L on the leaderboard/bounty
  const num = (v, name) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
    return n;
  };
  try {
    size = num(size, 'size');
    entry = num(entry, 'entry');
    stop = num(stop, 'stop');
    target = num(target, 'target');
    accountSize = num(accountSize, 'accountSize');
    maxRiskPct = num(maxRiskPct, 'maxRiskPct');
  } catch (e) { return { ok: false, error: e.message }; }
  const state = ensureAccount(accountId, accountId);
  const ticker = await getTicker(symbol);
  const fill = entry && entry > 0 ? entry : ticker.last;
  if (!fill) return { ok: false, error: 'No market price available' };
  const type = WATCHLIST.stocks.includes(symbol) ? 'stock' : 'crypto';

  let posSize = size;
  let stopPrice = stop;
  if ((!posSize || posSize <= 0) && stopPrice && stopPrice > 0 && accountSize && maxRiskPct) {
    // auto-size from risk engine
    const r = calculateRisk({ accountSize, maxRiskPct, entryPrice: fill, stopLoss: stopPrice, targetPrice: target, side });
    if (!r.ok) return { ok: false, errors: r.errors };
    posSize = r.positionSize;
  }
  if (!posSize || posSize <= 0) return { ok: false, error: 'Position size required (or provide stop + risk params for auto-sizing)' };

  // v1.13 position management (CryptoHopper-inspired, AI-aware):
  //   trailStopPct / trailTpPct — trailing stop-loss / take-profit as a % of the
  //     running peak (long) or trough (short). Ratchet only in the favorable
  //     direction; trailTp only triggers once the trailed line is past entry
  //     (a profit lock).
  //   dca: { enabled, triggerPct (e.g. 0.05 = -5%), maxTrades, sizeFactor (e.g. 0.5),
  //          cooldownMin } — automatic averaging-down on dips (paper), capped.
  const tStop = trailStopPct != null && trailStopPct > 0 ? Math.min(+trailStopPct, 0.5) : null;
  const tTp = trailTpPct != null && trailTpPct > 0 ? Math.min(+trailTpPct, 0.5) : null;
  const dcaCfg = dca && dca.enabled
    ? {
        enabled: true,
        triggerPct: Math.min(Math.max(+dca.triggerPct || 0.05, 0.01), 0.5),
        maxTrades: Math.min(Math.max(+dca.maxTrades || 3, 1), 10),
        sizeFactor: Math.min(Math.max(+dca.sizeFactor || 0.5, 0.1), 2),
        cooldownMin: Math.max(+dca.cooldownMin || 60, 5),
      }
    : null;

  const position = {
    id: id(), symbol, type, side, entry: fill, stop: stopPrice, target,
    size: posSize, notional: Math.round(fill * posSize * 100) / 100,
    reason: reason || (side === 'long' ? 'Long setup' : 'Short setup'),
    confidence, openedAt: Date.now(), lastPrice: fill,
    // v1.13 management state
    trailStopPct: tStop, trailTpPct: tTp, trailPeak: fill, // peak = extreme price since open
    dca: dcaCfg, dcaCount: 0, dcaLastAt: null, dcaTrades: [],
  };

  const journalEntry = {
    id: position.id, symbol, side, entry: fill, stop: stopPrice, target,
    size: posSize, reason: position.reason, confidence,
    status: 'open', openedAt: Date.now(), closedAt: null, exitPrice: null, pnl: null, pnlPct: null, result: null,
    trailStopPct: tStop, trailTpPct: tTp, dcaEnabled: !!dcaCfg,
  };

  if (position.notional > state.account.cash) {
    return { ok: false, error: `insufficient cash to open (need $${position.notional}, have $${Math.round(state.account.cash * 100) / 100})` };
  }

  state.positions.push(position);
  state.journal.push(journalEntry);
  state.account.cash -= position.notional; // paper: cash settles at open
  save();
  return { ok: true, position: { ...position, cash: state.account.cash }, accountId: state.accountId };
}

export async function closeTrade(positionId, exitPrice = null, accountId = DEFAULT_ACCOUNT_ID, exitReason = null) {
  if (exitPrice !== null && exitPrice !== undefined && exitPrice !== '') {
    const n = Number(exitPrice);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'exitPrice must be a positive number' };
    exitPrice = n;
  }
  const state = ensureAccount(accountId, accountId);
  const pos = state.positions.find(p => p.id === positionId);
  if (!pos) return { ok: false, error: 'Position not found' };
  let fill = exitPrice;
  if (!fill || fill <= 0) {
    const t = await getTicker(pos.symbol).catch(() => null);
    fill = t?.last ?? pos.lastPrice;
  }
  const pnl = (fill - pos.entry) * pos.size * (pos.side === 'long' ? 1 : -1);
  const pnlPct = pos.entry ? (pnl / (pos.entry * pos.size)) * 100 : 0;
  const result = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';

  const j = state.journal.find(e => e.id === positionId);
  if (j) {
    j.status = 'closed'; j.closedAt = Date.now(); j.exitPrice = fill;
    j.pnl = Math.round(pnl * 100) / 100; j.pnlPct = Math.round(pnlPct * 100) / 100; j.result = result;
    if (exitReason) j.exitReason = exitReason;
  }
  state.account.cash += pos.notional + pnl;
  state.positions = state.positions.filter(p => p.id !== positionId);
  save();
  return { ok: true, pnl: Math.round(pnl * 100) / 100, pnlPct: Math.round(pnlPct * 100) / 100, result, accountId: state.accountId };
}

// v1.13 DCA: add to an EXISTING open position (lower average entry, increase size).
export async function addToPosition(positionId, extraSize, reason = 'DCA add', accountId = DEFAULT_ACCOUNT_ID) {
  const state = ensureAccount(accountId, accountId);
  const pos = state.positions.find(p => p.id === positionId);
  if (!pos) return { ok: false, error: 'Position not found' };
  if (!extraSize || extraSize <= 0) return { ok: false, error: 'extra size must be positive' };
  const ticker = await getTicker(pos.symbol);
  const fill = ticker.last;
  if (!fill) return { ok: false, error: 'No market price available' };
  const cost = Math.round(fill * extraSize * 100) / 100;
  if (cost > state.account.cash) return { ok: false, error: `insufficient cash for DCA add (need $${cost}, have $${Math.round(state.account.cash * 100) / 100})` };
  // weighted average entry
  const prevNotional = pos.entry * pos.size;
  pos.entry = Math.round(((prevNotional + fill * extraSize) / (pos.size + extraSize)) * 100000) / 100000;
  pos.size += extraSize;
  pos.notional = Math.round(pos.entry * pos.size * 100) / 100;
  pos.lastPrice = fill;
  state.account.cash -= cost;
  const j = state.journal.find(e => e.id === positionId);
  if (j) { j.entry = pos.entry; j.size = pos.size; }
  save();
  return { ok: true, position: { ...pos, cash: state.account.cash }, accountId: state.accountId, fill, cost };
}

export async function markToMarket(accountId = DEFAULT_ACCOUNT_ID) {
  const state = ensureAccount(accountId, accountId);
  for (const p of state.positions) {
    try { p.lastPrice = (await getTicker(p.symbol)).last; } catch { /* keep last */ }
  }
  save();
  return state;
}

export function resetAccount(accountId = DEFAULT_ACCOUNT_ID) {
  const prev = accounts[accountId];
  const fresh = newAccount(accountId, prev?.owner ?? accountId);
  if (prev?.createdAt) fresh.createdAt = prev.createdAt;
  accounts[accountId] = fresh;
  save();
  return fresh;
}

export function setAccountSize(accountSize, accountId = DEFAULT_ACCOUNT_ID) {
  const state = ensureAccount(accountId, accountId);
  const delta = accountSize - state.account.initialCash;
  state.account.initialCash = accountSize;
  state.account.cash += delta;
  save();
  return state.account;
}

export function journalStats(accountId = DEFAULT_ACCOUNT_ID) {
  const state = ensureAccount(accountId, accountId);
  const closed = state.journal.filter(j => j.status === 'closed');
  const wins = closed.filter(j => j.result === 'win').length;
  const losses = closed.filter(j => j.result === 'loss').length;
  const totalPnl = closed.reduce((a, j) => a + (j.pnl || 0), 0);
  return {
    total: state.journal.length, open: state.journal.length - closed.length, closed: closed.length,
    wins, losses, winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgWin: closed.filter(j => j.result === 'win').length ? Math.round(closed.filter(j => j.result === 'win').reduce((a, j) => a + j.pnl, 0) / wins * 100) / 100 : null,
    avgLoss: losses ? Math.round(closed.filter(j => j.result === 'loss').reduce((a, j) => a + j.pnl, 0) / losses * 100) / 100 : null,
  };
}
