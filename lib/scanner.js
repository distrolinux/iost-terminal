// lib/scanner.js — AI Market Scanner: per-symbol technical + whale analysis
import { getKlines, getTicker, getTrades, WATCHLIST } from './market.js';
import {
  sma, ema, rsi, macd, atr, roc, volumeZScore, supportResistance, breakoutCheck, maCross,
} from './indicators.js';

const WHALE_USD = 25000;          // hard whale threshold (crypto)
const WHALE_MULT = 12;            // or 12x median trade size
const SCAN_TTL = 20_000;
const scanCache = new Map();
let scanAllCache = { ts: 0, val: null };

function med(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function analyzeSymbol(symbol, opts = {}) {
  const type = WATCHLIST.stocks.includes(symbol) ? 'stock' : 'crypto';
  const intradayBar = type === 'crypto' ? '15m' : '1d';
  const cacheKey = `${symbol}:${intradayBar}`;
  const hit = scanCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < SCAN_TTL && !opts.force) return hit.val;

  const [ticker, k15, k1d] = await Promise.all([
    getTicker(symbol).catch(() => null),
    getKlines(symbol, intradayBar, 300).catch(() => null),
    getKlines(symbol, '1d', 300).catch(() => null),
  ]);
  if (!ticker || !k15) throw new Error(`No data for ${symbol}`);

  const closes = k15.map(c => c.c);
  const vols = k15.map(c => c.v);
  const price = ticker.last ?? closes[closes.length - 1];
  const r = rsi(closes, 14);
  const m = macd(closes, 12, 26, 9);
  const atrV = atr(k15, 14);
  const atrPct = atrV && price ? (atrV / price) * 100 : null;
  const vz = volumeZScore(vols, 20);
  const sr = supportResistance(k15, 40);
  const bk = breakoutCheck(k15, 20);
  const cross = maCross(closes, 20, 50);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const roc15m = roc(closes, 14);
  const d1 = k1d.length ? {
    rsi: rsi(k1d.map(c => c.c), 14).value,
    sma50: sma(k1d.map(c => c.c), 50),
    sma200: sma(k1d.map(c => c.c), 200),
    roc: roc(k1d.map(c => c.c), 30),
  } : null;

  // ---- whale / large-wallet activity ----
  const whale = { alerts: [], bigTrades24h: 0, largestUsd: 0 };
  if (type === 'crypto') {
    try {
      const trades = await getTrades(symbol, 150);
      const sizesUsd = trades.map(t => t.price * t.size);
      const m = med(sizesUsd);
      for (const t of trades) {
        const usd = t.price * t.size;
        whale.largestUsd = Math.max(whale.largestUsd, usd);
        if (usd >= WHALE_USD || (m > 0 && usd >= WHALE_MULT * m)) {
          whale.alerts.push({ ts: t.ts, price: t.price, size: t.size, usd: Math.round(usd), side: t.side, source: t.source || '' });
        }
      }
      whale.bigTrades24h = whale.alerts.length;
    } catch { /* whale data optional */ }
  }

  // ---- signal assembly ----
  const signals = [];
  const add = (label, direction, weight, detail = '') =>
    signals.push({ label, direction, weight, detail });

  if (vz >= 2) add('Unusual volume', 'bullish', 3, `vol z-score ${vz.toFixed(1)}`);
  else if (vz >= 1.2) add('Elevated volume', 'bullish', 2, `vol z-score ${vz.toFixed(1)}`);
  else if (vz <= -1) add('Volume drying up', 'bearish', 1, `vol z-score ${vz.toFixed(1)}`);

  if (bk) {
    add(bk.type === 'breakout' ? 'Breakout' : 'Breakdown', bk.type === 'breakout' ? 'bullish' : 'bearish',
      bk.weak ? 2 : 3, `past ${bk.level?.toPrecision(6) ?? ''}${bk.weak ? ' (weak)' : ''}`);
  }

  if (r.value != null) {
    if (r.value >= 70) add('RSI overbought', 'bearish', 1, `RSI ${r.value.toFixed(1)}`);
    else if (r.value <= 30) add('RSI oversold', 'bullish', 2, `RSI ${r.value.toFixed(1)}`);
    else if (r.value > r.prev) add('RSI rising', 'bullish', 1, `RSI ${r.value.toFixed(1)}`);
    else add('RSI falling', 'bearish', 1, `RSI ${r.value.toFixed(1)}`);
  }

  if (m.cross) add(`MACD ${m.cross} cross`, m.cross === 'bullish' ? 'bullish' : 'bearish', 3, `hist ${m.hist.toFixed(8)}`);

  if (cross === 'golden') add('Golden cross (20/50)', 'bullish', 3, 'EMA20 crossed above EMA50');
  else if (cross === 'death') add('Death cross (20/50)', 'bearish', 3, 'EMA20 crossed below EMA50');
  else add(cross === 'bullish' ? 'MA trend up (20>50)' : 'MA trend down (20<50)', cross === 'bullish' ? 'bullish' : 'bearish', 1);

  if (sr.support != null && price / sr.support - 1 < 0.015)
    add('At support', 'bullish', 2, `S @ ${sr.support.toPrecision(6)}`);
  if (sr.resistance != null && sr.resistance / price - 1 < 0.015)
    add('At resistance', 'bearish', 2, `R @ ${sr.resistance.toPrecision(6)}`);

  if (atrPct != null) {
    if (atrPct >= 4 && type === 'crypto') add('High volatility', 'neutral', 1, `ATR ${atrPct.toFixed(1)}%`);
    else if (atrPct >= 2 && type === 'stock') add('High volatility', 'neutral', 1, `ATR ${atrPct.toFixed(1)}%`);
    else if (atrPct <= 1) add('Low volatility', 'neutral', 1, `ATR ${atrPct.toFixed(1)}%`);
  }

  if (d1) {
    if (d1.rsi != null && d1.rsi >= 65) add('Daily RSI hot', 'neutral', 1, `D1 RSI ${d1.rsi.toFixed(1)}`);
    if (d1.sma50 != null && price > d1.sma50 && d1.sma200 != null && price > d1.sma200)
      add('Above 50/200 D1', 'bullish', 2, 'Long-term uptrend');
    if (d1.sma200 != null && price < d1.sma200) add('Below 200 D1', 'bearish', 2, 'Long-term downtrend');
  }

  const bull = signals.filter(s => s.direction === 'bullish').reduce((a, s) => a + s.weight, 0);
  const bear = signals.filter(s => s.direction === 'bearish').reduce((a, s) => a + s.weight, 0);
  const bias = bull - bear;

  const analysis = {
    symbol, type, price, source: ticker.source, ts: Date.now(),
    change24hPct: ticker.change24hPct, high24h: ticker.high24h, low24h: ticker.low24h,
    vol24hQuote: ticker.volQuote24h || ticker.vol24h * price,
    indicators: {
      rsi: r.value, rsiPrev: r.prev, macdHist: m.hist, macdSignal: m.signal,
      atrPct, volZ: vz, sma20, sma50, sma200, roc15m,
      support: sr.support, resistance: sr.resistance,
      maState: cross, d1: d1 && { rsi: d1.rsi, roc: d1.roc, above50: d1.sma50 != null && price > d1.sma50 },
    },
    signals, whale,
    bias, // positive = net bullish
    biasLabel: bias >= 3 ? 'Strong bullish' : bias >= 1 ? 'Bullish' : bias <= -3 ? 'Strong bearish' : bias <= -1 ? 'Bearish' : 'Neutral',
  };
  scanCache.set(cacheKey, { ts: Date.now(), val: analysis });
  return analysis;
}

export async function scanAll(opts = {}) {
  if (scanAllCache.val && Date.now() - scanAllCache.ts < SCAN_TTL && !opts.force) return scanAllCache.val;
  const symbols = [...WATCHLIST.crypto, ...WATCHLIST.stocks];
  const results = [];
  for (const sym of symbols) {
    try { results.push(await analyzeSymbol(sym)); } catch { /* skip unreachable */ }
  }
  const sorted = results.sort((a, b) => (b.bias - a.bias) || (b.change24hPct - a.change24hPct));
  scanAllCache = { ts: Date.now(), val: sorted };
  return sorted;
}
