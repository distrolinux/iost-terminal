// Read-only paper trade preflight. This module computes a deterministic,
// sanitized decision from already-observed state. It never writes a store,
// creates a reservation, places an order, or contacts a public chain.
import crypto from 'node:crypto';
import { stableStringify } from './execution-receipts.js';

export const PAPER_PREFLIGHT_QUOTE_TTL_MS = 10_000;
export const PAPER_PREFLIGHT_ENTRY_WARNING_BPS = 100;
export const PAPER_PREFLIGHT_MAX_SPREAD_BPS = 100;
export const PAPER_PREFLIGHT_DEFAULT_MAX_SLIPPAGE_BPS = 100;
export const PAPER_PREFLIGHT_MAX_SLIPPAGE_BPS = 100;

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value) : null;
const round = (value, places = 4) => {
  const number = finite(value);
  if (number == null) return null;
  const power = 10 ** places;
  return Math.round((number + Number.EPSILON) * power) / power;
};
const money = (minor) => Number.isSafeInteger(minor) && minor >= 0 ? round(minor / 100, 2) : null;
const clean = (value, max = 120) => String(value || '').trim().slice(0, max);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac256 = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
const INTENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function marketEstimate(ticker, order, now) {
  const last = finite(ticker?.last);
  const bid = finite(ticker?.bid);
  const ask = finite(ticker?.ask);
  const entry = finite(order?.entry);
  const size = finite(order?.size);
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  const estimatedFill = order?.side === 'short' ? (bid > 0 ? bid : last) : (ask > 0 ? ask : last);
  const spreadBps = midpoint > 0 && bid > 0 && ask > 0 ? ((ask - bid) / midpoint) * 10_000 : null;
  const slippageBps = midpoint > 0 && estimatedFill > 0 ? Math.abs(estimatedFill - midpoint) / midpoint * 10_000 : null;
  const adverseSlippageBps = entry > 0 && estimatedFill > 0
    ? Math.max(0, (order?.side === 'short' ? entry - estimatedFill : estimatedFill - entry) / entry * 10_000)
    : null;
  const deviationBps = last > 0 && entry > 0 ? Math.abs(entry - last) / last * 10_000 : null;
  const observedAt = Number.isSafeInteger(Number(ticker?.observedAt)) ? Number(ticker.observedAt) : null;
  const quoteAgeMs = observedAt == null ? null : Math.max(0, Math.trunc(now - observedAt));
  const expiresAt = observedAt == null ? null : observedAt + PAPER_PREFLIGHT_QUOTE_TTL_MS;
  return {
    available: last > 0,
    source: clean(ticker?.source, 80) || null,
    observedPrice: round(last, 8),
    observedAt,
    quoteAgeMs,
    fresh: last > 0 && observedAt != null && now <= expiresAt,
    expiresAt,
    bid: round(bid, 8),
    ask: round(ask, 8),
    spreadBps: round(spreadBps, 2),
    executionSide: order?.side === 'short' ? 'bid' : 'ask',
    requestedEntryDeviationBps: round(deviationBps, 2),
    estimatedFillPrice: round(estimatedFill, 8),
    estimatedSlippageBps: round(slippageBps, 2),
    adverseSlippageBps: round(adverseSlippageBps, 2),
    estimateModel: 'top-of-book-spread-only',
    estimatedSlippageUsd: round(entry > 0 && size > 0 && adverseSlippageBps != null
      ? entry * size * adverseSlippageBps / 10_000 : null, 4),
  };
}

export function buildPaperTradePreflight({
  order = {}, ticker = null, cashUsd = null, authorization = {}, mission = null,
  accountScope = '', supportedSymbols = [], now = Date.now(), bindingSecret = null,
} = {}) {
  const intentId = clean(order.intentId, 128);
  const symbol = clean(order.symbol, 24).toUpperCase();
  const side = order.side === 'long' || order.side === 'short' ? order.side : null;
  const size = finite(order.size);
  const entry = finite(order.entry);
  const stop = order.stop == null ? null : finite(order.stop);
  const target = order.target == null ? null : finite(order.target);
  const requestedNotional = entry > 0 && size > 0 ? entry * size : null;
  const market = marketEstimate(ticker, { ...order, side, size, entry }, now);
  const fillNotional = market.estimatedFillPrice > 0 && size > 0 ? market.estimatedFillPrice * size : null;
  const notionalMinor = fillNotional == null ? null : Math.ceil(fillNotional * 100);
  const maxSlippageBps = order.maxSlippageBps == null
    ? PAPER_PREFLIGHT_DEFAULT_MAX_SLIPPAGE_BPS : finite(order.maxSlippageBps);
  const missionRequired = !!clean(order.missionId, 128);
  const cash = finite(cashUsd);

  const checks = [
    { code: 'intent-valid', pass: INTENT_RE.test(intentId) },
    { code: 'symbol-supported', pass: supportedSymbols.includes(symbol) },
    { code: 'side-valid', pass: side != null },
    { code: 'size-valid', pass: size > 0 },
    { code: 'entry-valid', pass: entry > 0 },
    { code: 'max-slippage-valid', pass: maxSlippageBps != null && maxSlippageBps >= 0 && maxSlippageBps <= PAPER_PREFLIGHT_MAX_SLIPPAGE_BPS },
    { code: 'notional-valid', pass: Number.isSafeInteger(notionalMinor) && notionalMinor > 0 },
    { code: 'stop-valid', pass: stop == null || (stop > 0 && side != null && market.estimatedFillPrice > 0 && (side === 'long' ? stop < market.estimatedFillPrice : stop > market.estimatedFillPrice)) },
    { code: 'target-valid', pass: target == null || (target > 0 && side != null && market.estimatedFillPrice > 0 && (side === 'long' ? target > market.estimatedFillPrice : target < market.estimatedFillPrice)) },
    { code: 'market-available', pass: market.available },
    { code: 'quote-fresh', pass: market.fresh },
    { code: 'spread-within-limit', pass: market.spreadBps != null && market.spreadBps <= PAPER_PREFLIGHT_MAX_SPREAD_BPS },
    { code: 'slippage-within-limit', pass: market.adverseSlippageBps != null && maxSlippageBps != null && market.adverseSlippageBps <= maxSlippageBps },
    { code: 'paper-cash-sufficient', pass: cash != null && fillNotional != null && cash >= fillNotional },
    { code: 'wallet-pact-authorized', pass: authorization.ok === true },
    { code: 'mission-authorized', pass: !missionRequired || mission?.ok === true },
  ];
  const firstFailure = checks.find((check) => !check.pass);
  const decision = firstFailure ? 'deny' : 'allow';
  const reasonCode = firstFailure?.code === 'wallet-pact-authorized'
    ? clean(authorization.reason, 120) || firstFailure.code
    : firstFailure?.code === 'mission-authorized'
      ? clean(mission?.reason, 120) || firstFailure.code
      : firstFailure?.code || 'preflight-passed';
  const warnings = [];
  if (market.requestedEntryDeviationBps != null
      && market.requestedEntryDeviationBps > PAPER_PREFLIGHT_ENTRY_WARNING_BPS) {
    warnings.push({ code: 'requested-entry-deviation-high', thresholdBps: PAPER_PREFLIGHT_ENTRY_WARNING_BPS });
  }
  if (market.spreadBps == null) warnings.push({ code: 'spread-unavailable' });

  const fingerprintPayload = {
    version: 1,
    accountScope: String(accountScope || ''),
    request: {
      intentId, symbol, side, size: round(size, 8), entry: round(entry, 8), stop: round(stop, 8), target: round(target, 8),
      maxSlippageBps: round(maxSlippageBps, 2),
      walletId: clean(order.walletId, 128), pactId: clean(order.pactId, 128), missionId: clean(order.missionId, 128),
      recipient: clean(order.recipient, 256), protocol: clean(order.protocol, 128),
    },
    quote: {
      source: market.source, observedPrice: market.observedPrice, observedAt: market.observedAt,
      bid: market.bid, ask: market.ask,
    },
    decision,
    account: { cashUsd: round(cash, 2) },
    authorization: {
      tradePaperScope: authorization.tradePaperScope === true,
      walletPactRequired: authorization.walletPactRequired === true,
      walletOwned: authorization.walletOwned === true,
      walletActive: authorization.walletActive === true,
      walletTradePaper: authorization.walletTradePaper === true,
      walletLimitsAuthorized: authorization.walletLimitsAuthorized === true,
      pactAuthorized: authorization.pactAuthorized === true,
      remainingDailyMinor: Number.isSafeInteger(authorization.remainingDailyMinor) ? authorization.remainingDailyMinor : null,
      remainingWeeklyMinor: Number.isSafeInteger(authorization.remainingWeeklyMinor) ? authorization.remainingWeeklyMinor : null,
      missionRequired,
      missionAuthorized: !missionRequired || mission?.ok === true,
      reason: authorization.ok === true ? 'authorized' : clean(authorization.reason, 120),
      missionReason: !missionRequired || mission?.ok === true ? 'authorized' : clean(mission?.reason, 120),
    },
    checks,
  };
  const fingerprintInput = `iost-terminal:paper-preflight:v2:${stableStringify(fingerprintPayload)}`;

  return {
    ok: true,
    mode: 'paper-only',
    readOnly: true,
    decision,
    reasonCode,
    checkedAt: Math.trunc(now),
    expiresAt: market.expiresAt,
    preflightFingerprint: bindingSecret ? hmac256(bindingSecret, fingerprintInput) : sha256(fingerprintInput),
    binding: {
      version: 1, intentProtected: INTENT_RE.test(intentId), oneExecutionIntent: true,
      expiresAt: market.expiresAt,
    },
    request: {
      symbol, side, size: round(size, 8), requestedEntry: round(entry, 8),
      requestedNotionalUsd: round(requestedNotional, 2), estimatedFillNotionalUsd: round(fillNotional, 2),
      maxSlippageBps: round(maxSlippageBps, 2), missionAttached: missionRequired,
    },
    market,
    costs: {
      currency: 'USD', estimatedFeeUsd: 0, feeModel: 'paper-zero-fee',
      estimatedSlippageUsd: market.estimatedSlippageUsd,
      estimatedTotalUsd: round(fillNotional, 4),
    },
    account: { cashUsd: round(cash, 2), sufficient: checks.find((check) => check.code === 'paper-cash-sufficient').pass },
    authorization: {
      tradePaperScope: authorization.tradePaperScope === true,
      walletPactRequired: authorization.walletPactRequired === true,
      walletOwned: authorization.walletOwned === true,
      walletActive: authorization.walletActive === true,
      walletTradePaper: authorization.walletTradePaper === true,
      walletLimitsAuthorized: authorization.walletLimitsAuthorized === true,
      pactAuthorized: authorization.pactAuthorized === true,
      reasonCode: authorization.ok === true ? 'authorized' : clean(authorization.reason, 120) || 'authorization-denied',
      missionRequired,
      missionAuthorized: !missionRequired || mission?.ok === true,
      remainingDailyUsd: money(authorization.remainingDailyMinor),
      remainingWeeklyUsd: money(authorization.remainingWeeklyMinor),
      liveScopeUsed: false,
      publicChainUsed: false,
    },
    checks,
    warnings,
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
  };
}
