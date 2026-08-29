import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, '.tmp-self-service-agent-launchpad');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

const wallets = await import('../lib/wallets.js');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
const html = readFileSync(join(ROOT, 'public', 'app.html'), 'utf8');
const app = readFileSync(join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'css', 'style.css'), 'utf8');

try {
  assert.equal(wallets.PAPER_ONBOARDING_CREDIT_CAP_MINOR, 10_000,
    'self-service launchpad must have a fixed $100 lifetime paper-credit ceiling');

  const first = wallets.grantPaperOnboardingCredits('user:launchpad-owner', 7_500);
  assert.equal(first.grantedMinor, 7_500);
  assert.equal(first.remainingGrantMinor, 2_500);
  const second = wallets.grantPaperOnboardingCredits('user:launchpad-owner', 2_500);
  assert.equal(second.lifetimeGrantedMinor, 10_000);
  assert.throws(
    () => wallets.grantPaperOnboardingCredits('user:launchpad-owner', 1),
    /paper onboarding credit limit reached/,
    'repeated setup cannot mint unlimited simulation credits',
  );

  assert.match(server, /app\.get\('\/api\/agent-launchpad',\s*requireUser/,
    'launchpad status must require authentication');
  assert.match(server, /app\.post\('\/api\/agent-launchpad\/setup',\s*requireUser/,
    'launchpad setup must require authentication');
  assert.match(server, /app\.post\('\/api\/agent-launchpad\/pact',\s*requireUser/,
    'an ended Pact must be replaceable without creating another wallet');
  assert.match(server, /agent keys cannot set up or approve a Launchpad/,
    'agent credentials must not bootstrap or approve their own authority');
  assert.match(server, /function sessionOwnsPact[\s\S]{0,500}pact\.ownerId === `user:\$\{req\.session\.userId\}`/,
    'Pact approval must bind the signed-in user to the stored Pact owner');
  assert.match(server, /function canManagePact[\s\S]{0,250}sessionOwnsPact/,
    'the Pact management gate must include signed-in ownership');
  assert.match(server, /app\.post\('\/api\/pacts\/:id\/approve'[\s\S]{0,500}canManagePact/,
    'ordinary signed-in users may approve only an owned Pact');
  assert.match(server, /app\.post\('\/api\/pacts\/:id\/terminate'[\s\S]{0,500}canManagePact/,
    'ordinary signed-in users may terminate only an owned Pact');

  assert.match(html, /data-view="launchpad"/,
    'Terminal navigation must expose the Agent Launchpad');
  assert.match(html, /id="view-launchpad"/,
    'Terminal must provide a dedicated Agent Launchpad view');
  assert.match(app, /Self-service Agent Launchpad/,
    'Launchpad must explain the self-service agent journey');
  assert.match(app, /\/api\/agent-launchpad\/setup/,
    'Launchpad UI must use the bounded setup route');
  assert.match(app, /\/api\/agent-launchpad\/pact/,
    'Launchpad UI must let the human propose a replacement Pact');
  assert.match(app, /capabilities:\s*\['trade\.paper'\]/,
    'Launchpad-created wallets must remain paper-only');
  assert.match(app, /Copy MCP endpoint/,
    'Launchpad must provide a concrete MCP connection handoff');
  assert.match(app, /Emergency pause|Pause wallet/,
    'Launchpad must expose an immediate stop control');
  assert.doesNotMatch(app, /agent-launchpad[\s\S]{0,2000}trade\.live/,
    'Launchpad must never offer a live-trading scope');
  assert.match(css, /\.launchpad-steps/,
    'Launchpad must have responsive step styling');

  console.log('self-service Agent Launchpad checks passed');
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
