// Pure evidence comparison. No venue calls, persistence or hold release.
export function previewLiveReconciliation(expected, observation, previous = null) {
  const fail = { status: 'unknown', releaseAllowed: false, executionAuthorized: false };
  const quantity = s => {
    if (typeof s !== 'string' || !/^(0|[1-9]\d{0,19})(\.\d{1,10})?$/.test(s)) throw Error('quantity');
    const [w, f = ''] = s.split('.'); return BigInt(w) * 10000000000n + BigInt(f.padEnd(10, '0'));
  };
  try {
    if (!expected?.clientOrderId || !expected?.venueOrderId || observation?.clientOrderId !== expected.clientOrderId || observation?.venueOrderId !== expected.venueOrderId || observation?.pair !== expected.pair || observation?.side !== expected.side) return fail;
    const total = quantity(expected.quantity), observedTotal = quantity(observation.quantity), filled = quantity(observation.filledQuantity);
    if (total <= 0n || total !== observedTotal || filled > total) return fail;
    if (!['open', 'closed', 'canceled', 'expired'].includes(observation.status)) return fail;
    if (observation.status === 'closed' && filled !== total) return fail;
    if (previous && (previous.clientOrderId !== expected.clientOrderId || previous.venueOrderId !== expected.venueOrderId || filled < quantity(previous.filledQuantity) || (['closed', 'canceled', 'expired'].includes(previous.status) && observation.status !== previous.status))) return fail;
    const status = observation.status === 'closed' ? 'filled-evidence' : ['canceled', 'expired'].includes(observation.status) ? 'terminal-evidence' : filled > 0n ? 'partial-evidence' : 'open-evidence';
    return { ...fail, status, filledQuantity: observation.filledQuantity, feesVerified: false };
  } catch { return fail; }
}
