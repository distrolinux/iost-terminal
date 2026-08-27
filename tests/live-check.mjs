// live.js verification — scratch state only; never touches accounts.json.
// Exercises allowlist, enable (real keys present), masked state, kill switch.
process.env.LIVE_EMAIL_ALLOWLIST = 'owner@test.local,owner@example.com';
process.env.LIVE_TRADING_ENABLED = '1';

const { enableLive, disableLive, getLiveState, isLiveAllowed, liveAuditFile } = await import('../lib/live.js');
import { readFileSync, existsSync } from 'node:fs';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const state = { accountId: 'smoke-live', owner: 'x', positions: [], journal: [], account: {} };

// allowlist (case-insensitive, fail-closed when empty)
ok('allowlist matches (case-insensitive)', isLiveAllowed('OWNER@TEST.LOCAL') === true);
ok('allowlist rejects unknown', isLiveAllowed('stranger@x.com') === false);

// enable: real Kraken keys are configured on this box → should succeed
const e = await enableLive(state, 'owner@test.local');
ok('enableLive ok (keys configured)', e.ok, e.error || `venue ${e.live?.venue}`);
ok('pilot flag set', e.live?.pilot === true);

// enable twice → refused
const e2 = await enableLive(state, 'owner@test.local');
ok('enableLive refuses double-enable', !e2.ok);

// masked state — no secrets anywhere
const ls = getLiveState(state, 'owner@test.local');
ok('getLiveState shows enabled+venue', ls.enabled === true && ls.venue === 'kraken');
ok('getLiveState has no secrets', !JSON.stringify(ls).includes('KRAKEN') && !JSON.stringify(ls).includes('Secret'));

// kill switch: no open orders on venue → clean disable
const d = await disableLive(state);
ok('disableLive (kill switch) ok', d.ok && d.wasEnabled === true && Array.isArray(d.cancelled));
ok('state back to disabled', getLiveState(state, 'owner@test.local').enabled === false);

// audit trail written
ok('audit file has entries', existsSync(liveAuditFile) && readFileSync(liveAuditFile, 'utf8').trim().split('\n').length >= 2);

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
