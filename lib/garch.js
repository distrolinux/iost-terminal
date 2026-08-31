// lib/garch.js — GARCH(1,1) volatility sizing for the live rail.
//
// Model: Bollerslev GARCH(1,1), variance-targeted, parameters fit by
// grid-search MLE on ~600 daily closes from OKX (no Python/uv dependency).
// Answers "how much", never "which way". Pure JS, fail-soft: any error →
// multiplier 1.0 (no behavior change) — the live rail keeps working as before.
//
// Env:
//   GARCH_ENABLED=1      activate sizing (default off → multiplier 1.0)
//   GARCH_TARGET_VOL     target annualized vol % (default 15, per garch-method skill)
//   GARCH_STORM_CAP      storm-regime multiplier cap (default 0.5)
//   GARCH_TTL_MS         cache TTL (default 6h — it's a daily model)
//
// Refit cadence: the model is refit on first call and every TTL after.
// The walk-forward principle is preserved: the 1-day-ahead forecast uses
// only data available at forecast time (expanding window, no lookahead).

const TTL = Number(process.env.GARCH_TTL_MS || 6 * 3600 * 1000);
// NOTE: read from process.env at CALL time, not module load — server.js loads
// .env after imports are hoisted, so import-time reads see only real env vars.
const ENABLED = () => process.env.GARCH_ENABLED === '1';
const TARGET_VOL = () => Number(process.env.GARCH_TARGET_VOL || 15); // annualized %
const STORM_CAP = () => Number(process.env.GARCH_STORM_CAP || 0.5);
const MIN_DAYS = 510; // skill: ~510 daily observations minimum
const MAX_DAYS = 900;
const MIN_MULT = 0.25, MAX_MULT = 2.0; // skill caps

const cache = new Map(); // symbol -> { ts, state }

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

/** Daily closes from OKX (newest-first pages, oldest-first output). */
async function fetchDailyCloses(symbol) {
  const instId = `${symbol}-USDT`;
  const rows = new Map();
  let after = Date.now() + 1000; // OKX 'after' = return records OLDER than this ts (ms)
  let guard = 0;
  while (rows.size < MIN_DAYS && guard < 6) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=300&after=${after}`;
    const d = await fetchJson(url);
    if (d.code !== '0' || !d.data || !d.data.length) break;
    for (const c of d.data) rows.set(Number(c[0]), Number(c[4])); // ts -> close
    after = Math.min(...rows.keys());
    guard++;
  }
  const closes = [...rows.keys()].sort((a, b) => a - b).map(ts => rows.get(ts));
  if (closes.length < MIN_DAYS) throw new Error(`need ${MIN_DAYS}+ days, got ${closes.length}`);
  return closes.slice(-MAX_DAYS);
}

/** GARCH(1,1) grid-MLE with variance targeting. Returns { alpha, beta, omega }. */
function fitGarch11(returns) {
  const r = returns;
  const n = r.length;
  const mu = r.reduce((a, x) => a + x, 0) / n;
  const centered = r.map(x => x - mu);
  const uncondVar = centered.reduce((a, x) => a + x * x, 0) / (n - 1);
  if (!(uncondVar > 0)) return { alpha: 0.05, beta: 0.9, omega: uncondVar * 0.05 };

  let best = { ll: -Infinity, alpha: 0.05, beta: 0.9 };
  for (let ai = 0; ai <= 10; ai++) {
    const alpha = 0.02 + ai * 0.028; // 0.02..0.30
    for (let bi = 0; bi <= 18; bi++) {
      const beta = 0.60 + bi * 0.02; // 0.60..0.96
      if (alpha + beta >= 1) continue;
      const omega = (1 - alpha - beta) * uncondVar;
      // filter forward
      let varPrev = uncondVar;
      let ll = 0, bad = false;
      for (let i = 0; i < n; i++) {
        const sig2 = omega + alpha * centered[i] * centered[i] + beta * varPrev;
        if (!(sig2 > 1e-20)) { bad = true; break; }
        ll += -0.5 * (Math.log(sig2) + (centered[i] * centered[i]) / sig2);
        varPrev = sig2;
      }
      if (!bad && ll > best.ll) best = { ll, alpha, beta, omega };
    }
  }
  if (!isFinite(best.ll)) return { alpha: 0.05, beta: 0.9, omega: uncondVar * 0.05 };
  return { alpha: best.alpha, beta: best.beta, omega: best.omega };
}

/**
 * Walk-forward GARCH(1,1) — matches the garch-method skill: params are
 * re-estimated every REFIT_DAYS on an expanding window; between refits the
 * recursion rolls forward with the last params. One-day-ahead PREDICTIONS are
 * recorded at every step (never using future data) — the trailing-year
 * prediction series is what the final forecast's percentile is measured
 * against. Zero lookahead throughout.
 */
const REFIT_DAYS = 21; // skill: parameters re-estimated every 21 days

function forecast(closes) {
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0) returns.push(Math.log(closes[i] / prev));
  }
  const n = returns.length;
  const predictions = new Array(n); // 1-day-ahead vol prediction per step
  let sig2 = 0;
  let p = null;
  let mu = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || i % REFIT_DAYS === 0) {
      // expanding window: fit on returns[0..i]
      const window = returns.slice(0, i + 1);
      p = fitGarch11(window);
      mu = window.reduce((a, x) => a + x, 0) / window.length;
      sig2 = p.omega / (1 - p.alpha - p.beta); // long-run start after refit
    }
    // one-step-ahead prediction for step i (uses only data < i)
    predictions[i] = Math.sqrt(Math.max(sig2, 1e-20));
    // roll forward with current params using this step's actual return
    const c = returns[i] - mu;
    sig2 = p.omega + p.alpha * c * c + p.beta * sig2;
  }
  // final 1-day-ahead forecast: the prediction for the NEXT day (n)
  const forecastDaily = Math.sqrt(Math.max(p.omega + p.alpha * (returns[n - 1] - mu) ** 2 + p.beta * sig2, 1e-20));
  // percentile of the final forecast vs the trailing-year prediction series
  const year = predictions.slice(-365).filter(v => v > 0);
  const below = year.filter(v => v < forecastDaily).length;
  const percentile = year.length ? (below / year.length) * 100 : 50;
  const dailyPct = forecastDaily * 100;
  const annualizedPct = dailyPct * Math.sqrt(365);
  const regime = percentile < 25 ? 'calm' : percentile > 75 ? 'storm' : 'normal';
  return { forecastVolDailyPct: dailyPct, forecastVolAnnualizedPct: annualizedPct, volPercentile1y: percentile, regime };
}

function multiplierFor(annualizedPct) {
  if (!(annualizedPct > 0)) return 1;
  const raw = TARGET_VOL() / annualizedPct;
  return Math.min(MAX_MULT, Math.max(MIN_MULT, raw));
}

/** Full state for a symbol. Cached; fail-soft to null state (mult 1). */
export async function getGarchState(symbol) {
  const sym = String(symbol || '').toUpperCase().slice(0, 12);
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.ts < TTL) return hit.state;
  const nullState = { enabled: ENABLED(), symbol: sym, forecastVolDailyPct: null, forecastVolAnnualizedPct: null, volPercentile1y: null, regime: null, multiplier: 1, stormCapped: false, note: 'GARCH forecasts magnitude (volatility), not direction.' };
  if (!ENABLED()) { cache.set(sym, { ts: Date.now(), state: nullState }); return nullState; }
  try {
    const closes = await fetchDailyCloses(sym);
    const f = forecast(closes);
    let mult = multiplierFor(f.forecastVolAnnualizedPct);
    const stormCapped = f.regime === 'storm' && mult > STORM_CAP();
    if (stormCapped) mult = STORM_CAP();
    const state = { enabled: true, symbol: sym, ...f, multiplier: Math.round(mult * 100) / 100, stormCapped, note: 'GARCH forecasts magnitude (volatility), not direction.' };
    cache.set(sym, { ts: Date.now(), state });
    return state;
  } catch (e) {
    // fail-soft: no data / model error → size unchanged, rail untouched
    const errState = { ...nullState, error: e.message };
    cache.set(sym, { ts: Date.now(), state: errState });
    return errState;
  }
}

// Read-only, network-free access for execution preflight. Risk checks may use
// a recent model observation, but must never block on a model refit.
export function peekGarchState(symbol) {
  const sym = String(symbol || '').toUpperCase().slice(0, 12);
  const hit = cache.get(sym);
  if (!hit || Date.now() - hit.ts >= TTL) return null;
  return structuredClone(hit.state);
}

/**
 * Apply GARCH sizing to a proposed size.
 * Returns { size, multiplier, regime, stormCapped } — size unchanged (mult 1)
 * when disabled, unknown symbol, or the model failed.
 */
export async function applyGarchSizing(symbol, size) {
  const num = Number(size);
  if (!(num > 0)) return { size: num, multiplier: 1, regime: null, stormCapped: false };
  const st = await getGarchState(symbol);
  return { size: Math.round(num * st.multiplier * 100) / 100, multiplier: st.multiplier, regime: st.regime, stormCapped: st.stormCapped, state: st };
}

export const garchConfig = { enabled: () => ENABLED(), targetVol: () => TARGET_VOL(), stormCap: () => STORM_CAP(), minMult: MIN_MULT, maxMult: MAX_MULT };
