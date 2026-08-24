// Pure browser-safe guards for the signed-in AITT wallet/claims panel.
export const AITT_CHAIN_ID = 182;

export function chainIdNumber(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  return /^0x/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
}

export function claimGateReason(info) {
  const conversion = info?.conversion || {};
  if (conversion.open !== true || conversion.releaseGate?.ready !== true) {
    return conversion.statusText || conversion.status || conversion.releaseGate?.reason || 'conversion is not enabled';
  }
  return '';
}

export function shouldAllowClaim(info) {
  return claimGateReason(info) === '';
}

// Deliberately refuses to invoke request while the server-reported gate is closed.
export async function requestClaimIfOpen({ gate, request }) {
  const reason = claimGateReason(gate);
  if (reason) return { sent: false, reason };
  await request();
  return { sent: true };
}
