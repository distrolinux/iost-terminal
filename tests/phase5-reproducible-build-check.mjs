// Standalone, local-only Phase 5 reproducible-build record regression.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePhase5ReproducibleBuild } from '../lib/phase5-reproducible-build.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readFixture = (name) => JSON.parse(readFileSync(
  join(ROOT, 'tests', 'fixtures', name),
  'utf8',
));
const releaseTarget = readFixture('phase5-release-target-valid.json');
const fixture = readFixture('phase5-reproducible-build-valid.json');
const clone = () => structuredClone(fixture);
const hasCodeAt = (result, code, path) => result.errors.some(
  (error) => error.code === code && error.path === path,
);

const result = validatePhase5ReproducibleBuild(fixture, releaseTarget);
assert.deepEqual(result, { valid: true, errors: [] });
assert.equal(fixture.scope, 'local-reproducibility-only');
assert.equal(fixture.externalAudit, false);
assert.equal(fixture.releaseAuthorization, false);

console.log('PASS  matching local-only build runs validate without claiming audit or authorization');

const missingExecutionProof = clone();
delete missingExecutionProof.runs[0].executionProof;
const missingExecutionProofResult = validatePhase5ReproducibleBuild(
  missingExecutionProof,
  releaseTarget,
);
assert.equal(missingExecutionProofResult.valid, false);
assert.equal(hasCodeAt(
  missingExecutionProofResult,
  'missing_execution_proof',
  '$.runs[0].executionProof',
), true);
console.log('PASS  missing per-run execution proof fails closed');

for (const [name, field] of [
  ['reference', 'reference'],
  ['content hash', 'contentHash'],
]) {
  const reusedExecutionProof = clone();
  reusedExecutionProof.runs[1].executionProof[field]
    = reusedExecutionProof.runs[0].executionProof[field];
  const reusedExecutionProofResult = validatePhase5ReproducibleBuild(
    reusedExecutionProof,
    releaseTarget,
  );
  assert.equal(reusedExecutionProofResult.valid, false);
  assert.equal(hasCodeAt(
    reusedExecutionProofResult,
    'duplicate_execution_proof',
    `$.runs[1].executionProof.${field}`,
  ), true);
  console.log(`PASS  reused execution-proof ${name} fails closed`);
}

const caseVariantExecutionProofHash = clone();
caseVariantExecutionProofHash.runs[1].executionProof.contentHash = `0x${
  caseVariantExecutionProofHash.runs[0].executionProof.contentHash.slice(2).toUpperCase()
}`;
const caseVariantExecutionProofHashResult = validatePhase5ReproducibleBuild(
  caseVariantExecutionProofHash,
  releaseTarget,
);
assert.equal(caseVariantExecutionProofHashResult.valid, false);
assert.equal(hasCodeAt(
  caseVariantExecutionProofHashResult,
  'duplicate_execution_proof',
  '$.runs[1].executionProof.contentHash',
), true);
console.log('PASS  case-variant duplicate execution-proof hash fails closed');

const mismatchedCleanTreeHash = clone();
mismatchedCleanTreeHash.runs[0].cleanTreeProofHash = `0x${'b'.repeat(64)}`;
const mismatchedCleanTreeHashResult = validatePhase5ReproducibleBuild(
  mismatchedCleanTreeHash,
  releaseTarget,
);
assert.equal(mismatchedCleanTreeHashResult.valid, false);
assert.equal(hasCodeAt(
  mismatchedCleanTreeHashResult,
  'fingerprint_mismatch',
  '$.runs[0].cleanTreeProofHash',
), true);
console.log('PASS  clean-tree proof hash mismatch fails closed');

const omittedRunbook = clone();
omittedRunbook.runs[0].runbooks.pop();
const omittedRunbookResult = validatePhase5ReproducibleBuild(omittedRunbook, releaseTarget);
assert.equal(omittedRunbookResult.valid, false);
assert.equal(hasCodeAt(omittedRunbookResult, 'incomplete_runbooks', '$.runs[0].runbooks'), true);
console.log('PASS  omitted required runbook fails closed');

const mismatchedRunbookHash = clone();
mismatchedRunbookHash.runs[0].runbooks[1].contentHash = `0x${'c'.repeat(64)}`;
const mismatchedRunbookHashResult = validatePhase5ReproducibleBuild(
  mismatchedRunbookHash,
  releaseTarget,
);
assert.equal(mismatchedRunbookHashResult.valid, false);
assert.equal(hasCodeAt(
  mismatchedRunbookHashResult,
  'fingerprint_mismatch',
  '$.runs[0].runbooks[1].contentHash',
), true);
console.log('PASS  runbook hash mismatch fails closed');

const duplicateRunbookHash = clone();
duplicateRunbookHash.runs[0].runbooks[1].contentHash
  = duplicateRunbookHash.runs[0].runbooks[0].contentHash;
const duplicateRunbookHashResult = validatePhase5ReproducibleBuild(
  duplicateRunbookHash,
  releaseTarget,
);
assert.equal(duplicateRunbookHashResult.valid, false);
assert.equal(hasCodeAt(
  duplicateRunbookHashResult,
  'duplicate_runbook_evidence',
  '$.runs[0].runbooks[1].contentHash',
), true);
console.log('PASS  duplicate runbook hash fails closed');

const mixedRunbookTarget = clone();
mixedRunbookTarget.runs[0].runbooks[1].targetId = 'fixture-only:release-target:other';
const mixedRunbookTargetResult = validatePhase5ReproducibleBuild(
  mixedRunbookTarget,
  releaseTarget,
);
assert.equal(mixedRunbookTargetResult.valid, false);
assert.equal(hasCodeAt(
  mixedRunbookTargetResult,
  'target_mismatch',
  '$.runs[0].runbooks[1].targetId',
), true);
console.log('PASS  mixed-target runbook evidence fails closed');

const dirtyTree = clone();
dirtyTree.runs[0].treeState = 'dirty';
const dirtyTreeResult = validatePhase5ReproducibleBuild(dirtyTree, releaseTarget);
assert.equal(dirtyTreeResult.valid, false);
assert.equal(hasCodeAt(dirtyTreeResult, 'dirty_tree', '$.runs[0].treeState'), true);
console.log('PASS  dirty-tree run fails closed');

const mismatchedCleanTreeProof = clone();
mismatchedCleanTreeProof.runs[0].cleanTreeProofReference = 'fixture-only:source:clean-tree-proof-other';
const mismatchedCleanTreeProofResult = validatePhase5ReproducibleBuild(
  mismatchedCleanTreeProof,
  releaseTarget,
);
assert.equal(mismatchedCleanTreeProofResult.valid, false);
assert.equal(hasCodeAt(
  mismatchedCleanTreeProofResult,
  'fingerprint_mismatch',
  '$.runs[0].cleanTreeProofReference',
), true);
console.log('PASS  clean-tree proof reference mismatch fails closed');

const mixedTarget = clone();
mixedTarget.runs[1].targetId = 'fixture-only:release-target:other';
const mixedTargetResult = validatePhase5ReproducibleBuild(mixedTarget, releaseTarget);
assert.equal(mixedTargetResult.valid, false);
assert.equal(hasCodeAt(mixedTargetResult, 'target_mismatch', '$.runs[1].targetId'), true);
console.log('PASS  mismatched run target ID fails closed');

const missingLockfile = clone();
missingLockfile.runs[0].lockfiles = missingLockfile.runs[0].lockfiles.filter(
  ({ kind }) => kind !== 'contracts-npm',
);
const missingLockfileResult = validatePhase5ReproducibleBuild(missingLockfile, releaseTarget);
assert.equal(missingLockfileResult.valid, false);
assert.equal(hasCodeAt(missingLockfileResult, 'incomplete_lockfiles', '$.runs[0].lockfiles'), true);
console.log('PASS  missing required lockfile fails closed');

const missingToolchain = clone();
delete missingToolchain.runs[0].toolchain.hardhatVersionReference;
const missingToolchainResult = validatePhase5ReproducibleBuild(missingToolchain, releaseTarget);
assert.equal(missingToolchainResult.valid, false);
assert.equal(hasCodeAt(
  missingToolchainResult,
  'missing_toolchain_reference',
  '$.runs[0].toolchain.hardhatVersionReference',
), true);
console.log('PASS  missing toolchain reference fails closed');

const missingCompiler = clone();
delete missingCompiler.runs[0].toolchain.compiler;
const missingCompilerResult = validatePhase5ReproducibleBuild(missingCompiler, releaseTarget);
assert.equal(missingCompilerResult.valid, false);
assert.equal(hasCodeAt(missingCompilerResult, 'missing_compiler', '$.runs[0].toolchain.compiler'), true);
console.log('PASS  missing compiler reference fails closed');

const invalidHash = clone();
invalidHash.runs[0].cleanTreeProofHash = '0x1234';
const invalidHashResult = validatePhase5ReproducibleBuild(invalidHash, releaseTarget);
assert.equal(invalidHashResult.valid, false);
assert.equal(hasCodeAt(invalidHashResult, 'invalid_hash', '$.runs[0].cleanTreeProofHash'), true);
console.log('PASS  malformed content hash fails closed');

const mismatchedFingerprint = clone();
mismatchedFingerprint.runs[1].deployedBundleHash = `0x${'f'.repeat(64)}`;
const mismatchedFingerprintResult = validatePhase5ReproducibleBuild(
  mismatchedFingerprint,
  releaseTarget,
);
assert.equal(mismatchedFingerprintResult.valid, false);
assert.equal(hasCodeAt(
  mismatchedFingerprintResult,
  'fingerprint_mismatch',
  '$.runs[1].deployedBundleHash',
), true);
console.log('PASS  bytecode fingerprint mismatch fails closed');

for (const [name, mutate, path] of [
  [
    'lockfile',
    (value) => { value.runs[0].lockfiles[0].contentHash = `0x${'e'.repeat(64)}`; },
    '$.runs[0].lockfiles[0].contentHash',
  ],
  [
    'compiler settings',
    (value) => { value.runs[0].toolchain.compiler.settingsHash = `0x${'d'.repeat(64)}`; },
    '$.runs[0].toolchain.compiler.settingsHash',
  ],
  [
    'config',
    (value) => { value.runs[0].configHash = `0x${'c'.repeat(64)}`; },
    '$.runs[0].configHash',
  ],
  [
    'source',
    (value) => { value.runs[0].sourceCommitReference = 'fixture-only:source:commit-other'; },
    '$.runs[0].sourceCommitReference',
  ],
]) {
  const mismatch = clone();
  mutate(mismatch);
  const mismatchResult = validatePhase5ReproducibleBuild(mismatch, releaseTarget);
  assert.equal(mismatchResult.valid, false);
  assert.equal(hasCodeAt(mismatchResult, 'fingerprint_mismatch', path), true);
  console.log(`PASS  ${name} fingerprint mismatch fails closed`);
}

const productionClaim = clone();
productionClaim.status = 'production-ready';
productionClaim.hold = false;
productionClaim.externalAudit = true;
productionClaim.releaseAuthorization = true;
productionClaim.runs[0].environment = 'production';
const productionClaimResult = validatePhase5ReproducibleBuild(productionClaim, releaseTarget);
assert.equal(productionClaimResult.valid, false);
for (const code of [
  'unsupported_status',
  'hold_required',
  'audit_claim_prohibited',
  'authorization_claim_prohibited',
  'local_environment_required',
]) {
  assert.equal(productionClaimResult.errors.some((error) => error.code === code), true);
}
console.log('PASS  production/audit/authorization claims fail closed');

const unknownField = clone();
unknownField.runs[0].approval = 'fixture-only:approval:none';
const unknownFieldResult = validatePhase5ReproducibleBuild(unknownField, releaseTarget);
assert.equal(unknownFieldResult.valid, false);
assert.equal(hasCodeAt(unknownFieldResult, 'unknown_field', '$.runs[0].approval'), true);
console.log('PASS  unknown field fails closed');

const secretField = clone();
secretField.runs[0].deployerPrivateKey = 'fixture-only:key:prohibited';
const secretFieldResult = validatePhase5ReproducibleBuild(secretField, releaseTarget);
assert.equal(secretFieldResult.valid, false);
assert.equal(hasCodeAt(
  secretFieldResult,
  'prohibited_secret_field',
  '$.runs[0].deployerPrivateKey',
), true);
console.log('PASS  secret-bearing field fails closed');

const oneRun = clone();
oneRun.runs.pop();
const oneRunResult = validatePhase5ReproducibleBuild(oneRun, releaseTarget);
assert.equal(oneRunResult.valid, false);
assert.equal(hasCodeAt(oneRunResult, 'incomplete_runs', '$.runs'), true);
console.log('PASS  fewer than two independent runs fail closed');

const nonFixtureReference = clone();
nonFixtureReference.runs[0].runId = 'build-run-alpha';
const nonFixtureReferenceResult = validatePhase5ReproducibleBuild(nonFixtureReference, releaseTarget);
assert.equal(nonFixtureReferenceResult.valid, false);
assert.equal(hasCodeAt(nonFixtureReferenceResult, 'invalid_reference', '$.runs[0].runId'), true);
console.log('PASS  non-fixture reference fails closed');

const malformedLockfile = clone();
malformedLockfile.runs[0].lockfiles[0] = null;
const malformedLockfileResult = validatePhase5ReproducibleBuild(malformedLockfile, releaseTarget);
assert.equal(malformedLockfileResult.valid, false);
assert.equal(hasCodeAt(
  malformedLockfileResult,
  'invalid_lockfile',
  '$.runs[0].lockfiles[0]',
), true);
console.log('PASS  malformed lockfile entry returns a fail-closed result');
