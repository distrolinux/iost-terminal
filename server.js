// server.js — IOST Terminal: AI real-trading platform (paper execution)
import express from 'express';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTicker, getKlines, WATCHLIST } from './lib/market.js';
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
import * as aitt from './lib/aitt.js';
import * as wallets from './lib/wallets.js';
import * as limits from './lib/limits.js';
import * as freeze from './lib/freeze.js';
import * as stakes from './lib/stakes.js';
import * as slashes from './lib/slashes.js';
import * as trust from './lib/trust.js';
import * as pacts from './lib/pacts.js';
import * as iostAccounts from './lib/iost-accounts.js';
import * as agentKeys from './lib/agent-keys.js';
import * as liveProposals from './lib/live-proposals.js';
import * as management from './lib/management.js';
import * as triggers from './lib/triggers.js';
import { runBacktest, describeRule } from './lib/backtest.js';
import { auditToken, smartMoney, AUDIT_CHAINS, SIGNAL_CHAINS } from './lib/binance-data.js';
import session from 'express-session';
import { FileSessionStore } from './lib/session-store.js';
import { authRouter, authLimiter } from './lib/auth-routes.js';
import rateLimit from 'express-rate-limit';
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
// API keys (optional; agents SHOULD authenticate). Set AGENT_KEYS="k1,k2" — no default (fail closed).
// Registered BEFORE all routes so every protected route can see a valid key.
const AGENT_KEYS = new Set((process.env.AGENT_KEYS || '').split(',').map(s => s.trim()).filter(Boolean));
// OAuth 2.0 bearer tokens (v1.17): opaque tokens minted at POST /oauth/token
// via client_credentials (client_id = agent-key id, client_secret = full itk_ key).
// In-memory, TTL 24h, revocable via /oauth/revoke — a restart clears them (documented).
const oauthTokens = new Map(); // token -> { userId, keyId, scopes, expiresAt }
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
  // OAuth bearer tokens resolve to the same principal shape as user agent keys,
  // so every existing scope guard (userAgentHas) works unchanged.
  if (!req.userAgent) {
    const authz = req.get('authorization') || '';
    if (/^Bearer\s+/i.test(authz)) {
      const entry = oauthTokens.get(authz.replace(/^Bearer\s+/i, '').trim());
      if (entry && entry.expiresAt > Date.now()) {
        req.userAgent = { userId: entry.userId, keyId: entry.keyId, name: 'oauth', scopes: entry.scopes.slice() };
      }
    }
  }
  next();
});
// shared public-API limiter for resource-heavy endpoints (upstream calls / CPU work).
// Defined before any route uses it (TDZ-safe): scanner/risk/assistant register earlier in the file.
const PUBLIC_LIMIT = Number.parseInt(process.env.PUBLIC_RATE_LIMIT || '60', 10) || 60;
const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: PUBLIC_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many requests — slow down' },
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
for (const f of ['index.html', 'hub.html', 'app.html', 'token.html']) {
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
  const headExtra = `${meta}\n<meta name="agent:state" content="/api/ui-state">\n<link rel="alternate" type="application/json" title="IOST Terminal agent state" href="/api/ui-state">\n<link rel="alternate" type="text/markdown" title="IOST Terminal LLM index" href="/llms.txt">\n<link rel="llms" href="/llms.txt">\n<link rel="api-catalog" href="/.well-known/api-catalog">\n<link rel="ai-catalog" href="/.well-known/ai-catalog.json">\n<link rel="service-desc" type="application/openapi+json" href="/openapi.json">\n${jsonLdBlock()}`;
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

// ---------- markdown negotiation (Cloudflare "Markdown for Agents") ----------
// When an agent requests with Accept: text/markdown we return a markdown
// rendering of the page instead of HTML. Browsers (Accept: text/html) are
// unaffected. The markdown is built from the same 30s ssrState snapshot the
// HTML SSR uses — an agent with zero JS still gets live values.
function acceptsMarkdown(req) {
  const accept = req.headers.accept || '';
  return accept.includes('text/markdown') || accept.includes('text/x-markdown') || /markdown/i.test(accept.split(',')[0]);
}
function mdTable(rows) {
  if (!rows || !rows.length) return '_no data yet_';
  const w = (arr) => arr.map((c) => Math.max(4, c.length));
  const widths = w(rows[0].map((c) => String(c)));
  for (const r of rows.slice(1)) r.forEach((c, i) => { widths[i] = Math.max(widths[i], String(c).length); });
  const fmt = (r) => '| ' + r.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  const sep = '|' + widths.map((n) => '-'.repeat(n + 2)).join('|') + '|';
  return [fmt(rows[0]), sep, ...rows.slice(1).map(fmt)].join('\n');
}
function markdownFor(name) {
  const s = ssrState;
  const base = `# IOST Terminal — AI Real-Trading Platform\n\n> AI real-time trading platform for crypto + equities: live market data, AI\n> trade scores (0-100 with subscore breakdown), risk engine, news sentiment,\n> IOST on-chain dashboard, paper trading and an autonomous autopilot.\n> Paper-first: nothing here moves real money without explicit enablement.\n\nMachine interfaces: [API index](/api) · [OpenAPI](/openapi.json) · [full state](/api/ui-state) · [LLM index](/llms.txt) · [agent auth](/auth.md) · [ARD manifest](/.well-known/ai-catalog.json)\n`;
  if (name === 'app' || name === 'hub') {
    const isApp = name === 'app';
    return `${base}\n## ${isApp ? 'AI Command Center' : 'Automation Hub'}\n\nThis is the ${isApp ? 'interactive trading console' : '3D automation hub'} — a client-side application shell.\nLive machine-readable state (server-rendered, no JS required): **/api/ui-state**\n\n- Top AI scores: ${(s?.scores || []).slice(0, 5).map((x) => `${x.symbol} ${x.composite} ${x.grade}`).join(' · ') || 'n/a'}\n- Autopilot: ${s?.autopilot?.enabled ? `enabled (${s.autopilot.ticks} ticks)${s.autopilot.config?.requireApproval ? ' · human-approval mode' : ''}` : 'disabled'}\n- Paper account: ${s?.paper?.account?.cash != null ? `$${Number(s.paper.account.cash).toLocaleString('en-US', { maximumFractionDigits: 2 })} cash · ${s.paper.positions?.length || 0} open` : 'n/a'}\n\nActions for agents: authenticated via **X-API-Key** header or **OAuth 2.0 client_credentials** (see [/auth.md](/auth.md)); live trades require owner approval through the proposal queue ([/api/autopilot/proposals](/api/autopilot/proposals)).\n`;
  }
  if (name === 'token') {
    return `${base}\n## AITT — Agent Intelligence Trading Token\n\nERC-20 on IOST L2 (chain 182), 1B fixed supply, 8 decimals. Design draft — NOT issued yet.\n- Public info: [/api/aitt/info](/api/aitt/info)\n- Token page: [/aitt](/aitt) (SSR — no JS required)\n- Whitepaper: [/whitepaper](/whitepaper) (markdown)\n- Points → AITT conversion: 1:1 at TGE, gate closed until deploy (honest, no writes).\n`;
  }
  // index/landing — the full agent summary
  const scores = (s?.scores || []).slice(0, 10).map((x) => {
    const p = probFor(x.symbol);
    return [x.symbol, String(x.composite), x.grade || '', p ? `${Math.round(p.probUp * 100)}% (CI ${Math.round(p.ciLo * 100)}–${Math.round(p.ciHi * 100)})` : '—', x.change24hPct != null ? `${x.change24hPct >= 0 ? '+' : ''}${Number(x.change24hPct).toFixed(2)}%` : '—'];
  });
  const m = s?.market;
  const c = s?.onchain?.chain;
  const mood = m ? (m.bullish > m.bearish ? '🟢 bullish' : m.bearish > m.bullish ? '🔴 bearish' : '⚪ mixed') : 'n/a';
  const moodCounts = m ? `${Number(m.bullish) || 0} bull · ${Number(m.neutral) || 0} neutral · ${Number(m.bearish) || 0} bear headlines` : 'n/a';
  const lb = computeLeaderboard('week', 5);
  return `${base}
## Live snapshot (${new Date(s?.ts || Date.now()).toISOString()})

**Market mood:** ${mood} (${moodCounts}) · **IOST mainnet:** ${c ? `${c.tps} tx/s · head block ${Number(c.headBlock).toLocaleString('en-US')} · ${c.peerCount} peers` : 'n/a'}

### Top AI trade scores
${mdTable([['SYMBOL', 'SCORE', 'GRADE', 'UPSIDE PROB', '24H'], ...scores])}

### Top paper traders (week)
${lb.length ? mdTable([['RANK', 'TRADER', 'P&L', 'WIN RATE', 'TRADES']].concat(lb.map((r) => [String(r.rank), r.trader, `$${r.pnl.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, `${r.winRate}%`, String(r.trades)]))) : '_no closed trades yet_'}

### Autopilot
${s?.autopilot?.enabled ? `enabled (${s.autopilot.ticks} ticks)${s.autopilot.config?.requireApproval ? ' — human-approval mode: entries queue at /api/autopilot/proposals' : ''}` : 'disabled (paper account idle)'}

### Agent access
- **Read state (no auth):** [/api/ui-state](/api/ui-state) · [/api/scores](/api/scores) · [/api/scanner](/api/scanner) · [/api/news](/api/news) · [/api/onchain](/api/onchain) · [/api/probability](/api/probability)
- **Authenticate:** mint an agent key in the app (Portfolio → AI Agents) → send as \`X-API-Key: itk_…\`, or OAuth 2.0 client_credentials → Bearer token ([/auth.md](/auth.md))
- **Trade (paper):** POST /api/paper/open|close with a \`trade-paper\`-scoped key
- **Live:** proposals only — owner approves before anything executes (option C, human-in-the-loop)
`;
}
// RFC 8288 Link headers — point agents at the discovery resources from every HTML page
function setAgentHeaders(res) {
  res.set('Link', [
    '</.well-known/api-catalog>; rel="api-catalog"',
    '</.well-known/ai-catalog.json>; rel="ai-catalog"',
    '</openapi.json>; rel="service-desc"; type="application/openapi+json"',
    '</llms.txt>; rel="llms"',
    '</api>; rel="service-doc"',
    '</.well-known/agent.json>; rel="service-doc"',
    '</api/ui-state>; rel="alternate"; type="application/json"',
  ].join(', '));
}
function sendPage(req, res, name) {
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'Accept');
  if (acceptsMarkdown(req)) {
    res.type('text/markdown; charset=utf-8');
    return res.send(markdownFor(name));
  }
  setAgentHeaders(res);
  res.send(renderPage(`${name}.html`));
}

// SSR routes — full market state present in the initial HTML (no client JS needed)
app.get('/', (req, res) => sendPage(req, res, 'index'));
app.get('/hub', (req, res) => sendPage(req, res, 'hub'));
app.get('/app', (req, res) => sendPage(req, res, 'app'));
// AITT token page — public, SSR (CMC-ready: crawlers get full content, no JS required)
app.get(['/aitt', '/token'], (req, res) => sendPage(req, res, 'token'));
// Whitepaper (markdown distribution copy of TOKENOMICS.md — kept in sync)
app.get('/whitepaper', (req, res) => {
  try {
    res.type('text/markdown; charset=utf-8');
    res.send(readFileSync(join(ROOT, 'docs', 'AITT-Whitepaper-v1.0.md'), 'utf8'));
  } catch {
    res.status(404).json({ error: 'whitepaper not available yet' });
  }
});
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
const SITEMAP_URLS = ['/', '/app', '/hub', '/aitt', '/token', '/whitepaper', '/terms', '/privacy', '/risk-disclosure'];
app.get('/sitemap.xml', (req, res) => {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_URLS
    .map((p) => `  <url><loc>${SITE_URL}${p}</loc><lastmod>${lastmod}</lastmod><changefreq>${p === '/' ? 'hourly' : 'weekly'}</changefreq></url>`)
    .join('\n');
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

// ================= agent discovery layer (v1.17) =================
// Everything below is additive discovery metadata — zero impact on the
// trading engine. Standards: RFC 9727 (API catalog), RFC 8414 (OAuth AS
// metadata), RFC 9728 (protected-resource metadata), SEP-1649 (MCP server
// card), Agent Skills Discovery RFC v0.2.0, ARD (ai-catalog.json), WebMCP.

const DISCOVERY_VERSION = '1.17.0';

// ---- RFC 9727 API catalog (application/linkset+json) ----
app.get('/.well-known/api-catalog', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/linkset+json');
  res.json({
    linkset: [
      {
        anchor: `${SITE_URL}/api`,
        'service-desc': [`${SITE_URL}/openapi.json`],
        'service-doc': [`${SITE_URL}/api`],
        status: [`${SITE_URL}/api/health`],
      },
      {
        anchor: `${SITE_URL}/.well-known/agent.json`,
        'service-doc': [`${SITE_URL}/.well-known/agent.json`],
      },
      {
        anchor: `${SITE_URL}/llms.txt`,
        'describedby': [`${SITE_URL}/llms.txt`],
      },
    ],
  });
});

// ---- OpenAPI 3.0.3 — curated, honest subset of the public + authed API ----
const OPENAPI_PATHS = {
  '/api/health': { get: { summary: 'Liveness probe', tags: ['meta'], security: [] } },
  '/api/meta': { get: { summary: 'Platform state for agents: watchlist, account, engine status, freshness', tags: ['meta'], security: [] } },
  '/api/ui-state': { get: { summary: 'Single-call full snapshot mirroring the dashboard (scanner, scores, account, autopilot, market, on-chain)', tags: ['meta'], security: [] } },
  '/api': { get: { summary: 'Full API index — every endpoint, method, body and purpose', tags: ['meta'], security: [] } },
  '/api/scanner': { get: { summary: 'Real-time analysis for all watchlist assets (signals, indicators, whale tape, rank, market cap)', tags: ['market'], security: [] } },
  '/api/scores': { get: { summary: '0-100 AI trade scores for all assets (composite + 6 subscores)', tags: ['market'], security: [] } },
  '/api/score/{symbol}': { get: { summary: 'AI trade score for one symbol', tags: ['market'], security: [], parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }] } },
  '/api/analyze/{symbol}': { get: { summary: 'Full analysis for one symbol', tags: ['market'], security: [], parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }] } },
  '/api/klines/{symbol}': { get: { summary: 'OHLCV candles (bar=15m|1h|1d, limit=N)', tags: ['market'], security: [], parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }] } },
  '/api/probability': { get: { summary: 'Upside probability + confidence interval + signal drivers per asset', tags: ['market'], security: [] } },
  '/api/orderbook/{symbol}': { get: { summary: 'L3 order book depth (OKX, crypto only)', tags: ['market'], security: [], parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }] } },
  '/api/news': { get: { summary: 'Headlines + per-asset sentiment classification', tags: ['intelligence'], security: [] } },
  '/api/onchain': { get: { summary: 'IOST mainnet dashboard (TPS, head block, large transfers, gas/RAM)', tags: ['intelligence'], security: [] } },
  '/api/assistant': { post: { summary: 'Natural-language market Q&A synthesized from live data', tags: ['intelligence'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } } } } },
  '/api/risk': { post: { summary: 'Position size, $ risk, R:R, potential P/L, exposure', tags: ['risk'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
  '/api/leaderboard': { get: { summary: 'Top paper traders by closed P&L (masked identities)', tags: ['social'], security: [] } },
  '/api/backtest': { post: { summary: 'Objective-rules backtest with FXReplay KPIs + honesty caveats', tags: ['analysis'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
  '/api/token-audit': { post: { summary: 'Binance Web3 token security audit (honeypot/rug/tax scan)', tags: ['analysis'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { contractAddress: { type: 'string' }, chainId: { type: 'string' } }, required: ['contractAddress'] } } } } } },
  '/api/smart-money': { get: { summary: 'Whale buy/sell signals (BSC/Solana)', tags: ['analysis'], security: [] } },
  '/api/signals/feed': { get: { summary: 'Public signal feed with on-chain proof status', tags: ['agents'], security: [] } },
  '/api/autopilot/proposals': { get: { summary: 'Pending human-in-the-loop proposals with full reasoning', tags: ['autonomy'], security: [] } },
  '/api/paper': { get: { summary: 'Account + open positions + journal (mark-to-market)', tags: ['execution'] } },
  '/api/paper/open': { post: { summary: 'Open paper trade', tags: ['execution'] } },
  '/api/paper/close': { post: { summary: 'Close paper trade', tags: ['execution'] } },
  '/api/signals': { post: { summary: 'Publish a signal as the authenticated principal; SHA-256 pinned on IOST mainnet', tags: ['agents'] } },
  '/api/agent-keys': { get: { summary: 'My AI-agent API keys (scopes, prefixes)', tags: ['auth'] }, post: { summary: 'Mint a scoped AI-agent API key', tags: ['auth'] } },
};
app.get('/openapi.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/openapi+json');
  res.json({
    openapi: '3.0.3',
    info: { title: 'IOST Terminal API', version: DISCOVERY_VERSION, description: 'AI real-time trading platform — market data, AI trade scores, risk analysis, paper execution, agent signal publishing. Read endpoints are public; execution/agent endpoints require an agent key (X-API-Key) or OAuth 2.0 bearer token. Not financial advice.' },
    servers: [{ url: SITE_URL }],
    tags: [
      { name: 'meta' }, { name: 'market' }, { name: 'intelligence' }, { name: 'risk' },
      { name: 'social' }, { name: 'analysis' }, { name: 'agents' }, { name: 'autonomy' },
      { name: 'execution' }, { name: 'auth' },
    ],
    paths: OPENAPI_PATHS,
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Agent key minted in Portfolio → AI Agents (itk_…). Scopes: read / trade-paper / trade-live.' },
        BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque', description: 'OAuth 2.0 access token from POST /oauth/token (client_credentials).' },
      },
    },
    security: [{ ApiKey: [] }, { BearerAuth: [] }],
  });
});

// ---- OAuth 2.0 authorization-server metadata (RFC 8414) ----
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  res.json({
    issuer: SITE_URL,
    token_endpoint: `${SITE_URL}/oauth/token`,
    revocation_endpoint: `${SITE_URL}/oauth/revoke`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: ['read', 'trade-paper', 'trade-live'],
    response_types_supported: [],
    code_challenge_methods_supported: [],
    service_documentation: `${SITE_URL}/auth.md`,
  });
});
// ---- OAuth protected-resource metadata (RFC 9728) ----
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  res.json({
    resource: `${SITE_URL}/api/`,
    authorization_servers: [SITE_URL],
    scopes_supported: ['read', 'trade-paper', 'trade-live'],
    bearer_methods_supported: ['header'],
  });
});

// ---- real OAuth 2.0 client_credentials grant (no fake metadata) ----
// client_id = agent-key id (public), client_secret = the full itk_ secret.
// Tokens are opaque, in-memory, 24h TTL; revoke via /oauth/revoke.
const oauthLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'too many token requests — slow down' } });
const oauthForm = express.urlencoded({ extended: false });
app.post('/oauth/token', oauthLimiter, oauthForm, (req, res) => {
  const grant = String(req.body.grant_type || '');
  if (grant !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'only client_credentials is supported' });
  }
  const clientId = String(req.body.client_id || '');
  const clientSecret = String(req.body.client_secret || '');
  const authz = req.get('authorization') || '';
  let id = clientId, secret = clientSecret;
  if (/^Basic\s+/i.test(authz)) {
    try {
      const decoded = Buffer.from(authz.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) { id = decoded.slice(0, i); secret = decoded.slice(i + 1); }
    } catch { /* fall through to body */ }
  }
  const principal = agentKeys.verifySecret(id, secret);
  if (!principal) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'unknown client_id or bad client_secret' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 24 * 3600 * 1000;
  oauthTokens.set(token, { ...principal, expiresAt });
  res.set('Cache-Control', 'no-store');
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400, scope: principal.scopes.join(' ') });
});
app.post('/oauth/revoke', oauthForm, (req, res) => {
  const tok = String(req.body.token || '');
  if (tok && oauthTokens.delete(tok)) res.json({ ok: true });
  else res.status(200).json({ ok: false, error: 'token not found or already revoked' });
});

// ---- Auth.md — honest agent registration guide (workos.com/auth.md style) ----
const AUTH_MD = `# Auth.md — how AI agents authenticate to IOST Terminal

IOST Terminal is an AI real-time trading platform (crypto + equities, paper-first).
Agents can read public market data with **no auth**, and act on an account with a
**scoped agent API key** — or an OAuth 2.0 bearer token derived from one.

## Public (no auth) — read-only
\`/api/ui-state\` · \`/api/scores\` · \`/api/scanner\` · \`/api/analyze/:symbol\` · \`/api/news\` ·
\`/api/onchain\` · \`/api/probability\` · \`/api/leaderboard\` · \`/api/backtest\` ·
\`/api/signals/feed\` · \`/api/token-audit\` · \`/api/smart-money\` — all public, no keys.

## Agent API keys (recommended)
1. Human signs in at https://iostcallister.com/app → **Portfolio → AI Agents → Create key**.
2. Key looks like \`itk_…\`; the full secret is shown **exactly once** (like a wallet seed).
3. Scopes: \`read\` (always) · \`trade-paper\` (open/close paper trades) · \`trade-live\` (owner-only, requests only).
4. Send it: \`X-API-Key: itk_…\` on every request. Revocable instantly in the UI.

## OAuth 2.0 (client_credentials)
Discovery: \`/.well-known/oauth-authorization-server\` (RFC 8414) · \`/.well-known/oauth-protected-resource\` (RFC 9728).
- \`client_id\` = the key's id (shown in the app), \`client_secret\` = the full \`itk_…\` secret.
- \`POST /oauth/token\` with \`grant_type=client_credentials\` (form body or HTTP Basic) → \`access_token\` (Bearer, 24h, opaque, in-memory).
- Use \`Authorization: Bearer <token>\` — resolves to the same identity + scopes as the key.
- Revoke: \`POST /oauth/revoke\` with \`{token}\`.

## Live trading — human-in-the-loop
Agents never execute live trades directly. With a \`trade-live\` key an agent submits a
**proposal** (\`POST /api/live/proposals\`); the owner approves or rejects it
(\`POST /api/live/proposals/:id/approve|reject\`) before anything reaches the venue.
No CAPTCHAs, no barriers — keys and rails instead.

## Fail-closed
There are no default/shared platform keys. Unset credentials = no agent identity.
`;
app.get('/auth.md', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('text/markdown; charset=utf-8');
  res.send(AUTH_MD);
});

// ---- MCP server card (SEP-1649 draft) + real streamable-HTTP MCP endpoint ----
const MCP_VERSION = '2025-06-18';
const MCP_TOOLS = [
  { name: 'market_snapshot', description: 'Live platform snapshot: top AI trade scores, market mood, IOST mainnet state, autopilot status (from the 30s server cache — no per-call scans).', inputSchema: { type: 'object', properties: {} } },
  { name: 'asset_scores', description: '0-100 AI trade scores for every watchlist asset (composite + momentum/volume/news/risk subscores).', inputSchema: { type: 'object', properties: {} } },
  { name: 'analyze_symbol', description: 'Full AI analysis for one symbol: score, subscores, indicators, signals, price.', inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'e.g. IOST, BTC, ETH, SOL, AAPL, NVDA' } }, required: ['symbol'] } },
  { name: 'news_sentiment', description: 'Latest headlines + bullish/bearish/neutral classification.', inputSchema: { type: 'object', properties: {} } },
  { name: 'chain_status', description: 'IOST mainnet dashboard: TPS, head block, peers, large transfers.', inputSchema: { type: 'object', properties: {} } },
  { name: 'proposals', description: 'Pending autopilot proposals (candidate trades queued for human approval) with full reasoning.', inputSchema: { type: 'object', properties: {} } },
  { name: 'platform_help', description: 'What IOST Terminal is and how to connect: endpoints, auth, skills index, MCP card, ARD manifest.', inputSchema: { type: 'object', properties: {} } },
  { name: 'health', description: 'Liveness + version.', inputSchema: { type: 'object', properties: {} } },
];
async function mcpToolCall(name, args) {
  switch (name) {
    case 'market_snapshot': {
      const s = ssrState;
      const m = s?.market;
      const c = s?.onchain?.chain;
      return {
        ts: s?.ts || null,
        marketMood: m ? (m.bullish > m.bearish ? 'bullish' : m.bearish > m.bullish ? 'bearish' : 'mixed') : null,
        headlines: m ? { bullish: m.bullish, neutral: m.neutral, bearish: m.bearish } : null,
        onchain: c ? { tps: c.tps, headBlock: c.headBlock, peers: c.peerCount } : null,
        autopilot: s?.autopilot ? { enabled: s.autopilot.enabled, requireApproval: !!s.autopilot.config?.requireApproval } : null,
        topScores: (s?.scores || []).slice(0, 10).map((x) => ({ symbol: x.symbol, score: x.composite, grade: x.grade, change24hPct: x.change24hPct })),
      };
    }
    case 'asset_scores': return (ssrState?.scores || []).map((x) => ({ symbol: x.symbol, score: x.composite, grade: x.grade, subscores: x.subscores }));
    case 'analyze_symbol': {
      const sym = String(args?.symbol || '').toUpperCase().trim();
      if (!sym) throw new Error('missing required argument: symbol');
      return await analyzeSymbol(sym);
    }
    case 'news_sentiment': return await getNews();
    case 'chain_status': return await getChainSnapshot();
    case 'proposals': return getProposals().slice(0, 10);
    case 'platform_help': return {
      name: 'IOST Terminal', version: DISCOVERY_VERSION,
      api: `${SITE_URL}/api`, openapi: `${SITE_URL}/openapi.json`, llms: `${SITE_URL}/llms.txt`,
      auth: `${SITE_URL}/auth.md`, ard: `${SITE_URL}/.well-known/ai-catalog.json`,
      skills: `${SITE_URL}/.well-known/agent-skills/index.json`, mcpCard: `${SITE_URL}/.well-known/mcp/server-card.json`,
      note: 'Read-only MCP tools. Execution stays on the REST API with scoped agent keys + owner-approved live proposals.',
    };
    case 'health': return { ok: true, version: DISCOVERY_VERSION, ts: Date.now() };
    default: throw new Error(`unknown tool: ${name}`);
  }
}
app.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  res.json({
    serverInfo: { name: 'iost-terminal', version: DISCOVERY_VERSION },
    protocolVersion: MCP_VERSION,
    transport: { type: 'streamable-http', endpoint: `${SITE_URL}/mcp` },
    capabilities: { tools: { listChanged: false } },
  });
});
app.post('/mcp', express.json({ limit: '128kb' }), async (req, res) => {
  const msg = req.body;
  const reply = (payload, httpStatus = 200) => res.status(httpStatus).json(payload);
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return reply({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }, 400);
  }
  const id = msg.id ?? null;
  if (msg.method === 'initialize') {
    return reply({ jsonrpc: '2.0', id, result: { protocolVersion: MCP_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'iost-terminal', version: DISCOVERY_VERSION } } });
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
    return res.status(202).end(); // JSON-RPC notification — no body
  }
  if (msg.method === 'tools/list') {
    return reply({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
  }
  if (msg.method === 'tools/call') {
    const name = String(msg.params?.name || '');
    const args = msg.params?.arguments ?? {};
    try {
      const data = await mcpToolCall(name, args);
      return reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false } });
    } catch (e) {
      return reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } });
    }
  }
  if (msg.method === 'ping') {
    return reply({ jsonrpc: '2.0', id, result: {} });
  }
  return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
});

// ---- ARD manifest (Agentic Resource Discovery) — /.well-known/ai-catalog.json ----
app.get('/.well-known/ai-catalog.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  res.json({
    specVersion: '1.0.0',
    host: { name: 'IOST Terminal', url: SITE_URL },
    entries: [
      {
        urn: 'urn:air:iostcallister.com:api:rest',
        displayName: 'IOST Terminal REST API',
        type: 'application/openapi+json',
        url: `${SITE_URL}/openapi.json`,
        representativeQueries: ['market prices and AI trade scores', 'what API endpoints does the trading platform expose', 'autopilot proposals'],
      },
      {
        urn: 'urn:air:iostcallister.com:mcp:terminal',
        displayName: 'IOST Terminal MCP server (read-only tools)',
        type: 'application/vnd.mcp+json',
        url: `${SITE_URL}/.well-known/mcp/server-card.json`,
        representativeQueries: ['what tools does the IOST Terminal expose over MCP', 'get market snapshot', 'analyze a symbol'],
      },
      {
        urn: 'urn:air:iostcallister.com:docs:llms',
        displayName: 'LLM-friendly index',
        type: 'text/markdown',
        url: `${SITE_URL}/llms.txt`,
        representativeQueries: ['what is IOST Terminal and how do I use it', 'platform overview for agents'],
      },
      {
        urn: 'urn:air:iostcallister.com:auth:guide',
        displayName: 'Agent authentication guide',
        type: 'text/markdown',
        url: `${SITE_URL}/auth.md`,
        representativeQueries: ['how does an agent authenticate', 'API keys and OAuth scopes'],
      },
      {
        urn: 'urn:air:iostcallister.com:skills:index',
        displayName: 'Agent skills index',
        type: 'application/json',
        url: `${SITE_URL}/.well-known/agent-skills/index.json`,
        representativeQueries: ['skills for reading IOST Terminal data', 'agent skills available'],
      },
      {
        urn: 'urn:air:iostcallister.com:manifest:agent',
        displayName: 'Agent discovery manifest',
        type: 'application/json',
        url: `${SITE_URL}/.well-known/agent.json`,
        representativeQueries: ['agent manifest for iostcallister.com'],
      },
    ],
  });
});

// ---- Agent Skills Discovery index (RFC v0.2.0) — hashes computed at serve time ----
const AGENT_SKILLS_DIR = join(ROOT, 'public', '.well-known', 'agent-skills');
const AGENT_SKILLS = [
  { name: 'iost-terminal-market-data', type: 'skill', description: 'How an agent reads IOST Terminal market data: endpoints, the agent-state JSON blob, JSON-LD, markdown negotiation and the LLM index.', file: 'iost-terminal-market-data/SKILL.md' },
  { name: 'iost-terminal-agent-auth', type: 'skill', description: 'How an agent authenticates to IOST Terminal: API keys (X-API-Key), OAuth 2.0 client_credentials, scopes, and the human-in-the-loop live-trade proposal rail.', file: 'iost-terminal-agent-auth/SKILL.md' },
];
// Serve the SKILL.md bodies (express.static ignores dot-directories by default,
// so these need explicit routes).
for (const sk of AGENT_SKILLS) {
  app.get(`/.well-known/agent-skills/${sk.file}`, (req, res) => {
    try {
      res.type('text/markdown; charset=utf-8');
      res.send(readFileSync(join(AGENT_SKILLS_DIR, sk.file), 'utf8'));
    } catch {
      res.status(404).json({ error: 'skill not found' });
    }
  });
}
app.get('/.well-known/agent-skills/index.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  const skills = AGENT_SKILLS.map((sk) => {
    let sha256 = '';
    try { sha256 = crypto.createHash('sha256').update(readFileSync(join(AGENT_SKILLS_DIR, sk.file), 'utf8')).digest('hex'); } catch { /* keep empty */ }
    return { name: sk.name, type: sk.type, description: sk.description, url: `${SITE_URL}/.well-known/agent-skills/${sk.file}`, sha256 };
  });
  res.json({ $schema: 'https://agentskills.io/schema/skills-index.schema.json', skills });
});
// legacy path alias (v0.1.0)
app.get('/.well-known/skills/index.json', (req, res) => res.redirect(301, '/.well-known/agent-skills/index.json'));

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

app.get('/api/scanner', publicLimiter, async (req, res) => {
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
app.get('/api/market/global', publicLimiter, async (req, res) => {
  try { res.json({ ok: true, ...(await getGlobalMetrics()) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/market/movers', publicLimiter, async (req, res) => {
  try { res.json({ ok: true, ...(await getTopMovers()) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/analyze/:symbol', publicLimiter, async (req, res) => {
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

app.get('/api/scores', publicLimiter, async (req, res) => {
  try { res.json(await allScores()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/klines/:symbol', publicLimiter, async (req, res) => {
  try {
    const bar = /^(1m|5m|15m|1h|4h|1d)$/.test(req.query.bar || '') ? req.query.bar : '15m';
    res.json(await getKlines(req.params.symbol.toUpperCase(), bar, Math.min(+req.query.limit || 300, 300)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- probabilistic clarity layer (v1.4) ----------
app.get('/api/probability', publicLimiter, (req, res) => {
  if (!ssrState) return res.json([]);
  res.json(ssrState.scores.map((x) => probFor(x.symbol)).filter(Boolean));
});
app.get('/api/probability/:symbol/history', publicLimiter, (req, res) => {
  res.json({ symbol: req.params.symbol.toUpperCase(), samples: getProbHistory(req.params.symbol.toUpperCase()) });
});
app.get('/api/orderbook/:symbol', publicLimiter, async (req, res) => {
  const b = await getOrderBook(req.params.symbol.toUpperCase()).catch(() => null);
  if (!b) return res.status(404).json({ error: 'no order book for this symbol (crypto only, OKX)' });
  res.json(b);
});
app.get('/api/contracts/:symbol', publicLimiter, async (req, res) => {
  const c = await getContractSpec(req.params.symbol.toUpperCase()).catch(() => null);
  if (!c) return res.status(404).json({ error: 'no contract spec for this symbol (crypto only, OKX)' });
  res.json(c);
});

app.get('/api/score/:symbol', publicLimiter, async (req, res) => {
  try {
    const a = await analyzeSymbol(req.params.symbol.toUpperCase(), { force: true });
    res.json(computeScores(a, getAssetSentiment(a.symbol)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/news', publicLimiter, async (req, res) => {
  try { res.json(await getNews(!!req.query.force)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/onchain', publicLimiter, async (req, res) => {
  try { res.json(await getChainSnapshot(!!req.query.force)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/risk', publicLimiter, (req, res) => {
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
  // Phase 2 opt-in rails: enforce agent wallet spend limits when configured
  const entry = Number(req.body?.entry || 0);
  const size = Number(req.body?.size || 0);
  const notionalMinor = entry > 0 && size > 0 ? Math.trunc(entry * size * 100) : 0;
  const gate = agentSpendGate(req, notionalMinor);
  if (!gate.ok) return res.status(402).json({ error: gate.message, reason: gate.reason });
  req.agentReserveId = gate.reserveId;
  try {
    const r = await getBroker('paper').placeOrder({ ...(req.body || {}), accountId: accountFor(req).accountId });
    if (req.agentReserveId) {
      if (r.ok) limits.commitReserve({ walletId: gate.walletId, reserveId: req.agentReserveId });
      else limits.releaseReserve({ walletId: gate.walletId, reserveId: req.agentReserveId });
    }
    res.json(r);
  } catch (e) {
    if (req.agentReserveId) limits.releaseReserve({ walletId: gate.walletId, reserveId: req.agentReserveId });
    res.status(502).json({ error: e.message });
  }
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
  const raw = req.body?.accountSize;
  const size = raw == null || raw === '' ? 100000 : Math.trunc(Number(raw));
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'account size must be a positive number' });
  if (size > 1_000_000_000) return res.status(400).json({ error: 'account size too large (max 1,000,000,000)' });
  res.json(setAccountSize(size, accountFor(req).accountId));
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
  const agents = signals.listAgents().map((a) => ({ ...a, name: looksLikeEmail(a.name) ? maskEmail(a.name) : a.name }));
  res.json({ ok: true, count: agents.length, agents, stats: signals.agentStats() });
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
// No token is issued. Points are accrual-only; 1:1 AITT conversion is PLANNED
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
    conversion: {
      rate: '1:1', token: 'AITT', spendable: false,
      status: aitt.getInfo().conversion.statusText,
      open: aitt.getInfo().conversion.open,
    },
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
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  res.json({ ok: true, ...points.runWeeklyBounty() });
});

// ================= AITT token (Phase 1: design → deployed on IOST L2) =================
// Public metadata + points→AITT conversion gate. Honest by design: the gate is
// CLOSED until the ERC-20 is deployed, the converter funded, and TGE gates pass.
// No token has been created, minted, or sold (TOKENOMICS.md §10).

// GET /api/aitt/info — public token info (identity, chain, status, gate state)
app.get('/api/aitt/info', (req, res) => {
  res.json(aitt.getInfo());
});

// POST /api/points/claim — attempt points→AITT conversion (1:1) for the current
// principal. While the gate is closed it answers honestly and writes NOTHING.
app.post('/api/points/claim', requireUser, (req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ error: 'auth required' });
  const r = aitt.claim({ ownerId: ident.agentId });
  res.status(r.ok ? 200 : 400).json(r);
});

// ================= Phase 2 — agent wallet engine (off-chain first) =================
// Design: docs/PHASE2_SPEC.md. Works before the token deploys; on-chain escrow in
// Phase 3. Permissive default: no wallet ⇒ no enforcement (existing flows unchanged).
// All money in INTEGER MINOR UNITS (cents) unless stated.

const h = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } };

// POST /api/wallets — create an agent wallet (child of the caller's user wallet)
app.post('/api/wallets', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ error: 'auth required' });
  const { name, limits: lim, capabilities, regions, approvalRequired } = req.body || {};
  const w = wallets.createAgentWallet({
    ownerId: ident.agentId, name, limits: lim, capabilities, regions, approvalRequired,
  });
  res.json({ ok: true, wallet: { walletId: w.walletId, kind: w.kind, name: w.name, limits: w.limits, capabilities: w.capabilities, regions: w.regions, approvalRequired: w.approvalRequired, status: w.status, balanceMinor: w.balances.USD } });
}));

// GET /api/wallets — wallet tree (parent + agent children) with balances
app.get('/api/wallets', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ error: 'auth required' });
  const tree = wallets.walletTree(ident.agentId);
  const parent = tree.parent ? { walletId: tree.parent.walletId, balanceMinor: tree.parent.balances?.USD || 0, status: tree.parent.status } : null;
  res.json({ ok: true, parent, agents: tree.agents.map((w) => ({ ...w, balanceMinor: wallets.balanceOf(w.walletId) })), stats: wallets.stats() });
}));

// PATCH /api/wallets/:id/policies — update limits/capabilities/regions/approvalRequired
app.patch('/api/wallets/:id/policies', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  const w = wallets.getWallet(req.params.id);
  if (!w) return res.status(404).json({ ok: false, error: 'wallet not found' });
  if (w.ownerId !== ident.agentId && !isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'not your wallet' });
  const updated = wallets.updatePolicies(w.walletId, req.body || {});
  res.json({ ok: true, wallet: { walletId: updated.walletId, limits: updated.limits, capabilities: updated.capabilities, regions: updated.regions, approvalRequired: updated.approvalRequired } });
}));

// POST /api/wallets/:id/fund — fund agent wallet from parent (internal, no fees)
app.post('/api/wallets/:id/fund', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  const w = wallets.getWallet(req.params.id);
  if (!w) return res.status(404).json({ ok: false, error: 'wallet not found' });
  if (w.ownerId !== ident.agentId && !isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'not your wallet' });
  const r = wallets.fundAgentWallet({ walletId: w.walletId, amountMinor: req.body?.amountMinor });
  res.json({ ok: true, ...r });
}));

// POST /api/wallets/:id/credit — credit the USER wallet (platform onboarding funds; owner only)
app.post('/api/wallets/credit', requireUser, h((req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'owner only' });
  const ident = signalIdentity(req);
  const bal = wallets.creditUserWallet(ident.agentId, req.body?.amountMinor || 0);
  res.json({ ok: true, balanceMinor: bal });
}));

// POST /api/wallets/:id/suspend | /reactivate
app.post('/api/wallets/:id/suspend', requireUser, h((req, res) => {
  const w = wallets.getWallet(req.params.id);
  if (!w) return res.status(404).json({ ok: false, error: 'wallet not found' });
  if (!isOwnerSession(req) && w.ownerId !== signalIdentity(req)?.agentId) return res.status(403).json({ ok: false, error: 'not your wallet' });
  res.json({ ok: true, wallet: wallets.setWalletStatus(w.walletId, 'suspended') });
}));
app.post('/api/wallets/:id/reactivate', requireUser, h((req, res) => {
  const w = wallets.getWallet(req.params.id);
  if (!w) return res.status(404).json({ ok: false, error: 'wallet not found' });
  if (!isOwnerSession(req) && w.ownerId !== signalIdentity(req)?.agentId) return res.status(403).json({ ok: false, error: 'not your wallet' });
  res.json({ ok: true, wallet: wallets.setWalletStatus(w.walletId, 'active') });
}));

// GET /api/wallets/:id/usage — limits usage snapshot (daily/weekly windows)
app.get('/api/wallets/:id/usage', requireUser, h((req, res) => {
  const gate = walletOwnedBy(req, req.params.id);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  const w = wallets.getWallet(req.params.id);
  if (!w) return res.status(404).json({ ok: false, error: 'wallet not found' });
  res.json({ ok: true, walletId: w.walletId, usage: limits.usageSnapshot(w.walletId), limits: w.limits?.USD || {} });
}));

// POST /api/stake — create a stake {amountMinor (8-dec AITT units), lockDays}
app.post('/api/stake', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ ok: false, error: 'auth required' });
  const s = stakes.createStake({ ownerId: ident.agentId, amountMinor: req.body?.amountMinor, lockDays: req.body?.lockDays });
  res.json({ ok: true, stake: s });
}));
// POST /api/stake/unstake {stakeId} — start 7-day cooldown
app.post('/api/stake/unstake', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  const s = stakes.requestUnstake(req.body?.stakeId);
  if (s.ownerId !== ident.agentId) return res.status(403).json({ ok: false, error: 'not your stake' });
  res.json({ ok: true, stake: s });
}));
// POST /api/stake/withdraw {stakeId} — after cooldown
app.post('/api/stake/withdraw', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  const s = stakes.withdraw(req.body?.stakeId);
  if (s.ownerId !== ident.agentId) return res.status(403).json({ ok: false, error: 'not your stake' });
  res.json({ ok: true, stake: s });
}));

// GET /api/trust/score — derived Trust Score + credit line (owner)
app.get('/api/trust/score', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ ok: false, error: 'auth required' });
  res.json({ ok: true, ...trust.computeTrust(ident.agentId) });
}));

// POST /api/slashes — owner/admin creates a slash (unauthorized-spend | failed-settlement)
app.post('/api/slashes', requireUser, h((req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'owner only' });
  const r = slashes.createSlash({ ownerId: req.body?.ownerId, reason: req.body?.reason, evidence: req.body?.evidence || {} });
  res.json({ ok: true, slash: r });
}));
// POST /api/slashes/:id/appeal {statement}
app.post('/api/slashes/:id/appeal', requireUser, h((req, res) => {
  const s = slashes.fileAppeal(req.params.id, req.body?.statement);
  res.json({ ok: true, slash: s });
}));
// POST /api/slashes/:id/decide {decision: accepted|rejected} — owner only
app.post('/api/slashes/:id/decide', requireUser, h((req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'owner only' });
  const r = slashes.decideAppeal({ slashId: req.params.id, decision: req.body?.decision, by: signalIdentity(req)?.agentId });
  res.json({ ok: true, slash: r });
}));
// GET /api/slashes — my slash history
app.get('/api/slashes', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  res.json({ ok: true, slashes: slashes.slashHistory(ident.agentId) });
}));

// POST /api/pacts — propose a pact (agent or owner)
app.post('/api/pacts', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ ok: false, error: 'auth required' });
  const p = pacts.proposePact({
    ownerId: ident.agentId, agentWalletId: req.body?.agentWalletId, intent: req.body?.intent,
    plan: req.body?.plan, policies: req.body?.policies, completion: req.body?.completion,
  });
  res.json({ ok: true, pact: p });
}));
// POST /api/pacts/:id/approve | /reject | /terminate — human control (owner)
app.post('/api/pacts/:id/approve', requireUser, h((req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'owner only' });
  res.json({ ok: true, pact: pacts.approvePact(req.params.id, 'owner') });
}));
app.post('/api/pacts/:id/reject', requireUser, h((req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'owner only' });
  res.json({ ok: true, pact: pacts.rejectPact(req.params.id, 'owner') });
}));
app.post('/api/pacts/:id/terminate', requireUser, h((req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'owner only' });
  res.json({ ok: true, pact: pacts.terminatePact(req.params.id, 'owner') });
}));
// GET /api/pacts — my pacts
app.get('/api/pacts', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  res.json({ ok: true, pacts: pacts.listPacts(ident.agentId) });
}));

// POST /api/freeze {on:true, reason?} | {on:false} — emergency freeze (owner)
app.post('/api/freeze', requireUser, h((req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ ok: false, error: 'owner only' });
  const on = !!req.body?.on;
  const state = freeze.setFrozen(on, { reason: req.body?.reason, by: 'owner' });
  res.json({ ok: true, ...state });
}));
// GET /api/freeze — freeze state (public)
app.get('/api/freeze', (req, res) => res.json({ ok: true, ...freeze.freezeState() }));

// ---- spend enforcement boundary (rails): check → reserve → act → commit/release ----
// Agents call these; the engine (not agent code) enforces limits atomically.
app.post('/api/spend/check', requireUser, h((req, res) => {
  const { walletId, amountMinor, purpose } = req.body || {};
  const gate = walletOwnedBy(req, walletId);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  res.json(limits.checkSpend({ walletId, amountMinor, purpose }));
}));
app.post('/api/spend/reserve', requireUser, h((req, res) => {
  const { walletId, amountMinor, purpose } = req.body || {};
  const gate = walletOwnedBy(req, walletId);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  res.json(limits.reserveSpend({ walletId, amountMinor, purpose }));
}));
app.post('/api/spend/commit', requireUser, h((req, res) => {
  const { walletId, reserveId, pactId } = req.body || {};
  const gate = walletOwnedBy(req, walletId);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  // commitReserve returns the settled amount; captured BEFORE the reserve record is cleared
  const r = limits.commitReserve({ walletId, reserveId });
  if (r.ok) {
    // debit the wallet ledger; record against a pact when provided
    const debit = wallets.debitWallet(walletId, r.amount);
    if (pactId) {
      try { pacts.recordPactSpend(pactId, r.amount); } catch { /* pact gone — audit still holds */ }
    }
    res.json({ ok: true, debit });
  } else {
    res.status(400).json(r);
  }
}));
app.post('/api/spend/release', requireUser, h((req, res) => {
  const { walletId, reserveId } = req.body || {};
  const gate = walletOwnedBy(req, walletId);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  res.json(limits.releaseReserve({ walletId, reserveId }));
}));
// ownership gate for wallet-scoped routes (mirrors /api/wallets/:id/* checks)
function walletOwnedBy(req, walletId) {
  const w = wallets.getWallet(walletId);
  if (!w) return { status: 404, error: 'wallet not found' };
  const ident = signalIdentity(req);
  if (!ident) return { status: 401, error: 'auth required' };
  if (w.ownerId !== ident.agentId && !isOwnerSession(req)) return { status: 403, error: 'not your wallet' };
  return null;
}

// Opt-in execution-rail hook (AGENT_SPEND_ENFORCE=1): for agent-key callers WITH an
// agent wallet, check+reserve notional spend before the order lands. No wallet or
// env off ⇒ permissive (existing behavior unchanged). Notional only when entry
// price is known — otherwise the caller uses /api/spend/* explicitly.
const AGENT_SPEND_ENFORCE = process.env.AGENT_SPEND_ENFORCE === '1';
function agentSpendGate(req, notionalMinor) {
  if (!AGENT_SPEND_ENFORCE || !notionalMinor || notionalMinor <= 0) return { ok: true };
  if (!req.agentKey) return { ok: true }; // human session = the approver
  const ident = signalIdentity(req);
  const w = ident && wallets.findWallet(ident.agentId, 'agent');
  if (!w) return { ok: true }; // no wallet ⇒ permissive default
  const r = limits.reserveSpend({ walletId: w.walletId, amountMinor: notionalMinor, purpose: req.path });
  return r.ok ? { ok: true, reserveId: r.reserveId, walletId: w.walletId } : r;
}

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

app.post('/api/assistant', publicLimiter, async (req, res) => {
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

// mask an email for public display (t***@domain) — never leak the full address
const maskEmail = (email) => {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 1) return '***';
  return `${s.slice(0, 1)}***${s.slice(at)}`;
};
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

// Decentralized agents identity: session user → 'user:<id>' (human),
// user agent key → 'agent:key:<keyId>' (customer's AI agent),
// platform X-API-Key → 'agent:<hash>' (platform AI agent; raw key never exposed). Stable per principal.
function signalIdentity(req) {
  if (req.session?.userId) {
    const u = auth.findById(req.session.userId);
    if (u) return { agentId: `user:${u.id}`, name: maskEmail(u.email), kind: 'human' };
  }
  if (req.userAgent) return { agentId: `agent:key:${req.userAgent.keyId}`, name: req.userAgent.name, kind: 'ai' };
  if (req.agentKey) {
    // NEVER put the raw platform key in the public identity — it is served by
    // /api/agents and every signal feed row. Hash it instead.
    const h = crypto.createHash('sha256').update(req.agentKey).digest('hex');
    return { agentId: `agent:${h.slice(0, 16)}`, name: `agent-${h.slice(0, 8)}`, kind: 'ai' };
  }
  return null;
}

// /api/auth/* — rate-limited (~10/min/IP), session management, 2FA, password reset
app.use('/api/auth', authLimiter, authRouter(SITE_URL));

const API_INDEX = {
  name: 'IOST Terminal Agent API',
  version: '1.15.0',
  auth: 'X-API-Key header. Two key types: (1) platform keys via AGENT_KEYS env (required — no default, fail closed) → shared "default" account; (2) per-user "connect your AI agent" keys (itk_…, created in-app at /api/agent-keys) → bound to ONE user account with scopes: read / trade-paper / trade-live. Sensitive routes also accept a browser session (/api/auth/*).',
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
  binanceData: [
    { path: '/api/token-audit', method: 'POST', body: '{contractAddress, chainId?:56|8453|CT_501|1}', purpose: 'PUBLIC Binance Web3 token security audit (honeypot/rug-pull/scam/tax scan). No keys. Proxy of web3.binance.com — result normalized: riskLevel 1-5, taxes, verified flag, risk-item checks. NOT investment advice.' },
    { path: '/api/smart-money', method: 'GET', query: 'chainId=56|CT_501&page=1&pageSize=20', purpose: 'PUBLIC Binance Web3 smart-money on-chain signals (BSC/Solana): buy/sell events from tracked whale wallets, trigger vs current price, max gain, exit rate, tags. 30s server cache. NOT investment advice.' },
  ],
  points: 'Off-chain points ledger (tokenomics vision §6): no token issued. signal +10 · follower +5 · referral +50/+10 · feedback +5 (author) · weekly top paper trader +500. 1:1 AITT conversion planned at TGE (not guaranteed — conversion gate closed until deploy + TGE gates). Ledger data/points.json (atomic writes).',
  aitt: 'AITT — Agent Intelligence Trading Token (design draft, NOT issued): ERC-20 on IOST L2 (chain 182), 1B fixed supply, 8 decimals. Points→AITT 1:1 conversion planned at TGE (gate closed). Public info: /api/aitt/info · page /aitt · whitepaper /whitepaper. Config data/aitt-config.json.',
  agentWallet: 'Phase 2 agent wallet engine (off-chain first): parent-child wallets with spend limits (per-tx/daily/weekly, integer minor units), trust staking + slashing + appeals, derived Trust Score + credit line, task-scoped Pacts with auto-expiry, emergency freeze. Design: docs/PHASE2_SPEC.md. Permissive default — no wallet ⇒ no enforcement. Capabilities: finance.* / wallet.* / trade.* / mandate.sign.',
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
    { path: '/api/points/claim', method: 'POST', purpose: 'attempt points→AITT conversion (1:1, planned at TGE — not guaranteed). Gate closed until deploy + TGE gates: answers honestly, writes nothing' },
  ],
  aitt: [
    { path: '/api/aitt/info', method: 'GET', purpose: 'public AITT token info: identity, supply, chain, contract/converter addresses, conversion gate state, honesty notice' },
    { path: '/aitt', method: 'GET', purpose: 'public AITT token page (SSR — CMC-ready, no JS required)' },
    { path: '/token', method: 'GET', purpose: 'alias of /aitt' },
    { path: '/whitepaper', method: 'GET', purpose: 'AITT whitepaper v1.0 (markdown — identical to docs/TOKENOMICS.md)' },
  ],
  agentWallet: [
    { path: '/api/wallets', method: 'GET', purpose: 'my wallet tree: parent (user) wallet + agent child wallets with balances, limits, capabilities, status' },
    { path: '/api/wallets', method: 'POST', body: '{name, limits:{USD:{maxPerTxMinor,dailyCapMinor,weeklyCapMinor}}, capabilities[], regions[], approvalRequired}', purpose: 'create an agent wallet as a child of my wallet (limits enforced server-side; 0 = unlimited)' },
    { path: '/api/wallets/:id/policies', method: 'PATCH', body: '{limits?, capabilities?, regions?, approvalRequired?}', purpose: 'update wallet limits/capabilities/regions (owner)' },
    { path: '/api/wallets/:id/fund', method: 'POST', body: '{amountMinor}', purpose: 'fund agent wallet from parent wallet (internal transfer, no fees)' },
    { path: '/api/wallets/credit', method: 'POST', body: '{amountMinor}', purpose: 'owner only — credit the user wallet (onboarding funds)' },
    { path: '/api/wallets/:id/suspend | /reactivate', method: 'POST', purpose: 'suspend/reactivate an agent wallet' },
    { path: '/api/wallets/:id/usage', method: 'GET', purpose: 'daily/weekly spend usage snapshot vs limits' },
    { path: '/api/spend/check|reserve|commit|release', method: 'POST', purpose: 'rails enforcement: check → reserve (atomic) → act → commit or release. Limits never enforced by agent code' },
    { path: '/api/stake', method: 'POST', body: '{amountMinor (8-dec AITT), lockDays 7|30|90|365}', purpose: 'create trust stake (min 1,000 AITT)' },
    { path: '/api/stake/unstake | /withdraw', method: 'POST', body: '{stakeId}', purpose: 'start 7-day cooldown / withdraw after cooldown' },
    { path: '/api/trust/score', method: 'GET', purpose: 'derived Trust Score + credit line + components (never stored)' },
    { path: '/api/slashes', method: 'POST', body: '{ownerId, reason: unauthorized-spend|failed-settlement}', purpose: 'owner only — slash (unauthorized −10% + score reset · failed settlement −5%)' },
    { path: '/api/slashes/:id/appeal | /decide', method: 'POST', purpose: '14-day appeal window; decide = owner/DAO review' },
    { path: '/api/pacts', method: 'GET|POST', purpose: 'task-scoped Pacts: intent + plan + policies + completion (time/budget/goal) with auto-expiry' },
    { path: '/api/pacts/:id/approve | /reject | /terminate', method: 'POST', purpose: 'human control over pacts (owner)' },
    { path: '/api/freeze', method: 'POST', body: '{on:true, reason?} | {on:false}', purpose: 'owner only — emergency freeze: stops ALL agent operations instantly' },
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
  res.set('Access-Control-Allow-Origin', '*');
  res.json({
    name: 'IOST Terminal', version: DISCOVERY_VERSION, machineReadable: true,
    api: '/api', index: '/api', meta: '/api/meta', uiState: '/api/ui-state',
    openapi: '/openapi.json', apiCatalog: '/.well-known/api-catalog',
    ard: '/.well-known/ai-catalog.json', auth: '/api/auth', authMd: '/auth.md',
    oauth: { authorizationServer: '/.well-known/oauth-authorization-server', tokenEndpoint: '/oauth/token', protectedResource: '/.well-known/oauth-protected-resource', grantTypes: ['client_credentials'] },
    mcp: { card: '/.well-known/mcp/server-card.json', endpoint: '/mcp', tools: ['market_snapshot', 'asset_scores', 'analyze_symbol', 'news_sentiment', 'chain_status', 'proposals', 'platform_help', 'health'] },
    skills: '/.well-known/agent-skills/index.json', llms: '/llms.txt',
    points: '/api/points', aitt: '/api/aitt/info', agentWallet: '/api/wallets', wallet: '/api/account/iost',
    contracts: API_INDEX,
  });
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
const autopilotOwner = (req, res, next) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  next();
};
app.post('/api/autopilot/start', requireUser, autopilotOwner, (req, res) => { startAutopilot(req.body?.config || null); res.json(getAutopilot()); });
app.post('/api/autopilot/stop', requireUser, autopilotOwner, (req, res) => { stopAutopilot(); res.json(getAutopilot()); });
app.post('/api/autopilot/config', requireUser, autopilotOwner, (req, res) => res.json(setAutopilotConfig(req.body || {})));
app.post('/api/autopilot/tick', requireUser, autopilotOwner, async (req, res) => res.json(await tickAutopilot())); // manual tick for owner/testing
app.get('/api/autopilot/proposals', requireUser, (req, res) => res.json({ pending: getProposals() })); // ARD: human-in-the-loop queue
app.post('/api/autopilot/proposals/:id/approve', requireUser, autopilotOwner, async (req, res) => res.json(await approveProposal(req.params.id))); // override: execute now
app.post('/api/autopilot/proposals/:id/reject', requireUser, autopilotOwner, (req, res) => res.json(rejectProposal(req.params.id))); // override: block this entry

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
app.post('/api/backtest', publicLimiter, async (req, res) => {
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

// ---------- v1.16 Binance Web3 public data (Token Audit + Smart-Money Signals) ----------
// Public + agent-accessible (ARD). No keys — proxies web3.binance.com public endpoints.
// Token Audit: pre-trade safety scan (honeypot/rug-pull/scam/tax). Smart-Money: whale buy/sell feed.
app.post('/api/token-audit', publicLimiter, async (req, res) => {
  const { contractAddress, chainId } = req.body || {};
  if (!contractAddress || !/^[A-Za-z0-9]{32,44}$/.test(String(contractAddress).trim())) {
    return res.status(400).json({ ok: false, error: 'valid contractAddress required' });
  }
  const cid = String(chainId || '56');
  if (!AUDIT_CHAINS.some((c) => c.id === cid)) {
    return res.status(400).json({ ok: false, error: `unsupported chainId ${cid} — use ${AUDIT_CHAINS.map((c) => c.id).join('|')}` });
  }
  try {
    const r = await auditToken(contractAddress, cid);
    res.json({ ok: true, chainId: cid, ...r });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/smart-money', publicLimiter, async (req, res) => {
  const cid = String(req.query.chainId || '56');
  if (!SIGNAL_CHAINS.some((c) => c.id === cid)) {
    return res.status(400).json({ ok: false, error: `unsupported chainId ${cid} — use ${SIGNAL_CHAINS.map((c) => c.id).join('|')}` });
  }
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize, 10) || 20), 100);
    const r = await smartMoney({ chainId: cid, page, pageSize });
    res.json({ ok: true, chainId: cid, page, pageSize, cached: Date.now() - r.ts < 1500, ...r });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

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
