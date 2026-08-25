// Standalone local builder/validator for Phase 5 release-target records.
// Preparation tooling only: intentionally disconnected from deployment and runtime gates.

export const PHASE5_RELEASE_TARGET_SCHEMA_VERSION = 1;

const FIXTURE_REFERENCE_RE = /^fixture-only:[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/;
const PRIVATE_KEY_RE = /\b(?:0x)?[0-9a-fA-F]{64}\b/;
const SECRET_VALUE_PATTERNS = [
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk)[_-](?:live|test)[_-][A-Za-z0-9]{16,}\b/,
  /\bBearer[-_:][A-Za-z0-9._~+/-]{16,}\b/i,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];
const REQUIRED_SECTIONS = [
  'chainIntent',
  'source',
  'dependencies',
  'toolchain',
  'config',
  'bytecode',
  'runbooks',
];
const REQUIRED_LOCKFILES = ['root-npm', 'contracts-npm'];
const REQUIRED_RUNBOOKS = ['deployment-candidate', 'verification-candidate', 'incident-candidate'];
const TOP_FIELDS = new Set(['schemaVersion', 'status', 'hold', 'targetId', ...REQUIRED_SECTIONS]);
const CHAIN_INTENT_FIELDS = new Set(['targetId', 'reference', 'contentHash']);
const SOURCE_FIELDS = new Set([
  'targetId',
  'commitReference',
  'cleanTreeProofReference',
  'cleanTreeProofHash',
]);
const DEPENDENCY_FIELDS = new Set(['targetId', 'lockfiles']);
const LOCKFILE_FIELDS = new Set(['kind', 'pathReference', 'contentHash']);
const TOOLCHAIN_FIELDS = new Set([
  'targetId',
  'nodeVersionReference',
  'npmVersionReference',
  'hardhatVersionReference',
  'compiler',
]);
const COMPILER_FIELDS = new Set(['name', 'versionReference', 'settingsHash']);
const CONFIG_FIELDS = new Set(['targetId', 'payloadHash']);
const BYTECODE_FIELDS = new Set(['targetId', 'creationBundleHash', 'deployedBundleHash']);
const RUNBOOK_FIELDS = new Set(['targetId', 'kind', 'pathReference', 'contentHash']);
const SECRET_KEY_FRAGMENTS = [
  'accesstoken',
  'apikey',
  'bearertoken',
  'credential',
  'mnemonic',
  'passphrase',
  'password',
  'privatekey',
  'secret',
  'seedphrase',
  'sessiontoken',
  'signingkey',
  'walletkey',
];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFixtureReference = (value) => FIXTURE_REFERENCE_RE.test(String(value || ''));
const isNonzeroHash = (value) => HASH_RE.test(String(value || '')) && !/^0x0{64}$/i.test(String(value));
const normalizedKey = (key) => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();

function rejectUnknownFields(value, allowedFields, path, addError) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      addError('unknown_field', `${path}.${key}`, 'field is not allowed by the release-target schema');
    }
  }
}

function scanProhibitedMaterial(value, path, key, addError) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanProhibitedMaterial(entry, `${path}[${index}]`, '', addError));
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, entry] of Object.entries(value)) {
      scanProhibitedMaterial(entry, `${path}.${childKey}`, childKey, addError);
    }
    return;
  }

  const keyName = normalizedKey(key);
  if (SECRET_KEY_FRAGMENTS.some((fragment) => keyName.includes(fragment))) {
    addError('prohibited_secret_field', path, 'secret, credential, or key fields are prohibited');
  }
  if (typeof value === 'number' && keyName.includes('cap')) {
    addError('prohibited_numeric_cap', path, 'numeric cap values are outside the release-target record');
  }
  if (typeof value !== 'string') return;
  if (ADDRESS_RE.test(value)) {
    addError('prohibited_address', path, 'address values are prohibited from local release-target records');
  }
  if (!keyName.endsWith('hash') && PRIVATE_KEY_RE.test(value)) {
    addError('prohibited_secret_value', path, 'private-key-shaped values are prohibited');
  }
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    addError('prohibited_secret_value', path, 'credential-shaped values are prohibited');
  }
}

function requireFixtureReference(value, path, addError) {
  if (!isFixtureReference(value)) {
    addError('invalid_reference', path, 'value must be a fixture-only reference');
  }
}

function requireHash(value, path, addError) {
  if (!isNonzeroHash(value)) {
    addError('invalid_hash', path, 'value must be a nonzero 32-byte content hash');
  }
}

function requireTargetBinding(value, targetId, path, addError) {
  requireFixtureReference(value, path, addError);
  if (value !== targetId) {
    addError('target_mismatch', path, 'section does not bind to the record targetId');
  }
}

export function validatePhase5ReleaseTarget(record) {
  const errors = [];
  const addError = (code, path, message) => errors.push({ code, path, message });

  if (!isRecord(record)) {
    addError('invalid_record', '$', 'release-target record must be an object');
    return { valid: false, errors };
  }
  rejectUnknownFields(record, TOP_FIELDS, '$', addError);
  if (record.schemaVersion !== PHASE5_RELEASE_TARGET_SCHEMA_VERSION) {
    addError('unsupported_schema_version', '$.schemaVersion', 'only release-target schema version 1 is supported');
  }
  if (record.status !== 'local-fixture') {
    addError('unsupported_status', '$.status', 'only local-fixture status is supported');
  }
  if (record.hold !== true) {
    addError('hold_required', '$.hold', 'release-target records must remain under explicit HOLD');
  }
  if (!isFixtureReference(record.targetId)) {
    addError('invalid_target_id', '$.targetId', 'targetId must be a fixture-only reference');
  }
  for (const section of REQUIRED_SECTIONS) {
    const value = record[section];
    if (section === 'runbooks' ? !Array.isArray(value) : !isRecord(value)) {
      addError('missing_section', `$.${section}`, `${section} is required`);
    }
  }

  if (isRecord(record.chainIntent)) {
    rejectUnknownFields(record.chainIntent, CHAIN_INTENT_FIELDS, '$.chainIntent', addError);
    requireTargetBinding(
      record.chainIntent.targetId,
      record.targetId,
      '$.chainIntent.targetId',
      addError,
    );
    if (!('reference' in record.chainIntent)) {
      addError('missing_field', '$.chainIntent.reference', 'chain-intent reference is required');
    } else {
      requireFixtureReference(record.chainIntent.reference, '$.chainIntent.reference', addError);
    }
    if (!('contentHash' in record.chainIntent)) {
      addError('missing_field', '$.chainIntent.contentHash', 'chain-intent content hash is required');
    } else {
      requireHash(record.chainIntent.contentHash, '$.chainIntent.contentHash', addError);
    }
  }

  if (isRecord(record.source)) {
    rejectUnknownFields(record.source, SOURCE_FIELDS, '$.source', addError);
    requireTargetBinding(record.source.targetId, record.targetId, '$.source.targetId', addError);
    for (const field of ['commitReference', 'cleanTreeProofReference']) {
      if (!(field in record.source)) {
        addError('missing_field', `$.source.${field}`, `${field} is required`);
      } else {
        requireFixtureReference(record.source[field], `$.source.${field}`, addError);
      }
    }
    if (!('cleanTreeProofHash' in record.source)) {
      addError('missing_field', '$.source.cleanTreeProofHash', 'cleanTreeProofHash is required');
    } else {
      requireHash(record.source.cleanTreeProofHash, '$.source.cleanTreeProofHash', addError);
    }
  }

  if (isRecord(record.dependencies)) {
    rejectUnknownFields(record.dependencies, DEPENDENCY_FIELDS, '$.dependencies', addError);
    requireTargetBinding(record.dependencies.targetId, record.targetId, '$.dependencies.targetId', addError);
    if (!Array.isArray(record.dependencies.lockfiles)) {
      addError('missing_field', '$.dependencies.lockfiles', 'lockfiles are required');
    } else {
      const kinds = new Map();
      record.dependencies.lockfiles.forEach((lockfile, index) => {
        const path = `$.dependencies.lockfiles[${index}]`;
        if (!isRecord(lockfile)) {
          addError('invalid_lockfile', path, 'lockfile must be an object');
          return;
        }
        rejectUnknownFields(lockfile, LOCKFILE_FIELDS, path, addError);
        kinds.set(lockfile.kind, (kinds.get(lockfile.kind) || 0) + 1);
        requireFixtureReference(lockfile.pathReference, `${path}.pathReference`, addError);
        requireHash(lockfile.contentHash, `${path}.contentHash`, addError);
      });
      for (const kind of REQUIRED_LOCKFILES) {
        if (kinds.get(kind) !== 1) {
          addError('incomplete_lockfiles', '$.dependencies.lockfiles', `exactly one ${kind} lockfile is required`);
        }
      }
      for (const kind of kinds.keys()) {
        if (!REQUIRED_LOCKFILES.includes(kind)) {
          addError('unsupported_lockfile', '$.dependencies.lockfiles', `unsupported lockfile kind: ${kind}`);
        }
      }
    }
  }

  if (isRecord(record.toolchain)) {
    rejectUnknownFields(record.toolchain, TOOLCHAIN_FIELDS, '$.toolchain', addError);
    requireTargetBinding(record.toolchain.targetId, record.targetId, '$.toolchain.targetId', addError);
    for (const field of ['nodeVersionReference', 'npmVersionReference', 'hardhatVersionReference']) {
      requireFixtureReference(record.toolchain[field], `$.toolchain.${field}`, addError);
    }
    if (!isRecord(record.toolchain.compiler)) {
      addError('missing_field', '$.toolchain.compiler', 'compiler reference is required');
    } else {
      rejectUnknownFields(record.toolchain.compiler, COMPILER_FIELDS, '$.toolchain.compiler', addError);
      if (record.toolchain.compiler.name !== 'solc') {
        addError('inconsistent_toolchain', '$.toolchain.compiler.name', 'Hardhat release artifacts require the solc compiler');
      }
      requireFixtureReference(
        record.toolchain.compiler.versionReference,
        '$.toolchain.compiler.versionReference',
        addError,
      );
      requireHash(record.toolchain.compiler.settingsHash, '$.toolchain.compiler.settingsHash', addError);
    }
  }

  if (isRecord(record.config)) {
    rejectUnknownFields(record.config, CONFIG_FIELDS, '$.config', addError);
    requireTargetBinding(record.config.targetId, record.targetId, '$.config.targetId', addError);
    requireHash(record.config.payloadHash, '$.config.payloadHash', addError);
  }

  if (isRecord(record.bytecode)) {
    rejectUnknownFields(record.bytecode, BYTECODE_FIELDS, '$.bytecode', addError);
    requireTargetBinding(record.bytecode.targetId, record.targetId, '$.bytecode.targetId', addError);
    requireHash(record.bytecode.creationBundleHash, '$.bytecode.creationBundleHash', addError);
    requireHash(record.bytecode.deployedBundleHash, '$.bytecode.deployedBundleHash', addError);
  }

  if (Array.isArray(record.runbooks)) {
    const kinds = new Map();
    const pathReferences = new Set();
    const contentHashes = new Set();
    record.runbooks.forEach((runbook, index) => {
      const path = `$.runbooks[${index}]`;
      if (!isRecord(runbook)) {
        addError('invalid_runbook', path, 'runbook must be an object');
        return;
      }
      rejectUnknownFields(runbook, RUNBOOK_FIELDS, path, addError);
      kinds.set(runbook.kind, (kinds.get(runbook.kind) || 0) + 1);
      requireTargetBinding(runbook.targetId, record.targetId, `${path}.targetId`, addError);
      requireFixtureReference(runbook.pathReference, `${path}.pathReference`, addError);
      requireHash(runbook.contentHash, `${path}.contentHash`, addError);
      if (pathReferences.has(runbook.pathReference)) {
        addError(
          'duplicate_runbook_evidence',
          `${path}.pathReference`,
          'runbook path references must be unique within the frozen target',
        );
      }
      pathReferences.add(runbook.pathReference);
      const normalizedContentHash = String(runbook.contentHash).toLowerCase();
      if (contentHashes.has(normalizedContentHash)) {
        addError(
          'duplicate_runbook_evidence',
          `${path}.contentHash`,
          'runbook content hashes must be unique within the frozen target',
        );
      }
      contentHashes.add(normalizedContentHash);
    });
    for (const kind of REQUIRED_RUNBOOKS) {
      if (kinds.get(kind) !== 1) {
        addError('incomplete_runbooks', '$.runbooks', `exactly one ${kind} runbook is required`);
      }
    }
    for (const kind of kinds.keys()) {
      if (!REQUIRED_RUNBOOKS.includes(kind)) {
        addError('unsupported_runbook', '$.runbooks', `unsupported runbook kind: ${kind}`);
      }
    }
  }

  scanProhibitedMaterial(record, '$', '', addError);

  return { valid: errors.length === 0, errors };
}

export function buildPhase5ReleaseTarget(input) {
  const record = structuredClone({
    schemaVersion: PHASE5_RELEASE_TARGET_SCHEMA_VERSION,
    status: 'local-fixture',
    hold: true,
    ...input,
  });
  const result = validatePhase5ReleaseTarget(record);
  if (!result.valid) {
    const error = new TypeError('invalid Phase 5 release-target record');
    error.validationErrors = result.errors;
    throw error;
  }
  return record;
}
