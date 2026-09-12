import { assessKrakenFees } from './kraken-fee-evidence.js';
const SCALE = 10000000000n;
const decimal = value => {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d{0,23})(\.\d{1,10})?$/.test(value)) throw Error('decimal');
  const [whole, part = ''] = value.replace(/^-/, '').split('.');
  return (value.startsWith('-') ? -1n : 1n) * (BigInt(whole) * SCALE + BigInt(part.padEnd(10, '0')));
};
const money = units => `${units / 100000000n}.${String(units % 100000000n).padStart(8, '0')}`;
export function assessKrakenDraftFunding(balance, schedule, notionalUsd) {
  const base = { status: 'unavailable', platformFeeUsd: '0', estimatedFeeUsd: null, estimatedRequiredUsd: null, balanceAmountDisclosed: false, creditIncluded: false, marginCoverage: 'not-verified', eligibilityVerified: false, executionAuthorized: false };
  try {
    const fee = assessKrakenFees(schedule);
    if (fee.status !== 'schedule-observed' || !balance || typeof balance !== 'object' || Array.isArray(balance)) return base;
    const aliases = ['ZUSD', 'USD'].filter(k => Object.hasOwn(balance, k));
    if (aliases.length !== 1) return base;
    const row = balance[aliases[0]];
    if (!row || Array.isArray(row)) return base;
    const cash = decimal(row.balance), credit = decimal(row.credit), used = decimal(row.credit_used), held = decimal(row.hold_trade), notional = decimal(notionalUsd);
    if (credit < 0n || used < 0n || held < 0n || notional <= 0n || notional % 100n !== 0n) return base;
    const maker = decimal(fee.makerPercent), taker = decimal(fee.takerPercent), rate = maker > taker ? maker : taker;
    const n = notional / 100n;
    const estimatedFee = (n * rate + 100n * SCALE - 1n) / (100n * SCALE);
    const required = n + estimatedFee;
    return { ...base, status: cash - used - held >= required * 100n ? 'cash-indication-covers-estimate' : 'cash-indication-below-estimate', estimatedFeeUsd: money(estimatedFee), estimatedRequiredUsd: money(required) };
  } catch { return base; }
}
