// lib/probability.js — Probabilistic Clarity engine (v1.4)
// Turns the 0-100 composite into an honest upside probability with a confidence
// interval (shrunk toward 50%), plus human-readable signal drivers and a rolling
// probability timeline for the UI/agent layer.

const CACHE_TTL = { book: 10_000, contract: 3_600_000 };

const cache = new Map();
function getCache(key, ttl) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.val;
  return null;
}
function setCache(key, val) {
  cache.set(key, { ts: Date.now(), val });
}

async function fetchJson(url, timeout = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0]}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// composite (0-100) + 6 subscores → { probUp, ciLo, ciHi, direction, drivers }
export function probabilityOf(score, scanItem = null) {
  if (!score || typeof score.composite !== 'number') return null;
  const s = score.subscores || {};
  const c = score.components || {};
  // honest probability: shrink composite toward 50% (score 66 → 62.8%)
  const probUp = clamp(0.5 + (score.composite - 50) * 0.008);
  // CI width grows with subscore disagreement
  const vals = [s.momentum, s.technical, s.volume, s.news, s.onchain, s.risk].filter(v => typeof v === 'number');
  const mean = vals.reduce((a, v) => a + v, 0) / (vals.length || 1);
  const spread = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length || 1));
  const ciHalf = clamp(4 + spread * 0.25, 2, 15);
  const direction = probUp >= 0.55 ? 'bullish' : probUp <= 0.45 ? 'bearish' : 'neutral';

  const drivers = [];
  const a = scanItem || {};
  if (typeof c.volZ === 'number' && c.volZ >= 2) drivers.push(`Volume spike (z=${c.volZ.toFixed(1)})`);
  if (typeof c.rsi === 'number' && c.rsi <= 30) drivers.push(`RSI oversold (${c.rsi.toFixed(0)})`);
  else if (typeof c.rsi === 'number' && c.rsi >= 70) drivers.push(`RSI overbought (${c.rsi.toFixed(0)})`);
  else if ((s.momentum || 0) >= 75) drivers.push(`Strong momentum (RSI ${c.rsi != null ? c.rsi.toFixed(0) : '—'})`);
  if (c.maState === 'golden') drivers.push('Golden MA cross');
  else if (c.maState === 'death') drivers.push('Death cross');
  if ((a.whale?.bigTrades24h || 0) > 0) drivers.push(`Whale activity (${a.whale.bigTrades24h} big trades)`);
  if ((s.news || 0) >= 70) drivers.push('Positive news flow');
  else if ((s.news || 0) <= 30) drivers.push('Negative news flow');
  if (typeof c.support === 'number' && typeof score.price === 'number' && c.support > 0 && score.price / c.support - 1 < 0.02) drivers.push('At support');
  if (typeof c.resistance === 'number' && typeof score.price === 'number' && c.resistance / score.price - 1 < 0.02) drivers.push('At resistance');
  if ((s.risk || 0) >= 80) drivers.push('Low-risk setup');
  else if ((s.risk || 0) <= 35) drivers.push('High-risk setup');
  if (typeof c.atrPct === 'number' && c.atrPct >= 4) drivers.push(`Elevated volatility (ATR ${c.atrPct.toFixed(1)}%)`);

  return {
    symbol: score.symbol,
    price: score.price,
    probUp: +probUp.toFixed(3),
    ciLo: +clamp(probUp - ciHalf / 100, 0.01, 0.99).toFixed(3),
    ciHi: +clamp(probUp + ciHalf / 100, 0.01, 0.99).toFixed(3),
    direction,
    drivers: drivers.slice(0, 3),
  };
}

// ---------- rolling probability timeline (per symbol, capped) ----------
const MAX_SAMPLES = 90;
const history = new Map();
export function recordProbability(sym, prob) {
  if (!prob) return;
  const arr = history.get(sym) || [];
  const last = arr[arr.length - 1];
  if (last && Date.now() - last.t < 20_000) arr[arr.length - 1] = { t: Date.now(), ...prob }; // in-place refresh
  else arr.push({ t: Date.now(), probUp: prob.probUp, ciLo: prob.ciLo, ciHi: prob.ciHi });
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
  history.set(sym, arr);
}
export function getProbHistory(sym) {
  return (history.get(sym) || []).slice(-MAX_SAMPLES);
}

// ---------- L3: order book depth (OKX, crypto only) ----------
export async function getOrderBook(symbol, depth = 12) {
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return null;
  const key = `book:${symbol}`;
  const hit = getCache(key, CACHE_TTL.book);
  if (hit) return hit;
  try {
    const d = await fetchJson(`https://www.okx.com/api/v5/market/books?instId=${symbol}-USDT&sz=${depth}`);
    if (d.code !== '0' || !d.data?.[0]) throw new Error(`OKX books ${symbol}`);
    const b = d.data[0];
    const out = {
      symbol, exchange: 'OKX', ts: Date.now(),
      bids: (b.bids || []).slice(0, depth).map(x => ({ price: +x[0], size: +x[1] })),
      asks: (b.asks || []).slice(0, depth).map(x => ({ price: +x[0], size: +x[1] })),
    };
    setCache(key, out);
    return out;
  } catch { return null; }
}

// ---------- L3: contract specification (OKX SPOT instruments) ----------
export async function getContractSpec(symbol) {
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return null;
  const key = `contract:${symbol}`;
  const hit = getCache(key, CACHE_TTL.contract);
  if (hit) return hit;
  try {
    const d = await fetchJson(`https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=${symbol}-USDT`);
    if (d.code !== '0' || !d.data?.[0]) throw new Error(`OKX instruments ${symbol}`);
    const i = d.data[0];
    const out = {
      symbol, exchange: 'OKX', instId: i.instId, baseCcy: i.baseCcy, quoteCcy: i.quoteCcy,
      tickSz: i.tickSz, lotSz: i.lotSz, minSz: i.minSz, state: i.state, ts: Date.now(),
    };
    setCache(key, out);
    return out;
  } catch { return null; }
}
