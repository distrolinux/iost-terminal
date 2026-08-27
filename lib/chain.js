// lib/chain.js — IOST mainnet trust layer (Phase 1 "decentralized AI agents")
//
// Every agent signal gets a SHA-256 hash of its canonical payload, then that
// hash is PINNED on the IOST mainnet as the memo of a token.iost transfer tx
// (platform account → registry address / self-transfer, amount IOST_PIN_AMOUNT).
//
// Key config (optional, from .env):
//   IOST_PIN_KEY     — base58 Ed25519 private key (32-byte seed or 64-byte secret)
//   IOST_PIN_ACCOUNT — the IOST account name that pays for the pin txs
//   IOST_PIN_REGISTRY— destination account (default: the pin account itself)
//   IOST_PIN_AMOUNT  — memo-carrying transfer amount (default 0.0001)
//   IOST_RPC         — node base URL (default https://api.iost.io)
//
// No key configured → the pin is appended to data/pending_pins.json with
// status "pending-onchain" (honest UI label: "queued (off-chain)"). A
// background flush (server start + every 10 min) drains the queue when the
// key appears in .env. Real on-chain txs only happen with a funded account.
//
// Tx signing implemented from the verified protocol (iost-core SimpleEncoder +
// iost.js Codec — they are identical): custom binary serialization, SHA3-256
// tx hashes, Ed25519 publisher signature. Verified against the public RPC.

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { IOST_RPC, deriveIostNodeHealth, iostNodePublicConfig } from './iost-node.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, '..', 'data');
const QUEUE_FILE = join(DATA_DIR, 'pending_pins.json');

const CHAIN_ID = 1024; // IOST mainnet
const CHAIN_LABEL = 'iost-mainnet';
const EXPLORER = 'https://explorer.iost.io/tx/'; // verified reachable
export const PIN_MEMO_PREFIX = 'PIN:';

// ---------------------------------------------------------------------------
// IOST binary codec (matches iost-core common.SimpleEncoder / iost.js Codec)
// ---------------------------------------------------------------------------
const encInt32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n >>> 0, 0); return b; };
const encInt64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n), 0); return b; };
const encByte = (n) => { const b = Buffer.alloc(1); b.writeUInt8(Number(n) & 0xff, 0); return b; };
const encBytes = (b) => Buffer.concat([encInt32(b.length), b]);
const encString = (s) => encBytes(Buffer.from(String(s), 'utf8'));

const sigToBytes = (s) => Buffer.concat([encByte(s.algorithm), encBytes(s.signature), encBytes(s.publicKey)]);
const actionToBytes = (a) => Buffer.concat([encString(a.contract), encString(a.actionName), encString(a.data)]);
const amountToBytes = (a) => Buffer.concat([encString(a.token), encString(a.value)]);

// levels: 0 = base (hash input without signatures), 1 = publish (base + signs),
//         2 = full (publish + referredTx + publisher + publisherSigs) → on-chain hash
function txToBytes(tx, level) {
  const parts = [
    encInt64(tx.time), encInt64(tx.expiration),
    encInt64(Math.round(tx.gasRatio * 100)), encInt64(Math.round(tx.gasLimit * 100)),
    encInt64(tx.delay), encInt32(tx.chainId),
    encBytes(tx.reserved || Buffer.alloc(0)),
    encInt32(tx.signers.length), ...tx.signers.map(encString),
    encInt32(tx.actions.length), ...tx.actions.map((a) => encBytes(actionToBytes(a))),
    encInt32(tx.amountLimit.length), ...tx.amountLimit.map((a) => encBytes(amountToBytes(a))),
  ];
  if (level > 0) {
    parts.push(encInt32(tx.signatures.length), ...tx.signatures.map((s) => encBytes(sigToBytes(s))));
  }
  if (level > 1) {
    parts.push(encBytes(tx.referredTx || Buffer.alloc(0)), encString(tx.publisher));
    parts.push(encInt32(tx.publisherSigs.length), ...tx.publisherSigs.map((s) => encBytes(sigToBytes(s))));
  }
  return Buffer.concat(parts);
}
const sha3 = (buf) => crypto.createHash('sha3-256').update(buf).digest(); // IOST tx hashes are SHA3-256
const b58 = (buf) => bs58.encode(buf);

// ---------------------------------------------------------------------------
// application-level signal hash: sha256(canonicalJson(payload))
// ---------------------------------------------------------------------------
export function canonicalHash(obj) {
  const canon = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(canon).digest('hex');
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------
async function rpcGet(path, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${IOST_RPC}${path}`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    return await res.json();
  } finally { clearTimeout(t); }
}
async function rpcPost(path, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${IOST_RPC}${path}`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } finally { clearTimeout(t); }
}

// Node clock vs our clock, in nanoseconds (getNodeInfo returns server_time ns)
async function serverTimeDiffNs() {
  try {
    const info = await rpcGet('/getNodeInfo');
    const st = BigInt(info.server_time);
    if (st > 0n) return st - BigInt(Date.now()) * 1000000n;
  } catch { /* ignore */ }
  return 0n;
}

// ---------------------------------------------------------------------------
// key config
// ---------------------------------------------------------------------------
export function pinConfig() {
  const key = (process.env.IOST_PIN_KEY || '').trim();
  const account = (process.env.IOST_PIN_ACCOUNT || '').trim();
  if (!key || !account) return null;
  return {
    key,
    account,
    registry: (process.env.IOST_PIN_REGISTRY || '').trim() || account,
    amount: (process.env.IOST_PIN_AMOUNT || '0.0001').trim(),
  };
}
export function pinConfigured() { return !!pinConfig(); }

function keyPairFromPrivateKey(b58key) {
  const seed = bs58.decode(b58key.trim());
  if (seed.length < 32) throw new Error('invalid IOST private key (need ≥32 bytes)');
  const kp = nacl.sign.keyPair.fromSeed(seed.slice(0, 32));
  return { publicKey: Buffer.from(kp.publicKey), secretKey: Buffer.from(kp.secretKey) };
}

// ---------------------------------------------------------------------------
// build + sign a token.iost transfer tx and send it via the public RPC
// Returns { ok, txHash, nodeHash, block, response, error }
// ---------------------------------------------------------------------------
export async function sendPinTx({ memo, key, account, to, amount = '0.0001', gasRatio = 1, gasLimit = 1000000 }) {
  try {
    const kp = keyPairFromPrivateKey(key);
    const diff = await serverTimeDiffNs();
    const time = BigInt(Date.now()) * 1000000n + diff;
    const expiration = time + 60000000000n; // +60s — core caps expiration at 90s
    const tx = {
      time, expiration, gasRatio, gasLimit, delay: 0, chainId: CHAIN_ID,
      signers: [],
      // token.iost/transfer args are [token, from, to, amount, memo] (token FIRST)
      actions: [{ contract: 'token.iost', actionName: 'transfer', data: JSON.stringify(['iost', account, to, amount, memo]) }],
      amountLimit: [{ token: 'iost', value: String(amount) }],
      signatures: [], publisher: account, publisherSigs: [],
      reserved: null, referredTx: null,
    };
    // publisher signature covers publishHash = sha3(ToBytes(Publish)) — no signer sigs, == baseHash
    const publishHash = sha3(txToBytes(tx, 1));
    const sig = nacl.sign.detached(publishHash, kp.secretKey);
    tx.publisherSigs = [{ algorithm: 2, signature: Buffer.from(sig), publicKey: kp.publicKey }];
    const onChainHash = b58(sha3(txToBytes(tx, 2))); // == node's Tx.Hash() = Sha3(ToBytes(Full))

    const body = {
      time: time.toString(), expiration: expiration.toString(),
      gasRatio, gasLimit, delay: 0, chainId: CHAIN_ID,
      actions: tx.actions, amountLimit: tx.amountLimit, signers: [],
      signatures: [], publisher: account,
      publisherSigs: [{ algorithm: 'ED25519', signature: Buffer.from(sig).toString('base64'), publicKey: kp.publicKey.toString('base64') }],
    };
    const res = await rpcPost('/sendTx', body);
    if (!res || res.code) {
      return { ok: false, error: `node rejected tx: ${res?.message || JSON.stringify(res)}` };
    }
    const nodeHash = res.hash || onChainHash;
    // find the block the tx landed in (scan last ~20 blocks; honest null if missed)
    const block = await findTxBlock(nodeHash);
    return { ok: true, txHash: nodeHash, onChainHash, block, response: res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// scan recent blocks for a tx hash → block number (IOST mainnet mostly system
// txs; a 20-block window ≈ 60s at 3s/block). Honest null when not found.
export async function findTxBlock(txHash, attempts = 3) {
  for (let a = 0; a < attempts; a++) {
    try {
      const info = await rpcGet('/getChainInfo');
      const head = Number(info.head_block) || 0;
      const lo = Math.max(1, head - 20);
      const heights = [];
      for (let n = head; n >= lo; n--) heights.push(n);
      const blocks = (await Promise.all(heights.map((n) => rpcGet(`/getBlockByNumber/${n}/false`).catch(() => null)))).filter(Boolean);
      for (const raw of blocks) {
        const txs = raw.block?.transactions || raw.transactions || [];
        for (const t of txs) {
          if (t.hash === txHash) return Number(raw.block?.number ?? raw.number) || null;
        }
      }
    } catch { /* keep trying */ }
    if (a < attempts - 1) await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

// ---------------------------------------------------------------------------
// generic signed-tx builder (used by lib/iost-accounts.js for auth.iost/signUp
// and by the no-spend execTx probe). Same verified codec/signing as sendPinTx.
// Returns { body (camelCase JSON for /sendTx), onChainHash }.
// ---------------------------------------------------------------------------
export async function buildSignedTx({ actions, amountLimit = [], key, account, gasRatio = 1, gasLimit = 1000000 }) {
  const kp = keyPairFromPrivateKey(key);
  const diff = await serverTimeDiffNs();
  const time = BigInt(Date.now()) * 1000000n + diff;
  const expiration = time + 60000000000n; // +60s — core caps expiration at 90s
  const tx = {
    time, expiration, gasRatio, gasLimit, delay: 0, chainId: CHAIN_ID,
    signers: [], actions, amountLimit, signatures: [], publisher: account, publisherSigs: [],
    reserved: null, referredTx: null,
  };
  const publishHash = sha3(txToBytes(tx, 1));
  const sig = nacl.sign.detached(publishHash, kp.secretKey);
  tx.publisherSigs = [{ algorithm: 2, signature: Buffer.from(sig), publicKey: kp.publicKey }];
  const onChainHash = b58(sha3(txToBytes(tx, 2)));
  return {
    body: {
      time: time.toString(), expiration: expiration.toString(),
      gasRatio, gasLimit, delay: 0, chainId: CHAIN_ID,
      actions: tx.actions, amountLimit: tx.amountLimit, signers: [], signatures: [], publisher: account,
      publisherSigs: [{ algorithm: 'ED25519', signature: Buffer.from(sig).toString('base64'), publicKey: kp.publicKey.toString('base64') }],
    },
    onChainHash,
  };
}

// Dry-run execute (no consensus, no persistence, no cost). Same request shape
// as /sendTx, response shape like getTxReceiptByTxHash. Used for the
// no-spend wire probe AND name-uniqueness checks (signUp's "id existed"
// error fires before any balance/auth stage).
export async function execTx(body, timeoutMs = 20000) {
  const res = await rpcPost('/execTx', body, timeoutMs);
  if (res && res.code) return { ok: false, error: res.message || JSON.stringify(res) };
  return { ok: true, receipt: res };
}

// POST a signed tx body to /sendTx and (optionally) locate its block.
export async function sendSignedTx(body, { findBlock = true } = {}) {
  try {
    const res = await rpcPost('/sendTx', body);
    if (!res || res.code) {
      return { ok: false, error: `node rejected tx: ${res?.message || JSON.stringify(res)}` };
    }
    const nodeHash = res.hash;
    const block = findBlock ? await findTxBlock(nodeHash) : null;
    return { ok: true, txHash: nodeHash, block, response: res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// server time diff (getNodeInfo server_time ns vs our clock) — awaited by
// buildSignedTx; sendPinTx uses the same helper above.

// ---------------------------------------------------------------------------
// pending queue (no key configured → pins wait here, atomic writes)
// ---------------------------------------------------------------------------
export function publicChainActionsAvailable() {
  return process.env.PUBLIC_CHAIN_ACTIONS_ENABLED === '1';
}

// ---------------------------------------------------------------------------
function loadQueue() {
  try {
    if (existsSync(QUEUE_FILE)) {
      const parsed = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.pins)) return parsed.pins;
    }
  } catch { /* corrupt -> fresh */ }
  return [];
}
function saveQueue(pins) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${QUEUE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pins }, null, 2));
  renameSync(tmp, QUEUE_FILE);
}

export function queuePin({ signalId, hash, payload, queuedAt = Date.now() }) {
  const pins = loadQueue();
  if (pins.some((p) => p.hash === hash && p.signalId === signalId)) return; // no dup
  pins.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, signalId, hash, payload, queuedAt });
  saveQueue(pins);
}
export function listPendingPins() {
  return loadQueue().map((p) => ({ id: p.id, signalId: p.signalId, hash: p.hash, queuedAt: p.queuedAt }));
}

// Publish-time entry point: pin a signal hash on-chain when the key is
// configured, otherwise queue it (honest "pending-onchain" status).
export async function pinSignalHash(hash, payload, signalId) {
  if (!publicChainActionsAvailable()) {
    return { status: 'disabled', error: 'public-chain actions are unavailable in the paper-only launch', queuedAt: null };
  }
  const cfg = pinConfig();
  if (cfg) {
    const memo = `${PIN_MEMO_PREFIX}${hash}`;
    const r = await sendPinTx({ memo, key: cfg.key, account: cfg.account, to: cfg.registry, amount: cfg.amount });
    if (r.ok) {
      console.log(`[chain] pinned ${hash.slice(0, 12)}… tx ${r.txHash}${r.block ? ` block ${r.block}` : ''}`);
      return { status: 'pinned', txHash: r.txHash, block: r.block ?? null, pinnedAt: Date.now(), queuedAt: null };
    }
    console.warn(`[chain] live pin failed (${r.error}) — queuing ${hash.slice(0, 12)}…`);
    queuePin({ signalId, hash, payload });
    return { status: 'pending-onchain', error: r.error, queuedAt: Date.now() };
  }
  console.log(`[chain] IOST key not configured — pin queued ${hash.slice(0, 12)}…`);
  queuePin({ signalId, hash, payload });
  return { status: 'pending-onchain', queuedAt: Date.now() };
}

// drain the queue when a key is configured. Returns results per pin so the
// caller can update its own stores (signals.json etc).
export async function flushPendingQueue() {
  if (!publicChainActionsAvailable()) return { configured: false, disabled: true, results: [] };
  const cfg = pinConfig();
  if (!cfg) return { configured: false, results: [] };
  const pins = loadQueue();
  if (!pins.length) return { configured: true, results: [] };
  const results = [];
  const remaining = [];
  for (const p of pins) {
    const memo = `${PIN_MEMO_PREFIX}${p.hash}`;
    const r = await sendPinTx({ memo, key: cfg.key, account: cfg.account, to: cfg.registry, amount: cfg.amount });
    if (r.ok) {
      results.push({ id: p.id, signalId: p.signalId, hash: p.hash, ok: true, txHash: r.txHash, block: r.block, pinnedAt: Date.now() });
    } else {
      results.push({ id: p.id, signalId: p.signalId, hash: p.hash, ok: false, error: r.error });
      remaining.push(p); // keep failed pins in the queue for the next flush
    }
  }
  saveQueue(remaining);
  return { configured: true, results };
}

// ---------------------------------------------------------------------------
// proof: verify a signal's pin. Real on-chain check via getTxReceiptByTxHash
// (works on this node — memo visible in receipt content); getTxByHash is
// "Not Implemented" here, so receipts are the authoritative check. Falls back
// to an honest local recompute + integrity comparison.
// ---------------------------------------------------------------------------
export async function buildProof({ hash, payload, pin }) {
  const localHash = canonicalHash(payload);
  const localMatch = localHash === hash;
  const out = {
    hash,
    localHash,
    recompute: true, // we always recompute locally — the chain check is layered on top
    localMatch,
    payload,
    chain: CHAIN_LABEL,
    pinned: false,
    verified: false,
    tx: null,
    block: null,
    explorerUrl: null,
    note: '',
  };
  if (pin?.status === 'pinned' && pin.txHash) {
    out.pinned = true;
    out.tx = pin.txHash;
    out.block = pin.block ?? null;
    out.explorerUrl = `${EXPLORER}${pin.txHash}`;
    // authoritative on-chain check: fetch the receipt, look for our memo
    try {
      const rec = await rpcGet(`/getTxReceiptByTxHash/${pin.txHash}`);
      if (rec && !rec.code && rec.status_code === 'SUCCESS') {
        const memo = memoFromReceipt(rec);
        if (memo === `${PIN_MEMO_PREFIX}${hash}`) {
          out.verified = true;
          out.recompute = false; // chain state is the source of truth
          out.note = 'receipt verified on IOST mainnet (memo matches)';
        } else {
          out.note = `receipt found but memo mismatch (${memo ? 'different memo' : 'no transfer memo'})`;
        }
      } else if (rec?.code === 2 || (rec && /not found/i.test(rec.message || ''))) {
        out.note = 'tx not found on chain yet — stored pin record is pending confirmation';
      } else {
        out.note = `receipt lookup returned: ${rec?.message || JSON.stringify(rec).slice(0, 120)}`;
      }
    } catch (e) {
      out.note = `receipt lookup failed: ${e.message}`;
    }
  } else if (pin?.status === 'pending-onchain' || pin?.status === 'queued') {
    out.note = 'queued (off-chain) — will be anchored when the IOST pin key is configured';
  }
  return out;
}

// parse the token.iost/transfer receipt content JSON array → memo (index 4)
function memoFromReceipt(receipt) {
  const receipts = receipt.receipts || [];
  for (const r of receipts) {
    if (r.func_name !== 'token.iost/transfer') continue;
    try {
      const arr = JSON.parse(r.content);
      if (Array.isArray(arr)) return String(arr[4] ?? '');
    } catch { /* not parseable */ }
  }
  return null;
}

// chain health for the UI badge
export async function chainStatus() {
  const started = Date.now();
  try {
    const [info, nodeInfo] = await Promise.all([
      rpcGet('/getChainInfo'),
      rpcGet('/getNodeInfo').catch(() => null),
    ]);
    return {
      ok: true, chain: CHAIN_LABEL, chainId: info.chain_id, headBlock: info.head_block, net: info.net_name,
      configured: pinConfigured(),
      node: { ...iostNodePublicConfig(), ...deriveIostNodeHealth(info, nodeInfo, Date.now(), Date.now() - started) },
    };
  } catch (e) {
    return {
      ok: false, chain: CHAIN_LABEL, error: e.message, configured: pinConfigured(),
      node: { ...iostNodePublicConfig(), ...deriveIostNodeHealth(null, null, Date.now(), Date.now() - started) },
    };
  }
}
