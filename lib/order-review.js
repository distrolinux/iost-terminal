// Pure draft arithmetic. No broker, credentials, store or execution dependency.
// USD spot-buy LIMIT drafts only; venue support is deliberately unverified.
const SCALE = 100_000_000n;
function decimal(value, optional = false) {
  if (optional && (value === '' || value == null)) return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(value)) throw Error('Use decimal strings with at most eight decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
}
const format = value => `${value / SCALE}.${(value % SCALE).toString().padStart(8, '0')}`;
const ceilDiv = (a, b) => (a + b - 1n) / b;

export function buildOrderReview(input, { maxOrderUsd, now = Date.now() } = {}) {
  const allowed = ['symbol', 'quantity', 'limitPrice', 'protectiveStop', 'assumedFeeBps'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw Error('Unsupported draft field.');
  if (typeof input.symbol !== 'string' || !/^[A-Z0-9]{2,12}$/.test(input.symbol)) throw Error('Use an uppercase asset symbol.');
  const quantity = decimal(input.quantity), price = decimal(input.limitPrice);
  const stop = decimal(input.protectiveStop, true), feeBps = decimal(input.assumedFeeBps, true);
  if (quantity <= 0n || price <= 0n) throw Error('Quantity and limit price must be positive.');
  if (stop !== null && (stop <= 0n || stop >= price)) throw Error('For this buy draft, the stop must be positive and below the limit price.');
  if (feeBps !== null && feeBps > 1000n * SCALE) throw Error('Assumed fee must be between 0 and 1000 basis points.');
  const notional = ceilDiv(quantity * price, SCALE);
  const fee = feeBps === null ? null : ceilDiv(notional * feeBps, 10000n * SCALE);
  let cap = null;
  try { cap = decimal(maxOrderUsd); if (cap <= 0n) cap = null; } catch { /* unknown policy remains unknown */ }
  return {
    version: 1, mode: 'draft-review-only', decision: 'not-authorized',
    createdAt: now, expiresAt: now + 60_000,
    order: { provider: 'kraken', symbol: input.symbol, quoteCurrency: 'USD', side: 'buy', type: 'limit', quantity: format(quantity), limitPrice: format(price), protectiveStop: stop === null ? null : format(stop) },
    amounts: { notionalUsd: format(notional), assumedFeeBps: feeBps === null ? null : format(feeBps), assumedFeeUsd: fee === null ? null : format(fee), assumedTotalUsd: fee === null ? null : format(notional + fee), lossToStopBeforeFeesUsd: stop === null ? null : format(ceilDiv(quantity * (price - stop), SCALE)) },
    policy: { maxOrderUsd: cap === null ? null : format(cap), notionalCap: cap === null ? 'unknown' : notional <= cap ? 'within-configured-cap' : 'exceeds-configured-cap', fullRiskCheck: 'not-performed' },
    evidence: { price: 'owner-entered-not-market-evidence', fees: fee === null ? 'unknown' : 'owner-assumption-not-venue-verified', slippage: 'not-estimated-limit-order-draft', tradability: 'not-verified', permissions: 'not-verified', balance: 'not-queried', protectiveStop: stop === null ? 'missing' : 'draft-only-not-armed', providerPreview: 'unavailable' },
    approval: { status: 'not-requested', expiresAt: null, bindingPresent: false },
    warnings: ['No provider quote, lot-size, minimum-order or fee verification.', 'Limit orders may not fill. A drafted stop is not protection; gaps and fees can increase losses.', 'Review expiry is not approval expiry. This draft cannot be submitted or approved.'],
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    authorityExpanded: false, liveScopeUsed: false, publicChainUsed: false,
  };
}
