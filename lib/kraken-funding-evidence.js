// Conservative USD-only evidence, never an affordability or execution gate.
const decimal = value => {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d{0,23})(\.\d{1,10})?$/.test(value)) throw Error('unsupported decimal');
  const negative = value.startsWith('-'), [whole, part = ''] = value.replace(/^-/, '').split('.');
  return (negative ? -1n : 1n) * (BigInt(whole) * 10000000000n + BigInt(part.padEnd(10, '0')));
};
export function assessKrakenFunding(payload) {
  const result = { usdCashStatus: 'unavailable', borrowedCreditIncluded: false, marginCoverage: 'not-verified', feesVerified: false, eligibilityVerified: false, executionAuthorized: false };
  try {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') return result;
    const names = ['ZUSD', 'USD'].filter(k => Object.hasOwn(payload, k));
    if (names.length !== 1) return result;
    const row = payload[names[0]];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return result;
    const balance = decimal(row.balance), credit = decimal(row.credit), used = decimal(row.credit_used), held = decimal(row.hold_trade);
    if (credit < 0n || used < 0n || held < 0n) return result;
    // Exclude offered credit rather than treating borrowed capacity as cash.
    const conservativeCash = balance - used - held;
    return { ...result, usdCashStatus: conservativeCash > 0n ? 'positive' : conservativeCash === 0n ? 'zero' : 'negative' };
  } catch { return result; }
}
