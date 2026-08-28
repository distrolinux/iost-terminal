import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const token = readFileSync(new URL('../public/token.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const arena = readFileSync(new URL('../public/arena.html', import.meta.url), 'utf8');
const hub = readFileSync(new URL('../public/hub.html', import.meta.url), 'utf8');
const terms = readFileSync(new URL('../public/terms.html', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
const risk = readFileSync(new URL('../public/risk-disclosure.html', import.meta.url), 'utf8');
const authJs = readFileSync(new URL('../public/js/auth.js', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
const chainJs = readFileSync(new URL('../lib/chain.js', import.meta.url), 'utf8');
const iostAccountsJs = readFileSync(new URL('../lib/iost-accounts.js', import.meta.url), 'utf8');

function check(name, condition) {
  assert.ok(condition, name);
  console.log(`PASS  ${name}`);
}

check('landing copy identifies the product as paper-first without ambiguous real-trading branding',
  !/AI Real-Trading Platform/i.test(server + home)
  && /AI Trading Platform[^\n<]*Paper-First/i.test(server + home));

check('landing conversion paths remain paper-only and expose Agent Trust Arena',
  /href="\/arena"[^>]*>Arena</.test(home)
  && /href="\/arena"[^>]+aria-label="Explore the paper-only Agent Trust Arena"/.test(home)
  && !/LIVE ON KRAKEN|Connect your Kraken API key|execute on your real Kraken account/i.test(home)
  && !/href="\/app\?auth=login&amp;goto=keys"/.test(home));

check('landing agent claims match disabled public-chain and real-money gates',
  /monitor and paper-simulate without human latency/i.test(home)
  && /public-chain writes disabled/i.test(home)
  && /hash-ready[^<]+paper-only/i.test(home)
  && !/Every signal proven on IOST|hash-pinned on the IOST mainnet as a token-transfer memo/i.test(home));

check('landing examples and competition rewards are not presented as live results or token promises',
  /Example trace · paper route/.test(home)
  && /84<small>\/100 example<\/small>/.test(home)
  && /in-app points have no token or cash value during pre-launch/.test(home)
  && !/1:1 AIT|at TGE/i.test(home));

check('landing legal links wrap within narrow mobile viewports',
  /@media \(max-width: 640px\)[\s\S]{0,500}footer \.links \{[^}]*max-width: 100%;[^}]*flex-wrap: wrap;/.test(home));

check('the legacy token alias permanently redirects to the canonical AITT route',
  /app\.get\('\/token',[\s\S]{0,180}res\.redirect\(308, '\/aitt'\)/.test(server)
  && /app\.get\('\/aitt',[\s\S]{0,120}sendPage\(req, res, 'token'\)/.test(server));

const sitemapMatch = server.match(/const SITEMAP_URLS = \[([^\]]+)\]/);
check('the sitemap publishes only the canonical AITT URL',
  sitemapMatch
  && sitemapMatch[1].includes("'/aitt'")
  && !sitemapMatch[1].includes("'/token'"));

check('approved legal documents are indexable, discoverable, and contain no placeholders',
  [terms, privacy, risk].every((html) => /<meta name="robots" content="index,follow">/.test(html))
  && [terms, privacy, risk].every((html) => !/\[[^\]]+\]/.test(html))
  && sitemapMatch[1].includes("'/terms'")
  && sitemapMatch[1].includes("'/privacy'")
  && sitemapMatch[1].includes("'/risk-disclosure'"));

check('legal documents use unambiguous paper-first product wording',
  [terms, privacy, risk].every((html) => /AI trading platform · paper-first/i.test(html))
  && [terms, privacy, risk].every((html) => !/real-trading/i.test(html)));

check('legal documents describe the public launch as paper-only and keep financial actions unavailable',
  [terms, privacy, risk].every((html) => /paper-only/i.test(html))
  && /Live trading is unavailable/.test(risk)
  && /Real-money execution[^<]+unavailable/.test(terms)
  && /does not accept exchange API keys or route real-money orders/.test(privacy));

check('real-money trading and exchange-key connection fail closed by default',
  /process\.env\.LIVE_TRADING_ENABLED === '1'/.test(readFileSync(new URL('../lib/live.js', import.meta.url), 'utf8'))
  && /if \(!liveTradingAvailable\(\)\) return res\.status\(403\)/.test(server)
  && /Exchange-key connection and real-money execution are unavailable/.test(appJs));

check('public-chain writes and account creation fail closed by default',
  /process\.env\.PUBLIC_CHAIN_ACTIONS_ENABLED === '1'/.test(chainJs)
  && /if \(!publicChainActionsAvailable\(\)\)[\s\S]{0,180}status: 'disabled'/.test(chainJs)
  && /if \(!publicChainActionsAvailable\(\)\)[\s\S]{0,180}status: 403/.test(iostAccountsJs));

check('server-rendered sentiment defaults missing counts to zero',
  /function sentimentCounts\(market\)/.test(server)
  && /Number\.isFinite\(Number\(value\)\)[^\n]+:\s*0/.test(server)
  && /bullish:\s*count\(market\.bullish\)/.test(server)
  && /const m = sentimentCounts\(s\?\.market\)/.test(server));

check('Terminal sign-in gate promises paper trading without live-trading ambiguity',
  /Your \$100K paper trading account lives here\./.test(app)
  && !/Your \$100K paper account and live trading live here\./.test(app));

check('account dialogs trap keyboard focus and restore the opener',
  /lastFocus:\s*null/.test(authJs)
  && /trapFocus\(e\)/.test(authJs)
  && /e\.key !== 'Tab'/.test(authJs)
  && /\['authModal', 'authReset'\]/.test(authJs)
  && /this\.lastFocus\?\.focus/.test(authJs));

check('account password fields expose the correct password-manager purpose',
  /this\.field\('Password', 'password', 'aPass', 'required', 'current-password'\)/.test(authJs)
  && /this\.field\('Password \(min 8 chars\)', 'password', 'aPass', 'required minlength="8"', 'new-password'\)/.test(authJs)
  && /autocomplete="new-password"/.test(authJs));

check('account dialog accessibility changes are cache-versioned',
  /\/js\/auth\.js\?v=2\.9\.0/.test(app));

check('the AITT page declares its canonical URL',
  /<link rel="canonical" href="https:\/\/iostcallister\.com\/aitt">/.test(token));

check('pre-launch AITT structured data is a web page, not an available product',
  /"@type": "WebPage"/.test(token)
  && /"about": \{ "@type": "Thing"/.test(token)
  && !/"@type": "Product"/.test(token));

check('market observations are not represented as products offered for sale',
  !/availability:\s*'https:\/\/schema\.org\/InStock'/.test(server)
  && !/seller:\s*\{ '@id': '\/#org' \}/.test(server));

for (const [name, html] of [['landing', home], ['AITT', token], ['Terminal', app], ['Arena', arena], ['3D Hub', hub], ['Terms', terms], ['Privacy', privacy], ['Risk disclosure', risk]]) {
  check(`${name} page has a keyboard skip link and main landmark`,
    /class="skip-link" href="#main-content"/.test(html)
    && /<main[^>]+id="main-content"/.test(html));
}

check('Terminal skip-link styles are cache-versioned',
  /\.skip-link\s*\{/.test(css)
  && /\/css\/style\.css\?v=2\.16/.test(app));

check('Terminal mobile navigation keeps every primary view reachable',
  /@media \(max-width: 860px\)[\s\S]{0,900}\.sidebar \{ display: block;/.test(css)
  && /\.side-nav \{ flex-direction: row;/.test(css));

check('Terminal exposes a read-only agent decision trace',
  /data-view="trace" aria-label="View agent decision trace"/.test(app)
  && /id="view-trace" aria-label="Agent decision trace view"/.test(app)
  && /async function renderDecisionTrace\(\)/.test(appJs)
  && /PAPER-FIRST · READ-ONLY TRACE/.test(appJs)
  && /Simulation broker only in this trace/.test(appJs));

for (const [name, html] of [['landing WebGL', home], ['3D Hub', hub]]) {
  check(`${name} animation pauses while the page is hidden`,
    /visibilitychange/.test(html)
    && /document\.hidden/.test(html)
    && /cancelAnimationFrame/.test(html));
}

check('3D Hub background refreshes are suppressed while hidden',
  /setInterval\(\(\)\s*=>\s*\{\s*if\s*\(!document\.hidden\)\s*loadData\(\)/.test(hub));

check('landing background API refreshes are suppressed while hidden',
  /function scheduleVisibleRefresh\(task, intervalMs\)/.test(home)
  && /if \(document\.hidden \|\| running\) return/.test(home)
  && /scheduleVisibleRefresh\(loadLanding, 30000\)/.test(home)
  && /scheduleVisibleRefresh\(updateVisor, 10000\)/.test(home)
  && /scheduleVisibleRefresh\(refresh, 60000\)/.test(home));

console.log('\nWebsite launch-readiness checks passed');
