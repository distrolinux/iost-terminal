// server.js — IOST Terminal: AI real-trading platform (paper execution)
import express from 'express';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTicker, WATCHLIST } from './lib/market.js';
import { getGlobalMetrics, getTopMovers, getMarketExtras } from './lib/marketdata.js';
import { scanAll, analyzeSymbol } from './lib/scanner.js';
import { computeScores } from './lib/score.js';
import { getNews, getAssetSentiment } from './lib/news.js';
import { getChainSnapshot } from './lib/onchain.js';
import { calculateRisk, portfolioExposure } from './lib/risk.js';
import { analyzePortfolio } from './lib/portfolio.js';
import { getState, closeTrade, resetAccount, setAccountSize, markToMarket, journalStats, ensureAccount, listAccounts, persistAccounts } from './lib/paper.js';
import { getBroker } from './lib/broker/index.js';
import { enableLive, disableLive, getLiveState, logLiveEvent, anyLiveEnabled, isLiveAllowed } from './lib/live.js';
import { checkLiveOrder } from './lib/rails.js';
import { getFeeConfig, setFeeConfig, canTrade, burnCredits, grantCredits, walletSummary } from './lib/fees.js';
import { setUserKrakenKey, getUserKrakenKeys, clearUserKrakenKey, userKrakenStatus } from './lib/keys.js';
import { createPayment, listPayments, confirmPayment, rejectPayment } from './lib/payments.js';
import { answer, assistantStatus } from './lib/assistant.js';
import { getAutopilot, startAutopilot, stopAutopilot, setAutopilotConfig, tickAutopilot, getProposals, approveProposal, rejectProposal } from './lib/autopilot.js';
import { probabilityOf, recordProbability, getProbHistory, getOrderBook, getContractSpec } from './lib/probability.js';
import * as chain from './lib/chain.js';
import * as signals from './lib/signals.js';
import * as points from './lib/points.js';
import * as iostAccounts from './lib/iost-accounts.js';
import * as agentKeys from './lib/agent-keys.js';
import * as liveProposals from './lib/live-proposals.js';
import * as management from './lib/management.js';
import * as triggers from './lib/triggers.js';
import { runBacktest, describeRule } from './lib/backtest.js';
import session from 'express-session';
import { FileSessionStore } from './lib/session-store.js';
import { authRouter, authLimiter } from './lib/auth-routes.js';
import * as auth from './lib/auth.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

// ---- .env loader (KEY=VALUE, '#' comments; real env vars win) ----
import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync, appendFile } from 'node:fs';
import crypto from 'node:crypto';
{
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
}

// ---- session secret: env SESSION_SECRET, or persisted generated file (reused across restarts) ----
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = join(ROOT, 'data', 'session-secret');
  try {
    if (existsSync(f)) {
      const s = readFileSync(f, 'utf8').trim();
      if (s) return s;
    }
  } catch { /* fall through -> generate */ }
  const secret = crypto.randomBytes(32).toString('hex');
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(f, secret, { mode: 0o600 });
  chmodSync(f, 0o600);
  return secret;
}

const app = express();
app.use(express.json({ limit: '200kb' }));

// ---- launch readiness: security headers on EVERY response ----
// Pragmatic CSP: the app ships inline scripts/styles (landing shader, hub scene,
// SSR machine layer) and same-origin APIs only. 'unsafe-inline' is required by
// the inline <script>/<style> blocks; 'unsafe-eval' is a safety valve for
// WebGL/three.js bundles (not currently needed — see browser test below).
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
};
app.use((req, res, next) => {
  res.set(SECURITY_HEADERS);
  next();
});

const SITE_URL = 'https://iostcallister.com'; // canonical public origin

// ---- sessions: cookie 'iost.sid', httpOnly, lax, Secure when behind TLS ----
// secure:'auto' → Secure flag only when the request arrived over HTTPS
// (Traefik / cloudflared set X-Forwarded-Proto; trust proxy enables that).
app.set('trust proxy', 1);
app.use(session({
  name: 'iost.sid',
  secret: loadSessionSecret(),
  store: new FileSessionStore(), // survives restarts — no more surprise logouts
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 4 * 3600 * 1000 }, // 4h, then auto logout
}));

// ---------- machine-first agent layer ----------
// API keys (optional; agents SHOULD authenticate). Set AGENT_KEYS="k1,k2" or default demo key.
// Registered BEFORE all routes so every protected route can see a valid key.
const AGENT_KEYS = new Set((process.env.AGENT_KEYS || 'demo-agent-key').split(',').map(s => s.trim()).filter(Boolean));
app.use((req, res, next) => {
  const key = req.get('x-api-key') || '';
  req.agentKey = key && AGENT_KEYS.has(key) ? key : null;
  // per-user agent keys ("connect your AI agent"): a key is bound to ONE user
  // account and resolves to their principal (userId + scopes). Platform
  // AGENT_KEYS keep trading the shared 'default' account; user keys trade the
  // account they were created for.
  req.userAgent = null;
  if (!req.agentKey && key) {
    const ua = agentKeys.resolve(key);
    if (ua) { req.userAgent = ua; agentKeys.touch(ua.keyId); }
  }
  next();
});
// scope guard for per-user agent keys — platform keys & sessions are unaffected
function userAgentHas(req, scope) {
  return !!(req.userAgent && req.userAgent.scopes.includes(scope));
}

// ---- append-only agent audit log (data/agent-audit.jsonl) ----
// Every agent-authenticated (X-API-Key identity) request to a signal, paper
// or agent endpoint is recorded with a payload HASH only — never raw payload
// contents, API keys, emails or passwords. JSONL append via fs.appendFile —
// the file is never rewritten. Reading the tail: GET /api/audit?agent=&limit=
const AUDIT_FILE = join(ROOT, 'data', 'agent-audit.jsonl');
const AUDIT_ROUTES = [
  { re: /^\/api\/signals$/, method: 'POST', action: 'signal.publish' },
  { re: /^\/api\/signals\/feed$/, method: 'GET', action: 'signals.feed' },
  { re: /^\/api\/signals\/[^/]+\/proof$/, method: 'GET', action: 'signal.proof' },
  { re: /^\/api\/signals\/[^/]+\/trail$/, method: 'GET', action: 'signal.trail' },
  { re: /^\/api\/signals\/[^/]+\/follow$/, method: 'POST', action: 'signal.follow' },
  { re: /^\/api\/signals\/[^/]+\/follow$/, method: 'DELETE', action: 'signal.unfollow' },
  { re: /^\/api\/agents$/, method: 'GET', action: 'agents.list' },
  { re: /^\/api\/paper$/, method: 'GET', action: 'paper.read' },
  { re: /^\/api\/paper\/open$/, method: 'POST', action: 'paper.open' },
  { re: /^\/api\/paper\/close$/, method: 'POST', action: 'paper.close' },
  { re: /^\/api\/paper\/stats$/, method: 'GET', action: 'paper.stats' },
  { re: /^\/api\/paper\/reset$/, method: 'POST', action: 'paper.reset' },
  { re: /^\/api\/audit$/, method: 'GET', action: 'audit.read' },
];
// canonical sha256 of JSON.stringify(sorted keys) — deterministic payload fingerprint
function canonicalHash(obj) {
  const sort = (o) => {
    if (Array.isArray(o)) return o.map(sort);
    if (o && typeof o === 'object') return Object.keys(o).sort().reduce((acc, k) => { acc[k] = sort(o[k]); return acc; }, {});
    return o;
  };
  return crypto.createHash('sha256').update(JSON.stringify(sort(obj ?? {}))).digest('hex');
}
app.use((req, res, next) => {
  if (!req.agentKey) return next();
  const rule = AUDIT_ROUTES.find((r) => r.method === req.method && r.re.test(req.path));
  if (!rule) return next();
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  res.on('finish', () => {
    const entry = {
      ts: new Date().toISOString(),
      agentId: `agent:${req.agentKey}`,
      action: rule.action,
      endpoint: req.path,
      payloadHash: canonicalHash(payload),
      outcome: res.statusCode < 400 ? 'ok' : 'error',
      statusCode: res.statusCode,
    };
    try {
      mkdirSync(join(ROOT, 'data'), { recursive: true });
      appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', () => {});
    } catch (e) { console.warn(`[audit] append failed: ${e.message}`); }
  });
  next();
});

// ================= SSR: dual-layer architecture =================
// Layer 1 (human): immersive visuals — unchanged, enhanced by client JS.
// Layer 2 (machine): the SAME market data server-rendered into the initial HTML —
//   semantic tables, ARIA-labelled controls, JSON-LD knowledge graph and a
//   machine-readable state blob. Agents / screen readers never see a blank page:
//   prices, scores, on-chain state and execution CTAs are in the first response.

const PAGES = {};
for (const f of ['index.html', 'hub.html', 'app.html']) {
  PAGES[f] = readFileSync(join(ROOT, 'public', f), 'utf8');
}

let ssrState = null; // cached snapshot refreshed every 30s (no per-request scans)
async function refreshSsrState() {
  try {
    const [scan, scores, onchain, market, paper] = await Promise.all([
      scanAll().catch(() => []),
      allScores().catch(() => []),
      getChainSnapshot().catch(() => null),
      getNews().catch(() => null),
      markToMarket().catch(() => getState()),
    ]);
    // probabilistic clarity: record the rolling upside-probability timeline
    const scanBySym = new Map(scan.map((a) => [a.symbol, a]));
    for (const s of scores) {
      const prob = probabilityOf(s, scanBySym.get(s.symbol));
      if (prob) recordProbability(s.symbol, prob);
    }
    ssrState = {
      ts: Date.now(),
      scan: scan.slice(0, 16),
      scores, // full list — probability/JSON-LD cover the whole watchlist; UI slices
      onchain,
      market,
      paper,
      autopilot: getAutopilot(),
    };
    probCache.clear();
  } catch { /* keep last good snapshot */ }
}
const probCache = new Map(); // symbol → probabilityOf() result for the current snapshot
function probFor(sym) {
  if (!ssrState) return null;
  if (!probCache.has(sym)) {
    const score = ssrState.scores.find((x) => x.symbol === sym);
    const scanItem = ssrState.scan.find((x) => x.symbol === sym);
    probCache.set(sym, score ? probabilityOf(score, scanItem) : null);
  }
  return probCache.get(sym);
}
refreshSsrState();
setInterval(refreshSsrState, 30_000);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeJson = (o) => JSON.stringify(o ?? null).replace(/</g, '\\u003c'); // </script>-safe
const iso = (t) => new Date(t).toISOString();
const fmtPrice = (p) => p == null ? '—' : (Math.abs(p) >= 1 ? p.toLocaleString('en-US', { maximumFractionDigits: 2 }) : Math.abs(p) >= 0.001 ? p.toFixed(5) : p.toPrecision(3));
const fmtPct = (p) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${Number(p).toFixed(2)}%`);

// ARD: transparent reasoning — one-line human-readable rationale per asset
function rationale(x) {
  const s = x.subscores || {};
  const parts = [];
  if (s.volume >= 80) parts.push('strong volume');
  else if (s.volume <= 30) parts.push('weak volume');
  if (s.momentum >= 80) parts.push('strong momentum');
  else if (s.momentum <= 30) parts.push('weak momentum');
  if (s.news >= 70) parts.push('positive news');
  else if (s.news <= 30) parts.push('negative news');
  if (s.risk >= 80) parts.push('low risk');
  else if (s.risk <= 35) parts.push('high risk');
  if (x.components?.maState && x.components.maState !== 'neutral') parts.push(`${x.components.maState} MA stack`);
  return `${x.grade} (${x.composite}/100) — ${parts.length ? parts.slice(0, 2).join(' + ') : 'balanced profile'}`;
}

// machine-readable state blob — mirrored into <script type="application/json" id="agent-state">
function statePayload() {
  const s = ssrState;
  if (!s) return null;
  const p = s.paper;
  return {
    ts: s.ts, version: '1.9.0', mode: 'paper',
    watchlist: WATCHLIST,
    scores: s.scores.slice(0, 12).map((x) => {
      const p = probFor(x.symbol);
      return { symbol: x.symbol, type: x.type, price: x.price, composite: x.composite, grade: x.grade, subscores: x.subscores, rationale: rationale(x), ...(p ? { probUp: p.probUp, ciLo: p.ciLo, ciHi: p.ciHi, direction: p.direction, drivers: p.drivers } : {}) };
    }),
    top: s.scores[0] ? { symbol: s.scores[0].symbol, composite: s.scores[0].composite, grade: s.scores[0].grade, rationale: rationale(s.scores[0]), ...(probFor(s.scores[0].symbol) ? { probUp: probFor(s.scores[0].symbol).probUp, drivers: probFor(s.scores[0].symbol).drivers } : {}) } : null,
    account: p ? { initialCash: p.account.initialCash, cash: p.account.cash, openPositions: p.positions.length } : null,
    autopilot: s.autopilot ? { enabled: s.autopilot.enabled, ticks: s.autopilot.ticks, requireApproval: !!s.autopilot.config?.requireApproval, pendingProposals: getProposals().slice(0, 5).map((q) => ({ id: q.id, symbol: q.symbol, side: q.side, size: q.size, entry: q.entry, stop: q.stop, target: q.target, confidence: q.confidence, reason: q.reason })) } : null,
    market: s.market ? { bullish: s.market.bullish, neutral: s.market.neutral, bearish: s.market.bearish } : null,
    onchain: s.onchain?.chain ? { headBlock: s.onchain.chain.headBlock, tps: s.onchain.chain.tps, peers: s.onchain.chain.peerCount, activeAddresses: s.onchain.chain.activeAddresses } : null,
  };
}

// JSON-LD knowledge graph: WebSite + Organization + SoftwareApplication +
// one FinancialProduct (Stock for equities) per asset, each with an Offer that
// carries an explicit priceCurrency and ISO 8601 validity dates.
function jsonLdBlock() {
  const s = ssrState;
  const graph = [
    { '@type': 'WebSite', '@id': '/#website', url: '/', name: 'IOST Terminal', inLanguage: 'en', description: 'AI real-time trading platform for crypto and equities. Paper-first execution, agent-ready API.' },
    { '@type': 'Organization', '@id': '/#org', name: 'IOST Terminal', url: '/', sameAs: ['https://iost.io'] },
    { '@type': 'SoftwareApplication', '@id': '/#app', name: 'IOST Terminal', applicationCategory: 'FinanceApplication', operatingSystem: 'Web', url: '/', dateModified: iso(s?.ts || Date.now()), offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' }, featureList: ['AI market scanner', 'AI trade scores', 'risk engine', 'news sentiment', 'on-chain dashboard', 'paper trading', 'autopilot'] },
  ];
  for (const a of s?.scores || []) {
    const isStock = a.type === 'stock';
    const price = typeof a.price === 'number' && a.price > 0 ? a.price : null;
    const scanHit = (s.scan || []).find((x) => x.symbol === a.symbol);
    graph.push({
      '@type': isStock ? ['FinancialProduct', 'Stock'] : 'FinancialProduct',
      '@id': `/#asset/${a.symbol}`,
      name: isStock ? `${a.symbol} (NASDAQ)` : `${a.symbol}/USDT`,
      symbol: a.symbol,
      category: isStock ? 'Equity' : 'Cryptocurrency',
      provider: { '@id': '/#org' },
      dateModified: iso(s.ts),
      ...(price != null && {
        offers: {
          '@type': 'Offer',
          price,
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
          seller: { '@id': '/#org' },
          priceValidUntil: iso(s.ts + 24 * 3600 * 1000),
        },
      }),
      additionalProperty: [
        { '@type': 'PropertyValue', name: 'AI trade score', value: a.composite },
        { '@type': 'PropertyValue', name: 'grade', value: a.grade },
        { '@type': 'PropertyValue', name: 'change24hPct', value: scanHit?.change24hPct ?? 0 },
        ...(probFor(a.symbol) ? [{ '@type': 'PropertyValue', name: 'probabilityOfUpside', value: probFor(a.symbol).probUp }] : []),
      ],
    });
  }
  return `<script type="application/ld+json">${safeJson({ '@context': 'https://schema.org', '@graph': graph })}</script>`;
}

// strictly structured machine layer — present in the initial HTML, sr-only for
// humans, fully readable by agents and screen readers (semantic table + dl).
function machineLayer() {
  const s = ssrState;
  const rows = (s?.scores || []).slice(0, 10).map((a) => {
    const p = probFor(a.symbol);
    return `<tr><th scope="row">${esc(a.symbol)}</th><td>${esc(a.type)}</td><td>${fmtPrice(a.price)}</td><td>${p ? `${Math.round(p.probUp * 100)}% ${p.direction === 'bullish' ? '↑' : p.direction === 'bearish' ? '↓' : '→'} (CI ${Math.round(p.ciLo * 100)}–${Math.round(p.ciHi * 100)}%)` : '—'}</td><td>${a.composite ?? '—'}</td><td>${esc(a.grade ?? '—')}</td></tr>`;
  }).join('');
  const p = s?.paper;
  const c = s?.onchain?.chain;
  const m = s?.market;
  const t = s?.ts ? iso(s.ts) : '';
  return `<section data-agent-layer="true" aria-label="Machine-readable market state" data-layer-ts="${esc(t)}">
<style>section[data-agent-layer]{position:absolute!important;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}</style>
<h2>IOST Terminal — machine-readable market state</h2>
<p>Live state as of <time datetime="${esc(t)}">${esc(t)}</time> (ISO 8601). Paper execution. Prices in USD.</p>
<table>
<caption>Top AI trade scores (dual format: price in USD + probability of upside)</caption>
<thead><tr><th scope="col">Symbol</th><th scope="col">Type</th><th scope="col">Price (USD)</th><th scope="col">Prob (upside)</th><th scope="col">AI score</th><th scope="col">Grade</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No market data yet — API at /api/ui-state</td></tr>'}</tbody>
</table>
<dl>
<dt>Mode</dt><dd>paper</dd>
<dt>Account cash</dt><dd>${p ? fmtPrice(p.account.cash) : '—'} USD</dd>
<dt>Open positions</dt><dd>${p ? p.positions.length : '—'}</dd>
<dt>Autopilot</dt><dd>${s?.autopilot?.enabled ? `enabled (${s.autopilot.ticks} ticks)${s.autopilot.config?.requireApproval ? ' · human-approval mode' : ''}` : 'disabled'}</dd>
<dt>Pending proposals</dt><dd>${s?.autopilot?.enabled ? ((getProposals().length) ? `${getProposals().length} awaiting approval — first: ${esc(getProposals()[0].symbol)} ${esc(getProposals()[0].side)} ${Math.round(getProposals()[0].size)} @ ${getProposals()[0].entry} (${esc(getProposals()[0].reason)})` : 'none — all entries executed autonomously') : 'autopilot off'}</dd>
<dt>AI reasoning</dt><dd>${s?.scores?.[0] ? esc(rationale(s.scores[0])) : '—'}</dd>
<dt>Sentiment</dt><dd>${m ? `${m.bullish} bullish / ${m.neutral} neutral / ${m.bearish} bearish` : '—'}</dd>
<dt>IOST mainnet</dt><dd>${c ? `TPS ${esc(c.tps)} · head block ${Number(c.headBlock).toLocaleString('en-US')} · ${esc(c.peerCount)} peers` : '—'}</dd>
</dl>
<div class="machine-actions">
<button type="button" onclick="location.href='/app'" aria-label="Open IOST Terminal paper trading console">Open Terminal</button>
<button type="button" onclick="location.href='/api/ui-state'" aria-label="Fetch machine-readable platform state as JSON">Agent API state</button>
<button type="button" onclick="location.href='/.well-known/agent.json'" aria-label="Fetch agent discovery manifest">Agent manifest</button>
</div>
</section>`;
}

function renderPage(name) {
  const s = ssrState;
  let html = PAGES[name] || '';
  // per-page social meta (OG + Twitter card) + canonical — landing is the primary card
  const OG = {
    'index.html': {
      title: 'IOST Terminal — AI Real-Trading Platform',
      desc: 'AI real-time trading platform for crypto and equities. Live prices, on-chain intelligence, eight AI engines, paper-first execution. Agent-ready.',
      url: '/',
    },
    'hub.html': {
      title: 'IOST Terminal — Automation Hub',
      desc: 'The 3D command network: eight strategy bots, live market data and the IOST mainnet on one GPU surface.',
      url: '/hub',
    },
    'app.html': {
      title: 'IOST Terminal — AI Command Center',
      desc: 'AI market scanner, trade scores, risk engine, portfolio AI, on-chain dashboard and paper trading console.',
      url: '/app',
    },
  }[name];
  const meta = OG ? [
    `<meta name="description" content="${OG.desc}">`,
    `<link rel="canonical" href="${SITE_URL}${OG.url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="IOST Terminal">`,
    `<meta property="og:title" content="${OG.title}">`,
    `<meta property="og:description" content="${OG.desc}">`,
    `<meta property="og:url" content="${SITE_URL}${OG.url}">`,
    `<meta property="og:image" content="${SITE_URL}/img/og-image.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${OG.title}">`,
    `<meta name="twitter:description" content="${OG.desc}">`,
    `<meta name="twitter:image" content="${SITE_URL}/img/og-image.png">`,
  ].join('\n') : '';
  const headExtra = `${meta}\n<meta name="agent:state" content="/api/ui-state">\n<link rel="alternate" type="application/json" title="IOST Terminal agent state" href="/api/ui-state">\n<link rel="llms" href="/llms.txt">\n${jsonLdBlock()}`;
  html = html.replace('</head>', `${headExtra}\n</head>`);
  html = html.replace('<script type="application/json" id="agent-state">null</script>', `<script type="application/json" id="agent-state">${safeJson(statePayload())}</script>`);

  if (name === 'index.html') {
    const top = s?.scores?.[0];
    if (top) {
      const pTop = probFor(top.symbol);
      html = html.replace('<span class="rail-symbol" id="rv-sym">—</span>', `<span class="rail-symbol" id="rv-sym">${esc(top.symbol)}</span>`);
      html = html.replace('<span id="rv-score">--</span>', `<span id="rv-score">${top.composite}</span>`);
      html = html.replace('<div class="rail-sub" id="rv-grade">fetching…</div>', `<div class="rail-sub" id="rv-grade">${esc(top.grade)} · ${pTop ? `${Math.round(pTop.probUp * 100)}% upside prob (CI ${Math.round(pTop.ciLo * 100)}–${Math.round(pTop.ciHi * 100)}) · ` : ''}${top.subscores?.momentum ?? 0} mom / ${top.subscores?.volume ?? 0} vol</div>`);
    }
    const c = s?.onchain?.chain;
    if (c) {
      html = html.replace('<div class="rail-value" id="rv-tps" aria-live="polite">--</div>', `<div class="rail-value" id="rv-tps" aria-live="polite">${esc(c.tps)} tx/s</div>`);
      html = html.replace('<div class="rail-value" id="rv-block" aria-live="polite">--</div>', `<div class="rail-value" id="rv-block" aria-live="polite">${Number(c.headBlock).toLocaleString('en-US')}</div>`);
      html = html.replace('<div class="rail-sub">peer count <span id="rv-peers">—</span></div>', `<div class="rail-sub">peer count <span id="rv-peers">${esc(c.peerCount)}</span></div>`);
    }
    const m = s?.market;
    if (m) {
      const mood = m.bullish > m.bearish ? '🟢 Bullish' : m.bearish > m.bullish ? '🔴 Bearish' : '⚪ Mixed';
      html = html.replace('<div class="rail-value" id="rv-sent" aria-live="polite">--</div>', `<div class="rail-value" id="rv-sent" aria-live="polite">${esc(mood)}</div>`);
      html = html.replace('<div class="rail-sub" id="rv-sent-sub">headlines classified</div>', `<div class="rail-sub" id="rv-sent-sub">${esc(`${m.bullish} bull · ${m.neutral} neutral · ${m.bearish} bear`)}</div>`);
    }
    const items = (s?.scan || []).slice(0, 14).map((a) => {
      const dir = (a.change24hPct || 0) >= 0 ? 'up' : 'down';
      const sig = a.signals?.[0]?.label || 'no signal';
      return `<span class="strip-item"><b>${esc(a.symbol)}</b><span class="${dir}">${fmtPct(a.change24hPct)}</span><span class="sig">· ${esc(sig)}</span></span>`;
    });
    if (items.length) html = html.replace('<div class="strip-track" id="stripTrack"><span class="strip-item">scanning live tape…</span></div>', `<div class="strip-track" id="stripTrack">${items.join('')}</div>`);
    const stats = {
      'id="st-signals"': (s?.scan || []).reduce((a, x) => a + (x.signals?.length || 0), 0),
      'id="st-avg"': s?.scores?.length ? Math.round(s.scores.reduce((a, x) => a + x.composite, 0) / s.scores.length) : null,
      'id="st-news"': m?.total ?? null,
      'id="st-pos"': s?.paper?.positions?.length ?? null,
      'id="st-sent"': m?.total ?? null,
      'id="st-tps"': c?.tps ?? null,
      'id="st-journal"': s?.paper?.journal?.length ?? null,
      // decentralized agents (real counts from the marketplace stores)
      'id="st-agents"': signals.agentStats().agents || null,
      'id="st-pins"': (signals.agentStats().pinned + signals.agentStats().queued) || null,
      'id="st-onchain"': signals.agentStats().pinned || null,
      'id="st-follows"': signals.agentStats().follows || null,
    };
    for (const [id, v] of Object.entries(stats)) {
      if (v != null) html = html.replace(`<b ${id}>--</b>`, `<b ${id}>${esc(v)}</b>`);
    }
    if (top) {
      const tape = `TPS ${c?.tps ?? '—'} · HEAD ${c ? Number(c.headBlock).toLocaleString('en-US') : '—'} · ${s.paper?.positions?.length ?? 0} OPEN · ${s.paper?.positions?.length ? Math.round(s.paper.positions.reduce((a, p) => a + p.notional, 0) / s.paper.account.initialCash * 1000) / 10 : 0}% EXP`;
      html = html.replace('<span class="visor-sym" id="vSym">IOST</span>', `<span class="visor-sym" id="vSym">${esc(top.symbol)}</span>`);
      html = html.replace('<span class="visor-score" id="vScore">--</span>', `<span class="visor-score" id="vScore">${top.composite} ${esc(top.grade || '')}</span>`);
      html = html.replace('<div class="visor-tape" id="vTape">SYNCING…</div>', `<div class="visor-tape" id="vTape">${esc(tape)}</div>`);
    }
    // leaderboard section — SSR'd into the first response (agents see it too)
    const lb = computeLeaderboard('week', 5);
    const lbRows = lb.length
      ? lb.map((r) => `<div class="lb-row"><span class="lb-rank mono">#${r.rank}</span><span class="lb-name">${esc(r.trader)}</span><span class="lb-pnl ${r.pnl >= 0 ? 'up' : 'down'}">$${r.pnl.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span><span class="lb-rate mono">${r.winRate}%</span><span class="lb-trades mono">${r.trades} trades</span></div>`).join('')
      : '<div class="lb-empty">No closed trades yet — be the first on the board.</div>';
    html = html.replace('--lb-rows--', lbRows);
  }

  if (name === 'hub.html') {
    const c = s?.onchain?.chain;
    if (c) html = html.replace('<div class="t2" id="feedState" role="status" aria-live="polite">SYNCING…</div>', `<div class="t2" id="feedState" role="status" aria-live="polite">LIVE · TPS ${esc(c.tps)} · ${(s?.scores || []).length} ASSETS</div>`);
    html = html.replace('<span id="clock" role="timer" aria-label="UTC clock">--:--:--</span>', `<span id="clock" role="timer" aria-label="UTC clock">${new Date().toISOString().slice(11, 19)}</span>`);
  }

  html = html.replace('</body>', `${machineLayer()}\n</body>`);
  return html;
}

// SSR routes — full market state present in the initial HTML (no client JS needed)
app.get('/', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(renderPage('index.html')); });
app.get('/hub', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(renderPage('hub.html')); });
app.get('/app', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(renderPage('app.html')); });
app.use(express.static(join(ROOT, 'public')));

// ---- legal pages (draft — PROJECT OWNER reviews before publishing) ----
const LEGAL_PAGES = {};
for (const f of ['terms.html', 'privacy.html', 'risk-disclosure.html']) {
  LEGAL_PAGES[f] = readFileSync(join(ROOT, 'public', f), 'utf8');
}
app.get('/terms', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(LEGAL_PAGES['terms.html']); });
app.get('/privacy', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(LEGAL_PAGES['privacy.html']); });
app.get('/risk-disclosure', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(LEGAL_PAGES['risk-disclosure.html']); });

// ---- sitemap.xml ----
const SITEMAP_URLS = ['/', '/app', '/hub', '/terms', '/privacy', '/risk-disclosure'];
app.get('/sitemap.xml', (req, res) => {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_URLS
    .map((p) => `  <url><loc>${SITE_URL}${p}</loc><lastmod>${lastmod}</lastmod><changefreq>${p === '/' ? 'hourly' : 'weekly'}</changefreq></url>`)
    .join('\n');
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

// fast cached snapshot for the landing page (no forced scans)
app.get('/api/landing', async (req, res) => {
  try {
    const [scores, onchain, news] = await Promise.all([
      allScores().catch(() => []),
      getChainSnapshot().catch(() => null),
      getNews().catch(() => null),
    ]);
    res.json({ scores: scores.slice(0, 6), onchain, market: news?.market ?? null });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- warm caches ----------
getNews().catch(() => {});
getChainSnapshot().catch(() => {});

// ---------- REST API ----------
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'IOST Terminal', ts: Date.now(), watchlist: WATCHLIST }));

app.get('/api/watchlist', (req, res) => res.json(WATCHLIST));

app.get('/api/scanner', async (req, res) => {
  try {
    const scan = await scanAll({ force: !!req.query.force });
    // enrich crypto assets with rank + market cap (keyless CoinGecko, cached)
    try {
      const extras = await getMarketExtras(scan.filter(a => a.type === 'crypto').map(a => a.symbol));
      for (const a of scan) {
        const x = extras[a.symbol];
        if (x) { a.rank = x.rank; a.marketCap = x.marketCap; a.fdv = x.fdv; }
      }
    } catch { /* enrichment optional */ }
    res.json(scan);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- market-wide data (keyless: CoinGecko + Fear & Greed) ----
app.get('/api/market/global', async (req, res) => {
  try { res.json({ ok: true, ...(await getGlobalMetrics()) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/market/movers', async (req, res) => {
  try { res.json({ ok: true, ...(await getTopMovers()) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/analyze/:symbol', async (req, res) => {
  try { res.json(await analyzeSymbol(req.params.symbol.toUpperCase(), { force: true })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

async function allScores() {
  const scan = await scanAll();
  const news = await getNews();
  const results = [];
  for (const a of scan) {
    try {
      const sent = getAssetSentiment(a.symbol);
      results.push(computeScores(a, sent));
    } catch { /* skip */ }
  }
  return results.sort((a, b) => b.composite - a.composite);
}

app.get('/api/scores', async (req, res) => {
  try { res.json(await allScores()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/klines/:symbol', async (req, res) => {
  try {
    const bar = /^(1m|5m|15m|1h|4h|1d)$/.test(req.query.bar || '') ? req.query.bar : '15m';
    res.json(await getKlines(req.params.symbol.toUpperCase(), bar, Math.min(+req.query.limit || 300, 300)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- probabilistic clarity layer (v1.4) ----------
app.get('/api/probability', (req, res) => {
  if (!ssrState) return res.json([]);
  res.json(ssrState.scores.map((x) => probFor(x.symbol)).filter(Boolean));
});
app.get('/api/probability/:symbol/history', (req, res) => {
  res.json({ symbol: req.params.symbol.toUpperCase(), samples: getProbHistory(req.params.symbol.toUpperCase()) });
});
app.get('/api/orderbook/:symbol', async (req, res) => {
  const b = await getOrderBook(req.params.symbol.toUpperCase()).catch(() => null);
  if (!b) return res.status(404).json({ error: 'no order book for this symbol (crypto only, OKX)' });
  res.json(b);
});
app.get('/api/contracts/:symbol', async (req, res) => {
  const c = await getContractSpec(req.params.symbol.toUpperCase()).catch(() => null);
  if (!c) return res.status(404).json({ error: 'no contract spec for this symbol (crypto only, OKX)' });
  res.json(c);
});

app.get('/api/score/:symbol', async (req, res) => {
  try {
    const a = await analyzeSymbol(req.params.symbol.toUpperCase(), { force: true });
    res.json(computeScores(a, getAssetSentiment(a.symbol)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/news', async (req, res) => {
  try { res.json(await getNews(!!req.query.force)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/onchain', async (req, res) => {
  try { res.json(await getChainSnapshot(!!req.query.force)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/risk', (req, res) => {
  const r = calculateRisk(req.body || {});
  res.json(r);
});

// PUBLIC portfolio view (v1.14): guests see the platform demo account so the
// whole app is browsable without signing in; authenticated users see their own.
app.get('/api/portfolio', async (req, res) => {
  try {
    const acc = accountFor(req) || getState('default');
    const st = await markToMarket(acc.accountId);
    const scores = {};
    for (const p of st.positions) {
      try { scores[p.symbol] = computeScores(await analyzeSymbol(p.symbol), getAssetSentiment(p.symbol)); } catch { /* skip */ }
    }
    const sentiment = {};
    for (const p of st.positions) sentiment[p.symbol] = getAssetSentiment(p.symbol);
    res.json(analyzePortfolio({
      cash: st.account.cash, positions: st.positions,
      accountSize: st.account.initialCash, scores, sentiment,
    }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/paper', requireUser, async (req, res) => {
  try { res.json(await markToMarket(accountFor(req).accountId)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/paper/open', requireUser, async (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'trade-paper')) return res.status(403).json({ error: 'scope: this key cannot trade (missing trade-paper)' });
  try { res.json(await getBroker('paper').placeOrder({ ...(req.body || {}), accountId: accountFor(req).accountId })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/paper/close', requireUser, async (req, res) => {
  try {
    const r = await closeTrade(req.body?.positionId, req.body?.exitPrice, accountFor(req).accountId);
    // decentralized agents: when a copy-followed position closes, pin the close
    // on-chain (provable agent track record) — the journal reason carries the source agentId
    if (r.ok) {
      const st = getState(accountFor(req).accountId);
      const j = st.journal.find((e) => e.id === req.body?.positionId);
      if (j && (j.reason || '').includes('copy-follow (agent:')) {
        signals.pinCopiedClose(j, st.accountId).catch(() => {});
      }
    }
    res.json(r);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/paper/reset', requireUser, (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'trade-paper')) return res.status(403).json({ error: 'scope: this key cannot trade (missing trade-paper)' });
  res.json(resetAccount(accountFor(req).accountId));
});
app.post('/api/paper/account', requireUser, (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'trade-paper')) return res.status(403).json({ error: 'scope: this key cannot trade (missing trade-paper)' });
  res.json(setAccountSize(+req.body?.accountSize || 100000, accountFor(req).accountId));
});
app.get('/api/paper/stats', requireUser, (req, res) => res.json(journalStats(accountFor(req).accountId)));

// ================= decentralized AI agents — Phase 1 =================
// Trust layer: every published signal is SHA-256 hash-pinned on the IOST
// mainnet (token.iost transfer memo) via lib/chain.js; without a configured
// pin key, pins queue off-chain (status "pending-onchain", honest labels).
// Marketplace: public feed + agent registry + paper copy-follow (5-position cap).

// publish a signal as the current principal (session user OR X-API-Key agent)
app.post('/api/signals', requireUser, async (req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ error: 'auth required' });
  const r = await signals.publishSignal({ ...(req.body || {}), ...ident });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, signal: signals.publicSignalRow(r.signal), pin: r.pin, mirrored: r.mirrored });
});

// public feed — newest first, filters by type/symbol/agent
app.get('/api/signals/feed', (req, res) => {
  const rows = signals.listSignals({
    limit: req.query.limit, type: req.query.type || null,
    symbol: req.query.symbol || null, agentId: req.query.agentId || null,
  });
  res.json({ ok: true, count: rows.length, signals: rows.map(signals.publicSignalRow) });
});

// what I follow + my copied positions (session user) — MUST be registered
// before /api/signals/:id or Express 5 captures "following" as an id
app.get('/api/signals/following', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'follow requires a signed-in account' });
  const acc = accountFor(req);
  const agents = signals.listFollowing(acc.accountId);
  const copies = (getState(acc.accountId).positions || [])
    .filter((p) => (p.reason || '').includes('copy-follow (agent:'))
    .map((p) => ({ positionId: p.id, symbol: p.symbol, side: p.side, entry: p.entry, size: p.size, notional: p.notional, reason: p.reason, openedAt: p.openedAt }));
  res.json({ ok: true, followerId: acc.accountId, agents, copies, cap: 5 });
});

// single signal (public)
app.get('/api/signals/:id', (req, res) => {
  const s = signals.getSignal(req.params.id);
  if (!s) return res.status(404).json({ error: 'signal not found' });
  res.json({ ok: true, signal: signals.publicSignalRow(s) });
});

// proof verifier: on-chain status + recomputed hash + explorer link
app.get('/api/signals/:id/proof', async (req, res) => {
  const s = signals.getSignal(req.params.id);
  if (!s) return res.status(404).json({ error: 'signal not found' });
  const payload = signals.signalPinPayload(s);
  const proof = await chain.buildProof({ hash: s.pin?.hash, payload, pin: s.pin });
  res.json({ ok: true, signalId: s.id, ...proof });
});

// XAI: structured reason trail for a signal (steps: input → output, confidence)
app.get('/api/signals/:id/trail', (req, res) => {
  const trail = signals.getSignalTrail(req.params.id);
  if (!trail) return res.status(404).json({ error: 'signal not found' });
  res.json({ ok: true, ...trail });
});

// agent registry — provable track records (win rates from per-account journals)
app.get('/api/agents', (req, res) => {
  res.json({ ok: true, count: signals.listAgents().length, agents: signals.listAgents(), stats: signals.agentStats() });
});

// chain trust-layer status for the UI badge
app.get('/api/chain/status', async (req, res) => {
  res.json(await chain.chainStatus());
});

// follow an agent (session user only — agents publish, humans follow)
app.post('/api/signals/:id/follow', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'follow requires a signed-in account' });
  const acc = accountFor(req);
  const sig = signals.getSignal(req.params.id);
  const agentId = req.body?.agentId || sig?.agentId;
  if (!agentId) return res.status(400).json({ error: 'agentId required (or a valid signal id)' });
  const r = signals.followAgent(acc.accountId, agentId);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, followerId: acc.accountId, agentId, already: r.already });
});

app.delete('/api/signals/:id/follow', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'follow requires a signed-in account' });
  const acc = accountFor(req);
  const sig = signals.getSignal(req.params.id);
  const agentId = req.body?.agentId || sig?.agentId;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  res.json(signals.unfollowAgent(acc.accountId, agentId));
});

// ================= off-chain points (tokenomics vision §6) =================
// No token is issued. Points are accrual-only; 1:1 AIT conversion is PLANNED
// at TGE (honest label in the UI). Ledger: data/points.json (atomic writes).

// GET /api/points — balance + recent ledger + referral info (session user or X-API-Key)
app.get('/api/points', requireUser, (req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ error: 'auth required' });
  const ownerId = ident.agentId;
  const code = points.ensureReferralCode(ownerId);
  res.json({
    ok: true, ownerId, balance: points.getBalance(ownerId), ledger: points.getLedger(ownerId, 50),
    referralCode: code, referralLink: `${SITE_URL}/app?ref=${code}`,
    conversion: { rate: '1:1', token: 'AIT', status: 'planned at TGE — not issued yet', spendable: false },
  });
});

// POST /api/points/referral-code — get/create my 8-char referral code
app.post('/api/points/referral-code', requireUser, (req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ error: 'auth required' });
  const code = points.ensureReferralCode(ident.agentId);
  res.json({ ok: true, ownerId: ident.agentId, referralCode: code, referralLink: `${SITE_URL}/app?ref=${code}` });
});

// POST /api/points/feedback {signalId, rating 1-5, comment?}
// The signal AUTHOR gains +5 (capped 1 per rater per signal); the rater gains
// nothing — honest. Validates the signal exists.
app.post('/api/points/feedback', requireUser, (req, res) => {
  const rater = signalIdentity(req);
  if (!rater) return res.status(401).json({ error: 'auth required' });
  const { signalId } = req.body || {};
  const rating = Number(req.body?.rating);
  if (!signalId) return res.status(400).json({ error: 'signalId required' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be an integer 1-5' });
  const sig = signals.getSignal(signalId);
  if (!sig) return res.status(404).json({ error: 'signal not found' });
  const r = points.awardFeedback({
    signalOwnerId: sig.agentId, raterId: rater.agentId, signalId,
    rating, comment: String(req.body?.comment || '').slice(0, 500),
  });
  if (!r.ok) return res.json({ ok: false, reason: r.reason, already: !!r.already });
  res.json({ ok: true, event: 'feedback', awarded: r.entry.points, to: r.entry.ownerId, signalId });
});

// GET /api/points/bounty/status — weekly bounty state (public: no private data)
app.get('/api/points/bounty/status', (req, res) => {
  res.json({ ok: true, ...points.bountyStatus() });
});

// POST /api/points/bounty/run — owner or agent key only: +500 to the top paper
// trader of the trailing 7 days (realized PnL from per-account journals).
// Guard: once per ISO week. Manual trigger for now (cron in phase 2).
app.post('/api/points/bounty/run', requireUser, (req, res) => {
  if (!req.agentKey && !isOwnerSession(req)) return res.status(403).json({ error: 'admin or agent key required' });
  res.json({ ok: true, ...points.runWeeklyBounty() });
});

// queue flush: boot + every 10 min — drains data/pending_pins.json when the key appears
async function flushPinQueue() {
  try {
    const r = await chain.flushPendingQueue();
    for (const res of r.results) {
      signals.markPinResult({ signalId: res.signalId, ok: res.ok, txHash: res.txHash ?? null, block: res.block ?? null, error: res.error ?? null, pinnedAt: res.pinnedAt });
      console.log(`[chain] queue flush → ${res.ok ? `pinned ${res.hash.slice(0, 12)}… tx ${res.txHash}` : `retry ${res.hash.slice(0, 12)}… (${res.error})`}`);
    }
  } catch (e) { console.warn(`[chain] queue flush failed: ${e.message}`); }
}
flushPinQueue();
setInterval(flushPinQueue, 600_000); // 10 min

// free-IOST-wallet queue: same honest pattern — pending wallet creations are
// drained on boot + every 10 min once IOST_PIN_KEY/IOST_PIN_ACCOUNT appear
async function flushWalletQueue() {
  try {
    const r = await iostAccounts.flushPendingCreations();
    for (const res of r.results) {
      console.log(`[iost-acct] queue flush → ${res.ok ? `created ${res.accountName} tx ${res.txHash}` : `retry ${res.accountName} (${res.error})`}`);
    }
  } catch (e) { console.warn(`[iost-acct] wallet queue flush failed: ${e.message}`); }
}
flushWalletQueue();
setInterval(flushWalletQueue, 600_000); // 10 min

// Light per-account snapshot for the topbar: cash, equity, open positions, last trades
app.get('/api/account', requireUser, (req, res) => {
  const st = accountFor(req);
  const unrealized = st.positions.reduce((a, p) => a + ((p.lastPrice || p.entry) - p.entry) * p.size * (p.side === 'short' ? -1 : 1), 0);
  const email = req.session?.userId ? auth.findById(req.session.userId)?.email : null;
  res.json({
    accountId: st.accountId,
    owner: st.owner,
    cash: Math.round(st.account.cash * 100) / 100,
    initialCash: st.account.initialCash,
    equity: Math.round((st.account.cash + unrealized) * 100) / 100,
    openPositions: st.positions.length,
    lastTrades: st.journal.slice(-5).reverse().map(j => ({ symbol: j.symbol, side: j.side, status: j.status, pnl: j.pnl, result: j.result, openedAt: j.openedAt, closedAt: j.closedAt })),
    live: getLiveState(st, email), // masked — never exposes keys
    fee: { ...walletSummary(st), exempt: getFeeConfig().feeExemptAccounts.includes(st.accountId), burnRate: getFeeConfig().burnRate, minCreditsToTrade: getFeeConfig().minCreditsToTrade, bundles: getFeeConfig().bundles, wallet: getFeeConfig().wallet },
  });
});

// ---- live (real-money) mode: owner-only, allowlisted email, kill switch ----
app.post('/api/account/live/enable', requireUser, async (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'owner account only' });
  const u = auth.findById(req.session.userId);
  if (!u) return res.status(401).json({ error: 'auth required' });
  const ownKeys = !!brokerForUser(u);
  if (!isLiveAllowed(u.email) && !ownKeys) return res.status(403).json({ error: 'not eligible for live trading — connect your own Kraken key first' });
  const r = await enableLive(accountFor(req), u.email, ownKeys);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, live: r.live });
});

app.post('/api/account/live/disable', requireUser, async (req, res) => {
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  const r = await disableLive(accountFor(req), u ? brokerForUser(u) : null);
  res.json({ ok: true, cancelled: r.cancelled, wasEnabled: r.wasEnabled });
});

// ---- live execution: owner-only, rails-gated, fully audited ----
// Owner session helper: only allowlisted emails are the owner.
function isOwnerSession(req) {
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  return u && isLiveAllowed(u.email);
}

// Per-user broker: the user's OWN Kraken keys (encrypted). null when not set.
function brokerForUser(u) {
  const keys = u ? getUserKrakenKeys(u) : null;
  return keys ? createKrakenBroker(keys) : null;
}

// ---- per-user Kraken key connection (v3 — customers trade their own account) ----
app.get('/api/account/kraken', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  res.json({ ok: true, status: userKrakenStatus(auth.findById(req.session.userId)) });
});

app.put('/api/account/kraken', requireUser, async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  const { apiKey, apiSecret } = req.body || {};
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'apiKey and apiSecret required' });
  // validate the PROVIDED key with a read-only balance call before storing
  const test = createKrakenBroker({ apiKey: String(apiKey).trim(), apiSecret: String(apiSecret).trim() });
  const acct = await test.getAccount();
  if (!acct.ok) return res.status(400).json({ error: `key rejected by Kraken: ${acct.error}` });
  const u = auth.findById(req.session.userId);
  const r = setUserKrakenKey(u, String(apiKey).trim(), String(apiSecret).trim());
  if (!r.ok) return res.status(400).json({ error: r.error });
  persistUsers();
  logLiveEvent(u.id, 'user.key.connected', { masked: u.krakenKeyStatus?.maskedKey });
  res.json({ ok: true, status: userKrakenStatus(u) });
});

app.delete('/api/account/kraken', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  const u = auth.findById(req.session.userId);
  clearUserKrakenKey(u);
  persistUsers();
  res.json({ ok: true });
});

// ---- free IOST mainnet wallet (subsidized — platform pays the ~11 IOST fee) ----
// Key custody rule: the SERVER never generates or holds user private keys. The
// browser generates the Ed25519 keypair; only the PUBLIC key (base64, 32 bytes)
// + account name reach the server, which broadcasts auth.iost/signUp with the
// platform's funded account (IOST_PIN_KEY/IOST_PIN_ACCOUNT — same as pins).
// No key configured → creation QUEUES (status "pending") with an honest label.
app.post('/api/account/iost', requireUser, async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  const { accountName, publicKey } = req.body || {};
  const r = await iostAccounts.requestCreation({ userId: req.session.userId, accountName, publicKey });
  const e = r.entry || {};
  res.status(r.status).json({
    ok: r.ok,
    status: e.status || null,
    accountName: e.accountName || null,
    tx: e.tx || null,
    block: e.block ?? null,
    error: (r.error ?? e.error) ?? null,
    message: r.message || null,
  });
});

app.get('/api/account/iost', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  const e = iostAccounts.getEntry(req.session.userId);
  if (!e) return res.json({ ok: true, status: 'none', accountName: null, tx: null, block: null, error: null });
  res.json({ ok: true, status: e.status, accountName: e.accountName, tx: e.tx ?? null, block: e.block ?? null, error: e.error ?? null });
});

// public helper for UI honesty — no private data, no auth needed
app.get('/api/account/iost/status', (req, res) => {
  res.json({ ok: true, ...iostAccounts.publicStatus() });
});

// Shared live-order executor — used by manual trading AND agent-proposal
// approval (option C: agents request, owner approves). Runs under the
// APPROVING user's session; venue = their own Kraken keys or (owner only)
// the platform key. Risk rails + venue are re-validated at execution time —
// prices move between proposal and approval.
async function executeLiveOrder(req, { symbol, side = 'long', size, entry }) {
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  if (!u) return { status: 403, error: 'session required' };
  const st = accountFor(req);
  if (!getLiveState(st).enabled) return { status: 400, error: 'live mode not enabled for this account' };
  // venue: user's own keys when connected, else the platform key (owner only)
  const kraken = brokerForUser(u) || (isOwnerSession(req) ? getBroker('kraken') : null);
  if (!kraken) return { status: 403, error: 'connect your own Kraken key first (platform venue is owner-only)' };
  // rails need live venue state — fetch before touching anything
  const [acct, pos] = await Promise.all([kraken.getAccount(), kraken.getPositions()]);
  if (!acct.ok) return { status: 502, error: `venue: ${acct.error}` };
  const openPositions = pos.ok ? pos.positions : [];
  const today = new Date().toISOString().slice(0, 10);
  const todayPnlUsd = st.journal
    .filter(j => j.live && j.closedAt && new Date(j.closedAt).toISOString().slice(0, 10) === today)
    .reduce((a, j) => a + (j.pnl || 0), 0);
  const rail = checkLiveOrder({ symbol, side, size, entry, openPositions, cashUsd: acct.account.cashUsd ?? 0, todayPnlUsd });
  if (!rail.ok) return { status: 400, error: `risk rail: ${rail.error}` };
  const fee = canTrade(st);
  if (!fee.ok) return { status: 400, error: fee.error };

  const r = await kraken.placeOrder({ symbol, side, size, entry });
  if (!r.ok) return { status: 502, error: `venue: ${r.error}` };
  // fee: burn credits on the executed notional (entry price or last quote)
  let notional = entry && entry > 0 ? size * entry : 0;
  if (!notional) {
    const q = await kraken.getQuotes([symbol]);
    const last = q.ok ? q.quotes[symbol]?.last : null;
    if (last) notional = size * last;
  }
  const burn = burnCredits(st, notional);
  persistAccounts();
  logLiveEvent(st.accountId, 'live.order', { symbol, side, size, entry: entry || null, venueOrderId: r.order.venueOrderId, burn: burn.ok ? burn.burn : 0 });
  return { status: 200, ok: true, order: { venue: 'kraken', venueOrderId: r.order.venueOrderId, symbol, side, size, entry: entry || null }, fee: burn.ok ? { burn: burn.burn, credits: burn.credits } : { error: burn.error } };
}

app.post('/api/trade/live', requireUser, async (req, res) => {
  const { symbol, side = 'long', size, entry } = req.body || {};
  const r = await executeLiveOrder(req, { symbol, side, size, entry });
  res.status(r.status).json(r.status === 200 ? r : { error: r.error });
});

// masked view of venue positions/orders for the account owner (never keys)
app.get('/api/live/positions', requireUser, async (req, res) => {
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  const st = accountFor(req);
  if (!getLiveState(st).enabled) return res.status(400).json({ error: 'live mode not enabled' });
  const kraken = brokerForUser(u) || (isOwnerSession(req) ? getBroker('kraken') : null);
  if (!kraken) return res.status(403).json({ error: 'no venue keys for this account' });
  const [p, o] = await Promise.all([kraken.getPositions(), kraken.getOrders()]);
  res.json({ ok: true, positions: p.ok ? p.positions : [], orders: o.ok ? o.orders : [], errors: [!p.ok && p.error, !o.ok && o.error].filter(Boolean) });
});

// ============ "connect your AI agent" — per-user agent API keys (v1.12) ============
// Every customer can mint API keys for their own AI agents. A key is bound to
// ONE account, carries scopes (read / trade-paper / trade-live), is shown
// EXACTLY ONCE at creation (hash-only stored), and can be revoked instantly.
app.post('/api/agent-keys', requireUser, (req, res) => {
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  if (!u) return res.status(401).json({ error: 'auth required' });
  const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : ['read'];
  if (scopes.includes('trade-live') && !isLiveAllowed(u.email))
    return res.status(403).json({ error: 'trade-live scope is owner-only for now' });
  const r = agentKeys.createKey({ userId: u.id, name: req.body?.name, scopes });
  logLiveEvent(u.id, 'agent.key.created', { keyId: r.entry.id, scopes: r.entry.scopes });
  res.json({ ok: true, key: r.key, keyId: r.entry.id, name: r.entry.name, scopes: r.entry.scopes, warning: 'store it now — shown only once; anyone with it controls this key' });
});

app.get('/api/agent-keys', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  res.json({ ok: true, keys: agentKeys.listKeys(req.session.userId) });
});

app.delete('/api/agent-keys/:id', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  const r = agentKeys.revokeKey({ userId: req.session.userId, id: req.params.id });
  if (!r.ok) return res.status(404).json({ error: r.error });
  logLiveEvent(req.session.userId, 'agent.key.revoked', { keyId: req.params.id });
  res.json({ ok: true });
});

// agent-side: a key can introspect itself (identity + scopes)
app.get('/api/agent-keys/self', (req, res) => {
  if (!req.userAgent) return res.status(401).json({ error: 'send a valid X-API-Key header' });
  res.json({ ok: true, keyId: req.userAgent.keyId, name: req.userAgent.name, scopes: req.userAgent.scopes, userId: req.userAgent.userId });
});

// ============ live-trade proposals — option C (agent proposes, owner approves) ============
// Agents with trade-live scope REQUEST live orders; NOTHING executes until the
// owner approves in-app/API. Rails + venue are re-validated at approval time.
app.post('/api/live/proposals', requireUser, (req, res) => {
  if (!req.userAgent) return res.status(403).json({ error: 'live proposals are for agent keys (trade-live scope)' });
  if (!userAgentHas(req, 'trade-live')) return res.status(403).json({ error: 'scope: trade-live required' });
  const { symbol, side, size, entry, reason, confidence } = req.body || {};
  if (!symbol || !size || size <= 0) return res.status(400).json({ error: 'symbol and positive size required' });
  const p = liveProposals.addProposal({ userId: req.userAgent.userId, requesterKeyId: req.userAgent.keyId, requesterName: req.userAgent.name, symbol, side, size, entry, reason, confidence });
  logLiveEvent(p.userId, 'live.proposal.created', { proposalId: p.id, symbol: p.symbol, side: p.side, size: p.size });
  res.status(201).json({ ok: true, proposal: p });
});

app.get('/api/live/proposals', requireUser, (req, res) => {
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  if (u) return res.json({ ok: true, proposals: liveProposals.listProposals({ userId: u.id, status: req.query.status || null, limit: +req.query.limit || 20 }) });
  if (req.userAgent) return res.json({ ok: true, proposals: liveProposals.listProposals({ userId: req.userAgent.userId, status: req.query.status || null, limit: +req.query.limit || 20 }) });
  return res.status(403).json({ error: 'owner session or agent key required' });
});

app.get('/api/live/proposals/:id', requireUser, (req, res) => {
  const p = liveProposals.getProposal(req.params.id);
  if (!p) return res.status(404).json({ error: 'proposal not found' });
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  if (!(u && u.id === p.userId) && !(req.userAgent && req.userAgent.keyId === p.requesterKeyId))
    return res.status(403).json({ error: 'not your proposal' });
  res.json({ ok: true, proposal: p });
});

// APPROVE — owner session only. Re-checks venue + risk rails, then executes.
app.post('/api/live/proposals/:id/approve', requireUser, async (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const p = liveProposals.getProposal(req.params.id);
  if (!p) return res.status(404).json({ error: 'proposal not found' });
  if (p.status !== 'pending') return res.status(400).json({ error: `proposal already ${p.status}` });
  const r = await executeLiveOrder(req, { symbol: p.symbol, side: p.side, size: p.size, entry: p.entry });
  if (r.status === 200) {
    liveProposals.decide({ id: p.id, status: 'approved', by: 'owner' });
    liveProposals.attachResult(p.id, { venueOrderId: r.order.venueOrderId });
    logLiveEvent(p.userId, 'live.proposal.approved', { proposalId: p.id, venueOrderId: r.order.venueOrderId });
    res.json({ ok: true, proposal: liveProposals.getProposal(p.id), order: r.order });
  } else {
    liveProposals.decide({ id: p.id, status: 'rejected', by: 'owner' });
    liveProposals.attachResult(p.id, { error: r.error });
    logLiveEvent(p.userId, 'live.proposal.rejected', { proposalId: p.id, error: r.error });
    res.status(r.status).json({ ok: false, error: r.error, proposal: liveProposals.getProposal(p.id) });
  }
});

// REJECT — owner session only.
app.post('/api/live/proposals/:id/reject', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const r = liveProposals.decide({ id: req.params.id, status: 'rejected', by: 'owner' });
  if (!r.ok) return res.status(400).json({ error: r.error });
  logLiveEvent(r.proposal.userId, 'live.proposal.rejected', { proposalId: r.proposal.id });
  res.json({ ok: true, proposal: r.proposal });
});

// ---- admin (owner-only): fee config + wallets — PROJECT OWNER can change pricing live ----
app.get('/api/admin/fee-config', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  res.json({ ok: true, config: getFeeConfig() });
});

app.put('/api/admin/fee-config', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const r = setFeeConfig(req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  logLiveEvent('admin', 'fee-config.update', { burnRate: r.config.burnRate, bundles: r.config.bundles.length });
  res.json({ ok: true, config: r.config });
});

app.get('/api/admin/wallets', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const rows = listAccounts().map(a => ({
    accountId: a.accountId, owner: a.owner,
    exempt: getFeeConfig().feeExemptAccounts.includes(a.accountId),
    ...walletSummary(a),
  }));
  res.json({ ok: true, wallets: rows });
});

app.post('/api/admin/wallets/:accountId/credit', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const account = getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'account not found' });
  const r = grantCredits(account, +req.body?.amount, req.body?.note || 'payment confirmed');
  if (!r.ok) return res.status(400).json({ error: r.error });
  persistAccounts();
  logLiveEvent(account.accountId, 'credit.grant', { amount: +req.body?.amount, note: req.body?.note || 'payment confirmed' });
  res.json({ ok: true, credits: r.credits });
});

// Public fee info — deposit addresses + bundles visible WITHOUT sign-in
// (customers need these to pay; no private data leaks).
app.get('/api/fee-info', (req, res) => {
  const cfg = getFeeConfig();
  res.json({ ok: true, wallet: cfg.wallet, bundles: cfg.bundles, burnRate: cfg.burnRate, minCreditsToTrade: cfg.minCreditsToTrade });
});

// ---- credit purchases (crypto → owner wallet → admin confirm) ----
app.post('/api/payments', requireUser, async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  const { bundleId, asset, txRef } = req.body || {};
  const r = createPayment(accountFor(req), bundleId, { asset, txRef });
  if (!r.ok) return res.status(400).json({ error: r.error });
  logLiveEvent(accountFor(req).accountId, 'payment.created', { id: r.payment.id, bundleId, asset, usd: r.payment.usd });
  res.json({ ok: true, payment: r.payment });
});

app.get('/api/payments', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  res.json({ ok: true, payments: listPayments({ accountId: accountFor(req).accountId }) });
});

app.get('/api/admin/payments', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  res.json({ ok: true, payments: listPayments({ status: req.query.status || null }) });
});

app.post('/api/admin/payments/:id/confirm', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const r = confirmPayment(req.params.id, getAccount, req.body?.note || '');
  if (!r.ok) return res.status(400).json({ error: r.error });
  persistAccounts();
  logLiveEvent(r.payment.accountId, 'payment.confirmed', { id: r.payment.id, credits: r.credits, bundleId: r.payment.bundleId });
  res.json({ ok: true, payment: r.payment, credits: r.credits });
});

app.post('/api/admin/payments/:id/reject', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const r = rejectPayment(req.params.id, req.body?.note || '');
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, payment: r.payment });
});

// FreqUI-style performance analytics: KPIs, equity curve, per-symbol breakdown
app.get('/api/performance', requireUser, (req, res) => {
  const st = getState(accountFor(req).accountId);
  const closed = st.journal.filter(j => j.status === 'closed');
  const wins = closed.filter(j => (j.pnl || 0) > 0);
  const losses = closed.filter(j => (j.pnl || 0) <= 0);
  const grossProfit = wins.reduce((a, j) => a + j.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, j) => a + j.pnl, 0));
  const totalPnl = closed.reduce((a, j) => a + (j.pnl || 0), 0);
  // equity curve: initial cash + cumulative realized P&L, final point = current mark-to-market
  const ordered = closed.slice().sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  let equity = st.account.initialCash;
  const curve = ordered.map(j => { equity += j.pnl || 0; return { t: j.closedAt, equity: Math.round(equity * 100) / 100 }; });
  const equityNow = Math.round((st.account.cash + st.positions.reduce((a, p) => a + ((p.lastPrice || p.entry) - p.entry) * p.size * (p.side === 'short' ? -1 : 1), 0)) * 100) / 100;
  if (!curve.length || curve[curve.length - 1].t < Date.now() - 60_000) curve.push({ t: Date.now(), equity: equityNow });
  // drawdown from running peak
  let peak = st.account.initialCash, maxDD = 0;
  for (const p of curve) { peak = Math.max(peak, p.equity); maxDD = Math.max(maxDD, peak - p.equity); }
  const best = closed.length ? closed.reduce((a, j) => (j.pnl || 0) > (a.pnl || 0) ? j : a) : null;
  const worst = closed.length ? closed.reduce((a, j) => (j.pnl || 0) < (a.pnl || 0) ? j : a) : null;
  // per-symbol breakdown
  const bySym = {};
  for (const j of closed) {
    bySym[j.symbol] = bySym[j.symbol] || { symbol: j.symbol, trades: 0, wins: 0, pnl: 0 };
    bySym[j.symbol].trades++;
    if ((j.pnl || 0) > 0) bySym[j.symbol].wins++;
    bySym[j.symbol].pnl = Math.round((bySym[j.symbol].pnl + (j.pnl || 0)) * 100) / 100;
  }
  res.json({
    ts: Date.now(),
    kpis: {
      totalPnl: Math.round(totalPnl * 100) / 100,
      returnPct: st.account.initialCash ? Math.round(totalPnl / st.account.initialCash * 10000) / 100 : null,
      currentEquity: equityNow,
      closed: closed.length,
      open: st.positions.length,
      winRate: closed.length ? Math.round(wins.length / closed.length * 1000) / 10 : null,
      profitFactor: grossLoss ? Math.round(grossProfit / grossLoss * 100) / 100 : (wins.length ? null : 0),
      expectancy: closed.length ? Math.round(totalPnl / closed.length * 100) / 100 : null,
      avgWin: wins.length ? Math.round(wins.reduce((a, j) => a + j.pnl, 0) / wins.length * 100) / 100 : null,
      avgLoss: losses.length ? Math.round(losses.reduce((a, j) => a + j.pnl, 0) / losses.length * 100) / 100 : null,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      maxDrawdownPct: st.account.initialCash ? Math.round(maxDD / st.account.initialCash * 10000) / 100 : null,
      bestTrade: best ? { symbol: best.symbol, pnl: best.pnl } : null,
      worstTrade: worst ? { symbol: worst.symbol, pnl: worst.pnl } : null,
    },
    equityCurve: curve,
    bySymbol: Object.values(bySym).sort((a, b) => b.pnl - a.pnl),
    recent: closed.slice(-8).reverse().map(j => ({ symbol: j.symbol, side: j.side, entry: j.entry, exitPrice: j.exitPrice, pnl: j.pnl, pnlPct: j.pnlPct, result: j.result, openedAt: j.openedAt, closedAt: j.closedAt, reason: j.reason })),
  });
});

app.post('/api/assistant', async (req, res) => {
  try {
    const q = (req.body?.question || '').trim();
    if (!q) return res.status(400).json({ error: 'question required' });
    res.json(await answer(q));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/assistant/status', (req, res) => res.json(assistantStatus()));

// ---- auth: session user OR valid X-API-Key passes; else 401 ----
function requireUser(req, res, next) {
  if (req.session?.userId) {
    const u = auth.findById(req.session.userId);
    if (u) { auth.trackSession(u, req.sessionID); return next(); }
  }
  if (req.agentKey || req.userAgent) return next();
  res.status(401).json({ error: 'auth required' });
}

// Per-user paper accounts (v1.8):
//   session user  → own account, created on first access with fresh $100K
//   platform key  → the shared 'default' account (platform/agent account)
//   user agent key→ the account of the user who created the key
//   else          → null (route should 401)
function accountFor(req) {
  if (req.session?.userId) {
    const u = auth.findById(req.session.userId);
    if (u) return ensureAccount(`user:${u.id}`, u.id);
  }
  if (req.userAgent) return ensureAccount(`user:${req.userAgent.userId}`, req.userAgent.userId);
  if (req.agentKey) return ensureAccount('default', 'default');
  return null;
}

// Decentralized agents identity: session user → 'user:<id>' (human),
// user agent key → 'agent:key:<keyId>' (customer's AI agent),
// platform X-API-Key → 'agent:<key>' (platform AI agent). Stable per principal.
function signalIdentity(req) {
  if (req.session?.userId) {
    const u = auth.findById(req.session.userId);
    if (u) return { agentId: `user:${u.id}`, name: u.email, kind: 'human' };
  }
  if (req.userAgent) return { agentId: `agent:key:${req.userAgent.keyId}`, name: req.userAgent.name, kind: 'ai' };
  if (req.agentKey) return { agentId: `agent:${req.agentKey}`, name: `agent ${req.agentKey}`, kind: 'ai' };
  return null;
}

// /api/auth/* — rate-limited (~10/min/IP), session management, 2FA, password reset
app.use('/api/auth', authLimiter, authRouter());

const API_INDEX = {
  name: 'IOST Terminal Agent API',
  version: '1.15.0',
  auth: 'X-API-Key header. Two key types: (1) platform keys via AGENT_KEYS env (default: demo-agent-key) → shared "default" account; (2) per-user "connect your AI agent" keys (itk_…, created in-app at /api/agent-keys) → bound to ONE user account with scopes: read / trade-paper / trade-live. Sensitive routes also accept a browser session (/api/auth/*).',
  accounts: 'Per-user paper accounts (v1.8): session users get their own cash/positions/journal; platform X-API-Key agents share the "default" account; per-user agent keys trade the account of the user who created them. Autopilot trades the default account.',
  decentralizedAgents: 'Phase 1 trust layer + marketplace: signals are SHA-256 hash-pinned on the IOST mainnet (token.iost transfer memo, verified via getTxReceiptByTxHash); without IOST_PIN_KEY pins queue off-chain ("pending-onchain"). Agents publish, humans follow (paper copy, 5-position cap).',
  agentKeys: [
    { path: '/api/agent-keys', method: 'POST', body: '{name?, scopes:[read,trade-paper,trade-live]}', purpose: 'create a per-user agent API key — returned ONCE; trade-live is owner-only' },
    { path: '/api/agent-keys', method: 'GET', purpose: 'list my agent keys (no secrets)' },
    { path: '/api/agent-keys/:id', method: 'DELETE', purpose: 'revoke a key instantly' },
    { path: '/api/agent-keys/self', method: 'GET', purpose: 'agent-side introspection: keyId + name + scopes (send X-API-Key)' },
  ],
  liveProposals: 'Option C — human-in-the-loop live trading: agents with trade-live scope REQUEST orders; NOTHING executes until the owner approves. Rails + venue re-validated at approval time.',
  liveProposalEndpoints: [
    { path: '/api/live/proposals', method: 'POST', body: '{symbol,side,size,entry?,reason?,confidence?}', purpose: 'agent requests a live trade (pending proposal created)' },
    { path: '/api/live/proposals', method: 'GET', query: 'status=pending|approved|rejected', purpose: 'list my proposals (owner session or agent key)' },
    { path: '/api/live/proposals/:id', method: 'GET', purpose: 'proposal status — agents poll this' },
    { path: '/api/live/proposals/:id/approve', method: 'POST', purpose: 'OWNER ONLY: approve + execute (rails enforced)' },
    { path: '/api/live/proposals/:id/reject', method: 'POST', purpose: 'OWNER ONLY: reject' },
  ],
  positionManagement: 'v1.13 — CryptoHopper-inspired, AI-aware: trailing stop-loss + trailing take-profit (ratchet with price, journaled exit reasons) and score-gated DCA (average down on dips, capped). Swept every 60s over all paper accounts. Every action is a normal journaled close/add with an honest reason.',
  managementEndpoints: [
    { path: '/api/management', method: 'GET', purpose: 'last position-management sweep: trailing exits + DCA adds + errors' },
    { path: '/api/paper/:id/management', method: 'POST', body: '{trailStopPct?,trailTpPct?,resetPeak?,dca?:{enabled,triggerPct,maxTrades,sizeFactor,cooldownMin}}', purpose: 'set/update trailing or DCA config on an open position' },
    { path: '/api/paper/open', method: 'POST', body: '{...,trailStopPct?,trailTpPct?,dca?:{enabled,triggerPct,maxTrades,sizeFactor,cooldownMin}}', purpose: 'open a paper trade with trailing/DCA from the start' },
  ],
  triggers: 'v1.14 — user-defined alerts: when a condition fires (price > level, AI score crosses threshold, 24h % move) → notify (event log, pollable for Telegram) or propose (live-trade proposal, owner-only). Edge-triggered (no spam), events capped, checked every 60s. Store data/triggers.json.',
  triggerEndpoints: [
    { path: '/api/triggers', method: 'GET', purpose: 'my triggers' },
    { path: '/api/triggers', method: 'POST', body: '{name?,symbol,condition:{type:price|score|pct24h,operator:gt|lt|gte|lte,value},action:notify|propose,side?,reason?}', purpose: 'create a trigger (propose action = owner-only)' },
    { path: '/api/triggers/:id', method: 'DELETE', purpose: 'delete a trigger' },
    { path: '/api/triggers/:id/toggle', method: 'POST', body: '{enabled:bool}', purpose: 'enable/disable a trigger' },
    { path: '/api/triggers/events', method: 'GET', query: 'since=ts&limit=N', purpose: 'recent trigger events (what fired, when, value seen)' },
  ],
  leaderboard: { path: '/api/leaderboard', method: 'GET', query: 'period=week|all', purpose: 'PUBLIC social proof: top paper traders by closed P&L (masked identities) — agents can read it too' },
  backtest: { path: '/api/backtest', method: 'POST', body: '{symbol,timeframe?:1d|4h|1h|15m,strategy:{name?,side,entry:{rule:ma-cross|rsi|breakout|ai-score,params},exit:{stopPct?,targetPct?,trailingPct?,maxBars?},sizePct?}}', purpose: 'PUBLIC backtesting (FXReplay methodology): objective rules vs historical bars → expectancy, profit factor, max drawdown, Sharpe, vs buy-and-hold + per-trade journal. Honest caveats included.' },
  points: 'Off-chain points ledger (tokenomics vision §6): no token issued. signal +10 · follower +5 · referral +50/+10 · feedback +5 (author) · weekly top paper trader +500. 1:1 AIT conversion planned at TGE (not guaranteed). Ledger data/points.json (atomic writes).',
  freeIostWallet: 'Every registered user gets a subsidized IOST mainnet account (platform pays ~11 IOST). Keys are generated IN THE BROWSER — the server never sees private keys, only the base64 public key + account name; it broadcasts auth.iost/signUp (VERIFIED ABI: createAccount does not exist on mainnet) with the platform account. No IOST_PIN_KEY → requests queue (status "pending") and flush when the key appears. Store data/iost_accounts.json.',
  discover: [{ path: '/.well-known/agent.json', method: 'GET', purpose: 'agent discovery manifest' }],
  market: [
    { path: '/api/scanner', method: 'GET', purpose: 'real-time analysis for all watchlist assets (signals, indicators, whale tape, rank, market cap)' },
    { path: '/api/market/global', method: 'GET', purpose: 'market-wide state: total crypto market cap, BTC dominance, 24h volume, active coins, Fear & Greed index' },
    { path: '/api/market/movers', method: 'GET', purpose: 'top 5 gainers and top 5 losers (24h) across the top-80 assets by market cap' },
    { path: '/api/analyze/:symbol', method: 'GET', purpose: 'full analysis for one symbol' },
    { path: '/api/klines/:symbol', method: 'GET', query: 'bar=15m|1h|1d&limit=N', purpose: 'ohlcv candles' },
    { path: '/api/scores', method: 'GET', purpose: '0-100 AI trade scores for all assets (composite + 6 subscores)' },
    { path: '/api/score/:symbol', method: 'GET', purpose: 'AI trade score for one symbol' },
    { path: '/api/probability', method: 'GET', purpose: 'probabilistic clarity: upside probability + confidence interval + signal drivers per asset' },
    { path: '/api/probability/:symbol/history', method: 'GET', purpose: 'rolling probability timeline (samples with CI band)' },
    { path: '/api/orderbook/:symbol', method: 'GET', purpose: 'L3 order book depth (bids/asks, OKX, crypto only)' },
    { path: '/api/contracts/:symbol', method: 'GET', purpose: 'L3 contract specification (tick size, lot size, min size, OKX SPOT)' },
  ],
  intelligence: [
    { path: '/api/news', method: 'GET', purpose: 'headlines + per-asset sentiment classification' },
    { path: '/api/onchain', method: 'GET', purpose: 'IOST mainnet dashboard (TPS, head block, large transfers, gas/RAM)' },
    { path: '/api/assistant', method: 'POST', body: '{question}', purpose: 'natural-language market Q&A synthesized from live data' },
  ],
  risk: [
    { path: '/api/risk', method: 'POST', body: '{accountSize,maxRiskPct,entryPrice,stopLoss,targetPrice,side}', purpose: 'position size, $ risk, R:R, potential P/L, exposure' },
    { path: '/api/portfolio', method: 'GET', purpose: 'whole-portfolio AI analysis' },
  ],
  execution: [
    { path: '/api/account', method: 'GET', purpose: 'light per-account snapshot for UI topbar: cash, equity, openPositions, lastTrades' },
    { path: '/api/paper', method: 'GET', purpose: 'account + open positions + journal (mark-to-market)' },
    { path: '/api/paper/open', method: 'POST', body: '{symbol,side,size|stop+risk,stop,target,reason,confidence}', purpose: 'open paper trade' },
    { path: '/api/paper/close', method: 'POST', body: '{positionId,exitPrice?}', purpose: 'close paper trade' },
    { path: '/api/paper/stats', method: 'GET', purpose: 'journal statistics (win rate, P&L)' },
    { path: '/api/paper/reset', method: 'POST', purpose: 'reset paper account' },
  ],
  agents: [
    { path: '/api/signals', method: 'POST', body: '{type,symbol,side,entry?,size?,target?,stop?,content?,tags?,reason?,trail?}', purpose: 'publish a signal as the authenticated principal (X-API-Key agent or session user); auto-pins its SHA-256 hash on IOST mainnet; optional trail=[{step,input,output,confidence}] ≤20 steps for XAI traceability' },
    { path: '/api/signals/feed', method: 'GET', query: 'limit=&type=&symbol=&agentId=', purpose: 'public signal feed, newest first, each with pin status + proof link + hasTrail flag' },
    { path: '/api/signals/:id', method: 'GET', purpose: 'single signal (public)' },
    { path: '/api/signals/:id/proof', method: 'GET', purpose: 'on-chain proof verifier: pin status, recomputed hash, receipt check, explorer link' },
    { path: '/api/signals/:id/trail', method: 'GET', purpose: 'XAI: structured reasoning trail for a signal (steps with input, output, confidence)' },
    { path: '/api/agents', method: 'GET', purpose: 'agent registry with provable track records (win rate from journals, pin counts, followers)' },
    { path: '/api/signals/:id/follow', method: 'POST', body: '{agentId?}', purpose: 'paper copy-follow an agent (session user; mirrors positions, 5-position cap)' },
    { path: '/api/signals/:id/follow', method: 'DELETE', body: '{agentId?}', purpose: 'unfollow an agent' },
    { path: '/api/signals/following', method: 'GET', purpose: 'agents I follow + my copied positions' },
    { path: '/api/chain/status', method: 'GET', purpose: 'IOST mainnet trust-layer status (RPC reachability, pin key configured?)' },
  ],
  points: [
    { path: '/api/points', method: 'GET', purpose: 'balance + recent ledger + referral code/link for the current principal (session user or X-API-Key agent)' },
    { path: '/api/points/referral-code', method: 'POST', purpose: 'get/create my 8-char referral code (share it: referrer +50, referee +10)' },
    { path: '/api/points/feedback', method: 'POST', body: '{signalId,rating(1-5),comment?}', purpose: 'rate a signal\'s quality — its AUTHOR gains +5 (capped 1 per rater per signal; rater gains nothing)' },
    { path: '/api/points/bounty/status', method: 'GET', purpose: 'weekly top-trader bounty state: current ISO week, last award, trailing-7d leaderboard' },
    { path: '/api/points/bounty/run', method: 'POST', purpose: 'admin/agent only — award +500 to the top paper trader of the trailing 7 days (once per ISO week)' },
  ],
  wallets: [
    { path: '/api/account/iost/status', method: 'GET', purpose: 'public honesty endpoint (no auth): subsidized?, fee (~11 IOST), platform funding configured?, account-name rules, explorer base' },
    { path: '/api/account/iost', method: 'POST', body: '{publicKey (base64 of 32-byte Ed25519 public key), accountName?}', purpose: 'request a free platform-subsidized IOST mainnet wallet for the signed-in user — the browser generates the Ed25519 keypair and the server only ever receives the PUBLIC key; creation is broadcast via auth.iost/signUp with the platform funded account, or queued (status pending) until funding is configured' },
    { path: '/api/account/iost', method: 'GET', purpose: 'my wallet status (session user): none/pending/created/failed + account name + creation tx + block' },
  ],
  autonomy: [
    { path: '/api/autopilot', method: 'GET', purpose: 'autopilot status + config + action audit trail + pending proposals' },
    { path: '/api/autopilot/start', method: 'POST', body: '{config?}', purpose: 'enable autonomous trading loop' },
    { path: '/api/autopilot/stop', method: 'POST', purpose: 'disable autonomous loop' },
    { path: '/api/autopilot/config', method: 'POST', body: '{requireApproval,openMinScore,maxConcurrent,...}', purpose: 'update strategy params (requireApproval=true queues entries for human approval)' },
    { path: '/api/autopilot/proposals', method: 'GET', purpose: 'pending human-in-the-loop proposals with full reasoning (symbol, size, stop, target, confidence, reason)' },
    { path: '/api/autopilot/proposals/:id/approve', method: 'POST', purpose: 'human override — execute a pending proposal now' },
    { path: '/api/autopilot/proposals/:id/reject', method: 'POST', purpose: 'human override — block a pending proposal' },
  ],
  meta: [
    { path: '/api/meta', method: 'GET', purpose: 'platform state for agents: watchlist, account, engine status, freshness' },
    { path: '/api/performance', method: 'GET', purpose: 'performance analytics: win rate, profit factor, expectancy, equity curve, per-symbol breakdown, recent trades' },
    { path: '/api/ui-state', method: 'GET', purpose: 'single-call full snapshot mirroring the dashboard' },
    { path: '/api/audit', method: 'GET', query: 'agent=&limit=', purpose: 'append-only agent audit log (JSONL data/agent-audit.jsonl): payload hashes only, never contents — tail by agent, default 50 / max 200' },
    { path: '/api/health', method: 'GET', purpose: 'liveness' },
  ],
};

app.get('/.well-known/agent.json', (req, res) => {
  res.json({ name: 'IOST Terminal', version: '1.11.0', machineReadable: true, api: '/api', index: '/api', meta: '/api/meta', uiState: '/api/ui-state', auth: '/api/auth', points: '/api/points', wallet: '/api/account/iost', contracts: API_INDEX });
});
app.get('/api', (req, res) => res.json(API_INDEX));
app.get('/api/meta', async (req, res) => {
  try {
    const [scan, news, onchain] = await Promise.all([
      scanAll().catch(() => []),
      getNews().catch(() => null),
      getChainSnapshot().catch(() => null),
    ]);
    res.json({
      ts: Date.now(),
      version: '1.6.0',
      mode: 'paper',
      watchlist: WATCHLIST,
      account: { initialCash: getState('default').account.initialCash, cash: getState('default').account.cash, openPositions: getState('default').positions.length },
      engines: {
        scanner: { status: scan.length ? 'ok' : 'degraded', assets: scan.length },
        news: { status: news ? 'ok' : 'degraded', headlines: news?.market?.total ?? 0 },
        onchain: { status: onchain?.live ? 'ok' : 'degraded', headBlock: onchain?.chain?.headBlock ?? null, tps: onchain?.chain?.tps ?? null },
        autopilot: { enabled: getAutopilot().enabled, ticks: getAutopilot().ticks, lastTick: getAutopilot().lastTick },
      },
      freshness: { scanner: scan[0]?.ts ?? null, news: news?.fetchedAt ?? null, onchain: onchain?.fetchedAt ?? null },
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/ui-state', async (req, res) => {
  try {
    const [scan, scores, paper, news, onchain] = await Promise.all([
      scanAll().catch(() => []),
      allScores().catch(() => []),
      markToMarket().catch(() => getState()),
      getNews().catch(() => null),
      getChainSnapshot().catch(() => null),
    ]);
    res.json({
      ts: Date.now(),
      scanner: scan.map(a => ({ symbol: a.symbol, type: a.type, price: a.price, change24hPct: a.change24hPct, bias: a.biasLabel, rsi: a.indicators?.rsi, volZ: a.indicators?.volZ, signals: a.signals.map(s => s.label), whales: a.whale?.bigTrades24h ?? 0 })),
      scores: scores.slice(0, 8).map(s => ({ symbol: s.symbol, composite: s.composite, grade: s.grade, subscores: s.subscores })),
      account: { initialCash: paper.account.initialCash, cash: paper.account.cash, openPositions: paper.positions.length, exposurePct: paper.positions.length ? Math.round(paper.positions.reduce((a, p) => a + p.notional, 0) / paper.account.initialCash * 1000) / 10 : 0 },
      autopilot: { enabled: getAutopilot().enabled, config: getAutopilot().config, recentActions: getAutopilot().actions.slice(0, 10) },
      market: news?.market ?? null,
      onchain: onchain?.chain ? { headBlock: onchain.chain.headBlock, tps: onchain.chain.tps, peers: onchain.chain.peerCount, activeAddresses: onchain.chain.activeAddresses } : null,
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// append-only agent audit log — tail reader over data/agent-audit.jsonl
// ?agent=<agentId>&limit=N (default 50, max 200); entries newest-first
app.get('/api/audit', (req, res) => {
  const agent = String(req.query.agent || '').trim() || null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  let entries = [];
  try {
    if (existsSync(AUDIT_FILE)) {
      entries = readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch { /* no log yet */ }
  if (agent) entries = entries.filter((e) => e.agentId === agent);
  res.json({ agent, count: entries.length, entries: entries.slice(-limit).reverse() });
});

app.get('/api/autopilot', requireUser, (req, res) => {
  const s = getAutopilot();
  res.json({ enabled: s.enabled, startedAt: s.startedAt, ticks: s.ticks, lastTick: s.lastTick, config: s.config, actions: s.actions.slice(0, 25), proposals: getProposals(), liveGate: anyLiveEnabled() });
});
app.post('/api/autopilot/start', requireUser, (req, res) => { startAutopilot(req.body?.config || null); res.json(getAutopilot()); });
app.post('/api/autopilot/stop', requireUser, (req, res) => { stopAutopilot(); res.json(getAutopilot()); });
app.post('/api/autopilot/config', requireUser, (req, res) => res.json(setAutopilotConfig(req.body || {})));
app.post('/api/autopilot/tick', requireUser, async (req, res) => res.json(await tickAutopilot())); // manual tick for agents/testing
app.get('/api/autopilot/proposals', requireUser, (req, res) => res.json({ pending: getProposals() })); // ARD: human-in-the-loop queue
app.post('/api/autopilot/proposals/:id/approve', requireUser, async (req, res) => res.json(await approveProposal(req.params.id))); // override: execute now
app.post('/api/autopilot/proposals/:id/reject', requireUser, (req, res) => res.json(rejectProposal(req.params.id))); // override: block this entry

// autonomy loop: 60s cadence, no human needed
setInterval(() => { tickAutopilot().catch(() => {}); }, 60_000);

// ---------- v1.13 position management (trailing stops/TP + DCA) ----------
// Sweep every 60s over ALL paper accounts: ratchets trailing stops, locks
// trailing take-profits, and (optionally score-gated) averages down via DCA.
// Every action is a normal journaled close/add with an honest reason.
let mgmtRunning = false;
setInterval(async () => {
  if (mgmtRunning) return;
  mgmtRunning = true;
  try { await management.sweepManagement(); } catch (e) { console.error('[mgmt] sweep error:', e.message); }
  finally { mgmtRunning = false; }
}, 60_000);
management.sweepManagement().catch(() => {}); // run once at boot

// ---------- v1.14 triggers/alerts ----------
// Same 60s cadence. Price triggers via getTicker; score triggers via the same
// analyzeSymbol+computeScores path as /api/score/:symbol; 'propose' actions
// fire LIVE proposals for allowlisted (owner) users only.
let trigRunning = false;
async function checkTriggersTick() {
  if (trigRunning) return;
  trigRunning = true;
  try {
    const ownerIds = new Set(
      (process.env.LIVE_EMAIL_ALLOWLIST || '').split(',')
        .map((e) => e.trim().toLowerCase()).filter(Boolean)
        .map((em) => auth.findByEmail(em)?.id).filter(Boolean)
    );
    const r = await triggers.checkTriggers({
      getPrice: async (sym, full) => {
        const t = await getTicker(sym);
        return full ? t : t.last;
      },
      getScore: async (sym) => {
        try {
          const a = await analyzeSymbol(sym.toUpperCase(), { force: true });
          return computeScores(a, getAssetSentiment(a.symbol)).composite;
        } catch { return null; }
      },
      ownerIds,
    });
    if (r.fired.length) console.log(`[triggers] fired ${r.fired.length}: ${r.fired.map((e) => e.name).join(', ')}`);
  } catch (e) { console.error('[triggers] tick error:', e.message); }
  finally { trigRunning = false; }
}
setInterval(() => { checkTriggersTick().catch(() => {}); }, 60_000);
checkTriggersTick().catch(() => {}); // once at boot

// trigger CRUD + events (session or agent key; scope: any authenticated principal)
app.get('/api/triggers', requireUser, (req, res) => {
  const uid = principalUserId(req);
  if (!uid) return res.status(403).json({ error: 'no user principal' });
  res.json({ ok: true, triggers: triggers.listTriggers(uid) });
});
app.post('/api/triggers', requireUser, (req, res) => {
  const uid = principalUserId(req);
  if (!uid) return res.status(403).json({ error: 'no user principal' });
  if ((req.body?.action || 'notify') === 'propose' && !(req.session?.userId && isLiveAllowed(auth.findById(req.session.userId)?.email)))
    return res.status(403).json({ error: 'propose action is owner-only for now' });
  const r = triggers.createTrigger({ userId: uid, ...(req.body || {}) });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json({ ok: true, trigger: r.trigger });
});
app.delete('/api/triggers/:id', requireUser, (req, res) => {
  const uid = principalUserId(req);
  if (!uid) return res.status(403).json({ error: 'no user principal' });
  const r = triggers.deleteTrigger({ userId: uid, id: req.params.id });
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
});
app.post('/api/triggers/:id/toggle', requireUser, (req, res) => {
  const uid = principalUserId(req);
  if (!uid) return res.status(403).json({ error: 'no user principal' });
  const r = triggers.setEnabled({ userId: uid, id: req.params.id, enabled: req.body?.enabled !== false });
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, trigger: r.trigger });
});
app.get('/api/triggers/events', requireUser, (req, res) => {
  const uid = principalUserId(req);
  if (!uid) return res.status(403).json({ error: 'no user principal' });
  res.json({ ok: true, events: triggers.listEvents({ userId: uid, since: +req.query.since || 0, limit: +req.query.limit || 20 }) });
});

// current principal's userId (session user, per-user agent key, or platform agent → null)
function principalUserId(req) {
  if (req.session?.userId) return req.session.userId;
  if (req.userAgent) return req.userAgent.userId;
  return null;
}

// ---------- v1.14 leaderboard (public social proof, ARD) ----------
// Ranks paper accounts by closed-trade P&L for the period (week | all).
// Identities are masked (t***@domain) — social proof without doxxing.
// Shared by GET /api/leaderboard and the landing-page SSR section.
function computeLeaderboard(period = 'week', limit = 10) {
  const since = period === 'all' ? 0 : Date.now() - 7 * 24 * 3600 * 1000;
  const rows = [];
  for (const acc of listAccounts()) {
    const st = getState(acc.accountId);
    const closed = st.journal.filter((j) => j.status === 'closed' && j.closedAt >= since);
    if (!closed.length) continue;
    const wins = closed.filter((j) => j.result === 'win').length;
    const pnl = closed.reduce((a, j) => a + (j.pnl || 0), 0);
    const equity = st.account.cash + st.positions.reduce((a, p) => a + (p.notional || 0), 0);
    let label = 'Platform agent';
    if (acc.owner && acc.owner !== 'default') {
      const u = auth.findById(acc.owner);
      const em = u?.email || acc.owner;
      label = em.includes('@') ? `${em.slice(0, 1)}***@${em.split('@')[1]}` : `${em.slice(0, 4)}…`;
    }
    rows.push({
      rank: 0, trader: label, pnl: Math.round(pnl * 100) / 100,
      winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : 0,
      trades: closed.length, wins, losses: closed.length - wins,
      equity: Math.round(equity * 100) / 100, period,
    });
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows.slice(0, limit);
}

app.get('/api/leaderboard', (req, res) => {
  const period = req.query.period === 'all' ? 'all' : 'week';
  res.json({ ok: true, period, generatedAt: Date.now(), top: computeLeaderboard(period, 10) });
});

// ---------- v1.15 backtesting (FXReplay methodology, honest KPIs) ----------
// Validate RULES against historical bars. Public + agent-accessible (ARD).
// Reports expectancy, profit factor, max drawdown, Sharpe, vs buy-and-hold —
// win rate alone is the least informative metric. Honesty is part of the
// result (sample-size caveat, assumptions, past ≠ future).
app.post('/api/backtest', async (req, res) => {
  const { symbol, timeframe, strategy } = req.body || {};
  if (!symbol || !strategy?.entry?.rule) return res.status(400).json({ error: 'symbol and strategy.entry.rule required' });
  try {
    const r = await runBacktest({ symbol, timeframe: timeframe || '1d', strategy });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// status endpoint — honest ARD: last sweep summary
app.get('/api/management', requireUser, (req, res) => res.json({ ok: true, ...management.sweepStatus() }));

// update trailing/DCA config on an OPEN position
app.post('/api/paper/:id/management', requireUser, (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'trade-paper')) return res.status(403).json({ error: 'scope: this key cannot trade (missing trade-paper)' });
  const acc = accountFor(req);
  const r = management.updatePositionManagement(acc.accountId, req.params.id, req.body || {});
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, position: r.position });
});

// ---------- SSE real-time push ----------
const clients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    ...SECURITY_HEADERS, // writeHead replaces set headers — keep security headers on SSE too
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

let pushing = false;
async function pushTick() {
  if (pushing || !clients.size) return;
  pushing = true;
  try {
    const [scan, scores] = await Promise.all([scanAll(), allScores()]);
    const payload = JSON.stringify({ ts: Date.now(), scan, scores });
    for (const c of clients) c.write(`event: tick\ndata: ${payload}\n\n`);
  } catch { /* next tick */ } finally { pushing = false; }
}
setInterval(pushTick, 20_000);

// ---------- serve ----------
// JSON error handler: never leak stack traces / HTML error pages to clients
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[server] ${req.method} ${req.path}: ${err.message}`);
  res.status(err.status || 500).json({ error: 'internal server error' });
});

const server = createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`IOST Terminal running → http://localhost:${PORT}`);
  console.log(`API: /api/health · /api/scanner · /api/scores · /api/news · /api/onchain · /api/risk · /api/portfolio · /api/paper · /api/assistant`);
});
