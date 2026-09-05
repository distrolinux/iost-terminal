// Deterministic, read-only readiness policy for new agent paper exposure.
// The gate composes already-observed evidence and has no authority to mutate
// runtime, incident, wallet, Pact, mission, position, or execution state.

export const AGENT_EXECUTION_READINESS_VERSION = 1;
export const AGENT_EXECUTION_RECOVERY_PROBATION_MS = 30 * 60_000;

const BLOCKING_BURN_RATES = new Set(['fast', 'slow']);

export function buildAgentExecutionReadiness({
  agentRequired = true,
  runtime = null,
  incidents = null,
  safetySlo = null,
  guardian = null,
  dataTrust = null,
  authorization = null,
  emergencyFreeze = null,
  now = Date.now(),
} = {}) {
  const incidentCounts = incidents?.counts || {};
  const incidentList = Array.isArray(incidents?.incidents) ? incidents.incidents : [];
  const lastResolvedAt = incidentList.reduce((latest, incident) => (
    incident?.status === 'resolved' && Number.isFinite(incident.resolvedAt)
      ? Math.max(latest || 0, incident.resolvedAt) : latest
  ), null);
  const recoveryAgeMs = lastResolvedAt == null ? null : Math.max(0, Math.trunc(now) - lastResolvedAt);
  const recoveryProbationClear = recoveryAgeMs == null || recoveryAgeMs >= AGENT_EXECUTION_RECOVERY_PROBATION_MS;
  const burnRates = Array.isArray(safetySlo?.burnRates) ? safetySlo.burnRates : [];
  const operationalBurns = burnRates.filter((burn) => BLOCKING_BURN_RATES.has(burn?.name));
  const operationalBurnEvidenceComplete = [...BLOCKING_BURN_RATES].every((name) => (
    operationalBurns.some((burn) => burn?.name === name && typeof burn?.firing === 'boolean')
  ));
  const operationalBurnFiring = operationalBurns.some((burn) => burn?.firing === true);
  const safetyEvidenceAvailable = safetySlo?.ok === true && safetySlo?.status !== 'not-enrolled';
  const coverage = guardian?.coverage || guardian || {};
  const authorized = authorization?.ok === true || authorization?.canOpenPaperTrade === true;
  const checks = agentRequired ? [
    { code: 'runtime-enrolled', pass: runtime?.enrolled === true },
    { code: 'runtime-ready', pass: runtime?.ready === true && runtime?.status === 'ready' },
    { code: 'runtime-supervised', pass: runtime?.supervisor?.managed === true && runtime?.supervisor?.healthy === true },
    { code: 'runtime-checkpoint-present', pass: !!runtime?.checkpoint },
    { code: 'runtime-not-quarantined', pass: runtime?.quarantine?.active !== true },
    { code: 'runtime-new-exposure-allowed', pass: runtime?.execution?.newMissionExposureAllowed === true },
    { code: 'incidents-clear', pass: Number(incidentCounts.open || 0) === 0 },
    { code: 'critical-incidents-clear', pass: Number(incidentCounts.critical || 0) === 0 },
    { code: 'incident-quarantine-clear', pass: Number(incidentCounts.quarantined || 0) === 0 },
    { code: 'recovery-probation-clear', pass: recoveryProbationClear },
    { code: 'safety-evidence-available', pass: safetyEvidenceAvailable },
    { code: 'safety-burn-rate-clear', pass: operationalBurnEvidenceComplete && !operationalBurnFiring },
    { code: 'position-guardian-healthy', pass: Number(coverage.degraded || 0) === 0 && Number(coverage.unprotected || 0) === 0 },
    { code: 'data-trust-authorized', pass: dataTrust?.decision === 'allow' },
    { code: 'emergency-freeze-clear', pass: emergencyFreeze?.frozen !== true },
    { code: 'wallet-pact-authorized', pass: authorized },
  ] : [
    { code: 'owner-manual-exempt', pass: true },
  ];
  const failure = checks.find((check) => !check.pass) || null;
  const decision = failure ? 'deny' : 'allow';
  return {
    ok: true,
    mode: 'paper-only',
    version: AGENT_EXECUTION_READINESS_VERSION,
    readOnly: true,
    decision,
    reasonCode: failure?.code || (agentRequired ? 'agent-execution-ready' : 'owner-manual-exempt'),
    checkedAt: Math.trunc(now),
    policy: {
      appliesTo: 'new-agent-paper-exposure',
      runtimeRequired: agentRequired,
      supervisedRuntimeRequired: agentRequired,
      checkpointRequired: agentRequired,
      incidentFreeRequired: agentRequired,
      recoveryProbationMs: AGENT_EXECUTION_RECOVERY_PROBATION_MS,
      blockingBurnRates: [...BLOCKING_BURN_RATES],
      cumulativeErrorBudgetAdvisoryOnly: true,
      ticketBurnAdvisoryOnly: true,
      positionGuardianRequiredForExistingPositions: true,
      structuredDataTrustRequired: agentRequired,
      walletPactRequired: agentRequired,
      failClosed: true,
      existingPositionProtection: 'position-guardian',
    },
    evidence: {
      runtime: {
        enrolled: runtime?.enrolled === true,
        status: runtime?.status || 'not-enrolled',
        ready: runtime?.ready === true,
        supervised: runtime?.supervisor?.managed === true,
        supervisorHealthy: runtime?.supervisor?.healthy === true,
        checkpointPresent: !!runtime?.checkpoint,
        quarantineActive: runtime?.quarantine?.active === true,
        newExposureAllowed: runtime?.execution?.newMissionExposureAllowed === true,
      },
      incidents: {
        open: Number(incidentCounts.open || 0),
        critical: Number(incidentCounts.critical || 0),
        quarantined: Number(incidentCounts.quarantined || 0),
        recoveryReady: Number(incidentCounts.recoveryReady || 0),
        lastResolvedAt,
        recoveryAgeMs,
        probationClear: recoveryProbationClear,
      },
      safetySlo: {
        status: safetySlo?.status || 'not-enrolled',
        reasonCode: safetySlo?.reasonCode || 'no-slo-evidence',
        evidenceSufficient: safetySlo?.evidence?.sufficient === true,
        errorBudgetExhausted: safetySlo?.errorBudget?.exhausted === true,
        burnRates: burnRates.map((burn) => ({ name: burn?.name || 'unknown', firing: burn?.firing === true })),
        operationalBurnEvidenceComplete,
        operationalBurnFiring,
        ownerActionRequired: safetySlo?.decision?.ownerActionRequired === true,
      },
      guardian: {
        total: Number(coverage.total || 0),
        protected: Number(coverage.protected || 0),
        armed: Number(coverage.armed || 0),
        degraded: Number(coverage.degraded || 0),
        unprotected: Number(coverage.unprotected || 0),
      },
      dataTrust: {
        decision: dataTrust?.decision || 'not-evaluated',
        reasonCode: dataTrust?.reasonCode || 'data-trust-unavailable',
        trustedEvidenceCount: Number(dataTrust?.evidence?.trustedCount || 0),
      },
      emergencyFreeze: { active: emergencyFreeze?.frozen === true },
      authorization: { walletPactAuthorized: authorized },
    },
    checks,
    decisionEffects: {
      newExposureAllowed: decision === 'allow',
      existingPositionsRemainProtected: true,
      executionPermissionsChanged: false,
      authorityExpanded: false,
    },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false,
    publicChainUsed: false,
  };
}
