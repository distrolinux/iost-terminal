// Account schedule evidence only: never a fill fee, affordability check or approval.
export function assessKrakenFees(payload) {
  const result = { status: 'unavailable', pair: 'XBT/USD', platformFeeUsd: '0', makerPercent: null, takerPercent: null, executionAuthorized: false, affordabilityVerified: false };
  const rate = value => typeof value === 'string' && /^(?:0|[1-9]\d?)(?:\.\d{1,8})?$/.test(value) ? value : null;
  // Exact pair only. Ambiguous aliases or non-decimal representations are not guessed.
  const side = map => map && !Array.isArray(map) && Object.keys(map).length === 1 && Object.hasOwn(map, 'XXBTZUSD') ? rate(map.XXBTZUSD?.fee) : null;
  const taker = side(payload?.fees), maker = side(payload?.fees_maker);
  if (taker === null || maker === null) return result;
  return { ...result, status: 'schedule-observed', makerPercent: maker, takerPercent: taker };
}
