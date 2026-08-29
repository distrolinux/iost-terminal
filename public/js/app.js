// IOST Terminal frontend — all views, live SSE updates, charts, chat
import bs58 from '/js/vendor/bs58.mjs'; // vendored base58 (MIT) — for wallet key display
import { AITT_CHAIN_ID, chainIdNumber, claimGateReason, requestClaimIfOpen, shouldAllowClaim } from '/js/wallet-claims.js';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtPrice(v, type) {
  if (v == null || !isFinite(v)) return '—';
  if (type === 'stock') return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(5);
  return v.toFixed(8);
}
const fmtNum = (v, d = 2) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
const pct = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
const timeAgo = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
const gradeClass = (g) => g.toLowerCase().replace(/\s+/g, '-');

const state = { scan: [], scores: [], news: null, onchain: null, paper: null, portfolio: null, activeView: 'scanner' };
let sseOk = false;
let detailLastFocus = null;

function detailFocusable() {
  return $$('#detailBody a[href], #detailBody button:not([disabled]), #detailBody input:not([disabled]), #detailBody select:not([disabled]), #detailBody textarea:not([disabled]), #detailBody [tabindex]:not([tabindex="-1"])')
    .filter(el => !el.hidden && el.offsetParent !== null);
}
function openDetailDialog(label, opener = document.activeElement) {
  const modal = $('#detailModal');
  if (!modal) return;
  detailLastFocus = opener instanceof HTMLElement ? opener : null;
  modal.setAttribute('aria-label', label || 'Details');
  modal.classList.remove('hidden', 'closing');
  requestAnimationFrame(() => (detailFocusable()[0] || $('#detailBody'))?.focus());
}
function trapDetailFocus(event) {
  const modal = $('#detailModal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDetail(); return; }
  if (event.key !== 'Tab') return;
  const focusable = detailFocusable();
  if (!focusable.length) { event.preventDefault(); $('#detailBody')?.focus(); return; }
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
document.addEventListener('keydown', trapDetailFocus);

// ---------------- animation helpers ----------------
function animateNum(el, to, dur = 700) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function toast(html, sub = '', onClick = null) {
  let wrap = $('#toastWrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toastWrap'; wrap.className = 'toast-wrap'; wrap.setAttribute('role', 'status'); document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `${html}${sub ? `<span class="t-sub">${sub}</span>` : ''}`;
  if (onClick) { t.classList.add('clickable'); t.title = 'Click for details'; t.addEventListener('click', () => { onClick(); t.remove(); }); }
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 8000);
}
function buildTicker() {
  if ($('#ticker')) return;
  const div = document.createElement('div');
  div.className = 'ticker'; div.id = 'ticker';
  div.innerHTML = '<div class="ticker-track" id="tickerTrack"></div>';
  $('.topbar').after(div);
}
function tickerContentHTML() {
  const prices = state.scan.map(a => {
    const dir = (a.change24hPct || 0) >= 0 ? 'up' : 'down';
    return `<span class="ticker-item" data-sym="${a.symbol}"><b>${a.symbol}</b> <span class="t-price ${dir}">${fmtPrice(a.price, a.type)}</span> <span class="t-pct ${dir}">${pct(a.change24hPct)}</span></span>`;
  }).join('');
  const news = (state.news?.items || []).slice(0, 10).map(i =>
    `<span class="ticker-item"><span class="chip ${i.sentiment === 'bullish' ? 'bull' : i.sentiment === 'bearish' ? 'bear' : 'neut'}" style="font-size:9px;padding:0 5px">${i.sentiment}</span> ${esc(i.title.slice(0, 72))}</span>`).join('');
  const half = prices + news;
  return half + half; // duplicated for seamless -50% loop
}
function renderTickerContent() { const t = $('#tickerTrack'); if (t) t.innerHTML = tickerContentHTML(); }
function updateTickerPrices() {
  $$('#tickerTrack [data-sym]').forEach(el => {
    const a = state.scan.find(x => x.symbol === el.dataset.sym);
    if (!a) return;
    const dir = (a.change24hPct || 0) >= 0 ? 'up' : 'down';
    const p = el.querySelector('.t-price'), pc = el.querySelector('.t-pct');
    if (p) { p.textContent = fmtPrice(a.price, a.type); p.className = `t-price ${dir}`; }
    if (pc) { pc.textContent = pct(a.change24hPct); pc.className = `t-pct ${dir}`; }
  });
}
const whaleSeen = {}; const lastToast = {};
function checkWhales() {
  state.whaleLog = state.whaleLog || [];
  for (const a of state.scan) {
    const n = a.whale?.bigTrades24h || 0;
    const prev = whaleSeen[a.symbol];
    if (prev != null && n > prev && Date.now() - (lastToast[a.symbol] || 0) > 30000) {
      lastToast[a.symbol] = Date.now();
      // newest whale alert(s) since last scan — push into the log
      const alerts = (a.whale?.alerts || []);
      const fresh = alerts.slice(0, Math.max(1, n - prev)).map(x => ({ ...x, symbol: a.symbol, type: a.type }));
      for (const w of fresh) state.whaleLog.unshift({ ...w, seenAt: Date.now() });
      if (state.whaleLog.length > 200) state.whaleLog.length = 200;
      const top = fresh[0];
      toast(`🐋 <span class="t-sym">${a.symbol}</span> — ${n - prev} new large trade${n - prev > 1 ? 's' : ''} detected`, `largest $${fmtNum(a.whale.largestUsd, 0)} USDT · ${top?.source || 'live scanner'} · click for details`, () => openWhaleModal(top, a.symbol));
    }
    whaleSeen[a.symbol] = n;
  }
}
function exchangeLink(symbol, source) {
  const base = (source || '').toLowerCase();
  if (base.includes('okx')) return `https://www.okx.com/trade-spot/${symbol}-USDT`;
  if (base.includes('gate')) return `https://www.gate.io/trade/${symbol}_USDT`;
  if (base.includes('kucoin')) return `https://www.kucoin.com/trade/${symbol}-USDT`;
  return null;
}
function openWhaleModal(w, symbol, type) {
  if (!w) return;
  const link = exchangeLink(symbol, w.source);
  const dir = w.side === 'sell' ? 'down' : 'up';
  const body = $('#detailBody');
  if (!body) return;
  body.innerHTML = `
    <button class="modal-close" aria-label="Close">✕</button>
    <div class="section-title" style="margin-bottom:10px">🐋 Large Trade <span class="sub">${esc(symbol)} · ${esc(w.source || 'unknown venue')}</span></div>
    <div class="stat-cards" style="grid-template-columns:1fr 1fr">
      <div class="card kpi"><span class="k-label">Side</span><span class="k-value ${dir}">${esc(w.side || '—').toUpperCase()}</span></div>
      <div class="card kpi"><span class="k-label">Size</span><span class="k-value">${fmtNum(w.size)} <span style="font-size:12px">${esc(symbol)}</span></span></div>
      <div class="card kpi"><span class="k-label">Price</span><span class="k-value">$${fmtNum(w.price)}</span></div>
      <div class="card kpi"><span class="k-label">Notional</span><span class="k-value">$${fmtNum(w.usd)}</span></div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:10px">🕒 ${new Date(w.ts).toLocaleString()} · venue: <strong>${esc(w.source || '—')}</strong></div>
    <div class="muted" style="font-size:12px;margin-top:4px">Where it happened: ${link ? `<a href="${link}" target="_blank" rel="noopener" class="up">${esc(w.source)} ${esc(symbol)} market ↗</a>` : '<em>public trade feed — no on-chain address for CEX trades</em>'}</div>
    <div style="margin-top:14px;display:flex;gap:8px">
      <button class="btn sm ghost" id="whaleClose">Close</button>
      ${link ? `<a class="btn sm" href="${link}" target="_blank" rel="noopener">Open ${esc(w.source || 'exchange')} ↗</a>` : ''}
    </div>`;
  openDetailDialog(`Large ${symbol} trade details`);
  $('#whaleClose')?.addEventListener('click', closeDetail);
  const x = $('#detailBody .modal-close'); if (x) x.onclick = closeDetail;
}
// ---------------- Whales log view ----------------
function renderWhales() {
  const el = $('#view-whales');
  state.whaleLog = state.whaleLog || [];
  // current tape from live scan, merged with the session log
  const tape = [];
  for (const a of (state.scan || [])) {
    for (const w of (a.whale?.alerts || [])) tape.push({ ...w, symbol: a.symbol, type: a.type });
  }
  const merged = [...state.whaleLog, ...tape];
  const seen = new Set(); const rows = [];
  for (const w of merged) {
    const k = `${w.symbol}:${w.ts}:${w.usd}`;
    if (seen.has(k)) continue; seen.add(k);
    rows.push(w);
  }
  rows.sort((a, b) => (b.seenAt || b.ts) - (a.seenAt || a.ts));
  el.innerHTML = `
    <div class="section-title">Whale Trades <span class="sub">large-trade tape · live scan + this session · ${rows.length} events</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Size</th><th>Price</th><th>Notional</th><th>Venue</th></tr></thead>
        <tbody>${rows.slice(0, 100).map(w => `
          <tr class="clickable-row" data-whale="${esc(JSON.stringify({ ...w, symbol: w.symbol, type: w.type }))}">
            <td class="mono">${new Date(w.seenAt || w.ts).toLocaleTimeString('en-GB', { hour12: false })}</td>
            <td><strong>${esc(w.symbol)}</strong></td>
            <td class="${w.side === 'sell' ? 'down' : 'up'}">${esc(w.side || '—').toUpperCase()}</td>
            <td class="mono">${fmtNum(w.size)}</td>
            <td class="mono">$${fmtNum(w.price)}</td>
            <td class="mono">$${fmtNum(w.usd)}</td>
            <td>${esc(w.source || '—')}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="dim">No large trades detected yet — they appear here live as they hit the scanner.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="muted" style="font-size:11px;margin-top:8px">Click any row for the trade detail + where it happened. CEX trades are venue-level (OKX/Gate public tape) — no on-chain wallet address exists for exchange trades.</div>`;
  $$('.clickable-row').forEach(r => r.addEventListener('click', () => {
    try { const w = JSON.parse(r.dataset.whale); openWhaleModal(w, w.symbol, w.type); } catch { /* ignore */ }
  }));
}

// ---------------- Smart-Money Signals (v1.16, Binance Web3) ----------------
// Public feed: on-chain buy/sell events from tracked smart-money wallets (BSC/Solana).
// Server proxies + normalizes; this view renders cards + cross-links to Token Audit.
const SM_CHAINS = [
  { id: '56', name: 'BSC' },
  { id: 'CT_501', name: 'Solana' },
];
state.sm = state.sm || { chain: '56', data: null, ts: null, timer: null, loading: false };

function smPrice(v) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return '—';
  return n < 0.01 ? n.toPrecision(4) : fmtNum(n);
}

async function fetchSmartMoney() {
  const el = $('#view-smartmoney');
  if (!el) return;
  const st = state.sm;
  if (st.loading) return;
  st.loading = true;
  try {
    const r = await api(`/api/smart-money?chainId=${st.chain}&page=1&pageSize=20`);
    st.data = r.signals || [];
    st.ts = Date.now();
    st.err = null;
  } catch (e) {
    st.data = null;
    st.err = e.message;
  }
  st.loading = false;
  if (state.activeView === 'smartmoney') renderSmartMoney();
}

async function renderSmartMoney() {
  const el = $('#view-smartmoney');
  const st = state.sm;
  el.innerHTML = `
    <div class="section-title">Smart Money <span class="sub">on-chain whale buy/sell signals · Binance Web3 · ${SM_CHAINS.find(c => c.id === st.chain)?.name || st.chain}</span></div>
    <div class="audit-tools" style="margin-bottom:14px">
      ${SM_CHAINS.map(c => `<button class="chip sm-chain ${st.chain === c.id ? 'is-active' : ''}" data-chain="${c.id}">${c.name}</button>`).join('')}
      <button class="btn sm ghost" id="smRefresh" aria-label="Refresh smart money signals">⟳ Refresh</button>
      <span class="mono muted" style="font-size:11px" id="smStamp">${st.ts ? 'updated ' + new Date(st.ts).toLocaleTimeString('en-GB', { hour12: false }) : '—'}</span>
    </div>
    ${!st.data && !st.err ? '<div class="card empty">Loading signals…</div>'
      : st.err ? `<div class="card empty" style="color:#f87171">Feed error: ${esc(st.err)}</div>`
      : !st.data.length ? '<div class="card empty">No active signals right now — check back shortly.</div>'
      : `<div class="grid g-2">${st.data.map(sigCard).join('')}</div>`}
    <div class="muted" style="font-size:11px;margin-top:10px">Smart money = wallets tracked for professional buying patterns. High exit rate (≥70%) means smart money already left. ⚠️ Signals are for reference only — not investment advice. Always audit a token before trading.</div>`;
  $$('.sm-chain').forEach(b => b.addEventListener('click', () => {
    st.chain = b.dataset.chain;
    st.data = null; st.err = null; st.ts = null;
    fetchSmartMoney();
  }));
  $('#smRefresh')?.addEventListener('click', () => { st.data = null; fetchSmartMoney(); });
  $$('[data-audit]').forEach(b => b.addEventListener('click', () => {
    state.audit.pending = b.dataset.audit;
    state.audit.result = null; state.audit.err = null;
    switchView('audit');
    setTimeout(() => runAudit(), 50);
  }));
  if (!st.timer) st.timer = setInterval(() => { if (state.activeView === 'smartmoney') fetchSmartMoney(); }, 60_000);
  if (!st.data && !st.err && !st.loading) fetchSmartMoney();
}

function sigCard(s) {
  const dir = s.direction === 'sell' ? 'down' : 'up';
  const stale = s.status === 'timeout' || s.exitRate >= 70;
  const tags = (s.tags || []).slice(0, 3).map(t => `<span class="sig-tag">${esc(t)}</span>`).join('');
  const gain = s.maxGainPct;
  return `
    <div class="card sig-card">
      <div class="sig-head">
        ${s.logoUrl ? `<img class="sig-logo" src="${esc(s.logoUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<span class="sig-logo sig-logo-fallback">◈</span>'}
        <div class="sig-title">
          <strong>${esc(s.ticker)}</strong>
          ${s.isAlpha ? '<span class="chip alpha">ALPHA</span>' : ''}
          ${s.launchPlatform ? `<span class="sig-tag">${esc(s.launchPlatform)}</span>` : ''}
        </div>
        <div class="sig-right">
          <span class="chip ${dir}">${s.direction === 'sell' ? 'SELL' : 'BUY'}</span>
          <span class="chip ${stale ? 'dim' : 'ok'}">${esc(s.status || '—')}</span>
        </div>
      </div>
      <div class="sig-prices">
        <div><span class="sig-label">ALERT</span><span class="mono">$${smPrice(s.alertPrice)}</span></div>
        <div><span class="sig-label">NOW</span><span class="mono">$${smPrice(s.currentPrice)}</span></div>
        <div class="sig-gain ${gain != null && gain > 0 ? 'up' : gain != null && gain < 0 ? 'down' : ''}">${gain != null ? (gain > 0 ? '+' : '') + gain + '%' : '—'}</div>
      </div>
      <div class="stat-grid">
        <div class="stat-cell"><span class="s-label">SMART MONEY</span><span class="s-val mono">${s.smartMoneyCount ?? '—'}</span></div>
        <div class="stat-cell"><span class="s-label">EXIT RATE</span><span class="s-val mono">${s.exitRate != null ? s.exitRate + '%' : '—'}</span></div>
        <div class="stat-cell"><span class="s-label">VALUE</span><span class="s-val mono">$${smPrice(s.totalTokenValue)}</span></div>
        <div class="stat-cell"><span class="s-label">TRIGGERED</span><span class="s-val mono">${s.triggerTime ? new Date(s.triggerTime).toLocaleTimeString('en-GB', { hour12: false }) : '—'}</span></div>
      </div>
      ${tags ? `<div class="sig-tags">${tags}</div>` : ''}
      <div class="sig-foot">
        <span class="mono sig-addr" title="${esc(s.contractAddress || '')}">${esc((s.contractAddress || '').slice(0, 10))}…${esc((s.contractAddress || '').slice(-6))}</span>
        <button class="btn sm ghost" data-audit="${esc(s.contractAddress || '')}">🛡 Audit token</button>
      </div>
    </div>`;
}

// ---------------- Token Audit (v1.16, Binance Web3) ----------------
// Pre-trade security scan: honeypot / rug-pull / malicious contract / tax checks.
state.audit = state.audit || { chain: '56', pending: null, lastAddr: null, result: null, busy: false, err: null };
const AUDIT_CHAINS = [
  { id: '56', name: 'BSC' },
  { id: '8453', name: 'Base' },
  { id: 'CT_501', name: 'Solana' },
  { id: '1', name: 'Ethereum' },
];

function riskBadge(enumName) {
  const cls = enumName === 'LOW' ? 'risk-low' : enumName === 'MEDIUM' ? 'risk-med' : enumName === 'HIGH' ? 'risk-high' : 'risk-unk';
  return `<span class="risk-badge ${cls}">${esc(enumName || 'UNKNOWN')} RISK</span>`;
}

function auditCheckRow(c) {
  const cls = c.hit ? (c.type === 'risk' ? 'check-hit' : 'check-caution') : 'check-clean';
  const mark = c.hit ? (c.type === 'risk' ? '✗' : '⚠') : '✓';
  return `<div class="audit-check ${cls}"><span class="audit-mark">${mark}</span><div><strong>${esc(c.title)}</strong><div class="muted" style="font-size:11px">${esc(c.description)}</div></div></div>`;
}

async function runAudit() {
  const st = state.audit;
  if (st.busy) return;
  const addr = ($('#auditAddr')?.value || st.pending || '').trim();
  if (!addr) return;
  st.busy = true; st.err = null; st.result = null;
  const el = $('#view-audit');
  if (el) el.querySelector('#auditResult')?.replaceWith(htmlToNode('<div class="card empty" id="auditResult">Running security audit…</div>'));
  try {
    st.result = await post('/api/token-audit', { contractAddress: addr, chainId: st.chain });
    st.lastAddr = addr;
  } catch (e) {
    st.err = e.message;
  }
  st.busy = false;
  if (state.activeView === 'audit') renderAudit();
}

function renderAudit() {
  const el = $('#view-audit');
  const st = state.audit;
  const r = st.result;
  let body = '';
  if (st.busy) {
    body = '<div class="card empty">Running security audit…</div>';
  } else if (st.err) {
    body = `<div class="card empty" style="color:#f87171">Audit failed: ${esc(st.err)} — try again or check the contract address.</div>`;
  } else if (r && r.ok && r.supported) {
    const meta = [
      r.buyTax != null ? ['BUY TAX', r.buyTax + '%'] : null,
      r.sellTax != null ? ['SELL TAX', r.sellTax + '%'] : null,
      ['VERIFIED', r.isVerified ? 'yes' : 'no'],
      ['SOURCE', r.source || 'BINANCE'],
    ].filter(Boolean).map(([k, v]) => `<div class="stat-cell"><span class="s-label">${k}</span><span class="s-val mono">${esc(v)}</span></div>`).join('');
    const items = (r.items || []).map(cat => `
      <div class="card audit-cat">
        <div class="audit-cat-head"><strong>${esc(cat.name)}</strong><span class="mono muted">${cat.checks.filter(c => c.hit).length} flagged</span></div>
        ${cat.checks.map(auditCheckRow).join('')}
      </div>`).join('');
    body = `
      <div class="card audit-summary">
        <div class="sig-head">
          ${riskBadge(r.riskLevelEnum)}
          <span class="mono" style="font-size:13px">level ${r.riskLevel ?? '—'} / 5</span>
          ${r.hits + r.cautions > 0 ? `<span class="chip ${r.riskLevelEnum === 'HIGH' ? 'down' : ''}">${r.hits} risk · ${r.cautions} caution</span>` : '<span class="chip ok">clean scan</span>'}
        </div>
        <div class="stat-grid">${meta}</div>
      </div>
      ${items}`;
  } else if (r && r.ok) {
    body = '<div class="card empty">Security audit data is not available for this token on this chain — verify the contract address and chain, or try again later.</div>';
  } else {
    body = '<div class="card empty">Paste a token contract address and run the scan.</div>';
  }
  el.innerHTML = `
    <div class="section-title">Token Audit <span class="sub">pre-trade security scan · honeypot / rug-pull / scam / tax · Binance Web3</span></div>
    <div class="audit-tools" style="margin-bottom:14px">
      <select id="auditChain" class="audit-select mono" aria-label="Chain">
        ${AUDIT_CHAINS.map(c => `<option value="${c.id}" ${st.chain === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
      <input id="auditAddr" class="audit-input mono" type="text" placeholder="0x… contract address" value="${st.pending || st.lastAddr || ''}" spellcheck="false" aria-label="Token contract address">
      <button class="btn green" id="auditGo" aria-label="Run token audit" ${st.busy ? 'disabled' : ''}>${st.busy ? 'SCANNING…' : 'AUDIT'}</button>
    </div>
    <div id="auditResult">${body}</div>
    <div class="muted" style="font-size:11px;margin-top:10px">⚠️ This audit result is for reference only and does not constitute investment advice. Always conduct your own research. LOW risk does not mean safe — results are point-in-time snapshots.</div>`;
  $('#auditChain')?.addEventListener('change', e => { st.chain = e.target.value; });
  $('#auditGo')?.addEventListener('click', () => runAudit());
  $('#auditAddr')?.addEventListener('keydown', e => { if (e.key === 'Enter') runAudit(); });
  $$('[data-audit]').forEach(b => b.addEventListener('click', () => {
    st.pending = b.dataset.audit;
    st.result = null; st.err = null;
    switchView('audit');
    setTimeout(() => runAudit(), 50);
  }));
  if (st.pending && !st.busy && !r) { const addr = st.pending; st.pending = null; $('#auditAddr') && (el.querySelector('#auditAddr').value = addr); runAudit(); }
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

function htmlToNode(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

// ---------------- Decentralized AI Agents marketplace ----------------
// Agents publish signals; every signal is SHA-256 hash-pinned on the IOST
// mainnet (token.iost transfer memo). Humans follow agents → paper
// copy-trades (5-position cap). Pin states are honest: "pinned" (on-chain,
// explorer link) vs "queued (off-chain)" until IOST_PIN_KEY is configured.
let agentsSel = null;
async function renderAgents() {
  const el = $('#view-agents');
  el.innerHTML = skeleton();
  const [reg, feed, chain] = await Promise.all([
    api('/api/agents').catch(() => null),
    api('/api/signals/feed?limit=100').catch(() => null),
    api('/api/chain/status').catch(() => null),
  ]);
  if (!reg) { el.innerHTML = '<div class="card empty">Agents registry unavailable — is the server up?</div>'; return; }
  const st = reg.stats || {};
  const sigs = (feed?.signals || []).filter(s => !agentsSel || s.agentId === agentsSel);
  const loggedIn = !!window.Auth?.state?.loggedIn;
  const kindChip = (k) => `<span class="chip ${k === 'ai' ? 'acc' : 'neut'}">${k === 'ai' ? 'AI' : 'human'}</span>`;
  const pinCell = (s) => s.pinStatus === 'pinned'
    ? `<a class="chip bull" href="${esc(s.explorerUrl || '#')}" target="_blank" rel="noopener" aria-label="View pinned transaction on IOST explorer">✓ pinned ↗</a>`
    : `<span class="chip warn" title="Will be anchored when IOST_PIN_KEY is configured">queued (off-chain)</span>`;
  const agentRows = (reg.agents || []).map(a => `
    <tr class="clickable" data-agent="${esc(a.agentId)}" tabindex="0" role="button" aria-label="Show signals from ${esc(a.name)}">
      <td><strong>${esc(a.name)}</strong> <span class="muted mono">${esc(a.agentId)}</span></td>
      <td>${kindChip(a.kind)}</td>
      <td class="mono">${a.winRate != null ? a.winRate + '%' : '—'}</td>
      <td class="mono">${a.pinnedCount}</td>
      <td class="mono">${a.queuedCount}</td>
      <td class="mono">${a.followCount}</td>
      <td>
        <button class="btn sm ghost" data-follow="${esc(a.agentId)}" data-sig="${esc(a.latestSignal?.id || '')}" aria-label="Follow ${esc(a.name)} (paper copy-trading)">${loggedIn ? 'Follow' : 'Follow (sign in)'}</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="dim">No agents registered yet — publish a signal to create one.</td></tr>';
  el.innerHTML = `
    <div class="section-title">Decentralized AI Agents <span class="sub">agents publish · every signal SHA-256 hash-pinned on IOST mainnet · humans follow → paper copy-trades (5-position cap)</span></div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Agents</span><span class="k-value">${st.agents ?? 0}</span><span class="k-sub">${(st.pinned ?? 0) + (st.queued ?? 0)} provable signals</span></div>
      <div class="card kpi"><span class="k-label">Signals</span><span class="k-value">${st.signals ?? 0}</span><span class="k-sub">${st.queued ?? 0} queued · ${st.pinned ?? 0} pinned on-chain</span></div>
      <div class="card kpi"><span class="k-label">Follows</span><span class="k-value">${st.follows ?? 0}</span><span class="k-sub">${st.copiedPositions ?? 0} copied paper positions</span></div>
      <div class="card kpi"><span class="k-label">L1 trust layer</span><span class="k-value" style="font-size:15px">${chain?.ok ? '⛓ IOST mainnet' : '⛓ RPC unreachable'}</span><span class="k-sub">${esc(chain?.identity?.operator?.displayName || 'IOSTcallister')} · ${chain?.headBlock ? 'head #' + chain.headBlock : 'chain 1024'}${chain?.configured ? '' : ' · pin key OFF'}</span></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Agent registry <span class="sub">win rates from real paper journals · provable track records</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">Agent</th><th scope="col">Kind</th><th scope="col">Win rate</th><th scope="col">Pinned</th><th scope="col">Queued</th><th scope="col">Followers</th><th scope="col">Follow</th></tr></thead>
        <tbody>${agentRows}</tbody>
      </table></div>
      <p class="muted" style="font-size:11px;margin-top:8px">Click an agent row to see its signal history + on-chain proofs. Without IOST_PIN_KEY, pins are queued off-chain and labeled honestly.</p>
    </div>
    <div class="card" id="agentDetail" aria-live="polite">
      ${agentsSel
        ? `<div class="section-title" style="margin-bottom:8px">Signals — <span class="mono">${esc(agentsSel)}</span> <button class="btn sm ghost" id="agClear" aria-label="Show all agents again">show all agents</button></div>`
        : '<div class="section-title" style="margin-bottom:8px">Signal history <span class="sub">select an agent above</span></div>'}
      ${sigs.length ? `<div class="table-wrap"><table>
        <thead><tr><th scope="col">Type</th><th scope="col">Symbol</th><th scope="col">Side</th><th scope="col">Entry</th><th scope="col">Reason</th><th scope="col">Pin</th><th scope="col">Proof</th><th scope="col">Age</th></tr></thead>
        <tbody>${sigs.map(s => `
          <tr>
            <td><span class="chip neut">${esc(s.type)}</span></td>
            <td><strong>${esc(s.symbol || '—')}</strong></td>
            <td>${s.side ? `<span class="chip ${s.side === 'long' ? 'bull' : 'bear'}">${s.side}</span>` : '—'}</td>
            <td class="mono">${s.entry != null ? fmtPrice(s.entry, 'crypto') : '—'}</td>
            <td class="muted" style="max-width:280px;white-space:normal">${esc(s.reason || s.content || '—')}</td>
            <td>${pinCell(s)}</td>
            <td><a href="${esc(s.proofUrl)}" target="_blank" rel="noopener" aria-label="Verify proof for signal ${esc(s.id)}">verify</a>${s.hasTrail ? ` <button class="btn sm ghost" data-trail="${esc(s.id)}" aria-expanded="false" aria-label="Why — show the reasoning trace for signal ${esc(s.id)}">Why</button>` : ''}</td>
            <td class="muted mono">${timeAgo(s.ts)}</td>
          </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No signals yet for this view.</div>'}
    </div>`;
  // interactions (delegated, keyboard accessible)
  $$('#view-agents [data-follow]').forEach(b => b.addEventListener('click', async () => {
    if (!window.Auth?.state?.loggedIn) { window.Auth?.open('login'); toast('Sign in to follow agents', 'paper copy-trading is per-account'); return; }
    const agentId = b.dataset.follow;
    const path = b.dataset.sig || 'x';
    try {
      const r = await post(`/api/signals/${path}/follow`, { agentId });
      if (r.ok) { b.textContent = '✓ Following'; b.disabled = true; toast('Now following', agentId); }
      else toast('Follow failed', r.error || 'unknown');
    } catch (e) { toast('Follow failed', e.message); }
  }));
  $$('#view-agents tr[data-agent]').forEach(tr => {
    const show = () => { agentsSel = tr.dataset.agent; renderAgents(); };
    tr.addEventListener('click', show);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } });
  });
  // XAI "Why" toggle — fetch the structured reasoning trail and expand inline
  $$('#view-agents [data-trail]').forEach(b => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('trail-row')) { next.remove(); b.setAttribute('aria-expanded', 'false'); return; } // collapse
    const id = b.dataset.trail;
    b.disabled = true;
    let row;
    try {
      const d = await api(`/api/signals/${id}/trail`);
      const steps = (d.trail || []).map((st, i) => `
        <div class="trail-step" style="margin:6px 0;padding:8px 10px;background:var(--bg,#0c0f14);border:1px solid var(--border,#222);border-radius:6px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="chip neut" style="font-size:10px">step ${i + 1}</span>
            <strong style="font-size:12px">${esc(st.step || '—')}</strong>
            <span class="muted mono" style="margin-left:auto;font-size:11px">conf ${st.confidence != null ? Math.round(st.confidence * 100) + '%' : '—'}</span>
          </div>
          <div class="muted" style="font-size:12px;margin-top:4px"><b style="color:var(--fg,#ddd)">input:</b> ${esc(st.input ?? '—')}</div>
          <div class="muted" style="font-size:12px"><b style="color:var(--fg,#ddd)">output:</b> ${esc(st.output ?? '—')}</div>
        </div>`).join('') || '<div class="muted">no steps</div>';
      row = document.createElement('tr');
      row.className = 'trail-row';
      row.innerHTML = `<td colspan="8" style="padding:4px 10px 10px">${steps}</td>`;
      b.setAttribute('aria-expanded', 'true');
    } catch (e) {
      row = document.createElement('tr');
      row.className = 'trail-row';
      row.innerHTML = '<td colspan="8" class="muted" style="padding:6px 10px">trace unavailable</td>';
    } finally { b.disabled = false; }
    tr.after(row);
  }));
  $('#agClear')?.addEventListener('click', () => { agentsSel = null; renderAgents(); });
}

// ---------------- Points (tokenomics vision §6: off-chain, 1:1 AITT planned) ----------------
// Honest framing: points are accrual-only platform credits. NO token is issued;
// 1:1 AITT conversion is planned at TGE and explicitly labeled "not guaranteed".
const aittWalletFlow = { address: '', chainId: null, challenge: null, error: '', notice: '' };
let aittProviderListenersAttached = false;
async function ensureIostL2Wallet() {
  if (!window.ethereum) throw new Error('MetaMask or another EVM wallet is required');
  const chainId = await window.ethereum.request({ method: 'eth_chainId' });
  if (chainIdNumber(chainId) === AITT_CHAIN_ID) return;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xb6' }] });
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0xb6', chainName: 'IOST L2', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://l2-mainnet.iost.io'], blockExplorerUrls: ['https://l2-scan.iost.io'] }] });
  }
}
function clearAittPending(message = '') { aittWalletFlow.challenge = null; aittWalletFlow.error = message; }
function attachAittProviderListeners() {
  if (aittProviderListenersAttached || !window.ethereum?.on) return;
  aittProviderListenersAttached = true;
  window.ethereum.on('accountsChanged', (accounts) => {
    const next = accounts?.[0] || '';
    aittWalletFlow.address = next;
    clearAittPending(next ? 'Wallet account changed. Review and sign a new binding message.' : 'Wallet disconnected.');
    if (state.activeView === 'points') renderPoints();
  });
  window.ethereum.on('chainChanged', (chainId) => {
    aittWalletFlow.chainId = chainIdNumber(chainId);
    clearAittPending(`Network changed to chain ${aittWalletFlow.chainId}; AITT binding requires IOST L2 chain 182.`);
    if (state.activeView === 'points') renderPoints();
  });
  window.ethereum.on('disconnect', () => {
    aittWalletFlow.address = ''; aittWalletFlow.chainId = null;
    clearAittPending('Wallet disconnected. Reconnect only when you are ready to bind.');
    if (state.activeView === 'points') renderPoints();
  });
}
async function renderPoints() {
  const el = $('#view-points');
  el.innerHTML = skeleton();
  if (!window.Auth?.state?.loggedIn) {
    el.innerHTML = `<div class="card empty">Sign in required — <button class="btn sm" id="authGateBtn">open sign in</button></div>`;
    $('#authGateBtn')?.addEventListener('click', () => window.Auth?.open('login'));
    return;
  }
  attachAittProviderListeners();
  let d, walletResponse, claimInfo, gate;
  try {
    [d, walletResponse, claimInfo, gate] = await Promise.all([api('/api/points'), api('/api/aitt/wallet'), api('/api/aitt/claims'), api('/api/aitt/info')]);
  } catch (e) {
    if (/^40[13]\b/.test(e.message)) {
      clearAittPending('Your signed-in session expired or is not authorized. Sign in again before viewing wallet or claims.');
      el.innerHTML = '<div class="card empty" role="alert">Sign in required — <button class="btn sm" id="authGateBtn">open sign in</button></div>';
      $('#authGateBtn')?.addEventListener('click', () => window.Auth?.open('login'));
    } else el.innerHTML = `<div class="card empty">AITT dashboard unavailable: ${esc(e.message)}</div>`;
    return;
  }
  const walletBinding = walletResponse.binding || null;
  const gateReason = claimGateReason(gate);
  const claims = claimInfo.claims || [];
  const rows = (d.ledger || []).map(e => {
    const detail = e.meta?.signalId ? `signal ${String(e.meta.signalId).slice(0, 8)}…` : e.meta?.referee ? `referee ${String(e.meta.referee).slice(0, 12)}…` : e.meta?.followerId ? `follower ${String(e.meta.followerId).slice(0, 12)}…` : e.meta?.week ? `week ${esc(e.meta.week)}` : e.meta?.rating ? `rating ${e.meta.rating}/5` : (e.meta?.comment ? esc(e.meta.comment).slice(0, 60) : '');
    return `<tr>
      <td><span class="chip neut">${esc(e.eventLabel)}</span></td>
      <td class="mono up">+${e.points}</td>
      <td class="muted mono">${new Date(e.ts).toLocaleString()}</td>
      <td class="muted" style="max-width:280px;white-space:normal">${detail || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="dim">No activity yet — earn points by publishing signals, gaining followers, referrals and quality feedback.</td></tr>';
  el.innerHTML = `
    <div class="section-title">Platform Points <span class="sub">off-chain accrual · 1:1 AITT conversion design target · pre-launch hold · nothing issued</span></div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Points balance</span><span class="k-value">${d.balance}</span><span class="k-sub">1 point → 1 AITT design target (planned, not guaranteed) · not spendable</span></div>
    </div>
    <section class="card" style="margin-bottom:16px" aria-labelledby="aittWalletTitle">
      <div class="section-title" id="aittWalletTitle" style="margin-bottom:8px">AITT conversion wallet <span class="sub">EIP-191 signature only · no transaction or payment authority</span></div>
      <div aria-live="polite">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span class="k-label">Binding</span><span class="mono">${walletBinding ? esc(walletBinding.address) : 'unbound'}</span>
          ${walletBinding ? '<span class="chip ok">verified</span>' : '<span class="chip neut">not bound</span>'}
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px"><span class="k-label">Network</span><span class="mono">${aittWalletFlow.chainId === AITT_CHAIN_ID ? 'IOST L2 · chain 182' : aittWalletFlow.chainId ? `wrong network · chain ${aittWalletFlow.chainId}` : 'not checked'}</span></div>
        <p class="muted" style="font-size:11px">${walletBinding ? 'This address is bound to this signed-in account. Disconnecting in MetaMask does not delete the server binding; rebinds require review.' : 'Connect an EIP-1193 wallet, confirm chain 182, then explicitly review and sign the server-provided message.'}</p>
        ${walletBinding ? '<span class="chip neut">rebind requires review</span>' : '<button class="btn sm" id="bindEvmBtn">Connect wallet</button>'}
        ${aittWalletFlow.challenge ? `<div class="card" style="margin-top:12px;background:var(--surface-2)"><label for="aittChallengeMessage" class="k-label">Exact message to sign</label><pre id="aittChallengeMessage" tabindex="0" style="white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto">${esc(aittWalletFlow.challenge.message)}</pre><button class="btn sm" id="signEvmBtn">Sign this message</button></div>` : ''}
        ${aittWalletFlow.error || aittWalletFlow.notice ? `<p role="status" class="muted" style="margin-top:8px">${esc(aittWalletFlow.error || aittWalletFlow.notice)}</p>` : ''}
      </div>
    </section>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">AITT conversion <span class="sub">1 point → 1 AITT design target · pre-launch hold · no token issued</span></div>
      <div class="aitt-conv">
        <div class="conv-cell"><span class="k-label">Design target</span><span class="k-value">≈ ${d.balance} AITT</span></div>
        <div class="conv-cell"><span class="k-label">Status</span><span class="chip ${d.conversion?.open ? 'ok' : 'neut'}">${esc((d.conversion?.status || 'planned at TGE — not open yet'))}</span></div>
        <button class="btn sm" id="claimBtn" ${gateReason ? 'disabled' : ''} aria-label="Claim AITT for your points" title="${esc(gateReason)}">Claim AITT</button>
      </div>
      <p class="muted" style="font-size:11px;margin-top:8px" role="status">${esc(gateReason || 'Conversion is enabled by the server release gates.')}</p>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Conversion claims <span class="sub">only this signed-in account</span></div>
      <div class="stat-cards"><div class="conv-cell"><span class="k-label">Available points</span><span class="k-value">${claimInfo.availablePoints ?? d.balance}</span></div><div class="conv-cell"><span class="k-label">Approved</span><span class="k-value">${claims.filter(c => c.status === 'approved_onchain').reduce((n, c) => n + c.points, 0)}</span></div><div class="conv-cell"><span class="k-label">Claimed</span><span class="k-value">${claims.filter(c => c.status === 'claimed_onchain').reduce((n, c) => n + c.points, 0)}</span></div></div>
      ${claims.length ? claims.map(c => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0"><span class="mono">${esc(c.id.slice(0, 12))}…</span><span>${c.points} points</span><span class="chip neut">${esc(c.status)}</span></div>`).join('') : '<p class="muted">No claims yet. Conversion remains closed during the pre-launch hold.</p>'}
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Referral program <span class="sub">share your code — you earn +50, the new trader earns +10 · self-referral blocked</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <code class="ref-code mono" id="refCode" aria-label="Your referral code">${esc(d.referralCode)}</code>
        <button class="btn sm" id="refCopy" aria-label="Copy your referral link">Copy link</button>
        <span class="muted mono" style="font-size:12px;word-break:break-all">${esc(d.referralLink)}</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title" style="margin-bottom:8px">Earn ledger <span class="sub">recent activity</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">Event</th><th scope="col">Points</th><th scope="col">When</th><th scope="col">Detail</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="muted" style="font-size:11px;margin-top:8px">How to earn: publish a signal <strong>+10</strong> · gain a follower <strong>+5</strong> · bring a referral <strong>+50/+10</strong> · rate a signal's quality (its author gets <strong>+5</strong>, you get nothing) · weekly top paper trader <strong>+500</strong>. Points are non-spendable until TGE.</p>
    </div>`;
  $('#refCopy')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(d.referralLink).then(() => toast('Referral link copied')).catch(() => toast('Copy failed — select the link manually'));
  });
  $('#bindEvmBtn')?.addEventListener('click', async () => {
    if (!window.ethereum) return toast('MetaMask or another EVM wallet is required');
    const btn = $('#bindEvmBtn');
    btn.disabled = true;
    try {
      await ensureIostL2Wallet();
      aittWalletFlow.chainId = chainIdNumber(await window.ethereum.request({ method: 'eth_chainId' }));
      if (aittWalletFlow.chainId !== AITT_CHAIN_ID) throw new Error('Wrong network. Switch MetaMask to IOST L2 chain 182, then try again.');
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const address = accounts?.[0];
      if (!address) throw new Error('No wallet account selected');
      const challengeRes = await fetch('/api/aitt/wallet/challenge', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok) throw new Error(challenge.error || 'Challenge failed');
      aittWalletFlow.address = address; aittWalletFlow.challenge = challenge; aittWalletFlow.error = ''; aittWalletFlow.notice = 'Review the exact message before signing.';
      await renderPoints();
    } catch (e) {
      aittWalletFlow.challenge = null; aittWalletFlow.error = e?.code === 4001 ? 'Signature or wallet request rejected.' : e.message;
      toast('Wallet binding unavailable: ' + aittWalletFlow.error);
      await renderPoints();
    }
  });
  $('#signEvmBtn')?.addEventListener('click', async () => {
    const btn = $('#signEvmBtn'); const challenge = aittWalletFlow.challenge; const address = aittWalletFlow.address;
    if (!challenge || !address || !window.ethereum) return;
    btn.disabled = true;
    try {
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [challenge.message, address] });
      const verifyRes = await fetch('/api/aitt/wallet/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verified.error || 'Signature verification failed');
      aittWalletFlow.challenge = null; aittWalletFlow.notice = 'Wallet bound to this signed-in account.';
      toast('EVM conversion wallet verified');
      await renderPoints();
    } catch (e) {
      aittWalletFlow.challenge = null; aittWalletFlow.error = e?.code === 4001 ? 'Signature rejected; nothing was bound.' : e.message;
      toast('Wallet binding failed: ' + aittWalletFlow.error);
      await renderPoints();
    }
  });

  // AITT claim — gate-first: while closed the server answers honestly (400 + message), no write.
  $('#claimBtn')?.addEventListener('click', async () => {
    const btn = $('#claimBtn');
    if (!shouldAllowClaim(gate)) return;
    btn.disabled = true;
    try {
      let r;
      const result = await requestClaimIfOpen({ gate, request: async () => { const res = await fetch('/api/points/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }); r = await res.json().catch(() => ({})); if (!res.ok) throw new Error(r.error || r.message || 'Claim unavailable'); } });
      if (!result.sent) return toast(result.reason);
      toast(r.message || 'Claim submitted — see claims status');
    } catch (e) { toast('Claim unavailable: ' + e.message); }
    btn.disabled = false;
  });
}

// ---------------- AITT token (Phase 1: design → IOST L2 deploy) ----------------
// Public view — no sign-in required. Honest framing: design draft, nothing issued.
async function renderAITT() {
  const el = $('#view-aitt');
  el.innerHTML = skeleton();
  let d;
  try { d = await api('/api/aitt/info'); } catch (e) { el.innerHTML = `<div class="card empty">AITT info unavailable: ${esc(e.message)}</div>`; return; }
  let admin = null;
  if (window.Auth?.state?.loggedIn && !window.Auth?.state?.agent) {
    try { admin = await api('/api/admin/aitt/status'); } catch { /* non-owner sessions intentionally see nothing */ }
  }
  const t = d.token || {};
  const conv = d.conversion || {};
  const trade = d.trading || {};
  const ALLOC = [
    ['Ecosystem & agent rewards', 30, '300M', '48-mo linear emission vault'],
    ['Treasury (future DAO policy)', 20, '200M', 'Safe-controlled · 48h queued release'],
    ['Team & core contributors', 15, '150M', '12-mo cliff + 36-mo linear'],
    ['Strategic partners', 10, '100M', 'milestone-gated · contracts only'],
    ['Community & adoption', 10, '100M', 'earned airdrops · grants'],
    ['Reserve fund', 10, '100M', 'insurance · future DAO policy'],
    ['Advisors', 5, '50M', '12-mo cliff + 24-mo linear'],
  ];
  el.innerHTML = `
    <div class="section-title">AITT — Agent Intelligence Trading Token <span class="sub">${esc(d.status === 'deployed' ? 'deployed on IOST L2 · contract verified below' : 'pre-launch review hold · no token created, minted or sold')}</span></div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Total supply</span><span class="k-value">${esc(t.totalSupply || '1,000,000,000')}</span><span class="k-sub">fixed · no minting</span></div>
      <div class="card kpi"><span class="k-label">Standard</span><span class="k-value">ERC-20</span><span class="k-sub">OpenZeppelin-based · custom AMM tax</span></div>
      <div class="card kpi"><span class="k-label">Decimals</span><span class="k-value">${t.decimals ?? 8}</span><span class="k-sub">home chain ${esc(t.chain || 'IOST L2')}</span></div>
      <div class="card kpi"><span class="k-label">Contract</span><span class="k-value">${d.contractAddress ? '<a href="' + esc(d.explorerUrl || '') + '/address/' + esc(d.contractAddress) + '" target="_blank" rel="noopener">' + esc(d.contractAddress.slice(0, 8)) + '…' + esc(d.contractAddress.slice(-6)) + '</a>' : 'pending deploy'}</span><span class="k-sub">full contract suite passing · tooling-reviewed · external audit pending</span></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Allocation <span class="sub">1B fixed-supply design · every pool contract-locked · converter reserve only claimable after gates</span></div>
      ${ALLOC.map(([name, pct, amt, vest]) => `<div class="alloc-row"><span class="alloc-name">${name}</span><span class="alloc-bar"><i style="width:${pct}%"></i></span><span class="alloc-pct mono">${amt} · ${pct}%</span><span class="alloc-vest">${vest}</span></div>`).join('')}
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Utility <span class="sub">future Phase 2+ proposals · not active · holding AITT earns nothing</span></div>
      <div class="util-grid">
        <div class="util"><span class="chip ok">Trust staking</span><p>Agents stake AITT → Trust Score → spend limits. Slashing for unauthorized spend — KYA with teeth.</p></div>
        <div class="util"><span class="chip neut">Fee utility</span><p>Proposed Phase 2+ parameters: 50% discount · 50/20/30 split. Phase 1 pays holders and stakers no revenue, yield, APY, or return. Any future reward mechanism requires a separate audited staking contract, refreshed counsel approval and explicit owner launch, and may never launch.</p></div>
        <div class="util"><span class="chip neut">Governance roadmap</span><p>Phase 2+ target only: stake-weighted voting, quorum and policy controls. Phase 1 has immutable fee ratios and Safe-controlled 48h milestone releases; no on-chain DAO vote or veto.</p></div>
        <div class="util"><span class="chip ok">Agentic payments</span><p>AP2 consent/intent/payment mandates + x402 rails on IOST — Phase 3.</p></div>
      </div>
    </div>
    <div class="card conv-card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Points → AITT conversion <span class="sub">earn-event, not a purchase</span></div>
      <div class="aitt-conv">
        <div class="conv-cell"><span class="k-label">Rate</span><span class="k-value">1:1</span></div>
        <div class="conv-cell"><span class="k-label">Status</span><span class="chip ${conv.open ? 'ok' : 'neut'}">${esc(conv.statusText || 'closed — planned at TGE, not guaranteed')}</span></div>
        <a class="btn sm" href="/whitepaper" target="_blank" rel="noopener">Whitepaper</a>
      </div>
      <p class="muted" style="font-size:11px;margin-top:8px">${esc(d.honesty || '')}</p>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Wallet, explorer &amp; swap <span class="sub">prepared now · fail-closed until verified launch configuration</span></div>
      <div class="aitt-conv">
        <div class="conv-cell"><span class="k-label">Home network</span><span class="k-value">IOST L2 · 182</span></div>
        <div class="conv-cell"><span class="k-label">DEX route</span><span class="chip ${trade.ready ? 'ok' : 'neut'}">${esc(trade.statusText || 'disabled — Phase 4 liquidity is not live')}</span></div>
        <a class="btn sm" href="/aitt#access" target="_blank" rel="noopener">Open wallet dashboard</a>
        ${trade.ready && trade.swapUrl ? `<a class="btn sm" href="${esc(trade.swapUrl)}" target="_blank" rel="noopener">Open PancakeSwap</a>` : '<button class="btn sm" disabled>Swap unavailable</button>'}
      </div>
    </div>
    ${admin ? `<div class="card" style="margin-bottom:16px;border-color:var(--amber)">
      <div class="section-title" style="margin-bottom:8px">Owner operations <span class="sub">read-only · no deploy or gate-flip controls</span></div>
      <div class="stat-cards">
        <div class="card kpi"><span class="k-label">Release gate</span><span class="k-value">${admin.releaseGate?.ready ? 'READY' : 'HOLD'}</span><span class="k-sub">${esc((admin.releaseGate?.failed || []).join(' · ') || 'all checks passed')}</span></div>
        <div class="card kpi"><span class="k-label">Conversion claims</span><span class="k-value">${admin.claims?.length || 0}</span><span class="k-sub">${esc((admin.claims || []).map(c => c.status).join(' · ') || 'no queued claims')}</span></div>
      </div>
    </div>` : ''}
    <div class="card empty" style="text-align:center">Full public page: <a href="/aitt" target="_blank" rel="noopener" style="color:var(--cyan)">iostcallister.com/aitt</a> · Whitepaper: <a href="/whitepaper" target="_blank" rel="noopener" style="color:var(--cyan)">iostcallister.com/whitepaper</a></div>`;
}

// ---------------- Your IOST Wallet (free to open · self-custody) ----------------
// Security model: the Ed25519 keypair is generated in THIS browser (tweetnacl). The
// server only ever receives the PUBLIC key (base64 of the 32-byte pubkey) + account
// name and broadcasts auth.iost/signUp with the platform's funded account. The SECRET
// key is shown exactly once for manual backup and never leaves the page — no server
// custody, no localStorage. Reload after backing up = gone by design (you were warned).
let walletKeys = null; // in-memory keypair between "generate" and "submit" only
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function renderWallet() {
  const el = $('#view-wallet');
  el.innerHTML = skeleton();
  if (!window.Auth?.state?.loggedIn) {
    el.innerHTML = `<div class="card empty">Sign in required — <button class="btn sm" id="authGateBtn">open sign in</button></div>`;
    $('#authGateBtn')?.addEventListener('click', () => window.Auth?.open('login'));
    return;
  }
  const [pub, mine] = await Promise.all([
    api('/api/account/iost/status').catch(() => null),
    api('/api/account/iost').catch((e) => { toast('Wallet status unavailable', e.message); return null; }),
  ]);
  const st = mine?.status || 'none';
  const cfg = pub?.configured ? 'platform funding configured' : 'platform funding not configured yet';
  const statusLabel = st === 'none' ? 'not created' : st;
  const fee = pub?.feeIost ?? 0;
  let body = '';
  if (st === 'none') {
    body = `<div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Create my free wallet <span class="sub">free to open · you hold the keys</span></div>
      <p class="muted" style="max-width:680px;line-height:1.55">Every registered account gets a real IOST mainnet wallet — opening an IOST account is now <strong>free</strong> (no creation fee; official signup at <a href="https://iostaccount.io/en/create" target="_blank" rel="noopener">iostaccount.io ↗</a>). Your browser generates the private key — it is shown to you <strong>once</strong> for backup and <strong>never sent to the server</strong> (only your public key is).</p>
      <div style="margin-top:14px"><button class="btn" id="walletCreate" aria-label="Generate my IOST wallet keys and request creation">Create my free wallet</button></div>
    </div>`;
  } else if (st === 'pending') {
    body = `<div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Wallet queued <span class="chip warn">${esc(cfg)}</span></div>
      <p class="muted" style="max-width:680px;line-height:1.55">Your request is in the queue (account <code class="mono">${esc(mine.accountName || '—')}</code>). It will be created on the IOST mainnet automatically once the platform's funding key is configured. Your public key is stored so the account can be created; your secret key never left your browser.</p>
    </div>`;
  } else if (st === 'created') {
    body = `<div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Wallet created <span class="chip bull">live on IOST</span></div>
      <div class="wallet-row"><span class="muted">account</span><code class="mono">${esc(mine.accountName)}</code></div>
      <div class="wallet-row"><span class="muted">creation tx</span><a class="mono" href="${esc(pub?.explorer || 'https://explorer.iost.io/tx/')}${esc(mine.tx)}" target="_blank" rel="noopener" aria-label="View wallet creation transaction on the IOST explorer">${esc(String(mine.tx).slice(0, 26))}… ↗</a></div>
      ${mine.block ? `<div class="wallet-row"><span class="muted">block</span><span class="mono">${esc(mine.block)}</span></div>` : ''}
      <p class="muted" style="font-size:12px;margin-top:8px;max-width:680px">Created by the platform on your behalf (referrer ${esc(mine.referrer || 'platform account')}). Your secret key was never transmitted — keep the backup you saved when you created it.</p>
    </div>`;
  } else if (st === 'failed') {
    body = `<div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Wallet creation failed <span class="chip bear">needs attention</span></div>
      <p class="muted" style="line-height:1.55;max-width:680px">${esc(mine.error || 'unknown error')}</p>
      <div style="margin-top:14px"><button class="btn" id="walletRetry" aria-label="Retry wallet creation">Retry wallet creation</button></div>
    </div>`;
  }
  el.innerHTML = `
    <div class="section-title">Your IOST Wallet <span class="sub">free to open · self-custody keys · ${esc(pub?.action || 'auth.iost/signUp')}</span></div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Status</span><span class="k-value">${esc(statusLabel)}</span><span class="k-sub">${esc(cfg)}</span></div>
      <div class="card kpi"><span class="k-label">Opening cost</span><span class="k-value">free</span><span class="k-sub">no creation fee · <a href="https://iostaccount.io/en/create" target="_blank" rel="noopener">open at iostaccount.io ↗</a> · <a href="${esc(pub?.explorer || 'https://explorer.iost.io/tx/')}" target="_blank" rel="noopener">explorer ↗</a></span></div>
    </div>
    ${body}
    <div class="card" id="walletFlow" style="display:none"></div>
  `;
  $('#walletCreate')?.addEventListener('click', walletBeginCreate);
  $('#walletRetry')?.addEventListener('click', walletBeginCreate);
}

// step 1 — generate the keypair in-browser and show the secret key ONCE
function walletBeginCreate() {
  if (!window.nacl) { toast('Crypto library not loaded', 'tweetnacl failed to load — hard refresh'); return; }
  walletKeys = window.nacl.sign.keyPair();
  const secB58 = bs58.encode(walletKeys.secretKey);
  const pubB58 = bs58.encode(walletKeys.publicKey);
  const flow = $('#walletFlow');
  flow.style.display = 'block';
  flow.innerHTML = `
    <div class="section-title" style="margin-bottom:8px">Back up your secret key <span class="sub">the only copy that will ever exist</span></div>
    <div class="warn-banner" role="alert" aria-label="Secret key warning">
      <strong>We never see this key.</strong> It was generated in your browser and is shown below <strong>once</strong> — it is not stored by IOST Terminal and cannot be recovered if lost. <strong>Anyone with it controls the wallet</strong> and everything inside. Save it somewhere safe: a password manager, an offline note, or printed paper. Do not share it with anyone.
    </div>
    <div class="field">
      <label for="walletSecret">Your secret key (base58) — copy it now</label>
      <textarea id="walletSecret" class="secret-box mono" rows="2" readonly aria-label="Your secret key — copy it now and store it safely">${esc(secB58)}</textarea>
    </div>
    <div class="field">
      <label for="walletPub">Your public key (base58) — your wallet address</label>
      <input id="walletPub" class="mono" value="${esc(pubB58)}" readonly aria-label="Your public key">
    </div>
    <div class="field">
      <label for="walletName">Account name (optional)</label>
      <input id="walletName" class="mono" maxlength="11" placeholder="u + 8 hex chars (auto-suggested if empty)" autocomplete="off" aria-describedby="walletNameHint">
      <span class="muted" style="font-size:11px" id="walletNameHint">5-11 chars, lowercase a-z, 0-9 or underscore only · leave empty for an auto-generated name</span>
    </div>
    <label class="wallet-check" style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <input type="checkbox" id="walletSaved" aria-label="I saved my secret key somewhere safe">
      <span>I saved my secret key somewhere safe</span>
    </label>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn" id="walletSubmit" disabled aria-label="Request my free IOST wallet">Request my free wallet</button>
      <button class="btn ghost sm" id="walletCancel" aria-label="Cancel wallet creation">Cancel</button>
    </div>`;
  $('#walletSaved').addEventListener('change', (e) => { $('#walletSubmit').disabled = !e.target.checked; });
  $('#walletCancel').addEventListener('click', () => { walletKeys = null; renderWallet(); });
  $('#walletSubmit').addEventListener('click', walletSubmit);
}

// step 2 — send ONLY the public key + name; the secret key never leaves this page
async function walletSubmit() {
  if (!walletKeys) return;
  const name = ($('#walletName')?.value || '').trim();
  const body = { publicKey: b64(walletKeys.publicKey) }; // public ONLY — by design
  if (name) body.accountName = name;
  const btn = $('#walletSubmit');
  btn.disabled = true; btn.textContent = 'Requesting…';
  try {
    const res = await fetch('/api/account/iost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
    walletKeys = null; // wipe the in-memory secret — backup is now the user's responsibility
    toast(d.message || 'Wallet request submitted');
    renderWallet();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Request my free wallet';
    toast('Wallet request failed', e.message);
  }
}

// ---------------- topbar / nav ----------------
function setClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString('en-GB', { hour12: false });
}
setInterval(setClock, 1000); setClock();

$$('.nav-btn[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

function setupNavPalette() {
  const overlay = $('#navPalette'); const input = $('#navPaletteInput'); const results = $('#navPaletteResults');
  const openers = [$('#navSearchBtn'), $('#navSearchMobile')].filter(Boolean); const closeButton = $('#navPaletteClose');
  if (!overlay || !input || !results || !openers.length || !closeButton) return;
  const commands = $$('.sidebar .nav-btn[data-view]').map((button) => ({
    button, view: button.dataset.view, label: button.querySelector('.lbl')?.textContent?.trim() || button.dataset.view,
    group: button.closest('.nav-group')?.dataset.navGroup || 'Terminal', icon: button.querySelector('.ic')?.textContent?.trim() || '›',
    description: button.getAttribute('aria-label') || '',
  }));
  let lastFocus = null;

  const render = () => {
    const query = input.value.trim().toLowerCase();
    const matches = commands.filter((command) => !query || `${command.label} ${command.group} ${command.description}`.toLowerCase().includes(query));
    results.replaceChildren(...matches.map((command) => {
      const option = document.createElement('button');
      option.type = 'button'; option.className = 'nav-palette-option';
      const icon = document.createElement('span'); icon.className = 'nav-palette-icon'; icon.textContent = command.icon;
      const copy = document.createElement('span'); const name = document.createElement('strong'); const group = document.createElement('small');
      name.textContent = command.label; group.textContent = command.group; copy.append(name, group);
      const arrow = document.createElement('span'); arrow.className = 'mono'; arrow.textContent = '→';
      option.append(icon, copy, arrow);
      option.addEventListener('click', () => { close(); switchView(command.view); });
      return option;
    }));
    if (!matches.length) {
      const empty = document.createElement('p'); empty.className = 'nav-palette-empty'; empty.textContent = 'No destination matches that search.';
      results.replaceChildren(empty);
    }
  };
  const anotherDialogIsOpen = () => ['onboardingLayer', 'gateOverlay', 'authModal', 'authReset', 'detailModal']
    .some((id) => { const node = document.getElementById(id); return node && !node.classList.contains('hidden'); });
  const open = () => { if (anotherDialogIsOpen()) return; lastFocus = document.activeElement; overlay.classList.remove('hidden'); input.value = ''; render(); input.focus(); };
  const close = () => { overlay.classList.add('hidden'); lastFocus?.focus?.(); };
  openers.forEach((opener) => opener.addEventListener('click', open)); closeButton.addEventListener('click', close); input.addEventListener('input', render);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); overlay.classList.contains('hidden') ? open() : close(); }
    if (event.key === 'Escape' && !overlay.classList.contains('hidden')) { event.preventDefault(); close(); }
    if (event.key === 'Enter' && document.activeElement === input) results.querySelector('.nav-palette-option')?.click();
    if (event.key === 'Tab' && !overlay.classList.contains('hidden')) {
      const controls = [closeButton, input, ...results.querySelectorAll('.nav-palette-option')];
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}
setupNavPalette();

// ARD: deterministic paths — every view has a stable deep link (/app#scanner, /app#risk, …)
const VALID_VIEWS = ['scanner', 'scores', 'risk', 'portfolio', 'onchain', 'news', 'assistant', 'journal', 'performance', 'evaluation', 'whales', 'smartmoney', 'audit', 'agents', 'control', 'trace', 'points', 'aitt', 'wallet'];
function switchView(view) {
  if (!VALID_VIEWS.includes(view)) view = 'scanner';
  state.activeView = view;
  $$('.nav-btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  refreshView(view);
}
addEventListener('hashchange', () => switchView(location.hash.replace('#', '')));

// ---- landing-page deep link: /app?auth=login&goto=keys → Portfolio → Trading Keys input ----
// "Connect your key" on the landing page lands the user on the Kraken API key input,
// either immediately (already signed in) or right after they finish sign-in.
let pendingGotoKeys = false;
function gotoApiKeyInput() {
  pendingGotoKeys = true;
  if (!window.Auth?.state?.loggedIn) return; // authchange listener will re-fire this
  pendingGotoKeys = false;
  switchView('portfolio');
  const q = new URLSearchParams(location.search);
  q.delete('goto');
  const qs = q.toString();
  history.replaceState(null, '', (qs ? '?' + qs : location.pathname) + '#portfolio');
  const t0 = Date.now();
  (function poll() {
    const el = $('#keyApi');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
      const card = el.closest('.card');
      if (card) { // brief glow so the user sees exactly where to paste their key
        card.style.transition = 'box-shadow .4s';
        card.style.boxShadow = '0 0 0 1px rgba(34,211,170,.8), 0 0 26px rgba(34,211,170,.35)';
        setTimeout(() => { card.style.boxShadow = ''; }, 2600);
      }
      return;
    }
    if (Date.now() - t0 < 8000) setTimeout(poll, 150);
  })();
}
function refreshView(view) {
  // auth-gated views: paper account data (portfolio, journal, performance) + points + wallet
  if (['portfolio', 'journal', 'performance', 'evaluation', 'control', 'trace', 'points', 'wallet'].includes(view) && !window.Auth?.state?.loggedIn) {
    const el = $(`#view-${view}`);
    if (el) el.innerHTML = `<div class="card empty">Sign in required — <button class="btn sm" id="authGateBtn">open sign in</button></div>`;
    $('#authGateBtn')?.addEventListener('click', () => window.Auth?.open('login'));
    if (view === 'portfolio') { // trading-keys card renders only when signed in
      const feeWrap = document.createElement('div');
      el.appendChild(feeWrap);
      renderFeeCard(feeWrap);
    }
    return;
  }
  ({ scanner: renderScanner, scores: renderScores, risk: renderRisk, portfolio: renderPortfolio,
    onchain: renderOnchain, news: renderNews, assistant: renderAssistant, journal: renderJournal, performance: renderPerformance, evaluation: renderEvaluationLab, whales: renderWhales, smartmoney: renderSmartMoney, audit: renderAudit, agents: renderAgents, control: renderAgentControl, trace: renderDecisionTrace, points: renderPoints, aitt: renderAITT, wallet: renderWallet })[view]();
}

// ---------------- Owner Agent Control Center ----------------
// One operational view over the server's existing policy and revocation rails.
// It is intentionally paper-first and never receives API-key or venue secrets.
async function renderAgentControl() {
  const el = $('#view-control');
  el.innerHTML = skeleton();
  let s;
  try { s = await api('/api/agent-control'); }
  catch (e) {
    el.innerHTML = `<div class="card empty">Agent Control Center is available only to the platform owner. <span class="mono">${esc(e.message)}</span></div>`;
    return;
  }
  const ap = s.autopilot || {};
  const last = ap.lastAction;
  const money = (minor) => `$${(Number(minor || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const keys = s.keys || [];
  const agentWallets = s.wallets || [];
  const pacts = s.pacts || [];
  const parentWallet = s.parentWallet || null;
  const paperWallets = agentWallets.filter((w) => w.status === 'active' && (w.capabilities || []).includes('trade.paper'));
  const activePacts = pacts.filter((p) => p.status === 'active');
  const moneyInput = (minor) => ((Number(minor || 0) / 100).toFixed(2));
  el.innerHTML = `
    <div class="section-title">Agent Control Center <span class="sub">owner-only operations · server-enforced limits</span></div>
    <div class="control-boundary" role="status">Execution boundary · <strong>PAPER</strong> · live and on-chain execution remain separately gated</div>
    <div class="grid g-3 control-kpis">
      <div class="card kpi"><span class="k-label">Autonomous agent</span><span class="k-value ${ap.enabled ? 'up' : ''}">${ap.running ? 'WORKING' : ap.enabled ? 'READY' : 'PAUSED'}</span><span class="k-sub">${ap.ticks || 0} ticks · ${ap.dayTrades || 0} paper trades today</span></div>
      <div class="card kpi"><span class="k-label">Active access</span><span class="k-value">${s.keyStats?.active || 0}</span><span class="k-sub">agent keys · ${s.keyStats?.revoked || 0} revoked</span></div>
      <div class="card kpi"><span class="k-label">Pending approvals</span><span class="k-value">${(s.approvals?.paper || 0) + (s.approvals?.live || 0)}</span><span class="k-sub">${s.approvals?.paper || 0} paper · ${s.approvals?.live || 0} live (cannot auto-execute)</span></div>
    </div>
    <section class="card control-activity" aria-labelledby="controlActivityTitle">
      <div class="section-title" id="controlActivityTitle">Agent activity</div>
      <div class="control-activity-grid">
        <div><span class="k-label">Current task</span><strong>${esc(ap.currentTask || 'Unknown')}</strong></div>
        <div><span class="k-label">Last action</span><strong>${esc(last?.type || 'None yet')}</strong><span>${esc(last?.detail || 'No agent action recorded')}</span></div>
      </div>
      <div class="control-actions">
        <button class="btn sm ${ap.enabled ? 'ghost' : 'green'}" id="controlAutopilot">${ap.enabled ? 'Pause agent' : 'Start paper agent'}</button>
        <button class="btn sm ghost" id="controlApproval">${ap.config?.requireApproval ? 'Approval required' : 'Require approval'}</button>
        <button class="btn sm danger" id="controlEmergency">Emergency stop</button>
      </div>
    </section>
    <section class="card" aria-labelledby="controlKeysTitle">
      <div class="section-title" id="controlKeysTitle">Permissions <span class="sub">scoped keys · secrets never displayed here</span></div>
      ${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Scopes</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>${keys.map(k => `<tr>
        <td><strong>${esc(k.name)}</strong><div class="mono muted">${esc(k.prefix)}…</div></td>
        <td>${(k.scopes || []).map(scope => `<span class="chip ${scope === 'trade-live' ? 'warn' : scope === 'trade-paper' ? 'bull' : 'neut'}">${esc(scope)}</span>`).join(' ')}</td>
        <td class="mono">${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}</td>
        <td>${k.revokedAt ? '<span class="chip neut">revoked</span>' : '<span class="chip bull">active</span>'}</td>
        <td>${k.revokedAt ? '' : `<button class="btn sm ghost" data-control-revoke="${esc(k.id)}">Revoke</button>`}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No agent keys created.</div>'}
    </section>
    <section class="card" aria-labelledby="controlBudgetTitle">
      <div class="section-title" id="controlBudgetTitle">Wallet budgets <span class="sub">integer minor-unit rails enforced before agent execution</span></div>
      ${agentWallets.length ? `<div class="control-wallets">${agentWallets.map(w => {
        const lim = w.limits?.USD || {};
        const usage = w.usage || {};
        return `<article class="control-wallet">
          <div class="control-wallet-head"><div><strong>${esc(w.name)}</strong><span class="mono muted">${esc(w.walletId)}</span></div><span class="chip ${w.status === 'active' ? 'bull' : 'warn'}">${esc(w.status)}</span></div>
          <dl><div><dt>Balance</dt><dd>${money(w.balanceMinor)}</dd></div><div><dt>Per trade</dt><dd>${lim.maxPerTxMinor ? money(lim.maxPerTxMinor) : 'Unlimited'}</dd></div><div><dt>Daily used</dt><dd>${money(usage.dailyUsedMinor)} / ${lim.dailyCapMinor ? money(lim.dailyCapMinor) : 'Unlimited'}</dd></div><div><dt>Weekly used</dt><dd>${money(usage.weeklyUsedMinor)} / ${lim.weeklyCapMinor ? money(lim.weeklyCapMinor) : 'Unlimited'}</dd></div></dl>
          <div class="control-capabilities">${(w.capabilities || []).map(c => `<span class="chip neut">${esc(c)}</span>`).join(' ') || '<span class="muted">No execution capabilities</span>'}</div>
          <button class="btn sm ghost" data-wallet-state="${w.status === 'active' ? 'suspend' : 'reactivate'}" data-wallet-id="${esc(w.walletId)}">${w.status === 'active' ? 'Pause wallet' : 'Reactivate wallet'}</button>
        </article>`;
      }).join('')}</div>` : '<div class="empty">No agent wallets configured.</div>'}
    </section>`;

  el.insertAdjacentHTML('beforeend', `
    <section class="card control-paper-setup" aria-labelledby="paperSetupTitle">
      <div class="section-title" id="paperSetupTitle">Paper trade setup <span class="sub">internal paper credits only · no token, bank, exchange, or on-chain transfer</span></div>
      <p class="muted control-setup-note">Create a narrowly funded agent wallet, then propose and explicitly approve a time-limited Pact. The agent cannot use this for live trading or public-chain actions.</p>
      ${paperWallets.length ? `<div class="control-setup-status"><span class="chip bull">paper wallet ready</span> ${paperWallets.length} active wallet${paperWallets.length === 1 ? '' : 's'} · ${activePacts.length} active Pact${activePacts.length === 1 ? '' : 's'}</div>` : ''}
      <form id="controlWalletSetup" class="control-setup-form">
        <label>Wallet name<input id="controlWalletName" maxlength="80" value="MCP Inspector Paper Wallet" required></label>
        <label>Paper credits to fund (USD)<input id="controlWalletFund" type="number" min="1" max="10000" step="0.01" value="100.00" required></label>
        <label>Maximum per paper order (USD)<input id="controlWalletPerOrder" type="number" min="1" max="10000" step="0.01" value="25.00" required></label>
        <label>Daily paper limit (USD)<input id="controlWalletDaily" type="number" min="1" max="10000" step="0.01" value="100.00" required></label>
        <div class="control-setup-actions"><button class="btn sm green" type="submit">${paperWallets.length ? 'Create another bounded wallet' : 'Create paper wallet'}</button><span class="muted">Creates a separate internal ledger with <code>trade.paper</code> only.</span></div>
      </form>
      ${paperWallets.length ? `<form id="controlWalletFundForm" class="control-inline-form">
        <label>Fund wallet<select id="controlFundWallet">${paperWallets.map((w) => `<option value="${esc(w.walletId)}">${esc(w.name)} · ${esc(w.walletId)} · ${moneyInput(w.balanceMinor)} USD</option>`).join('')}</select></label>
        <label>Paper credits (USD)<input id="controlFundAmount" type="number" min="1" max="10000" step="0.01" value="25.00" required></label>
        <button class="btn sm ghost" type="submit">Fund wallet</button>
      </form>` : ''}
    </section>
    <section class="card control-pacts" aria-labelledby="controlPactsTitle">
      <div class="section-title" id="controlPactsTitle">Paper Pacts <span class="sub">a human-approved, wallet-bound authorization with automatic expiry</span></div>
      ${paperWallets.length ? `<form id="controlPactForm" class="control-setup-form">
        <label>Paper wallet<select id="controlPactWallet">${paperWallets.map((w) => `<option value="${esc(w.walletId)}">${esc(w.name)} · ${esc(w.walletId)}</option>`).join('')}</select></label>
        <label>Pact budget (USD)<input id="controlPactBudget" type="number" min="1" max="10000" step="0.01" value="25.00" required></label>
        <label>Expires in hours<input id="controlPactHours" type="number" min="1" max="168" step="1" value="24" required></label>
        <label class="control-wide">Purpose<input id="controlPactIntent" maxlength="500" value="MCP Inspector paper-trade test" required></label>
        <div class="control-setup-actions"><button class="btn sm" type="submit">Propose paper Pact</button><span class="muted">Proposing does not enable trading. Approval is a separate owner action.</span></div>
      </form>` : '<div class="empty">Create an active paper wallet before proposing a Pact.</div>'}
      ${pacts.length ? `<div class="control-pact-list">${pacts.map((p) => {
        const cap = p.policies?.limits?.maxPerTxMinor;
        const expiry = p.expiresAt ? new Date(p.expiresAt).toLocaleString() : p.completion?.type === 'budget' ? 'when budget is used' : 'not set';
        return `<article class="control-pact"><div><strong>${esc(p.intent)}</strong><span class="mono muted">${esc(p.pactId)}</span></div><span class="chip ${p.status === 'active' ? 'bull' : p.status === 'proposed' ? 'warn' : 'neut'}">${esc(p.status)}</span><dl><div><dt>Wallet</dt><dd>${esc(p.agentWalletId || 'none')}</dd></div><div><dt>Budget</dt><dd>${p.completion?.type === 'budget' ? money(p.completion.budgetMinor) : '—'}</dd></div><div><dt>Per order</dt><dd>${cap ? money(cap) : 'Unlimited'}</dd></div><div><dt>Expires</dt><dd>${esc(expiry)}</dd></div></dl><div class="control-pact-actions">${p.status === 'proposed' ? `<button class="btn sm green" data-pact-approve="${esc(p.pactId)}">Approve paper Pact</button>` : ''}${p.status === 'active' ? `<button class="btn sm ghost" data-pact-terminate="${esc(p.pactId)}">End Pact</button>` : ''}</div></article>`;
      }).join('')}</div>` : '<div class="empty">No paper Pacts proposed.</div>'}
    </section>`);

  $('#controlAutopilot')?.addEventListener('click', async () => {
    await post(ap.enabled ? '/api/autopilot/stop' : '/api/autopilot/start', {});
    toast(ap.enabled ? '⏸ Paper agent paused' : '▶ Paper agent started');
    renderAgentControl();
  });
  $('#controlApproval')?.addEventListener('click', async () => {
    await post('/api/autopilot/config', { requireApproval: !ap.config?.requireApproval });
    toast(!ap.config?.requireApproval ? '✓ Human approval is now required' : 'Approval mode disabled for paper execution');
    renderAgentControl();
  });
  $('#controlEmergency')?.addEventListener('click', async () => {
    if (!confirm('Emergency stop: pause the agent, suspend every agent wallet, cancel open live orders, and disable live execution?')) return;
    const r = await post('/api/agent-control/emergency-stop', {});
    toast(`⛔ Emergency stop complete · ${r.suspendedWallets?.length || 0} wallet(s) suspended`);
    renderAgentControl();
  });
  el.querySelectorAll('[data-control-revoke]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Revoke this agent key? It will stop working immediately.')) return;
    await api(`/api/agent-keys/${b.dataset.controlRevoke}`, { method: 'DELETE' });
    toast('🔑 Agent key revoked'); renderAgentControl();
  }));
  el.querySelectorAll('[data-wallet-state]').forEach(b => b.addEventListener('click', async () => {
    await post(`/api/wallets/${b.dataset.walletId}/${b.dataset.walletState}`, {});
    toast(b.dataset.walletState === 'suspend' ? '⏸ Agent wallet paused' : '✓ Agent wallet reactivated');
    renderAgentControl();
  }));
  $('#controlWalletSetup', el)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fundMinor = Math.round(Number($('#controlWalletFund', el).value) * 100);
    const perOrderMinor = Math.round(Number($('#controlWalletPerOrder', el).value) * 100);
    const dailyMinor = Math.round(Number($('#controlWalletDaily', el).value) * 100);
    const name = $('#controlWalletName', el).value.trim();
    if (!name || !Number.isSafeInteger(fundMinor) || !Number.isSafeInteger(perOrderMinor) || !Number.isSafeInteger(dailyMinor) || fundMinor <= 0 || perOrderMinor <= 0 || dailyMinor < perOrderMinor || fundMinor < perOrderMinor) {
      return toast('Paper wallet needs positive amounts; daily and funded amounts must cover one order.');
    }
    if (!confirm(`Create a paper-only wallet funded with ${money(fundMinor)} internal credits? It cannot access real funds, tokens, or a blockchain.`)) return;
    try {
      const created = await post('/api/wallets', { name, limits: { USD: { maxPerTxMinor: perOrderMinor, dailyCapMinor: dailyMinor, weeklyCapMinor: dailyMinor * 7 } }, capabilities: ['trade.paper'], approvalRequired: true });
      const available = Number(parentWallet?.balanceMinor || 0);
      if (available < fundMinor) await post('/api/wallets/credit', { amountMinor: fundMinor - available });
      await post(`/api/wallets/${created.wallet.walletId}/fund`, { amountMinor: fundMinor });
      toast('✓ Paper wallet created and funded', 'Only internal paper credits were added.');
      renderAgentControl();
    } catch (e) { toast(`Paper wallet setup failed: ${esc(e.message)}`); }
  });
  $('#controlWalletFundForm', el)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const walletId = $('#controlFundWallet', el).value;
    const amountMinor = Math.round(Number($('#controlFundAmount', el).value) * 100);
    if (!walletId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return toast('Enter a positive paper-credit amount.');
    if (!confirm(`Fund this paper wallet with ${money(amountMinor)} internal credits?`)) return;
    try {
      const available = Number(parentWallet?.balanceMinor || 0);
      if (available < amountMinor) await post('/api/wallets/credit', { amountMinor: amountMinor - available });
      await post(`/api/wallets/${walletId}/fund`, { amountMinor });
      toast('✓ Paper wallet funded', 'No real-money or token transfer occurred.');
      renderAgentControl();
    } catch (e) { toast(`Funding failed: ${esc(e.message)}`); }
  });
  $('#controlPactForm', el)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const agentWalletId = $('#controlPactWallet', el).value;
    const budgetMinor = Math.round(Number($('#controlPactBudget', el).value) * 100);
    const hours = Math.round(Number($('#controlPactHours', el).value));
    const intent = $('#controlPactIntent', el).value.trim();
    if (!agentWalletId || !intent || !Number.isSafeInteger(budgetMinor) || budgetMinor <= 0 || !Number.isSafeInteger(hours) || hours < 1 || hours > 168) return toast('Enter a valid paper Pact budget, purpose, and expiry.');
    if (!confirm(`Propose a ${money(budgetMinor)} paper-only Pact that expires in ${hours} hour(s)? It will still require separate owner approval.`)) return;
    try {
      await post('/api/pacts', { agentWalletId, intent, plan: [{ step: 'Open a user-requested paper position through the paper broker only.' }], policies: { approvalRequired: true, limits: { maxPerTxMinor: budgetMinor }, whitelist: { recipients: [], protocols: [] } }, completion: { type: 'time', deadlineTs: Date.now() + hours * 3600_000 } });
      toast('✓ Paper Pact proposed', 'Approve it below before an agent can open a paper position.');
      renderAgentControl();
    } catch (e) { toast(`Pact proposal failed: ${esc(e.message)}`); }
  });
  el.querySelectorAll('[data-pact-approve]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Approve this wallet-bound Pact for paper trading only? It does not enable live, token, or on-chain execution.')) return;
    try { await post(`/api/pacts/${b.dataset.pactApprove}/approve`, {}); toast('✓ Paper Pact approved'); renderAgentControl(); }
    catch (e) { toast(`Pact approval failed: ${esc(e.message)}`); }
  }));
  el.querySelectorAll('[data-pact-terminate]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('End this paper Pact now? Future agent paper orders using it will be blocked.')) return;
    try { await post(`/api/pacts/${b.dataset.pactTerminate}/terminate`, {}); toast('Paper Pact ended'); renderAgentControl(); }
    catch (e) { toast(`Could not end Pact: ${esc(e.message)}`); }
  }));
}

// ---------------- Agent Decision Trace (read-only) ----------------
// Explains what the autonomous loop observed, which policy gate applied, and
// whether the result stayed paper-only or is waiting for explicit approval.
async function renderDecisionTrace() {
  const el = $('#view-trace');
  el.innerHTML = skeleton();
  let s;
  try { s = await api('/api/autopilot'); }
  catch (e) { el.innerHTML = `<div class="card empty">Decision trace unavailable: ${esc(e.message)}</div>`; return; }
  const cfg = s.config || {};
  const actions = (s.actions || []).slice(0, 25);
  const proposals = s.proposals || [];
  const typeClass = (type) => type === 'entry' ? 'bull' : ['halt', 'error', 'halt-close'].includes(type) ? 'bear' : ['proposal', 'skip', 'exit', 'reject'].includes(type) ? 'warn' : 'neut';
  const stage = (type) => ({ start: 'Operator', stop: 'Operator', config: 'Policy', proposal: 'Approval', entry: 'Paper execution', exit: 'Paper execution', skip: 'Risk gate', halt: 'Risk gate', 'halt-close': 'Risk gate', reject: 'Approval', error: 'Fail closed' }[type] || 'Agent loop');
  el.innerHTML = `
    <div class="section-title">Agent Decision Trace <span class="sub">evidence → policy → approval → paper execution</span></div>
    <div class="trace-safety" role="status">PAPER-FIRST · READ-ONLY TRACE · LIVE AND ON-CHAIN ACTIONS REMAIN SEPARATELY DISABLED</div>
    <ol class="trace-pipeline" aria-label="Autonomous decision pipeline">
      ${[
        ['1', 'Observe', 'Market, news and on-chain inputs'],
        ['2', 'Score', `Composite ≥ ${cfg.openMinScore ?? '—'} · risk ≥ ${cfg.openMaxRisk ?? '—'}`],
        ['3', 'Risk gate', `R:R ≥ ${cfg.minRr ?? '—'} · ${cfg.accountRiskPct ?? '—'}% risk · halt ${cfg.dailyLossHaltPct ?? '—'}%`],
        ['4', 'Approval', cfg.requireApproval ? 'Human approval required before execution' : 'Paper mode may execute inside policy'],
        ['5', 'Paper execute', 'Simulation broker only in this trace'],
        ['6', 'Journal', 'Outcome and reasoning retained for review'],
      ].map(([n, title, detail]) => `<li><span class="trace-num mono">${n}</span><strong>${title}</strong><span>${detail}</span></li>`).join('')}
    </ol>
    <div class="grid g-3 trace-stats">
      <div class="card kpi"><span class="k-label">Agent state</span><span class="k-value">${s.enabled ? 'RUNNING' : 'IDLE'}</span><span class="k-sub">${s.ticks || 0} completed ticks</span></div>
      <div class="card kpi"><span class="k-label">Approval queue</span><span class="k-value">${proposals.length}</span><span class="k-sub">pending · nothing here approves an action</span></div>
      <div class="card kpi"><span class="k-label">Execution boundary</span><span class="k-value">PAPER</span><span class="k-sub">read-only evidence view</span></div>
    </div>
    ${proposals.length ? `<section class="card trace-proposals" aria-labelledby="traceProposalTitle">
      <div class="section-title" id="traceProposalTitle">Awaiting human approval <span class="sub">inspect only — approve/reject controls remain in the owner workflow</span></div>
      <div class="trace-proposal-grid">${proposals.map(p => `<article>
        <div><strong>${esc(p.symbol)}</strong> <span class="chip warn">${esc(p.side)}</span> <span class="chip neut">confidence ${p.confidence ?? '—'}</span></div>
        <p>${esc(p.reason || 'No reasoning supplied')}</p>
        <dl><div><dt>Entry</dt><dd>${p.entry ?? '—'}</dd></div><div><dt>Stop</dt><dd>${p.stop ?? '—'}</dd></div><div><dt>Target</dt><dd>${p.target ?? '—'}</dd></div><div><dt>R:R</dt><dd>${p.rr != null ? Number(p.rr).toFixed(2) : '—'}</dd></div></dl>
      </article>`).join('')}</div>
    </section>` : ''}
    <section class="card" aria-labelledby="traceLogTitle">
      <div class="section-title" id="traceLogTitle">Recent reasoning <span class="sub">newest first · server-owned audit trail</span></div>
      ${actions.length ? `<ol class="trace-log">${actions.map(a => `<li>
        <time class="mono" datetime="${new Date(a.ts).toISOString()}">${new Date(a.ts).toLocaleString()}</time>
        <span class="chip ${typeClass(a.type)}">${esc(a.type)}</span>
        <strong>${esc(stage(a.type))}</strong>
        <span class="trace-symbol mono">${esc(a.symbol || 'SYSTEM')}</span>
        <p>${esc(a.detail || 'No detail')}</p>
        <span class="mono trace-score">${a.score == null ? '—' : `score ${a.score}`}</span>
      </li>`).join('')}</ol>` : '<div class="empty">No decisions yet. The trace will populate after the paper agent runs.</div>'}
    </section>`;
}

// ---------------- helpers ----------------
function biasChip(biasLabel) {
  const dir = /bull/i.test(biasLabel) ? 'bull' : /bear/i.test(biasLabel) ? 'bear' : 'neut';
  return `<span class="chip ${dir}">${esc(biasLabel)}</span>`;
}
function sigChips(signals) {
  if (!signals?.length) return '<span class="dim">—</span>';
  return `<div class="sig-row">${signals.slice(0, 6).map(s =>
    `<span class="sig ${s.direction === 'bullish' ? 'bull' : s.direction === 'bearish' ? 'bear' : ''}" title="${esc(s.detail)}">${esc(s.label)}</span>`).join('')}</div>`;
}
function skeleton() { return '<div class="card"><div class="skeleton" style="height:240px"></div></div>'; }

function scoreBar(label, val, color) {
  const c = color || (val >= 60 ? 'var(--up)' : val >= 45 ? 'var(--warn)' : 'var(--down)');
  return `<div class="subscore"><span class="lbl">${label}</span><div class="bar"><i style="width:${val}%;background:${c}"></i></div><span class="val">${val}</span></div>`;
}

// ---------------- Scanner ----------------
async function renderScanner(fromTick = false) {
  const el = $('#view-scanner');
  el.innerHTML = skeleton();
  try {
    state.scan = await api('/api/scanner');
  } catch (e) { el.innerHTML = `<div class="card empty">Scanner unavailable: ${esc(e.message)}</div>`; return; }
  const prevPrices = state._prices || {};
  const [probs, global, movers] = await Promise.all([
    api('/api/probability').catch(() => []),
    api('/api/market/global').catch(() => ({})),
    api('/api/market/movers').catch(() => ({ gainers: [], losers: [] })),
  ]);
  state.global = global; state.movers = movers;
  const probBySym = Object.fromEntries(probs.map(p => [p.symbol, p]));
  const fmtCap = (n) => n == null ? '—' : n >= 1e12 ? '$' + (n / 1e12).toFixed(2) + 'T' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n);
  const fg = global.fearGreed;
  const fgCls = fg == null ? 'neut' : fg <= 25 ? 'down' : fg <= 45 ? 'warn' : fg <= 55 ? 'warn' : fg <= 75 ? 'up' : 'up';
  const fgLabel = global.fearGreedLabel || '—';
  const cmc = global.cmc && global.cmc.enabled ? global.cmc : null;
  const domBtc = cmc ? cmc.btcDominance : global.btcDominance;
  const domEth = cmc ? cmc.ethDominance : null;
  const moverRow = (m) => `<tr class="clickable" data-sym="${esc(m.symbol)}" role="button" tabindex="0" aria-label="Open ${esc(m.symbol)} asset details"><td><strong>${esc(m.symbol)}</strong></td><td class="mono">$${fmtNum(m.price)}</td><td class="mono ${m.change24hPct >= 0 ? 'up' : 'down'}">${pct(m.change24hPct)}</td></tr>`;
  const priceCls = (sym, price) => {
    const p = prevPrices[sym];
    if (p == null || p === price) return '';
    return price > p ? 'flash-up' : 'flash-down';
  };
  const rows = state.scan.map((a, i) => `
    <tr class="clickable anim-row" role="button" tabindex="0" aria-label="Open ${esc(a.symbol)} asset details" data-sym="${a.symbol}" style="animation-delay:${fromTick ? 0 : Math.min(i * 20, 320)}ms">
      <td><strong>${a.symbol}</strong> <span class="chip ${a.type === 'stock' ? 'acc' : 'neut'}">${a.type}</span></td>
      <td class="mono dim">${a.rank != null ? '#' + a.rank : '—'}</td>
      <td class="mono">${a.marketCap != null ? fmtCap(a.marketCap) : '—'}</td>
      <td class="mono ${priceCls(a.symbol, a.price)}">${fmtPrice(a.price, a.type)}</td>
      <td>${probBySym[a.symbol] ? `<span class="prob-badge ${probBySym[a.symbol].direction}" style="font-size:11px;padding:2px 8px">${Math.round(probBySym[a.symbol].probUp * 100)}% ${probBySym[a.symbol].direction === 'bullish' ? '↑' : probBySym[a.symbol].direction === 'bearish' ? '↓' : '→'}</span>` : '—'}</td>
      <td class="mono ${a.change24hPct >= 0 ? 'up' : 'down'}">${pct(a.change24hPct)}</td>
      <td>${biasChip(a.biasLabel)}</td>
      <td>${sigChips(a.signals)}</td>
      <td class="mono">${a.indicators.rsi != null ? a.indicators.rsi.toFixed(1) : '—'}</td>
      <td class="mono">${a.indicators.volZ != null ? a.indicators.volZ.toFixed(1) : '—'}</td>
      <td class="mono">${a.whale.bigTrades24h || 0}</td>
      <td class="mono">${a.indicators.atrPct != null ? a.indicators.atrPct.toFixed(2) + '%' : '—'}</td>
      <td class="muted mono">${timeAgo(a.ts)}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="section-title">AI Market Scanner <span class="sub">real-time · unusual volume · breakouts · RSI/MACD · S/R · MA crosses · volatility · whale activity</span></div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Total market cap</span><span class="k-value">${fmtCap(global.totalMcapUsd)}</span><span class="k-sub">${global.activeCoins != null ? global.activeCoins.toLocaleString() + ' coins' : ''} · ${global.markets != null ? global.markets + ' markets' : ''}</span></div>
      <div class="card kpi"><span class="k-label">BTC dominance</span><span class="k-value">${domBtc != null ? domBtc.toFixed(1) + '%' : '—'}</span><span class="k-sub">${domEth != null ? 'ETH ' + domEth.toFixed(1) + '%' : 'share of total market cap'}${cmc ? ' · CMC' : ''}</span></div>
      <div class="card kpi"><span class="k-label">24h volume</span><span class="k-value">${fmtCap(global.volume24hUsd)}</span><span class="k-sub">across all markets</span></div>
      <div class="card kpi"><span class="k-label">Fear & Greed</span><span class="k-value ${fgCls}">${fg != null ? fg : '—'}</span><span class="k-sub">${esc(fgLabel)} · alternative.me</span></div>
    </div>
    <div class="grid g-2" style="margin:14px 0">
      <div class="card">
        <div class="section-title" style="margin-bottom:8px">Top Gainers <span class="sub">24h · top-80 by mcap</span></div>
        <table class="ob-table" style="font-size:12px"><tbody>${(movers.gainers || []).map(moverRow).join('') || '<tr><td class="dim">—</td></tr>'}</tbody></table>
      </div>
      <div class="card">
        <div class="section-title" style="margin-bottom:8px">Top Losers <span class="sub">24h · top-80 by mcap</span></div>
        <table class="ob-table" style="font-size:12px"><tbody>${(movers.losers || []).map(moverRow).join('') || '<tr><td class="dim">—</td></tr>'}</tbody></table>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Asset</th><th>Rank</th><th>Mkt Cap</th><th>Price</th><th>Prob ↑</th><th>24h</th><th>Bias</th><th>Signals</th><th>RSI</th><th>Vol Z</th><th>Whale</th><th>ATR%</th><th>Updated</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  $$('#view-scanner tr.clickable').forEach(tr => {
    const activate = () => openDetail(tr.dataset.sym);
    tr.addEventListener('click', activate);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
  });
  state._prices = Object.fromEntries(state.scan.map(a => [a.symbol, a.price]));
  buildTicker();
  if (!fromTick) {
    renderTickerContent();
    checkWhales();
    if (!state.news) api('/api/news').then(n => { state.news = n; renderTickerContent(); }).catch(() => {});
  } else {
    updateTickerPrices();
    checkWhales();
  }
}

// ---------------- Asset detail modal (progressive disclosure: L1/L2/L3) ----------------
// L1 Overview: binary event card + payout. L2 Analysis: probability timeline +
// candlesticks + history + sizing. L3 Pro/Agent: order book depth + contract spec + raw API logs.
async function openDetail(symbol) {
  const modal = $('#detailModal');
  $('#detailBody').innerHTML = '<div class="skeleton" style="height:300px"></div>';
  openDetailDialog(`${symbol} asset details`);
  const [klines, score, probs, paper] = await Promise.all([
    api(`/api/klines/${symbol}?bar=15m&limit=200`).catch(() => []),
    api(`/api/score/${symbol}`).catch(() => null),
    api('/api/probability').catch(() => []),
    api('/api/paper').catch(() => null),
  ]);
  const a = state.scan.find(x => x.symbol === symbol) || { type: 'crypto', signals: [], whale: {} };
  const s = score?.subscores || {};
  const prob = probs.find(p => p.symbol === symbol) || null;
  const pctVal = prob ? Math.round(prob.probUp * 100) : null;
  const ci = prob ? `${Math.round(prob.ciLo * 100)}–${Math.round(prob.ciHi * 100)}%` : '—';
  const dirCls = prob?.direction || 'neutral';
  const price = score?.price ?? a.price;
  const history = (paper?.journal || []).filter(j => j.symbol === symbol).slice(-5).reverse();

  const body = `
    <button class="modal-close" aria-label="Close">✕</button>
    <div class="modal-head">
      <h3>${symbol} <span class="muted mono" style="font-size:13px">${fmtPrice(price, a.type)}</span>
        ${score ? ` <span class="chip ${score.grade.includes('Avoid') ? 'bear' : score.composite >= 65 ? 'bull' : 'neut'}">${score.composite}/100 ${score.grade}</span>` : ''}</h3>
      ${pctVal != null ? `<span class="prob-badge ${dirCls}">${pctVal}% upside · CI ${ci}</span>` : ''}
      <span class="dual-price">price $${fmtPrice(price, a.type)} <b>≈ ${pctVal ?? '—'}%</b> probability of upside</span>
    </div>
    ${prob?.drivers?.length ? `<div class="drivers">Signal triggered by: ${prob.drivers.map(d => `<span class="chip">${esc(d)}</span>`).join(' ')}</div>` : ''}

    <div class="tabs" role="tablist" aria-label="Progressive disclosure layers">
      <button class="tab is-active" id="detail-tab-overview" data-tab="overview" role="tab" aria-controls="tab-overview" aria-selected="true" tabindex="0">Overview<span class="lv">L1</span></button>
      <button class="tab" id="detail-tab-analysis" data-tab="analysis" role="tab" aria-controls="tab-analysis" aria-selected="false" tabindex="-1">Analysis<span class="lv">L2</span></button>
      <button class="tab" id="detail-tab-pro" data-tab="pro" role="tab" aria-controls="tab-pro" aria-selected="false" tabindex="-1">Pro / Agent<span class="lv">L3</span></button>
    </div>

    <div class="tab-panel" id="tab-overview" role="tabpanel" aria-labelledby="detail-tab-overview">
      <div class="card" style="padding:16px">
        <div class="section-title">Event — ${symbol}/USDT <span class="sub">binary outcome · paper execution</span></div>
        <div class="prob-gauge" aria-hidden="true"><i style="width:${pctVal ?? 50}%"></i><span class="marker" style="left:${pctVal ?? 50}%"></span></div>
        <div class="prob-scale"><span>0%</span><span>50%</span><span>100%</span></div>
        <p style="font-size:13px;color:var(--muted);margin-top:10px">AI assigns a <b style="color:var(--text)">${pctVal ?? '—'}% probability of upside</b> (confidence interval ${ci}) over the current setup horizon.
          <span class="payout-line">Payout (paper): risk <b>1.00 USDT</b> → target <b>≈ 2.00 USDT</b> at R:R 2.0 · <b>${pctVal ?? '—'}%</b> edge to the long side.</span></p>
        <div class="grid g-4" style="margin-top:14px">
          <button class="btn green sm" id="dTradeLong">Buy / Long (paper)</button>
          <button class="btn red sm" id="dTradeShort">Sell / Short (paper)</button>
          <button class="btn ghost sm" id="dAsk">Ask assistant</button>
          <button class="btn ghost sm" id="dClose">Close</button>
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="section-title">AI Trade Score breakdown <span class="sub">why the machine voted</span></div>
        ${scoreBar('Momentum', s.momentum, 'var(--accent)')}
        ${scoreBar('Technical', s.technical, 'var(--accent)')}
        ${scoreBar('Volume', s.volume, 'var(--accent)')}
        ${scoreBar('News sentiment', s.news, 'var(--accent)')}
        ${scoreBar('On-chain', s.onchain, 'var(--accent)')}
        ${scoreBar('Risk (100 = low)', s.risk, 'var(--up)')}
      </div>
    </div>

    <div class="tab-panel hidden" id="tab-analysis" role="tabpanel" aria-labelledby="detail-tab-analysis">
      <div class="card" style="padding:16px">
        <div class="section-title">Probability timeline <span class="sub">upside probability · CI band · 50% midline</span></div>
        <canvas class="prob-chart" id="probChart" aria-label="Probability timeline chart for ${symbol}"></canvas>
        <div class="section-title" style="margin-top:16px">Candlesticks <span class="sub">15m · ${symbol}/USDT</span></div>
        <div id="detailChart" style="height:220px"></div>
      </div>
      <div class="grid g-2" style="margin-top:12px">
        <div class="card">
          <div class="section-title">Recent trade history <span class="sub">paper journal · ${symbol}</span></div>
          ${history.length ? `<div style="max-height:260px;overflow:auto"><table class="ob-table" style="font-size:11.5px"><thead><tr><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Result</th></tr></thead><tbody>
            ${history.map(h => `<tr><td>${esc(h.side || 'long')}</td><td>${fmtPrice(h.entry, a.type)}</td><td>${h.exitPrice != null ? fmtPrice(h.exitPrice, a.type) : '—'}</td><td class="${(h.pnl || 0) >= 0 ? 'up' : 'down'}">${h.pnl != null ? h.pnl.toFixed(2) : '—'}</td><td class="muted">${esc(h.result || (h.closedAt ? 'closed' : 'open'))}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="muted" style="font-size:12px">No paper trades for this symbol yet.</div>'}
        </div>
        <div class="card">
          <div class="section-title">Position sizing <span class="sub">risk engine</span></div>
          <div class="mini-form">
            <div><label for="szAccount">Account size</label><input id="szAccount" type="number" value="100000"></div>
            <div><label for="szRisk">Max risk %</label><input id="szRisk" type="number" value="1" step="0.1"></div>
            <div><label for="szEntry">Entry</label><input id="szEntry" type="number" step="any" value="${price ?? ''}"></div>
            <div><label for="szStop">Stop loss</label><input id="szStop" type="number" step="any" value="${(price * 0.98).toFixed(price < 0.01 ? 6 : 2)}"></div>
          </div>
          <button class="btn sm ghost" id="szCalc">Calculate size</button>
          <div id="szOut" class="mono" style="font-size:12px;margin-top:10px;color:var(--muted)">Enter parameters and hit Calculate.</div>
        </div>
      </div>
    </div>

    <div class="tab-panel hidden" id="tab-pro" role="tabpanel" aria-labelledby="detail-tab-pro">
      <div class="card" style="padding:16px">
        <div class="section-title">Level 3 — order book depth <span class="sub">OKX SPOT ${symbol}/USDT · top 12 levels</span></div>
        <div id="obBody"><div class="muted" style="font-size:12px">loading…</div></div>
      </div>
      <div class="grid g-2" style="margin-top:12px">
        <div class="card">
          <div class="section-title">Contract specification <span class="sub">OKX instruments · for algorithmic verification</span></div>
          <div id="specBody"><div class="muted" style="font-size:12px">loading…</div></div>
        </div>
        <div class="card">
          <div class="section-title">Raw API logs <span class="sub">audit trail + analyze payload</span></div>
          <div class="agent-log" id="auditBody" style="margin-bottom:8px">loading…</div>
          <div class="section-title" style="margin-top:10px">Raw /api/analyze payload</div>
          <pre class="pre-block" id="rawBody">loading…</pre>
        </div>
      </div>
    </div>`;
  $('#detailBody').innerHTML = body;
  $('#detailBody .modal-close').onclick = closeDetail;
  $('#dClose').onclick = closeDetail;
  $('#dTradeLong').onclick = () => { closeDetail(); openTradeModal(symbol, 'long', score?.composite); };
  $('#dTradeShort').onclick = () => { closeDetail(); openTradeModal(symbol, 'short', score?.composite); };
  $('#dAsk').onclick = () => { closeDetail(); switchView('assistant'); askAssistant(`why is ${symbol} moving today?`); };

  const activateDetailTab = (btn) => {
    const t = btn.dataset.tab;
    $$('#detailBody .tab').forEach(b => { const active = b.dataset.tab === t; b.classList.toggle('is-active', active); b.setAttribute('aria-selected', active ? 'true' : 'false'); b.tabIndex = active ? 0 : -1; });
    $$('#detailBody .tab-panel').forEach(p => p.classList.add('hidden'));
    $(`#tab-${t}`).classList.remove('hidden');
    if (t === 'analysis') initAnalysis();
    if (t === 'pro') loadProLayer();
  };
  $$('#detailBody .tab').forEach((btn, index, tabs) => {
    btn.addEventListener('click', () => activateDetailTab(btn));
    btn.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1]
        : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      activateDetailTab(target); target.focus();
    });
  });

  let analysisInited = false;
  async function initAnalysis() {
    if (analysisInited) return;
    analysisInited = true;
    drawProbChart($('#probChart'), await api(`/api/probability/${symbol}/history`).catch(() => ({ samples: [] })), pctVal);
    if (klines.length && window.LightweightCharts) {
      const chart = LightweightCharts.createChart($('#detailChart'), {
        layout: { background: { color: 'transparent' }, textColor: '#8b98a5', fontFamily: 'JetBrains Mono' },
        grid: { vertLines: { color: '#121a23' }, horzLines: { color: '#121a23' } },
        timeScale: { borderColor: '#1c2530' }, rightPriceScale: { borderColor: '#1c2530' },
        width: $('#detailChart').clientWidth, height: 220,
      });
      chart.addCandlestickSeries({ upColor: '#22d3aa', downColor: '#f85149', borderVisible: false, wickUpColor: '#22d3aa', wickDownColor: '#f85149' })
        .setData(klines.map(k => ({ time: Math.floor(k.ts / 1000), open: k.o, high: k.h, low: k.l, close: k.c })));
      chart.timeScale().fitContent();
      new ResizeObserver(() => chart.applyOptions({ width: $('#detailChart').clientWidth })).observe($('#detailChart'));
    }
    $('#szCalc').onclick = async () => {
      const out = $('#szOut');
      out.textContent = 'calculating…';
      try {
        const r = await api('/api/risk', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountSize: +$('#szAccount').value, maxRiskPct: +$('#szRisk').value, entryPrice: +$('#szEntry').value, stopLoss: +$('#szStop').value, targetPrice: price * 1.04, side: 'long' }),
        });
        if (!r.ok) { out.textContent = 'invalid inputs'; return; }
        out.innerHTML = `size <b style="color:var(--text)">${r.positionSize.toLocaleString('en-US', { maximumFractionDigits: 4 })}</b> · $risk <b>${r.dollarRisk}</b> · notional <b>${r.notional.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b> · R:R <b>${r.rr ?? '—'}</b> · pot. P/L <b>${r.potentialProfit ?? '—'}</b>`;
      } catch { out.textContent = 'risk calc failed'; }
    };
  }
  async function loadProLayer() {
    const [book, spec, audit, raw] = await Promise.all([
      api(`/api/orderbook/${symbol}`).catch(() => null),
      api(`/api/contracts/${symbol}`).catch(() => null),
      api('/api/audit').catch(() => null),
      api(`/api/analyze/${symbol}`).catch(() => null),
    ]);
    $('#obBody').innerHTML = book ? orderBookHTML(book) : '<div class="muted" style="font-size:12px">No CLOB depth for this symbol (crypto only via OKX).</div>';
    $('#specBody').innerHTML = spec
      ? `<div class="spec-grid">${Object.entries(spec).map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span>`).join('')}</div>`
      : '<div class="muted" style="font-size:12px">No contract spec for this symbol (crypto only via OKX).</div>';
    $('#auditBody').innerHTML = audit?.entries?.length
      ? audit.entries.slice(0, 8).map(e => `<div><b>${e.method} ${esc(e.path)}</b> · ${e.status} · ${new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false })} · ${esc(e.key || 'anon')}</div>`).join('')
      : 'no API calls logged yet';
    $('#rawBody').textContent = JSON.stringify(raw, null, 2).slice(0, 3000);
  }
}
function orderBookHTML(book) {
  const row = (x, cls) => `<tr class="${cls}"><td>${x.price}</td><td>${x.size.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td></tr>`;
  return `<div style="max-height:300px;overflow:auto"><table class="ob-table">
    <thead><tr><th>Price</th><th>Size</th></tr></thead>
    <tbody>
      ${book.asks.slice().reverse().map(x => row(x, 'ask')).join('')}
      <tr class="ob-head"><td colspan="2">— spread ${((book.asks[0]?.price ?? 0) - (book.bids[0]?.price ?? 0)).toFixed(6)} —</td></tr>
      ${book.bids.map(x => row(x, 'bid')).join('')}
    </tbody></table></div>`;
}
function drawProbChart(cv, data, currentPct) {
  if (!cv) return;
  const dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const samples = (data?.samples || []).filter(s => typeof s.probUp === 'number');
  if (!samples.length && currentPct != null) samples.push({ t: Date.now(), probUp: currentPct / 100, ciLo: Math.max(0.2, currentPct / 100 - 0.05), ciHi: Math.min(0.8, currentPct / 100 + 0.05) });
  if (!samples.length) { ctx.fillStyle = 'rgba(232,241,248,.4)'; ctx.font = '11px JetBrains Mono'; ctx.fillText('collecting probability samples…', 12, h / 2); return; }
  const y = v => h - 4 - Math.max(0, Math.min(1, (v - 0.2) / 0.6)) * (h - 8);
  const x = i => i * (w / Math.max(1, samples.length - 1));
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, y(0.5)); ctx.lineTo(w, y(0.5)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(0,229,255,.10)';
  ctx.beginPath();
  samples.forEach((s, i) => { i ? ctx.lineTo(x(i), y(s.ciLo)) : ctx.moveTo(x(i), y(s.ciLo)); });
  for (let i = samples.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(samples[i].ciHi));
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(0,229,255,.6)'; ctx.shadowBlur = 6;
  ctx.beginPath();
  samples.forEach((s, i) => { i ? ctx.lineTo(x(i), y(s.probUp)) : ctx.moveTo(x(i), y(s.probUp)); });
  ctx.stroke(); ctx.shadowBlur = 0;
  const last = samples[samples.length - 1];
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x(samples.length - 1), y(last.probUp), 3, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(232,241,248,.6)'; ctx.font = '10px JetBrains Mono';
  ctx.fillText('50%', 4, y(0.5) - 3);
  ctx.fillText(`${Math.round(last.probUp * 100)}% now`, Math.max(4, w - 56), Math.max(10, y(last.probUp) - 6));
}
function closeDetail() {
  const m = $('#detailModal');
  if (!m || m.classList.contains('hidden')) return;
  if (m.classList.contains('closing')) return;
  m.classList.add('closing');
  setTimeout(() => {
    m.classList.remove('closing'); m.classList.add('hidden');
    detailLastFocus?.focus({ preventScroll: true });
    detailLastFocus = null;
  }, 150);
}
$('#detailModal').addEventListener('click', e => { if (e.target === $('#detailModal')) closeDetail(); });

// ---------------- Scores ----------------
async function renderScores(fromTick = false) {
  const el = $('#view-scores');
  el.innerHTML = skeleton();
  try { state.scores = await api('/api/scores'); } catch (e) { el.innerHTML = `<div class="card empty">Scores unavailable: ${esc(e.message)}</div>`; return; }
  const cards = state.scores.map((s, i) => `
    <div class="card score-card clickable anim-row" data-sym="${s.symbol}" role="button" tabindex="0" aria-label="${s.symbol} score ${s.composite}" style="animation-delay:${fromTick ? 0 : Math.min(i * 30, 360)}ms">
      <div class="score-top">
        <span><strong>${s.symbol}</strong> <span class="dim mono">${fmtPrice(s.price, s.type)}</span></span>
        <span class="score-grade grade-${gradeClass(s.grade)}">${esc(s.grade)}</span>
      </div>
      <div class="score-top"><span class="score-num">${s.composite}</span><span class="dim" style="font-size:11px">/100</span></div>
      ${scoreBar('Momentum', s.subscores.momentum, 'var(--accent)')}
      ${scoreBar('Technical', s.subscores.technical, 'var(--accent)')}
      ${scoreBar('Volume', s.subscores.volume, 'var(--accent)')}
      ${scoreBar('News', s.subscores.news, 'var(--accent)')}
      ${scoreBar('On-chain', s.subscores.onchain, 'var(--accent)')}
      ${scoreBar('Risk (100=low)', s.subscores.risk, 'var(--up)')}
    </div>`).join('');
  el.innerHTML = `
    <div class="section-title">AI Trade Scores <span class="sub">0–100 composite · momentum + technical + volume + news + on-chain + risk</span></div>
    <div class="grid g-3">${cards}</div>`;
  $$('#view-scores .score-card').forEach(c => {
    const open = () => openDetail(c.dataset.sym);
    c.addEventListener('click', open);
    c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  if (!fromTick) $$('#view-scores .score-num').forEach(el => animateNum(el, +el.textContent));
}

// ---------------- Risk ----------------
async function renderRisk() {
  const el = $('#view-risk');
  let paper = state.paper;
  try { paper = await api('/api/paper'); state.paper = paper; } catch { /* keep */ }
  const exposure = paper?.positions?.length
    ? paper.positions.reduce((a, p) => a + p.notional, 0) / (paper.account?.initialCash || 1) * 100 : 0;
  el.innerHTML = `
    <div class="section-title">Risk Management Engine <span class="sub">position size · dollar risk · R:R · potential P/L · portfolio exposure</span></div>
    <div class="grid g-2">
      <div class="card">
        <div class="field"><label for="rAccount">Account size (USDT/USD)</label><input id="rAccount" type="number" value="${paper?.account?.initialCash || 10000}"></div>
        <div class="field"><label for="rRisk">Max risk per trade (%)</label><input id="rRisk" type="number" step="0.1" value="1"></div>
        <div class="field"><label for="rEntry">Entry price</label><input id="rEntry" type="number" step="any" placeholder="e.g. 0.0006115"></div>
        <div class="field"><label for="rStop">Stop loss</label><input id="rStop" type="number" step="any" placeholder="e.g. 0.00058"></div>
        <div class="field"><label for="rTarget">Target price <span class="dim">(optional)</span></label><input id="rTarget" type="number" step="any" placeholder="e.g. 0.00068"></div>
        <div class="field"><label for="rSide">Side</label>
          <select id="rSide"><option value="long">Long</option><option value="short">Short</option></select>
        </div>
        <button class="btn" id="rCalc">Calculate</button>
      </div>
      <div class="card" id="riskOut">
        <div class="section-title" style="margin-bottom:12px">Result</div>
        <div class="empty" style="padding:32px 0">Enter parameters and hit Calculate.</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="section-title" style="margin-bottom:8px">Portfolio exposure <span class="sub">open paper positions</span></div>
      <div class="kpi"><span class="k-value">${exposure.toFixed(1)}%</span><span class="k-sub">gross exposure vs account size · ${paper?.positions?.length || 0} open position(s)</span></div>
    </div>
    <div class="card" id="autopilotCard" style="margin-top:16px"><div class="empty">loading autopilot…</div></div>`;
  $('#rCalc').addEventListener('click', async () => {
    const body = {
      accountSize: +$('#rAccount').value, maxRiskPct: +$('#rRisk').value,
      entryPrice: +$('#rEntry').value, stopLoss: +$('#rStop').value,
      targetPrice: $('#rTarget').value ? +$('#rTarget').value : null, side: $('#rSide').value,
    };
    const r = await post('/api/risk', body);
    const out = $('#riskOut');
    if (!r.ok) { out.innerHTML = `<div class="empty" style="color:var(--down)">${(r.errors || []).map(esc).join('<br>')}</div>`; return; }
    out.innerHTML = `
      <div class="section-title" style="margin-bottom:12px">Result</div>
      <div class="grid g-2">
        <div class="kpi"><span class="k-label">Position size</span><span class="k-value">${fmtNum(r.positionSize, 4)}</span><span class="k-sub">units · notional $${fmtNum(r.notional)}</span></div>
        <div class="kpi"><span class="k-label">Dollar risk</span><span class="k-value ${r.dollarRisk >= 0 ? '' : 'down'}">$${fmtNum(r.dollarRisk)}</span><span class="k-sub">${r.inputs.maxRiskPct}% of account</span></div>
        <div class="kpi"><span class="k-label">Risk : Reward</span><span class="k-value">${r.rr != null ? r.rr + ' : 1' : '—'}</span><span class="k-sub">${r.targetPrice ? 'with target' : 'add a target to compute'}</span></div>
        <div class="kpi"><span class="k-label">Potential profit</span><span class="k-value up">$${fmtNum(r.potentialProfit)}</span><span class="k-sub">vs loss $${fmtNum(r.potentialLoss)}</span></div>
        <div class="kpi"><span class="k-label">Exposure</span><span class="k-value">${r.exposurePct}%</span><span class="k-sub">notional / account</span></div>
        <div class="kpi"><span class="k-label">Liquidation (est.)</span><span class="k-value mono">${r.liquidationPrice != null ? fmtPrice(r.liquidationPrice, 'crypto') : 'n/a (spot)'}</span><span class="k-sub">leverage ${r.inputs.leverage}x</span></div>
      </div>`;
  });
  loadAutopilotPanel();
}

async function loadAutopilotPanel() {
  const card = $('#autopilotCard');
  if (!card) return;
  let s;
  try { s = await api('/api/autopilot'); } catch { card.innerHTML = '<div class="empty">autopilot API unavailable</div>'; return; }
  const cfg = s.config;
  card.innerHTML = `
    <div class="section-title" style="margin-bottom:8px">Autopilot <span class="sub">autonomous paper execution · human-approval override available</span>
      <span style="margin-left:auto;display:flex;gap:8px">
        ${s.enabled ? '<button class="btn red sm" id="apStop">Stop</button>' : '<button class="btn green sm" id="apStart">Start</button>'}
        <button class="btn ghost sm" id="apTick">Tick now</button>
      </span>
    </div>
    <div class="grid g-4" style="margin-bottom:12px">
      <div class="kpi"><span class="k-label">Status</span><span class="k-value" style="font-size:18px;color:${s.enabled ? 'var(--up)' : 'var(--dim)'}">${s.enabled ? '● RUNNING' : '○ IDLE'}</span><span class="k-sub">${s.ticks} ticks</span></div>
      <div class="kpi"><span class="k-label">Entry filter</span><span class="k-value" style="font-size:18px">score ≥ ${cfg.openMinScore}</span><span class="k-sub">risk subscore ≥ ${cfg.openMaxRisk}</span></div>
      <div class="kpi"><span class="k-label">Concurrency</span><span class="k-value" style="font-size:18px">${cfg.maxConcurrent} pos · ${cfg.maxTradesPerDay}/day</span><span class="k-sub">${cfg.accountRiskPct}% risk per trade</span></div>
      <div class="kpi"><span class="k-label">Safety rails</span><span class="k-value" style="font-size:18px">halt ${cfg.dailyLossHaltPct}%</span><span class="k-sub">exit: score &lt; ${cfg.exitScore} · RSI &gt; ${cfg.exitRsi} · R:R ≥ ${cfg.minRr}</span></div>
    </div>
    ${s.actions.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Symbol</th><th>Detail</th><th>Score</th></tr></thead><tbody>
      ${s.actions.slice(0, 10).map(a => `<tr><td class="muted mono">${new Date(a.ts).toLocaleTimeString('en-GB', { hour12: false })}</td><td><span class="chip ${a.type === 'entry' ? 'bull' : a.type === 'exit' ? 'warn' : a.type === 'halt' ? 'bear' : 'neut'}">${esc(a.type)}</span></td><td><strong>${esc(a.symbol || '—')}</strong></td><td class="muted" style="max-width:340px;white-space:normal">${esc(a.detail)}</td><td class="mono">${a.score ?? '—'}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="muted" style="font-size:12px">No actions yet — hit Start and the loop will scan → score → size → execute → journal on its own, every 60s.</div>'}
    ${s.proposals?.length ? `<div class="section-title" style="margin:14px 0 6px">Pending proposals <span class="sub">human-in-the-loop — approve or reject before execution</span></div>
    <div class="table-wrap"><table><thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>Stop</th><th>Target</th><th>Conf</th><th>Reason</th><th></th></tr></thead><tbody>
      ${s.proposals.map(p => `<tr><td><strong>${esc(p.symbol)}</strong></td><td>${esc(p.side)}</td><td class="mono">${Math.round(p.size)}</td><td class="mono">${p.entry}</td><td class="mono">${p.stop}</td><td class="mono">${p.target}</td><td class="mono">${p.confidence}</td><td class="muted" style="max-width:280px;white-space:normal">${esc(p.reason)}</td><td style="white-space:nowrap"><button class="btn green sm" data-ap-approve="${esc(p.id)}">Approve</button> <button class="btn red sm" data-ap-reject="${esc(p.id)}">Reject</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}`;
  const start = $('#apStart'), stop = $('#apStop'), tick = $('#apTick');
  if (start) start.addEventListener('click', async () => { await post('/api/autopilot/start', {}); loadAutopilotPanel(); });
  if (stop) stop.addEventListener('click', async () => { await post('/api/autopilot/stop', {}); loadAutopilotPanel(); });
  if (tick) tick.addEventListener('click', async () => { await post('/api/autopilot/tick', {}); loadAutopilotPanel(); });
  document.querySelectorAll('[data-ap-approve]').forEach(b => b.addEventListener('click', async () => { await post(`/api/autopilot/proposals/${b.dataset.apApprove}/approve`, {}); loadAutopilotPanel(); }));
  document.querySelectorAll('[data-ap-reject]').forEach(b => b.addEventListener('click', async () => { await post(`/api/autopilot/proposals/${b.dataset.apReject}/reject`, {}); loadAutopilotPanel(); }));
}

// ---------------- Performance (FreqUI-style) ----------------
const fmt = (v, dgt = 2) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: dgt });
const money = (v) => `${v == null ? '—' : (v > 0 ? '+' : '') + fmt(v)}`;
async function renderPerformance() {
  const el = $('#view-performance');
  el.innerHTML = skeleton();
  let d;
  try { d = await api('/api/performance'); } catch (e) { el.innerHTML = `<div class="card empty">Performance unavailable: ${esc(e.message)}</div>`; return; }
  const k = d.kpis;
  const pnlCls = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
  el.innerHTML = `
    <div class="section-title">Performance <span class="sub">FreqUI-style analytics · paper journal · win rate · expectancy · equity curve</span></div>
    <div class="grid g-4" style="margin-bottom:14px">
      <div class="kpi"><span class="k-label">Net P&L</span><span class="k-value ${pnlCls(k.totalPnl)}" style="font-size:20px">${money(k.totalPnl)}</span><span class="k-sub">${k.returnPct != null ? (k.returnPct > 0 ? '+' : '') + k.returnPct + '% return' : 'no closed trades'}</span></div>
      <div class="kpi"><span class="k-label">Equity</span><span class="k-value" style="font-size:20px">$${fmt(k.currentEquity, 0)}</span><span class="k-sub">${k.open} open · ${k.closed} closed</span></div>
      <div class="kpi"><span class="k-label">Win rate</span><span class="k-value ${(k.winRate ?? 0) >= 50 ? 'up' : 'down'}" style="font-size:20px">${k.winRate != null ? k.winRate + '%' : '—'}</span><span class="k-sub">${k.closed ? 'avg win ' + money(k.avgWin) + ' / avg loss ' + money(k.avgLoss) : 'no closed trades'}</span></div>
      <div class="kpi"><span class="k-label">Profit factor</span><span class="k-value ${(k.profitFactor ?? 0) >= 1 ? 'up' : 'down'}" style="font-size:20px">${k.profitFactor != null ? k.profitFactor : '—'}</span><span class="k-sub">expectancy ${money(k.expectancy)}/trade</span></div>
      <div class="kpi"><span class="k-label">Max drawdown</span><span class="k-value down" style="font-size:20px">$${fmt(k.maxDrawdown)}</span><span class="k-sub">${k.maxDrawdownPct != null ? k.maxDrawdownPct + '% of account' : '—'}</span></div>
      <div class="kpi"><span class="k-label">Best / worst</span><span class="k-value" style="font-size:16px"><span class="up">${k.bestTrade ? money(k.bestTrade.pnl) : '—'}</span> / <span class="down">${k.worstTrade ? money(k.worstTrade.pnl) : '—'}</span></span><span class="k-sub">${k.bestTrade ? k.bestTrade.symbol + ' / ' + k.worstTrade?.symbol : ''}</span></div>
    </div>
    <div class="card" style="padding:16px;margin-bottom:14px">
      <div class="section-title">Equity curve <span class="sub">realized P&L + mark-to-market · drawdown shaded</span></div>
      <canvas id="equityChart" class="perf-chart" aria-label="Equity curve chart"></canvas>
    </div>
    <div class="grid g-2">
      <div class="card">
        <div class="section-title">Per-symbol breakdown</div>
        ${d.bySymbol.length ? `<div style="max-height:280px;overflow:auto"><table class="ob-table" style="font-size:11.5px"><thead><tr><th>Symbol</th><th>Trades</th><th>Win rate</th><th>P&L</th></tr></thead><tbody>
          ${d.bySymbol.map(s => `<tr><td><strong>${esc(s.symbol)}</strong></td><td>${s.trades}</td><td class="${s.trades ? ((s.wins / s.trades) >= 0.5 ? 'up' : 'down') : ''}">${s.trades ? Math.round(s.wins / s.trades * 100) + '%' : '—'}</td><td class="${pnlCls(s.pnl)}">${money(s.pnl)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted" style="font-size:12px">No closed trades yet.</div>'}
      </div>
      <div class="card">
        <div class="section-title">Recent closed trades</div>
        ${d.recent.length ? `<div style="max-height:280px;overflow:auto"><table class="ob-table" style="font-size:11.5px"><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Result</th></tr></thead><tbody>
          ${d.recent.map(t => `<tr><td><strong>${esc(t.symbol)}</strong></td><td>${esc(t.side || 'long')}</td><td>${fmt(t.entry, 6)}</td><td>${t.exitPrice != null ? fmt(t.exitPrice, 6) : '—'}</td><td class="${pnlCls(t.pnl)}">${money(t.pnl)}</td><td class="muted">${esc(t.result || '—')}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted" style="font-size:12px">No closed trades yet — start the autopilot or trade manually.</div>'}
      </div>
    </div>`;
  drawEquityChart($('#equityChart'), d.equityCurve);
}
function drawEquityChart(cv, curve) {
  if (!cv) return;
  const dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const pts = (curve || []).filter(p => typeof p.equity === 'number');
  if (pts.length < 2) {
    ctx.fillStyle = 'rgba(232,241,248,.4)'; ctx.font = '11px JetBrains Mono';
    ctx.fillText('not enough closed trades for a curve yet', 12, h / 2);
    return;
  }
  const min = Math.min(...pts.map(p => p.equity)), max = Math.max(...pts.map(p => p.equity));
  const pad = 10, span = Math.max(max - min, 1);
  const y = v => h - pad - ((v - min) / span) * (h - pad * 2);
  const x = i => pad + i * ((w - pad * 2) / (pts.length - 1));
  // grid
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  for (let g = 0; g <= 4; g++) { ctx.beginPath(); ctx.moveTo(pad, y(min + span * g / 4)); ctx.lineTo(w - pad, y(min + span * g / 4)); ctx.stroke(); }
  // drawdown shading: red where below running peak
  let peak = pts[0].equity;
  ctx.fillStyle = 'rgba(248,81,73,.10)';
  ctx.beginPath();
  pts.forEach((p, i) => { peak = Math.max(peak, p.equity); i ? ctx.lineTo(x(i), y(peak)) : ctx.moveTo(x(i), y(peak)); });
  pts.slice().reverse().forEach((p, i, arr) => { const j = pts.length - 1 - i; ctx.lineTo(x(j), y(p.equity)); });
  ctx.closePath(); ctx.fill();
  // equity line
  ctx.strokeStyle = '#22d3aa'; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(34,211,170,.5)'; ctx.shadowBlur = 6;
  ctx.beginPath();
  pts.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p.equity)) : ctx.moveTo(x(i), y(p.equity)); });
  ctx.stroke(); ctx.shadowBlur = 0;
  // start/end labels
  ctx.fillStyle = 'rgba(232,241,248,.5)'; ctx.font = '10px JetBrains Mono';
  ctx.fillText('$' + fmt(pts[0].equity, 0), pad, y(pts[0].equity) - 4);
  const last = pts[pts.length - 1];
  ctx.fillStyle = '#22d3aa';
  ctx.fillText('$' + fmt(last.equity, 0), Math.max(pad, w - pad - 64), Math.max(10, y(last.equity) - 4));
}

// ---------------- Portfolio ----------------
async function renderPortfolio() {
  const el = $('#view-portfolio');
  el.innerHTML = skeleton();
  let p;
  try { p = await api('/api/portfolio'); state.portfolio = p; } catch (e) { el.innerHTML = `<div class="card empty">Portfolio unavailable: ${esc(e.message)}</div>`; return; }
  if (p.empty) {
    el.innerHTML = `<div class="card empty"><h3 style="margin-bottom:8px">Portfolio AI</h3>${esc(p.message)}<br><br><button class="btn sm" onclick="switchView('scores')">Find a setup</button></div>`;
    const liveWrap = document.createElement('div');
    el.appendChild(liveWrap);
    renderLiveCard(liveWrap);
    const feeWrap = document.createElement('div');
    el.appendChild(feeWrap);
    renderFeeCard(feeWrap);
    const akWrap = document.createElement('div');
    el.appendChild(akWrap);
    renderAgentKeysCard(akWrap);
    const lpWrap = document.createElement('div');
    el.appendChild(lpWrap);
    renderLiveProposalsCard(lpWrap);
    const tgWrap = document.createElement('div');
    el.appendChild(tgWrap);
    renderTriggersCard(tgWrap);
    const lbWrap = document.createElement('div');
    el.appendChild(lbWrap);
    renderLeaderboardCard(lbWrap);
    return;
  }
  const comp = p.composition;
  el.innerHTML = `
    <div class="section-title">Portfolio AI <span class="sub">whole-portfolio analysis — not per-coin</span></div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Equity</span><span class="k-value">$${fmtNum(p.equity)}</span><span class="k-sub">cash + unrealized</span></div>
      <div class="card kpi"><span class="k-label">Unrealized P&L</span><span class="k-value ${p.unrealizedPnl >= 0 ? 'up' : 'down'}">$${fmtNum(p.unrealizedPnl)}</span><span class="k-sub">open positions</span></div>
      <div class="card kpi"><span class="k-label">Gross exposure</span><span class="k-value">${p.exposurePct}%</span><span class="k-sub">notional $${fmtNum(p.totalNotional)}</span></div>
      <div class="card kpi"><span class="k-label">Avg AI score</span><span class="k-value">${p.avgScore ?? '—'}</span><span class="k-sub">weighted by holdings</span></div>
    </div>
    <div class="grid g-2">
      <div class="card">
        <div class="section-title" style="margin-bottom:8px">Composition</div>
        <div class="subscore"><span class="lbl">Crypto</span><div class="bar"><i style="width:${comp.crypto ? 100 : 0}%;background:var(--accent)"></i></div><span class="val">${comp.crypto}</span></div>
        <div class="subscore"><span class="lbl">Stocks</span><div class="bar"><i style="width:${comp.stocks ? 100 : 0}%;background:var(--accent)"></i></div><span class="val">${comp.stocks}</span></div>
        <div class="subscore"><span class="lbl">Longs / Shorts</span><div class="bar"><i style="width:${comp.shorts ? 100 : 10}%;background:var(--warn)"></i></div><span class="val">${comp.longs}/${comp.shorts}</span></div>
        <div class="muted" style="font-size:12px;margin-top:8px">News: ${p.bullishNews} bullish · ${p.bearishNews} bearish · concentration risk: <strong>${esc(p.concentrationRisk)}</strong> (${esc(p.topHolding || '—')})</div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-bottom:8px">AI Suggestions</div>
        <ul style="padding-left:18px;display:grid;gap:6px;font-size:13px">${p.suggestions.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:16px">
      <table>
        <thead><tr><th>Asset</th><th>Side</th><th>Notional</th><th>Weight</th><th>Unrealized</th><th>AI Score</th><th>News</th></tr></thead>
        <tbody>${p.holdings.map(h => `
          <tr><td><strong>${h.symbol}</strong></td><td>${h.side}</td><td class="mono">$${fmtNum(h.notional)}</td>
          <td class="mono">${h.weightPct}%</td><td class="mono ${h.unrealizedPnl >= 0 ? 'up' : 'down'}">$${fmtNum(h.unrealizedPnl)}</td>
          <td class="mono">${h.score ?? '—'}</td><td>${h.news ? `<span class="chip ${h.news === 'bullish' ? 'bull' : h.news === 'bearish' ? 'bear' : 'neut'}">${h.news}</span>` : '—'}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  const liveWrap = document.createElement('div');
  el.appendChild(liveWrap);
  renderLiveCard(liveWrap);
  const feeWrap = document.createElement('div');
  el.appendChild(feeWrap);
  renderFeeCard(feeWrap);
  const akWrap = document.createElement('div');
  el.appendChild(akWrap);
  renderAgentKeysCard(akWrap);
  const lpWrap = document.createElement('div');
  el.appendChild(lpWrap);
  renderLiveProposalsCard(lpWrap);
  const tgWrap = document.createElement('div');
  el.appendChild(tgWrap);
  renderTriggersCard(tgWrap);
  const lbWrap = document.createElement('div');
  el.appendChild(lbWrap);
  renderLeaderboardCard(lbWrap);
}

// ---------------- Trading Keys card ----------------
// Free trading: no fees, no credits, no bundles, no deposit addresses. The
// only thing this card does is let a user connect their own Kraken key for
// live trades (non-custodial — the platform never holds funds).
async function renderFeeCard(container) {
  if (!window.Auth?.state?.loggedIn) return;
  let ks = null;
  try { ks = await api('/api/account/kraken'); } catch { return; }
  const kst = ks?.status || {};
  if (ks?.available !== true) {
    container.innerHTML = `
      <div class="card" style="margin-top:16px">
        <div class="section-title" style="margin-bottom:8px">Trading Keys <span class="sub">paper-only launch</span></div>
        <div class="muted" style="font-size:12px">Exchange-key connection and real-money execution are unavailable.</div>
      </div>`;
    return;
  }
  container.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="section-title" style="margin-bottom:8px">Trading Keys <span class="sub">trade your own account · encrypted, never shown · free</span></div>
      ${kst.configured
        ? `<div class="muted" style="font-size:12px">✓ Connected ${esc(kst.maskedKey || '')} · verified ${new Date(kst.lastVerified).toLocaleString()}</div>
           <button class="btn sm ghost" id="keyDisconnect" style="margin-top:6px">Disconnect</button>`
        : `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
             <input type="password" id="keyApi" placeholder="Kraken API Key" autocomplete="off" style="flex:1;min-width:170px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
             <input type="password" id="keySecret" placeholder="Kraken Private Key" autocomplete="off" style="flex:1;min-width:170px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
             <button class="btn sm" id="keyConnect">Connect</button>
           </div>
           <div class="muted" style="font-size:11px;margin-top:6px">Create at Kraken → API → key with Query + Trade only, <strong>no withdraw</strong>. Stored AES-256 encrypted; validated with a read-only call.</div>`}
    </div>`;
  $('#keyConnect')?.addEventListener('click', async () => {
    const apiKey = $('#keyApi')?.value.trim();
    const apiSecret = $('#keySecret')?.value.trim();
    if (!apiKey || !apiSecret) { toast('⚠️ Fill both key fields'); return; }
    toast('Verifying key with Kraken (read-only)…');
    const r = await fetch('/api/account/kraken', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, apiSecret }),
    }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 200) { toast(`⚠️ ${esc(r.body.error || r.status)}`); return; }
    toast('✅ Kraken key connected');
    renderFeeCard(container);
  });
  $('#keyDisconnect')?.addEventListener('click', async () => {
    if (!confirm('Disconnect your Kraken key?')) return;
    await fetch('/api/account/kraken', { method: 'DELETE' });
    toast('Key disconnected');
    renderFeeCard(container);
  });
}

// ---------------- Live trading card (real-money mode) ----------------
// Reads masked state from /api/account; enable/disable routes are owner-gated.
async function renderLiveCard(container) {
  if (!window.Auth?.state?.loggedIn) return;
  let a;
  try { a = await api('/api/account'); } catch { return; }
  const lv = a.live || {};
  if (lv.available !== true) {
    container.innerHTML = `
      <div class="card" style="margin-top:16px">
        <div class="section-title" style="margin-bottom:8px">Execution Mode <span class="sub">paper-only launch</span></div>
        <span class="chip neut">PAPER</span>
        <span class="muted" style="font-size:12px;margin-left:8px">Real-money execution is unavailable.</span>
      </div>`;
    return;
  }
  const liveStyle = 'background:rgba(255,45,85,.15);color:#ff2d55;border-color:rgba(255,45,85,.4)';
  const status = lv.enabled
    ? `<span class="chip" style="${liveStyle}">● LIVE — ${esc(lv.venue || 'kraken')}</span>`
    : '<span class="chip neut">PAPER</span>';
  container.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="section-title" style="margin-bottom:8px">Live Trading <span class="sub">real-money execution · Kraken</span></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        ${status}
        ${lv.pilot ? '<span class="chip" style="background:rgba(255,170,0,.15);color:#ffaa00;border-color:rgba(255,170,0,.4)">DRY-RUN PILOT</span>' : ''}
        <span class="muted" style="font-size:12px">${lv.enabled ? `enabled ${new Date(lv.enabledAt).toLocaleString()}` : 'paper execution only — no real orders can be placed'}</span>
      </div>
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
        ${lv.enabled
          ? '<button class="btn sm danger" id="liveDisableBtn" aria-label="Disable live trading — kill switch">⛔ Kill switch — disable live</button>'
          : '<button class="btn sm" id="liveEnableBtn" aria-label="Enable live trading on Kraken">Enable live (Kraken)</button>'}
      </div>
      ${!lv.enabled && !lv.allowlisted ? '<div class="muted" style="font-size:12px;margin-top:8px">Enable requires your email on the LIVE_EMAIL_ALLOWLIST — owner account only.</div>' : ''}
      <div class="muted" style="font-size:11px;margin-top:6px">Live = pilot mode only (tiny sizes), autopilot requires human approval, and the kill switch cancels all open orders instantly.</div>
    </div>`;
  $('#liveEnableBtn')?.addEventListener('click', async () => {
    if (!confirm('Enable REAL-MONEY trading on Kraken? The API key has no withdraw permission, but funds on the account are tradable.')) return;
    const r = await fetch('/api/account/live/enable', { method: 'POST' }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 200) { toast(`⚠️ ${esc(r.body.error || r.status)}`); return; }
    toast('● LIVE trading enabled — pilot mode');
    renderLiveCard(container);
  });
  $('#liveDisableBtn')?.addEventListener('click', async () => {
    if (!confirm('KILL SWITCH: cancel all open live orders and disable live trading?')) return;
    const r = await fetch('/api/account/live/disable', { method: 'POST' }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 200) { toast(`⚠️ ${esc(r.body.error || r.status)}`); return; }
    toast(r.body.cancelled?.length ? `⛔ Live disabled — ${r.body.cancelled.length} order(s) cancelled` : '⛔ Live disabled');
    renderLiveCard(container);
  });
}

// ---------------- AI Agent Keys card ("connect your AI agent") ----------------
// Every user can mint API keys for their own AI agents. Key shown ONCE, hash
// stored server-side, revocable instantly. Scopes: read (always) / trade-paper
// / trade-live (owner-only creation — server enforces).
async function renderAgentKeysCard(container) {
  if (!window.Auth?.state?.loggedIn) return;
  let ks = null, acc = null;
  try { ks = await api('/api/agent-keys'); } catch { return; }
  try { acc = await api('/api/account'); } catch { /* allowlist flag unknown */ }
  const ownerLive = !!(acc?.live?.allowlisted);
  const rows = (ks.keys || []).map(k => `
    <tr>
      <td class="mono">${esc(k.name || 'agent')}</td>
      <td class="mono">${esc(k.prefix)}…</td>
      <td>${k.scopes.map(s => `<span class="chip ${s === 'trade-live' ? 'live' : s === 'trade-paper' ? 'bull' : 'neut'}">${esc(s)}</span>`).join(' ')}</td>
      <td class="mono" style="font-size:11px">${new Date(k.createdAt).toLocaleDateString()}</td>
      <td>${k.revokedAt ? '<span class="chip neut">revoked</span>' : `<button class="btn sm ghost" data-revoke="${esc(k.id)}" aria-label="Revoke agent key ${esc(k.name || '')}">Revoke</button>`}</td>
    </tr>`).join('');
  container.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="section-title" style="margin-bottom:8px">AI Agents <span class="sub">connect your own AI agent — it trades YOUR paper account · X-API-Key</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" id="akName" placeholder="Agent name (e.g. My bot)" maxlength="60" style="flex:1;min-width:150px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <label style="font-size:12px;display:flex;gap:4px;align-items:center"><input type="checkbox" id="akPaper" checked> trade-paper</label>
        ${ownerLive ? '<label style="font-size:12px;display:flex;gap:4px;align-items:center"><input type="checkbox" id="akLive"> trade-live</label>' : ''}
        <button class="btn sm" id="akCreate" aria-label="Create agent API key">+ Create key</button>
      </div>
      <div id="akSecret" class="hidden" style="margin-top:10px;border:1px solid rgba(255,170,0,.4);background:rgba(255,170,0,.07);border-radius:8px;padding:10px">
        <div style="font-size:11px;color:#ffaa00;margin-bottom:4px">⚠️ Copy this now — <strong>shown only once</strong>. Anyone with it controls this key. We never store it.</div>
        <div class="mono" id="akSecretVal" style="word-break:break-all;font-size:12px"></div>
        <button class="btn sm ghost" id="akCopy" style="margin-top:6px" aria-label="Copy agent key">Copy</button>
      </div>
      ${rows ? `<table style="margin-top:12px;font-size:12px"><thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted" style="font-size:12px;margin-top:8px">No agent keys yet — create one to let your AI agent trade this account.</div>'}
      <div class="muted" style="font-size:11px;margin-top:8px">Your agent sends <span class="mono">X-API-Key: &lt;key&gt;</span> to read state (GET /api/ui-state, /api/paper) and trade paper (POST /api/paper/open). Manifest: <span class="mono">/.well-known/agent.json</span>.</div>
    </div>`;
  $('#akCreate')?.addEventListener('click', async () => {
    const name = $('#akName')?.value.trim();
    const scopes = ['read'];
    if ($('#akPaper')?.checked) scopes.push('trade-paper');
    if ($('#akLive')?.checked) scopes.push('trade-live');
    const r = await fetch('/api/agent-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scopes }) })
      .then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 200) { toast(`⚠️ ${esc(r.body.error || r.status)}`); return; }
    $('#akSecret')?.classList.remove('hidden');
    const v = $('#akSecretVal'); if (v) v.textContent = r.body.key;
    const copyBtn = $('#akCopy'); if (copyBtn) copyBtn.onclick = () => { navigator.clipboard?.writeText(r.body.key); toast('✅ Key copied — store it safely'); };
    toast('✅ Agent key created — shown once');
    // Keep the one-time secret visible until the owner copies it. Re-rendering
    // here would replace #akSecret immediately and erase the only recoverable
    // copy of the newly minted key. The key list refreshes on the next view
    // render or page reload, after the owner has had a chance to store it.
  });
  container.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Revoke this agent key? It stops working immediately.')) return;
    const r = await fetch(`/api/agent-keys/${b.dataset.revoke}`, { method: 'DELETE' }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 200) { toast(`⚠️ ${esc(r.body.error || r.status)}`); return; }
    toast('🔑 Agent key revoked');
    renderAgentKeysCard(container);
  }));
}

// ---------------- Live proposals card (option C: agent requests, owner approves) ----------------
async function renderLiveProposalsCard(container) {
  if (!window.Auth?.state?.loggedIn) return;
  let ps = null;
  try { ps = await api('/api/live/proposals?status=pending'); } catch { return; }
  const rows = (ps.proposals || []).map(p => `
    <tr>
      <td><strong>${esc(p.symbol)}</strong></td>
      <td class="${p.side === 'long' ? 'up' : 'down'}">${p.side}</td>
      <td class="mono">${p.size}</td>
      <td class="mono">${p.entry ? '$' + fmtNum(p.entry) : 'market'}</td>
      <td style="font-size:12px">${esc(p.reason || '—')}${p.confidence ? ` <span class="muted">(${p.confidence}/100)</span>` : ''}</td>
      <td class="mono" style="font-size:11px">${new Date(p.createdAt).toLocaleTimeString()} · ${esc(p.requesterName || 'agent')}</td>
      <td style="white-space:nowrap">
        <button class="btn sm" data-aprove="${esc(p.id)}" aria-label="Approve live trade proposal for ${esc(p.symbol)}">✓ Approve</button>
        <button class="btn sm ghost" data-reject="${esc(p.id)}" aria-label="Reject live trade proposal for ${esc(p.symbol)}">✕ Reject</button>
      </td>
    </tr>`).join('');
  if (!rows) return; // nothing pending → no card
  container.innerHTML = `
    <div class="card" style="margin-top:16px;border-color:rgba(255,170,0,.35)">
      <div class="section-title" style="margin-bottom:8px">⚠ Agent Live-Trade Proposals <span class="sub">nothing executes until you approve · rails re-checked</span></div>
      <div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Asset</th><th>Side</th><th>Size</th><th>Entry</th><th>Reason</th><th>Time · Agent</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  container.querySelectorAll('[data-aprove]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Approve this REAL-MONEY live trade? Risk rails will be enforced at execution.')) return;
    const r = await fetch(`/api/live/proposals/${b.dataset.aprove}/approve`, { method: 'POST' }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 200) { toast(`⚠️ ${esc(r.body.error || r.status)}`); return; }
    toast(`✅ Live order placed — ${esc(r.body.order?.venueOrderId || '')}`);
    renderLiveProposalsCard(container);
  }));
  container.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', async () => {
    const r = await fetch(`/api/live/proposals/${b.dataset.reject}/reject`, { method: 'POST' }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 200) { toast(`⚠️ ${esc(r.body.error || r.status)}`); return; }
    toast('✕ Proposal rejected');
    renderLiveProposalsCard(container);
  }));
}

// ---------------- v1.14 Triggers card ----------------
// "When X happens → notify me (or propose a live trade, owner-only)"
async function renderTriggersCard(container) {
  if (!window.Auth?.state?.loggedIn) return;
  let ts = null, ev = null, acc = null;
  try { [ts, ev, acc] = await Promise.all([
    api('/api/triggers').catch(() => null),
    api('/api/triggers/events?limit=5').catch(() => null),
    api('/api/account').catch(() => null),
  ]); } catch { return; }
  const ownerLive = !!(acc?.live?.allowlisted);
  const list = ts?.triggers || [];
  const rows = list.map(t => `
    <tr>
      <td><strong>${esc(t.name)}</strong></td>
      <td class="mono">${esc(t.symbol)} ${esc(t.condition.operator)} ${t.condition.value} <span class="dim">(${esc(t.condition.type)})</span></td>
      <td>${t.action === 'propose' ? '<span class="chip live">propose live</span>' : '<span class="chip neut">notify</span>'}</td>
      <td class="mono">${t.triggerCount}</td>
      <td>${t.enabled
        ? `<button class="btn sm ghost" data-toggle="${esc(t.id)}" data-on="1">ON</button>`
        : `<button class="btn sm" data-toggle="${esc(t.id)}" data-on="0">OFF</button>`}</td>
      <td><button class="btn red sm" data-del="${esc(t.id)}">✕</button></td>
    </tr>`).join('');
  const events = (ev?.events || []).map(e => `
    <div style="font-size:12px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">
      <span class="chip ${e.action === 'propose' ? 'live' : 'warn'}">${esc(e.action)}</span>
      <strong>${esc(e.name)}</strong> — ${esc(e.symbol)} saw ${e.condition.actual}
      <span class="dim mono">· ${new Date(e.ts).toLocaleTimeString()}</span>
    </div>`).join('');
  container.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="section-title" style="margin-bottom:8px">Triggers <span class="sub">when a condition fires → notify or propose a live trade · checked every 60s</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <input type="text" id="tgName" placeholder="Name (e.g. BTC pumps)" maxlength="60" style="flex:1;min-width:110px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <input type="text" id="tgSym" placeholder="Symbol" maxlength="12" style="width:80px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <select id="tgType" style="padding:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
          <option value="price">price</option><option value="score">AI score</option><option value="pct24h">24h %</option>
        </select>
        <select id="tgOp" style="padding:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
          <option value="gt">&gt;</option><option value="gte">≥</option><option value="lt">&lt;</option><option value="lte">≤</option>
        </select>
        <input type="number" id="tgVal" placeholder="value" step="any" style="width:90px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <select id="tgAction" style="padding:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
          <option value="notify">notify</option>
          ${ownerLive ? '<option value="propose">propose live trade</option>' : ''}
        </select>
        <select id="tgSide" style="padding:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)"><option value="long">long</option><option value="short">short</option></select>
        <button class="btn sm" id="tgCreate">+ Trigger</button>
      </div>
      ${rows ? `<table style="margin-top:12px;font-size:12px"><thead><tr><th>Name</th><th>Condition</th><th>Action</th><th>Fires</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted" style="font-size:12px;margin-top:8px">No triggers — e.g. "BTC > 65000 → notify" or (owner) "IOST score ≥ 75 → propose a live long".</div>'}
      ${events ? `<div style="margin-top:10px"><div class="muted" style="font-size:11px;margin-bottom:4px">Recent firings</div>${events}</div>` : ''}
      <div class="muted" style="font-size:11px;margin-top:8px">Edge-triggered — fires once per condition-clear cycle (no spam). A firing marks an event; a Hermes watcher can push it to Telegram.</div>
    </div>`;
  $('#tgCreate')?.addEventListener('click', async () => {
    const body = {
      name: $('#tgName')?.value.trim(),
      symbol: $('#tgSym')?.value.trim().toUpperCase(),
      condition: { type: $('#tgType')?.value, operator: $('#tgOp')?.value, value: +($('#tgVal')?.value || 0) },
      action: $('#tgAction')?.value || 'notify',
      side: $('#tgSide')?.value || 'long',
    };
    if (!body.symbol) { toast('⚠️ Symbol required'); return; }
    const r = await fetch('/api/triggers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 201) { toast(`⚠️ ${esc(r.body.error || r.status)}`); return; }
    toast('🔔 Trigger created');
    renderTriggersCard(container);
  });
  container.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
    await fetch(`/api/triggers/${b.dataset.toggle}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: b.dataset.on === '0' }) });
    renderTriggersCard(container);
  }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this trigger?')) return;
    await fetch(`/api/triggers/${b.dataset.del}`, { method: 'DELETE' });
    renderTriggersCard(container);
  }));
}

// ---------------- v1.14 Leaderboard card (public social proof) ----------------
async function renderLeaderboardCard(container) {
  let lb = null;
  try { lb = await api('/api/leaderboard'); } catch { return; }
  const rows = (lb.promoted || []).map(r => `
    <tr>
      <td class="mono">#${r.rank}</td>
      <td>${esc(r.trader)}</td>
      <td class="mono ${r.pnl >= 0 ? 'up' : 'down'}">$${fmtNum(r.pnl)}</td>
      <td class="mono">${r.winRate}%</td>
      <td class="mono">${r.trades} (${r.wins}W/${r.losses}L)</td>
    </tr>`).join('');
  container.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="section-title" style="margin-bottom:8px">Leaderboard <span class="sub">qualified paper evidence · ${esc(lb.period)} · public</span></div>
      ${rows ? `<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>#</th><th>Trader</th><th>P&L</th><th>Win rate</th><th>Trades</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="muted" style="font-size:12px">No paper trader has cleared the public evidence bar yet.</div>'}
      <div class="muted" style="font-size:11px;margin-top:8px">Positive period P&amp;L and ${lb.qualification?.minimumTrades || 5}+ closed paper trades required. ${lb.qualification?.provisionalCount || 0} provisional record(s) hidden. Identities remain masked.</div>
    </div>`;
}

// topbar red LIVE chip — visible only while live mode is on
async function updateLiveChip() {
  const chip = $('#liveTradeChip');
  if (!chip) return;
  if (!window.Auth?.state?.loggedIn) { chip.classList.add('hidden'); return; }
  try {
    const a = await api('/api/account');
    chip.classList.toggle('hidden', !(a.live && a.live.enabled));
  } catch { chip.classList.add('hidden'); }
}
setInterval(updateLiveChip, 30000);
window.addEventListener('authchange', updateLiveChip);
setTimeout(updateLiveChip, 2500);

// ---------------- On-chain ----------------
async function renderOnchain() {
  const el = $('#view-onchain');
  el.innerHTML = skeleton();
  let o;
  try { o = await api('/api/onchain'); state.onchain = o; } catch (e) { el.innerHTML = `<div class="card empty">On-chain unavailable: ${esc(e.message)}</div>`; return; }
  const c = o.chain;
  const n = o.node || {};
  const identity = o.identity || {};
  const operator = identity.operator || {};
  const l1 = identity.layers?.l1 || {};
  const l2 = identity.layers?.l2 || {};
  const nodeHealthy = n.status === 'healthy';
  const nodeStatus = nodeHealthy ? '<span class="up">● healthy</span>' : n.status === 'degraded' ? '<span class="warn">● degraded</span>' : '<span class="down">● offline</span>';
  const age = n.headAgeSec == null ? '—' : `${n.headAgeSec}s`;
  const finality = c.finalityGapBlocks == null ? '—' : `${fmtNum(c.finalityGapBlocks, 0)} blocks`;
  const maxTx = Math.max(...o.series.map(s => s.txs), 1);
  const bars = o.series.slice(-30).map(s => `<i title="block ${s.height}: ${s.txs} tx" style="height:${Math.max(6, (s.txs / maxTx) * 100)}%"></i>`).join('');
  el.innerHTML = `
    <div class="section-title">IOST Dual-Chain Trust <span class="sub">Layer 1 telemetry · Layer 2 token readiness</span></div>
    <div class="grid g-2" style="margin-bottom:16px">
      <section class="card" aria-labelledby="l1TrustTitle">
        <div class="section-title" id="l1TrustTitle" style="margin-bottom:8px">IOST Layer 1 <span class="sub">producer identity + trust anchoring</span></div>
        <div class="grid g-2">
          <div class="kpi"><span class="k-label">Verified producer</span><span class="k-value" style="font-size:17px">${esc(operator.displayName || 'IOSTcallister')}</span><span class="k-sub mono">${esc(operator.account || 'iost_4_life')} · ${esc(operator.country || 'Canada')}</span></div>
          <div class="kpi"><span class="k-label">Native network</span><span class="k-value" style="font-size:17px">chain ${l1.chainId ?? 1024}</span><span class="k-sub">${esc(l1.runtime || 'IOST V8VM')} · ${nodeStatus}</span></div>
        </div>
        <p class="muted" style="font-size:11px;margin-top:10px">Rank is live and may change. <a href="${esc(operator.explorer || 'https://iostscan.com/en/account/iost_4_life')}" target="_blank" rel="noopener">Verify producer ↗</a> · <a href="${esc(operator.ranking || 'https://iostscan.com/en/producers')}" target="_blank" rel="noopener">live ranking ↗</a></p>
      </section>
      <section class="card" aria-labelledby="l2TrustTitle">
        <div class="section-title" id="l2TrustTitle" style="margin-bottom:8px">IOST Layer 2 <span class="sub">AITT canonical home</span></div>
        <div class="grid g-2">
          <div class="kpi"><span class="k-label">EVM network</span><span class="k-value" style="font-size:17px">chain ${l2.chainId ?? 182}</span><span class="k-sub">${esc(l2.runtime || 'EVM / Solidity')}</span></div>
          <div class="kpi"><span class="k-label">AITT status</span><span class="k-value warn" style="font-size:17px">NOT ISSUED</span><span class="k-sub">pre-launch · no contract address</span></div>
        </div>
        <p class="muted" style="font-size:11px;margin-top:10px">Layer 2 is separate from the producer node and remains fail-closed. <a href="${esc(l2.explorer || 'https://l2-scan.iost.io')}" target="_blank" rel="noopener">L2 explorer ↗</a></p>
      </section>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Layer 1 node health <span class="sub">read-only telemetry source · not the L2 token RPC</span></div>
      <div class="grid g-3">
        <div class="kpi"><span class="k-label">Source</span><span class="k-value" style="font-size:15px">${esc(n.label || 'IOST RPC')}</span><span class="k-sub">${n.source === 'operator-node' ? 'operator configured' : 'public fallback'}</span></div>
        <div class="kpi"><span class="k-label">Node software</span><span class="k-value" style="font-size:15px">${esc(n.version || '—')}</span><span class="k-sub">${esc(n.mode || 'mode unavailable')}</span></div>
        <div class="kpi"><span class="k-label">Freshness</span><span class="k-value" style="font-size:15px">${age}</span><span class="k-sub">RPC ${n.responseMs ?? '—'} ms · tx pool ${n.txPoolSize ?? '—'}</span></div>
      </div>
    </div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Head block</span><span class="k-value">${fmtNum(c.headBlock, 0)}</span><span class="k-sub">LIB ${fmtNum(c.libBlock, 0)} · ${esc(c.netName)}</span></div>
      <div class="card kpi"><span class="k-label">TPS</span><span class="k-value">${c.tps}</span><span class="k-sub">${c.avgTxPerBlock} tx/block</span></div>
      <div class="card kpi"><span class="k-label">Finality gap</span><span class="k-value" style="font-size:18px">${finality}</span><span class="k-sub">${c.finalityLagSec ?? '—'}s head-to-LIB</span></div>
      <div class="card kpi"><span class="k-label">Peers</span><span class="k-value">${c.peerCount ?? '—'}</span><span class="k-sub">${n.inboundPeers ?? '—'} in · ${n.outboundPeers ?? '—'} out</span></div>
    </div>
    <div class="grid g-2" style="margin-bottom:16px">
      <div class="card">
        <div class="section-title" style="margin-bottom:8px">Network activity <span class="sub">${c.sampleTransactions} txs · ${c.activeAddresses} active addresses in ${c.sampleBlockCount} sampled blocks</span></div>
        <div class="mini-bar">${bars || '<div class="empty">no block data</div>'}</div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-bottom:8px">Gas & RAM & Token</div>
        <div class="grid g-3">
          <div class="kpi"><span class="k-label">Gas ratio</span><span class="k-value">${o.gas?.ratio ?? '—'}</span></div>
          <div class="kpi"><span class="k-label">RAM available</span><span class="k-value" style="font-size:16px">${o.ram?.available ? (o.ram.available / 1e9).toFixed(1) + ' GB' : '—'}</span></div>
          <div class="kpi"><span class="k-label">IOST price</span><span class="k-value" style="font-size:16px">${fmtPrice(o.token.price, 'crypto')}</span></div>
        </div>
        <div class="dim" style="font-size:11px;margin-top:10px">RAM buy ${o.ram?.buyPrice ? o.ram.buyPrice.toFixed(4) + ' IOST/KB' : ''} · total ${o.ram?.total ? (o.ram.total / 1e9).toFixed(1) + ' GB' : ''}</div>
      </div>
    </div>
    <div class="card">
      <div class="section-title" style="margin-bottom:8px">Large transactions <span class="sub">top transfers in last ${o.series.length} blocks (IOST)</span></div>
      ${o.largeTxs.length ? `<div class="table-wrap"><table>
        <thead><tr><th>From</th><th>To</th><th>Amount (IOST)</th><th>≈ USD</th><th>Time</th></tr></thead>
        <tbody>${o.largeTxs.map(t => `<tr><td class="mono">${esc(t.from?.slice(0, 12))}…</td><td class="mono">${esc(t.to?.slice(0, 12))}…</td><td class="mono">${fmtNum(t.amount, 0)}</td><td class="mono">${t.usd ? '$' + fmtNum(t.usd, 0) : '—'}</td><td class="muted">${new Date(t.ts).toLocaleTimeString()}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">No token transfers in this window — most recent blocks are system txs.</div>'}
    </div>`;
}

// ---------------- News ----------------
async function renderNews() {
  const el = $('#view-news');
  el.innerHTML = skeleton();
  let n;
  try { n = await api('/api/news'); state.news = n; } catch (e) { el.innerHTML = `<div class="card empty">News unavailable: ${esc(e.message)}</div>`; return; }
  const m = n.market;
  const total = Math.max(m.total, 1);
  const assetStrip = Object.entries(n.byAsset).slice(0, 12).map(([sym, v]) => `
    <span class="chip ${v.bullish > v.bearish ? 'bull' : v.bearish > v.bullish ? 'bear' : 'neut'}" title="${v.bullish} bull · ${v.neutral} neut · ${v.bearish} bear">
      ${sym} ${v.bullish}/${v.bearish}</span>`).join(' ');
  const rows = n.items.slice(0, 60).map(i => `
    <tr>
      <td>${i.assets.length ? i.assets.map(a => `<span class="chip acc" style="margin-right:4px">${a}</span>`).join('') : '<span class="dim">—</span>'}</td>
      <td><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></td>
      <td class="muted">${esc(i.source)}</td>
      <td><span class="chip ${i.sentiment === 'bullish' ? 'bull' : i.sentiment === 'bearish' ? 'bear' : 'neut'}">${i.sentiment}</span></td>
      <td class="muted">${timeAgo(i.ts)}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="section-title">News + Sentiment Engine <span class="sub">RSS · auto-classified bullish / neutral / bearish</span></div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Market sentiment</span><span class="k-value" style="font-size:16px">${m.bullish > m.bearish ? '🟢 Bullish' : m.bearish > m.bullish ? '🔴 Bearish' : '⚪ Mixed'}</span><span class="k-sub">${total} headlines</span></div>
      <div class="card kpi"><span class="k-label">Bullish</span><span class="k-value up">${m.bullish}</span></div>
      <div class="card kpi"><span class="k-label">Neutral</span><span class="k-value">${m.neutral}</span></div>
      <div class="card kpi"><span class="k-label">Bearish</span><span class="k-value down">${m.bearish}</span></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Per-asset sentiment</div>
      <div class="sig-row">${assetStrip || '<span class="dim">No direct asset mentions in current feed</span>'}</div>
      <div class="sent-gauge" aria-hidden="true"><i style="width:${(m.bullish / total) * 100}%;background:var(--up)"></i><i style="width:${(m.neutral / total) * 100}%;background:var(--dim)"></i><i style="width:${(m.bearish / total) * 100}%;background:var(--down)"></i></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Assets</th><th>Headline</th><th>Source</th><th>Sentiment</th><th>Age</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---------------- Assistant ----------------
let assistantReady = false;
async function renderAssistant() {
  const el = $('#view-assistant');
  if (assistantReady) return;
  el.innerHTML = `
    <div class="section-title">AI Trade Assistant <span class="sub">ask "why is IOST moving today?" · local synthesis over live data</span><img class="ai-avatar" src="/img/ai-operator.webp" alt="AI operator"></div>
    <div class="chat">
      <div class="chat-log" id="chatLog" aria-live="polite">
        <div class="msg bot">Hey — ask me anything about the market. Try <strong>"why is IOST moving today?"</strong>, or name any asset on the watchlist. I check price, volume, news sentiment, on-chain activity and technicals in real time.</div>
      </div>
      <div class="quick">
        <button data-q="why is IOST moving today?">why is IOST moving today?</button>
        <button data-q="what should I watch right now?">what should I watch right now?</button>
        <button data-q="how is bitcoin doing?">how is bitcoin doing?</button>
        <button data-q="what's the market mood?">what's the market mood?</button>
      </div>
      <div class="chat-input">
        <input id="chatInput" type="text" placeholder="Ask about any asset or the market…" aria-label="Ask the assistant">
        <button class="btn" id="chatSend">Ask</button>
      </div>
    </div>`;
  assistantReady = true;
  const send = () => {
    const q = $('#chatInput').value.trim();
    if (q) askAssistant(q);
  };
  $('#chatSend').addEventListener('click', send);
  $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $$('.quick button').forEach(b => b.addEventListener('click', () => askAssistant(b.dataset.q)));
}

async function askAssistant(q) {
  const log = $('#chatLog');
  if (!log) return;
  log.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(q)}</div>`);
  log.scrollTop = log.scrollHeight;
  const typing = `<div class="msg bot"><span class="dim">analyzing live data…</span></div>`;
  log.insertAdjacentHTML('beforeend', typing);
  log.scrollTop = log.scrollHeight;
  let r;
  try { r = await post('/api/assistant', { question: q }); } catch (e) { r = { ok: false, summary: `Assistant error: ${e.message}` }; }
  log.querySelector('.msg.bot:last-child')?.remove();
  const reasons = r.reasons?.length ? `<ul class="reason-list">${r.reasons.map(x => `<li>${esc(x).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`).join('')}</ul>` : '';
  log.insertAdjacentHTML('beforeend', `
    <div class="msg bot">${esc(r.summary || 'No answer.').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}
      ${reasons}<span class="disclaimer">${esc(r.disclaimer || 'Not financial advice.')}</span></div>`);
  log.scrollTop = log.scrollHeight;
}

// ---------------- Agent Evaluation Lab ----------------
// Read-only historical evidence. A passing gate means paper review only.
async function renderEvaluationLab() {
  const el = $('#view-evaluation');
  el.innerHTML = `
    <div class="section-title">Agent Evaluation Lab <span class="sub">walk-forward evidence · realistic execution costs · fail-closed paper review</span></div>
    <div class="eval-boundary" role="status"><strong>PAPER EVIDENCE · FAIL-CLOSED</strong><span>This lab never enables live trading, token actions or public-chain writes.</span></div>
    <ol class="eval-pipeline" aria-label="Evaluation methodology">
      <li><span>01</span><strong>Freeze</strong><small>strategy parameters</small></li>
      <li><span>02</span><strong>Walk forward</strong><small>train → unseen test</small></li>
      <li><span>03</span><strong>Execute</strong><small>next-bar-open</small></li>
      <li><span>04</span><strong>Charge costs</strong><small>fee + spread + slip</small></li>
      <li><span>05</span><strong>Challenge</strong><small>baselines + calibration</small></li>
      <li><span>06</span><strong>Hold or review</strong><small>paper candidate only</small></li>
    </ol>
    <div class="eval-layout">
      <form class="card eval-form" id="evalForm">
        <div class="section-title">Strategy specimen <span class="sub">minimum out-of-sample evidence is enforced by the server</span></div>
        <div class="eval-fields">
          <div class="field"><label for="evSymbol">Symbol</label><input id="evSymbol" value="BTC" maxlength="12" autocomplete="off"></div>
          <div class="field"><label for="evTimeframe">Timeframe</label><select id="evTimeframe"><option value="1d">1 day</option><option value="4h">4 hours</option><option value="1h">1 hour</option><option value="15m">15 minutes</option></select></div>
          <div class="field"><label for="evRule">Entry rule</label><select id="evRule"><option value="ma-cross">MA cross</option><option value="rsi">RSI reversion</option><option value="breakout">Breakout</option><option value="ai-score">AI proxy score</option></select></div>
          <div class="field"><label for="evSide">Side</label><select id="evSide"><option value="long">Long</option><option value="short">Short</option></select></div>
          <div class="field"><label for="evP1" id="evP1Label">Fast MA</label><input id="evP1" type="number" value="20" min="1"></div>
          <div class="field" id="evP2Field"><label for="evP2" id="evP2Label">Slow MA</label><input id="evP2" type="number" value="50" min="2"></div>
          <div class="field"><label for="evStop">Stop (%)</label><input id="evStop" type="number" value="5" min="0.1" max="100" step="0.1"></div>
          <div class="field"><label for="evTarget">Target (%)</label><input id="evTarget" type="number" value="10" min="0.1" max="100" step="0.1"></div>
          <div class="field"><label for="evFee">Fee (bps/side)</label><input id="evFee" type="number" value="10" min="0" max="500"></div>
          <div class="field"><label for="evSpread">Spread (bps)</label><input id="evSpread" type="number" value="8" min="0" max="500"></div>
          <div class="field"><label for="evSlippage">Slippage (bps/side)</label><input id="evSlippage" type="number" value="5" min="0" max="500"></div>
          <div class="field"><label for="evTrades">Minimum trades</label><input id="evTrades" type="number" value="30" min="30" max="5000"></div>
        </div>
        <button class="btn eval-run" id="evRun" type="submit">Run walk-forward evaluation <span>→</span></button>
        <p class="eval-note">Signals see bars through index <b>i</b>; simulated fills occur at <b>i+1 open</b>. If stop and target touch in one bar, the stop wins.</p>
      </form>
      <section class="eval-result" id="evalResult" aria-live="polite">
        <div class="eval-await">
          <span class="eval-orbit" aria-hidden="true">⌬</span>
          <strong>Awaiting strategy evidence</strong>
          <p>The lab will expose out-of-sample performance, costs, calibration, baselines and every reason the promotion gate holds.</p>
        </div>
      </section>
    </div>
    <section class="card eval-history" id="evalHistory" aria-live="polite"><div class="section-title">Private evaluation history</div><div class="muted">Loading retained runs…</div></section>`;

  const setRuleFields = () => {
    const rule = $('#evRule').value; const p1 = $('#evP1'); const p2 = $('#evP2'); const field2 = $('#evP2Field');
    if (rule === 'ma-cross') { $('#evP1Label').textContent = 'Fast MA'; p1.value = 20; $('#evP2Label').textContent = 'Slow MA'; p2.value = 50; field2.hidden = false; }
    else if (rule === 'rsi') { $('#evP1Label').textContent = 'Oversold'; p1.value = 30; $('#evP2Label').textContent = 'Overbought'; p2.value = 70; field2.hidden = false; }
    else if (rule === 'breakout') { $('#evP1Label').textContent = 'Lookback bars'; p1.value = 20; field2.hidden = true; }
    else { $('#evP1Label').textContent = 'Score threshold'; p1.value = 65; field2.hidden = true; }
  };
  $('#evRule').addEventListener('change', setRuleFields);
  $('#evalForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const rule = $('#evRule').value; const p1 = +$('#evP1').value; const p2 = +$('#evP2').value;
    const params = rule === 'ma-cross' ? { fast: p1, slow: p2 }
      : rule === 'rsi' ? { oversold: p1, overbought: p2 }
      : rule === 'breakout' ? { lookback: p1 } : { threshold: p1, side: $('#evSide').value };
    const body = {
      symbol: $('#evSymbol').value.trim().toUpperCase() || 'BTC', timeframe: $('#evTimeframe').value,
      strategy: { name: `${rule} · ${$('#evSide').value}`, side: $('#evSide').value, sizePct: 0.5,
        entry: { rule, params }, exit: { stopPct: +$('#evStop').value / 100, targetPct: +$('#evTarget').value / 100, maxBars: 20 } },
      config: { trainBars: 120, testBars: 40, stepBars: 40, minimumTrades: +$('#evTrades').value,
        costs: { feeBps: +$('#evFee').value, spreadBps: +$('#evSpread').value, slippageBps: +$('#evSlippage').value } },
    };
    const button = $('#evRun'); const out = $('#evalResult');
    button.disabled = true; button.textContent = 'Evaluating unseen windows…';
    out.innerHTML = `<div class="eval-await is-running"><span class="eval-orbit" aria-hidden="true">⌬</span><strong>Walking forward</strong><p>Freezing parameters, replaying unseen windows and challenging the result against baselines.</p></div>`;
    try { renderEvaluationResult(out, await post('/api/evaluation-lab', body)); await loadEvaluationHistory(); }
    catch (error) { out.innerHTML = `<div class="card eval-error"><strong>Evaluation held closed</strong><p>${esc(error.message)}</p><span>No strategy was promoted.</span></div>`; }
    finally { button.disabled = false; button.innerHTML = 'Run walk-forward evaluation <span>→</span>'; }
  });
  await loadEvaluationHistory();
}

function renderEvaluationResult(out, data) {
  const m = data.metrics || {}; const gate = data.promotion || {}; const cal = data.calibration || {};
  const pass = gate.allowed === true;
  const metric = (label, value, sub, cls = '') => `<div class="card kpi"><span class="k-label">${label}</span><span class="k-value ${cls}">${value}</span><span class="k-sub">${sub}</span></div>`;
  const baselineRows = Object.entries(data.baselines || {}).map(([key, row]) => {
    const value = Number(row.returnPct || 0); const width = Math.min(100, Math.max(3, Math.abs(value) * 3));
    return `<div class="eval-baseline"><span>${esc(key.replace(/([A-Z])/g, ' $1'))}</span><i><b class="${value >= 0 ? 'positive' : 'negative'}" style="width:${width}%"></b></i><strong class="${value >= 0 ? 'up' : 'down'}">${value > 0 ? '+' : ''}${fmtNum(value)}%</strong></div>`;
  }).join('');
  const failures = (gate.failures || []).map(x => `<li>${esc(x.replaceAll('-', ' '))}</li>`).join('');
  const warnings = (data.warnings || []).map(x => `<li>${esc(x)}</li>`).join('');
  const folds = (data.folds || []).map(f => `<tr><td>${f.id}</td><td class="mono">${f.train.fromIndex}–${f.train.toIndex}</td><td class="mono">${f.test.fromIndex}–${f.test.toIndex}</td><td>${f.result?.trades ?? 0}</td><td class="${(f.result?.returnPct || 0) >= 0 ? 'up' : 'down'}">${(f.result?.returnPct || 0) > 0 ? '+' : ''}${fmtNum(f.result?.returnPct)}%</td></tr>`).join('');
  out.innerHTML = `
    <article class="eval-verdict ${pass ? 'is-pass' : 'is-hold'}">
      <span class="eval-verdict-label">PROMOTION GATE · PAPER REVIEW ONLY</span>
      <strong>${pass ? 'ELIGIBLE_FOR_PAPER_REVIEW' : 'HOLD'}</strong>
      <p>${pass ? 'Evidence cleared every paper-review threshold. Human review is still required.' : 'The gate failed closed. No strategy state or execution permission changed.'}</p>
    </article>
    <div class="grid g-3 eval-kpis">
      ${metric('OOS trades', m.trades ?? '—', `${m.wins ?? 0} wins · ${m.losses ?? 0} losses`)}
      ${metric('Win rate', m.winRatePct != null ? `${m.winRatePct}%` : '—', 'out-of-sample only')}
      ${metric('Profit factor', m.profitFactor ?? '—', 'gross wins ÷ gross losses', (m.profitFactor ?? 0) >= 1 ? 'up' : 'down')}
      ${metric('Expectancy', m.expectancy != null ? `$${fmtNum(m.expectancy)}` : '—', `${fmtNum(m.expectancyPct, 3)}% per trade`, (m.expectancy ?? 0) >= 0 ? 'up' : 'down')}
      ${metric('Max drawdown', m.maxDrawdownPct != null ? `${m.maxDrawdownPct}%` : '—', 'mark-to-market peak → trough', 'down')}
      ${metric('Sharpe-like', m.sharpeLike ?? '—', 'trade-return risk adjustment')}
      ${metric('Net return', m.cumulativeReturnPct != null ? `${m.cumulativeReturnPct > 0 ? '+' : ''}${m.cumulativeReturnPct}%` : '—', `$${fmtNum(m.finalEquity)} final paper equity`, (m.cumulativeReturnPct ?? 0) >= 0 ? 'up' : 'down')}
      ${metric('Modeled costs', m.totalCosts != null ? `$${fmtNum(m.totalCosts)}` : '—', 'fees + spread + slippage')}
      ${metric('Calibration', cal.expectedCalibrationError != null ? fmtNum(cal.expectedCalibrationError, 4) : '—', `Brier ${fmtNum(cal.brierScore, 4)} · ${cal.observations ?? 0} observations`)}
    </div>
    <div class="grid g-2 eval-detail-grid">
      <section class="card"><div class="section-title">Baseline challenge</div><div class="eval-baselines">${baselineRows}</div></section>
      <section class="card"><div class="section-title">Gate evidence</div>
        ${failures ? `<ul class="eval-findings is-failure">${failures}</ul>` : '<p class="eval-clear">All configured paper-review checks passed.</p>'}
        ${warnings ? `<ul class="eval-findings">${warnings}</ul>` : ''}
      </section>
    </div>
    <p id="evChartSummary" class="sr-only">Evaluation charts summarize ${m.trades ?? 0} out-of-sample trades, ${fmtNum(m.cumulativeReturnPct)} percent net return, ${fmtNum(m.maxDrawdownPct)} percent maximum drawdown, and calibration error ${fmtNum(cal.expectedCalibrationError, 4)}. The paper-review gate decision is ${pass ? 'eligible for human paper review' : 'hold'}.</p>
    <div class="eval-chart-grid">
      <section class="card"><div class="section-title">Equity <span class="sub">strategy vs causal baselines</span></div><canvas class="eval-chart" id="evEquityChart" role="img" aria-describedby="evChartSummary" aria-label="Evaluation equity and baseline chart"></canvas></section>
      <section class="card"><div class="section-title">Drawdown <span class="sub">peak-to-trough, out-of-sample</span></div><canvas class="eval-chart" id="evDrawdownChart" role="img" aria-describedby="evChartSummary" aria-label="Evaluation drawdown chart"></canvas></section>
      <section class="card"><div class="section-title">Baseline equity</div><canvas class="eval-chart" id="evBaselineChart" role="img" aria-describedby="evChartSummary" aria-label="Evaluation baseline equity chart"></canvas></section>
      <section class="card"><div class="section-title">Confidence calibration <span class="sub">predicted vs observed</span></div><canvas class="eval-chart" id="evCalibrationChart" role="img" aria-describedby="evChartSummary" aria-label="Evaluation confidence calibration chart"></canvas></section>
    </div>
    <section class="card eval-folds"><div class="section-title">Walk-forward ledger <span class="sub">non-overlapping train/test boundary · ${data.folds?.length || 0} folds</span></div>
      <div class="table-wrap"><table><thead><tr><th>Fold</th><th>Train bars</th><th>Unseen test bars</th><th>Trades</th><th>Return</th></tr></thead><tbody>${folds}</tbody></table></div>
      <div class="eval-hash mono">RESULT HASH · ${esc(data.evidence?.resultHash || 'unavailable')}</div>
    </section>`;
  requestAnimationFrame(() => drawEvaluationCharts(data));
}

function drawEvalLines(canvas, datasets, { valueKey = 'equity', zero = false } = {}) {
  if (!canvas) return;
  const dpr = devicePixelRatio || 1; const W = canvas.clientWidth || 420; const H = canvas.clientHeight || 170;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  const valid = datasets.map(d => ({ ...d, points: (d.points || []).filter(p => Number.isFinite(p?.[valueKey])) })).filter(d => d.points.length);
  const values = valid.flatMap(d => d.points.map(p => p[valueKey]));
  if (!values.length) { ctx.fillStyle = 'rgba(232,241,248,.45)'; ctx.font = '11px JetBrains Mono'; ctx.fillText('No chart evidence available', 12, H / 2); return; }
  const pad = 16; let min = Math.min(...values), max = Math.max(...values); if (zero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  const span = Math.max(max - min, 1e-9); const longest = Math.max(...valid.map(d => d.points.length));
  const x = i => pad + i * ((W - pad * 2) / Math.max(longest - 1, 1)); const y = v => H - pad - ((v - min) / span) * (H - pad * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) { const gy = pad + g * (H - pad * 2) / 3; ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke(); }
  if (zero && min < 0 && max > 0) { ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(W - pad, y(0)); ctx.stroke(); }
  for (const dataset of valid) {
    ctx.strokeStyle = dataset.color; ctx.lineWidth = dataset.width || 1.7; ctx.beginPath();
    dataset.points.forEach((point, i) => { const px = x(i * (longest - 1) / Math.max(dataset.points.length - 1, 1)); const py = y(point[valueKey]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
  }
  ctx.font = '9px JetBrains Mono'; ctx.fillStyle = 'rgba(232,241,248,.55)'; ctx.fillText(fmtNum(max, 2), pad, 10); ctx.fillText(fmtNum(min, 2), pad, H - 3);
  let lx = W - pad;
  [...valid].reverse().forEach(d => { const width = ctx.measureText(d.label).width + 16; lx -= width; ctx.fillStyle = d.color; ctx.fillRect(lx, 5, 7, 2); ctx.fillText(d.label, lx + 10, 9); });
}

function drawCalibration(canvas, buckets) {
  const points = (buckets || []).map((b, index) => ({ index, predicted: Number(b.predicted), observed: Number(b.observed) }));
  drawEvalLines(canvas, [
    { label: 'predicted', color: '#00e5ff', points: points.map(p => ({ value: p.predicted })) },
    { label: 'observed', color: '#2fffd0', points: points.map(p => ({ value: p.observed })) },
  ], { valueKey: 'value', zero: true });
}

function drawEvaluationCharts(data) {
  const series = data.series || {}; const base = series.baselines || {};
  drawEvalLines($('#evEquityChart'), [
    { label: 'strategy', color: '#2fffd0', width: 2.2, points: series.equity },
    { label: 'buy/hold', color: '#7c5cff', points: base.buyAndHold },
    { label: 'SMA', color: '#00e5ff', points: base.smaCross },
    { label: 'cash', color: '#8b98a5', points: base.cash },
  ]);
  drawEvalLines($('#evDrawdownChart'), [{ label: 'drawdown %', color: '#ff6157', width: 2, points: series.drawdown }], { valueKey: 'drawdownPct', zero: true });
  drawEvalLines($('#evBaselineChart'), Object.entries(base).map(([key, points], index) => ({ label: key, color: ['#7c5cff', '#00e5ff', '#8b98a5'][index], points })));
  drawCalibration($('#evCalibrationChart'), data.calibration?.buckets);
}

async function loadEvaluationHistory() {
  const box = $('#evalHistory'); if (!box) return;
  let history;
  try { history = await api('/api/evaluation-lab/history'); }
  catch (error) { box.innerHTML = `<div class="section-title">Private evaluation history</div><div class="muted">History unavailable: ${esc(error.message)}</div>`; return; }
  const runs = history.runs || [];
  const rows = runs.map(run => `<tr>
    <td><input type="checkbox" data-eval-compare="${esc(run.id)}" aria-label="Select ${esc(run.strategy?.name || 'evaluation')} for comparison"></td>
    <td><strong>${esc(run.symbol)}</strong><span class="eval-history-name">${esc(run.strategy?.name || run.strategy?.rule || 'strategy')}</span></td>
    <td>${esc(run.timeframe)}</td><td>${new Date(run.createdAt).toLocaleString()}</td>
    <td class="${(run.metrics?.cumulativeReturnPct || 0) >= 0 ? 'up' : 'down'}">${fmtNum(run.metrics?.cumulativeReturnPct)}%</td>
    <td><span class="chip ${run.promotion?.allowed ? 'ok' : 'warn'}">${esc(run.promotion?.decision || 'HOLD')}</span></td>
    <td class="eval-history-actions"><button class="btn sm ghost" data-eval-view="${esc(run.id)}">View</button><a class="btn sm ghost" href="/api/evaluation-lab/history/${esc(run.id)}/export?format=json">JSON</a><a class="btn sm ghost" href="/api/evaluation-lab/history/${esc(run.id)}/export?format=csv">CSV</a></td>
  </tr>`).join('');
  box.innerHTML = `<div class="section-title">Private evaluation history <span class="sub">${runs.length}/${history.retention?.maxRuns || 25} retained · ${history.retention?.retentionDays || 90} days · owner-only</span><button class="btn sm" id="evalCompare" disabled>Compare selected</button></div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th></th><th>Run</th><th>Bar</th><th>Created</th><th>Return</th><th>Gate</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No saved evaluations yet.</div>'}`;
  const checks = [...box.querySelectorAll('[data-eval-compare]')]; const compare = $('#evalCompare');
  checks.forEach(check => check.addEventListener('change', () => {
    const selected = checks.filter(x => x.checked);
    if (selected.length > 2) { check.checked = false; toast('Select exactly two evaluation runs'); }
    if (compare) compare.disabled = checks.filter(x => x.checked).length !== 2;
  }));
  box.querySelectorAll('[data-eval-view]').forEach(button => button.addEventListener('click', async () => {
    try { const run = await api(`/api/evaluation-lab/history/${button.dataset.evalView}`); renderEvaluationResult($('#evalResult'), run.evaluation); $('#evalResult')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (error) { toast(`History unavailable: ${error.message}`); }
  }));
  compare?.addEventListener('click', async () => {
    const ids = checks.filter(x => x.checked).map(x => x.dataset.evalCompare);
    try { renderEvaluationComparison($('#evalResult'), await api(`/api/evaluation-lab/history/compare?ids=${encodeURIComponent(ids.join(','))}`)); $('#evalResult')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (error) { toast(`Comparison unavailable: ${error.message}`); }
  });
}

function renderEvaluationComparison(out, data) {
  const [a, b] = data.runs || []; const delta = data.delta || {};
  if (!a || !b) return;
  const cell = (label, key, suffix = '') => `<div class="card kpi"><span class="k-label">Δ ${label}</span><span class="k-value ${(delta[key] || 0) >= 0 ? 'up' : 'down'}">${delta[key] > 0 ? '+' : ''}${fmtNum(delta[key], 4)}${suffix}</span><span class="k-sub">second minus first</span></div>`;
  out.innerHTML = `<article class="eval-verdict is-hold"><span class="eval-verdict-label">PRIVATE RUN COMPARISON · PAPER EVIDENCE ONLY</span><strong>${esc(a.symbol)} ${esc(a.strategy?.name)} → ${esc(b.symbol)} ${esc(b.strategy?.name)}</strong><p>No strategy state or execution permission changed.</p></article>
    <div class="grid g-3 eval-kpis">${cell('return', 'cumulativeReturnPct', '%')}${cell('drawdown', 'maxDrawdownPct', '%')}${cell('Sharpe-like', 'sharpeLike')}${cell('win rate', 'winRatePct', '%')}${cell('trades', 'trades')}${cell('costs', 'totalCosts')}</div>
    <section class="card"><div class="section-title">Equity comparison <span class="sub">normalized paper evidence · stored result hashes preserved</span></div><canvas class="eval-chart eval-chart-wide" id="evCompareChart" aria-label="Two-run equity comparison chart"></canvas><div class="eval-hash mono">A ${esc(a.evidence?.resultHash || '')}<br>B ${esc(b.evidence?.resultHash || '')}</div></section>`;
  requestAnimationFrame(() => drawEvalLines($('#evCompareChart'), [
    { label: `A ${a.symbol}`, color: '#00e5ff', points: a.series?.equity, width: 2 },
    { label: `B ${b.symbol}`, color: '#2fffd0', points: b.series?.equity, width: 2 },
  ]));
}

// ---------------- Journal ----------------
let journalView = { filter: 'all' };
async function renderJournal() {
  const el = $('#view-journal');
  let p;
  try { p = await api('/api/paper'); state.paper = p; } catch (e) { el.innerHTML = `<div class="card empty">Journal unavailable: ${esc(e.message)}</div>`; return; }
  const stats = await api('/api/paper/stats').catch(() => null);
  const j = p.journal || [];
  const filtered = j.filter(e => journalView.filter === 'all' ? true : e.status === journalView.filter || e.result === journalView.filter);
  const rows = filtered.map(e => `
    <tr>
      <td><strong>${e.symbol}</strong></td>
      <td><span class="chip ${e.side === 'long' ? 'bull' : 'bear'}">${e.side}</span></td>
      <td class="mono">${fmtPrice(e.entry, 'crypto')}</td>
      <td class="mono">${e.stop != null ? fmtPrice(e.stop, 'crypto') : '—'}</td>
      <td class="mono">${e.target != null ? fmtPrice(e.target, 'crypto') : '—'}</td>
      <td class="mono">${fmtNum(e.size, 0)}</td>
      <td class="muted" style="max-width:220px;white-space:normal">${esc(e.reason || '—')}</td>
      <td class="mono">${e.confidence ?? '—'}</td>
      <td><span class="chip ${e.status === 'open' ? 'acc' : e.result === 'win' ? 'bull' : e.result === 'loss' ? 'bear' : 'neut'}">${e.status === 'open' ? 'open' : e.result}</span></td>
      <td class="mono ${(e.pnl || 0) >= 0 ? 'up' : 'down'}">${e.pnl != null ? '$' + fmtNum(e.pnl) : '—'}</td>
      <td>${e.status === 'open' ? `<button class="btn ghost sm" data-close="${e.id}">Close</button>` : `<span class="muted">${timeAgo(e.closedAt || e.openedAt)}</span>`}</td>
    </tr>`).join('');
  const openPos = p.positions || [];
  el.innerHTML = `
    <div class="section-title">AI Trading Journal <span class="sub">every trade recorded — reason, confidence, result</span>
      <span style="margin-left:auto;display:flex;gap:8px">
        <button class="btn sm" id="jNew">+ New trade</button>
        <button class="btn ghost sm" id="jCsv">Export CSV</button>
      </span>
    </div>
    <div id="backtestWrap"></div>
    <div class="stat-cards">
      <div class="card kpi"><span class="k-label">Total trades</span><span class="k-value">${stats?.total ?? j.length}</span><span class="k-sub">${stats?.open ?? 0} open</span></div>
      <div class="card kpi"><span class="k-label">Win rate</span><span class="k-value">${stats?.winRate != null ? stats.winRate + '%' : '—'}</span><span class="k-sub">${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L</span></div>
      <div class="card kpi"><span class="k-label">Net P&L</span><span class="k-value ${(stats?.totalPnl || 0) >= 0 ? 'up' : 'down'}">$${fmtNum(stats?.totalPnl)}</span><span class="k-sub">avg win $${fmtNum(stats?.avgWin)} · avg loss $${fmtNum(stats?.avgLoss)}</span></div>
      <div class="card kpi"><span class="k-label">Account</span><span class="k-value">$${fmtNum(p.account?.cash)}</span><span class="k-sub">cash · ${fmtNum(p.account?.initialCash)} initial</span></div>
    </div>
    ${openPos.length ? `<div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Open positions <span class="sub">${openPos.length} · trailing stops/TP + DCA auto-managed every 60s</span></div>
      <div class="table-wrap"><table><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Size</th><th>Last</th><th>Unrealized</th><th>Trail</th><th>DCA</th><th></th></tr></thead>
      <tbody>${openPos.map(pos => {
        const u = (pos.lastPrice - pos.entry) * pos.size * (pos.side === 'long' ? 1 : -1);
        const trail = [];
        if (pos.trailStopPct) trail.push(`<span class="chip warn" title="Trailing stop — exits on ${(pos.trailStopPct * 100).toFixed(1)}% retrace from peak ${fmtPrice(pos.trailPeak ?? pos.entry, pos.type)}">TS ${(pos.trailStopPct * 100).toFixed(1)}%</span>`);
        if (pos.trailTpPct) trail.push(`<span class="chip bull" title="Trailing take-profit — locks profit ${(pos.trailTpPct * 100).toFixed(1)}% below peak">TP ${(pos.trailTpPct * 100).toFixed(1)}%</span>`);
        const dca = pos.dca?.enabled ? `<span class="chip live" title="Auto average-down: ${(pos.dca.triggerPct * 100).toFixed(0)}% dip · ${pos.dca.sizeFactor}× · cooldown ${pos.dca.cooldownMin}m">DCA ${pos.dcaCount}/${pos.dca.maxTrades}</span>` : '—';
        return `<tr><td><strong>${pos.symbol}</strong></td><td>${pos.side}</td><td class="mono">${fmtPrice(pos.entry, pos.type)}</td><td class="mono">${fmtNum(pos.size, 0)}</td><td class="mono">${fmtPrice(pos.lastPrice, pos.type)}</td><td class="mono ${u >= 0 ? 'up' : 'down'}">$${fmtNum(u)}</td><td>${trail.join(' ') || '—'}</td><td>${dca}</td><td style="white-space:nowrap"><button class="btn sm ghost" data-mgmt="${pos.id}">⚙ Manage</button> <button class="btn red sm" data-close="${pos.id}">Close</button></td></tr>`;
      }).join('')}</tbody></table></div></div>` : ''}
    <div class="card">
      <div class="section-title" style="margin-bottom:8px">All trades
        <span style="margin-left:auto;display:flex;gap:6px" id="jFilters">
          ${['all', 'open', 'win', 'loss'].map(f => `<button class="btn ghost sm ${journalView.filter === f ? '' : ''}" data-f="${f}" style="${journalView.filter === f ? 'border-color:var(--accent);color:var(--accent)' : ''}">${f}</button>`).join('')}
        </span>
      </div>
      ${filtered.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Stop</th><th>Target</th><th>Size</th><th>Reason</th><th>AI Conf</th><th>Result</th><th>P&L</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<div class="empty">No trades recorded yet — open your first paper trade.</div>'}
    </div>`;
  $('#jNew').addEventListener('click', () => openTradeModal());
  $('#jCsv').addEventListener('click', () => {
    const head = ['id', 'symbol', 'side', 'entry', 'stop', 'target', 'size', 'reason', 'confidence', 'status', 'openedAt', 'closedAt', 'exitPrice', 'pnl', 'pnlPct', 'result'];
    const csv = [head.join(','), ...j.map(e => head.map(h => `"${String(e[h] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `iost-terminal-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  });
  $$('#jFilters [data-f]').forEach(b => b.addEventListener('click', () => { journalView.filter = b.dataset.f; renderJournal(); }));
  $$('[data-close]').forEach(b => b.addEventListener('click', async () => { await post('/api/paper/close', { positionId: b.dataset.close }); renderJournal(); }));
  $$('[data-mgmt]').forEach(b => b.addEventListener('click', () => openPositionManagement(b.dataset.mgmt, openPos)));
  renderBacktestCard($('#backtestWrap'));
}

// ---------------- v1.15 Backtest Lab (FXReplay methodology) ----------------
async function renderBacktestCard(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:8px">Backtest Lab <span class="sub">validate rules before risking capital · expectancy, profit factor, max drawdown, vs buy-and-hold</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <input type="text" id="btSym" value="BTC" maxlength="12" style="width:80px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <select id="btTf" style="padding:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)"><option value="1d">1d</option><option value="4h">4h</option><option value="1h">1h</option><option value="15m">15m</option></select>
        <select id="btRule" style="padding:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
          <option value="ma-cross">MA cross</option><option value="rsi">RSI reversion</option><option value="breakout">Breakout</option><option value="ai-score">AI proxy score</option>
        </select>
        <select id="btSide" style="padding:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)"><option value="long">long</option><option value="short">short</option></select>
        <input type="number" id="btP1" placeholder="fast" value="20" step="1" style="width:64px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <input type="number" id="btP2" placeholder="slow" value="50" step="1" style="width:64px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <input type="number" id="btStop" placeholder="stop %" value="5" step="0.5" style="width:76px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <input type="number" id="btTarget" placeholder="target %" value="10" step="0.5" style="width:84px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--txt)">
        <button class="btn sm" id="btRun">▶ Run backtest</button>
      </div>
      <div id="btOut" style="margin-top:12px"></div>
    </div>`;
  const p1 = $('#btP1'), p2 = $('#btP2');
  $('#btRule')?.addEventListener('change', (e) => {
    const r = e.target.value;
    if (r === 'ma-cross') { p1.placeholder = 'fast'; p1.value = 20; p2.style.display = ''; p2.placeholder = 'slow'; p2.value = 50; }
    else if (r === 'rsi') { p1.placeholder = 'oversold'; p1.value = 30; p2.style.display = ''; p2.placeholder = 'overbought'; p2.value = 70; }
    else if (r === 'breakout') { p1.placeholder = 'lookback'; p1.value = 20; p2.style.display = 'none'; }
    else { p1.placeholder = 'threshold'; p1.value = 65; p2.style.display = 'none'; }
  });
  $('#btRun')?.addEventListener('click', async () => {
    const rule = $('#btRule').value;
    const params = rule === 'ma-cross' ? { fast: +p1.value || 20, slow: +p2.value || 50 }
      : rule === 'rsi' ? { oversold: +p1.value || 30, overbought: +p2.value || 70 }
      : rule === 'breakout' ? { lookback: +p1.value || 20 }
      : { threshold: +p1.value || 65, side: $('#btSide').value };
    const body = {
      symbol: $('#btSym').value.trim().toUpperCase() || 'BTC',
      timeframe: $('#btTf').value,
      strategy: {
        name: `${rule} · ${$('#btSide').value}`,
        side: $('#btSide').value,
        entry: { rule, params },
        exit: {
          stopPct: $('#btStop').value ? +$('#btStop').value / 100 : null,
          targetPct: $('#btTarget').value ? +$('#btTarget').value / 100 : null,
        },
        sizePct: 0.5,
      },
    };
    const out = $('#btOut');
    out.innerHTML = '<div class="muted" style="font-size:13px">Running backtest…</div>';
    const r = await fetch('/api/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    if (r.status !== 200) { out.innerHTML = `<div class="empty" style="color:var(--down)">${esc(r.body.error || r.status)}</div>`; return; }
    const d = r.body;
    const k = d.kpis;
    const kpi = (label, val, sub, cls = '') => `<div class="card kpi"><span class="k-label">${label}</span><span class="k-value ${cls}">${val}</span><span class="k-sub">${sub}</span></div>`;
    const tradeRows = (d.trades || []).slice(-15).reverse().map(t => `
      <tr><td class="mono">${t.side}</td><td class="mono">${fmtPrice(t.entry, 'crypto')}</td><td class="mono">${fmtPrice(t.exit, 'crypto')}</td>
      <td class="mono ${t.pnl >= 0 ? 'up' : 'down'}">$${fmtNum(t.pnl)}</td><td><span class="chip ${t.pnl > 0 ? 'bull' : 'bear'}">${esc(t.reason)}</span></td></tr>`).join('');
    out.innerHTML = `
      <div class="stat-cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:10px">
        ${kpi('Trades', k.trades, 'how many signals fired in the period')}
        ${kpi('Win rate', k.winRate != null ? k.winRate + '%' : '—', '% of trades that made money — weak on its own')}
        ${kpi('Expectancy', k.expectancy != null ? '$' + k.expectancy : '—', 'average $ per trade — the real edge test', k.expectancy >= 0 ? 'up' : 'down')}
        ${kpi('Profit factor', k.profitFactor ?? '—', 'gross wins ÷ gross losses · 1.5+ = strong', (k.profitFactor ?? 0) >= 1.5 ? 'up' : '')}
        ${kpi('Max drawdown', k.maxDrawdownPct + '%', 'worst peak-to-trough dip — can you stomach it?', 'down')}
        ${kpi('Sharpe', k.sharpe ?? '—', 'return per unit of risk · higher = smoother')}
        ${kpi('Cumulative return', k.cumulativeReturnPct + '%', 'total growth of the $10K starting stake', k.cumulativeReturnPct >= 0 ? 'up' : 'down')}
        ${kpi('vs buy &amp; hold', k.vsBuyHoldPct + '%', 'strategy vs simply holding the asset', k.vsBuyHoldPct >= 0 ? 'up' : 'down')}
      </div>
      <canvas id="btCurve" height="120" style="width:100%;margin-bottom:8px" aria-label="Backtest equity curve"></canvas>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;margin-bottom:8px">
        <span class="muted">${esc(d.symbol)} · ${esc(d.timeframe)} · ${esc(d.strategy.entry)} · stop ${d.strategy.exit.stopPct ? (d.strategy.exit.stopPct * 100) + '%' : '—'} / target ${d.strategy.exit.targetPct ? (d.strategy.exit.targetPct * 100) + '%' : '—'}</span>
        <span class="${d.honesty.significantSample ? 'up' : 'warn'}">${esc(d.honesty.note)}</span>
      </div>
      <div class="muted" style="font-size:11px;margin-bottom:8px">${esc(d.honesty.disclaimer)} · assumptions: ${esc(d.honesty.assumptions.join(', '))}</div>
      ${tradeRows ? `<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Exit reason</th></tr></thead><tbody>${tradeRows}</tbody></table></div>` : ''}`;
    drawEquityCurve('btCurve', d.equityCurve || [], d.kpis.finalEquity);
  });
}

// minimal equity-curve line renderer (no deps)
function drawEquityCurve(canvasId, curve, finalEquity) {
  const c = document.getElementById(canvasId);
  if (!c || !curve.length) return;
  const ctx = c.getContext('2d');
  const W = c.clientWidth || 600, H = 120;
  c.width = W * 2; c.height = H * 2; ctx.scale(2, 2);
  ctx.clearRect(0, 0, W, H);
  const vals = curve.map(p => p.equity);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  curve.forEach((p, i) => {
    const x = (i / (curve.length - 1)) * (W - 10) + 5;
    const y = H - 8 - ((p.equity - min) / span) * (H - 16);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,229,255,.10)';
  ctx.lineTo((W - 5), H - 8); ctx.lineTo(5, H - 8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#8b98a5'; ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(`$${min.toLocaleString()}`, 6, H - 2);
  ctx.fillText(`$${max.toLocaleString()}`, W - 70, 12);
}

// v1.13 — manage trailing stop / trailing TP / DCA on an open position
function openPositionManagement(positionId, positions) {
  const pos = positions.find(p => p.id === positionId);
  if (!pos) return;
  const modal = $('#detailModal');
  const d = pos.dca?.enabled ? pos.dca : null;
  $('#detailBody').innerHTML = `
    <button class="modal-close" aria-label="Close">✕</button>
    <h3>Manage ${esc(pos.symbol)} ${pos.side} <span class="dim" style="font-size:12px">entry ${fmtPrice(pos.entry, pos.type)} · peak ${fmtPrice(pos.trailPeak ?? pos.entry, pos.type)}</span></h3>
    <div class="grid g-2">
      <div class="field"><label>Trailing stop % <span class="dim">(0 = off)</span></label><input id="mStop" type="number" step="0.1" min="0" max="50" value="${pos.trailStopPct ? +(pos.trailStopPct * 100).toFixed(1) : ''}" placeholder="off"></div>
      <div class="field"><label>Trailing TP % <span class="dim">(0 = off)</span></label><input id="mTp" type="number" step="0.1" min="0" max="50" value="${pos.trailTpPct ? +(pos.trailTpPct * 100).toFixed(1) : ''}" placeholder="off"></div>
      <div class="field" style="grid-column:1/-1"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="mDca" ${d ? 'checked' : ''}> Enable DCA <span class="dim">— average down on dips (score-gated)</span></label></div>
      <div class="field" id="mDcaRow"><label>Trigger dip %</label><input id="mDcaTrig" type="number" step="0.1" min="1" max="50" value="${d ? +(d.triggerPct * 100).toFixed(0) : 5}"></div>
      <div class="field" id="mDcaRow2"><label>Max adds <span class="dim">(used ${pos.dcaCount})</span></label><input id="mDcaMax" type="number" step="1" min="1" max="10" value="${d ? d.maxTrades : 3}"></div>
      <div class="field" id="mDcaRow3"><label>Add size ×</label><input id="mDcaFactor" type="number" step="0.1" min="0.1" max="2" value="${d ? d.sizeFactor : 0.5}"></div>
      <div class="field" id="mDcaRow4"><label>Cooldown (min)</label><input id="mDcaCool" type="number" step="1" min="5" value="${d ? d.cooldownMin : 60}"></div>
    </div>
    <div class="grid g-2" style="margin-top:12px">
      <button class="btn green" id="mSave">Save</button>
      <button class="btn ghost" id="mCancel">Cancel</button>
    </div>
    <div class="dim" style="font-size:11px;margin-top:10px">Trailing levels ratchet with price and are re-checked every 60s. DCA triggers only when the score stays ≥ 55 — the AI won't average down into a dying setup.</div>`;
  openDetailDialog(`Manage ${pos.symbol} paper position`);
  $('#detailBody .modal-close').onclick = closeDetail;
  $('#mCancel').onclick = closeDetail;
  $('#mDca')?.addEventListener('change', (e) => {
    const on = e.target.checked;
    ['mDcaRow', 'mDcaRow2', 'mDcaRow3', 'mDcaRow4'].forEach(id => { const el = $('#' + id); if (el) el.style.display = on ? '' : 'none'; });
  });
  if (!d) ['mDcaRow', 'mDcaRow2', 'mDcaRow3', 'mDcaRow4'].forEach(id => { const el = $('#' + id); if (el) el.style.display = 'none'; });
  $('#mSave').addEventListener('click', async () => {
    const body = {
      trailStopPct: $('#mStop').value ? +$('#mStop').value / 100 : null,
      trailTpPct: $('#mTp').value ? +$('#mTp').value / 100 : null,
      dca: $('#mDca')?.checked ? {
        enabled: true,
        triggerPct: +($('#mDcaTrig').value || 5) / 100,
        maxTrades: +($('#mDcaMax').value || 3),
        sizeFactor: +($('#mDcaFactor').value || 0.5),
        cooldownMin: +($('#mDcaCool').value || 60),
      } : null,
    };
    const r = await post(`/api/paper/${positionId}/management`, body);
    if (r.ok) { closeDetail(); toast('✅ Position management updated'); renderJournal(); }
    else toast(`⚠️ ${esc(r.error || 'failed')}`);
  });
}

// ---------------- Trade modal ----------------
function openTradeModal(symbol = '', side = 'long', confidence = null) {
  const modal = $('#detailModal');
  const syms = [...(state.scan || []).map(a => a.symbol)].join(',');
  $('#detailBody').innerHTML = `
    <button class="modal-close" aria-label="Close">✕</button>
    <h3>Open paper trade</h3>
    <div class="grid g-2">
      <div class="field"><label>Symbol</label><input id="tSym" list="symList" value="${esc(symbol)}" placeholder="IOST"><datalist id="symList">${syms.split(',').map(s => `<option value="${s}">`).join('')}</datalist></div>
      <div class="field"><label>Side</label><select id="tSide"><option value="long" ${side === 'long' ? 'selected' : ''}>Long</option><option value="short" ${side === 'short' ? 'selected' : ''}>Short</option></select></div>
      <div class="field"><label>Size (units)</label><input id="tSize" type="number" step="any" placeholder="e.g. 100000"></div>
      <div class="field"><label>Entry <span class="dim">(blank = market)</span></label><input id="tEntry" type="number" step="any"></div>
      <div class="field"><label>Stop</label><input id="tStop" type="number" step="any"></div>
      <div class="field"><label>Target</label><input id="tTarget" type="number" step="any"></div>
      <div class="field"><label>Trailing stop % <span class="dim">(0 = off)</span></label><input id="tTrailStop" type="number" step="0.1" min="0" max="50" placeholder="e.g. 3"></div>
      <div class="field"><label>Trailing TP % <span class="dim">(locks profit)</span></label><input id="tTrailTp" type="number" step="0.1" min="0" max="50" placeholder="e.g. 5"></div>
      <div class="field" style="grid-column:1/-1"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="tDca"> Enable DCA <span class="dim">— auto average-down on dips (score-gated)</span></label></div>
      <div class="field" id="tDcaRow" style="display:none"><label>DCA trigger dip %</label><input id="tDcaTrig" type="number" step="0.1" min="1" max="50" value="5"></div>
      <div class="field" id="tDcaRow2" style="display:none"><label>Max adds</label><input id="tDcaMax" type="number" step="1" min="1" max="10" value="3"></div>
      <div class="field" id="tDcaRow3" style="display:none"><label>Add size × <span class="dim">(of original)</span></label><input id="tDcaFactor" type="number" step="0.1" min="0.1" max="2" value="0.5"></div>
      <div class="field" id="tDcaRow4" style="display:none"><label>Cooldown (min)</label><input id="tDcaCool" type="number" step="1" min="5" value="60"></div>
      <div class="field" style="grid-column:1/-1"><label>Reason <span class="dim">(e.g. breakout + volume)</span></label><input id="tReason" placeholder="breakout + volume"></div>
      <div class="field" style="grid-column:1/-1"><label>AI confidence <span class="dim">(auto from score)</span></label><input id="tConf" type="number" value="${confidence ?? ''}"></div>
    </div>
    <div class="grid g-2">
      <button class="btn green" id="tSubmit">Place paper trade</button>
      <button class="btn ghost" id="tCancel">Cancel</button>
    </div>
    <div class="dim" style="font-size:11px;margin-top:12px">Paper execution — simulated fill at current market price. No real money moves.</div>`;
  openDetailDialog(`Open ${symbol || 'a'} paper trade`);
  $('#detailBody .modal-close').onclick = closeDetail;
  $('#tCancel').onclick = closeDetail;
  $('#tDca')?.addEventListener('change', (e) => {
    const on = e.target.checked;
    ['tDcaRow', 'tDcaRow2', 'tDcaRow3', 'tDcaRow4'].forEach(id => { const el = $('#' + id); if (el) el.style.display = on ? '' : 'none'; });
  });
  $('#tSym').addEventListener('input', async (e) => {
    const v = e.target.value.trim().toUpperCase();
    const sc = state.scores.find(s => s.symbol === v);
    if (sc) $('#tConf').value = sc.composite;
  });
  $('#tSubmit').addEventListener('click', async () => {
    const body = {
      symbol: $('#tSym').value.trim().toUpperCase(), side: $('#tSide').value,
      size: +$('#tSize').value, entry: $('#tEntry').value ? +$('#tEntry').value : null,
      stop: $('#tStop').value ? +$('#tStop').value : null, target: $('#tTarget').value ? +$('#tTarget').value : null,
      reason: $('#tReason').value, confidence: $('#tConf').value ? +$('#tConf').value : null,
      trailStopPct: $('#tTrailStop').value ? +$('#tTrailStop').value / 100 : null,
      trailTpPct: $('#tTrailTp').value ? +$('#tTrailTp').value / 100 : null,
      dca: $('#tDca')?.checked ? {
        enabled: true,
        triggerPct: +($('#tDcaTrig').value || 5) / 100,
        maxTrades: +($('#tDcaMax').value || 3),
        sizeFactor: +($('#tDcaFactor').value || 0.5),
        cooldownMin: +($('#tDcaCool').value || 60),
      } : null,
    };
    const r = await post('/api/paper/open', body);
    if (r.ok) { closeDetail(); switchView('journal'); }
    else {
      const errBox = $('#detailBody').insertAdjacentHTML('beforeend', `<div class="empty" style="color:var(--down);padding:12px 0">${esc(r.error || (r.errors || []).join(', '))}</div>`);
    }
  });
}

// ---------------- SSE ----------------
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => { $('#liveDot').classList.add('live'); sseOk = true; });
  es.addEventListener('error', () => { $('#liveDot').classList.remove('live'); });
  es.addEventListener('tick', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      state.scan = d.scan;
      state.scores = d.scores;
      $('#footTs').textContent = `last update ${timeAgo(d.ts)}`;
      updateTickerPrices();
      checkWhales();
      if (state.activeView === 'scanner') renderScanner(true);
      else if (state.activeView === 'scores') renderScores(true);
    } catch { /* ignore malformed */ }
  });
}

// ---------------- v1.6: AI command intelligence rail ----------------
async function renderCommandRail() {
  const t0 = performance.now();
  const [probs, paper, perf, ap, acct, pts] = await Promise.all([
    api('/api/probability').catch(() => []),
    api('/api/paper').catch(() => null),
    api('/api/performance').catch(() => null),
    api('/api/autopilot').catch(() => null),
    api('/api/account').catch(() => null),
    api('/api/points').catch(() => null),
  ]);
  const lat = Math.round(performance.now() - t0);
  const top = probs[0] || null;
  const pct = top ? Math.round(top.probUp * 100) : null;
  state.railTop = top?.symbol || null;
  state.railScore = top ? Math.round(top.probUp * 100) : null;

  const gc = $('#gaugeCanvas');
  if (gc) drawGauge(gc, pct, top?.direction);
  $('#gaugeSym').textContent = top ? `${top.symbol}/USDT` : '--';
  $('#gaugeLabel').textContent = top ? `${top.direction === 'bullish' ? 'BULLISH' : top.direction === 'bearish' ? 'BEARISH' : 'NEUTRAL'} ${pct}%` : '--';

  const rec = $('#fusionRec');
  if (top) {
    const cls = top.direction === 'bullish' ? 'bull' : top.direction === 'bearish' ? 'bear' : 'neut';
    rec.textContent = pct >= 60 ? 'Strong Buy' : pct <= 40 ? 'Strong Sell' : pct >= 55 ? 'Buy' : pct <= 45 ? 'Sell' : 'Hold';
    rec.className = `fusion-rec ${cls}`;
    $('#fusionConf').textContent = `${pct}% confidence · CI ${Math.round(top.ciLo * 100)}–${Math.round(top.ciHi * 100)}%`;
    const why = (top.drivers || []).join(' + ');
    $('#fusionQuote').textContent = why
      ? `Current tape: ${why.replace(/\s*\([^)]*\)/g, '')} — the agent reads ${pct}% probability of upside on ${top.symbol}.`
      : `The agent reads ${pct}% probability of upside on ${top.symbol} over the current setup horizon.`;
    $('#fusionDrivers').innerHTML = (top.drivers || []).map(d => `<span class="chip">${esc(d)}</span>`).join(' ');
  } else {
    rec.textContent = '—'; rec.className = 'fusion-rec neut';
    $('#fusionConf').textContent = '--% confidence';
    $('#fusionQuote').textContent = 'awaiting signal…';
    $('#fusionDrivers').innerHTML = '';
  }

  // state classification: 24H high/low/volume from 1d candles of the top asset
  if (top) {
    const k = await api(`/api/klines/${top.symbol}?bar=1d&limit=2`).catch(() => []);
    if (k.length) {
      $('#stHigh').textContent = fmtPrice(Math.max(...k.map(x => x.h)), 'crypto');
      $('#stLow').textContent = fmtPrice(Math.min(...k.map(x => x.l)), 'crypto');
      $('#stVol').textContent = k.reduce((a, x) => a + (x.v || 0), 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
  }
  $('#stLat').textContent = `${lat}ms`;

  // balance + autopilot chip — balance is the signed-in user's own paper account
  const balEl = $('#tbBalance');
  if (balEl) {
    if (acct) balEl.textContent = Number(acct.cash).toLocaleString('en-US', { maximumFractionDigits: 2 });
    else if (paper) balEl.textContent = Number(paper.account.cash).toLocaleString('en-US', { maximumFractionDigits: 2 });
    else balEl.textContent = '--';
  }
  // points balance (off-chain; 1:1 AITT planned at TGE — honest chip)
  const ptEl = $('#tbPoints');
  if (ptEl) ptEl.textContent = pts && Number.isFinite(pts.balance) ? String(pts.balance) : '--';
  const apChip = $('#tbAutopilot');
  if (apChip) {
    apChip.textContent = ap?.enabled ? 'AUTOPILOT ON' : 'AUTOPILOT OFF';
    apChip.classList.toggle('on', !!ap?.enabled);
  }

  // portfolio donut: cash + open positions
  const segs = [];
  if (paper) {
    segs.push({ label: 'CASH', v: Math.max(0, paper.account.cash), color: '#00e5ff' });
    for (const p of paper.positions) {
      segs.push({ label: p.symbol, v: Math.max(0, p.notional || 0), color: null });
    }
    const total = segs.reduce((a, s) => a + s.v, 0) || 1;
    const dc = $('#donutCanvas');
    if (dc) drawDonut(dc, segs);
    const pfPnl = paper.positions.length ? paper.positions.reduce((a, p) => a + (p.unrealizedPnl || 0), 0) : (perf?.kpis?.totalPnl ?? 0);
    $('#pfPnl').textContent = `P/L ${pfPnl >= 0 ? '+' : ''}${Number(pfPnl).toFixed(2)}`;
    $('#pfPnl').style.color = pfPnl >= 0 ? 'var(--mint)' : 'var(--red)';
    $('#donutLegend').innerHTML = segs.filter(s => s.v > total * 0.005).map(s =>
      `<span><b style="color:var(--cyan)">${esc(s.label)}</b> ${(s.v / total * 100).toFixed(0)}%</span>`).join('');
  }
}
function drawGauge(cv, pct, dir) {
  if (!cv) return;
  const dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);
  // The intelligence rail is hidden at narrow breakpoints. Avoid constructing
  // a negative-radius arc while its canvas has no rendered width.
  if (w < 32 || h < 32) return;
  const cx = w / 2, cy = h - 10, r = Math.min(w / 2 - 8, h - 16);
  const v = Math.max(0, Math.min(100, pct ?? 50)) / 100;
  ctx.lineWidth = 11; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 0); ctx.stroke();
  const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
  grad.addColorStop(0, '#ff5c5c'); grad.addColorStop(.5, '#ffc857'); grad.addColorStop(1, '#22d3aa');
  ctx.strokeStyle = grad;
  ctx.shadowColor = v >= .55 ? 'rgba(34,211,170,.7)' : v <= .45 ? 'rgba(255,92,92,.7)' : 'rgba(255,200,87,.6)';
  ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * v); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI + Math.PI * (i / 10);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r + 6), cy + Math.sin(a) * (r + 6));
    ctx.lineTo(cx + Math.cos(a) * (r + 10), cy + Math.sin(a) * (r + 10));
    ctx.stroke();
  }
}
function drawDonut(cv, segs) {
  if (!cv) return;
  const dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 8;
  const total = segs.reduce((a, s) => a + s.v, 0) || 1;
  const colors = ['#00e5ff', '#22d3aa', '#7c5cff', '#ffc857', '#ff5c5c', '#38bdf8', '#f472b6', '#a3e635'];
  let a0 = -Math.PI / 2;
  segs.forEach((s, i) => {
    const a1 = a0 + (s.v / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1); ctx.closePath();
    ctx.fillStyle = s.color || colors[i % colors.length]; ctx.fill();
    a0 = a1;
  });
  ctx.beginPath(); ctx.arc(cx, cy, r * .62, 0, 7); ctx.fillStyle = 'rgba(10,15,26,.95)'; ctx.fill();
}

// ---------------- boot ----------------
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
switchView(location.hash.replace('#', '') || 'scanner');
connectSSE();

// command center rail + controls
renderCommandRail();
setInterval(renderCommandRail, 15000);
$('#tbRescan')?.addEventListener('click', () => { if (state.activeView === 'scanner') renderScanner(true); toast('Rescan triggered'); });
// topbar points chip → Points view (keyboard accessible: Enter/Space)
const tbPointsWrap = $('#tbPointsWrap');
if (tbPointsWrap) {
  tbPointsWrap.addEventListener('click', () => switchView('points'));
  tbPointsWrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchView('points'); } });
}
$('#tbAutopilot')?.addEventListener('click', async () => {
  if (!window.Auth?.state?.loggedIn) { window.Auth?.open('login'); return; }
  const ap = await api('/api/autopilot').catch(() => null);
  await post(ap?.enabled ? '/api/autopilot/stop' : '/api/autopilot/start', {});
  renderCommandRail();
  if (state.activeView === 'portfolio' || state.activeView === 'risk') refreshView(state.activeView);
});
$('#cmdBuy')?.addEventListener('click', () => { if (!window.Auth?.state?.loggedIn) { window.Auth?.open('login'); return; } if (state.railTop) openTradeModal(state.railTop, 'long', state.railScore); });
$('#cmdSell')?.addEventListener('click', () => { if (!window.Auth?.state?.loggedIn) { window.Auth?.open('login'); return; } if (state.railTop) openTradeModal(state.railTop, 'short', state.railScore); });

// ---- auth gating (state driven by /js/auth.js, which dispatches 'authchange') ----
function applyAuthGate() {
  const ok = !!window.Auth?.state?.loggedIn;
  ['cmdBuy', 'cmdSell', 'tbAutopilot'].forEach(id => {
    const el = $('#' + id);
    if (el) { el.disabled = !ok; el.title = ok ? '' : 'Sign in required'; }
  });
  if (['portfolio', 'journal', 'performance', 'evaluation', 'control', 'trace', 'points', 'wallet'].includes(state.activeView) && !ok) refreshView(state.activeView);
  // topbar balance follows the signed-in user's account
  const bal = $('#tbBalance');
  if (!ok && bal) bal.textContent = '--';
  const pt = $('#tbPoints');
  if (!ok && pt) pt.textContent = '--';
}
window.addEventListener('authchange', (e) => {
  applyAuthGate();
  if (e.detail?.loggedIn) renderCommandRail(); // show the user's balance immediately on sign-in
  if (e.detail?.loggedIn && ['portfolio', 'journal', 'performance', 'evaluation', 'control', 'trace', 'points', 'wallet'].includes(state.activeView)) refreshView(state.activeView);
});
setTimeout(applyAuthGate, 2500); // safety re-run once auth.js has settled

// ---- sign-in gate: the Terminal requires an account (free) ----
// Shows until the user signs in; the auth modal auto-opens on top of it.
function applyGate() {
  const gate = $('#gateOverlay');
  if (!gate) return;
  const ok = !!window.Auth?.state?.loggedIn;
  const dismissed = gate.dataset.dismissed === '1' || localStorage.getItem('iost.gate.dismissed') === '1';
  const coveredByAuth = gate.dataset.authCovered === '1';
  gate.classList.toggle('hidden', ok || dismissed || coveredByAuth);
  // Auto-open the auth modal ONLY when the landing page asked for it (?auth=login|signup).
  // Otherwise the gate stands alone with its X — no modal stacking on top of it.
  const wantAuth = new URLSearchParams(location.search).get('auth');
  if (!ok && !dismissed && !gate.dataset.autoOpened && wantAuth) {
    gate.dataset.autoOpened = '1';
    setTimeout(() => {
      if (!gate.dataset.dismissed && !window.Auth?.state?.loggedIn)
        window.Auth?.open(wantAuth === 'signup' ? 'signup' : 'login');
    }, 350);
  }
}
$('#gateLogin')?.addEventListener('click', () => window.Auth?.open('login'));
$('#gateSignup')?.addEventListener('click', () => window.Auth?.open('signup'));
$('#gateClose')?.addEventListener('click', () => {
  const gate = $('#gateOverlay');
  if (!gate) return;
  gate.dataset.dismissed = '1';
  try { localStorage.setItem('iost.gate.dismissed', '1'); } catch { /* private mode */ }
  gate.classList.add('hidden');
  window.Auth?.close?.(); // in case the auth modal auto-opened on top
});
window.addEventListener('authchange', (e) => {
  if (e.detail?.loggedIn) { const g = $('#gateOverlay'); if (g) g.classList.add('hidden'); }
  applyGate();
  if (pendingGotoKeys && e.detail?.loggedIn) gotoApiKeyInput();
});
setTimeout(applyGate, 1800); // once auth.js has settled
setTimeout(() => {
  if (new URLSearchParams(location.search).get('goto') === 'keys') gotoApiKeyInput();
}, 2000); // landing "Connect your key" deep link — after the auth modal has had its chance to auto-open

// ---------------- ARD: machine-readable page state ----------------
// any agent parsing the DOM can read the exact live state of this view
setInterval(async () => {
  try {
    const s = await api('/api/ui-state');
    const st = document.getElementById('agent-state');
    if (st) st.textContent = JSON.stringify({ ts: s.ts, view: state.activeView, top: s.scores?.[0], account: s.account, autopilot: s.autopilot ? { enabled: s.autopilot.enabled } : null, market: s.market ? { bullish: s.market.bullish, neutral: s.market.neutral, bearish: s.market.bearish } : null });
  } catch { /* keep last state */ }
}, 15000);
