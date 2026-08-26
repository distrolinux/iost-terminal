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
const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');

function check(name, condition) {
  assert.ok(condition, name);
  console.log(`PASS  ${name}`);
}

check('landing copy identifies the product as paper-first without ambiguous real-trading branding',
  !/AI Real-Trading Platform/i.test(server + home)
  && /AI Trading Platform[^\n<]*Paper-First/i.test(server + home));

check('the legacy token alias permanently redirects to the canonical AITT route',
  /app\.get\('\/token',[\s\S]{0,180}res\.redirect\(308, '\/aitt'\)/.test(server)
  && /app\.get\('\/aitt',[\s\S]{0,120}sendPage\(req, res, 'token'\)/.test(server));

const sitemapMatch = server.match(/const SITEMAP_URLS = \[([^\]]+)\]/);
check('the sitemap publishes only the canonical AITT URL',
  sitemapMatch
  && sitemapMatch[1].includes("'/aitt'")
  && !sitemapMatch[1].includes("'/token'"));

check('draft legal documents stay out of search indexes and the sitemap',
  [terms, privacy, risk].every((html) => /<meta name="robots" content="noindex,follow">/.test(html))
  && !sitemapMatch[1].includes("'/terms'")
  && !sitemapMatch[1].includes("'/privacy'")
  && !sitemapMatch[1].includes("'/risk-disclosure'"));

check('draft legal documents use unambiguous paper-first product wording',
  [terms, privacy, risk].every((html) => /AI trading platform · paper-first/i.test(html))
  && [terms, privacy, risk].every((html) => !/real-trading/i.test(html)));

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
  /\/js\/auth\.js\?v=2\.8\.1/.test(app));

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
  && /\/css\/style\.css\?v=2\.12/.test(app));

for (const [name, html] of [['landing WebGL', home], ['3D Hub', hub]]) {
  check(`${name} animation pauses while the page is hidden`,
    /visibilitychange/.test(html)
    && /document\.hidden/.test(html)
    && /cancelAnimationFrame/.test(html));
}

check('3D Hub background refreshes are suppressed while hidden',
  /setInterval\(\(\)\s*=>\s*\{\s*if\s*\(!document\.hidden\)\s*loadData\(\)/.test(hub));

console.log('\nWebsite launch-readiness checks passed');
