// Pure arithmetic preview, NOT authenticated settlement evidence or a posting API.
// The caller must independently establish account, fill/reference linkage and completeness.
const SCALE = 10000000000n;
function units(value) {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d{0,19})(\.\d{1,10})?$/.test(value)) throw Error('decimal');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const n = BigInt(whole) * SCALE + BigInt(fraction.padEnd(10, '0'));
  return negative ? -n : n;
}
function decimal(n) {
  const sign = n < 0n ? '-' : ''; const v = n < 0n ? -n : n;
  const fraction = (v % SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return sign + (v / SCALE).toString() + (fraction ? '.' + fraction : '');
}
export function previewSpotLedgerEvidence(expected, rows) {
  const held = { status: 'unknown', settlementVerified: false, releaseAllowed: false, executionAuthorized: false };
  const id = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value);
  const asset = value => typeof value === 'string' && /^[A-Z0-9]{2,12}$/.test(value);
  try {
    if (!id(expected.referenceId) || !asset(expected.baseAsset) || !asset(expected.quoteAsset) || expected.baseAsset === expected.quoteAsset || !['buy', 'sell'].includes(expected.side)) return held;
    const volume = units(expected.volume), cost = units(expected.cost);
    if (volume <= 0n || cost <= 0n || !Array.isArray(rows) || rows.length !== 2) return held;
    if (!rows.every(r => r && id(r.id)) || rows[0].id === rows[1].id) return held;
    const sign = expected.side === 'buy' ? 1n : -1n;
    const assets = [];
    for (const [name, amount] of [[expected.baseAsset, sign * volume], [expected.quoteAsset, -sign * cost]]) {
      const matching = rows.filter(r => r.asset === name);
      if (matching.length !== 1) return held;
      const r = matching[0];
      if (r.refid !== expected.referenceId || r.type !== 'trade' || r.subtype !== '' || r.aclass !== 'currency' || units(r.amount) !== amount) return held;
      const fee = units(r.fee);
      if (fee < 0n) return held;
      assets.push({ asset: name, amount: decimal(amount), fee: decimal(fee), netChange: decimal(amount - fee) });
    }
    return { ...held, status: 'ledger-legs-matched', assets };
  } catch { return held; }
}
