// lib/broker/kraken.js — KrakenBroker: live venue adapter (v2).
// Implements the broker contract (see README.md). Read-only-safe: construction
// never calls the API. getAccount/getPositions/getOrders are read-only;
// placeOrder/cancelOrder touch real money — callers MUST pass risk rails first
// (lib/risk.js, Phase 3) and require explicit user approval in live mode.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, createHash } from 'node:crypto';
import { verifyLiveFillEvidence } from '../live-fill-evidence.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_BASE = 'https://api.kraken.com';

// ---- env: keys live in .env (app root), real env vars win ----
function ensureKeys() {
  if (process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET) return;
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// our symbol -> Kraken pair (canonical names; XBT = BTC, XDG = DOGE)
const PAIR_OF = {
  BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'XDGUSD',
  ADA: 'ADAUSD', AVAX: 'AVAXUSD', LINK: 'LINKUSD', DOT: 'DOTUSD', SUI: 'SUIUSD',
  ARB: 'ARBUSD', OP: 'OPUSD', TON: 'TONUSD', NEAR: 'NEARUSD', LTC: 'LTCUSD',
};
const SYMBOL_OF_PAIR = Object.fromEntries(Object.entries(PAIR_OF).map(([s, p]) => [p, s]));

// Kraken Ticker returns CANONICAL pair keys (XXBTZUSD, XETHZUSD, XLTCZUSD...),
// not the aliases we request (XBTUSD, ETHUSD...). Map canonical -> requested.
const RESPONSE_KEYS = {
  XXBTZUSD: 'XBTUSD', XETHZUSD: 'ETHUSD', XLTCZUSD: 'LTCUSD', XDGUSD: 'XDGUSD',
};
function normalizeAsset(code) {
  if (code.startsWith('Z')) return code.slice(1);           // ZUSD -> USD
  if (/^X[A-Z]{3}$/.test(code)) {                           // XXBT -> XBT
    const c = code.slice(1);
    return c === 'XBT' ? 'BTC' : c === 'XDG' ? 'DOGE' : c === 'XLTC' ? 'LTC' : c;
  }
  return code;
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Kraken request unavailable');
  const reader = res.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > 1048576) throw Error('Kraken response unavailable');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('Kraken response unavailable'); }
}

function sign(secretB64, path, postdata, nonce) {
  // Kraken: API-Sign = b64(hmac_sha512(secret, sha256(nonce + postdata) + path))
  const secret = Buffer.from(secretB64, 'base64');
  const sha256 = createHash('sha256').update(nonce + postdata).digest(); // nonce PREFIXED
  const msg = Buffer.concat([Buffer.from(path), sha256]);
  return createHmac('sha512', secret).update(msg).digest('base64');
}

function fillQuantity(order) {
  const parse = s => {
    if (typeof s !== 'string' || !/^(0|[1-9]\d{0,19})(\.\d{1,10})?$/.test(s)) throw Error('Order quantity evidence unavailable');
    const [w, f = ''] = s.split('.'); return BigInt(w) * 10000000000n + BigInt(f.padEnd(10, '0'));
  };
  if (parse(order.vol_exec) > parse(order.vol)) throw Error('Order quantity evidence unavailable');
  return order.vol_exec;
}
export function createKrakenBroker({ apiKey: keyOverride, secret: secretOverride, apiSecret, ownerId: boundOwnerId } = {}) {
  const explicit = keyOverride !== undefined || secretOverride !== undefined || apiSecret !== undefined || boundOwnerId !== undefined;
  if (!explicit) ensureKeys();
  // Per-user override (v3): a user's OWN keys, encrypted in lib/keys.js.
  // server.js sends { apiKey, apiSecret } — accept BOTH spellings so the
  // user's secret is never silently dropped for the platform secret.
  const key = explicit ? keyOverride : process.env.KRAKEN_API_KEY;
  const secret = explicit ? (apiSecret ?? secretOverride) : process.env.KRAKEN_API_SECRET;
  const configured = typeof key === 'string' && key.length > 0 && typeof secret === 'string' && secret.length > 0;
  // Private opaque connection binding, not a verified venue account identity.
  // Never expose in HTTP, MCP, logs or discovery. Key rotation deliberately holds.
  const credentialBinding = ownerId => {
    if (!explicit || !configured || typeof ownerId !== 'string' || !ownerId || ownerId.length > 256 || ownerId !== boundOwnerId) return null;
    return createHmac('sha256', secret).update(JSON.stringify(['iost-kraken-connection-v1', ownerId, key])).digest('hex');
  };

  async function privateCall(method, params = {}) {
    if (!configured) throw new Error('Kraken keys not configured (KRAKEN_API_KEY/SECRET in .env)');
    const path = `/0/private/${method}`;
    const nonce = String(Date.now() * 1000);
    const postdata = new URLSearchParams({ nonce, ...params }).toString();
    const res = await jsonFetch(API_BASE + path, {
      method: 'POST',
      headers: {
        'API-Key': key,
        'API-Sign': sign(secret, path, postdata, nonce),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postdata,
    });
    if (!Array.isArray(res.error) || res.error.length || !res.result || typeof res.result !== 'object') throw new Error('Kraken response unavailable');
    return res.result;
  }

  async function publicTicker(pairs) {
    const res = await jsonFetch(`${API_BASE}/0/public/Ticker?pair=${pairs.join(',')}`);
    if (res.error && res.error.length) throw new Error(`Kraken Ticker: ${res.error.join('; ')}`);
    return res.result;
  }

  return {
    name: 'kraken',
    configured,
    credentialBinding,

    // Query exactly the acknowledged venue ID, never infer absence as failure.
    // Exact decimal strings retained; fills/fees are not booked by this method.
    async getOrderEvidence(hold, ownerId) {
      try {
        const binding = credentialBinding(ownerId);
        if (!binding || hold?.credentialBinding !== binding) throw Error('connection mismatch');
        const pair = PAIR_OF[hold?.order?.symbol];
        if (!pair || !['long', 'short'].includes(hold.order.side) || typeof hold.clientOrderId !== 'string' || typeof hold.venueOrderId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(hold.venueOrderId)) throw Error('identity');
        const res = await privateCall('QueryOrders', { txid: hold.venueOrderId, trades: 'true' });
        if (Object.keys(res).length !== 1 || !Object.hasOwn(res, hold.venueOrderId)) throw Error('missing order');
        const o = res[hold.venueOrderId];
        const decimal = value => {
          if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})(\.\d{1,10})?$/.test(value)) throw Error('decimal');
          const [w, f = ''] = value.split('.');
          return BigInt(w) * 10000000000n + BigInt(f.padEnd(10, '0'));
        };
        const type = hold.order.entry === null ? 'market' : 'limit';
        if (o?.descr?.ordertype !== type || (type === 'limit' && decimal(o.descr.price) !== decimal(hold.order.entry))) throw Error('order terms');
        const expected = { clientOrderId: hold.clientOrderId, venueOrderId: hold.venueOrderId, pair, side: hold.order.side === 'short' ? 'sell' : 'buy', quantity: hold.order.size, credentialBinding: binding };
        const observation = { clientOrderId: o.cl_ord_id, venueOrderId: hold.venueOrderId, pair: RESPONSE_KEYS[o.descr.pair] || o.descr.pair, side: o.descr.type, quantity: o.vol, filledQuantity: fillQuantity(o), status: o.status };
        return { ok: true, expected, observation, fillSummary: { ...observation, cost: o.cost, fee: o.fee, tradeIds: o.trades } };
      } catch { return { ok: false, outcome: 'unknown' }; }
    },

    // At most one bounded read-only query. Larger histories require a reviewed
    // pagination/recovery path; never silently truncate or guess missing fills.
    async getFillEvidence(summary) {
      try {
        const ids = summary?.tradeIds;
        if (!Array.isArray(ids) || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id))) throw Error('trade IDs');
        const result = ids.length ? await privateCall('QueryTrades', { txid: ids.join(','), trades: 'false' }) : {};
        const normalized = Object.fromEntries(Object.entries(result).map(([id, trade]) => [id, { ...trade, pair: RESPONSE_KEYS[trade?.pair] || trade?.pair }]));
        return verifyLiveFillEvidence(summary, normalized);
      } catch { return { status: 'unknown', feesVerified: false, releaseAllowed: false, executionAuthorized: false }; }
    },

    /** { ok, account } — balances + best-effort USD equity (0 for unsupported assets). */
    async getAccount() {
      try {
        const bal = await privateCall('Balance');
        const balances = {};
        let usd = 0;
        for (const [code, v] of Object.entries(bal)) {
          const a = normalizeAsset(code);
          balances[a] = parseFloat(v);
          if (a === 'USD') usd = parseFloat(v);
        }
        return { ok: true, account: { balances, cashUsd: usd, venue: 'kraken' } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** { ok, quotes } — fresh last prices for supported symbols (IOST etc. omitted). */
    async getQuotes(symbols = []) {
      const wanted = symbols.filter(s => PAIR_OF[s]);
      const quotes = {};
      if (!wanted.length) return { ok: true, quotes };
      try {
        const res = await publicTicker(wanted.map(s => PAIR_OF[s]));
        for (const [pair, t] of Object.entries(res)) {
          const requested = RESPONSE_KEYS[pair] || pair; // canonical -> requested alias
          const sym = SYMBOL_OF_PAIR[requested] || wanted.find(s => PAIR_OF[s] === requested);
          if (sym && Array.isArray(t?.c) && t.c[0]) quotes[sym] = { last: parseFloat(t.c[0]), ts: Date.now() };
        }
        return { ok: true, quotes };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** { ok, positions } — open positions on the venue. */
    async getPositions() {
      try {
        const res = await privateCall('OpenPositions', {});
        const positions = Object.entries(res).map(([txid, p]) => ({
          txid, symbol: SYMBOL_OF_PAIR[p.pair] || p.pair, side: p.type === 'sell' ? 'short' : 'long',
          size: parseFloat(p.vol), entry: parseFloat(p.cost) / parseFloat(p.vol) || null,
        }));
        return { ok: true, positions };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** { ok, orders } — resting orders on the venue. */
    async getOrders() {
      try {
        const res = await privateCall('OpenOrders', {});
        const orders = Object.entries(res.open || {}).map(([txid, o]) => ({
          txid, symbol: SYMBOL_OF_PAIR[o.descr?.pair] || o.descr?.pair,
          side: o.descr?.type === 'sell' ? 'short' : 'long',
          type: o.descr?.ordertype, size: parseFloat(o.vol), price: parseFloat(o.descr?.price) || null,
          filledQuantity: fillQuantity(o),
        }));
        return { ok: true, orders };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /**
     * { ok, order } — place a real order on Kraken.
     * order: { symbol, side: 'long'|'short', size (asset units), entry (limit price, optional) }
     * market orders use current market price when entry omitted.
     */
    async placeOrder(order = {}) {
      const { symbol, side = 'long', size, entry, clientOrderId } = order;
      if (!configured) return { ok: false, error: 'Kraken keys not configured' };
      const pair = PAIR_OF[symbol];
      if (!pair) return { ok: false, error: `Symbol ${symbol} not supported on Kraken` };
      if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'Order size required' };
      if (typeof clientOrderId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(clientOrderId)) return { ok: false, error: 'Durable client order identity required' };
      const ordertype = entry && entry > 0 ? 'limit' : 'market';
      try {
        const res = await privateCall('AddOrder', {
          pair, type: side === 'short' ? 'sell' : 'buy', ordertype, cl_ord_id: clientOrderId,
          volume: String(size), ...(ordertype === 'limit' ? { price: String(entry) } : {}),
        });
        if (!Array.isArray(res.txid) || res.txid.length !== 1 || typeof res.txid[0] !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(res.txid[0])) throw Error('invalid acknowledgement');
        return { ok: true, order: { venueOrderId: res.txid[0], venue: 'kraken', status: 'accepted' } };
      } catch { return { ok: false, outcome: 'unknown', error: 'Order outcome unknown; reconcile before any retry.' }; }
    },

    /** { ok } — cancel a resting order by venue txid. */
    async cancelOrder(orderId) {
      if (!configured) return { ok: false, error: 'Kraken keys not configured' };
      if (!orderId) return { ok: false, error: 'Order id required' };
      try {
        await privateCall('CancelOrder', { txid: orderId });
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  };
}
