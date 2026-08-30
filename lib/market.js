// lib/market.js — Multi-source market data layer
// Crypto: OKX (primary) → KuCoin → Gate.io failover
// Stocks: Yahoo Finance chart API (delayed) → FMP demo fallback
// All requests time-boxed; results cached in-memory with TTLs.

const CACHE_TTL = { ticker: 10_000, klines: 45_000, trades: 15_000 };

const cache = new Map();
function getCache(key, ttl) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.val;
  return null;
}
function setCache(key, val) {
  cache.set(key, { ts: Date.now(), val });
}

// Read the server's latest observed ticker without triggering a network call.
// Execution receipts use this to report honest quote freshness and explicitly
// say when no observation was available at decision time.
export function peekTicker(symbol, now = Date.now()) {
  const hit = cache.get(`t:${String(symbol || '').toUpperCase()}`);
  if (!hit?.val) return null;
  return {
    ...structuredClone(hit.val),
    observedAt: hit.ts,
    ageMs: Math.max(0, now - hit.ts),
    fresh: now - hit.ts < CACHE_TTL.ticker,
  };
}

async function fetchJson(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 9000);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} from ${url.split('?')[0]}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- symbol mapping ----------
const CRYPTO = [
  'IOST', 'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX',
  'LINK', 'DOT', 'SUI', 'ARB', 'OP', 'TON', 'NEAR', 'LTC',
];
const STOCKS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'SPY', 'QQQ'];
const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };

function okxInst(sym) { return `${sym}-USDT`; }
function gatePair(sym) { return `${sym}_USDT`; }

// ---------- OKX ----------
async function okxTicker(sym) {
  const d = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${okxInst(sym)}`);
  if (d.code !== '0' || !d.data?.[0]) throw new Error(`OKX ticker ${sym}`);
  const t = d.data[0];
  return {
    symbol: sym, source: 'OKX', last: +t.last, ask: +t.askPx, bid: +t.bidPx,
    open24h: +t.open24h, high24h: +t.high24h, low24h: +t.low24h,
    vol24h: +t.volCcy24h, volQuote24h: +t.volCcyQuote24h,
    change24hPct: t.open24h ? (+t.last / +t.open24h - 1) * 100 : 0, ts: +t.ts,
  };
}

async function okxKlines(sym, bar, limit = 300) {
  const b = OKX_BAR[bar] || '15m';
  const d = await fetchJson(
    `https://www.okx.com/api/v5/market/candles?instId=${okxInst(sym)}&bar=${b}&limit=${Math.min(limit, 300)}`);
  if (d.code !== '0' || !d.data) throw new Error(`OKX candles ${sym}`);
  return d.data.reverse().map(c => ({
    ts: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5],
  }));
}

async function okxTrades(sym, limit = 100) {
  const d = await fetchJson(`https://www.okx.com/api/v5/market/trades?instId=${okxInst(sym)}&limit=${limit}`);
  if (d.code !== '0' || !d.data) throw new Error(`OKX trades ${sym}`);
  return d.data.map(t => ({ ts: +t.ts, price: +t.px, size: +t.sz, side: t.side, source: 'OKX' }));
}

// ---------- KuCoin (failover) ----------
async function kcTicker(sym) {
  const d = await fetchJson(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${okxInst(sym)}`);
  if (d.code !== '200000' || !d.data) throw new Error(`KC ticker ${sym}`);
  const price = +d.data.price;
  const stats = await fetchJson(`https://api.kucoin.com/api/v1/market/stats?symbol=${okxInst(sym)}`)
    .catch(() => null);
  const s = stats?.data || {};
  return {
    symbol: sym, source: 'KuCoin', last: price, ask: +d.data.bestAsk || price,
    bid: +d.data.bestBid || price, open24h: +s.open || price, high24h: +s.high || price,
    low24h: +s.low || price, vol24h: +s.volValue || 0, volQuote24h: +s.volValue || 0,
    change24hPct: s.open ? (price / +s.open - 1) * 100 : 0, ts: Date.now(),
  };
}

async function kcKlines(sym, bar, limit = 300) {
  const map = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1hour', '4h': '4hour', '1d': '1day' };
  const d = await fetchJson(
    `https://api.kucoin.com/api/v1/market/candles?type=${map[bar] || '15min'}&symbol=${okxInst(sym)}&limit=${Math.min(limit, 300)}`);
  if (d.code !== '200000' || !d.data) throw new Error(`KC candles ${sym}`);
  return d.data.reverse().map(c => ({ ts: +c[0], o: +c[1], c: +c[2], h: +c[3], l: +c[4], v: +c[5] }));
}

// ---------- Gate.io (failover) ----------
async function gateTicker(sym) {
  const d = await fetchJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${gatePair(sym)}`);
  if (!d?.[0]) throw new Error(`Gate ticker ${sym}`);
  const t = d[0];
  return {
    symbol: sym, source: 'Gate', last: +t.last, ask: +t.lowest_ask || +t.last,
    bid: +t.highest_bid || +t.last, open24h: +t.last / (1 + (+t.change_percentage / 100)),
    high24h: +t.high_24h, low24h: +t.low_24h, vol24h: +t.base_volume, volQuote24h: +t.quote_volume,
    change24hPct: +t.change_percentage, ts: Date.now(),
  };
}

// ---------- Stocks ----------
async function yahooQuote(sym) {
  const d = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1mo&interval=1d`, { timeout: 12000 });
  const r = d?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo ${sym}`);
  const q = r.indicators.quote[0];
  const closes = q.close.filter(v => v != null);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const high24h = Math.max(...q.high.filter(v => v != null).slice(-2));
  const low24h = Math.min(...q.low.filter(v => v != null).slice(-2));
  return {
    symbol: sym, source: 'Yahoo', last, ask: last, bid: last, open24h: prev,
    high24h, low24h, vol24h: q.volume[q.volume.length - 1] || 0,
    volQuote24h: 0, change24hPct: prev ? (last / prev - 1) * 100 : 0, ts: Date.now(),
  };
}

async function yahooKlines(sym, bar, limit = 300) {
  const rangeMap = { '1d': '1y', '4h': '6mo', '1h': '3mo', '15m': '1mo', '5m': '5d', '1m': '1d' };
  const range = rangeMap[bar] || '3mo';
  const intervalMap = { '1d': '1d', '4h': '1d', '1h': '60m', '15m': '15m', '5m': '5m', '1m': '1m' };
  const d = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${intervalMap[bar] || '1d'}`,
    { timeout: 12000 });
  const r = d?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo klines ${sym}`);
  const q = r.indicators.quote[0];
  return r.timestamp.map((ts, i) => ({
    ts: ts * 1000, o: q.open[i] ?? q.close[i], h: q.high[i] ?? q.close[i],
    l: q.low[i] ?? q.close[i], c: q.close[i], v: q.volume[i] || 0,
  })).filter(k => k.c != null);
}

async function fmpFallbackQuote(sym) {
  const d = await fetchJson(`https://financialmodelingprep.com/api/v3/quote/${sym}?apikey=demo`);
  if (!d?.[0]) throw new Error(`FMP ${sym}`);
  const q = d[0];
  return {
    symbol: sym, source: 'FMP', last: q.price, ask: q.price, bid: q.price,
    open24h: q.open, high24h: q.dayHigh, low24h: q.dayLow,
    vol24h: q.volume || 0, volQuote24h: 0, change24hPct: q.changesPercentage || 0, ts: Date.now(),
  };
}

// ---------- public facade ----------
export async function getTicker(symbol) {
  const key = `t:${symbol}`;
  const hit = getCache(key, CACHE_TTL.ticker);
  if (hit) return hit;
  const isStock = STOCKS.includes(symbol);
  let ticker = null;
  const attempts = isStock
    ? [() => yahooQuote(symbol), () => fmpFallbackQuote(symbol)]
    : [() => okxTicker(symbol), () => kcTicker(symbol), () => gateTicker(symbol)];
  for (const fn of attempts) {
    try { ticker = await fn(); break; } catch { /* next source */ }
  }
  if (!ticker) throw new Error(`No data source for ${symbol}`);
  setCache(key, ticker);
  return ticker;
}

export async function getKlines(symbol, bar = '15m', limit = 300) {
  const key = `k:${symbol}:${bar}:${limit}`;
  const hit = getCache(key, CACHE_TTL.klines);
  if (hit) return hit;
  const isStock = STOCKS.includes(symbol);
  let klines = null;
  const attempts = isStock
    ? [() => yahooKlines(symbol, bar, limit)]
    : [() => okxKlines(symbol, bar, limit), () => kcKlines(symbol, bar, limit)];
  for (const fn of attempts) {
    try { klines = await fn(); break; } catch { /* next source */ }
  }
  if (!klines) throw new Error(`No klines for ${symbol}`);
  setCache(key, klines);
  return klines;
}

export async function getTrades(symbol, limit = 100) {
  const key = `trades:${symbol}`;
  const hit = getCache(key, CACHE_TTL.trades);
  if (hit) return hit;
  let trades = null;
  const attempts = [
    () => okxTrades(symbol, limit),
    async () => {
      const d = await fetchJson(`https://api.gateio.ws/api/v4/spot/trades?currency_pair=${gatePair(symbol)}&limit=${limit}`);
      return d.map(t => ({ ts: +t.create_time * 1000, price: +t.price, size: +t.amount, side: t.side, source: 'Gate' }));
    },
  ];
  for (const fn of attempts) {
    try { trades = await fn(); break; } catch { /* next source */ }
  }
  if (!trades) throw new Error(`No trades for ${symbol}`);
  setCache(key, trades);
  return trades;
}

export const WATCHLIST = { crypto: CRYPTO, stocks: STOCKS };
