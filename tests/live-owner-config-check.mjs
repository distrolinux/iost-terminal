// Regression: live trading must fail closed unless exactly one owner identity is configured.
// Each case imports live.js in a fresh child process because the allowlist is read at module load.
import { spawnSync } from 'node:child_process';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

function probe(allowlist, email) {
  const code = `import('./lib/live.js').then(m => console.log(JSON.stringify({cfg:m.liveOwnerConfig(), allowed:m.isLiveAllowed(${JSON.stringify(email)})})))`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, LIVE_TRADING_ENABLED: '1', LIVE_EMAIL_ALLOWLIST: allowlist },
    encoding: 'utf8',
  });
  if (r.status !== 0) return { error: r.stderr || `exit ${r.status}` };
  try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); }
  catch { return { error: r.stdout || 'invalid output' }; }
}

const none = probe('', 'owner@example.com');
ok('empty live owner config fails closed', none.cfg?.ok === false && none.allowed === false, none.error);

const one = probe('Owner@Example.com', 'owner@example.com');
ok('exactly one configured owner is allowed', one.cfg?.ok === true && one.cfg.owner === 'owner@example.com' && one.allowed === true, one.error);

const wrong = probe('owner@example.com', 'other@example.com');
ok('non-owner identity is rejected', wrong.cfg?.ok === true && wrong.allowed === false, wrong.error);

const multiple = probe('owner@example.com,other@example.com', 'owner@example.com');
ok('multiple live owners fail closed', multiple.cfg?.ok === false && multiple.allowed === false && /exactly one/.test(multiple.cfg?.error || ''), multiple.error);

const duplicate = probe('OWNER@example.com,owner@example.com', 'owner@example.com');
ok('duplicate spelling of the same owner is normalized safely', duplicate.cfg?.ok === true && duplicate.allowed === true, duplicate.error);

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
