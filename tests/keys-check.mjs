// keys.js + per-user broker verification.
// Scratch user object only — users.json untouched. Read-only Kraken calls only.
import { setUserKrakenKey, getUserKrakenKeys, clearUserKrakenKey, userKrakenStatus } from '../lib/keys.js';
import { createKrakenBroker } from '../lib/broker/kraken.js';
import { enableLive, disableLive, getLiveState } from '../lib/live.js';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const KEY = 'YOUR_KRAKEN_API_KEY';
const SECRET = 'YOUR_KRAKEN_API_SECRET';

// encryption round-trip on a scratch user
const user = { id: 'scratch-user', email: 'u@x.com' };
const r = setUserKrakenKey(user, KEY, SECRET);
ok('setUserKrakenKey ok', r.ok);
ok('no plaintext on record', !JSON.stringify(user).includes(SECRET) && !JSON.stringify(user).includes(KEY));
ok('blob has iv/tag/data', user.krakenKey?.iv && user.krakenKey?.tag && user.krakenKey?.data);

const dec = getUserKrakenKeys(user);
ok('decrypt round-trip', dec?.apiKey === KEY && dec?.apiSecret === SECRET);

// corruption → null (never crashes)
const corrupted = { ...user, krakenKey: { ...user.krakenKey, data: 'AAAA' } };
ok('corrupt blob → null (fail safe)', getUserKrakenKeys(corrupted) === null);

// masked status
const st = userKrakenStatus(user);
ok('status masked', st.configured === true && st.maskedKey.includes('nFGx') && !JSON.stringify(st).includes(SECRET));

clearUserKrakenKey(user);
ok('clear works', getUserKrakenKeys(user) === null && userKrakenStatus(user).configured === false);

// per-user broker with REAL keys — read-only balance (no orders)
const broker = createKrakenBroker({ apiKey: KEY, apiSecret: SECRET });
ok('per-user broker configured', broker.configured === true);
const acct = await broker.getAccount();
ok('per-user broker read-only balance works', acct.ok, acct.ok ? `cashUsd ${acct.account.cashUsd}` : acct.error);

// live enable with own keys (scratch account state — no disk writes)
const state = { accountId: 'smoke-self', owner: 'u', positions: [], journal: [], account: {} };
const e = await enableLive(state, 'nobody@not-allowlisted.com', true);
ok('enableLive with own keys bypasses allowlist', e.ok && e.live.venue === 'kraken:self', e.error || e.live.venue);
ok('live state reflects own venue', getLiveState(state).venue === 'kraken:self');
const d = await disableLive(state, broker); // kill switch against user's own broker (no orders → clean)
ok('disableLive with own broker clean', d.ok && d.wasEnabled && d.cancelled.length === 0);

console.log(failures === 0 ? '\nALL PASS ✅ (no orders placed, users.json untouched)' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
