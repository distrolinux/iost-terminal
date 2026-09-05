import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const server = readFileSync(new URL('server.js', root), 'utf8');
const auth = readFileSync(new URL('lib/auth.js', root), 'utf8');
const authRoutes = readFileSync(new URL('lib/auth-routes.js', root), 'utf8');
const authUi = readFileSync(new URL('public/js/auth.js', root), 'utf8');
const appUi = readFileSync(new URL('public/js/app.js', root), 'utf8');
const app = readFileSync(new URL('public/app.html', root), 'utf8');
const css = readFileSync(new URL('public/css/style.css', root), 'utf8');

function pass(name, condition) {
  assert.ok(condition, name);
  console.log(`PASS  ${name}`);
}

pass('password-reset tokens are validated only in a POST body, never a URL',
  /r\.post\('\/reset\/validate'/.test(authRoutes)
  && !/reset\/validate\?token/.test(authUi));

pass('new passwords have a bcrypt-safe UTF-8 byte ceiling',
  /MAX_PASSWORD_BYTES\s*=\s*72/.test(auth)
  && /Buffer\.byteLength\(password, 'utf8'\)/.test(auth));

pass('session secrets and audit logs honor the isolated data directory',
  /const DATA_DIR = process\.env\.IOST_DATA_DIR \|\| join\(ROOT, 'data'\)/.test(server)
  && /join\(DATA_DIR, 'session-secret'\)/.test(server)
  && /join\(DATA_DIR, 'agent-audit\.jsonl'\)/.test(server));

pass('authenticated and auth responses are explicitly private and non-cacheable',
  /Cache-Control', 'private, no-store, max-age=0'/.test(server)
  && /Vary', 'Cookie, Authorization, X-API-Key'/.test(server));

pass('baseline response hardening includes opener, resource and legacy plugin isolation',
  /Cross-Origin-Opener-Policy': 'same-origin'/.test(server)
  && /Cross-Origin-Resource-Policy': 'same-origin'/.test(server)
  && /X-Permitted-Cross-Domain-Policies': 'none'/.test(server));

pass('shared detail dialogs trap focus, restore the opener and receive contextual labels',
  /let detailLastFocus = null/.test(appUi)
  && /function openDetailDialog\(/.test(appUi)
  && /function trapDetailFocus\(/.test(appUi)
  && /detailLastFocus\?\.focus/.test(appUi)
  && /setAttribute\('aria-label'/.test(appUi));

pass('scanner rows expose button semantics and keyboard activation',
  /<tr class="clickable anim-row"[^>]+role="button"[^>]+tabindex="0"/.test(appUi)
  && /view-scanner tr\.clickable[\s\S]{0,500}e\.key === 'Enter' \|\| e\.key === ' '/.test(appUi));

pass('asset-detail tabs implement relationships and roving keyboard focus',
  /role="tab"[^>]+aria-controls="tab-overview"/.test(appUi)
  && /role="tabpanel"[^>]+aria-labelledby="detail-tab-overview"/.test(appUi)
  && /ArrowRight|ArrowLeft/.test(appUi));

pass('chart canvases expose image semantics and textual summaries',
  /role="img"[^>]+aria-describedby="evChartSummary"/.test(appUi)
  && /id="evChartSummary"[^>]+class="sr-only"/.test(appUi));

pass('hidden responsive canvases do not render invalid negative-radius gauges',
  /function drawGauge\([\s\S]{0,500}if \(w < 32 \|\| h < 32\) return;/.test(appUi));

const dim = css.match(/--dim:\s*(#[0-9a-f]{6})/i)?.[1];
const surface = css.match(/--surface:\s*(#[0-9a-f]{6})/i)?.[1];
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
pass('Terminal dim text meets WCAG AA contrast on cards', dim && surface && contrast(dim, surface) >= 4.5);

pass('security and accessibility assets are cache-versioned',
  /\/css\/style\.css\?v=2\.29/.test(app)
  && /\/js\/app\.js\?v=2\.40\.1/.test(app)
  && /\/js\/auth\.js\?v=2\.10\.0/.test(app));

console.log('\nPR #30 security and accessibility contracts passed');
