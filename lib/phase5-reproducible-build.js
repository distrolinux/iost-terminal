// Standalone local validator for Phase 5 reproducible-build fixtures.
// Preparation evidence only: no deployment, runtime gate, audit, or authorization effect.

import { validatePhase5ReleaseTarget } from './phase5-release-target.js';

export const PHASE5_REPRODUCIBLE_BUILD_SCHEMA_VERSION = 1;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const FIXTURE_REFERENCE_RE = /^fixture-only:[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
const REQUIRED_RUNBOOKS = ['deployment-candidate', 'verification-candidate', 'incident-candidate'];
const TOP_FIELDS = new Set([
  'schemaVersion',
  'status',
  'hold',
  'scope',
  'externalAudit',
  'releaseAuthorization',
  'targetId',
  'runs',
]);
const RUN_FIELDS = new Set([
  'runId',
  'targetId',
  'environment',
  'treeState',
  'cleanTreeProofHash',
  'cleanTreeProofReference',
  'executionProof',
  'sourceCommitReference',
  'lockfiles',
  'toolchain',
  'configHash',
  'creationBundleHash',
  'deployedBundleHash',
  'runbooks',
]);
const EXECUTION_PROOF_FIELDS = new Set(['targetId', 'runId', 'reference', 'contentHash']);
const LOCKFILE_FIELDS = new Set(['kind', 'pathReference', 'contentHash']);
const RUNBOOK_FIELDS = new Set([
  'targetId',
  'runId',
  'kind',
  'pathReference',
  'contentHash',
]);
const TOOLCHAIN_FIELDS = new Set([
  'nodeVersionReference',
  'npmVersionReference',
  'hardhatVersionReference',
  'compiler',
]);
const COMPILER_FIELDS = new Set(['name', 'versionReference', 'settingsHash']);
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
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk)[_-](?:live|test)[_-][A-Za-z0-9]{16,}\b/,
  /\bBearer[-_: ]+[A-Za-z0-9._~+/-]{16,}\b/i,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonzeroHash = (value) => HASH_RE.test(String(value || ''))
  && !/^0x0{64}$/i.test(String(value));
const isFixtureReference = (value) => FIXTURE_REFERENCE_RE.test(String(value || ''));
const normalizedKey = (key) => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();

function rejectUnknownFields(value, allowedFields, path, addError) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      addError('unknown_field', `${path}.${key}`, 'field is not allowed by the reproducible-build schema');
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
  if (typeof value === 'string'
    && !keyName.endsWith('hash')
    && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    addError('prohibited_secret_value', path, 'credential-shaped values are prohibited');
  }
}

export function validatePhase5ReproducibleBuild(record, releaseTarget) {
  const errors = [];
  const addError = (code, path, message) => errors.push({ code, path, message });
  const requireHash = (value, path) => {
    if (!isNonzeroHash(value)) {
      addError('invalid_hash', path, 'value must be a nonzero 32-byte content hash');
    }
  };
  const requireMatch = (value, expected, path) => {
    if (value !== expected) {
      addError('fingerprint_mismatch', path, 'value does not match the frozen release target');
    }
  };
  const targetResult = validatePhase5ReleaseTarget(releaseTarget);
  if (!targetResult.valid) {
    return {
      valid: false,
      errors: [{
        code: 'invalid_release_target',
        path: '$releaseTarget',
        message: 'release target must satisfy the standalone Phase 5 release-target schema',
      }],
    };
  }

  if (!isRecord(record)) {
    return {
      valid: false,
      errors: [{
        code: 'invalid_record',
        path: '$',
        message: 'reproducible-build record must be an object',
      }],
    };
  }

  rejectUnknownFields(record, TOP_FIELDS, '$', addError);
  if (record.schemaVersion !== PHASE5_REPRODUCIBLE_BUILD_SCHEMA_VERSION) {
    addError('unsupported_schema_version', '$.schemaVersion', 'only reproducible-build schema version 1 is supported');
  }
  if (record.status !== 'local-fixture') {
    addError('unsupported_status', '$.status', 'only local-fixture status is supported');
  }
  if (record.hold !== true) {
    addError('hold_required', '$.hold', 'reproducible-build fixtures must remain under HOLD');
  }
  if (record.scope !== 'local-reproducibility-only') {
    addError('unsupported_scope', '$.scope', 'scope must remain local-reproducibility-only');
  }
  if (record.externalAudit !== false) {
    addError('audit_claim_prohibited', '$.externalAudit', 'local build evidence is not an external audit');
  }
  if (record.releaseAuthorization !== false) {
    addError(
      'authorization_claim_prohibited',
      '$.releaseAuthorization',
      'local build evidence is not release authorization',
    );
  }
  if (record.targetId !== releaseTarget.targetId) {
    addError('target_mismatch', '$.targetId', 'record does not bind to the validated release target');
  }
  if (!isFixtureReference(record.targetId)) {
    addError('invalid_reference', '$.targetId', 'targetId must be a fixture-only reference');
  }
  if (!Array.isArray(record.runs) || record.runs.length !== 2) {
    addError('incomplete_runs', '$.runs', 'exactly two independent local build runs are required');
  }

  if (Array.isArray(record?.runs)) {
    const runIds = new Set();
    const executionProofReferences = new Set();
    const executionProofHashes = new Set();
    record.runs.forEach((run, index) => {
      const runPath = `$.runs[${index}]`;
      if (!isRecord(run)) {
        addError('invalid_run', runPath, 'build run must be an object');
        return;
      }
      rejectUnknownFields(run, RUN_FIELDS, runPath, addError);
      if (!isFixtureReference(run.runId)) {
        addError('invalid_reference', `${runPath}.runId`, 'runId must be a fixture-only reference');
      }
      if (runIds.has(run.runId)) {
        addError('duplicate_run', `${runPath}.runId`, 'build run IDs must be unique');
      }
      runIds.add(run.runId);
      if (run.environment !== 'local-ephemeral') {
        addError(
          'local_environment_required',
          `${runPath}.environment`,
          'build runs must use a local ephemeral environment',
        );
      }
      if (run?.targetId !== releaseTarget.targetId) {
        addError(
          'target_mismatch',
          `${runPath}.targetId`,
          'build run does not bind to the validated release target',
        );
      }
      if (run?.treeState !== 'clean') {
        addError(
          'dirty_tree',
          `${runPath}.treeState`,
          'every reproducible-build run must come from a clean tree',
        );
      }
      requireHash(run?.cleanTreeProofHash, `${runPath}.cleanTreeProofHash`);
      requireMatch(
        run.cleanTreeProofHash,
        releaseTarget.source.cleanTreeProofHash,
        `${runPath}.cleanTreeProofHash`,
      );
      if (!isFixtureReference(run.cleanTreeProofReference)) {
        addError(
          'invalid_reference',
          `${runPath}.cleanTreeProofReference`,
          'clean-tree proof must be a fixture-only reference',
        );
      }
      requireMatch(
        run.cleanTreeProofReference,
        releaseTarget.source.cleanTreeProofReference,
        `${runPath}.cleanTreeProofReference`,
      );
      if (!isRecord(run.executionProof)) {
        addError(
          'missing_execution_proof',
          `${runPath}.executionProof`,
          'each build run requires independently attributable execution evidence',
        );
      } else {
        const proofPath = `${runPath}.executionProof`;
        rejectUnknownFields(run.executionProof, EXECUTION_PROOF_FIELDS, proofPath, addError);
        if (run.executionProof.targetId !== releaseTarget.targetId) {
          addError(
            'target_mismatch',
            `${proofPath}.targetId`,
            'execution proof does not bind to the validated release target',
          );
        }
        if (run.executionProof.runId !== run.runId) {
          addError(
            'run_mismatch',
            `${proofPath}.runId`,
            'execution proof does not bind to its containing build run',
          );
        }
        if (!isFixtureReference(run.executionProof.reference)) {
          addError(
            'invalid_reference',
            `${proofPath}.reference`,
            'execution proof must use a fixture-only reference',
          );
        } else if (executionProofReferences.has(run.executionProof.reference)) {
          addError(
            'duplicate_execution_proof',
            `${proofPath}.reference`,
            'execution-proof references must be unique across build runs',
          );
        } else {
          executionProofReferences.add(run.executionProof.reference);
        }
        requireHash(run.executionProof.contentHash, `${proofPath}.contentHash`);
        if (isNonzeroHash(run.executionProof.contentHash)) {
          const normalizedProofHash = run.executionProof.contentHash.toLowerCase();
          if (executionProofHashes.has(normalizedProofHash)) {
            addError(
              'duplicate_execution_proof',
              `${proofPath}.contentHash`,
              'execution-proof content hashes must be unique across build runs',
            );
          } else {
            executionProofHashes.add(normalizedProofHash);
          }
        }
      }
      requireMatch(
        run?.sourceCommitReference,
        releaseTarget.source.commitReference,
        `${runPath}.sourceCommitReference`,
      );

      const lockfileKinds = Array.isArray(run?.lockfiles)
        ? run.lockfiles.map((lockfile) => lockfile?.kind)
        : [];
      for (const kind of ['root-npm', 'contracts-npm']) {
        if (lockfileKinds.filter((value) => value === kind).length !== 1) {
          errors.push({
            code: 'incomplete_lockfiles',
            path: `${runPath}.lockfiles`,
            message: `exactly one ${kind} lockfile reference is required`,
          });
        }
      }
      if (Array.isArray(run?.lockfiles)) {
        run.lockfiles.forEach((lockfile, lockfileIndex) => {
          const path = `${runPath}.lockfiles[${lockfileIndex}]`;
          if (!isRecord(lockfile)) {
            addError('invalid_lockfile', path, 'lockfile reference must be an object');
            return;
          }
          rejectUnknownFields(lockfile, LOCKFILE_FIELDS, path, addError);
          if (!['root-npm', 'contracts-npm'].includes(lockfile.kind)) {
            addError('unsupported_lockfile', `${path}.kind`, 'lockfile kind is not supported');
          }
          if (!isFixtureReference(lockfile.pathReference)) {
            addError('invalid_reference', `${path}.pathReference`, 'lockfile path must be fixture-only');
          }
          requireHash(lockfile?.contentHash, `${path}.contentHash`);
          const targetLockfile = releaseTarget.dependencies.lockfiles.find(
            ({ kind }) => kind === lockfile?.kind,
          );
          if (targetLockfile) {
            requireMatch(lockfile.pathReference, targetLockfile.pathReference, `${path}.pathReference`);
            requireMatch(lockfile.contentHash, targetLockfile.contentHash, `${path}.contentHash`);
          }
        });
      }

      if (isRecord(run.toolchain)) {
        rejectUnknownFields(run.toolchain, TOOLCHAIN_FIELDS, `${runPath}.toolchain`, addError);
      }
      for (const field of [
        'nodeVersionReference',
        'npmVersionReference',
        'hardhatVersionReference',
      ]) {
        if (!run?.toolchain?.[field]) {
          errors.push({
            code: 'missing_toolchain_reference',
            path: `${runPath}.toolchain.${field}`,
            message: `${field} is required`,
          });
        } else if (!isFixtureReference(run.toolchain[field])) {
          addError(
            'invalid_reference',
            `${runPath}.toolchain.${field}`,
            `${field} must be a fixture-only reference`,
          );
        }
      }
      if (!run?.toolchain?.compiler) {
        errors.push({
          code: 'missing_compiler',
          path: `${runPath}.toolchain.compiler`,
          message: 'compiler name, version, and settings references are required',
        });
      } else {
        rejectUnknownFields(
          run.toolchain.compiler,
          COMPILER_FIELDS,
          `${runPath}.toolchain.compiler`,
          addError,
        );
        if (!isFixtureReference(run.toolchain.compiler.versionReference)) {
          addError(
            'invalid_reference',
            `${runPath}.toolchain.compiler.versionReference`,
            'compiler version must be a fixture-only reference',
          );
        }
        for (const field of [
          'nodeVersionReference',
          'npmVersionReference',
          'hardhatVersionReference',
        ]) {
          requireMatch(
            run.toolchain[field],
            releaseTarget.toolchain[field],
            `${runPath}.toolchain.${field}`,
          );
        }
        requireMatch(
          run.toolchain.compiler.name,
          releaseTarget.toolchain.compiler.name,
          `${runPath}.toolchain.compiler.name`,
        );
        requireMatch(
          run.toolchain.compiler.versionReference,
          releaseTarget.toolchain.compiler.versionReference,
          `${runPath}.toolchain.compiler.versionReference`,
        );
        requireHash(
          run.toolchain.compiler.settingsHash,
          `${runPath}.toolchain.compiler.settingsHash`,
        );
        requireMatch(
          run.toolchain.compiler.settingsHash,
          releaseTarget.toolchain.compiler.settingsHash,
          `${runPath}.toolchain.compiler.settingsHash`,
        );
      }
      for (const [field, expected] of [
        ['configHash', releaseTarget.config.payloadHash],
        ['creationBundleHash', releaseTarget.bytecode.creationBundleHash],
        ['deployedBundleHash', releaseTarget.bytecode.deployedBundleHash],
      ]) {
        requireHash(run?.[field], `${runPath}.${field}`);
        requireMatch(run?.[field], expected, `${runPath}.${field}`);
      }

      const runbookKinds = Array.isArray(run.runbooks)
        ? run.runbooks.map((runbook) => runbook?.kind)
        : [];
      for (const kind of REQUIRED_RUNBOOKS) {
        if (runbookKinds.filter((value) => value === kind).length !== 1) {
          addError(
            'incomplete_runbooks',
            `${runPath}.runbooks`,
            `exactly one ${kind} runbook is required`,
          );
        }
      }
      if (Array.isArray(run.runbooks)) {
        const runbookReferences = new Set();
        const runbookHashes = new Set();
        run.runbooks.forEach((runbook, runbookIndex) => {
          const path = `${runPath}.runbooks[${runbookIndex}]`;
          if (!isRecord(runbook)) {
            addError('invalid_runbook', path, 'runbook evidence must be an object');
            return;
          }
          rejectUnknownFields(runbook, RUNBOOK_FIELDS, path, addError);
          if (!REQUIRED_RUNBOOKS.includes(runbook.kind)) {
            addError('unsupported_runbook', `${path}.kind`, 'runbook kind is not supported');
          }
          if (runbook.targetId !== releaseTarget.targetId) {
            addError(
              'target_mismatch',
              `${path}.targetId`,
              'runbook evidence does not bind to the validated release target',
            );
          }
          if (runbook.runId !== run.runId) {
            addError(
              'run_mismatch',
              `${path}.runId`,
              'runbook evidence does not bind to its containing build run',
            );
          }
          if (!isFixtureReference(runbook.pathReference)) {
            addError(
              'invalid_reference',
              `${path}.pathReference`,
              'runbook path must be a fixture-only reference',
            );
          } else if (runbookReferences.has(runbook.pathReference)) {
            addError(
              'duplicate_runbook_evidence',
              `${path}.pathReference`,
              'runbook path references must be unique within each build run',
            );
          } else {
            runbookReferences.add(runbook.pathReference);
          }
          requireHash(runbook.contentHash, `${path}.contentHash`);
          if (isNonzeroHash(runbook.contentHash)) {
            const normalizedRunbookHash = runbook.contentHash.toLowerCase();
            if (runbookHashes.has(normalizedRunbookHash)) {
              addError(
                'duplicate_runbook_evidence',
                `${path}.contentHash`,
                'runbook content hashes must be unique within each build run',
              );
            } else {
              runbookHashes.add(normalizedRunbookHash);
            }
          }
          const targetRunbook = releaseTarget.runbooks.find(
            ({ kind }) => kind === runbook.kind,
          );
          if (targetRunbook) {
            requireMatch(runbook.pathReference, targetRunbook.pathReference, `${path}.pathReference`);
            requireMatch(runbook.contentHash, targetRunbook.contentHash, `${path}.contentHash`);
          }
        });
      }
    });
  }

  scanProhibitedMaterial(record, '$', '', addError);

  return { valid: errors.length === 0, errors };
}
