import crypto from 'node:crypto';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function buildAgentReleaseTrust({ revision, packageLock, dockerfile, workflow, deployScript, expected = {} }) {
  const lock = JSON.parse(packageLock);
  const files = {
    packageLockSha256: sha256(packageLock),
    dockerfileSha256: sha256(dockerfile),
    workflowSha256: sha256(workflow),
    deployScriptSha256: sha256(deployScript),
  };
  const packages = Object.entries(lock.packages || {}).filter(([name]) => name);
  const integrityPackages = packages.filter(([, item]) => item?.link || typeof item?.integrity === 'string');
  const base = dockerfile.match(/^FROM\s+([^\s@]+)@sha256:([a-f0-9]{64})$/m);
  const actions = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((match) => match[1]);
  const actionsPinned = actions.length > 0 && actions.every((action) => /@[a-f0-9]{40}$/.test(action));
  const expectedPresent = Boolean(expected.packageLockSha256 && expected.dockerfileSha256);
  const runtimeMatches = expectedPresent
    && expected.packageLockSha256 === files.packageLockSha256
    && expected.dockerfileSha256 === files.dockerfileSha256;
  const checks = {
    immutableRevision: /^[a-f0-9]{40}$/.test(String(revision || '')),
    lockfileV3: Number(lock.lockfileVersion) >= 3,
    dependencyIntegrityComplete: packages.length > 0 && integrityPackages.length === packages.length,
    baseImageDigestPinned: Boolean(base),
    ciActionsPinned: actionsPinned,
    ciLeastPrivilege: /permissions:\s*\n\s+contents:\s*read/.test(workflow)
      && !/(?:contents|packages|actions|id-token):\s*write/.test(workflow),
    ciSafetySuite: /run:\s*npm test/.test(workflow) && /npm audit --omit=dev --audit-level=high/.test(workflow),
    cyclonedxSbom: /npm sbom --sbom-format=cyclonedx --omit=dev/.test(workflow)
      && /actions\/upload-artifact@[a-f0-9]{40}/.test(workflow),
    cleanTreeRequired: /refusing to deploy a dirty or untracked working tree/.test(deployScript),
    isolatedCandidate: /live credentials disabled/.test(deployScript) && /--tmpfs ["']?\/app\/data:/.test(deployScript),
    exactRevisionHealth: /b\.revision!==expected/.test(deployScript),
    automaticRollback: /rollback_production/.test(deployScript),
    runtimeProvenanceMatches: runtimeMatches,
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return {
    ok: true, mode: 'paper-only', version: 1,
    status: failed.length ? 'blocked' : 'verified',
    decision: failed.length ? 'deny' : 'allow',
    reasonCode: failed.length ? 'release-evidence-incomplete' : 'release-trust-passed',
    revision: { present: checks.immutableRevision, value: checks.immutableRevision ? revision : null },
    sbom: { format: 'CycloneDX', generatedAndRetainedInCi: checks.cyclonedxSbom, packageCount: packages.length,
      integrityCoveragePercent: packages.length ? Number((integrityPackages.length / packages.length * 100).toFixed(2)) : 0 },
    container: { baseImage: base?.[1] || null, baseDigestPinned: checks.baseImageDigestPinned,
      baseDigest: base ? `sha256:${base[2]}` : null, runtimeProvenanceExpected: expectedPresent },
    pipeline: { actionCount: actions.length, actionsPinned, leastPrivilege: checks.ciLeastPrivilege,
      safetySuite: checks.ciSafetySuite, immutableSbomArtifact: checks.cyclonedxSbom },
    deployment: { cleanTreeRequired: checks.cleanTreeRequired, isolatedCandidate: checks.isolatedCandidate,
      exactRevisionHealth: checks.exactRevisionHealth, automaticRollback: checks.automaticRollback },
    evidence: files,
    checks,
    failedChecks: failed,
    guarantees: { deterministic: true, failClosed: true, authorityExpanded: false, executionPermissionsChanged: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}
