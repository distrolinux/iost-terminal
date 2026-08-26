// Static deployment-contract regression. The host script itself is never run
// by tests: these assertions ensure it cannot regress to destructive replace-
// first deployment or start a second writer against production data.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'deploy-host.sh'), 'utf8');
let failures = 0;
const ok = (name, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures++;
};

const candidateStart = src.indexOf('start_candidate');
const candidateHealth = src.indexOf('wait_for_health "$CANDIDATE"');
const oldPause = src.indexOf('docker_cmd pause');
const dataOwnership = src.indexOf('chown -R "$APP_UID:$APP_GID" "$DATA_DIR"');
const productionStart = src.indexOf('echo "==> starting production from $IOST_IMAGE..."');

ok('deployment is strict and serialized', /set -Eeuo pipefail/.test(src) && /flock\s+-n/.test(src));
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
ok('deployment builds an immutable image from a supported LTS runtime',
  /docker_cmd build --pull/.test(src)
  && /IOST_IMAGE/.test(src)
  && /^FROM node:24-bookworm-slim$/m.test(dockerfile)
  && !/^FROM node:20/m.test(dockerfile));
ok('candidate uses isolated scratch data', /start_candidate[\s\S]*--tmpfs ["']?\/app\/data:/.test(src));
ok('candidate becomes healthy before the production writer pauses',
  candidateStart >= 0 && candidateHealth > candidateStart && oldPause > candidateHealth);
ok('legacy data ownership is migrated only after the old writer pauses',
  dataOwnership > oldPause && productionStart > dataOwnership);
ok('preflight-only mode exits before production promotion',
  /PREFLIGHT_ONLY/.test(src)
  && src.indexOf('PREFLIGHT_ONLY') > candidateHealth
  && src.indexOf('PREFLIGHT_ONLY') < oldPause);
ok('network discovery targets production or Traefik, never an arbitrary container',
  /network_for_container/.test(src) && !/docker ps -q \| head -1/.test(src));
ok('failed promotion invokes rollback of the exact paused process',
  /rollback_production/.test(src) && /promotion failed/.test(src) && /docker_cmd unpause/.test(src));
ok('production is checked internally and through the public route',
  /wait_for_health "\$PROD_CONTAINER"/.test(src)
  && /PUBLIC_HEALTH_URL/.test(src)
  && /APP_REVISION/.test(src)
  && /EXPECTED_REVISION/.test(src));
ok('script never performs public-chain or live-order actions',
  !/hardhat\s+run|deploy\.js|api\/live\/proposals|placeOrder|sendTransaction/.test(src));

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
