// lib/fees.js — credit fee engine (v3, Phase 1).
// Trade-volume credits: live execution burns credits by notional. Every knob
// lives in data/fee-config.json and is admin-modifiable at runtime (no code,
// no restart). The owner's account can be fee-exempt. Paper trading is free.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, 'data');
const FILE = join(DATA_DIR, 'fee-config.json');

const DEFAULTS = {
  burnRate: 0.01,          // credits per $1 notional (0.01 = 0.1%)
  minCreditsToTrade: 50,   // live execution blocked below this
  freeTrialCredits: 0,
  feeExemptAccounts: [],   // exact accountIds, e.g. ['user:<uuid>']
  wallet: {},              // { USDT_TRC20: 'TX...', IOST: 'iost_...' }
  bundles: [
    { id: 'b10', usd: 10, credits: 1000 },
    { id: 'b50', usd: 50, credits: 5500 },
    { id: 'b100', usd: 100, credits: 12000 },
  ],
};

let config = load();

function load() {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      return { ...DEFAULTS, ...parsed, bundles: Array.isArray(parsed.bundles) ? parsed.bundles : DEFAULTS.bundles };
    }
  } catch { /* corrupt -> defaults */ }
  persistConfig(DEFAULTS);
  return { ...DEFAULTS, bundles: [...DEFAULTS.bundles] };
}

function persistConfig(cfg) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
    chmodSync(FILE, 0o600);
  } catch { /* config writes must never crash trading */ }
}

export function getFeeConfig() { return config; }

/** Validate + persist a new config (admin PUT). Returns { ok } | { ok:false, error }. */
export function setFeeConfig(next) {
  const cfg = { ...config, ...(next || {}) };
  if (typeof cfg.burnRate !== 'number' || cfg.burnRate < 0 || cfg.burnRate > 1)
    return { ok: false, error: 'burnRate must be a number 0..1' };
  if (typeof cfg.minCreditsToTrade !== 'number' || cfg.minCreditsToTrade < 0)
    return { ok: false, error: 'minCreditsToTrade must be >= 0' };
  if (!Array.isArray(cfg.bundles) || cfg.bundles.some(b => !b?.id || !(b.usd > 0) || !(b.credits > 0)))
    return { ok: false, error: 'bundles must be [{id, usd>0, credits>0}]' };
  if (cfg.wallet != null && (typeof cfg.wallet !== 'object' || Array.isArray(cfg.wallet)))
    return { ok: false, error: 'wallet must be an object of address strings' };
  if (!Array.isArray(cfg.feeExemptAccounts)) return { ok: false, error: 'feeExemptAccounts must be an array' };
  config = cfg;
  persistConfig(cfg);
  return { ok: true, config: cfg };
}

export function isFeeExempt(accountId) {
  return config.feeExemptAccounts.includes(accountId);
}

// ---- wallet (lives on the account record; mutated in place) ----
export function walletOf(account) {
  if (!account.wallet) {
    account.wallet = { credits: config.freeTrialCredits || 0, history: [] };
  }
  return account.wallet;
}

/** Credits needed for one order of a given notional (0 when fee-exempt). */
export function burnForOrder(notional) {
  if (!notional || notional <= 0) return 0;
  return Math.round(notional * config.burnRate * 100) / 100;
}

/** Can this account place a live order right now? Free trading — no gate. */
export function canTrade(account) {
  return { ok: true };
}

/** Grant credits (admin confirmation of a payment, trial, corrections). */
export function grantCredits(account, amount, note = 'admin grant') {
  const w = walletOf(account);
  const a = Math.round((amount || 0) * 100) / 100;
  if (a <= 0) return { ok: false, error: 'amount must be > 0' };
  w.credits = Math.round((w.credits + a) * 100) / 100;
  w.history.push({ ts: Date.now(), kind: 'grant', amount: a, note });
  return { ok: true, credits: w.credits };
}

/**
 * Burn credits for an executed live order. Free trading — nothing is ever
 * burned. Kept for API compatibility (returns 0 burn).
 */
export function burnCredits(account, notional) {
  return { ok: true, burn: 0, credits: walletOf(account).credits };
}

export function walletSummary(account) {
  const w = walletOf(account);
  return { credits: w.credits, history: w.history.slice(-20).reverse() };
}
