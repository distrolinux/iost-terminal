// lib/iost-accounts.js — IOST mainnet wallets (free account per user; opening is now FREE — 2026-08-24)
//
// owner-approved model (2026-08-10): every registered user gets a REAL IOST
// mainnet account; IOST account opening has NO creation fee anymore. The
// platform creates the account on-chain via auth.iost/signUp; the official
// free signup is iostaccount.io/en/create (linked from the site).
//
// KEY CUSTODY RULE: the server NEVER generates or holds user private keys.
// The user's browser generates the Ed25519 keypair; the server only ever sees
// the PUBLIC key (base64 of the 32-byte pubkey) + the account name, and
// broadcasts the auth.iost/signUp tx with the platform's funded account
// (the SAME IOST_PIN_KEY/IOST_PIN_ACCOUNT from .env that lib/chain.js uses
// for pins — one funded account powers both). No key configured → creation
// requests QUEUE in the store (status "pending") and the UI labels them
// honestly; a flush on boot + every 10 min drains the queue when the key
// appears (mirrors the pending_pins.json pattern).
//
// ABI (VERIFIED 2026-08-10 against the DEPLOYED mainnet contract pulled from
// the live RPC getContract/auth.iost + the iost-core genesis source):
//   action:  auth.iost/signUp          (NOTE: auth.iost/createAccount does
//                                       NOT exist on mainnet — signUp is the
//                                       account-creation action)
//   args:    [id, owner, active]       id = account name (5-11 chars,
//                                       [a-z0-9_], not starting "Contract");
//                                       owner/active = base58 of the 32-byte
//                                       Ed25519 public key (iost.js KeyPair.id)
//   referrer: blockchain.publisher()   = the platform account (no creator arg)
//   RAM:      paid by auth.iost itself (storage.mapPut payer = contract) —
//             NO separate ram.iost/pledge needed for the base record
//   gas:      auth.iost/signUp pledges gas for the new account as before;
//             with free account opening (2026-08-24) no creation fee is charged

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { buildSignedTx, execTx, sendSignedTx, pinConfig } from './chain.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, '..', 'data');
const STORE_FILE = join(DATA_DIR, 'iost_accounts.json');

export const EXPLORER_TX = 'https://explorer.iost.io/tx/'; // verified reachable
export const NAME_RE = /^[a-z0-9_]{5,11}$/; // auth.iost _checkIdValid (deployed contract, verified)
export const NAME_RULES = '5-11 chars, lowercase a-z, 0-9 or underscore only';
export const FEE_IOST = 0; // IOST account opening is now free (2026-08-24) — no creation fee
export const SUBSIDIZED = true;
export const SIGNUP_GAS_LIMIT = 2000000; // iost.js default for newAccount

// ---------------------------------------------------------------------------
// store: data/iost_accounts.json — { byUserId: { [userId]: entry } }
// entry: { userId, accountName, publicKey (base64), status, tx?, block?,
//          error?, referrer?, createdAt, updatedAt }
// status: "none" | "pending" | "created" | "failed" (queue == pending rows)
// ---------------------------------------------------------------------------
function loadStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    if (parsed && parsed.byUserId && typeof parsed.byUserId === 'object') return parsed;
  } catch { /* corrupt -> fresh */ }
  return { byUserId: {} };
}
function saveStore(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, STORE_FILE);
}
function updateEntry(userId, patch) {
  const store = loadStore();
  const entry = store.byUserId[userId];
  if (!entry) return null;
  Object.assign(entry, patch, { updatedAt: Date.now() });
  saveStore(store);
  return entry;
}

// ---------------------------------------------------------------------------
// config + public honesty endpoint data
// ---------------------------------------------------------------------------
export function walletConfig() { return pinConfig(); } // same key/account as pins
export function publicStatus() {
  return {
    subsidized: SUBSIDIZED,
    feeIost: FEE_IOST,
    configured: !!walletConfig(),
    action: 'auth.iost/signUp',
    nameRules: NAME_RULES,
    explorer: EXPLORER_TX,
  };
}

// ---------------------------------------------------------------------------
// naming: default = "u" + hex chars from sha256(userId:attempt)
//   attempt 0 → 9 chars (u + 8 hex), 1 → 10 chars, 2 → 11 chars (max)
// ---------------------------------------------------------------------------
export function defaultAccountName(userId, attempt = 0) {
  const h = crypto.createHash('sha256').update(`${userId}:${attempt}`).digest('hex');
  const chars = 8 + Math.min(Math.max(attempt, 0), 2);
  return 'u' + h.slice(0, chars);
}

// ---------------------------------------------------------------------------
// validation (name rules from the deployed contract; pubkey = 32 bytes)
// ---------------------------------------------------------------------------
export function validateRequest({ accountName, publicKey }) {
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    return { ok: false, error: 'publicKey required (base64 of the 32-byte Ed25519 public key)' };
  }
  let bytes = null;
  try { bytes = Buffer.from(publicKey.trim(), 'base64'); } catch { /* invalid */ }
  if (!bytes || bytes.length !== 32) {
    return { ok: false, error: 'publicKey must be the base64 of exactly 32 bytes (Ed25519 public key)' };
  }
  const name = (accountName ?? '').trim();
  if (name && !NAME_RE.test(name)) {
    return { ok: false, error: `invalid account name — ${NAME_RULES}` };
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// requestCreation — the API entry point. Anti-abuse: 1 wallet per user;
// re-request blocked unless the previous attempt FAILED.
// ---------------------------------------------------------------------------
export async function requestCreation({ userId, accountName, publicKey }) {
  const v = validateRequest({ accountName, publicKey });
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  const store = loadStore();
  const existing = store.byUserId[userId];
  if (existing && (existing.status === 'pending' || existing.status === 'created')) {
    return {
      ok: false, status: 409,
      error: `wallet already ${existing.status} (${existing.accountName})`,
      entry: existing,
    };
  }

  // pick the name: caller's (validated) or a derived default; never let two
  // users of THIS platform claim the same name
  let name = v.name || defaultAccountName(userId);
  if (v.name) {
    const clash = Object.entries(store.byUserId).some(([uid, e]) => uid !== userId && e.accountName === v.name);
    if (clash) return { ok: false, status: 409, error: 'account name already claimed on this platform' };
  } else {
    let attempt = 0;
    while (attempt < 3 && Object.values(store.byUserId).some((e) => e.accountName === name)) {
      name = defaultAccountName(userId, ++attempt);
    }
  }

  const now = Date.now();
  const entry = {
    userId, accountName: name, publicKey: publicKey.trim(), nameSource: v.name ? 'user' : 'derived',
    status: 'pending', tx: null, block: null, error: null, referrer: null,
    createdAt: now, updatedAt: now,
  };
  store.byUserId[userId] = entry;
  saveStore(store);

  const cfg = walletConfig();
  if (cfg) {
    // key configured → create right away (flush-style attempt)
    const r = await createAccountOnChain(userId);
    const fresh = getEntry(userId);
    return {
      ok: true, status: r.ok ? 201 : 202,
      entry: fresh,
      message: r.ok
        ? `wallet created on-chain (${fresh.accountName})`
        : `wallet creation attempted but not yet created: ${fresh.error || 'see status'}`,
    };
  }
  console.log(`[iost-acct] key not configured — wallet creation queued for user ${userId} (${name})`);
  return { ok: true, status: 202, entry, message: 'queued — will be created once platform funding is configured' };
}

export function getEntry(userId) {
  const e = loadStore().byUserId[userId];
  return e ? { ...e } : null;
}

// ---------------------------------------------------------------------------
// createAccountOnChain — build + sign auth.iost/signUp with the platform key,
// dry-run pre-check (zero cost), then broadcast. Updates the store entry.
// Returns { ok, entry, txHash?, block?, error? }.
// ---------------------------------------------------------------------------
export async function createAccountOnChain(userId) {
  const cfg = walletConfig();
  const entry = getEntry(userId);
  if (!entry) return { ok: false, error: 'no wallet entry' };
  if (!cfg) return { ok: false, error: 'platform funding key not configured' };
  if (entry.status === 'created') return { ok: true, entry, txHash: entry.tx, block: entry.block };

  const ownerB58 = bs58.encode(Buffer.from(entry.publicKey, 'base64'));
  const derived = entry.nameSource === 'derived';
  const nameIsTaken = (msg) => /id existed/i.test(msg || '');

  for (let attempt = 0; attempt < (derived ? 3 : 1); attempt++) {
    const name = attempt === 0 ? entry.accountName : defaultAccountName(entry.userId, attempt);
    const { body } = await buildSignedTx({
      actions: [{
        contract: 'auth.iost',
        actionName: 'signUp',
        data: JSON.stringify([name, ownerB58, ownerB58]),
      }],
      amountLimit: [{ token: 'iost', value: '100' }],
      key: cfg.key, account: cfg.account, gasRatio: 1, gasLimit: SIGNUP_GAS_LIMIT,
    });

    // zero-cost pre-check with the REAL funded publisher: dry-run executes the
    // full signUp — a taken name surfaces as "id existed" here, nothing commits
    const dry = await execTx(body);
    if (dry.ok && dry.receipt?.status_code && dry.receipt.status_code !== 'SUCCESS') {
      const msg = String(dry.receipt.message || '');
      if (nameIsTaken(msg)) {
        if (derived && attempt < 2) continue; // name taken → next derived candidate
        updateEntry(userId, { status: 'failed', error: `account name taken on-chain (${name}) — retry with a different name` });
        return { ok: false, entry: getEntry(userId), error: `name taken (${name})` };
      }
      if (!/gas not enough/i.test(msg) && !/require auth failed/i.test(msg)) {
        // an unexpected runtime error — surface it honestly (gas/auth errors
        // mean the publisher account itself is unviable; keep pending for the
        // next flush rather than failing the user's wallet)
        updateEntry(userId, { status: 'failed', error: `dry-run failed: ${msg}` });
        return { ok: false, entry: getEntry(userId), error: msg };
      }
      break; // gas/auth-stage errors → the real send would fail too; fall through
    }

    const sent = await sendSignedTx(body);
    if (sent.ok) {
      const updated = updateEntry(userId, {
        status: 'created', tx: sent.txHash, block: sent.block ?? null,
        error: null, referrer: cfg.account,
      });
      console.log(`[iost-acct] wallet created for user ${userId} → ${name} tx ${sent.txHash}${sent.block ? ` block ${sent.block}` : ''}`);
      return { ok: true, entry: updated, txHash: sent.txHash, block: sent.block };
    }
    if (nameIsTaken(sent.error)) {
      if (derived && attempt < 2) continue;
      updateEntry(userId, { status: 'failed', error: `account name taken on-chain (${name}) — retry with a different name` });
      return { ok: false, entry: getEntry(userId), error: `name taken (${name})` };
    }
    // transient node error → keep pending so the next flush retries it
    console.warn(`[iost-acct] create failed for ${name} (${sent.error}) — staying pending`);
    updateEntry(userId, { error: sent.error ?? 'node error' }); // status stays pending
    return { ok: false, entry: getEntry(userId), error: sent.error };
  }
  updateEntry(userId, { status: 'failed', error: 'could not find a free account name' });
  return { ok: false, entry: getEntry(userId), error: 'could not find a free account name' };
}

// ---------------------------------------------------------------------------
// queue flush: boot + every 10 min — creates pending wallets once the key
// appears (same honest pattern as pending_pins.json). Idempotent: only rows
// still status "pending" are touched; the send path marks them created/failed.
// ---------------------------------------------------------------------------
export async function flushPendingCreations() {
  const cfg = walletConfig();
  if (!cfg) return { configured: false, results: [] };
  const pendings = Object.values(loadStore().byUserId).filter((e) => e.status === 'pending');
  if (!pendings.length) return { configured: true, results: [] };
  const results = [];
  for (const e of pendings) {
    const r = await createAccountOnChain(e.userId);
    results.push({ userId: e.userId, accountName: e.accountName, ok: r.ok, txHash: r.txHash ?? null, block: r.block ?? null, error: r.error ?? null });
    if (r.ok) console.log(`[iost-acct] queue flush → created ${e.accountName} tx ${r.txHash}`);
    else console.warn(`[iost-acct] queue flush → retry ${e.accountName} (${r.error})`);
  }
  return { configured: true, results };
}
