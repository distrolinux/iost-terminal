// Standalone, local-only Phase 5 release-target record regression.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhase5ReleaseTarget,
  validatePhase5ReleaseTarget,
} from '../lib/phase5-release-target.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(
  join(ROOT, 'tests', 'fixtures', 'phase5-release-target-valid.json'),
  'utf8',
));
const clone = () => structuredClone(fixture);
const hasCode = (result, code) => result.errors.some((error) => error.code === code);
const hasCodeAt = (result, code, path) => result.errors.some(
  (error) => error.code === code && error.path === path,
);
let failures = 0;
const ok = (name, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures++;
};

const valid = validatePhase5ReleaseTarget(fixture);
ok('valid local-fixture/HOLD record passes', valid.valid, JSON.stringify(valid.errors));

const built = buildPhase5ReleaseTarget({
  targetId: fixture.targetId,
  chainIntent: fixture.chainIntent,
  source: fixture.source,
  dependencies: fixture.dependencies,
  toolchain: fixture.toolchain,
  config: fixture.config,
  bytecode: fixture.bytecode,
  runbooks: fixture.runbooks,
});
assert.deepEqual(built, fixture);
ok('builder emits the canonical local-fixture/HOLD record', true);

const incomplete = clone();
delete incomplete.source.cleanTreeProofReference;
const incompleteResult = validatePhase5ReleaseTarget(incomplete);
ok('incomplete source proof fails closed',
  !incompleteResult.valid
    && hasCodeAt(incompleteResult, 'missing_field', '$.source.cleanTreeProofReference'));

const missingCleanTreeProofHash = clone();
delete missingCleanTreeProofHash.source.cleanTreeProofHash;
const missingCleanTreeProofHashResult = validatePhase5ReleaseTarget(missingCleanTreeProofHash);
ok('missing clean-tree proof hash fails closed',
  !missingCleanTreeProofHashResult.valid
    && hasCodeAt(missingCleanTreeProofHashResult, 'missing_field', '$.source.cleanTreeProofHash'));

const missingRunbookReference = clone();
delete missingRunbookReference.runbooks[0].pathReference;
const missingRunbookReferenceResult = validatePhase5ReleaseTarget(missingRunbookReference);
ok('missing runbook reference fails closed',
  !missingRunbookReferenceResult.valid
    && hasCodeAt(
      missingRunbookReferenceResult,
      'invalid_reference',
      '$.runbooks[0].pathReference',
    ));

const duplicateRunbookHash = clone();
duplicateRunbookHash.runbooks[1].contentHash = duplicateRunbookHash.runbooks[0].contentHash;
const duplicateRunbookHashResult = validatePhase5ReleaseTarget(duplicateRunbookHash);
ok('duplicate runbook content hash fails closed',
  !duplicateRunbookHashResult.valid
    && hasCodeAt(
      duplicateRunbookHashResult,
      'duplicate_runbook_evidence',
      '$.runbooks[1].contentHash',
    ));

const caseVariantRunbookHash = clone();
caseVariantRunbookHash.runbooks[0].contentHash = `0x${'a'.repeat(64)}`;
caseVariantRunbookHash.runbooks[1].contentHash = `0x${'A'.repeat(64)}`;
const caseVariantRunbookHashResult = validatePhase5ReleaseTarget(caseVariantRunbookHash);
ok('case-variant duplicate runbook content hash fails closed',
  !caseVariantRunbookHashResult.valid
    && hasCodeAt(
      caseVariantRunbookHashResult,
      'duplicate_runbook_evidence',
      '$.runbooks[1].contentHash',
    ));

const mixedTarget = clone();
mixedTarget.runbooks[1].targetId = 'fixture-only:release-target:other';
const mixedTargetResult = validatePhase5ReleaseTarget(mixedTarget);
ok('mixed target IDs fail closed',
  !mixedTargetResult.valid
    && hasCodeAt(mixedTargetResult, 'target_mismatch', '$.runbooks[1].targetId'));

const missingChainIntent = clone();
delete missingChainIntent.chainIntent;
const missingChainIntentResult = validatePhase5ReleaseTarget(missingChainIntent);
ok('missing chain intent fails closed',
  !missingChainIntentResult.valid
    && hasCodeAt(missingChainIntentResult, 'missing_section', '$.chainIntent'));

const mixedChainIntent = clone();
mixedChainIntent.chainIntent.targetId = 'fixture-only:release-target:other';
const mixedChainIntentResult = validatePhase5ReleaseTarget(mixedChainIntent);
ok('chain intent bound to a different target fails closed',
  !mixedChainIntentResult.valid
    && hasCodeAt(mixedChainIntentResult, 'target_mismatch', '$.chainIntent.targetId'));

const invalidChainIntentReference = clone();
invalidChainIntentReference.chainIntent.reference = 'production-network';
const invalidChainIntentReferenceResult = validatePhase5ReleaseTarget(invalidChainIntentReference);
ok('non-fixture chain-intent reference fails closed',
  !invalidChainIntentReferenceResult.valid
    && hasCodeAt(
      invalidChainIntentReferenceResult,
      'invalid_reference',
      '$.chainIntent.reference',
    ));

const invalidChainIntentHash = clone();
invalidChainIntentHash.chainIntent.contentHash = `0x${'0'.repeat(64)}`;
const invalidChainIntentHashResult = validatePhase5ReleaseTarget(invalidChainIntentHash);
ok('zero chain-intent hash fails closed',
  !invalidChainIntentHashResult.valid
    && hasCodeAt(invalidChainIntentHashResult, 'invalid_hash', '$.chainIntent.contentHash'));

for (const [name, mutate, path] of [
  ['zero config hash', (value) => { value.config.payloadHash = `0x${'0'.repeat(64)}`; }, '$.config.payloadHash'],
  ['malformed creation bytecode hash', (value) => { value.bytecode.creationBundleHash = '0x1234'; }, '$.bytecode.creationBundleHash'],
]) {
  const badHash = clone();
  mutate(badHash);
  const badHashResult = validatePhase5ReleaseTarget(badHash);
  ok(`${name} fails closed`,
    !badHashResult.valid && hasCodeAt(badHashResult, 'invalid_hash', path));
}

const production = clone();
production.status = 'production-ready';
production.hold = false;
const productionResult = validatePhase5ReleaseTarget(production);
ok('production status fails closed',
  !productionResult.valid
    && hasCode(productionResult, 'unsupported_status')
    && hasCode(productionResult, 'hold_required'));
assert.throws(
  () => buildPhase5ReleaseTarget({ ...clone(), status: 'production-ready', hold: false }),
  /invalid Phase 5 release-target record/,
);
ok('builder cannot emit a production/non-HOLD record', true);

const unknown = clone();
unknown.productionApproval = 'fixture-only:approval:none';
const unknownResult = validatePhase5ReleaseTarget(unknown);
ok('unknown approval field fails closed',
  !unknownResult.valid
    && hasCodeAt(unknownResult, 'unknown_field', '$.productionApproval'));

const secretField = clone();
secretField.toolchain.deployerPrivateKey = 'fixture-only:key:prohibited';
const secretFieldResult = validatePhase5ReleaseTarget(secretField);
ok('secret/key field fails closed',
  !secretFieldResult.valid
    && hasCodeAt(secretFieldResult, 'prohibited_secret_field', '$.toolchain.deployerPrivateKey'));

const keyValue = clone();
keyValue.source.note = `0x${'ab'.repeat(32)}`;
const keyValueResult = validatePhase5ReleaseTarget(keyValue);
ok('private-key-shaped value fails closed',
  !keyValueResult.valid
    && hasCodeAt(keyValueResult, 'prohibited_secret_value', '$.source.note'));

const inconsistentToolchain = clone();
inconsistentToolchain.toolchain.compiler.name = 'hardhat';
const inconsistentToolchainResult = validatePhase5ReleaseTarget(inconsistentToolchain);
ok('inconsistent compiler/toolchain fields fail closed',
  !inconsistentToolchainResult.valid
    && hasCodeAt(inconsistentToolchainResult, 'inconsistent_toolchain', '$.toolchain.compiler.name'));

const numericCap = clone();
numericCap.pointsCap = 100;
const numericCapResult = validatePhase5ReleaseTarget(numericCap);
ok('numeric cap value fails closed',
  !numericCapResult.valid
    && hasCodeAt(numericCapResult, 'prohibited_numeric_cap', '$.pointsCap'));

const address = clone();
address.config.governanceAddress = `0x${'12'.repeat(20)}`;
const addressResult = validatePhase5ReleaseTarget(address);
ok('address value fails closed',
  !addressResult.valid
    && hasCodeAt(addressResult, 'prohibited_address', '$.config.governanceAddress'));

const embeddedAddress = clone();
embeddedAddress.source.commitReference = `fixture-only:source:commit-${`0x${'12'.repeat(20)}`}`;
const embeddedAddressResult = validatePhase5ReleaseTarget(embeddedAddress);
ok('embedded EVM address in an allowed fixture reference fails closed',
  !embeddedAddressResult.valid
    && hasCodeAt(embeddedAddressResult, 'prohibited_address', '$.source.commitReference'));

const embeddedGithubToken = clone();
embeddedGithubToken.source.commitReference = 'fixture-only:source:ghp_REDACTEDREDACTEDREDACTED';
const embeddedGithubTokenResult = validatePhase5ReleaseTarget(embeddedGithubToken);
ok('redacted GitHub-token shape in an allowed fixture reference fails closed',
  !embeddedGithubTokenResult.valid
    && hasCodeAt(embeddedGithubTokenResult, 'prohibited_secret_value', '$.source.commitReference'));

for (const [name, reference] of [
  ['API-token shape', `fixture-only:source:sk-test-${'a'.repeat(24)}`],
  ['Bearer-token shape', `fixture-only:source:Bearer-${'b'.repeat(24)}`],
  ['JWT shape', 'fixture-only:source:header123.payload123.signature123'],
  ['embedded private-key shape', `fixture-only:source:key-${'a1'.repeat(32)}`],
]) {
  const prohibitedReference = clone();
  prohibitedReference.source.commitReference = reference;
  const prohibitedReferenceResult = validatePhase5ReleaseTarget(prohibitedReference);
  ok(`${name} in an allowed fixture reference fails closed`,
    !prohibitedReferenceResult.valid
      && hasCodeAt(
        prohibitedReferenceResult,
        'prohibited_secret_value',
        '$.source.commitReference',
      ));
}

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
