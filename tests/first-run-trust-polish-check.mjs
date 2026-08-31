import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public', 'app.html'), 'utf8');
const app = readFileSync(join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const onboarding = readFileSync(join(ROOT, 'public', 'js', 'onboarding.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const home = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');

for (const group of ['Observe', 'Plan', 'Agents', 'Account']) {
  assert.match(html, new RegExp(`data-nav-group="${group}"`), `navigation must expose the ${group} group`);
}
assert.match(html, /id="navSearchBtn"[^>]+aria-haspopup="dialog"/);
assert.match(html, /id="navSearchMobile"[^>]+aria-haspopup="dialog"/);
assert.match(html, /id="navPalette"[^>]+role="dialog"[^>]+aria-modal="true"/);
assert.match(html, /id="navPaletteInput"[^>]+aria-label="Search terminal destinations"/);
assert.match(app, /function setupNavPalette\(\)/);
assert.match(app, /\$\$\('\.nav-btn\[data-view\]'\)/, 'non-destination command buttons must not trigger view changes');
assert.match(app, /event\.(metaKey \|\| ctrlKey)|event\.(metaKey \|\| event\.ctrlKey)/);
assert.doesNotMatch(app.slice(app.indexOf('function setupNavPalette()'), app.indexOf('// ---------------- Owner Agent Control Center')), /cmdBuy|cmdSell|paper\/open|live\/enable/);

assert.match(html, /id="onboardingMission"[^>]+First session mission progress/);
assert.match(onboarding, /FIRST SESSION MISSION/);
assert.match(onboarding, /Challenge the strategy/);
assert.match(onboarding, /data-view="evaluation"|view: 'evaluation'/);
assert.match(onboarding, /bounded sandbox/);
assert.match(onboarding, /data-view="launchpad"|view: 'launchpad'/);
assert.match(onboarding, /SIMULATION ONLY|never calls an API/i);
assert.match(onboarding, /iost\.onboarding\.paper\.v3/);

assert.match(server, /LEADERBOARD_PROMOTION_MIN_TRADES\s*=\s*5/);
assert.match(server, /eligibleForPromotion:\s*trades\s*>=\s*LEADERBOARD_PROMOTION_MIN_TRADES\s*&&\s*pnl\s*>\s*0/);
assert.match(server, /promoted:\s*promotion\.eligible/);
assert.match(home, /Qualified paper evidence · honest samples/);
assert.match(home, /No paper trader has cleared the public evidence bar yet/);
assert.match(home, /d\.promoted/);
assert.doesNotMatch(home, /Live social proof · paper competition/);

assert.match(css, /\.nav-group-label/);
assert.match(css, /\.nav-palette/);
assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.nav-group \{ display: contents; \}/);
assert.match(html, /\/css\/style\.css\?v=2\.22/);
assert.match(html, /\/js\/app\.js\?v=2\.33\.0/);
assert.match(html, /\/js\/onboarding\.js\?v=1\.2\.0/);

console.log('First-run experience and trust-polish checks passed');
