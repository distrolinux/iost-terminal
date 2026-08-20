// lib/broker/kraken.js — KrakenBroker: live venue adapter (v2).
// Implements the broker contract (see README.md). Read-only-safe: construction
// never calls the API. getAccount/getPositions/getOrders are read-only;
// placeOrder/cancelOrder touch real money — callers MUST pass risk rails first
// (lib/risk.js, Phase 3) and require explicit user approval in live mode.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, createHash } from 'node:crypto';

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
  const res = await fetch(url, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

function sign(secretB64, path, postdata, nonce) {
  // Kraken: API-Sign = b64(hmac_sha512(secret, sha256(nonce + postdata) + path))
  const secret = Buffer.from(secretB64, 'base64');
  const sha256 = createHash('sha256').update(nonce + postdata).digest(); // nonce PREFIXED
  const msg = Buffer.concat([Buffer.from(path), sha256]);
  return createHmac('sha512', secret).update(msg).digest('base64');
}

export function createKrakenBroker({ apiKey: keyOverride, secret: secretOverride, apiSecret } = {}) {
  ensureKeys();
  // Per-user override (v3): a user's OWN keys, encrypted in lib/keys.js.
  // server.js sends { apiKey, apiSecret } — accept BOTH spellings so the
  // user's secret is never silently dropped for the platform secret.
  const key = keyOverride || process.env.KRAKEN_API_KEY;
  const secret = apiSecret || secretOverride || process.env.KRAKEN_API_SECRET;
  const configured = Boolean(key && secret);

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
    if (res.error && res.error.length) throw new Error(`Kraken ${method}: ${res.error.join('; ')}`);
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
      const { symbol, side = 'long', size, entry } = order;
      if (!configured) return { ok: false, error: 'Kraken keys not configured' };
      const pair = PAIR_OF[symbol];
      if (!pair) return { ok: false, error: `Symbol ${symbol} not supported on Kraken` };
      if (!size || size <= 0) return { ok: false, error: 'Order size required' };
      const ordertype = entry && entry > 0 ? 'limit' : 'market';
      try {
        const res = await privateCall('AddOrder', {
          pair, type: side === 'short' ? 'sell' : 'buy', ordertype,
          volume: String(size), ...(ordertype === 'limit' ? { price: String(entry) } : {}),
        });
        return { ok: true, order: { venueOrderId: res.txid?.[0] || null, venue: 'kraken' } };
      } catch (e) { return { ok: false, error: e.message }; }
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
