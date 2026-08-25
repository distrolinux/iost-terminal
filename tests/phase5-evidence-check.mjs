// Standalone, local-only Phase 5 evidence-index schema regression.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePhase5EvidenceIndex } from '../lib/phase5-evidence.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'phase5-evidence-valid.json'), 'utf8'));
const clone = () => structuredClone(fixture);
let failures = 0;
const ok = (name, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures++;
};
const hasCode = (result, code) => result.errors.some((error) => error.code === code);
const hasCodeAt = (result, code, path) => result.errors.some((error) => error.code === code && error.path === path);

const valid = validatePhase5EvidenceIndex(fixture);
ok('valid non-secret local fixture passes', valid.valid, JSON.stringify(valid.errors));

const incomplete = clone();
incomplete.artifacts = incomplete.artifacts.filter(({ category }) => category !== 'external-audit');
const incompleteResult = validatePhase5EvidenceIndex(incomplete);
ok('incomplete fixture fails closed', !incompleteResult.valid && hasCode(incompleteResult, 'missing_artifact'));

const mixedTarget = clone();
mixedTarget.artifacts[1].targetReference = 'fixture-only:release-target:other';
const mixedTargetResult = validatePhase5EvidenceIndex(mixedTarget);
ok('mixed-target fixture fails closed', !mixedTargetResult.valid && hasCode(mixedTargetResult, 'target_mismatch'));

const secretBearing = clone();
secretBearing.artifacts[0].privateKey = 'fixture-only-private-key-material';
const secretResult = validatePhase5EvidenceIndex(secretBearing);
ok('secret-bearing fixture fails closed', !secretResult.valid && hasCode(secretResult, 'prohibited_secret_field'));

const zeroHash = clone();
zeroHash.artifacts[0].contentHash = `0x${'0'.repeat(64)}`;
const zeroHashResult = validatePhase5EvidenceIndex(zeroHash);
ok('zero-hash fixture fails closed', !zeroHashResult.valid && hasCode(zeroHashResult, 'invalid_hash'));

const unsupportedStatus = clone();
unsupportedStatus.status = 'production-ready';
unsupportedStatus.hold = false;
const unsupportedStatusResult = validatePhase5EvidenceIndex(unsupportedStatus);
ok('unsupported production status fails closed',
  !unsupportedStatusResult.valid && hasCode(unsupportedStatusResult, 'unsupported_status'));

const missingHold = clone();
delete missingHold.hold;
const missingHoldResult = validatePhase5EvidenceIndex(missingHold);
ok('missing explicit HOLD fails closed', !missingHoldResult.valid && hasCode(missingHoldResult, 'hold_required'));

for (const [name, mutate, path] of [
  ['index', (value) => { value.productionAuthorization = 'approved'; }, '$.productionAuthorization'],
  ['target', (value) => { value.target.chainId = 182; }, '$.target.chainId'],
  ['artifact', (value) => { value.artifacts[0].approval = true; }, '$.artifacts[0].approval'],
  ['deployment', (value) => { value.artifacts[0].deploymentTransactionHash = 'fixture-only:deployment:none'; }, '$.artifacts[0].deploymentTransactionHash'],
  ['attribution', (value) => { value.artifacts[0].attribution.signature = 'signed'; }, '$.artifacts[0].attribution.signature'],
]) {
  const unknownField = clone();
  mutate(unknownField);
  const unknownFieldResult = validatePhase5EvidenceIndex(unknownField);
  ok(`unknown ${name} field fails closed`,
    !unknownFieldResult.valid && hasCodeAt(unknownFieldResult, 'unknown_field', path));
}

for (const [name, field, value] of [
  ['wallet-key alias', 'walletKey', 'fixture-only:not-secret'],
  ['access-token alias', 'accessToken', 'fixture-only:not-secret'],
  ['API-token alias', 'apiToken', 'fixture-only:not-secret'],
  ['composite private-key alias', 'deployerPrivateKey', 'fixture-only:not-secret'],
  ['composite access-token alias', 'clientAccessTokenValue', 'fixture-only:not-secret'],
  ['composite credential alias', 'productionCredentialReference', 'fixture-only:not-secret'],
]) {
  const credentialAlias = clone();
  credentialAlias.artifacts[0][field] = value;
  const credentialAliasResult = validatePhase5EvidenceIndex(credentialAlias);
  ok(`${name} fails as a prohibited credential field`,
    !credentialAliasResult.valid
      && hasCodeAt(credentialAliasResult, 'prohibited_secret_field', `$.artifacts[0].${field}`));
}

const evmPrivateKey = clone();
evmPrivateKey.artifacts[0].note = `0x${'a1'.repeat(32)}`;
const evmPrivateKeyResult = validatePhase5EvidenceIndex(evmPrivateKey);
ok('EVM private-key-shaped value fails closed',
  !evmPrivateKeyResult.valid
    && hasCodeAt(evmPrivateKeyResult, 'prohibited_secret_field', '$.artifacts[0].note'));

const unprefixedEvmPrivateKey = clone();
unprefixedEvmPrivateKey.artifacts[0].note = 'a1'.repeat(32);
const unprefixedEvmPrivateKeyResult = validatePhase5EvidenceIndex(unprefixedEvmPrivateKey);
ok('unprefixed EVM private-key-shaped value fails closed',
  !unprefixedEvmPrivateKeyResult.valid
    && hasCodeAt(unprefixedEvmPrivateKeyResult, 'prohibited_secret_field', '$.artifacts[0].note'));

const jwtToken = clone();
jwtToken.artifacts[0].note = ['header123', 'payload123', 'signature123'].join('.');
const jwtTokenResult = validatePhase5EvidenceIndex(jwtToken);
ok('JWT-shaped value fails closed',
  !jwtTokenResult.valid
    && hasCodeAt(jwtTokenResult, 'prohibited_secret_field', '$.artifacts[0].note'));

const unsignedJwtToken = clone();
unsignedJwtToken.artifacts[0].note = ['header123', 'payload123', ''].join('.');
const unsignedJwtTokenResult = validatePhase5EvidenceIndex(unsignedJwtToken);
ok('unsigned JWT-shaped value fails closed',
  !unsignedJwtTokenResult.valid
    && hasCodeAt(unsignedJwtTokenResult, 'prohibited_secret_field', '$.artifacts[0].note'));

const bearerToken = clone();
bearerToken.artifacts[0].note = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
const bearerTokenResult = validatePhase5EvidenceIndex(bearerToken);
ok('bearer-token-shaped value fails closed',
  !bearerTokenResult.valid
    && hasCodeAt(bearerTokenResult, 'prohibited_secret_field', '$.artifacts[0].note'));

const punctuatedBearerToken = clone();
punctuatedBearerToken.artifacts[0].note = `Bearer ${'a'.repeat(24)}-`;
const punctuatedBearerTokenResult = validatePhase5EvidenceIndex(punctuatedBearerToken);
ok('URL-safe bearer-token-shaped value fails closed',
  !punctuatedBearerTokenResult.valid
    && hasCodeAt(punctuatedBearerTokenResult, 'prohibited_secret_field', '$.artifacts[0].note'));

const apiToken = clone();
apiToken.artifacts[0].note = ['sk', 'test', 'a'.repeat(24)].join('-');
const apiTokenResult = validatePhase5EvidenceIndex(apiToken);
ok('API-token-shaped value fails closed',
  !apiTokenResult.valid
    && hasCodeAt(apiTokenResult, 'prohibited_secret_field', '$.artifacts[0].note'));

const duplicateCategory = clone();
duplicateCategory.artifacts.push(structuredClone(duplicateCategory.artifacts[0]));
const duplicateCategoryResult = validatePhase5EvidenceIndex(duplicateCategory);
ok('duplicate artifact category fails closed',
  !duplicateCategoryResult.valid && hasCode(duplicateCategoryResult, 'duplicate_artifact'));

for (const [name, mutate, code, path] of [
  ['short hash', (value) => { value.target.configHash = '0x1234'; }, 'invalid_hash', '$.target.configHash'],
  ['non-hex hash', (value) => { value.artifacts[0].contentHash = `0x${'g'.repeat(64)}`; }, 'invalid_hash', '$.artifacts[0].contentHash'],
  ['bare reference', (value) => { value.target.reference = 'release-target:alpha'; }, 'invalid_reference', '$.target.reference'],
  ['whitespace reference', (value) => { value.artifacts[0].attribution.identityReference = 'fixture-only:identity:bad value'; }, 'invalid_reference', '$.artifacts[0].attribution.identityReference'],
]) {
  const malformed = clone();
  mutate(malformed);
  const malformedResult = validatePhase5EvidenceIndex(malformed);
  ok(`${name} fails closed`, !malformedResult.valid && hasCodeAt(malformedResult, code, path));
}

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
