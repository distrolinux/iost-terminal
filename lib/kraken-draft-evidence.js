// Public market evidence only. No credentials, private endpoints or orders.
const SCALE = 10n ** 18n;
const value = s => {
  if (typeof s !== 'string' || !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(s)) throw Error('invalid decimal');
  const [w, f = ''] = s.split('.');
  return BigInt(w) * SCALE + BigInt(f.padEnd(18, '0'));
};
const positive = s => { const v = value(s); if (v <= 0n) throw Error('nonpositive'); return v; };
const precision = n => { if (!Number.isInteger(n) || n < 0 || n > 18) throw Error('precision'); return 10n ** BigInt(18 - n); };

async function publicJson(fetchFn, endpoint, pair, signal) {
  const response = await fetchFn(`https://api.kraken.com/0/public/${endpoint}?pair=${encodeURIComponent(pair)}`, { method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
  const age = Number(response.headers.get('age') || 0);
  if (!response.ok || !Number.isFinite(age) || age < 0 || age > 30) throw Error('unavailable');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value: bytes } = await reader.read();
      if (done) break;
      length += bytes.length;
      if (length > 262144) throw Error('oversized');
      chunks.push(Buffer.from(bytes));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(data.error) || data.error.length || !data.result || typeof data.result !== 'object' || Array.isArray(data.result)) throw Error('invalid response');
  return data.result;
}

export function createKrakenDraftEvidence({ fetchFn = (...args) => fetch(...args), now = Date.now } = {}) {
  let active = 0;
  return async review => {
    const unavailable = reasonCode => ({ status: 'unavailable', reasonCode, provider: 'Kraken', executionAuthority: 'none', fees: 'not-verified', accountEligibility: 'not-verified', sourceQuoteAgeMs: null });
    if (active >= 4) return unavailable('market-evidence-busy');
    active++;
    const started = now();
    const signal = AbortSignal.timeout(8000);
    try {
      const symbol = review.order.symbol;
      if (!/^[A-Z0-9]{2,12}$/.test(symbol) || review.order.quoteCurrency !== 'USD') throw Error('invalid draft');
      // Explicit legacy display alias only; never concatenate an arbitrary venue URL.
      const base = symbol === 'BTC' ? 'XBT' : symbol;
      const pairs = await publicJson(fetchFn, 'AssetPairs', `${base}USD`, signal);
      const matches = Object.entries(pairs).filter(([, p]) => p?.wsname === `${base}/USD` && p.aclass_base === 'currency' && p.aclass_quote === 'currency');
      if (matches.length !== 1) return unavailable('pair-not-confirmed');
      const [pairKey, p] = matches[0];
      if (!/^[A-Z0-9]{2,30}$/.test(pairKey) || p.lot_multiplier !== 1) throw Error('unsupported pair');
      const tick = positive(p.tick_size), minimum = positive(p.ordermin), costMinimum = positive(p.costmin);
      const quantityStep = precision(p.lot_decimals), priceStep = precision(p.pair_decimals);
      const quantity = positive(review.order.quantity), price = positive(review.order.limitPrice);
      const checks = {
        pairOnline: p.status === 'online',
        minimumQuantity: quantity >= minimum,
        minimumNotional: quantity * price >= costMinimum * SCALE,
        quantityIncrement: quantity % quantityStep === 0n,
        priceIncrement: price % tick === 0n && price % priceStep === 0n,
      };
      const ticker = await publicJson(fetchFn, 'Ticker', pairKey, signal);
      if (Object.keys(ticker).length !== 1 || !Object.hasOwn(ticker, pairKey)) throw Error('ticker pair mismatch');
      const t = ticker[pairKey];
      const bid = positive(t?.b?.[0]), ask = positive(t?.a?.[0]);
      if (bid > ask) throw Error('crossed quote');
      const observedAt = now();
      if (observedAt - started > 8000 || observedAt < started) throw Error('stale retrieval');
      const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
      return {
        status: failures.length ? 'draft-invalid' : 'public-checks-passed', reasonCode: failures.length ? 'draft-violates-market-rules' : 'public-rules-only-not-authorized',
        provider: 'Kraken', pair: p.wsname, observedAt, expiresAt: observedAt + 30000,
        rules: { minimumQuantity: p.ordermin, minimumNotionalUsd: p.costmin, quantityDecimals: p.lot_decimals, priceDecimals: p.pair_decimals, priceTick: p.tick_size, pairOnline: checks.pairOnline },
        quote: { bid: t.b[0], ask: t.a[0], spreadBps: (Number((ask - bid) * 2000000n / (ask + bid)) / 100).toFixed(2), observedAt, sourceTimestamp: null, sourceQuoteAgeMs: null },
        checks, failures, fees: 'not-verified', accountEligibility: 'not-verified', executionAuthority: 'none',
      };
    } catch { return unavailable('market-evidence-unavailable'); }
    finally { active--; }
  };
}
