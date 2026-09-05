// Execute deploy-host.sh against a stateful fake Docker CLI. This proves that
// a failed promoted container restores the exact paused predecessor and that a
// successful promotion retains one paused last-known-good process.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVISION = 'a'.repeat(40);
const FAKE_DOCKER = `#!/bin/bash
set -eu
state="$FAKE_DOCKER_STATE"
cmd="$1"; shift
last="\${!#}"
case "$cmd" in
  inspect)
    file="$state/$last"; [ -f "$file" ] || exit 1
    value="$(cat "$file")"
    args="$*"
    if [[ "$args" == *State.Running* ]]; then [[ "$value" == *running || "$value" == *paused ]] && echo true || echo false
    elif [[ "$args" == *State.Paused* ]]; then [[ "$value" == *paused ]] && echo true || echo false
    elif [[ "$args" == *NetworkSettings.Networks* ]]; then echo testnet
    elif [[ "$args" == *Config.Env* ]]; then echo NODE_ENV=production
    fi
    ;;
  ps)
    for file in "$state"/*; do
      [ -f "$file" ] || continue
      value="$(cat "$file")"
      [[ "$value" == *running || "$value" == *paused ]] || continue
      basename "$file"
    done
    ;;
  port) exit 1 ;;
  build) exit 0 ;;
  run)
    name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--name" ]; then name="$2"; shift 2; else shift; fi
    done
    [[ "$name" == *candidate* ]] && echo candidate-running > "$state/$name" || echo new-running > "$state/$name"
    echo fake-container-id
    ;;
  exec)
    container="$1"
    value="$(cat "$state/$container")"
    [ "$value" != new-running ] || [ "\${FAKE_PROMOTION_FAIL:-0}" != 1 ]
    ;;
  pause) echo old-paused > "$state/$1" ;;
  unpause) echo old-running > "$state/$1" ;;
  start) echo old-running > "$state/$1" ;;
  rename) mv "$state/$1" "$state/$2" ;;
  rm) rm -f "$state/$last" ;;
  logs) exit 0 ;;
  *) echo "unsupported fake docker command: $cmd" >&2; exit 1 ;;
esac
`;

const FAKE_GIT = `#!/bin/bash
case "$*" in
  *"ls-files --others"*) exit 0 ;;
  *"rev-parse --verify HEAD"*) echo ${REVISION} ;;
  *) exit 0 ;;
esac
`;

function runScenario(promotionFails, preflightOnly = false, extraArgs = []) {
  const scratch = mkdtempSync(join(tmpdir(), 'iost-deploy-test-'));
  const app = join(scratch, 'app');
  const bin = join(scratch, 'bin');
  const state = join(scratch, 'state');
  mkdirSync(app); mkdirSync(bin); mkdirSync(state);
  writeFileSync(join(app, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(state, 'iost-terminal'), 'old-running\n');
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  writeFileSync(join(bin, 'git'), FAKE_GIT);
  writeFileSync(join(bin, 'curl'), `#!/bin/bash\necho '{"ok":true,"revision":"${REVISION}"}'\n`);
  writeFileSync(join(bin, 'flock'), '#!/bin/bash\nexit 0\n');
  writeFileSync(join(bin, 'stat'), '#!/bin/bash\necho 1000\n');
  writeFileSync(join(bin, 'chown'), '#!/bin/bash\nexit 0\n');
  for (const name of ['docker', 'git', 'curl', 'flock', 'stat', 'chown']) chmodSync(join(bin, name), 0o755);

  const result = spawnSync('bash', [join(ROOT, 'deploy-host.sh'), ...extraArgs], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      APP: app,
      DATA_DIR: join(scratch, 'data'),
      LOCK_FILE: join(scratch, 'deploy.lock'),
      HEALTH_TIMEOUT: '1',
      HEALTH_INTERVAL: '0.05',
      PUBLIC_HEALTH_URL: 'https://example.invalid/api/health',
      FAKE_DOCKER_STATE: state,
      FAKE_PROMOTION_FAIL: promotionFails ? '1' : '0',
      PREFLIGHT_ONLY: preflightOnly ? '1' : '0',
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  const containers = Object.fromEntries(readdirSync(state).map((name) => [name, readFileSync(join(state, name), 'utf8').trim()]));
  rmSync(scratch, { recursive: true, force: true });
  return { ...result, containers, output: `${result.stdout}${result.stderr}` };
}

let failures = 0;
const ok = (name, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) failures++;
};

const failed = runScenario(true);
ok('failed promotion exits nonzero', failed.status !== 0, failed.output);
ok('failed promotion restores and unpauses the predecessor',
  failed.containers['iost-terminal'] === 'old-running'
  && Object.keys(failed.containers).every((name) => !name.includes('rollback')), failed.output);
ok('failed promotion reports a healthy rollback', /rollback healthy/.test(failed.output), failed.output);

const preflight = runScenario(false, false, ['--preflight-only']);
ok('preflight-only exits successfully without touching production',
  preflight.status === 0
  && preflight.containers['iost-terminal'] === 'old-running'
  && Object.keys(preflight.containers).length === 1
  && /preflight only; production was not paused/.test(preflight.output), preflight.output);

const unknownArgument = runScenario(false, false, ['--deploy-now']);
ok('unknown arguments fail before Docker or production state is touched',
  unknownArgument.status === 2
  && unknownArgument.containers['iost-terminal'] === 'old-running'
  && /unknown argument/.test(unknownArgument.output), unknownArgument.output);

const passed = runScenario(false);
const rollback = Object.entries(passed.containers).find(([name]) => name.includes('rollback'));
ok('healthy promotion exits successfully', passed.status === 0, passed.output);
ok('healthy promotion runs the immutable replacement', passed.containers['iost-terminal'] === 'new-running', passed.output);
ok('healthy promotion retains one paused predecessor', rollback?.[1] === 'old-paused', passed.output);

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
