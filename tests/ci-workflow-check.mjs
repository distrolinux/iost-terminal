import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/safety.yml', import.meta.url), 'utf8');
const scanner = readFileSync(new URL('../scripts/check-secrets.sh', import.meta.url), 'utf8');
let failed = 0;

function ok(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failed++;
}

ok('workflow has read-only repository permissions',
  /permissions:\s*\n\s+contents: read/.test(workflow)
  && !/contents: write|packages: write|id-token: write|actions: write/.test(workflow));
ok('third-party actions are pinned to immutable commit SHAs',
  [...workflow.matchAll(/uses:\s*([^\s]+)/g)].length > 0
  && [...workflow.matchAll(/uses:\s*([^\s]+)/g)].every((match) => /@[a-f0-9]{40}$/.test(match[1])));
ok('application job installs the lockfile and runs the complete safety suite',
  /npm ci --ignore-scripts/.test(workflow) && /run: npm test/.test(workflow)
  && /node --check server\.js/.test(workflow));
ok('production dependencies fail on high-severity audit findings',
  /npm audit --omit=dev --audit-level=high/.test(workflow));
ok('local-only contract toolchain fails on critical audit findings',
  /Audit local-only contract toolchain[\s\S]*npm audit --audit-level=critical/.test(workflow));
ok('contract verification is explicitly local-only',
  /HARDHAT_NETWORK: hardhat/.test(workflow)
  && /npx --no-install hardhat compile --force/.test(workflow)
  && !/--network iostL2|l2-mainnet\.iost\.io|sendTransaction/.test(workflow));
ok('workflow has no secret interpolation or production mutation commands',
  !/\$\{\{\s*secrets\.|deploy-host|docker\s+(?:restart|run|stop|rm)|kubectl|tailscale\s+file/.test(workflow));
ok('secret scanner covers private keys and common credential prefixes without printing matches',
  /PRIVATE KEY/.test(scanner) && /github_pat_/.test(scanner) && /hooks\\\.slack\\\.com/.test(scanner)
  && /git grep -IlE/.test(scanner) && !/git grep -In/.test(scanner));

if (failed) process.exit(1);
console.log('CI workflow safety contract checks passed');
