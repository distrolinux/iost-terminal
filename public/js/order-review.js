// In-memory draft UI only. Never stores inputs or calls an approval/order API.
import { summarizeOrderReview } from './order-review-summary.js?v=1';
import { mountPairPicker } from './order-pair-picker.js?v=1';
export function mountOrderReview(host, { post, isCurrent }) {
  host.innerHTML = `<h2>Review an order draft <span class="chip warn">Execution locked</span></h2>
    <p>Kraken · USD spot-buy limit draft. Asset availability is not verified. Enter your own assumptions; this is not a recommendation, market quote or exchange preview.</p>
    <section data-pair-picker></section><h3>2. Enter draft amounts</h3><p>Choose a market above or enter a symbol manually. Nothing is submitted to an exchange.</p>
    <form><div class="grid g-2">
      <label>Asset symbol<input name="symbol" required pattern="[A-Z0-9]{2,12}" maxlength="12" placeholder="IOST" autocomplete="off"></label>
      <label>Quantity (asset units)<input name="quantity" required inputmode="decimal" maxlength="19" placeholder="Enter units" autocomplete="off"></label>
      <label>Limit price (USD per unit)<input name="limitPrice" required inputmode="decimal" maxlength="19" placeholder="Enter price" autocomplete="off"></label>
      <label>Protective stop price (optional, USD)<input name="protectiveStop" inputmode="decimal" maxlength="19" placeholder="Not armed by this draft" autocomplete="off"></label>
      <label>Assumed fee (optional, basis points)<input name="assumedFeeBps" inputmode="decimal" maxlength="13" placeholder="100 bps = 1%" autocomplete="off"></label>
    </div><p><button class="btn" type="submit">Review draft — no order sent</button> <button class="btn ghost" type="submit" data-market-review>Check Kraken market rules</button></p><p>Market checks send only the pair symbol to Kraken’s public API. They do not use your credentials or submit this draft.</p></form>
    <div role="status" aria-live="polite" data-review-result>No draft reviewed. Inputs stay in this page and are sent only for calculation; they are not saved.</div>
    <p><button class="btn ghost" disabled>Live execution locked</button></p>`;
  const form = host.querySelector('form');
  const output = host.querySelector('[data-review-result]');
  const submit = form.querySelector('button');
  const marketSubmit = form.querySelector('[data-market-review]');
  mountPairPicker(host.querySelector('[data-pair-picker]'), { isCurrent, onSelect: symbol => {
    form.elements.symbol.value = symbol;
    form.dispatchEvent(new Event('input', { bubbles: true }));
  } });
  let revision = 0, expiryTimer;
  const valid = r => r === revision && host.isConnected && isCurrent();
  form.addEventListener('input', () => {
    revision++; clearTimeout(expiryTimer); submit.disabled = false; marketSubmit.disabled = false;
    output.textContent = 'Inputs changed. Review again; any previous calculation is no longer current.';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const requestRevision = ++revision;
    clearTimeout(expiryTimer); submit.disabled = true; marketSubmit.disabled = true;
    output.textContent = 'Calculating draft only…';
    try {
      const endpoint = event.submitter === marketSubmit ? 'market-review' : 'order-review';
      const result = await post(`/api/exchange-connections/${endpoint}`, Object.fromEntries(new FormData(form)));
      if (!valid(requestRevision)) return;
      if (result.mode !== 'draft-review-only' || result.decision !== 'not-authorized') throw Error('unexpected review');
      output.replaceChildren();
      const summary = summarizeOrderReview(result);
      const panel = document.createElement('section'); panel.className = 'card';
      const summaryHeading = document.createElement('h3'); summaryHeading.textContent = `3. ${summary.title}`; panel.append(summaryHeading);
      for (const message of summary.blockers) { const p = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = message; p.append(strong); panel.append(p); }
      for (const message of summary.unknowns) { const p = document.createElement('p'); p.textContent = message; panel.append(p); }
      const approval = document.createElement('p'); approval.textContent = summary.approval; panel.append(approval); output.append(panel);
      const heading = document.createElement('h3');
      heading.textContent = `Buy ${result.order.quantity} ${result.order.symbol} · limit draft only`;
      output.append(heading);
      const list = document.createElement('dl');
      const money = value => value === null ? 'Unknown — not verified' : `$${value} USD`;
      const rows = [
        ['Entered limit price', money(result.order.limitPrice)],
        ['Notional at limit (rounded up to 8 decimals)', money(result.amounts.notionalUsd)],
        ['Assumed fee — not a venue quote', money(result.amounts.assumedFeeUsd)],
        ['Total using assumed fee — not a spending authorization', money(result.amounts.assumedTotalUsd)],
        ['Loss to drafted stop, excluding fees/gaps', result.amounts.lossToStopBeforeFeesUsd === null ? 'No stop drafted' : money(result.amounts.lossToStopBeforeFeesUsd)],
        ['Stop protection', result.order.protectiveStop === null ? 'Missing' : 'Draft only — not armed or submitted'],
        ['Slippage', 'Not estimated. This is a limit draft; it may not fill.'],
        ['Configured notional cap', `${money(result.policy.maxOrderUsd)} · ${result.policy.notionalCap}`],
        ['Full risk, balance and venue checks', 'Not performed'],
        ['Owner approval', 'Not requested — no approval binding or expiry'],
        ['Review validity', result.market?.quote ? 'Market snapshot valid for at most 30 seconds after retrieval; changing inputs invalidates it' : 'Arithmetic only: 60 seconds from calculation; changing inputs invalidates it'],
      ];
      if (result.market) {
        const m = result.market;
        rows.push(['Kraken public checks', `${m.status} · ${m.reasonCode}`]);
        if (m.rules && m.quote) rows.push(
          ['Market pair', m.pair], ['Pair online', m.rules.pairOnline ? 'Yes — account eligibility not verified' : 'No — draft blocked'],
          ['Minimum asset quantity', m.rules.minimumQuantity], ['Minimum notional', money(m.rules.minimumNotionalUsd)],
          ['Quantity precision', `${m.rules.quantityDecimals} decimal places`], ['Price tick', money(m.rules.priceTick)],
          ['Bid / ask', `${money(m.quote.bid)} / ${money(m.quote.ask)}`], ['Spread', `${m.quote.spreadBps} bps (rounded down)`],
          ['Retrieved at', new Date(m.observedAt).toLocaleTimeString()], ['Source quote age', 'Unknown — Kraken ticker has no source timestamp'],
          ['Failed market rules', m.failures.length ? m.failures.join(', ') : 'None in checked public rules — not authorization'],
        );
        rows.push(['Account fees and eligibility', 'Not verified']);
      }
      for (const [label, value] of rows) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = label; dd.textContent = value; list.append(dt, dd);
      }
      output.append(list);
      for (const warning of result.warnings) {
        const p = document.createElement('p'); p.textContent = warning; output.append(p);
      }
      // Server timestamp determines eligibility of the displayed review. This
      // is not an execution token and cannot authorize anything even while fresh.
      const remaining = Math.max(0, Math.min(60_000, result.expiresAt - Date.now()));
      const expire = () => { if (valid(requestRevision)) output.textContent = 'Review expired. Calculate a fresh draft. Nothing was approved or sent.'; };
      if (!remaining) expire(); else expiryTimer = setTimeout(expire, remaining);
    } catch {
      if (valid(requestRevision)) output.textContent = 'Review unavailable. Use positive decimal quantity/price (up to 8 decimal places), an uppercase symbol, a stop below the limit and an optional fee of 0–1000 bps. Nothing was sent to an exchange.';
    } finally { if (valid(requestRevision)) { submit.disabled = false; marketSubmit.disabled = false; } }
  });
}
