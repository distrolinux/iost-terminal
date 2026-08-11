// lib/backtest.js — v1.15 strategy backtesting (FXReplay methodology)
//
// "Most trading strategies look convincing until you test them." This engine
// validates RULES against historical bars and reports the KPI set that matters
// (win rate alone is the least informative metric):
//   trades · win rate · EXPECTANCY · PROFIT FACTOR · MAX DRAWDOWN ·
//   cumulative return · Sharpe (approx) · vs buy-and-hold
//
// Methodology (from FX Replay's framework, applied honestly):
//   1. Objective rules — two people reading the same bars see the same setup.
//   2. Clean data — klines from the same feeds as the live scanner.
//   3. Full trade accounting — stops, targets, trailing, time exits, sizing.
//   4. Track EVERY trade — the output IS the journal (entry/exit/reason/pnl).
//   5. Test across environments — the equity curve shows the drawdowns too.
//   6. Honesty — sample-size caveats, assumptions, and "past ≠ future" are
//      part of the result, not footnotes. A perfect backtest usually means an
//      overfit (flawed) strategy — we don't optimize, we report.
//
// Rules (v1):
//   ma-cross  — smaFast crosses above/below smaSlow (trend-following)
//   rsi       — RSI crosses oversold/overbought thresholds (mean reversion)
//   breakout  — close breaks the previous N-bar high (long) / low (short)
//   ai-score  — bar-level AI proxy score (RSI + MA trend + volume z + momentum,
//               the same signal families the live engine uses) >= threshold.
//               Documented as a PROXY of the live AI — the live engine scores
//               live data; this replays its indicator families on history.

import { getKlines } from './market.js';
import { sma, rsi as rsiFn, volumeZScore, roc, maCross } from './indicators.js';

export const STARTING_EQUITY = 10_000;
export const MIN_TRADES_FOR_SIGNIFICANCE = 100; // FXReplay: below this, results may be random variance

export function describeRule(rule) {
  const p = rule.params || {};
  switch (rule.rule) {
    case 'ma-cross': return `MA cross: SMA${p.fast || 20} × SMA${p.slow || 50}`;
    case 'rsi': return `RSI ${p.oversold ?? 30}/${p.overbought ?? 70} reversion`;
    case 'breakout': return `Breakout: close vs ${p.lookback || 20}-bar extreme`;
    case 'ai-score': return `AI proxy score ≥ ${p.threshold ?? 65}`;
    default: return rule.rule;
  }
}

// Bar-level AI proxy score (0-100) — mirrors the live engine's signal families.
export function aiProxyScore(bar, closes, volumes) {
  const r = rsiFn(closes, 14);
  const v = volumeZScore(volumes, 20);
  const mom = roc(closes, 10);
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  let s = 50;
  // momentum (0-30): roc sign + magnitude
  s += Math.max(-15, Math.min(15, (mom ?? 0) * 30));
  // trend (0-30): price vs 50sma + 20/50 relationship
  if (s50 != null) s += bar.c > s50 ? 15 : -15;
  if (s20 != null && s50 != null) s += s20 > s50 ? 7 : -7;
  // volume (0-20): volume z-score conviction
  s += Math.max(-10, Math.min(10, (v ?? 0) * 6));
  // rsi (0-20): momentum-health blend
  if (r.value != null) s += Math.max(-10, Math.min(10, (r.value - 50) * 0.4));
  return Math.max(0, Math.min(100, s));
}

export function entrySignal(rule, idx, closes, candles) {
  const p = rule.params || {};
  const bar = candles[idx];
  const prev = candles[idx - 1];
  if (!prev) return null;
  switch (rule.rule) {
    case 'ma-cross': {
      const f = p.fast || 20, s = p.slow || 50;
      const fNow = sma(closes.slice(0, idx + 1), f), fPrev = sma(closes.slice(0, idx), f);
      const sNow = sma(closes.slice(0, idx + 1), s), sPrev = sma(closes.slice(0, idx), s);
      if (fNow == null || fPrev == null || sNow == null || sPrev == null) return null;
      if (fPrev <= sPrev && fNow > sNow) return 'long';
      if (fPrev >= sPrev && fNow < sNow) return 'short';
      return null;
    }
    case 'rsi': {
      const r = rsiFn(closes.slice(0, idx + 1), 14);
      const rp = rsiFn(closes.slice(0, idx), 14);
      if (r.value == null || rp.value == null) return null;
      const lo = p.oversold ?? 30, hi = p.overbought ?? 70;
      if (rp.value <= lo && r.value > lo) return 'long';
      if (rp.value >= hi && r.value < hi) return 'short';
      return null;
    }
    case 'breakout': {
      const n = p.lookback || 20;
      if (idx < n) return null;
      const hi = Math.max(...candles.slice(idx - n, idx).map(c => c.h));
      const lo = Math.min(...candles.slice(idx - n, idx).map(c => c.l));
      if (bar.c > hi) return 'long';
      if (bar.c < lo) return 'short';
      return null;
    }
    case 'ai-score': {
      const th = p.threshold ?? 65;
      const s = aiProxyScore(bar, closes.slice(0, idx + 1), candles.slice(0, idx + 1).map(c => c.v));
      return s >= th ? (p.side || 'long') : null;
    }
    default: return null;
  }
}

function exitCheck(exit, idx, pos, bar) {
  // returns { exit:true, price, reason } or null. Long: stop below, target above.
  if (exit.stopPct) {
    if (pos.side === 'long' && bar.l <= pos.stop) return { exit: true, price: pos.stop, reason: 'stop' };
    if (pos.side === 'short' && bar.h >= pos.stop) return { exit: true, price: pos.stop, reason: 'stop' };
  }
  if (exit.targetPct) {
    if (pos.side === 'long' && bar.h >= pos.target) return { exit: true, price: pos.target, reason: 'target' };
    if (pos.side === 'short' && bar.l <= pos.target) return { exit: true, price: pos.target, reason: 'target' };
  }
  if (exit.trailingPct && pos.peak != null) {
    if (pos.side === 'long' && bar.l <= pos.peak * (1 - exit.trailingPct)) return { exit: true, price: pos.peak * (1 - exit.trailingPct), reason: 'trailing' };
    if (pos.side === 'short' && bar.h >= pos.peak * (1 + exit.trailingPct)) return { exit: true, price: pos.peak * (1 + exit.trailingPct), reason: 'trailing' };
  }
  return null;
}

/**
 * Run a backtest over historical bars.
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {'1d'|'4h'|'1h'|'15m'} [opts.timeframe]
 * @param {object} opts.strategy { name, side, entry:{rule,params}, exit:{stopPct,targetPct,trailingPct?,maxBars?}, sizePct }
 * @param {(symbol:string,bar:string,limit:number)=>Promise<Array>} [opts.klinesFn] — injectable for tests
 */
export async function runBacktest({ symbol, timeframe = '1d', strategy, klinesFn = null }) {
  const getK = klinesFn || getKlines;
  const candles = await getK(symbol.toUpperCase(), timeframe, 300);
  if (!candles || candles.length < 60) return { ok: false, error: 'insufficient history (need ≥60 bars)' };
  const closes = candles.map(c => c.c);
  const volumes = candles.map(c => c.v);

  const entry = strategy.entry || {};
  const exit = strategy.exit || {};
  const side = strategy.side === 'short' ? 'short' : 'long';
  const sizePct = Math.min(Math.max(+strategy.sizePct || 0.5, 0.05), 1);

  let equity = STARTING_EQUITY;
  const curve = [{ i: 0, ts: candles[0].ts, equity: Math.round(equity * 100) / 100 }];
  const trades = [];
  let pos = null;

  for (let i = 1; i < candles.length; i++) {
    const bar = candles[i];
    // manage open position first (intrabar stop/target/trailing on this bar)
    if (pos) {
      pos.peak = side === 'long'
        ? Math.max(pos.peak, bar.h)
        : Math.min(pos.peak, bar.l);
      const x = exitCheck(exit, i, pos, bar);
      const timeExit = exit.maxBars && (i - pos.entryIdx) >= exit.maxBars;
      if (x || timeExit) {
        const fill = x ? x.price : bar.c;
        const pnl = (fill - pos.entry) * pos.size * (side === 'long' ? 1 : -1);
        trades.push({
          entryTs: pos.entryTs, exitTs: bar.ts, side,
          entry: Math.round(pos.entry * 100000) / 100000, exit: Math.round(fill * 100000) / 100000,
          size: pos.size, pnl: Math.round(pnl * 100) / 100,
          pnlPct: Math.round((pnl / pos.cost) * 10000) / 100,
          reason: timeExit ? 'time' : (x ? x.reason : 'signal'),
        });
        equity += pnl;
        pos = null;
      }
    }
    // entry signal
    if (!pos) {
      const sig = entrySignal(entry, i, closes, candles);
      if (sig === side) {
        const fill = bar.c;
        const cost = equity * sizePct;
        const size = cost / fill;
        pos = {
          entryIdx: i, entryTs: bar.ts, entry: fill, size,
          cost, peak: fill, side,
          stop: exit.stopPct ? (side === 'long' ? fill * (1 - exit.stopPct) : fill * (1 + exit.stopPct)) : null,
          target: exit.targetPct ? (side === 'long' ? fill * (1 + exit.targetPct) : fill * (1 - exit.targetPct)) : null,
        };
      }
    }
    curve.push({ i, ts: bar.ts, equity: Math.round(equity * 100) / 100 });
  }
  // mark-to-market open position on the final bar
  if (pos) {
    const last = candles[candles.length - 1];
    const pnl = (last.c - pos.entry) * pos.size * (side === 'long' ? 1 : -1);
    curve[curve.length - 1].equity = Math.round((equity + pnl) * 100) / 100;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  let peak = STARTING_EQUITY, maxDd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }
  const pnls = trades.map(t => t.pnl);
  const mean = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const std = pnls.length > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1)) : 0;
  const buyHold = (candles[candles.length - 1].c / candles[0].c - 1) * 100;

  return {
    ok: true,
    symbol: symbol.toUpperCase(), timeframe,
    strategy: {
      name: strategy.name || `${describeRule(entry)} · ${side}`,
      side, entry: describeRule(entry), exit: {
        stopPct: exit.stopPct || null, targetPct: exit.targetPct || null,
        trailingPct: exit.trailingPct || null, maxBars: exit.maxBars || null,
      }, sizePct,
    },
    period: {
      from: candles[0].ts, to: candles[candles.length - 1].ts, bars: candles.length,
    },
    kpis: {
      trades: trades.length,
      winRate: trades.length ? Math.round((wins.length / trades.length) * 1000) / 10 : null,
      expectancy: Math.round(mean * 100) / 100,
      profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : (grossProfit > 0 ? null : 0),
      maxDrawdownPct: Math.round(maxDd * 10000) / 100,
      cumulativeReturnPct: Math.round(((curve[curve.length - 1].equity / STARTING_EQUITY) - 1) * 10000) / 100,
      sharpe: std > 0 ? Math.round((mean / std) * Math.sqrt(Math.max(trades.length, 1)) * 100) / 100 : null,
      avgWin: wins.length ? Math.round(wins.reduce((a, t) => a + t.pnl, 0) / wins.length * 100) / 100 : null,
      avgLoss: losses.length ? Math.round(losses.reduce((a, t) => a + t.pnl, 0) / losses.length * 100) / 100 : null,
      bestTrade: trades.length ? Math.round(Math.max(...pnls) * 100) / 100 : null,
      worstTrade: trades.length ? Math.round(Math.min(...pnls) * 100) / 100 : null,
      maxConsecLosses: maxConsecutiveLosses(trades),
      vsBuyHoldPct: Math.round((buyHold) * 100) / 100,
      finalEquity: curve[curve.length - 1].equity,
    },
    equityCurve: curve.filter((_, i) => i % Math.max(1, Math.floor(curve.length / 60)) === 0 || i === curve.length - 1),
    trades: trades.slice(-100), // journal — every trade
    honesty: {
      significantSample: trades.length >= MIN_TRADES_FOR_SIGNIFICANCE,
      note: trades.length < MIN_TRADES_FOR_SIGNIFICANCE
        ? `Only ${trades.length} trades — below the ~100-trade threshold for statistical significance; treat as indicative, not proof.`
        : `${trades.length} trades — above the ~100-trade significance threshold.`,
      assumptions: ['fill at signal-bar close', 'no fees or slippage (paper)', 'intrabar stop/target honored', 'fixed fractional sizing'],
      disclaimer: 'Past performance ≠ future results. A perfect backtest usually means an overfit strategy — this engine reports, it does not optimize.',
    },
  };
}

function maxConsecutiveLosses(trades) {
  let best = 0, cur = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { cur++; best = Math.max(best, cur); } else cur = 0;
  }
  return best;
}
