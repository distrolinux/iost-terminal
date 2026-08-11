// lib/indicators.js — Technical indicator math (no deps)

export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(e);
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

// Wilder RSI, returns { value, prev } (last two RSI points)
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return { value: null, prev: null };
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  const points = [];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    points.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  }
  return { value: points[points.length - 1] ?? null, prev: points[points.length - 2] ?? null };
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macd: null, signal: null, hist: null, prevHist: null, cross: null };
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const n = Math.min(fastE.length, slowE.length);
  const macdLine = [];
  for (let i = 0; i < n; i++) macdLine.push(fastE[fastE.length - n + i] - slowE[slowE.length - n + i]);
  const sigLine = emaSeries(macdLine, signal);
  const m = macdLine[macdLine.length - 1];
  const s = sigLine[sigLine.length - 1];
  const h = m - s;
  const prevH = macdLine[macdLine.length - 2] - sigLine[sigLine.length - 2];
  return {
    macd: m, signal: s, hist: h, prevHist: prevH,
    cross: prevH != null && isFinite(prevH) && isFinite(h)
      ? (prevH <= 0 && h > 0 ? 'bullish' : prevH >= 0 && h < 0 ? 'bearish' : null)
      : null,
  };
}

export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { h, l, c } = candles[i];
    const pc = candles[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export function roc(closes, period = 14) {
  if (closes.length <= period) return 0;
  const prev = closes[closes.length - 1 - period];
  return prev ? ((closes[closes.length - 1] / prev) - 1) * 100 : 0;
}

export function volumeZScore(volumes, period = 20) {
  if (volumes.length < period) return 0;
  const slice = volumes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period) || 1;
  return (volumes[volumes.length - 1] - mean) / std;
}

// Nearest support / resistance from swing pivots (lookback window)
export function supportResistance(candles, window = 40) {
  const highs = [], lows = [];
  const start = Math.max(1, candles.length - window);
  for (let i = start; i < candles.length - 1; i++) {
    const h = candles[i].h, l = candles[i].l;
    const prev = candles[i - 1], next = candles[i + 1];
    if (h > prev.h && h > next.h) highs.push(h);
    if (l < prev.l && l < next.l) lows.push(l);
  }
  const price = candles[candles.length - 1].c;
  const resistance = Math.min(...highs.filter(x => x > price), Infinity);
  const support = Math.max(...lows.filter(x => x < price), -Infinity);
  return {
    support: isFinite(support) ? support : null,
    resistance: isFinite(resistance) ? resistance : null,
  };
}

// Breakout: close beyond the rolling high/low of the previous `lookback` bars, volume-confirmed
export function breakoutCheck(candles, lookback = 20, volZ = 1.2) {
  if (candles.length < lookback + 2) return null;
  const last = candles[candles.length - 1];
  const prior = candles.slice(-(lookback + 1), -1);
  const hi = Math.max(...prior.map(c => c.h));
  const lo = Math.min(...prior.map(c => c.l));
  const vz = volumeZScore(candles.map(c => c.v), lookback);
  if (last.c > hi && vz >= volZ) return { type: 'breakout', level: hi, volZ: vz };
  if (last.c < lo && vz >= volZ) return { type: 'breakdown', level: lo, volZ: vz };
  if (last.c > hi) return { type: 'breakout', level: hi, volZ: vz, weak: true };
  if (last.c < lo) return { type: 'breakdown', level: lo, volZ: vz, weak: true };
  return null;
}

export function maCross(closes, fastP = 20, slowP = 50) {
  if (closes.length < slowP + 2) return null;
  const fast = emaSeries(closes, fastP);
  const slow = emaSeries(closes, slowP);
  const off = fast.length - slow.length;
  const prevF = fast[fast.length - 2], prevS = slow[slow.length - 2 + off];
  const curF = fast[fast.length - 1], curS = slow[slow.length - 1 + off];
  if (prevF <= prevS && curF > curS) return 'golden';
  if (prevF >= prevS && curF < curS) return 'death';
  return curF > curS ? 'bullish' : curF < curS ? 'bearish' : 'neutral';
}

export function normalize(v, lo, hi) {
  if (v == null) return 50;
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}
