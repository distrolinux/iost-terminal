// Standalone local validator for Phase 5 evidence-index fixtures.
// This module is preparation tooling only and is intentionally not wired into runtime gates.

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const FIXTURE_REFERENCE_RE = /^fixture-only:[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
const INDEX_FIELDS = new Set(['schemaVersion', 'status', 'hold', 'holdReason', 'target', 'artifacts']);
const TARGET_FIELDS = new Set([
  'reference',
  'sourceCommit',
  'configHash',
  'creationBytecodeBundleHash',
  'deployedBytecodeBundleHash',
]);
const ARTIFACT_FIELDS = new Set(['category', 'targetReference', 'contentHash', 'attribution']);
const ATTRIBUTION_FIELDS = new Set(['identityReference', 'provenanceReference']);
const PROHIBITED_SECRET_KEYS = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'apitoken',
  'authorization',
  'authorizationheader',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentials',
  'jwt',
  'mnemonic',
  'passphrase',
  'password',
  'privatekey',
  'rawcredential',
  'refreshtoken',
  'secret',
  'secretkey',
  'seedphrase',
  'sessiontoken',
  'signingkey',
  'token',
  'walletkey',
]);
const PROHIBITED_SECRET_KEY_FRAGMENTS = [
  'accesstoken',
  'apikey',
  'apitoken',
  'authorization',
  'authtoken',
  'bearertoken',
  'credential',
  'mnemonic',
  'passphrase',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'seedphrase',
  'sessiontoken',
  'signingkey',
  'walletkey',
];
const HASH_VALUE_FIELDS = new Set([
  'confighash',
  'contenthash',
  'creationbytecodebundlehash',
  'deployedbytecodebundlehash',
]);
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/,
  /^0x[0-9a-fA-F]{64}$/,
  /^[0-9a-fA-F]{64}$/,
  /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

export const PHASE5_EVIDENCE_SCHEMA_VERSION = 1;
export const REQUIRED_PHASE5_ARTIFACT_CATEGORIES = Object.freeze([
  'release-target',
  'external-audit',
  'counsel',
  'governance-config-review',
  'points-package',
  'offline-rehearsal',
  'reproducible-build',
  'verification-plan',
  'incident-rollback-runbook',
  'cally-authorization',
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonzeroHash = (value) => HASH_RE.test(String(value || '')) && !/^0x0{64}$/i.test(String(value));
const isFixtureReference = (value) => FIXTURE_REFERENCE_RE.test(String(value || ''));
const normalizedKey = (key) => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
const isProhibitedSecretKey = (key) => PROHIBITED_SECRET_KEYS.has(key)
  || PROHIBITED_SECRET_KEY_FRAGMENTS.some((fragment) => key.includes(fragment));

function rejectUnknownFields(value, allowedFields, path, addError) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      addError('unknown_field', `${path}.${key}`, 'field is not allowed by the Phase 5 local-fixture schema');
    }
  }
}

function findSecretFields(value, path = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findSecretFields(entry, `${path}[${index}]`, findings));
    return findings;
  }
  if (!isRecord(value)) return findings;

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    const keyName = normalizedKey(key);
    if (isProhibitedSecretKey(keyName)) findings.push(entryPath);
    if (typeof entry === 'string'
      && !isFixtureReference(entry)
      && !HASH_VALUE_FIELDS.has(keyName)
      && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(entry))) {
      findings.push(entryPath);
    }
    findSecretFields(entry, entryPath, findings);
  }
  return findings;
}

export function validatePhase5EvidenceIndex(index) {
  const errors = [];
  const addError = (code, path, message) => errors.push({ code, path, message });

  if (!isRecord(index)) {
    addError('invalid_index', '$', 'evidence index must be an object');
    return { valid: false, errors };
  }

  rejectUnknownFields(index, INDEX_FIELDS, '$', addError);

  if (index.schemaVersion !== PHASE5_EVIDENCE_SCHEMA_VERSION) {
    addError('unsupported_schema_version', '$.schemaVersion', 'only Phase 5 evidence schema version 1 is supported');
  }
  if (index.status !== 'local-fixture') {
    addError('unsupported_status', '$.status', 'only local-fixture status is supported by this preparation-only validator');
  }
  if (index.hold !== true) {
    addError('hold_required', '$.hold', 'local fixture evidence must remain under explicit HOLD');
  }
  if (!isFixtureReference(index.holdReason)) {
    addError('invalid_reference', '$.holdReason', 'holdReason must be a non-empty fixture-only reference');
  }

  const target = index.target;
  if (!isRecord(target)) {
    addError('invalid_target', '$.target', 'a frozen target object is required');
  } else {
    rejectUnknownFields(target, TARGET_FIELDS, '$.target', addError);
    for (const field of ['reference', 'sourceCommit']) {
      if (!isFixtureReference(target[field])) {
        addError('invalid_reference', `$.target.${field}`, `${field} must be a fixture-only reference`);
      }
    }
    for (const field of ['configHash', 'creationBytecodeBundleHash', 'deployedBytecodeBundleHash']) {
      if (!isNonzeroHash(target[field])) {
        addError('invalid_hash', `$.target.${field}`, `${field} must be a nonzero 32-byte content hash`);
      }
    }
  }

  const artifacts = index.artifacts;
  if (!Array.isArray(artifacts)) {
    addError('invalid_artifacts', '$.artifacts', 'artifacts must be an array');
  } else {
    const categoryCounts = new Map();
    artifacts.forEach((artifact, indexPosition) => {
      const path = `$.artifacts[${indexPosition}]`;
      if (!isRecord(artifact)) {
        addError('invalid_artifact', path, 'artifact must be an object');
        return;
      }

      rejectUnknownFields(artifact, ARTIFACT_FIELDS, path, addError);

      const category = String(artifact.category || '');
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      if (!REQUIRED_PHASE5_ARTIFACT_CATEGORIES.includes(category)) {
        addError('unsupported_artifact', `${path}.category`, 'artifact category is not supported');
      }
      if (!isNonzeroHash(artifact.contentHash)) {
        addError('invalid_hash', `${path}.contentHash`, 'artifact contentHash must be a nonzero 32-byte hash');
      }
      if (!isFixtureReference(artifact.targetReference)) {
        addError('invalid_reference', `${path}.targetReference`, 'artifact targetReference must be fixture-only');
      } else if (isRecord(target) && artifact.targetReference !== target.reference) {
        addError('target_mismatch', `${path}.targetReference`, 'artifact does not bind to the frozen target');
      }

      if (!isRecord(artifact.attribution)) {
        addError('invalid_attribution', `${path}.attribution`, 'artifact attribution is required');
      } else {
        rejectUnknownFields(artifact.attribution, ATTRIBUTION_FIELDS, `${path}.attribution`, addError);
        for (const field of ['identityReference', 'provenanceReference']) {
          if (!isFixtureReference(artifact.attribution[field])) {
            addError('invalid_reference', `${path}.attribution.${field}`, `${field} must be a fixture-only reference`);
          }
        }
      }
    });

    for (const category of REQUIRED_PHASE5_ARTIFACT_CATEGORIES) {
      const count = categoryCounts.get(category) || 0;
      if (count === 0) addError('missing_artifact', '$.artifacts', `missing required artifact category: ${category}`);
      if (count > 1) addError('duplicate_artifact', '$.artifacts', `duplicate artifact category: ${category}`);
    }
  }

  for (const path of new Set(findSecretFields(index))) {
    addError('prohibited_secret_field', path, 'secret or raw credential material is prohibited');
  }

  return { valid: errors.length === 0, errors };
}
