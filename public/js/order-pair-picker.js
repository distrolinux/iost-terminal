export function mountPairPicker(host, { isCurrent, onSelect, load = async () => {
  const r = await fetch('/api/exchange-connections/market-pairs', { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw Error('unavailable');
  return r.json();
} }) {
  host.innerHTML = `<h3>1. Choose a market</h3><button class="btn ghost" type="button" data-load-pairs>Load Kraken USD markets</button>
    <p data-pair-status role="status">Optional public catalog. Listing is not account eligibility or trading approval.</p>
    <label>Search available symbols<input type="search" maxlength="24" data-pair-search disabled autocomplete="off"></label>
    <label>Choose a pair<select data-pair-select disabled><option value="">Load markets first</option></select></label>`;
  const button = host.querySelector('[data-load-pairs]'), search = host.querySelector('[data-pair-search]'), select = host.querySelector('[data-pair-select]'), status = host.querySelector('[data-pair-status]');
  let pairs = [], expiresAt = 0, generation = 0, timer;
  const active = () => host.isConnected && isCurrent();
  const clear = text => { pairs = []; select.replaceChildren(); select.disabled = true; search.disabled = true; status.textContent = text; };
  const render = () => {
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Select a market — no order sent'; select.append(placeholder);
    const q = search.value.trim().toUpperCase();
    const matches = pairs.filter(p => p.symbol.includes(q) || p.pair.includes(q));
    for (const p of matches) { const option = document.createElement('option'); option.value = p.symbol; option.textContent = `${p.symbol}/USD${p.pair === p.symbol + '/USD' ? '' : ` (Kraken ${p.pair})`}`; select.append(option); }
    select.disabled = !matches.length;
    status.textContent = `${matches.length} matching online USD markets. Account availability is not verified; check market rules after choosing.`;
  };
  search.addEventListener('input', render);
  select.addEventListener('change', () => {
    if (!active() || Date.now() >= expiresAt) { clear('Catalog expired. Load markets again.'); return; }
    if (pairs.some(p => p.symbol === select.value)) onSelect(select.value);
  });
  button.addEventListener('click', async () => {
    const request = ++generation; clearTimeout(timer); clear('Loading public market catalog…'); button.disabled = true;
    try {
      const data = await load();
      if (!active() || request !== generation) return;
      if (data.status !== 'available' || !Array.isArray(data.pairs) || data.pairs.length > 10000 || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) throw Error('unavailable');
      pairs = data.pairs.filter(p => /^[A-Z0-9]{2,12}$/.test(p.symbol) && /^[A-Z0-9]{2,12}\/USD$/.test(p.pair));
      expiresAt = Math.min(data.expiresAt, Date.now() + 60000); search.disabled = false; render();
      timer = setTimeout(() => { if (active() && request === generation) clear('Catalog expired. Load markets again; no draft was approved.'); }, Math.max(0, expiresAt - Date.now()));
    } catch { if (active() && request === generation) clear('Market catalog unavailable. You can enter a symbol manually, but it is not verified until checked.'); }
    finally { if (active() && request === generation) button.disabled = false; }
  });
}
