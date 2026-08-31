// server.js — IOST Terminal: AI trading platform (paper-first execution)
import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTicker, getExecutionTicker, getKlines, peekTicker, WATCHLIST } from './lib/market.js';
import { getGlobalMetrics, getTopMovers, getMarketExtras, getCmcGlobal } from './lib/marketdata.js';
import { applyGarchSizing, getGarchState, peekGarchState, garchConfig } from './lib/garch.js';
import { scanAll, analyzeSymbol } from './lib/scanner.js';
import { computeScores } from './lib/score.js';
import { getNews, getAssetSentiment } from './lib/news.js';
import { getChainSnapshot } from './lib/onchain.js';
import { iostChainIdentity } from './lib/iost-node.js';
import { calculateRisk, portfolioExposure } from './lib/risk.js';
import { analyzePortfolio } from './lib/portfolio.js';
import { getState, getAccount, closeTrade, resetAccount, setAccountSize, markToMarket, journalStats, ensureAccount, listAccounts, persistAccounts } from './lib/paper.js';
import { getBroker } from './lib/broker/index.js';
import { enableLive, disableLive, getLiveState, logLiveEvent, anyLiveEnabled, isLiveAllowed, isOwnerIdentity, liveTradingAvailable } from './lib/live.js';
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
import * as evmWallets from './lib/evm-wallets.js';
import * as aittClaims from './lib/aitt-claims.js';
import * as aittChain from './lib/aitt-chain.js';
import * as wallets from './lib/wallets.js';
import * as limits from './lib/limits.js';
import * as freeze from './lib/freeze.js';
import * as stakes from './lib/stakes.js';
import * as slashes from './lib/slashes.js';
import * as trust from './lib/trust.js';
import * as arena from './lib/arena.js';
import * as pacts from './lib/pacts.js';
import * as missions from './lib/missions.js';
import * as executionReceipts from './lib/execution-receipts.js';
import * as executionIntents from './lib/execution-intents.js';
import { buildPaperTradePreflight } from './lib/trade-preflight.js';
import { buildPortfolioRiskDecision } from './lib/portfolio-risk-governor.js';
import * as iostAccounts from './lib/iost-accounts.js';
import * as agentKeys from './lib/agent-keys.js';
import * as liveProposals from './lib/live-proposals.js';
import * as management from './lib/management.js';
import * as triggers from './lib/triggers.js';
import { runBacktest, describeRule } from './lib/backtest.js';
import { evaluateAgentStrategy } from './lib/evaluation.js';
import { compareEvaluations, exportEvaluationCsv, exportEvaluationJson, getEvaluation, listEvaluations, saveEvaluation, secureEvaluationHistoryPermissions } from './lib/evaluation-history.js';
import { auditToken, smartMoney, AUDIT_CHAINS, SIGNAL_CHAINS } from './lib/binance-data.js';
import session from 'express-session';
import { FileSessionStore } from './lib/session-store.js';
import { authRouter, authLimiter, sameOriginMutation } from './lib/auth-routes.js';
import rateLimit from 'express-rate-limit';
import * as auth from './lib/auth.js';
import {
  MCP_LEGACY_VERSION, MCP_MODERN_VERSION, MCP_SUPPORTED_VERSIONS, MCP_TASKS_EXTENSION,
  MCP_UI_EXTENSION, buildMcpTools, hasMcpAppsCapability, hasTasksCapability, modernResult,
  validateModernRequest, validateToolArguments, withModernMeta,
} from './lib/mcp-protocol.js';
import { createMcpTaskStore } from './lib/mcp-tasks.js';
import { MCP_APP_MIME_TYPE, listMcpAppResources, readMcpAppResource } from './lib/mcp-apps.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.IOST_DATA_DIR || join(ROOT, 'data');
const PORT = process.env.PORT || 8787;
const AITT_DOC_VERSION = '2.3';
process.umask(0o077);

// ---- .env loader (KEY=VALUE, '#' comments; real env vars win) ----
import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync, statSync, appendFile } from 'node:fs';
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
  const f = join(DATA_DIR, 'session-secret');
  try {
    if (existsSync(f)) {
      chmodSync(f, 0o600);
      if ((statSync(f).mode & 0o777) !== 0o600) throw new Error('session-secret permissions must be 0600');
      const s = readFileSync(f, 'utf8').trim();
      if (s) return s;
    }
  } catch (e) {
    if (existsSync(f)) throw new Error(`session-secret could not be secured: ${e.message}`);
    /* missing file -> generate below */
  }
  const secret = crypto.randomBytes(32).toString('hex');
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(f, secret, { mode: 0o600 });
  chmodSync(f, 0o600);
  if ((statSync(f).mode & 0o777) !== 0o600) throw new Error('session-secret permissions must be 0600');
  return secret;
}
const SESSION_SECRET = loadSessionSecret();
const PAPER_PREFLIGHT_BINDING_SECRET = crypto.createHash('sha256')
  .update(`iost-terminal:paper-preflight-binding:v1:${SESSION_SECRET}`).digest();

// defense-in-depth: data stores hold hashes / TOTP blobs / encrypted key
// material — keep them owner-only at boot (tmp+rename writes reset perms).
try {
  for (const f of [
    'accounts.json', 'paper.json', 'users.json', 'agent-keys.json', 'sessions.json', 'session-secret',
    'stakes.json', 'slashes.json', 'points.json', 'wallets.json', 'limits.json', 'freeze.json',
    'pacts.json', 'evm-wallets.json', 'aitt-claims-v2.json', 'aitt-points-snapshot.json',
    'iost_accounts.json', 'pending_pins.json', 'signals.json', 'follows.json', 'triggers.json',
    'payments.json', 'fee-config.json', 'live-proposals.json', 'agent-audit.jsonl',
    'live-audit.jsonl', 'arena-audit.jsonl', 'mcp-tasks.json', 'missions.json', 'execution-receipts.jsonl',
    'execution-intents.json',
  ]) {
    const p = join(DATA_DIR, f);
    if (existsSync(p)) {
      chmodSync(p, 0o600);
      if ((statSync(p).mode & 0o777) !== 0o600) throw new Error(`${f} permissions must be 0600`);
    }
  }
  secureEvaluationHistoryPermissions();
  missions.secureMissionPermissions();
  executionReceipts.secureReceiptPermissions();
  executionIntents.secureExecutionIntentPermissions();
} catch (e) {
  console.error(`[security] refusing boot: sensitive store permissions could not be secured (${e.message})`);
  throw e;
}

const app = express();
app.disable('x-powered-by'); // no framework fingerprinting
app.use(compression({
  threshold: 1024,
  // Streaming events must flush immediately rather than wait for a compression
  // buffer. Everything else uses the package's content-type safety filter.
  filter: (req, res) => req.path !== '/api/events' && compression.filter(req, res),
}));
app.use(express.json({ limit: '200kb' }));

// ---- launch readiness: security headers on EVERY response ----
// Pragmatic CSP: the app ships inline scripts/styles (landing shader, hub scene,
// SSR machine layer) and same-origin APIs only. 'unsafe-inline' is required by
// the inline <script>/<style> blocks. Dynamic evaluation remains disallowed.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
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

// Production defaults to the canonical origin. Explicit overrides allow a
// scratch local server to exercise browser security and auth end to end.
const SITE_URL = process.env.SITE_URL || 'https://iostcallister.com';

// Apply browser-origin validation to the complete mutation surface, not only
// /api/auth. Headerless CLI/native-agent requests remain compatible; browser
// requests with cross-site Fetch Metadata or a foreign Origin fail closed.
app.use(sameOriginMutation(SITE_URL));

// ---- sessions: cookie 'iost.sid', httpOnly, lax, Secure when behind TLS ----
// secure:'auto' → Secure flag only when the request arrived over HTTPS
// (Traefik / cloudflared set X-Forwarded-Proto; trust proxy enables that).
app.set('trust proxy', 1);
app.use(session({
  name: 'iost.sid',
  secret: SESSION_SECRET,
  store: new FileSessionStore(), // survives restarts — no more surprise logouts
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', priority: 'high', maxAge: 4 * 3600 * 1000 }, // 4h, then auto logout
}));

// ---------- machine-first agent layer ----------
// API keys (optional; agents SHOULD authenticate). Set AGENT_KEYS="k1,k2" — no default (fail closed).
// Registered BEFORE all routes so every protected route can see a valid key.
const AGENT_KEYS = new Set((process.env.AGENT_KEYS || '').split(',').map(s => s.trim()).filter(Boolean));
// OAuth 2.0 bearer tokens (v1.17): opaque, resource-bound tokens minted at POST /oauth/token
// via client_credentials (client_id = agent-key id, client_secret = full itk_ key).
// In-memory, TTL 24h, revocable via /oauth/revoke — a restart clears them (documented).
const oauthTokens = new Map(); // token -> { userId, keyId, scopes, resource, expiresAt }
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
      const bearerToken = authz.replace(/^Bearer\s+/i, '').trim();
      const entry = oauthTokens.get(bearerToken);
      const expectedResource = req.path === '/mcp' ? `${SITE_URL}/mcp` : `${SITE_URL}/`;
      const active = !!(entry && entry.expiresAt > Date.now() && agentKeys.isActiveKey(entry.keyId, entry.userId));
      if (active && entry.resource === expectedResource) {
        req.userAgent = { userId: entry.userId, keyId: entry.keyId, name: 'oauth', scopes: entry.scopes.slice() };
      } else {
        req.invalidBearer = true;
        if (entry && !active) oauthTokens.delete(bearerToken);
      }
    }
  }
  next();
});

// Authenticated API responses and every authentication response may contain
// account state or credential-flow metadata. Keep them out of browser/shared
// caches and make cache-key boundaries explicit for intermediaries.
app.use((req, res, next) => {
  const apiRequest = req.path.startsWith('/api/') || req.path.startsWith('/oauth/') || req.path === '/mcp';
  const authFlow = req.path.startsWith('/api/auth/');
  const privateRoute = ['/api/evaluation-lab/history', '/api/account/', '/api/admin/', '/api/paper', '/api/agent-keys']
    .some((prefix) => req.path.startsWith(prefix));
  if (apiRequest && (authFlow || privateRoute || req.session?.userId || req.agentKey || req.userAgent)) {
    res.set('Cache-Control', 'private, no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Vary', 'Cookie, Authorization, X-API-Key');
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
// Gentle site-wide limiter: real rate limit (600 req/min/IP) that also emits
// standard RateLimit-* AND legacy X-RateLimit-* headers on every response, so
// agent-readiness validators and agents can discover the policy. Endpoint-level
// limiters (publicLimiter, oauthLimiter, …) stay the authoritative gates.
const siteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: true,
  message: { error: 'too many requests — slow down' },
});
app.use(siteLimiter);
// scope guard for per-user agent keys — platform keys & sessions are unaffected
function userAgentHas(req, scope) {
  return !!(req.userAgent && req.userAgent.scopes.includes(scope));
}

// ---- append-only agent audit log (data/agent-audit.jsonl) ----
// Every agent-authenticated (X-API-Key identity) request to a signal, paper
// or agent endpoint is recorded with a payload HASH only — never raw payload
// contents, API keys, emails or passwords. JSONL append via fs.appendFile —
// the file is never rewritten. Reading the tail: GET /api/audit?agent=&limit=
const AUDIT_FILE = join(DATA_DIR, 'agent-audit.jsonl');
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
  { re: /^\/api\/evaluation-lab$/, method: 'POST', action: 'evaluation.run' },
  { re: /^\/api\/evaluation-lab\/history$/, method: 'GET', action: 'evaluation.history.list' },
  { re: /^\/api\/evaluation-lab\/history\/compare$/, method: 'GET', action: 'evaluation.history.compare' },
  { re: /^\/api\/evaluation-lab\/history\/[^/]+$/, method: 'GET', action: 'evaluation.history.read' },
  { re: /^\/api\/evaluation-lab\/history\/[^/]+\/export$/, method: 'GET', action: 'evaluation.export' },
  { re: /^\/api\/audit$/, method: 'GET', action: 'audit.read' },
  { re: /^\/mcp$/, method: 'POST', action: 'mcp.request' },
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
  if (!(req.agentKey || req.userAgent)) return next();
  const rule = AUDIT_ROUTES.find((r) => r.method === req.method && r.re.test(req.path));
  if (!rule) return next();
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  res.on('finish', () => {
    const entry = {
      ts: new Date().toISOString(),
      // hashed identity — the raw platform key must NEVER reach the log
      // (signalIdentity hashes platform keys; user agent keys are non-secret ids)
      agentId: signalIdentity(req)?.agentId || 'anon',
      action: rule.action,
      endpoint: req.path,
      payloadHash: canonicalHash(payload),
      outcome: res.statusCode < 400 ? 'ok' : 'error',
      statusCode: res.statusCode,
    };
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 }, () => {});
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
for (const f of ['index.html', 'hub.html', 'app.html', 'arena.html', 'token.html']) {
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
function sentimentCounts(market) {
  if (!market) return null;
  const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  return {
    bullish: count(market.bullish),
    neutral: count(market.neutral),
    bearish: count(market.bearish),
    total: count(market.total),
  };
}

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
  const m = sentimentCounts(s?.market);
  return {
    ts: s.ts, version: '1.9.0', mode: 'paper',
    watchlist: WATCHLIST,
    scores: s.scores.slice(0, 12).map((x) => {
      const p = probFor(x.symbol);
      return { symbol: x.symbol, type: x.type, price: x.price, composite: x.composite, grade: x.grade, subscores: x.subscores, rationale: rationale(x), ...(p ? { probUp: p.probUp, ciLo: p.ciLo, ciHi: p.ciHi, direction: p.direction, drivers: p.drivers } : {}) };
    }),
    top: s.scores[0] ? { symbol: s.scores[0].symbol, composite: s.scores[0].composite, grade: s.scores[0].grade, rationale: rationale(s.scores[0]), ...(probFor(s.scores[0].symbol) ? { probUp: probFor(s.scores[0].symbol).probUp, drivers: probFor(s.scores[0].symbol).drivers } : {}) } : null,
    account: p ? { initialCash: p.account.initialCash, cash: p.account.cash, openPositions: p.positions.length } : null,
    autopilot: s.autopilot ? { enabled: s.autopilot.enabled, ticks: s.autopilot.ticks, requireApproval: !!s.autopilot.config?.requireApproval } : null,
    market: m ? { bullish: m.bullish, neutral: m.neutral, bearish: m.bearish } : null,
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
      additionalProperty: [
        ...(price != null ? [{ '@type': 'PropertyValue', name: 'observed market price', value: price, unitText: 'USD' }] : []),
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
  const m = sentimentCounts(s?.market);
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
      title: 'IOST Terminal — AI Trading Platform — Paper-First',
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
    'arena.html': {
      title: 'Agent Trust Arena — IOST Terminal',
      desc: 'Paper-only agent rankings with server-priced performance, drawdown and risk scores, transparent reasoning, and hash-chained audit evidence.',
      url: '/arena',
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
  const headExtra = `${meta}\n<meta name="agent:state" content="/api/ui-state">\n<link rel="alternate" type="application/json" title="IOST Terminal agent state" href="/api/ui-state">\n<link rel="alternate" type="text/markdown" title="IOST Terminal LLM index" href="/llms.txt">\n<link rel="llms" href="/llms.txt">\n<link rel="llms-full" href="/llms-full.txt">\n<link rel="api-catalog" href="/.well-known/api-catalog">\n<link rel="ai-catalog" href="/.well-known/ai-catalog.json">\n<link rel="alternate" type="application/json" title="A2A agent card" href="/.well-known/agent-card.json">\n<link rel="service-desc" type="application/openapi+json" href="/openapi.json">\n${jsonLdBlock()}`;
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
    const m = sentimentCounts(s?.market);
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
    const promotion = leaderboardPromotion(computeLeaderboard('week', 10), 5);
    const lbRows = promotion.eligible.length
      ? promotion.eligible.map((r) => `<div class="lb-row"><span class="lb-rank mono">#${r.rank}</span><span class="lb-name">${esc(r.trader)}</span><span class="lb-pnl up">$${r.pnl.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span><span class="lb-rate mono">${r.winRate}%</span><span class="lb-trades mono">${r.trades} trades</span></div>`).join('')
      : '<div class="lb-empty"><strong>No paper trader has cleared the public evidence bar yet.</strong><span>Qualification requires positive weekly P&amp;L and at least 5 closed paper trades.</span></div>';
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
  return accept.includes('text/markdown') || accept.includes('text/x-markdown') || /markdown/i.test(accept.split(',')[0]) || /text\/plain/i.test(accept);
}
// JSON negotiation: an explicit Accept: application/json (never */* alone) gets
// the machine state payload instead of HTML. Browsers never send this for
// navigation, so human pages are unaffected.
function acceptsJson(req) {
  const accept = req.headers.accept || '';
  return accept.includes('application/json') && !accept.includes('text/html');
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
  const base = `# IOST Terminal — AI Trading Platform — Paper-First\n\n> AI real-time trading platform for crypto + equities: live market data, AI\n> trade scores (0-100 with subscore breakdown), risk engine, news sentiment,\n> IOST on-chain dashboard, paper trading and an autonomous autopilot.\n> Paper-first: nothing here moves real money without explicit enablement.\n\nMachine interfaces: [API index](/api) · [OpenAPI](/openapi.json) · [full state](/api/ui-state) · [LLM index](/llms.txt) · [agent auth](/auth.md) · [ARD manifest](/.well-known/ai-catalog.json)\n`;
  if (name === 'app' || name === 'hub') {
    const isApp = name === 'app';
    return `${base}\n## ${isApp ? 'AI Command Center' : 'Automation Hub'}\n\nThis is the ${isApp ? 'interactive trading console' : '3D automation hub'} — a client-side application shell.\nLive machine-readable state (server-rendered, no JS required): **/api/ui-state**\n\n- Top AI scores: ${(s?.scores || []).slice(0, 5).map((x) => `${x.symbol} ${x.composite} ${x.grade}`).join(' · ') || 'n/a'}\n- Autopilot: ${s?.autopilot?.enabled ? `enabled (${s.autopilot.ticks} ticks)${s.autopilot.config?.requireApproval ? ' · human-approval mode' : ''}` : 'disabled'}\n- Paper account: ${s?.paper?.account?.cash != null ? `$${Number(s.paper.account.cash).toLocaleString('en-US', { maximumFractionDigits: 2 })} cash · ${s.paper.positions?.length || 0} open` : 'n/a'}\n\nActions for agents: authenticated via **X-API-Key** header or **OAuth 2.0 client_credentials** (see [/auth.md](/auth.md)); live trades require owner approval through the proposal queue ([/api/autopilot/proposals](/api/autopilot/proposals)).\n`;
  }
  if (name === 'token') {
    return `${base}\n## AITT — Agent Intelligence Trading Token\n\nERC-20 design for IOST L2 (chain 182), 1B fixed supply, 8 decimals. **Pre-launch remediation — NOT issued.**\n- Public info: [/api/aitt/info](/api/aitt/info)\n- Token page: [/aitt](/aitt) (SSR — no JS required)\n- Tokenomics draft v${AITT_DOC_VERSION}: [/whitepaper](/whitepaper)\n- Unified protocol burns, contract-locked allocations, signed EVM binding and atomic receipt reconciliation are built. Counsel cleared the Phase 1 utility framing on 2026-08-24, but conversion remains closed pending deployment, independent audit, hash-bound approval evidence and owner approval. Staking revenue/APY, external transferability and Phase 4 liquidity remain inactive future proposals requiring separate counsel/owner/audit approval.\n`;
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
  const lb = leaderboardPromotion(computeLeaderboard('week', 10), 5).eligible;
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
- **Trade (paper):** preflight with a unique 8-128 character \`intentId\`; crypto requires a fresh two-venue quote quorum and routes to the best trusted ask/bid. Then POST /api/paper/open with that intent and the returned \`preflightFingerprint\`; exact retries return the original outcome, changed evidence fails closed, and opens require a \`trade-paper\`-scoped key + owned walletId + active wallet-bound pactId
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
    '</llms-full.txt>; rel="llms-full"',
    '</api>; rel="service-doc"',
    '</.well-known/agent.json>; rel="service-doc"',
    '</.well-known/agent-card.json>; rel="agent-card"',
    '</api/ui-state>; rel="alternate"; type="application/json"',
  ].join(', '));
}
function sendPage(req, res, name) {
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'Accept');
  if (acceptsJson(req)) {
    res.type('application/json; charset=utf-8');
    return res.json(statePayload() ?? { ok: false, error: 'state not ready yet' });
  }
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
app.get('/arena', (req, res) => sendPage(req, res, 'arena'));
// AITT token page — public, SSR (CMC-ready: crawlers get full content, no JS required)
app.get('/aitt', (req, res) => sendPage(req, res, 'token'));
app.get('/token', (req, res) => res.redirect(308, '/aitt'));
// Whitepaper (public markdown distribution copy; TOKENOMICS.md remains the internal source of truth)
app.get('/whitepaper', (req, res) => {
  try {
    res.type('text/markdown; charset=utf-8');
    res.send(readFileSync(join(ROOT, 'docs', 'AITT-Whitepaper-v1.0.md'), 'utf8'));
  } catch {
    res.status(404).json({ error: 'whitepaper not available yet' });
  }
});
app.use(express.static(join(ROOT, 'public'), { maxAge: '1h' }));

// ---- legal pages ----
const LEGAL_PAGES = {};
for (const f of ['terms.html', 'privacy.html', 'risk-disclosure.html']) {
  LEGAL_PAGES[f] = readFileSync(join(ROOT, 'public', f), 'utf8');
}
app.get('/terms', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(LEGAL_PAGES['terms.html']); });
app.get('/privacy', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(LEGAL_PAGES['privacy.html']); });
app.get('/risk-disclosure', (req, res) => { res.set('Cache-Control', 'no-store'); res.send(LEGAL_PAGES['risk-disclosure.html']); });

// ---- sitemap.xml ----
const SITEMAP_URLS = ['/', '/app', '/hub', '/aitt', '/arena', '/whitepaper', '/terms', '/privacy', '/risk-disclosure'];
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

const DISCOVERY_VERSION = '1.27.0';

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
  '/api/chain/identity': { get: { summary: 'Public IOSTCallister operator identity and explicitly separated IOST L1/L2 roles', tags: ['meta'], security: [] } },
  '/api/assistant': { post: { summary: 'Natural-language market Q&A synthesized from live data', tags: ['intelligence'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } } } } },
  '/api/risk': { post: { summary: 'Position size, $ risk, R:R, potential P/L, exposure', tags: ['risk'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
  '/api/leaderboard': { get: { summary: 'Paper leaderboard plus qualified public-promotion subset (masked identities)', tags: ['social'], security: [] } },
  '/api/backtest': { post: { summary: 'Objective-rules backtest with FXReplay KPIs + honesty caveats', tags: ['analysis'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
  '/api/evaluation-lab': { post: { summary: 'Paper-only walk-forward strategy evaluation and fail-closed promotion evidence', tags: ['analysis'], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
  '/api/evaluation-lab/history': { get: { summary: 'Private retained evaluation history for the current user', tags: ['analysis'] } },
  '/api/evaluation-lab/history/compare': { get: { summary: 'Compare exactly two current-user evaluation runs', tags: ['analysis'], parameters: [{ name: 'ids', in: 'query', required: true, schema: { type: 'string' } }] } },
  '/api/evaluation-lab/history/{id}': { get: { summary: 'Read one current-user evaluation run', tags: ['analysis'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
  '/api/evaluation-lab/history/{id}/export': { get: { summary: 'Deterministic private JSON or CSV evidence export', tags: ['analysis'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'format', in: 'query', required: true, schema: { type: 'string', enum: ['json', 'csv'] } }] } },
  '/api/token-audit': { post: { summary: 'Binance Web3 token security audit (honeypot/rug/tax scan)', tags: ['analysis'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { contractAddress: { type: 'string' }, chainId: { type: 'string' } }, required: ['contractAddress'] } } } } } },
  '/api/smart-money': { get: { summary: 'Whale buy/sell signals (BSC/Solana)', tags: ['analysis'], security: [] } },
  '/api/signals/feed': { get: { summary: 'Public signal feed with on-chain proof status', tags: ['agents'], security: [] } },
  '/api/autopilot/proposals': { get: { summary: 'Pending human-in-the-loop proposals with full reasoning', tags: ['autonomy'], security: [] } },
  '/api/paper': { get: { summary: 'Account + open positions + journal (mark-to-market)', tags: ['execution'] } },
  '/api/paper/preflight': { post: { summary: 'Read-only paper trade preflight with multi-venue quote integrity, routed price, estimated cost and authorization evidence', tags: ['execution'] } },
  '/api/paper/open': { post: { summary: 'Open paper trade', tags: ['execution'] } },
  '/api/paper/close': { post: { summary: 'Close paper trade', tags: ['execution'] } },
  '/api/execution-receipts': { get: { summary: 'Private tamper-evident paper execution receipts and chain verification', tags: ['execution'] } },
  '/api/execution-intents': { get: { summary: 'Private paper execution idempotency and replay status', tags: ['execution'] } },
  '/api/execution-intents/{intentId}': { get: { summary: 'Private status for one paper execution intent', tags: ['execution'] } },
  '/api/signals': { post: { summary: 'Publish a signal as the authenticated principal; SHA-256 pinned on IOST mainnet', tags: ['agents'] } },
  '/api/agent-keys': { get: { summary: 'My AI-agent API keys (scopes, prefixes)', tags: ['auth'] }, post: { summary: 'Mint a scoped AI-agent API key', tags: ['auth'] } },
  '/api/agent-control': { get: { summary: 'Owner-only agent operations snapshot: activity, permissions, budgets and safety state', tags: ['autonomy'] } },
  '/api/agent-control/emergency-stop': { post: { summary: 'Owner-only fail-safe: stop autopilot, suspend owned agent wallets and disable live execution', tags: ['autonomy'] } },
  '/api/agent-missions': { get: { summary: 'Owner-only supervised paper missions and trace evidence', tags: ['autonomy'] }, post: { summary: 'Create a paused paper mission bound to an exact active wallet and Pact', tags: ['autonomy'] } },
  '/api/agent-missions/{id}/start': { post: { summary: 'Start an owner paper mission after revalidating its wallet and Pact', tags: ['autonomy'] } },
  '/api/agent-missions/{id}/pause': { post: { summary: 'Pause an owner paper mission', tags: ['autonomy'] } },
  '/api/agent-missions/{id}/stop': { post: { summary: 'Permanently stop an owner paper mission', tags: ['autonomy'] } },
  '/api/agent-missions/{id}/checkpoint': { post: { summary: 'Append a bounded user-agent mission checkpoint', tags: ['autonomy'] } },
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
    agent_auth: {
      register_uri: `${SITE_URL}/auth.md`,
      skill: `${SITE_URL}/auth.md`,
      // anonymous registration method — truthful for autonomous agents holding
      // a scoped itk_ key / OAuth bearer token (no per-user identity assertion)
      identity_types_supported: ['anonymous'],
      anonymous: { credential_types_supported: ['access_token'] },
      claim_uri: `${SITE_URL}/api/meta`,
      revocation_uri: `${SITE_URL}/oauth/revoke`,
      revocation_endpoint: `${SITE_URL}/oauth/revoke`,
    },
  });
});
// ---- OAuth protected-resource metadata (RFC 9728) ----
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  res.json({
    resource: `${SITE_URL}/`,
    authorization_servers: [SITE_URL],
    scopes_supported: ['read', 'trade-paper', 'trade-live'],
    bearer_methods_supported: ['header'],
  });
});
// RFC 9728 path-specific metadata for the protected MCP resource.
app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  res.json({
    resource: `${SITE_URL}/mcp`,
    authorization_servers: [SITE_URL],
    scopes_supported: ['read', 'trade-paper'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${SITE_URL}/auth.md`,
  });
});

// ---- real OAuth 2.0 client_credentials grant (no fake metadata) ----
// client_id = agent-key id (public), client_secret = the full itk_ secret.
// Tokens are opaque, in-memory, 24h TTL; revoke directly via /oauth/revoke or
// revoke the source agent key to invalidate every bearer derived from it.
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
  const resource = String(req.body.resource || `${SITE_URL}/`);
  if (![`${SITE_URL}/`, `${SITE_URL}/mcp`].includes(resource)) {
    return res.status(400).json({ error: 'invalid_target', error_description: 'resource must identify the IOST Terminal API or MCP endpoint' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 24 * 3600 * 1000;
  oauthTokens.set(token, { ...principal, resource, expiresAt });
  res.set('Cache-Control', 'no-store');
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400, scope: principal.scopes.join(' '), resource });
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
- \`POST /oauth/token\` with \`grant_type=client_credentials\` (form body or HTTP Basic) → \`access_token\` (Bearer, 24h, opaque, in-memory). MCP clients include \`resource=${SITE_URL}/mcp\`; tokens are audience-bound and cannot be replayed across resources.
- Use \`Authorization: Bearer <token>\` — resolves to the same identity + scopes as the key.
- Revoke: \`POST /oauth/revoke\` with \`{token}\`, or revoke the source agent key to invalidate every bearer derived from it immediately.

## Agent paper execution rail
Agent-key paper opens require the \`trade-paper\` scope, a positive \`entry\` and
\`size\`, a protective \`stop\`, an owned agent \`walletId\`, an active
wallet-bound \`pactId\`, and an allowed server portfolio-risk preflight.
Human-session paper execution remains unchanged.

## MCP 2026-07-28
Endpoint: \`POST ${SITE_URL}/mcp\`. Public tools are read-only. A user-bound key or
an MCP-resource-bound bearer token adds private evaluation/account tools,
including \`paper_execution_receipts\` and \`paper_execution_intents\` with
tamper-evident execution evidence and replay-safe intent status. The
\`trade-paper\` scope adds read-only \`paper_trade_preflight\` plus
\`paper_trade_open\` and \`paper_trade_close\`.
Both require a unique \`intentId\`; exact retries return the original terminal
outcome and conflicting reuse fails closed. Paper opens still require the wallet
and Pact fields above. No MCP tool can execute a live,
token, conversion, wallet-send, swap, or public-chain action.
Paper closes use a server-observed market price (or the last server observation
if a fresh quote is unavailable); a client cannot select the P&L exit price.

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

// ---- MCP 2026-07-28 stateless streamable HTTP + bounded legacy compatibility ----
// The modern endpoint exposes public read tools anonymously. Private account,
// evaluation and paper-trade tools appear only for a user-bound credential with
// the matching scope. Tool annotations are hints; this server always enforces
// authorization independently at execution time.
const MCP_SERVER_INFO = Object.freeze({
  name: 'iost-terminal', version: DISCOVERY_VERSION,
  description: 'Paper-only AI trading analysis, evaluation and execution with server-enforced authorization rails.',
  websiteUrl: SITE_URL,
});
const mcpTaskStore = createMcpTaskStore({ dataDir: DATA_DIR });

function mcpAccess(req) {
  if (req.userAgent) return { authenticated: true, ownerId: req.userAgent.userId, scopes: req.userAgent.scopes.slice() };
  if (req.session?.userId && auth.findById(req.session.userId)) {
    return { authenticated: true, ownerId: req.session.userId, scopes: ['read'] };
  }
  return { authenticated: false, ownerId: null, scopes: [] };
}

function mcpToolAllowed(req, name) {
  const access = mcpAccess(req);
  return buildMcpTools(access).some((tool) => tool.name === name);
}

function mcpAuthorizationStatus(req) {
  const access = mcpAccess(req);
  const wallet = findAgentWalletForRequest(req);
  const ownerPacts = wallet ? pacts.listPacts(wallet.ownerId) : [];
  return {
    ok: true, mode: 'paper-only', scopes: access.scopes,
    emergencyFreeze: freeze.freezeState(),
    wallet: wallet ? {
      walletId: wallet.walletId, name: wallet.name, status: wallet.status,
      limits: wallet.limits, capabilities: wallet.capabilities, approvalRequired: wallet.approvalRequired,
    } : null,
    pacts: ownerPacts.map((pact) => ({
      pactId: pact.pactId, agentWalletId: pact.agentWalletId, status: pact.status,
      approvalRequired: pact.policies?.approvalRequired ?? true, completion: pact.completion,
      spentMinor: pact.spentMinor, expiresAt: pact.expiresAt,
    })),
    canOpenPaperTrade: !!(req.userAgent && userAgentHas(req, 'trade-paper') && wallet && wallet.status === 'active'
      && ownerPacts.some((pact) => pact.status === 'active' && pact.agentWalletId === wallet.walletId)),
  };
}

async function runMcpEvaluation(req, args) {
  const ownerId = evaluationOwner(req);
  if (!ownerId) throw Object.assign(new Error('user-bound evaluation history required'), { status: 403 });
  const symbol = String(args?.symbol || '').toUpperCase();
  const timeframe = String(args?.timeframe || '1d');
  const strategy = args?.strategy;
  if (!symbol || !strategy?.entry?.rule) throw Object.assign(new Error('symbol and strategy.entry.rule required'), { status: 400 });
  const candles = await getKlines(symbol, timeframe, 500);
  const result = evaluateAgentStrategy({ symbol, timeframe, strategy, candles, config: args?.config });
  if (result.ok) result.history = saveEvaluation(ownerId, result);
  return result;
}

function mcpEvaluationOwner(req) {
  const ownerId = evaluationOwner(req);
  if (!ownerId) throw Object.assign(new Error('private evaluation evidence unavailable'), { protocolCode: -32602 });
  return ownerId;
}

function mcpEvaluationGet(req, runId) {
  const run = getEvaluation(mcpEvaluationOwner(req), runId);
  if (!run) throw Object.assign(new Error('private evaluation evidence unavailable'), { protocolCode: -32602 });
  return run;
}

function mcpEvaluationCompare(req, runIds) {
  const result = compareEvaluations(mcpEvaluationOwner(req), runIds);
  if (!result) throw Object.assign(new Error('private evaluation evidence unavailable'), { protocolCode: -32602 });
  return result;
}

function mcpEvaluationTask(req, taskId) {
  const task = mcpTaskStore.get(mcpEvaluationOwner(req), taskId);
  if (!task) throw Object.assign(new Error('private evaluation task unavailable'), { protocolCode: -32602 });
  return task;
}

function mcpEvaluationReview(req, args) {
  const ownerId = mcpEvaluationOwner(req);
  const runIds = Array.isArray(args?.runIds) ? args.runIds : [];
  const selected = runIds.map((runId) => {
    const run = getEvaluation(ownerId, runId);
    if (!run) throw Object.assign(new Error('private evaluation evidence unavailable'), { protocolCode: -32602 });
    return run;
  });
  return {
    ok: true,
    mode: 'paper-only',
    appVersion: 1,
    serverRevision: process.env.APP_REVISION || 'development',
    history: listEvaluations(ownerId, 25),
    selected,
    comparison: runIds.length === 2 ? mcpEvaluationCompare(req, runIds) : null,
    task: args?.taskId ? mcpEvaluationTask(req, args.taskId) : null,
    authorization: mcpAuthorizationStatus(req),
    boundary: 'Evidence review cannot authorize financial execution. MetaMask binding proves ownership only. Paper execution remains a separate wallet/Pact-gated tool.',
  };
}

async function mcpToolCall(req, name, args) {
  if (!mcpToolAllowed(req, name)) throw Object.assign(new Error('unknown or unauthorized tool'), { protocolCode: -32602 });
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
    case 'platform_help': return {
      name: 'IOST Terminal', version: DISCOVERY_VERSION,
      api: `${SITE_URL}/api`, openapi: `${SITE_URL}/openapi.json`, llms: `${SITE_URL}/llms.txt`,
      auth: `${SITE_URL}/auth.md`, ard: `${SITE_URL}/.well-known/ai-catalog.json`,
      skills: `${SITE_URL}/.well-known/agent-skills/index.json`, mcpCard: `${SITE_URL}/.well-known/mcp/server-card.json`,
      protocolVersions: MCP_SUPPORTED_VERSIONS,
      note: 'Authenticated MCP agents may evaluate and trade paper accounts through scoped keys, agent wallets and active Pacts. Real-money, token and public-chain actions are unavailable.',
    };
    case 'health': return { ok: true, version: DISCOVERY_VERSION, ts: Date.now() };
    case 'agent_authorization_status': return mcpAuthorizationStatus(req);
    case 'paper_account': return await markToMarket(accountFor(req).accountId);
    case 'paper_stats': return journalStats(accountFor(req).accountId);
    case 'paper_execution_receipts': return executionReceipts.listExecutionReceipts(accountFor(req).accountId, args?.limit);
    case 'paper_execution_intents': {
      const accountId = accountFor(req).accountId;
      if (args?.intentId) {
        const intent = executionIntents.getExecutionIntent(accountId, args.intentId);
        if (!intent) throw Object.assign(new Error('execution intent not found'), { protocolCode: -32602 });
        return { ok: true, mode: 'paper-only', intent };
      }
      return { ok: true, mode: 'paper-only', intents: executionIntents.listExecutionIntents(accountId, args?.limit) };
    }
    case 'paper_missions': {
      const ownerId = missionOwnerId(req);
      if (!ownerId) throw Object.assign(new Error('user-bound mission access required'), { status: 403 });
      return { ok: true, mode: 'paper-only', missions: missions.listMissionEvidence(ownerId) };
    }
    case 'paper_mission_checkpoint': {
      const ownerId = missionOwnerId(req);
      if (!ownerId) throw Object.assign(new Error('user-bound mission access required'), { status: 403 });
      return { ok: true, mode: 'paper-only', mission: missions.missionEvidence(missions.recordMissionCheckpoint(args?.missionId, ownerId, args || {})) };
    }
    case 'evaluation_history': {
      const ownerId = evaluationOwner(req);
      if (!ownerId) throw Object.assign(new Error('user-bound evaluation history required'), { status: 403 });
      return { ok: true, mode: 'paper-only', ...listEvaluations(ownerId, args?.limit) };
    }
    case 'evaluation_review': return mcpEvaluationReview(req, args);
    case 'evaluation_get': return mcpEvaluationGet(req, args?.runId);
    case 'evaluation_compare': return mcpEvaluationCompare(req, args?.runIds);
    case 'evaluation_export': {
      const ownerId = mcpEvaluationOwner(req);
      const data = args?.format === 'csv' ? exportEvaluationCsv(ownerId, args?.runId) : exportEvaluationJson(ownerId, args?.runId);
      if (data == null) throw Object.assign(new Error('private evaluation evidence unavailable'), { protocolCode: -32602 });
      if (Buffer.byteLength(data) > 2_500_000) throw new Error('evaluation export exceeds MCP response limit');
      return {
        ok: true, mode: 'paper-only', format: args.format,
        filename: `iost-evaluation-${args.runId}.${args.format}`,
        mimeType: args.format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
        bytes: Buffer.byteLength(data), sha256: crypto.createHash('sha256').update(data).digest('hex'), data,
      };
    }
    case 'evaluation_task_status': return mcpEvaluationTask(req, args?.taskId);
    case 'evaluation_task_cancel': {
      mcpEvaluationTask(req, args?.taskId);
      const cancelled = mcpTaskStore.cancel(mcpEvaluationOwner(req), args?.taskId);
      if (!cancelled) throw Object.assign(new Error('evaluation task is already terminal'), { protocolCode: -32602 });
      return cancelled;
    }
    case 'evaluation_run': return await runMcpEvaluation(req, args);
    case 'paper_trade_preflight': {
      return paperTradePreflight(req, args || {});
    }
    case 'paper_trade_open': {
      return executePaperOpen(req, args || {}, 'mcp');
    }
    case 'paper_trade_close': {
      // Closing is risk-reducing, so it does not need an active Pact; the fill
      // nevertheless comes from the server, never an MCP client supplied price.
      return executePaperClose(req, args || {}, 'mcp');
    }
    default: throw new Error(`unknown tool: ${name}`);
  }
}
app.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  res.json({
    serverInfo: MCP_SERVER_INFO,
    protocolVersion: MCP_MODERN_VERSION,
    supportedVersions: MCP_SUPPORTED_VERSIONS,
    transport: { type: 'streamable-http', endpoint: `${SITE_URL}/mcp` },
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: {
      [MCP_TASKS_EXTENSION]: {}, [MCP_UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
    } },
    safety: { mode: 'paper-only', realMoney: false, tokenActions: false, publicChainActions: false },
  });
});
app.post('/mcp', publicLimiter, async (req, res) => {
  const msg = req.body;
  const reply = (payload, httpStatus = 200) => res.status(httpStatus).json(payload);
  if (req.invalidBearer) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${SITE_URL}/.well-known/oauth-protected-resource/mcp"`);
    return reply({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32001, message: 'Invalid or wrong-audience bearer token' } }, 401);
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return reply({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }, 400);
  }
  const id = msg.id ?? null;
  const requestedVersion = req.get('mcp-protocol-version') || msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const modern = requestedVersion === MCP_MODERN_VERSION;
  if (modern) {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));
    const validation = validateModernRequest(msg, headers);
    if (!validation.ok) return reply({ jsonrpc: '2.0', id, error: validation.error }, validation.status);
  } else if (requestedVersion && requestedVersion !== MCP_LEGACY_VERSION) {
    return reply({ jsonrpc: '2.0', id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: MCP_SUPPORTED_VERSIONS, requested: requestedVersion } } }, 400);
  }

  const access = mcpAccess(req);
  const taskOwner = access.ownerId;
  const success = (result) => reply({ jsonrpc: '2.0', id, result: modern ? withModernMeta(result, MCP_SERVER_INFO) : result });

  if (modern && msg.method === 'server/discover') {
    return success({
      resultType: 'complete', supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: {
        [MCP_TASKS_EXTENSION]: {}, [MCP_UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
      } },
      instructions: 'Public tools are read-only. Authenticate with a user-bound agent key for private evaluations and wallet/Pact-authorized paper trades. Real-money, token and public-chain actions are unavailable.',
      ttlMs: 300_000, cacheScope: 'public',
    });
  }
  if (msg.method === 'initialize') {
    if (modern) return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: initialize' } }, 404);
    return reply({ jsonrpc: '2.0', id, result: { protocolVersion: MCP_LEGACY_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO } });
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
    return res.status(202).end(); // JSON-RPC notification — no body
  }
  if (modern && msg.method === 'resources/list') {
    return success({ resultType: 'complete', resources: listMcpAppResources(), ttlMs: 300_000, cacheScope: 'public' });
  }
  if (modern && msg.method === 'resources/read') {
    const resource = readMcpAppResource(String(msg.params?.uri || ''));
    if (!resource) return reply({ jsonrpc: '2.0', id, error: { code: -32602, message: 'resource not found' } });
    return success({ resultType: 'complete', ...resource });
  }
  if (msg.method === 'tools/list') {
    const tools = buildMcpTools({ ...access, apps: modern && hasMcpAppsCapability(msg) });
    return success(modern
      ? { resultType: 'complete', tools, ttlMs: access.authenticated ? 0 : 60_000, cacheScope: access.authenticated ? 'private' : 'public' }
      : { tools });
  }
  if (msg.method === 'tools/call') {
    const name = String(msg.params?.name || '');
    const args = msg.params?.arguments ?? {};
    const argumentValidation = validateToolArguments(name, args, access);
    if (!argumentValidation.ok) {
      return reply({ jsonrpc: '2.0', id, error: { code: -32602, message: argumentValidation.error } });
    }
    if (modern && name === 'evaluation_run' && hasTasksCapability(msg)) {
      if (!taskOwner || !mcpToolAllowed(req, name)) {
        return reply({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown or unauthorized tool' } });
      }
      let task;
      try {
        task = mcpTaskStore.create({ ownerId: taskOwner, toolName: name, requestHash: canonicalHash(args) });
      } catch (error) {
        return reply({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
      }
      setTimeout(async () => {
        try {
          if (mcpTaskStore.get(taskOwner, task.taskId)?.status !== 'working') return;
          const data = await runMcpEvaluation(req, args);
          if (mcpTaskStore.get(taskOwner, task.taskId)?.status === 'working') {
            mcpTaskStore.complete(taskOwner, task.taskId, modernResult(data, MCP_SERVER_INFO));
          }
        } catch (error) {
          mcpTaskStore.fail(taskOwner, task.taskId, { code: error.protocolCode || -32603, message: error.message });
        }
      }, 25);
      return success({ resultType: 'task', ...task });
    }
    try {
      const data = await mcpToolCall(req, name, args);
      const result = modern ? modernResult(data, MCP_SERVER_INFO) : { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
      return reply({ jsonrpc: '2.0', id, result });
    } catch (e) {
      if (e.protocolCode) return reply({ jsonrpc: '2.0', id, error: { code: e.protocolCode, message: e.message } });
      const errorData = {
        ok: false, error: e.message, mode: 'paper-only',
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.receipt ? { receipt: e.receipt } : {}),
        ...(e.executionIntent ? { executionIntent: e.executionIntent } : {}),
      };
      const result = modern ? modernResult(errorData, MCP_SERVER_INFO, { isError: true }) : { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true };
      return reply({ jsonrpc: '2.0', id, result });
    }
  }
  if (modern && ['tasks/get', 'tasks/update', 'tasks/cancel'].includes(msg.method)) {
    if (!hasTasksCapability(msg)) {
      return reply({ jsonrpc: '2.0', id, error: { code: -32021, message: 'Tasks extension capability required', data: { requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } } } } }, 400);
    }
    if (!taskOwner) return reply({ jsonrpc: '2.0', id, error: { code: -32602, message: 'private task owner required' } });
    const taskId = String(msg.params?.taskId || '');
    const existing = mcpTaskStore.get(taskOwner, taskId);
    if (!existing) return reply({ jsonrpc: '2.0', id, error: { code: -32602, message: 'task not found' } });
    if (msg.method === 'tasks/get') return success({ resultType: 'complete', ...existing });
    if (msg.method === 'tasks/cancel') {
      const cancelled = mcpTaskStore.cancel(taskOwner, taskId);
      if (!cancelled) return reply({ jsonrpc: '2.0', id, error: { code: -32602, message: 'task is already terminal' } });
      return success({ resultType: 'complete', ...cancelled });
    }
    const updated = mcpTaskStore.updateInput(taskOwner, taskId, msg.params?.inputResponses);
    if (!updated) return reply({ jsonrpc: '2.0', id, error: { code: -32602, message: 'task is not awaiting input' } });
    return success({ resultType: 'complete', ...updated });
  }
  if (msg.method === 'ping') {
    return success(modern ? { resultType: 'complete' } : {});
  }
  return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } }, modern ? 404 : 200);
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
        identifier: 'urn:air:iostcallister.com:api:rest',
        urn: 'urn:air:iostcallister.com:api:rest',
        displayName: 'IOST Terminal REST API',
        type: 'application/openapi+json',
        url: `${SITE_URL}/openapi.json`,
        representativeQueries: ['market prices and AI trade scores', 'what API endpoints does the trading platform expose', 'autopilot proposals'],
      },
      {
        identifier: 'urn:air:iostcallister.com:mcp:terminal',
        urn: 'urn:air:iostcallister.com:mcp:terminal',
        displayName: 'IOST Terminal MCP server (private evaluation and paper-only trading)',
        type: 'application/vnd.mcp+json',
        url: `${SITE_URL}/.well-known/mcp/server-card.json`,
        representativeQueries: ['what tools does the IOST Terminal expose over MCP', 'get market snapshot', 'analyze a symbol'],
      },
      {
        identifier: 'urn:air:iostcallister.com:docs:llms',
        urn: 'urn:air:iostcallister.com:docs:llms',
        displayName: 'LLM-friendly index',
        type: 'text/markdown',
        url: `${SITE_URL}/llms.txt`,
        representativeQueries: ['what is IOST Terminal and how do I use it', 'platform overview for agents'],
      },
      {
        identifier: 'urn:air:iostcallister.com:auth:guide',
        urn: 'urn:air:iostcallister.com:auth:guide',
        displayName: 'Agent authentication guide',
        type: 'text/markdown',
        url: `${SITE_URL}/auth.md`,
        representativeQueries: ['how does an agent authenticate', 'API keys and OAuth scopes'],
      },
      {
        identifier: 'urn:air:iostcallister.com:skills:index',
        urn: 'urn:air:iostcallister.com:skills:index',
        displayName: 'Agent skills index',
        type: 'application/json',
        url: `${SITE_URL}/.well-known/agent-skills/index.json`,
        representativeQueries: ['skills for reading IOST Terminal data', 'agent skills available'],
      },
      {
        identifier: 'urn:air:iostcallister.com:manifest:agent',
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
app.get('/api/health', (req, res) => res.json({
  ok: true,
  name: 'IOST Terminal',
  revision: process.env.APP_REVISION || null,
  ts: Date.now(),
  watchlist: WATCHLIST,
}));

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
// GARCH vol state for a symbol — public read-only sizing info (how much).
app.get('/api/risk/garch', publicLimiter, async (req, res) => {
  const symbol = String(req.query.symbol || 'BTC').toUpperCase().slice(0, 12);
  try {
    const st = await getGarchState(symbol);
    res.json({ ok: true, config: garchConfig, ...st });
  }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/market/global', publicLimiter, async (req, res) => {
  try {
    const [base, cmc] = await Promise.all([getGlobalMetrics(), getCmcGlobal()]);
    res.json({ ok: true, ...base, cmc });
  }
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

app.post('/api/paper/preflight', requireUser, async (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'trade-paper')) {
    return res.status(403).json({ error: 'scope: this key cannot preflight paper execution (missing trade-paper)' });
  }
  try { res.json(await paperTradePreflight(req, req.body || {})); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post('/api/paper/open', requireUser, async (req, res) => {
  try {
    res.json(await executePaperOpen(req, req.body || {}, 'rest'));
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message, ...(e.reason ? { reason: e.reason } : {}),
      ...(e.receipt ? { receipt: e.receipt } : {}),
      ...(e.executionIntent ? { executionIntent: e.executionIntent } : {}),
    });
  }
});

app.post('/api/paper/close', requireUser, async (req, res) => {
  try {
    const r = await executePaperClose(req, req.body || {}, 'rest');
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
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message, ...(e.reason ? { reason: e.reason } : {}),
      ...(e.receipt ? { receipt: e.receipt } : {}),
      ...(e.executionIntent ? { executionIntent: e.executionIntent } : {}),
    });
  }
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
app.get('/api/execution-receipts', requireUser, (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'read')) return res.status(403).json({ error: 'read scope required' });
  res.json(executionReceipts.listExecutionReceipts(accountFor(req).accountId, req.query.limit));
});
app.get('/api/execution-intents', requireUser, (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'read')) return res.status(403).json({ error: 'read scope required' });
  res.json({ ok: true, mode: 'paper-only', intents: executionIntents.listExecutionIntents(accountFor(req).accountId, req.query.limit) });
});
app.get('/api/execution-intents/:intentId', requireUser, (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'read')) return res.status(403).json({ error: 'read scope required' });
  const intent = executionIntents.getExecutionIntent(accountFor(req).accountId, req.params.intentId);
  if (!intent) return res.status(404).json({ error: 'execution intent not found' });
  res.json({ ok: true, mode: 'paper-only', intent });
});

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

// Stable public identity; dynamic producer rank remains linked to IOSTScan
// instead of being copied into source where it would become stale.
app.get('/api/chain/identity', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, ...iostChainIdentity() });
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

// ================= Agent Trust Arena (paper-only) =================
// Arena performance can only be created through these routes. Both fills use
// fresh server market data, the venue is hard-coded to the paper broker, and
// every accepted open/close becomes a local SHA-256 hash-chain record. No
// token, stake, live venue or public-chain state participates in Arena scores.
app.get('/api/arena', publicLimiter, (req, res) => {
  const board = arena.leaderboard();
  res.status(board.ok ? 200 : 503).json(board);
});

app.get('/api/arena/agents/:agentId', publicLimiter, (req, res) => {
  const detail = arena.agentDetail(String(req.params.agentId || ''), req.query.limit);
  if (!detail) return res.status(404).json({ ok: false, error: 'Arena agent not found' });
  res.status(detail.ok ? 200 : 503).json(detail);
});

app.post('/api/arena/trades/open', requireUser, async (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'trade-paper')) return res.status(403).json({ error: 'scope: this key cannot trade (missing trade-paper)' });
  const ident = signalIdentity(req);
  const account = accountFor(req);
  if (!ident || !account) return res.status(401).json({ error: 'auth required' });
  const symbol = String(req.body?.symbol || '').toUpperCase();
  const side = req.body?.side === 'short' ? 'short' : req.body?.side === 'long' ? 'long' : null;
  const size = Number(req.body?.size);
  if (![...WATCHLIST.crypto, ...WATCHLIST.stocks].includes(symbol)) return res.status(400).json({ error: 'unsupported Arena symbol' });
  if (!side) return res.status(400).json({ error: 'side must be long or short' });
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'size must be a positive number' });

  let ticker;
  try { ticker = await getTicker(symbol); }
  catch (e) { return res.status(502).json({ error: `trusted market price unavailable: ${e.message}` }); }
  const entry = Number(ticker?.last);
  if (!Number.isFinite(entry) || entry <= 0) return res.status(502).json({ error: 'trusted market price unavailable' });
  const notionalMinor = Math.trunc(entry * size * 100);
  if (!Number.isSafeInteger(notionalMinor) || notionalMinor <= 0) return res.status(400).json({ error: 'Arena notional is invalid' });
  const gate = agentSpendGate(req, notionalMinor, {
    walletId: req.body?.walletId, pactId: req.body?.pactId,
    recipient: req.body?.recipient, protocol: req.body?.protocol,
  });
  if (!gate.ok) return res.status(402).json({ error: gate.message || gate.reason || 'agent spend denied', reason: gate.reason });

  let placed = null;
  let openEvidence = null;
  try {
    placed = await getBroker('paper').placeOrder({
      symbol, side, size, entry,
      stop: req.body?.stop, target: req.body?.target,
      reason: String(req.body?.reason || '').slice(0, 500),
      confidence: req.body?.confidence,
      accountId: account.accountId,
    });
    if (!placed.ok) {
      settleAgentSpend(gate, false);
      return res.status(400).json(placed);
    }
    openEvidence = arena.recordOpen({
      ...ident, accountId: account.accountId, trade: placed.position,
      priceProvider: ticker.source, reason: req.body?.reason, trail: req.body?.trail,
    });
    const settled = settleAgentSpend(gate, true);
    if (!settled.ok) {
      await closeTrade(placed.position.id, entry, account.accountId, 'Arena authorization settlement failed');
      try { arena.recordVoid({ openEvidence, reason: 'authorization settlement failed' }); } catch { /* remains unscored */ }
      return res.status(500).json({ error: 'agent authorization settlement failed' });
    }
    res.json({ ok: true, mode: 'paper', position: placed.position, evidence: { auditHash: openEvidence.hash, fillAuthority: 'server-market', priceProvider: ticker.source } });
  } catch (e) {
    if (placed?.ok) await closeTrade(placed.position.id, entry, account.accountId, 'Arena audit creation failed').catch(() => {});
    settleAgentSpend(gate, false);
    res.status(500).json({ ok: false, error: `Arena open failed closed: ${e.message}` });
  }
});

app.post('/api/arena/trades/:id/close', requireUser, async (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'trade-paper')) return res.status(403).json({ error: 'scope: this key cannot trade (missing trade-paper)' });
  const ident = signalIdentity(req);
  const account = accountFor(req);
  if (!ident || !account) return res.status(401).json({ error: 'auth required' });
  const tradeId = String(req.params.id || '');
  const position = getState(account.accountId).positions.find((p) => p.id === tradeId);
  if (!position) return res.status(404).json({ error: 'open Arena paper position not found' });
  const openEvidence = arena.getOpenEvidence({ agentId: ident.agentId, accountId: account.accountId, tradeId });
  if (!openEvidence) return res.status(403).json({ error: 'matching verified Arena open evidence required' });

  try {
    const ticker = await getTicker(position.symbol);
    const exitPrice = Number(ticker?.last);
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) return res.status(502).json({ error: 'trusted market price unavailable' });
    const closed = await closeTrade(tradeId, exitPrice, account.accountId, 'Arena server-market close');
    if (!closed.ok) return res.status(400).json(closed);
    const journal = getState(account.accountId).journal.find((j) => j.id === tradeId);
    const evidence = arena.recordClose({ openEvidence, journal, exitPrice, priceProvider: ticker.source });
    res.json({ ...closed, mode: 'paper', evidence: { auditHash: evidence.hash, auditSeq: evidence.seq, fillAuthority: 'server-market', priceProvider: ticker.source } });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Arena close failed closed: ${e.message}` });
  }
});

// ================= off-chain points (tokenomics vision §6) =================
// No token is issued. Points are accrual-only; 1:1 AITT conversion is PLANNED
// at TGE (honest label in the UI). Ledger: data/points.json (atomic writes).

// GET /api/points — balance + recent ledger + referral info (session user or X-API-Key)
app.get('/api/points', requireUser, async (req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ error: 'auth required' });
  const ownerId = ident.agentId;
  const code = points.ensureReferralCode(ownerId);
  const tokenInfo = await aitt.getLiveInfo();
  res.json({
    ok: true, ownerId, balance: points.getBalance(ownerId), ledger: points.getLedger(ownerId, 50),
    referralCode: code, referralLink: `${SITE_URL}/app?ref=${code}`,
    conversion: {
      rate: '1:1', token: 'AITT', spendable: false,
      status: tokenInfo.conversion.statusText,
      open: tokenInfo.conversion.open,
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
app.get('/api/aitt/info', async (req, res) => {
  res.json(await aitt.getLiveInfo());
});

// POST /api/points/claim — attempt points→AITT conversion (1:1) for the current
// principal. While the gate is closed it answers honestly and writes NOTHING.
app.post('/api/points/claim', requireUser, async (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'signed-in human account required' });
  const info = await aitt.getLiveInfo();
  if (!info.conversion.open) return res.status(400).json({ ok: false, error: 'conversion-not-open', message: info.conversion.statusText, conversion: info.conversion });
  const userId = `user:${req.session.userId}`;
  const binding = evmWallets.getBinding(userId);
  if (!binding) return res.status(400).json({ ok: false, error: 'verified EVM wallet binding required' });
  const available = aittClaims.availablePoints(userId);
  const requested = req.body?.points == null ? available : Math.trunc(Number(req.body.points));
  const idempotencyKey = String(req.body?.idempotencyKey || req.get('idempotency-key') || '').trim();
  const r = aittClaims.reserveClaim({ userId, evmAddress: binding.address, points: requested, idempotencyKey });
  res.status(r.ok ? 202 : 400).json(r);
});

// EIP-191 MetaMask binding — session user only; no payment/transaction authority.
app.get('/api/aitt/wallet', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'signed-in human account required' });
  res.json({ ok: true, binding: evmWallets.getBinding(`user:${req.session.userId}`) });
});
app.post('/api/aitt/wallet/challenge', authLimiter, requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'signed-in human account required' });
  try { res.json({ ok: true, ...evmWallets.createChallenge({ userId: `user:${req.session.userId}`, address: req.body?.address }) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/aitt/wallet/verify', authLimiter, requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'signed-in human account required' });
  const r = evmWallets.verifyChallenge({ challengeId: req.body?.challengeId, signature: req.body?.signature, expectedUserId: `user:${req.session.userId}` });
  res.status(r.ok ? 200 : 400).json(r);
});
app.get('/api/aitt/claims', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'signed-in human account required' });
  const userId = `user:${req.session.userId}`;
  res.json({ ok: true, availablePoints: aittClaims.availablePoints(userId), converterAddress: aitt.getInfo().converterAddress || null, claims: aittClaims.listClaims(userId) });
});

// Read-only owner operations dashboard. It exposes release-gate evidence and the
// reconciliation queue, but deliberately has no deploy, gate-flip or key input.
app.get('/api/admin/aitt/status', requireUser, async (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const info = await aitt.getLiveInfo();
  res.json({
    ok: true,
    status: info.status,
    releaseGate: info.conversion.releaseGate,
    trading: info.trading,
    contracts: {
      token: info.contractAddress || null,
      converter: info.converterAddress || null,
    },
    claims: aittClaims.listClaims(),
  });
});
app.post('/api/aitt/claims/:id/reconcile', requireUser, async (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'signed-in human account required' });
  try {
    const userId = `user:${req.session.userId}`;
    const claim = aittClaims.getClaim(req.params.id);
    const converterAddress = aitt.getInfo().converterAddress;
    if (!claim || claim.userId !== userId || !converterAddress) return res.status(404).json({ ok: false, error: 'claim or converter not found' });
    const receipt = await aittChain.fetchReceipt(req.body?.txHash);
    const proof = aittChain.verifyConversionReceipt({ receipt, converterAddress, user: claim.evmAddress, amount: BigInt(claim.baseUnits) });
    if (!proof.ok) return res.status(400).json(proof);
    const r = aittClaims.confirmClaimedOnchain({ claimId: claim.id, txHash: req.body.txHash, blockNumber: proof.blockNumber });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Owner reconciliation endpoints. Operator automation must verify chain receipts
// before invoking these transitions; no private key is accepted by this API.
app.post('/api/admin/aitt/claims/:id/approved', requireUser, async (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  try {
    const claim = aittClaims.getClaim(req.params.id);
    const converterAddress = aitt.getInfo().converterAddress;
    if (!claim || !converterAddress) return res.status(400).json({ ok: false, error: 'claim or converter not configured' });
    const receipt = await aittChain.fetchReceipt(req.body?.txHash);
    const expectedApproval = BigInt(req.body?.expectedApprovalBaseUnits || 0);
    if (expectedApproval <= 0n) return res.status(400).json({ ok: false, error: 'expected cumulative approval from signed manifest required' });
    const state = await aittChain.fetchConverterAccountState(converterAddress, claim.evmAddress);
    if (state.approved !== expectedApproval) return res.status(400).json({ ok: false, error: 'on-chain cumulative approval mismatch' });
    const proof = aittChain.verifyApprovalReceipt({ receipt, converterAddress, user: claim.evmAddress, amount: expectedApproval });
    if (!proof.ok) return res.status(400).json(proof);
    const r = aittClaims.markApprovedOnchain({ claimId: claim.id, txHash: req.body.txHash, blockNumber: proof.blockNumber, expectedApprovalBaseUnits: expectedApproval.toString() });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/admin/aitt/claims/:id/confirmed', requireUser, async (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  try {
    const claim = aittClaims.getClaim(req.params.id);
    const converterAddress = aitt.getInfo().converterAddress;
    if (!claim || !converterAddress) return res.status(400).json({ ok: false, error: 'claim or converter not configured' });
    const receipt = await aittChain.fetchReceipt(req.body?.txHash);
    const proof = aittChain.verifyConversionReceipt({ receipt, converterAddress, user: claim.evmAddress, amount: BigInt(claim.baseUnits) });
    if (!proof.ok) return res.status(400).json(proof);
    const r = aittClaims.confirmClaimedOnchain({ claimId: claim.id, txHash: req.body.txHash, blockNumber: proof.blockNumber });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/admin/aitt/claims/:id/release', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  const r = aittClaims.releaseClaim({ claimId: req.params.id, reason: req.body?.reason });
  res.status(r.ok ? 200 : 400).json(r);
});

// ================= Phase 2 — agent wallet engine (off-chain first) =================
// Design: docs/PHASE2_SPEC.md. Works before the token deploys; on-chain escrow in
// Phase 3. Agent execution fails closed without an owned wallet and active Pact.
// All money in INTEGER MINOR UNITS (cents) unless stated.

const h = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } };

function launchpadSnapshot(req) {
  const ident = signalIdentity(req);
  const ownerId = ident?.agentId;
  const parent = wallets.ensureUserWallet(ownerId);
  const tree = wallets.walletTree(ownerId);
  const launchpadWallets = tree.agents.filter((wallet) => wallet.origin === 'self-service-launchpad');
  const ownerPacts = pacts.listPacts(ownerId);
  const keys = agentKeys.listKeys(req.session.userId);
  const lifetimeGrantedMinor = Math.max(0, Math.trunc(Number(parent.paperOnboardingGrantedMinor) || 0));
  const remainingGrantMinor = Math.max(0, wallets.PAPER_ONBOARDING_CREDIT_CAP_MINOR - lifetimeGrantedMinor);
  return {
    ok: true,
    mode: 'paper-only',
    executionBoundary: 'PAPER_ONLY',
    mcpEndpoint: `${SITE_URL}/mcp`,
    credit: {
      lifetimeCapMinor: wallets.PAPER_ONBOARDING_CREDIT_CAP_MINOR,
      lifetimeGrantedMinor,
      remainingGrantMinor,
      parentBalanceMinor: wallets.balanceOf(parent.walletId),
      cashValue: false,
      withdrawable: false,
    },
    keys,
    wallets: launchpadWallets.map((wallet) => ({
      walletId: wallet.walletId,
      name: wallet.name,
      status: wallet.status,
      balanceMinor: wallets.balanceOf(wallet.walletId),
      limits: wallet.limits,
      capabilities: wallet.capabilities,
      approvalRequired: wallet.approvalRequired,
      usage: limits.usageSnapshot(wallet.walletId),
    })),
    pacts: ownerPacts.filter((pact) => launchpadWallets.some((wallet) => wallet.walletId === pact.agentWalletId)).map((pact) => ({
      pactId: pact.pactId,
      agentWalletId: pact.agentWalletId,
      intent: pact.intent,
      status: pact.status,
      expiresAt: pact.expiresAt,
      completion: pact.completion,
      spentMinor: pact.spentMinor,
      policies: { approvalRequired: pact.policies?.approvalRequired ?? true, limits: pact.policies?.limits || null },
    })),
    status: {
      keyReady: keys.some((key) => !key.revokedAt && key.scopes.includes('trade-paper')),
      walletReady: launchpadWallets.some((wallet) => wallet.status === 'active' && wallet.capabilities.includes('trade.paper')),
      pactReady: ownerPacts.some((pact) => pact.status === 'active' && launchpadWallets.some((wallet) => wallet.walletId === pact.agentWalletId)),
    },
  };
}

// Self-service Agent Launchpad. Only a signed-in human session may bootstrap
// authority. Agent keys cannot create/fund their own wallet or approve a Pact.
app.get('/api/agent-launchpad', requireUser, h((req, res) => {
  if (!req.session?.userId || req.userAgent || req.agentKey) return res.status(403).json({ ok: false, error: 'agent keys cannot set up or approve a Launchpad' });
  res.json(launchpadSnapshot(req));
}));

function proposeLaunchpadPact({ ownerId, wallet, name, perOrderMinor, expiryHours }) {
  return pacts.proposePact({
    ownerId,
    agentWalletId: wallet.walletId,
    intent: `Allow ${name} to place bounded paper trades for evaluation`,
    plan: [{ step: 'Read market evidence.' }, { step: 'Open or close a simulated position within the approved limits.' }, { step: 'Write the result to the paper journal and decision trace.' }],
    policies: { approvalRequired: true, limits: { maxPerTxMinor: perOrderMinor }, whitelist: { recipients: [], protocols: [] } },
    completion: { type: 'time', deadlineTs: Date.now() + expiryHours * 3600_000 },
  });
}

app.post('/api/agent-launchpad/setup', requireUser, h((req, res) => {
  if (!req.session?.userId || req.userAgent || req.agentKey) return res.status(403).json({ ok: false, error: 'agent keys cannot set up or approve a Launchpad' });
  const ident = signalIdentity(req);
  const ownerId = ident.agentId;
  const name = String(req.body?.name || 'My Paper Agent').trim().slice(0, 60);
  const fundMinor = Math.trunc(Number(req.body?.fundMinor ?? 10_000));
  const perOrderMinor = Math.trunc(Number(req.body?.perOrderMinor ?? 2_500));
  const dailyMinor = Math.trunc(Number(req.body?.dailyMinor ?? 5_000));
  const expiryHours = Math.trunc(Number(req.body?.expiryHours ?? 24));
  if (!name) return res.status(400).json({ ok: false, error: 'agent name required' });
  if (!Number.isSafeInteger(fundMinor) || fundMinor < 100 || fundMinor > wallets.PAPER_ONBOARDING_CREDIT_CAP_MINOR) return res.status(400).json({ ok: false, error: 'paper funding must be between $1 and $100' });
  if (!Number.isSafeInteger(perOrderMinor) || perOrderMinor < 100 || perOrderMinor > fundMinor) return res.status(400).json({ ok: false, error: 'per-order limit must be between $1 and the funded amount' });
  if (!Number.isSafeInteger(dailyMinor) || dailyMinor < perOrderMinor || dailyMinor > fundMinor) return res.status(400).json({ ok: false, error: 'daily limit must cover one order and cannot exceed funded paper credits' });
  if (!Number.isSafeInteger(expiryHours) || expiryHours < 1 || expiryHours > 168) return res.status(400).json({ ok: false, error: 'Pact expiry must be between 1 and 168 hours' });

  const parent = wallets.ensureUserWallet(ownerId);
  let wallet = wallets.walletTree(ownerId).agents.find((candidate) => candidate.origin === 'self-service-launchpad') || null;
  const existing = !!wallet;
  if (!wallet) {
    const neededParentCredit = Math.max(0, fundMinor - wallets.balanceOf(parent.walletId));
    if (neededParentCredit) wallets.grantPaperOnboardingCredits(ownerId, neededParentCredit);
    wallet = wallets.createAgentWallet({
      ownerId,
      name,
      origin: 'self-service-launchpad',
      limits: { USD: { maxPerTxMinor: perOrderMinor, dailyCapMinor: dailyMinor, weeklyCapMinor: fundMinor } },
      capabilities: ['trade.paper'],
      approvalRequired: true,
    });
  }
  const walletFundingNeeded = Math.max(0, fundMinor - wallets.balanceOf(wallet.walletId));
  if (walletFundingNeeded) {
    const parentShortfall = Math.max(0, walletFundingNeeded - wallets.balanceOf(parent.walletId));
    if (parentShortfall) wallets.grantPaperOnboardingCredits(ownerId, parentShortfall);
    wallets.fundAgentWallet({ walletId: wallet.walletId, amountMinor: walletFundingNeeded });
  }
  let pact = pacts.listPacts(ownerId).find((candidate) => candidate.agentWalletId === wallet.walletId && ['proposed', 'active'].includes(candidate.status)) || null;
  if (!pact) {
    pact = proposeLaunchpadPact({ ownerId, wallet, name, perOrderMinor, expiryHours });
  }
  logLiveEvent(req.session.userId, 'agent.launchpad.setup', { walletId: wallet.walletId, pactId: pact.pactId, existing, mode: 'paper-only' });
  res.status(existing ? 200 : 201).json({ ...launchpadSnapshot(req), setup: { existing, walletId: wallet.walletId, pactId: pact.pactId } });
}));

// Re-authorize an existing Launchpad wallet after its prior Pact ended. This
// does not mint credits or change wallet policy; it only proposes a fresh,
// time-limited agreement for the human owner to review separately.
app.post('/api/agent-launchpad/pact', requireUser, h((req, res) => {
  if (!req.session?.userId || req.userAgent || req.agentKey) return res.status(403).json({ ok: false, error: 'agent keys cannot set up or approve a Launchpad' });
  const ownerId = signalIdentity(req).agentId;
  const wallet = wallets.walletTree(ownerId).agents.find((candidate) => candidate.origin === 'self-service-launchpad');
  if (!wallet) return res.status(404).json({ ok: false, error: 'Launchpad wallet not found' });
  const openPact = pacts.listPacts(ownerId).find((candidate) => candidate.agentWalletId === wallet.walletId && ['proposed', 'active'].includes(candidate.status));
  if (openPact) return res.status(409).json({ ok: false, error: 'this Launchpad wallet already has an open Pact' });
  const expiryHours = Math.trunc(Number(req.body?.expiryHours ?? 24));
  if (!Number.isSafeInteger(expiryHours) || expiryHours < 1 || expiryHours > 168) return res.status(400).json({ ok: false, error: 'Pact expiry must be between 1 and 168 hours' });
  const perOrderMinor = Math.max(1, Math.trunc(Number(wallet.limits?.USD?.maxPerTxMinor) || 1));
  const pact = proposeLaunchpadPact({ ownerId, wallet, name: wallet.name, perOrderMinor, expiryHours });
  logLiveEvent(req.session.userId, 'agent.launchpad.pact.proposed', { walletId: wallet.walletId, pactId: pact.pactId, mode: 'paper-only' });
  res.status(201).json({ ...launchpadSnapshot(req), setup: { existing: true, walletId: wallet.walletId, pactId: pact.pactId } });
}));

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
  if (!ident) return res.status(401).json({ ok: false, error: 'auth required' });
  const s = stakes.getStake(req.body?.stakeId);
  if (!s) return res.status(404).json({ ok: false, error: 'stake not found' });
  if (s.ownerId !== ident.agentId) return res.status(403).json({ ok: false, error: 'not your stake' });
  res.json({ ok: true, stake: stakes.requestUnstake(req.body?.stakeId) });
}));
// POST /api/stake/withdraw {stakeId} — after cooldown
app.post('/api/stake/withdraw', requireUser, h((req, res) => {
  const ident = signalIdentity(req);
  if (!ident) return res.status(401).json({ ok: false, error: 'auth required' });
  const s = stakes.getStake(req.body?.stakeId);
  if (!s) return res.status(404).json({ ok: false, error: 'stake not found' });
  if (s.ownerId !== ident.agentId) return res.status(403).json({ ok: false, error: 'not your stake' });
  res.json({ ok: true, stake: stakes.withdraw(req.body?.stakeId) });
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
  const ident = signalIdentity(req);
  const s = slashes.getSlash(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'slash not found' });
  if (!ident || s.ownerId !== ident.agentId) return res.status(403).json({ ok: false, error: 'not your slash' });
  res.json({ ok: true, slash: slashes.fileAppeal(req.params.id, req.body?.statement) });
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
function sessionOwnsPact(req, pact) {
  return !!(pact && req.session?.userId && !req.userAgent && !req.agentKey
    && pact.ownerId === `user:${req.session.userId}`);
}

function canManagePact(req, pact) {
  return isOwnerSession(req) || sessionOwnsPact(req, pact);
}

// POST /api/pacts/:id/approve | /reject | /terminate — human control.
// A normal signed-in user may manage only a Pact stored under that user's
// account identity. Agent credentials can never approve their own authority.
app.post('/api/pacts/:id/approve', requireUser, h((req, res) => {
  if (req.userAgent || req.agentKey) return res.status(403).json({ ok: false, error: 'agent keys cannot set up or approve a Launchpad' });
  const pact = pacts.getPact(req.params.id);
  if (!pact || !canManagePact(req, pact)) return res.status(404).json({ ok: false, error: 'pact not found' });
  res.json({ ok: true, pact: pacts.approvePact(req.params.id, isOwnerSession(req) ? 'platform-owner' : 'account-owner') });
}));
app.post('/api/pacts/:id/reject', requireUser, h((req, res) => {
  if (req.userAgent || req.agentKey) return res.status(403).json({ ok: false, error: 'agent keys cannot set up or approve a Launchpad' });
  const pact = pacts.getPact(req.params.id);
  if (!pact || !canManagePact(req, pact)) return res.status(404).json({ ok: false, error: 'pact not found' });
  res.json({ ok: true, pact: pacts.rejectPact(req.params.id, isOwnerSession(req) ? 'platform-owner' : 'account-owner') });
}));
app.post('/api/pacts/:id/terminate', requireUser, h((req, res) => {
  if (req.userAgent || req.agentKey) return res.status(403).json({ ok: false, error: 'agent keys cannot set up or approve a Launchpad' });
  const pact = pacts.getPact(req.params.id);
  if (!pact || !canManagePact(req, pact)) return res.status(404).json({ ok: false, error: 'pact not found' });
  res.json({ ok: true, pact: pacts.terminatePact(req.params.id, isOwnerSession(req) ? 'platform-owner' : 'account-owner') });
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
  const { walletId, amountMinor, purpose, pactId, recipient, protocol } = req.body || {};
  const gate = walletOwnedBy(req, walletId);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  if (!pactId) return res.status(400).json({ ok: false, error: 'pactId required' });
  const w = wallets.getWallet(walletId);
  const pactGate = pacts.checkPactSpend({ pactId, walletId, ownerId: w.ownerId, amountMinor, recipient, protocol });
  if (!pactGate.ok) return res.status(402).json(pactGate);
  res.json(limits.checkSpend({ walletId, amountMinor, purpose }));
}));
app.post('/api/spend/reserve', requireUser, h((req, res) => {
  const { walletId, amountMinor, purpose, pactId, recipient, protocol } = req.body || {};
  const gate = walletOwnedBy(req, walletId);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  if (!pactId) return res.status(400).json({ ok: false, error: 'pactId required' });
  const w = wallets.getWallet(walletId);
  const pactGate = pacts.checkPactSpend({ pactId, walletId, ownerId: w.ownerId, amountMinor, recipient, protocol });
  if (!pactGate.ok) return res.status(402).json(pactGate);
  const reservation = limits.reserveSpend({ walletId, amountMinor, purpose, pactId, recipient, protocol });
  if (!reservation.ok) return res.status(402).json(reservation);
  const pactReservation = pacts.reservePactSpend({ pactId, reservationId: reservation.reserveId, walletId, ownerId: w.ownerId, amountMinor, recipient, protocol });
  if (!pactReservation.ok) {
    limits.releaseReserve({ walletId, reserveId: reservation.reserveId });
    return res.status(402).json(pactReservation);
  }
  res.json(reservation);
}));
app.post('/api/spend/commit', requireUser, h((req, res) => {
  const { walletId, reserveId } = req.body || {};
  const gate = walletOwnedBy(req, walletId);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  const pending = limits.getReservation({ walletId, reserveId });
  if (!pending) return res.status(400).json({ ok: false, error: 'reservation not found' });
  if (!pending.pactId) return res.status(400).json({ ok: false, error: 'reservation has no pact authorization' });
  if (wallets.balanceOf(walletId) < pending.amount) return res.status(402).json({ ok: false, error: 'insufficient wallet balance' });
  // commitReserve returns the settled amount; captured BEFORE the reserve record is cleared
  const r = limits.commitReserve({ walletId, reserveId });
  if (r.ok) {
    // The pact identity comes from the server-side reservation, never the commit request.
    const debit = wallets.debitWallet(walletId, r.amount);
    const pactCommit = pacts.commitPactReservation(r.pactId, reserveId);
    if (!pactCommit.ok) return res.status(500).json({ ok: false, error: 'pact reservation settlement failed' });
    res.json({ ok: true, debit });
  } else {
    res.status(400).json(r);
  }
}));
app.post('/api/spend/release', requireUser, h((req, res) => {
  const { walletId, reserveId } = req.body || {};
  const gate = walletOwnedBy(req, walletId);
  if (gate) return res.status(gate.status).json({ ok: false, error: gate.error });
  const pending = limits.getReservation({ walletId, reserveId });
  const released = limits.releaseReserve({ walletId, reserveId });
  if (released.ok && pending?.pactId) pacts.releasePactReservation(pending.pactId, reserveId);
  res.json(released);
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

// Agent execution rail: platform and per-user agent credentials must present a
// wallet-bound active Pact. This is a security invariant, not a feature flag.
function agentSpendGate(req, notionalMinor, { walletId = null, pactId = null, recipient = null, protocol = null } = {}) {
  if (!(req.agentKey || req.userAgent)) return { ok: true }; // human session = the approver
  if (!notionalMinor || notionalMinor <= 0) {
    return { ok: false, reason: 'trusted-entry-required', message: 'Agent orders require a positive entry and size for server-side spend authorization.' };
  }
  const w = findAgentWalletForRequest(req, walletId);
  if (!w) {
    return { ok: false, reason: 'agent-wallet-required', message: 'An owned agent wallet is required for agent execution.' };
  }
  if (!(w.capabilities || []).includes('trade.paper')) {
    return { ok: false, reason: 'wallet-capability-required', message: 'The selected wallet is not authorized for paper trading.' };
  }
  if (!pactId) return { ok: false, reason: 'pact-required', message: 'An active wallet-bound Pact is required for agent execution.' };
  const pactGate = pacts.checkPactSpend({ pactId, walletId: w.walletId, ownerId: w.ownerId, amountMinor: notionalMinor, recipient, protocol });
  if (!pactGate.ok) return pactGate;
  const reservation = limits.reserveSpend({ walletId: w.walletId, amountMinor: notionalMinor, purpose: req.path, pactId, recipient, protocol });
  if (!reservation.ok) return reservation;
  const pactReservation = pacts.reservePactSpend({ pactId, reservationId: reservation.reserveId, walletId: w.walletId, ownerId: w.ownerId, amountMinor: notionalMinor, recipient, protocol });
  if (!pactReservation.ok) {
    limits.releaseReserve({ walletId: w.walletId, reserveId: reservation.reserveId });
    return pactReservation;
  }
  return { ok: true, reserveId: reservation.reserveId, walletId: w.walletId, pactId };
}

// Non-mutating counterpart to agentSpendGate. Preflight must never create a
// spend/Pact reservation, receipt, execution intent, position or chain action.
function agentSpendPreflight(req, notionalMinor, { walletId = null, pactId = null, recipient = null, protocol = null } = {}) {
  const agentPrincipal = !!(req.agentKey || req.userAgent);
  const base = {
    tradePaperScope: !req.userAgent || userAgentHas(req, 'trade-paper'),
    walletPactRequired: agentPrincipal,
    walletOwned: !agentPrincipal,
    walletActive: !agentPrincipal,
    walletTradePaper: !agentPrincipal,
    walletLimitsAuthorized: !agentPrincipal,
    pactAuthorized: !agentPrincipal,
    remainingDailyMinor: null,
    remainingWeeklyMinor: null,
  };
  if (!agentPrincipal) return { ...base, ok: true };
  if (!base.tradePaperScope) return { ...base, ok: false, reason: 'trade-paper-scope-required' };
  if (!Number.isSafeInteger(notionalMinor) || notionalMinor <= 0) {
    return { ...base, ok: false, reason: 'trusted-entry-required' };
  }
  const wallet = findAgentWalletForRequest(req, walletId);
  if (!wallet) return { ...base, ok: false, reason: 'agent-wallet-required' };
  base.walletOwned = true;
  base.walletActive = wallet.status === 'active';
  if (!base.walletActive) return { ...base, ok: false, reason: 'wallet-suspended' };
  base.walletTradePaper = wallet.capabilities?.includes('trade.paper') === true;
  if (!base.walletTradePaper) return { ...base, ok: false, reason: 'wallet-capability-required' };
  const walletGate = limits.previewSpend({ walletId: wallet.walletId, amountMinor: notionalMinor, purpose: '/api/paper/preflight' });
  base.walletLimitsAuthorized = walletGate.ok === true;
  base.remainingDailyMinor = Number.isSafeInteger(walletGate.remainingDailyMinor) && walletGate.remainingDailyMinor >= 0
    ? Math.max(0, walletGate.remainingDailyMinor - notionalMinor) : null;
  base.remainingWeeklyMinor = Number.isSafeInteger(walletGate.remainingWeeklyMinor) && walletGate.remainingWeeklyMinor >= 0
    ? Math.max(0, walletGate.remainingWeeklyMinor - notionalMinor) : null;
  if (!walletGate.ok) return { ...base, ok: false, reason: walletGate.reason || 'wallet-limit-denied' };
  if (!pactId) return { ...base, ok: false, reason: 'pact-required' };
  const pactGate = pacts.previewPactSpend({
    pactId, walletId: wallet.walletId, ownerId: wallet.ownerId,
    amountMinor: notionalMinor, recipient, protocol,
  });
  base.pactAuthorized = pactGate.ok === true;
  if (!pactGate.ok) return { ...base, ok: false, reason: pactGate.reason || 'pact-denied' };
  return { ...base, ok: true };
}

async function paperTradePreflight(req, order = {}) {
  const symbol = String(order?.symbol || '').trim().toUpperCase();
  const supportedSymbols = [...WATCHLIST.crypto, ...WATCHLIST.stocks];
  let ticker = null;
  if (supportedSymbols.includes(symbol)) {
    try {
      ticker = await getExecutionTicker(symbol, order?.side, Date.now());
    } catch { /* unavailable quote fails closed in the decision */ }
  }
  const agentPrincipal = !!(req.agentKey || req.userAgent);
  const suppliedEntry = Number(order?.entry);
  const effectiveOrder = !agentPrincipal && !(suppliedEntry > 0) && Number(ticker?.last) > 0
    ? { ...order, entry: Number(ticker.last) }
    : order;
  const now = Date.now();
  const size = Number(effectiveOrder?.size);
  const side = effectiveOrder?.side === 'short' ? 'short' : 'long';
  const fillPrice = Number(side === 'short' ? ticker?.bid : ticker?.ask) || Number(ticker?.last) || 0;
  const notionalMinor = fillPrice > 0 && Number.isFinite(size) && size > 0
    ? Math.ceil(fillPrice * size * 100) : 0;
  const authorization = agentSpendPreflight(req, notionalMinor, {
    walletId: effectiveOrder?.walletId, pactId: effectiveOrder?.pactId,
    recipient: effectiveOrder?.recipient, protocol: effectiveOrder?.protocol,
  });
  const ownerId = missionOwnerId(req);
  const missionId = String(effectiveOrder?.missionId || '').trim();
  const mission = missionId ? missions.previewMissionTrade({
    missionId, ownerId, walletId: effectiveOrder?.walletId, pactId: effectiveOrder?.pactId,
    symbol, notionalMinor,
  }) : null;
  let accountId = 'default';
  if (req.session?.userId && auth.findById(req.session.userId)) accountId = `user:${req.session.userId}`;
  else if (req.userAgent?.userId) accountId = `user:${req.userAgent.userId}`;
  const account = getAccount(accountId);
  const accountState = account || {
    account: { initialCash: 100_000, cash: 100_000 }, positions: [], journal: [],
  };
  const portfolioRisk = buildPortfolioRiskDecision({
    account: accountState.account,
    positions: accountState.positions || [],
    journal: accountState.journal || [],
    order: effectiveOrder,
    fillPrice,
    requireProtectiveStop: agentPrincipal,
    volatility: peekGarchState(symbol),
    now,
  });
  return buildPaperTradePreflight({
    order: effectiveOrder, ticker, cashUsd: accountState.account.cash,
    authorization, mission, accountScope: accountId,
    portfolioRisk,
    supportedSymbols, now, bindingSecret: PAPER_PREFLIGHT_BINDING_SECRET,
  });
}

// A per-user agent key may use a paper wallet created by that same signed-in
// user in Agent Control Center. Older key-specific wallets remain supported.
// The fallback is limited to user keys; platform keys never inherit a user
// wallet, and callers still must name the exact active wallet-bound Pact.
function agentWalletOwnerIds(req) {
  const ids = [];
  const ident = signalIdentity(req);
  if (ident?.agentId) ids.push(ident.agentId);
  if (req.userAgent?.userId) ids.push(`user:${req.userAgent.userId}`);
  return [...new Set(ids)];
}

function findAgentWalletForRequest(req, walletId = null) {
  const owners = agentWalletOwnerIds(req);
  if (!owners.length) return null;
  if (walletId) {
    const wallet = wallets.getWallet(walletId);
    return wallet?.kind === 'agent' && owners.includes(wallet.ownerId) ? wallet : null;
  }
  const candidates = owners.flatMap((ownerId) => wallets.walletTree(ownerId).agents
    .map((wallet) => wallets.getWallet(wallet.walletId)).filter(Boolean));
  // Discovery without an explicit wallet must return a usable authorization
  // pair, not merely the oldest wallet. This matters when an account created a
  // wallet before using Launchpad. Explicit execution requests remain bound to
  // their caller-supplied walletId and Pact id through agentSpendGate.
  const activePactWalletIds = new Set(owners.flatMap((ownerId) => pacts.listPacts(ownerId)
    .filter((pact) => pact.status === 'active').map((pact) => pact.agentWalletId)));
  return candidates.find((wallet) => wallet.status === 'active'
      && wallet.capabilities?.includes('trade.paper') && activePactWalletIds.has(wallet.walletId))
    || candidates.find((wallet) => wallet.status === 'active' && wallet.capabilities?.includes('trade.paper'))
    || candidates.find((wallet) => wallet.status === 'active')
    || candidates[0]
    || null;
}

function settleAgentSpend(gate, commit) {
  if (!gate?.reserveId) return { ok: true };
  if (!commit) {
    const limitRelease = limits.releaseReserve({ walletId: gate.walletId, reserveId: gate.reserveId });
    const pactRelease = pacts.releasePactReservation(gate.pactId, gate.reserveId);
    return { ok: limitRelease.ok && pactRelease.ok };
  }
  const limitCommit = limits.commitReserve({ walletId: gate.walletId, reserveId: gate.reserveId });
  if (!limitCommit.ok) return { ok: false };
  const pactCommit = pacts.commitPactReservation(gate.pactId, gate.reserveId);
  return { ok: pactCommit.ok };
}

function receiptPrincipal(req) {
  if (req.userAgent) return 'user-agent';
  if (req.agentKey) return 'platform-agent';
  return 'human-session';
}

function beginPaperReceipt(req, order, action, source) {
  const startedAt = Date.now();
  const symbol = String(order?.symbol || '').trim().toUpperCase();
  return {
    accountId: accountFor(req).accountId,
    action,
    source,
    startedAt,
    authorizationMs: 0,
    brokerMs: 0,
    settlementMs: 0,
    market: executionReceipts.marketEvidence({
      ticker: peekTicker(symbol, startedAt),
      requestedEntry: order?.entry,
      side: order?.side,
      size: order?.size,
      now: startedAt,
    }),
    request: {
      symbol,
      side: order?.side,
      size: order?.size,
      requestedEntry: order?.entry,
      requestedNotionalUsd: Number(order?.entry || 0) * Number(order?.size || 0),
      confidence: order?.confidence,
      reasoningSummary: order?.reason,
      missionAttached: !!String(order?.missionId || '').trim(),
      missionId: String(order?.missionId || '').trim() || null,
      positionId: order?.positionId || null,
      intentProtected: !!String(order?.intentId || '').trim(),
      intentId: String(order?.intentId || '').trim() || null,
      preflightProtected: !!String(order?.preflightFingerprint || '').trim(),
      preflightFingerprint: String(order?.preflightFingerprint || '').trim().toLowerCase() || null,
    },
    preflightRequired: action === 'open' && (source === 'mcp' || !!req.userAgent || !!req.agentKey),
    preflightAuthorized: action !== 'open' || !(source === 'mcp' || req.userAgent || req.agentKey),
    portfolioRisk: null,
  };
}

function writePaperReceipt(req, attempt, {
  outcome, execution, gate = null, missionAuthorized = false,
  reasonCode = null, detail = null, decision = null,
} = {}) {
  const agentCredential = !!(req.userAgent || req.agentKey);
  return executionReceipts.recordExecutionReceipt({
    accountId: attempt.accountId,
    action: attempt.action,
    outcome,
    request: attempt.request,
    market: attempt.market,
    portfolioRisk: attempt.portfolioRisk,
    execution,
    authorization: {
      principal: receiptPrincipal(req),
      tradePaperScope: req.userAgent ? userAgentHas(req, 'trade-paper') : true,
      walletPactRequired: agentCredential && attempt.action === 'open',
      walletPactAuthorized: attempt.action === 'close' || !agentCredential || gate?.ok === true,
      missionRequired: attempt.request.missionAttached,
      missionAuthorized: !attempt.request.missionAttached || missionAuthorized,
      preflightRequired: attempt.preflightRequired === true,
      preflightAuthorized: attempt.preflightAuthorized === true,
    },
    policy: {
      decision: decision || (outcome === 'accepted' ? 'allow' : 'deny'),
      reasonCode,
      detail,
    },
    latency: {
      totalMs: Date.now() - attempt.startedAt,
      authorizationMs: attempt.authorizationMs,
      brokerMs: attempt.brokerMs,
      settlementMs: attempt.settlementMs,
    },
  });
}

function rejectedPaperError(message, status, reason, receipt = null) {
  return Object.assign(new Error(message), { status, reason, ...(receipt ? { receipt } : {}) });
}

function paperExecutionIntentId(req, order, source) {
  const bodyId = String(order?.intentId || '').trim();
  const headerId = source === 'rest' ? String(req.get('idempotency-key') || '').trim() : '';
  if (bodyId && headerId && bodyId !== headerId) {
    throw Object.assign(new Error('execution intent header and body must match'), {
      status: 400, reason: 'execution-intent-mismatch',
    });
  }
  const intentId = bodyId || headerId;
  if (intentId) return intentId;
  if (source === 'mcp' || req.userAgent || req.agentKey) {
    throw Object.assign(new Error('execution intent id required'), {
      status: 400, reason: 'execution-intent-required',
    });
  }
  return `auto_${crypto.randomBytes(16).toString('hex')}`;
}

function paperIntentRequest(order, action) {
  if (action === 'close') return { positionId: String(order?.positionId || '') };
  return Object.fromEntries(Object.entries(order || {})
    .filter(([key]) => !['intentId', 'idempotencyKey'].includes(key)));
}

function missingPaperExecutionScope(req, source) {
  return source === 'mcp'
    ? (!req.userAgent || !userAgentHas(req, 'trade-paper'))
    : (req.userAgent && !userAgentHas(req, 'trade-paper'));
}

function preflightBindingError(req, attempt, message, status, reason, detail = message) {
  const receipt = writePaperReceipt(req, attempt, {
    outcome: 'rejected', execution: { status: 'not-filled' },
    reasonCode: reason, detail,
  });
  throw rejectedPaperError(message, status, reason, receipt);
}

async function enforcePaperPreflightBinding(req, order, source, attempt) {
  const required = source === 'mcp' || !!req.userAgent || !!req.agentKey;
  const supplied = String(order?.preflightFingerprint || '').trim().toLowerCase();
  if (!supplied) {
    if (required) {
      preflightBindingError(req, attempt, 'paper execution preflight fingerprint required', 428,
        'preflight-fingerprint-required');
    }
  }
  if (supplied && !/^[a-f0-9]{64}$/.test(supplied)) {
    preflightBindingError(req, attempt, 'paper execution preflight fingerprint invalid', 400,
      'preflight-fingerprint-invalid');
  }

  const current = await paperTradePreflight(req, order);
  attempt.portfolioRisk = current.portfolioRisk || null;
  if (current.decision !== 'allow') {
    preflightBindingError(req, attempt, 'paper execution preflight no longer allows this request', 409,
      'preflight-denied', `Current preflight denied: ${current.reasonCode || 'policy-denied'}.`);
  }
  if (supplied) {
    const expected = String(current.preflightFingerprint || '');
    const matches = /^[a-f0-9]{64}$/.test(expected)
      && crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
    if (!matches) {
      preflightBindingError(req, attempt, 'paper execution preflight evidence changed', 409,
        'preflight-evidence-changed', 'The order, quote, cash, wallet, Pact, mission, or spend-limit evidence changed. Run preflight again.');
    }
  }
  attempt.market = executionReceipts.marketEvidence({
    ticker: {
      last: current.market?.observedPrice, bid: current.market?.bid, ask: current.market?.ask,
      source: current.market?.source, observedAt: current.market?.observedAt,
      ageMs: current.market?.quoteAgeMs, fresh: current.market?.fresh,
      quoteIntegrity: current.market?.quoteIntegrity,
    },
    requestedEntry: order?.entry, side: order?.side, size: order?.size,
    now: current.checkedAt,
  });
  attempt.request.requestedEntry = current.request?.requestedEntry;
  attempt.request.requestedNotionalUsd = current.request?.requestedNotionalUsd;
  attempt.preflightAuthorized = true;
  return { ...current, required, fingerprint: supplied || null };
}

function serverPaperFill(preflight, order) {
  const fillPrice = Number(preflight?.market?.estimatedFillPrice);
  const requestedEntry = Number(preflight?.request?.requestedEntry);
  const size = Number(order?.size);
  const side = order?.side === 'short' ? 'short' : 'long';
  const priceDelta = side === 'short' ? requestedEntry - fillPrice : fillPrice - requestedEntry;
  return {
    fillPrice,
    fillAuthority: `server-top-of-book-${side === 'short' ? 'bid' : 'ask'}`,
    fillVenue: preflight?.market?.quoteIntegrity?.routeVenue || preflight?.market?.source || null,
    maxSlippageBps: Number(preflight?.request?.maxSlippageBps),
    slippageBps: Number(preflight?.market?.adverseSlippageBps),
    slippageUsd: Math.round(Math.max(0, priceDelta) * size * 10_000) / 10_000,
    priceImprovementUsd: Math.round(Math.max(0, -priceDelta) * size * 10_000) / 10_000,
  };
}

async function executePaperOpen(req, order, source = 'rest') {
  // Current authorization is checked before looking up a cached result so a
  // lower-scope key cannot use a guessed intent ID as a private read channel.
  if (missingPaperExecutionScope(req, source)) return executePaperOpenOnce(req, order, source);
  const accountId = accountFor(req).accountId;
  const intentId = paperExecutionIntentId(req, order, source);
  const protectedOrder = { ...(order || {}), intentId };
  return executionIntents.runExecutionIntent({
    accountId, intentId, action: 'open', request: paperIntentRequest(protectedOrder, 'open'),
  }, () => executePaperOpenOnce(req, protectedOrder, source));
}

async function executePaperOpenOnce(req, order, source = 'rest') {
  const attempt = beginPaperReceipt(req, order, 'open', source);
  const size = Number(order?.size || 0);
  let notionalMinor = 0;
  const missionId = String(order?.missionId || '').trim() || null;
  const missionOwner = missionOwnerId(req);
  let missionReservation = null;
  let gate = null;
  const authorizationStartedAt = Date.now();

  const missingPaperScope = missingPaperExecutionScope(req, source);
  if (missingPaperScope) {
    attempt.authorizationMs = Date.now() - authorizationStartedAt;
    const receipt = writePaperReceipt(req, attempt, {
      outcome: 'rejected', execution: { status: 'not-filled' },
      reasonCode: 'trade-paper-scope-required', detail: 'Paper trading scope is required.',
    });
    throw rejectedPaperError('scope: this key cannot trade (missing trade-paper)', 403, 'trade-paper-scope-required', receipt);
  }

  const preflight = await enforcePaperPreflightBinding(req, order, source, attempt);
  const fill = serverPaperFill(preflight, order);
  notionalMinor = fill.fillPrice > 0 && size > 0 ? Math.ceil(fill.fillPrice * size * 100) : 0;

  if (missionId) {
    missionReservation = missions.reserveMissionTrade({
      missionId, ownerId: missionOwner, walletId: order?.walletId,
      pactId: order?.pactId, symbol: order?.symbol, notionalMinor,
    });
    if (!missionReservation.ok) {
      attempt.authorizationMs = Date.now() - authorizationStartedAt;
      const receipt = writePaperReceipt(req, attempt, {
        outcome: 'rejected', execution: { status: 'not-filled' },
        missionAuthorized: false, reasonCode: missionReservation.reason,
        detail: missionReservation.message,
      });
      throw rejectedPaperError(missionReservation.message, 409, missionReservation.reason, receipt);
    }
  }

  gate = agentSpendGate(req, notionalMinor, {
    walletId: order?.walletId,
    pactId: order?.pactId,
    recipient: order?.recipient,
    protocol: order?.protocol,
  });
  attempt.authorizationMs = Date.now() - authorizationStartedAt;
  if (!gate.ok) {
    if (missionReservation?.ok) missions.releaseMissionTrade(missionId, missionOwner, missionReservation.reservationId);
    const receipt = writePaperReceipt(req, attempt, {
      outcome: 'rejected', execution: { status: 'not-filled' }, gate,
      missionAuthorized: missionReservation?.ok === true,
      reasonCode: gate.reason || 'agent-spend-denied', detail: gate.message,
    });
    throw rejectedPaperError(gate.message || gate.reason || 'agent spend denied', 402, gate.reason, receipt);
  }

  try {
    const brokerStartedAt = Date.now();
    const placed = await getBroker('paper').placeOrder({
      ...(order || {}), entry: fill.fillPrice, accountId: attempt.accountId,
    });
    attempt.brokerMs = Date.now() - brokerStartedAt;
    const settlementStartedAt = Date.now();
    const settled = settleAgentSpend(gate, !!placed.ok);
    attempt.settlementMs = Date.now() - settlementStartedAt;
    if (!settled.ok && placed.ok) {
      await closeTrade(placed.position?.id, placed.position?.entry, attempt.accountId, `${source.toUpperCase()} authorization settlement failed`);
      if (missionReservation?.ok) missions.releaseMissionTrade(missionId, missionOwner, missionReservation.reservationId);
      const receipt = writePaperReceipt(req, attempt, {
        outcome: 'reversed', execution: {
          status: 'reversed', fillPrice: placed.position?.entry,
          ...fill, feeUsd: 0,
        }, gate, missionAuthorized: missionReservation?.ok === true,
        reasonCode: 'authorization-settlement-failed', detail: 'The simulated fill was reversed.',
      });
      throw rejectedPaperError('agent authorization settlement failed', 500, 'authorization-settlement-failed', receipt);
    }
    if (!placed.ok) {
      if (missionReservation?.ok) missions.releaseMissionTrade(missionId, missionOwner, missionReservation.reservationId);
      const receipt = writePaperReceipt(req, attempt, {
        outcome: 'rejected', execution: { status: 'not-filled' }, gate,
        missionAuthorized: missionReservation?.ok === true,
        reasonCode: 'paper-broker-rejected', detail: placed.error || 'Paper broker rejected the order.',
      });
      return { ...placed, receipt };
    }
    if (missionReservation?.ok) {
      try {
        missions.commitMissionTrade(missionId, missionOwner, missionReservation.reservationId, {
          positionId: placed.position?.id, symbol: placed.position?.symbol,
        });
      } catch (missionError) {
        await closeTrade(placed.position?.id, placed.position?.entry, attempt.accountId, 'mission settlement failed');
        const receipt = writePaperReceipt(req, attempt, {
          outcome: 'reversed', execution: {
            status: 'reversed', fillPrice: placed.position?.entry,
            ...fill, feeUsd: 0,
          }, gate, missionAuthorized: false,
          reasonCode: 'mission-settlement-failed', detail: 'The simulated fill was reversed.',
        });
        throw rejectedPaperError('mission settlement failed', 500, 'mission-settlement-failed', receipt);
      }
    }
    let receipt;
    try {
      receipt = writePaperReceipt(req, attempt, {
        outcome: 'accepted', execution: {
          status: 'filled', fillPrice: placed.position?.entry,
          ...fill, feeUsd: 0,
        }, gate, missionAuthorized: missionReservation?.ok === true,
        decision: 'allow', reasonCode: 'paper-fill-verified', detail: 'Simulated paper fill completed inside authorization rails.',
      });
    } catch {
      const reversed = await closeTrade(placed.position?.id, placed.position?.entry, attempt.accountId, 'execution receipt unavailable');
      if (missionReservation?.ok && reversed.ok) missions.recordMissionClose(placed.position?.id, missionOwner, 0);
      throw rejectedPaperError('execution receipt unavailable; simulated fill reversed', 500, 'execution-receipt-unavailable');
    }
    return { ...placed, receipt };
  } catch (error) {
    if (!error.receipt) {
      settleAgentSpend(gate, false);
      if (missionReservation?.ok) missions.releaseMissionTrade(missionId, missionOwner, missionReservation.reservationId);
      try {
        error.receipt = writePaperReceipt(req, attempt, {
          outcome: 'rejected', execution: { status: 'not-filled' }, gate,
          missionAuthorized: missionReservation?.ok === true,
          reasonCode: 'paper-execution-error', detail: error.message,
        });
      } catch { /* the original execution error remains authoritative */ }
    }
    throw error;
  }
}

async function executePaperClose(req, order, source = 'rest') {
  if (missingPaperExecutionScope(req, source)) return executePaperCloseOnce(req, order, source);
  const accountId = accountFor(req).accountId;
  const intentId = paperExecutionIntentId(req, order, source);
  const protectedOrder = { ...(order || {}), intentId };
  return executionIntents.runExecutionIntent({
    accountId, intentId, action: 'close', request: paperIntentRequest(protectedOrder, 'close'),
  }, () => executePaperCloseOnce(req, protectedOrder, source));
}

async function executePaperCloseOnce(req, order, source = 'rest') {
  const accountId = accountFor(req).accountId;
  const position = getState(accountId).positions.find((item) => item.id === order?.positionId) || null;
  const request = {
    ...(order || {}), symbol: position?.symbol || '', side: position?.side || 'long',
    size: position?.size, entry: position?.entry, reason: `${source.toUpperCase()} paper close`,
  };
  const attempt = beginPaperReceipt(req, request, 'close', source);
  attempt.request.positionId = order?.positionId || null;
  const authorizationStartedAt = Date.now();
  const missingPaperScope = missingPaperExecutionScope(req, source);
  attempt.authorizationMs = Date.now() - authorizationStartedAt;
  if (missingPaperScope) {
    const receipt = writePaperReceipt(req, attempt, {
      outcome: 'rejected', execution: { status: 'not-filled' },
      reasonCode: 'trade-paper-scope-required', detail: 'Paper trading scope is required.',
    });
    throw rejectedPaperError('scope: this key cannot trade (missing trade-paper)', 403, 'trade-paper-scope-required', receipt);
  }
  const brokerStartedAt = Date.now();
  const closed = await closeTrade(order?.positionId, null, accountId, `${source.toUpperCase()} agent paper close`);
  attempt.brokerMs = Date.now() - brokerStartedAt;
  attempt.market = executionReceipts.marketEvidence({
    ticker: peekTicker(position?.symbol, Date.now()),
    requestedEntry: closed?.exitPrice,
    side: position?.side,
    size: position?.size,
  });
  if (closed.ok) missions.recordMissionClose(order?.positionId, missionOwnerId(req), Math.round(Number(closed.pnl || 0) * 100));
  try {
    const receipt = writePaperReceipt(req, attempt, {
      outcome: closed.ok ? 'accepted' : 'rejected',
      execution: closed.ok ? {
        status: 'filled', fillPrice: closed.exitPrice, fillAuthority: closed.exitAuthority,
        feeUsd: 0, pnlUsd: closed.pnl, result: closed.result,
      } : { status: 'not-filled' },
      gate: { ok: true }, missionAuthorized: true,
      decision: closed.ok ? 'allow' : 'deny',
      reasonCode: closed.ok ? 'risk-reducing-close-verified' : 'paper-close-rejected',
      detail: closed.ok ? 'Paper position closed at a server-observed or last-observed price.' : closed.error,
    });
    return { ...closed, receipt };
  } catch (error) {
    if (!closed.ok) throw error;
    return { ...closed, receipt: null, receiptError: 'execution receipt unavailable' };
  }
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
  const user = req.session?.userId ? auth.findById(req.session.userId) : null;
  const email = user?.email || null;
  res.json({
    accountId: st.accountId,
    owner: st.owner,
    cash: Math.round(st.account.cash * 100) / 100,
    initialCash: st.account.initialCash,
    equity: Math.round((st.account.cash + unrealized) * 100) / 100,
    openPositions: st.positions.length,
    lastTrades: st.journal.slice(-5).reverse().map(j => ({ symbol: j.symbol, side: j.side, status: j.status, pnl: j.pnl, result: j.result, openedAt: j.openedAt, closedAt: j.closedAt })),
    live: getLiveState(st, email, user ? brokerForUser(user) : null), // masked — never exposes keys
    fee: { ...walletSummary(st), exempt: getFeeConfig().feeExemptAccounts.includes(st.accountId), burnRate: getFeeConfig().burnRate, minCreditsToTrade: getFeeConfig().minCreditsToTrade, bundles: getFeeConfig().bundles, wallet: getFeeConfig().wallet },
  });
});

// ---- live (real-money) mode: owner-only, allowlisted email, kill switch ----
app.post('/api/account/live/enable', requireUser, async (req, res) => {
  if (!req.session?.userId) return res.status(403).json({ error: 'owner account only' });
  const u = auth.findById(req.session.userId);
  if (!u) return res.status(401).json({ error: 'auth required' });
  const ownBroker = brokerForUser(u);
  if (!isLiveAllowed(u.email) && !ownBroker) return res.status(403).json({ error: 'not eligible for live trading — connect your own Kraken key first' });
  const r = await enableLive(accountFor(req), u.email, ownBroker);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, live: r.live });
});

app.post('/api/account/live/disable', requireUser, async (req, res) => {
  if (!req.session?.userId || !isOwnerSession(req)) return res.status(403).json({ error: 'owner account only' });
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  const r = await disableLive(accountFor(req), u ? brokerForUser(u) : null);
  res.json({ ok: true, cancelled: r.cancelled, wasEnabled: r.wasEnabled });
});

// ---- live execution: owner-only, rails-gated, fully audited ----
// Owner session helper: only allowlisted emails are the owner.
function isOwnerSession(req) {
  const u = req.session?.userId ? auth.findById(req.session.userId) : null;
  return !!(u && isOwnerIdentity(u.email));
}

// Per-user broker: the user's OWN Kraken keys (encrypted). null when not set.
function brokerForUser(u) {
  const keys = u ? getUserKrakenKeys(u) : null;
  return keys ? createKrakenBroker(keys) : null;
}

// ---- per-user Kraken key connection (v3 — customers trade their own account) ----
app.get('/api/account/kraken', requireUser, (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth required' });
  res.json({ ok: true, available: liveTradingAvailable(), status: userKrakenStatus(auth.findById(req.session.userId)) });
});

app.put('/api/account/kraken', requireUser, async (req, res) => {
  if (!liveTradingAvailable()) return res.status(403).json({ error: 'exchange-key connection is unavailable in the paper-only launch' });
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

// ---- free IOST mainnet wallet (no creation fee — IOST accounts are free to open) ----
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
  // one quotes call: marks open live positions (REAL daily P&L for the loss
  // halt — previously always 0, so the kill-switch never fired) and prices
  // this order's notional so market orders hit the maxOrderUsd cap too.
  const qr = await kraken.getQuotes([...new Set([symbol, ...openPositions.map(p => p.symbol)])]).catch(() => ({ ok: false, quotes: {} }));
  const quotes = qr.ok ? qr.quotes : {};
  const today = new Date().toISOString().slice(0, 10);
  const realizedLive = st.journal
    .filter(j => j.live && j.closedAt && new Date(j.closedAt).toISOString().slice(0, 10) === today)
    .reduce((a, j) => a + (j.pnl || 0), 0);
  const unrealizedLive = openPositions.reduce((a, p) => {
    const last = quotes[p.symbol]?.last;
    if (!last || !p.entry) return a;
    return a + (last - p.entry) * p.size * (p.side === 'short' ? -1 : 1);
  }, 0);
  const todayPnlUsd = realizedLive + unrealizedLive;
  // GARCH vol sizing (opt-in via GARCH_ENABLED=1): how much, not which way.
  // Applied at the single execution choke point; fail-soft → multiplier 1.
  const gs = await applyGarchSizing(symbol, size);
  const effSize = gs.size;
  const rail = checkLiveOrder({ symbol, side, size: effSize, entry, marketPrice: quotes[symbol]?.last, openPositions, cashUsd: acct.account.cashUsd ?? 0, todayPnlUsd });
  if (!rail.ok) return { status: 400, error: `risk rail: ${rail.error}` };
  const fee = canTrade(st);
  if (!fee.ok) return { status: 400, error: fee.error };

  const r = await kraken.placeOrder({ symbol, side, size: effSize, entry });
  if (!r.ok) return { status: 502, error: `venue: ${r.error}` };
  // journal the live fill (live:true) — previously live fills never reached
  // the journal, so the daily-loss rail and account views saw nothing
  const lastQuote = quotes[symbol]?.last || null;
  const fillPrice = entry && entry > 0 ? entry : lastQuote;
  if (fillPrice) {
    st.journal.push({
      id: r.order.venueOrderId || `live_${Date.now()}`,
      symbol, side, entry: fillPrice, size: effSize, reason: 'live (venue fill)',
      status: 'open', openedAt: Date.now(), closedAt: null, exitPrice: null,
      pnl: 0, pnlPct: null, result: null, live: true, venue: 'kraken',
    });
  }
  // fee: burn credits on the executed notional (entry price or last quote)
  let notional = entry && entry > 0 ? effSize * entry : 0;
  if (!notional && lastQuote) notional = effSize * lastQuote;
  const burn = burnCredits(st, notional);
  persistAccounts();
  logLiveEvent(st.accountId, 'live.order', { symbol, side, size: effSize, requestedSize: Number(size), entry: entry || null, garchMult: gs.multiplier, garchRegime: gs.regime, stormCapped: gs.stormCapped || false, venueOrderId: r.order.venueOrderId, burn: burn.ok ? burn.burn : 0 });
  return { status: 200, ok: true, order: { venue: 'kraken', venueOrderId: r.order.venueOrderId, symbol, side, size: effSize, entry: entry || null, garch: { multiplier: gs.multiplier, regime: gs.regime, requestedSize: Number(size) } }, fee: burn.ok ? { burn: burn.burn, credits: burn.credits } : { error: burn.error } };
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
  // Kill every in-memory bearer derived from this key immediately. Request
  // middleware also revalidates the source key as defense in depth.
  for (const [token, entry] of oauthTokens) {
    if (entry.keyId === req.params.id && entry.userId === req.session.userId) oauthTokens.delete(token);
  }
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
  const claim = liveProposals.claimForExecution(req.params.id, 'owner');
  if (!claim.ok) return res.status(claim.error === 'proposal not found' ? 404 : 400).json({ error: claim.error });
  const p = claim.proposal;
  let r;
  try {
    r = await executeLiveOrder(req, { symbol: p.symbol, side: p.side, size: p.size, entry: p.entry });
  } catch (e) {
    const error = e instanceof Error ? e.message : 'live execution failed';
    liveProposals.finalizeExecution(p.id, { status: 'rejected', by: 'owner', error });
    logLiveEvent(p.userId, 'live.proposal.rejected', { proposalId: p.id, error });
    return res.status(502).json({ ok: false, error, proposal: liveProposals.getProposal(p.id) });
  }
  if (r.status === 200) {
    liveProposals.finalizeExecution(p.id, { status: 'approved', by: 'owner', venueOrderId: r.order.venueOrderId });
    logLiveEvent(p.userId, 'live.proposal.approved', { proposalId: p.id, venueOrderId: r.order.venueOrderId });
    res.json({ ok: true, proposal: liveProposals.getProposal(p.id), order: r.order });
  } else {
    liveProposals.finalizeExecution(p.id, { status: 'rejected', by: 'owner', error: r.error });
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

// ---- admin (owner-only): fee config + wallets — owner can change pricing live ----
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

// Evaluation history belongs to a real user account. Browser sessions and
// that user's revocable agent credentials share one private history; platform
// keys have no user owner and therefore fail closed.
function evaluationOwner(req) {
  if (req.session?.userId && auth.findById(req.session.userId)) return req.session.userId;
  if (req.userAgent?.userId && userAgentHas(req, 'read')) return req.userAgent.userId;
  return null;
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

// Mission authority belongs to the human account that created the scoped key,
// so the browser and its agent see the same paper-only control envelope.
function missionOwnerId(req) {
  if (req.session?.userId && auth.findById(req.session.userId)) return `user:${req.session.userId}`;
  if (req.userAgent?.userId) return `user:${req.userAgent.userId}`;
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
  version: DISCOVERY_VERSION,
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
    { path: '/api/paper/open', method: 'POST', body: '{...,walletId?,pactId?,trailStopPct?,trailTpPct?,dca?:{enabled,triggerPct,maxTrades,sizeFactor,cooldownMin}}', purpose: 'open a paper trade with trailing/DCA from the start; agent credentials require an owned wallet and active Pact' },
  ],
  triggers: 'v1.14 — user-defined alerts: when a condition fires (price > level, AI score crosses threshold, 24h % move) → notify (event log, pollable for Telegram) or propose (live-trade proposal, owner-only). Edge-triggered (no spam), events capped, checked every 60s. Store data/triggers.json.',
  triggerEndpoints: [
    { path: '/api/triggers', method: 'GET', purpose: 'my triggers' },
    { path: '/api/triggers', method: 'POST', body: '{name?,symbol,condition:{type:price|score|pct24h,operator:gt|lt|gte|lte,value},action:notify|propose,side?,reason?}', purpose: 'create a trigger (propose action = owner-only)' },
    { path: '/api/triggers/:id', method: 'DELETE', purpose: 'delete a trigger' },
    { path: '/api/triggers/:id/toggle', method: 'POST', body: '{enabled:bool}', purpose: 'enable/disable a trigger' },
    { path: '/api/triggers/events', method: 'GET', query: 'since=ts&limit=N', purpose: 'recent trigger events (what fired, when, value seen)' },
  ],
  leaderboard: { path: '/api/leaderboard', method: 'GET', query: 'period=week|all', purpose: 'PUBLIC paper leaderboard plus a promoted subset requiring positive P&L and 5+ closed trades; identities are masked' },
  backtest: { path: '/api/backtest', method: 'POST', body: '{symbol,timeframe?:1d|4h|1h|15m,strategy:{name?,side,entry:{rule:ma-cross|rsi|breakout|ai-score,params},exit:{stopPct?,targetPct?,trailingPct?,maxBars?},sizePct?}}', purpose: 'PUBLIC backtesting (FXReplay methodology): objective rules vs historical bars → expectancy, profit factor, max drawdown, Sharpe, vs buy-and-hold + per-trade journal. Honest caveats included.' },
  evaluationLab: { path: '/api/evaluation-lab', method: 'POST', body: '{symbol,timeframe,strategy,config?:{trainBars,testBars,stepBars,minimumTrades,costs:{feeBps,spreadBps,slippageBps}}}', purpose: 'AUTHENTICATED per-user paper-only rolling walk-forward evaluation with causal next-bar fills, realistic costs, baselines, calibration, evidence hashes, private retained history and a fail-closed paper-review gate.' },
  evaluationHistory: { path: '/api/evaluation-lab/history', method: 'GET', query: 'limit=1..retention maximum', purpose: 'List only the current user history. Read one run at /history/:id, compare two at /history/compare?ids=id1,id2, or export deterministic evidence at /history/:id/export?format=json|csv.' },
  binanceData: [
    { path: '/api/token-audit', method: 'POST', body: '{contractAddress, chainId?:56|8453|CT_501|1}', purpose: 'PUBLIC Binance Web3 token security audit (honeypot/rug-pull/scam/tax scan). No keys. Proxy of web3.binance.com — result normalized: riskLevel 1-5, taxes, verified flag, risk-item checks. NOT investment advice.' },
    { path: '/api/smart-money', method: 'GET', query: 'chainId=56|CT_501&page=1&pageSize=20', purpose: 'PUBLIC Binance Web3 smart-money on-chain signals (BSC/Solana): buy/sell events from tracked whale wallets, trigger vs current price, max gain, exit rate, tags. 30s server cache. NOT investment advice.' },
  ],
  points: `Off-chain points ledger: no token issued. signal +10 · follower +5 · referral +50/+10 · feedback +5 (author) · weekly top paper trader +500. Points→AITT 1:1 plumbing is built but planned/not guaranteed. Phase 1 utility counsel framing was cleared on 2026-08-24; independent-audit, hash-bound approval evidence, deployment and owner gates keep conversion closed under v${AITT_DOC_VERSION}.`,
  aitt: 'AITT — Agent Intelligence Trading Token (pre-launch remediation, NOT issued): 1B fixed supply, unified 800M-floor burn routing, contract-locked allocations, EIP-191 conversion binding and receipt reconciliation are built. Counsel cleared the Phase 1 utility framing on 2026-08-24; independent audit, hash-bound approval evidence, deployment and owner gates remain closed. Staking revenue/APY, external transferability and Phase 4 liquidity remain inactive future proposals requiring separate counsel/owner/audit approval; Phase 4 is disabled.',
  agentWallet: 'Phase 2 agent wallet engine (off-chain first): parent-child wallets with spend limits (per-tx/daily/weekly, integer minor units), trust staking + slashing + appeals, derived Trust Score + credit line, task-scoped Pacts with auto-expiry, emergency freeze. Design: docs/PHASE2_SPEC.md (engine) + docs/PHASE2_WALLET.md (on-chain wallet + Coinbase CDP research §9.20-9.26). Agent-key paper opens fail closed without positive entry/size, an owned agent wallet, and an active wallet-bound Pact. Capabilities: finance.* / wallet.* / trade.* / mandate.sign.',
  agentLaunchpad: 'Self-service, human-authorized paper-agent setup: a signed-in user creates one bounded paper wallet, separately approves a time-limited Pact, creates a revocable trade-paper key, and copies the MCP connection template. Lifetime launch credits are capped at $100 internal simulation value with no withdrawal, conversion, token, live-order, or public-chain path.',
  freeIostWallet: 'Every registered user gets a real IOST mainnet account — opening an IOST account is FREE (no creation fee; official signup at iostaccount.io). Keys are generated IN THE BROWSER — the server never sees private keys, only the base64 public key + account name; it broadcasts auth.iost/signUp (VERIFIED ABI: createAccount does not exist on mainnet) with the platform account. No IOST_PIN_KEY → requests queue (status "pending") and flush when the key appears. Store data/iost_accounts.json.',
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
    { path: '/api/risk/garch', method: 'GET', body: '?symbol=BTC', purpose: 'GARCH forecast vol + regime + size multiplier (how much, never which way)' },
    { path: '/api/risk', method: 'POST', body: '{accountSize,maxRiskPct,entryPrice,stopLoss,targetPrice,side}', purpose: 'position size, $ risk, R:R, potential P/L, exposure' },
    { path: '/api/portfolio', method: 'GET', purpose: 'whole-portfolio AI analysis' },
  ],
  execution: [
    { path: '/api/account', method: 'GET', purpose: 'light per-account snapshot for UI topbar: cash, equity, openPositions, lastTrades' },
    { path: '/api/paper', method: 'GET', purpose: 'account + open positions + journal (mark-to-market)' },
    { path: '/api/paper/preflight', method: 'POST', body: '{intentId,symbol,side,size,entry,maxSlippageBps,stop?,target?,walletId,pactId,missionId?,recipient?,protocol?}', purpose: 'read-only one-intent paper execution preflight; crypto quote integrity, best trusted bid/ask, hard cost caps, portfolio exposure/concentration/correlation/drawdown/daily-loss/stop/volatility risk, server-fill notional and authorization rails' },
    { path: '/api/paper/open', method: 'POST', body: '{intentId,preflightFingerprint,symbol,side,size,entry,maxSlippageBps,stop?,target?,reason?,confidence?,walletId,pactId,missionId?,recipient?,protocol?}', purpose: 'idempotent server-priced paper open; agents require a protective stop and matching unexpired quote-integrity, portfolio-risk and wallet/Pact evidence; crypto longs use the best consensus-approved ask and shorts the best bid' },
    { path: '/api/paper/close', method: 'POST', body: '{intentId,positionId}', purpose: 'idempotent close at a server-observed price (client exit prices are ignored)' },
    { path: '/api/paper/stats', method: 'GET', purpose: 'journal statistics (win rate, P&L)' },
    { path: '/api/execution-receipts', method: 'GET', query: 'limit=1..200', purpose: 'private SHA-256-chained paper execution receipts with pricing, portfolio-risk, authorization, cost and latency evidence' },
    { path: '/api/execution-intents', method: 'GET', query: 'limit=1..200', purpose: 'private replay-safe paper execution intent states; pending intents fail closed as outcome-unknown after restart' },
    { path: '/api/execution-intents/:intentId', method: 'GET', purpose: 'private status lookup for one paper execution intent' },
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
    { path: '/api/chain/status', method: 'GET', purpose: 'IOST Layer 1 trust status: RPC health, finality and signal-pin readiness' },
    { path: '/api/chain/identity', method: 'GET', purpose: 'verified IOSTCallister producer identity plus explicitly separated Layer 1 and Layer 2 roles' },
  ],
  arena: [
    { path: '/api/arena', method: 'GET', purpose: 'public paper-only Agent Trust Arena: verified performance, drawdown, risk/evidence/trust scores, formulas and audit head' },
    { path: '/api/arena/agents/:agentId', method: 'GET', purpose: 'public agent score inputs, server-priced paper trade evidence, transparent agent-submitted reasoning and hash-chained audit trail' },
    { path: '/api/arena/trades/open', method: 'POST', body: '{symbol,side,size,stop?,target?,reason?,trail?,walletId,pactId,recipient?,protocol?}', purpose: 'open an Arena-eligible server-priced PAPER trade; agent credentials retain wallet + Pact authorization' },
    { path: '/api/arena/trades/:id/close', method: 'POST', purpose: 'close an Arena paper trade at a fresh server market price; client exit prices are ignored' },
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
    { path: '/api/aitt/info', method: 'GET', purpose: 'public AITT token info: identity, supply, chain, contract/converter addresses, conversion gate, fail-closed DEX route and honesty notice' },
    { path: '/api/aitt/wallet/challenge | /verify', method: 'POST', purpose: 'session-user EIP-191 conversion-wallet binding; signature only, no payment authority' },
    { path: '/api/aitt/claims', method: 'GET', purpose: 'session user conversion claims and available points' },
    { path: '/api/admin/aitt/status', method: 'GET', purpose: 'owner-only read-only release-gate, contract, trading and claim-queue dashboard' },
    { path: '/aitt', method: 'GET', purpose: 'public AITT token page (SSR — CMC-ready, no JS required)' },
    { path: '/token', method: 'GET', purpose: 'alias of /aitt' },
    { path: '/whitepaper', method: 'GET', purpose: `AITT public whitepaper draft v${AITT_DOC_VERSION} (markdown — served from docs/AITT-Whitepaper-v1.0.md)` },
  ],
  agentWallet: [
    { path: '/api/agent-launchpad', method: 'GET', purpose: 'signed-in human Launchpad status: bounded paper wallet, Pact, scoped keys and MCP readiness (never returns key secrets)' },
    { path: '/api/agent-launchpad/setup', method: 'POST', body: '{name,fundMinor,perOrderMinor,dailyMinor,expiryHours}', purpose: 'idempotently create one paper-only wallet and propose a time-limited Pact; lifetime internal simulation-credit grant capped at $100' },
    { path: '/api/agent-launchpad/pact', method: 'POST', body: '{expiryHours}', purpose: 'propose a new time-limited Pact for an existing Launchpad wallet without minting credits or changing policy' },
    { path: '/api/wallets', method: 'GET', purpose: 'my wallet tree: parent (user) wallet + agent child wallets with balances, limits, capabilities, status' },
    { path: '/api/wallets', method: 'POST', body: '{name, limits:{USD:{maxPerTxMinor,dailyCapMinor,weeklyCapMinor}}, capabilities[], regions[], approvalRequired}', purpose: 'create an agent wallet as a child of my wallet (limits enforced server-side; 0 = unlimited)' },
    { path: '/api/wallets/:id/policies', method: 'PATCH', body: '{limits?, capabilities?, regions?, approvalRequired?}', purpose: 'update wallet limits/capabilities/regions (owner)' },
    { path: '/api/wallets/:id/fund', method: 'POST', body: '{amountMinor}', purpose: 'fund agent wallet from parent wallet (internal transfer, no fees)' },
    { path: '/api/wallets/credit', method: 'POST', body: '{amountMinor}', purpose: 'owner only — credit the user wallet (onboarding funds)' },
    { path: '/api/wallets/:id/suspend | /reactivate', method: 'POST', purpose: 'suspend/reactivate an agent wallet' },
    { path: '/api/wallets/:id/usage', method: 'GET', purpose: 'daily/weekly spend usage snapshot vs limits' },
    { path: '/api/spend/check|reserve|commit|release', method: 'POST', body: '{walletId,amountMinor,pactId,recipient?,protocol?,purpose?} for check/reserve; {walletId,reserveId} for commit/release', purpose: 'Pact + limit enforcement: active wallet-bound Pact check → reserve limit and Pact budget capacity with server-bound policy metadata → act → commit or release. Commit never trusts a client-supplied pact identity.' },
    { path: '/api/stake', method: 'POST', body: '{amountMinor (8-dec AITT), lockDays 7|30|90|365}', purpose: 'create trust stake (min 1,000 AITT)' },
    { path: '/api/stake/unstake | /withdraw', method: 'POST', body: '{stakeId}', purpose: 'start 7-day cooldown / withdraw after cooldown' },
    { path: '/api/trust/score', method: 'GET', purpose: 'derived Trust Score + credit line + components (never stored)' },
    { path: '/api/slashes', method: 'POST', body: '{ownerId, reason: unauthorized-spend|failed-settlement}', purpose: 'owner only — slash (unauthorized −10% + score reset · failed settlement −5%)' },
    { path: '/api/slashes/:id/appeal | /decide', method: 'POST', purpose: '14-day appeal window; decide = owner review (future DAO policy)' },
    { path: '/api/pacts', method: 'GET|POST', purpose: 'task-scoped Pacts: intent + plan + policies + completion (time/budget/goal) with auto-expiry' },
    { path: '/api/pacts/:id/approve | /reject | /terminate', method: 'POST', purpose: 'human control over Pacts: platform owner or the signed-in account that owns that Pact; agent keys are denied' },
    { path: '/api/freeze', method: 'POST', body: '{on:true, reason?} | {on:false}', purpose: 'owner only — emergency freeze: stops ALL agent operations instantly' },
  ],
  wallets: [
    { path: '/api/account/iost/status', method: 'GET', purpose: 'public honesty endpoint (no auth): free to open (no creation fee), platform funding configured?, account-name rules, explorer base' },
    { path: '/api/account/iost', method: 'POST', body: '{publicKey (base64 of 32-byte Ed25519 public key), accountName?}', purpose: 'request a free IOST mainnet wallet for the signed-in user (opening is now free, no creation fee) — the browser generates the Ed25519 keypair and the server only ever receives the PUBLIC key; creation is broadcast via auth.iost/signUp with the platform funded account, or queued (status pending) until funding is configured' },
    { path: '/api/account/iost', method: 'GET', purpose: 'my wallet status (session user): none/pending/created/failed + account name + creation tx + block' },
  ],
  autonomy: [
    { path: '/api/agent-missions', method: 'GET|POST', purpose: 'owner-only Mission Control: list or create a paused supervised paper mission bound to an exact active wallet and Pact' },
    { path: '/api/agent-missions/:id/start | /pause | /stop', method: 'POST', purpose: 'owner-only mission lifecycle controls; start revalidates the paper wallet and Pact' },
    { path: '/api/agent-missions/:id/checkpoint', method: 'POST', body: '{stage,detail,latencyMs?}', purpose: 'user-bound agent trace checkpoint; cannot expand mission authority' },
    { path: '/api/autopilot', method: 'GET', purpose: 'autopilot status + config + action audit trail + pending proposals' },
    { path: '/api/autopilot/start', method: 'POST', body: '{config?}', purpose: 'enable autonomous trading loop' },
    { path: '/api/autopilot/stop', method: 'POST', purpose: 'disable autonomous loop' },
    { path: '/api/autopilot/config', method: 'POST', body: '{requireApproval,openMinScore,maxConcurrent,...}', purpose: 'update strategy params (requireApproval=true queues entries for human approval)' },
    { path: '/api/autopilot/proposals', method: 'GET', purpose: 'pending human-in-the-loop proposals with full reasoning (symbol, size, stop, target, confidence, reason)' },
    { path: '/api/autopilot/proposals/:id/approve', method: 'POST', purpose: 'human override — execute a pending proposal now' },
    { path: '/api/autopilot/proposals/:id/reject', method: 'POST', purpose: 'human override — block a pending proposal' },
    { path: '/api/agent-control', method: 'GET', purpose: 'OWNER ONLY: aggregate agent activity, permissions, budgets and safety state' },
    { path: '/api/agent-control/emergency-stop', method: 'POST', purpose: 'OWNER ONLY: stop autopilot, suspend owned agent wallets and disable live execution' },
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
    points: '/api/points', aitt: '/api/aitt/info', arena: '/api/arena', agentWallet: '/api/wallets', wallet: '/api/account/iost',
    chains: '/api/chain/identity',
    contracts: API_INDEX,
  });
});
// ---- A2A agent card (A2A protocol v0.2) — /.well-known/agent-card.json ----
// Companion to the legacy /.well-known/agent.json manifest: advertises the
// service to other agents for discovery + delegation. Skills mirror the Agent
// Skills index entries.
app.get('/.well-known/agent-card.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({
    protocolVersion: '0.2.0',
    supportedInterfaces: [
      { url: `${SITE_URL}/mcp`, protocolBinding: 'HTTP+JSON', protocolVersion: '0.2.0' },
    ],
    name: 'IOST Terminal',
    description: 'AI real-time trading platform for crypto + equities: live market data, AI trade scores (0-100), risk engine, news sentiment, IOST on-chain dashboard, paper trading, autonomous autopilot and decentralized agent signals hash-pinned on the IOST mainnet. Paper-first: live trades require owner approval.',
    url: SITE_URL,
    version: DISCOVERY_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [
      { id: 'iost-terminal-market-data', name: 'IOST Terminal market data', description: 'Read live market data, AI trade scores, news sentiment, on-chain status and platform state.', tags: ['market-data', 'trading', 'crypto', 'stocks', 'onchain'] },
      { id: 'iost-terminal-agent-auth', name: 'IOST Terminal agent auth', description: 'Authenticate with API keys or OAuth 2.0 client_credentials and use scoped capabilities.', tags: ['auth', 'oauth', 'api-keys'] },
      { id: 'iost-terminal-trading', name: 'IOST Terminal paper + live trading', description: 'Open/close paper trades, publish hash-pinned signals, and request live trades through the owner-approved proposal rail.', tags: ['trading', 'signals', 'paper', 'live'] },
    ],
    authentication: null,
    preferredTransport: 'https',
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      oauth2: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: `${SITE_URL}/oauth/token` } } },
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
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
      version: DISCOVERY_VERSION,
      mode: 'paper',
      chains: iostChainIdentity(),
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
app.get('/api/audit', requireUser, (req, res) => {
  const isOwner = isOwnerSession(req);
  // non-owners only see their OWN trail; owner may ?agent= filter across all
  const agent = isOwner ? (String(req.query.agent || '').trim() || null) : (signalIdentity(req)?.agentId || 'anon');
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

// Mission Control: owner-created, paper-only envelopes that a user-bound agent
// may observe and checkpoint. Authority expansion remains human-only.
app.get('/api/agent-missions', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  res.json({ ok: true, mode: 'paper-only', missions: missions.listMissions(missionOwnerId(req)) });
});

app.post('/api/agent-missions', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  try {
    const mission = missions.createMission({ ...(req.body || {}), ownerId: missionOwnerId(req) });
    logLiveEvent(req.session.userId, 'agent.mission.created', { missionId: mission.missionId, walletId: mission.walletId, pactId: mission.pactId, mode: 'paper-only' });
    res.status(201).json({ ok: true, mission });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

for (const [action, handler] of [
  ['start', (id, ownerId) => missions.startMission(id, ownerId)],
  ['pause', (id, ownerId) => missions.pauseMission(id, ownerId)],
  ['stop', (id, ownerId) => missions.stopMission(id, ownerId)],
]) {
  app.post(`/api/agent-missions/:id/${action}`, requireUser, (req, res) => {
    if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
    try {
      const mission = handler(req.params.id, missionOwnerId(req));
      logLiveEvent(req.session.userId, `agent.mission.${action}`, { missionId: mission.missionId, mode: 'paper-only' });
      res.json({ ok: true, mission });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
}

app.post('/api/agent-missions/:id/checkpoint', requireUser, (req, res) => {
  if (req.userAgent && !userAgentHas(req, 'read')) return res.status(403).json({ error: 'read scope required' });
  const ownerId = missionOwnerId(req);
  if (!ownerId) return res.status(403).json({ error: 'user-bound mission access required' });
  try { res.json({ ok: true, mission: missions.recordMissionCheckpoint(req.params.id, ownerId, req.body || {}) }); }
  catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

// Owner operations cockpit. This composes existing server-enforced controls;
// it never returns key material, hashes, venue credentials or raw audit files.
app.get('/api/agent-control', requireUser, (req, res) => {
  if (!isOwnerSession(req) || !req.session?.userId) return res.status(403).json({ error: 'owner only' });
  const ident = signalIdentity(req);
  const ap = getAutopilot();
  const keys = agentKeys.listKeys(req.session.userId);
  const tree = wallets.walletTree(ident.agentId);
  const parentWallet = tree.parent ? {
    walletId: tree.parent.walletId,
    status: tree.parent.status,
    balanceMinor: wallets.balanceOf(tree.parent.walletId),
  } : null;
  const agentWallets = tree.agents.map((w) => ({
    walletId: w.walletId,
    name: w.name,
    status: w.status,
    balanceMinor: wallets.balanceOf(w.walletId),
    limits: w.limits,
    capabilities: w.capabilities,
    regions: w.regions,
    approvalRequired: w.approvalRequired,
    usage: limits.usageSnapshot(w.walletId),
  }));
  const ownerPacts = pacts.listPacts(ident.agentId).map((pact) => ({
    pactId: pact.pactId,
    agentWalletId: pact.agentWalletId,
    intent: pact.intent,
    status: pact.status,
    completion: pact.completion,
    expiresAt: pact.expiresAt,
    spentMinor: pact.spentMinor,
    policies: {
      approvalRequired: pact.policies?.approvalRequired ?? true,
      limits: pact.policies?.limits || null,
    },
  }));
  const pendingLive = liveProposals.listProposals({ userId: req.session.userId, status: 'pending', limit: 100 });
  const pendingPaper = getProposals();
  const ownerMissions = missions.listMissions(`user:${req.session.userId}`);
  const lastAction = ap.actions[0] || null;
  res.json({
    ok: true,
    mode: 'paper',
    executionBoundary: 'PAPER_ONLY',
    autopilot: {
      enabled: ap.enabled,
      running: ap.running,
      startedAt: ap.startedAt,
      ticks: ap.ticks,
      lastTick: ap.lastTick,
      dayTrades: ap.dayTrades,
      currentTask: ap.running ? 'Evaluating the paper strategy' : ap.enabled ? 'Waiting for the next paper scan' : 'Paused by operator',
      lastAction,
      config: ap.config,
    },
    approvals: { paper: pendingPaper.length, live: pendingLive.length },
    missions: ownerMissions,
    missionStats: {
      running: ownerMissions.filter((mission) => mission.status === 'running').length,
      paused: ownerMissions.filter((mission) => mission.status === 'paused').length,
      stopped: ownerMissions.filter((mission) => ['stopped', 'expired'].includes(mission.status)).length,
    },
    keys,
    keyStats: { active: keys.filter((k) => !k.revokedAt).length, revoked: keys.filter((k) => !!k.revokedAt).length },
    parentWallet,
    wallets: agentWallets,
    pacts: ownerPacts,
    walletStats: { active: agentWallets.filter((w) => w.status === 'active').length, suspended: agentWallets.filter((w) => w.status === 'suspended').length },
    safety: { liveEnabled: anyLiveEnabled(), globalFreeze: freeze.freezeState() },
  });
});

app.post('/api/agent-control/emergency-stop', requireUser, async (req, res) => {
  if (!isOwnerSession(req) || !req.session?.userId) return res.status(403).json({ error: 'owner only' });
  try {
    const ident = signalIdentity(req);
    stopAutopilot();
    for (const mission of missions.listMissions(`user:${req.session.userId}`)) {
      if (['running', 'paused'].includes(mission.status)) missions.stopMission(mission.missionId, `user:${req.session.userId}`, 'Emergency stop.');
    }
    const suspendedWallets = [];
    for (const w of wallets.walletTree(ident.agentId).agents) {
      if (w.status === 'active') {
        wallets.setWalletStatus(w.walletId, 'suspended');
        suspendedWallets.push(w.walletId);
      }
    }
    const u = auth.findById(req.session.userId);
    const live = await disableLive(accountFor(req), u ? brokerForUser(u) : null);
    logLiveEvent(req.session.userId, 'agent.emergency-stop', { suspendedWallets, cancelledOrders: live.cancelled?.length || 0 });
    res.json({ ok: true, autopilotStopped: true, suspendedWallets, cancelledOrders: live.cancelled || [], liveWasEnabled: live.wasEnabled });
  } catch (e) {
    console.error(`[agent-control] emergency stop failed: ${e.message}`);
    res.status(500).json({ ok: false, error: 'emergency stop could not complete' });
  }
});

app.get('/api/autopilot', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
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
app.get('/api/autopilot/proposals', requireUser, (req, res) => {
  if (!isOwnerSession(req)) return res.status(403).json({ error: 'owner only' });
  res.json({ pending: getProposals() });
}); // owner-only human-in-the-loop queue
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
const LEADERBOARD_PROMOTION_MIN_TRADES = 5;
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
    const trades = closed.length;
    rows.push({
      rank: 0, trader: label, pnl: Math.round(pnl * 100) / 100,
      winRate: trades ? Math.round((wins / trades) * 1000) / 10 : 0,
      trades, wins, losses: trades - wins,
      eligibleForPromotion: trades >= LEADERBOARD_PROMOTION_MIN_TRADES && pnl > 0,
      equity: Math.round(equity * 100) / 100, period,
    });
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows.slice(0, limit);
}

function leaderboardPromotion(rows, limit = 5) {
  const eligible = rows.filter((row) => row.eligibleForPromotion).slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
  return { eligible, qualification: { minimumTrades: LEADERBOARD_PROMOTION_MIN_TRADES, requiresPositivePnl: true,
    provisionalCount: rows.filter((row) => !row.eligibleForPromotion).length,
    message: `Public promotion requires positive period P&L and at least ${LEADERBOARD_PROMOTION_MIN_TRADES} closed paper trades.` } };
}

app.get('/api/leaderboard', (req, res) => {
  const period = req.query.period === 'all' ? 'all' : 'week';
  const top = computeLeaderboard(period, 10); const promotion = leaderboardPromotion(top, 5);
  res.json({ ok: true, period, generatedAt: Date.now(), top, promoted: promotion.eligible, qualification: promotion.qualification });
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

// Authenticated, read-only historical analysis. The result can only identify a
// paper candidate; this route has no execution, live, token or chain mutation.
app.post('/api/evaluation-lab', publicLimiter, requireUser, async (req, res) => {
  const ownerId = evaluationOwner(req);
  if (!ownerId) return res.status(403).json({ error: 'user-bound evaluation history required' });
  const { symbol, timeframe = '1d', strategy, config } = req.body || {};
  if (!symbol || !strategy?.entry?.rule) return res.status(400).json({ error: 'symbol and strategy.entry.rule required' });
  try {
    const candles = await getKlines(String(symbol).toUpperCase(), timeframe, 500);
    const result = evaluateAgentStrategy({ symbol, timeframe, strategy, candles, config });
    if (result.ok) result.history = saveEvaluation(ownerId, result);
    res.set('Cache-Control', 'private, no-store');
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(502).json({ ok: false, mode: 'paper-only', error: error.message,
      promotion: { allowed: false, decision: 'HOLD', scope: 'paper-strategy-candidate' } });
  }
});

app.get('/api/evaluation-lab/history', requireUser, (req, res) => {
  const ownerId = evaluationOwner(req);
  if (!ownerId) return res.status(403).json({ error: 'user-bound evaluation history required' });
  try { res.set('Cache-Control', 'private, no-store'); res.json({ ok: true, mode: 'paper-only', ...listEvaluations(ownerId, req.query.limit) }); }
  catch (error) { res.status(409).json({ ok: false, error: error.message }); }
});

app.get('/api/evaluation-lab/history/compare', requireUser, (req, res) => {
  const ownerId = evaluationOwner(req);
  if (!ownerId) return res.status(403).json({ error: 'user-bound evaluation history required' });
  try {
    const result = compareEvaluations(ownerId, String(req.query.ids || '').split(',').filter(Boolean));
    if (!result) return res.status(404).json({ error: 'evaluation run not found' });
    res.set('Cache-Control', 'private, no-store'); res.json({ ok: true, ...result });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

app.get('/api/evaluation-lab/history/:id/export', requireUser, (req, res) => {
  const ownerId = evaluationOwner(req);
  if (!ownerId) return res.status(403).json({ error: 'user-bound evaluation history required' });
  const format = req.query.format === 'csv' ? 'csv' : req.query.format === 'json' ? 'json' : null;
  if (!format) return res.status(400).json({ error: 'format must be json or csv' });
  try {
    const body = format === 'csv' ? exportEvaluationCsv(ownerId, req.params.id) : exportEvaluationJson(ownerId, req.params.id);
    if (body == null) return res.status(404).json({ error: 'evaluation run not found' });
    res.set({
      'Cache-Control': 'private, no-store',
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="iost-evaluation-${req.params.id}.${format}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(body);
  } catch (error) { res.status(409).json({ ok: false, error: error.message }); }
});

app.get('/api/evaluation-lab/history/:id', requireUser, (req, res) => {
  const ownerId = evaluationOwner(req);
  if (!ownerId) return res.status(403).json({ error: 'user-bound evaluation history required' });
  try {
    const run = getEvaluation(ownerId, req.params.id);
    if (!run) return res.status(404).json({ error: 'evaluation run not found' });
    res.set('Cache-Control', 'private, no-store'); res.json({ ok: true, mode: 'paper-only', ...run });
  } catch (error) { res.status(409).json({ ok: false, error: error.message }); }
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
  // Agents may open/close only through their wallet-bound Pact. Changing
  // trailing/DCA automation would create future actions outside that Pact, so
  // only the signed-in account owner may alter management instructions.
  if (req.userAgent) return res.status(403).json({ error: 'agent keys cannot change automated paper-position management' });
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
// JSON 404 for API paths AND any path where the client prefers JSON
// (agents get machine-readable errors); plain 404 elsewhere
app.use((req, res) => {
  const wantsJson = req.path.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
  if (wantsJson) return res.status(404).json({ error: 'not found' });
  res.status(404).type('text/plain').send('Not Found');
});
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
