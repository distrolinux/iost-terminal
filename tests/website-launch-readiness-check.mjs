import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const token = readFileSync(new URL('../public/token.html', import.meta.url), 'utf8');

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

check('the AITT page declares its canonical URL',
  /<link rel="canonical" href="https:\/\/iostcallister\.com\/aitt">/.test(token));

check('pre-launch AITT structured data is a web page, not an available product',
  /"@type": "WebPage"/.test(token)
  && /"about": \{ "@type": "Thing"/.test(token)
  && !/"@type": "Product"/.test(token));

check('market observations are not represented as products offered for sale',
  !/availability:\s*'https:\/\/schema\.org\/InStock'/.test(server)
  && !/seller:\s*\{ '@id': '\/#org' \}/.test(server));

for (const [name, html] of [['landing', home], ['AITT', token]]) {
  check(`${name} page has a keyboard skip link and main landmark`,
    /class="skip-link" href="#main-content"/.test(html)
    && /<main[^>]+id="main-content"/.test(html));
}

console.log('\nWebsite launch-readiness checks passed');
