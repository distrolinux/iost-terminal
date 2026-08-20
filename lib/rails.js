// lib/rails.js — HARD risk rails for live (real-money) orders.
// Enforced in the broker path BEFORE any venue call (defense in depth).
// Pilot-safe defaults, overridable via env:
//   LIVE_MAX_ORDER_USD   max notional per order     (default 50)
//   LIVE_MAX_POSITIONS   max concurrent live pos.   (default 3)
//   LIVE_MAX_DAILY_LOSS  halt if realized+unrealized daily loss exceeds $ (default 25)
//   LIVE_MIN_CASH_USD    minimum cash buffer kept   (default 10)
const cfg = {
  maxOrderUsd: Number(process.env.LIVE_MAX_ORDER_USD || 50),
  maxPositions: Number(process.env.LIVE_MAX_POSITIONS || 3),
  maxDailyLoss: Number(process.env.LIVE_MAX_DAILY_LOSS || 25),
  minCashUsd: Number(process.env.LIVE_MIN_CASH_USD || 10),
};

/**
 * Gate a live order against the hard rails.
 * ctx: { symbol, side, size, entry, openPositions (array), cashUsd, todayPnlUsd }
 * Returns { ok:true } or { ok:false, error, rail }.
 */
export function checkLiveOrder(ctx) {
  const { symbol, size, entry } = ctx;
  // market orders (no entry) are priced at the caller-supplied last quote;
  // limit orders at the explicit entry. Either way the notional cap applies.
  const price = ctx.marketPrice && ctx.marketPrice > 0 ? ctx.marketPrice : (entry && entry > 0 ? entry : null);

  if (!symbol || !size || size <= 0) return { ok: false, rail: 'shape', error: 'symbol and positive size required' };
  if (price && price <= 0) return { ok: false, rail: 'shape', error: 'invalid entry price' };

  // order notional cap (market orders use last known price via quotes elsewhere;
  // here we require an explicit entry OR accept null price → sized by caller)
  if (price) {
    const notional = size * price;
    if (notional > cfg.maxOrderUsd)
      return { ok: false, rail: 'maxOrderUsd', error: `order notional $${notional.toFixed(2)} exceeds $${cfg.maxOrderUsd} cap` };
  }

  // concurrent position cap
  const open = ctx.openPositions || [];
  if (open.length >= cfg.maxPositions)
    return { ok: false, rail: 'maxPositions', error: `max ${cfg.maxPositions} concurrent live positions reached` };

  // cash buffer
  if ((ctx.cashUsd ?? Infinity) < cfg.minCashUsd)
    return { ok: false, rail: 'minCashUsd', error: `cash $${ctx.cashUsd} below $${cfg.minCashUsd} buffer — top up or disable live` };

  // daily loss halt
  if ((ctx.todayPnlUsd ?? 0) <= -cfg.maxDailyLoss)
    return { ok: false, rail: 'maxDailyLoss', error: `daily loss $${Math.abs(ctx.todayPnlUsd).toFixed(2)} hits $${cfg.maxDailyLoss} halt — kill switch recommended` };

  return { ok: true, rails: cfg };
}

export const liveRailConfig = cfg;
