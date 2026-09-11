// Owner-private guidance only. Execution still uses its authoritative gates.
export const OWNER_ACTION_WORKBENCH_VERSION = 2;
export const OWNER_ACTION_RECOVERY_PROBATION_MS = 30 * 60_000;
const list = (v) => Array.isArray(v) ? v : [];
const alive = (entry, now) => [entry.expiresAt, entry.completion?.deadlineTs]
  .filter((v) => v != null).every((v) => Number.isFinite(Number(v)) && Number(v) > now);
const healthy = (r) => r?.ready === true && r.supervisor?.managed === true
  && r.supervisor?.healthy === true && !!r.checkpoint;

export function buildOwnerActionWorkbench({ incidents = {}, runtime = {}, safetySlo = {}, guardian = {},
  dataTrust = {}, reconciliation = {}, authorization = false, wallets = [], pacts = [], missions = [],
  decisionTrace = {}, frozen = false, now = Date.now() } = {}) {
  const checklist = [];
  const add = (code, title, detail, pass, actor, anchor, completionEvidence, options = {}) => {
    const entry = { code, title, detail, actor, completionEvidence,
      state: pass ? 'complete' : actor === 'owner' ? 'owner-action' : actor === 'supervisor' ? 'waiting' : 'system-action',
      target: { view: options.view || 'control', anchor }, action: null, ...options };
    checklist.push(entry);
  };
  const incidentList = list(incidents.incidents);
  const open = incidentList.filter((i) => i.status !== 'resolved')
    .sort((a, b) => String(a.incidentRef).localeCompare(String(b.incidentRef)));
  const runtimes = list(runtime.runtimes);
  const readyRuntimes = runtimes.filter((r) => healthy(r) && r.quarantine?.active !== true
    && r.execution?.newMissionExposureAllowed !== false);
  const lastResolvedAt = incidentList.reduce((latest, i) => i.status === 'resolved'
    && Number.isFinite(i.resolvedAt) ? Math.max(latest, i.resolvedAt) : latest, 0);
  const recoveryAgeMs = lastResolvedAt ? Math.max(0, now - lastResolvedAt) : null;
  const probationRemainingMs = recoveryAgeMs == null ? 0 : Math.max(0, OWNER_ACTION_RECOVERY_PROBATION_MS - recoveryAgeMs);
  const burns = list(safetySlo.burnRates);
  const burnEvidenceComplete = ['fast', 'slow'].every((name) => burns.some((b) => b.name === name && typeof b.firing === 'boolean'));
  const blockingBurns = burns.filter((b) => ['fast', 'slow'].includes(b.name) && b.firing === true);
  const coverage = guardian.coverage || {};
  const protectionKnown = ['degraded', 'unprotected'].every((key) => Number.isFinite(coverage[key]) && coverage[key] >= 0);
  const activeWallets = list(wallets).filter((w) => w.status === 'active' && w.capabilities?.includes('trade.paper'));
  const pairs = authorization === true ? list(pacts).filter((p) => p.status === 'active' && alive(p, now))
    .flatMap((pact) => activeWallets.filter((w) => w.walletId === pact.agentWalletId).map((wallet) => ({ wallet, pact }))) : [];
  // Match across valid pairs, not the first wallet/runtime returned by a store.
  const candidates = list(missions).filter((m) => m.status === 'running' && alive(m, now)
    && pairs.some((p) => p.wallet.walletId === m.walletId && p.pact.pactId === m.pactId));
  const boundMission = candidates.find((m) => readyRuntimes.some((r) => r.checkpoint.missionId === m.missionId));
  const runningMission = boundMission || candidates[0];
  const missionBound = !!boundMission;
  add('emergency-freeze', 'Review the emergency freeze', frozen ? 'The owner paused exposure. Review the cause before changing the freeze.' :
    'Emergency freeze is inactive.', !frozen, 'owner', 'executionReadinessTitle', 'The server reports emergency freeze inactive.');
  add('position-protection', 'Confirm existing positions are protected', !protectionKnown ? 'Position protection evidence is unavailable. Refresh before proceeding.' :
    'Position Guardian must report no degraded or unprotected positions.', protectionKnown && coverage.degraded === 0 && coverage.unprotected === 0,
    'operator', 'executionReadinessTitle', 'Fresh Guardian evidence reports zero degraded and zero unprotected positions.');
  for (const incident of open) {
    const recovered = incident.recoveryReady === true && typeof incident.runtimeRef === 'string'
      && healthy(runtimes.find((r) => r.runtimeRef === incident.runtimeRef));
    const operation = incident.acknowledgedAt ? 'resolve' : 'acknowledge';
    add(recovered ? `incident-${operation}` : 'incident-recovery', recovered ? operation === 'resolve' ? 'Release the recovered incident' :
      'Review the recovered incident' : 'Recover the affected runtime', recovered ?
      'The affected supervisor is healthy and has a checkpoint. Review this incident before confirming the owner action.' :
      'Wait for this incident’s supervisor and checkpoint to recover. A different healthy agent does not clear this incident.', false,
      recovered ? 'owner' : 'supervisor', 'incidentRecoveryTitle', 'This incident is resolved after owner review; other safety gates are checked again.',
      { action: recovered ? { kind: 'incident', operation, incidentRef: incident.incidentRef, requiresConfirmation: true } : null });
  }
  const incidentClear = Array.isArray(incidents.incidents) && !open.length
    && !['open', 'critical', 'quarantined'].some((key) => Number(incidents.counts?.[key] || 0) > 0);
  add('incidents-clear', 'Confirm incident release', incidentClear ? 'No open incident or incident quarantine remains.' :
    'Review unresolved incidents. Missing or inconsistent evidence cannot prove release.', incidentClear,
    'operator', 'incidentRecoveryTitle', 'Fresh incident evidence reports no open, critical or quarantined incidents.');
  add('runtime-ready', 'Restore the supervised runtime', readyRuntimes.length ? 'A healthy supervised runtime has a durable checkpoint.' :
    'The operator must recover the supervisor from its exact checkpoint. Do not send a competing agent heartbeat.', readyRuntimes.length > 0,
    'operator', 'runtimeReliabilityTitle', 'The runtime is ready, supervised, healthy, checkpointed and not quarantined.');
  add('recovery-probation', 'Complete recovery probation', probationRemainingMs ?
    `Keep supervision healthy. At this check, at least ${Math.ceil(probationRemainingMs / 60_000)} minute(s) remain; this is not a guaranteed execution time.` :
    'The observed recovery probation is clear.', probationRemainingMs === 0, 'supervisor', 'safetySloTitle',
    'A fresh server check confirms the 30-minute probation has cleared.', { remainingMs: probationRemainingMs });
  add('safety-burn', 'Wait for operational safety evidence', !burnEvidenceComplete ? 'Fast and slow safety-window evidence is incomplete.' :
    blockingBurns.length ? 'Recent failures remain in the fast or slow safety window. Keep healthy supervision running; do not reset evidence.' :
    'Fast and slow safety windows are clear.', burnEvidenceComplete && !blockingBurns.length, 'supervisor', 'safetySloTitle',
    'Both fast and slow windows are present and report that they are not firing.');
  add('data-trust', 'Refresh trusted market evidence', 'Fresh structured market data must pass the Data Trust Firewall.',
    dataTrust.decision === 'allow' || (dataTrust.decision == null && dataTrust.status === 'healthy'), 'agent', 'dataTrustTitle',
    'Fresh evidence passes data trust; each preflight still checks quote freshness and quorum.');
  add('reconciliation', 'Verify the execution ledger', 'Resolve ledger contradictions before requesting new exposure.',
    reconciliation.decision === 'allow', 'operator', 'executionReconciliationTitle', 'The server reports execution state reconciled.');
  add('paper-wallet', 'Select an active paper wallet', 'Use bounded simulation funds with paper-trading capability.',
    activeWallets.length > 0, 'owner', 'launchpadSetupTitle', 'An active paper wallet is present.', { view: 'launchpad' });
  add('paper-pact', 'Approve a wallet-bound paper Pact', 'Review or replace an expired Pact and bind it to the intended paper wallet.',
    pairs.length > 0, 'owner', 'launchpadPactTitle', 'An unexpired active Pact matches an active paper wallet and authorization is present.', { view: 'launchpad' });
  add('paper-mission', 'Start a supervised paper mission', 'Review a narrow mission bound to the active wallet and Pact.',
    !!runningMission, 'owner', 'missionControlTitle', 'A running, unexpired mission matches the wallet and Pact.');
  add('mission-binding', 'Bind the mission to its supervised checkpoint',
    'The operator updates the supervisor context and verifies its checkpoint matches the mission. If context loads only at startup, restart only that supervisor; do not restart Hermes or send a direct heartbeat.',
    missionBound, 'operator', 'runtimeReliabilityTitle', 'A healthy runtime checkpoint contains the exact running mission binding.');
  const actions = checklist.filter((e) => e.state !== 'complete');
  const completed = checklist.length - actions.length;
  const next = actions[0] || { code: 'ready', title: 'Ready for a fresh paper preflight',
    detail: 'Recovery checks are complete. A fresh preflight and required owner order approval still apply.',
    state: 'complete', actor: 'agent', target: { view: 'control', anchor: 'executionReadinessTitle' }, action: null };
  const advisories = [];
  if (safetySlo.errorBudget?.exhausted || burns.some((b) => b.name === 'ticket' && b.firing)) advisories.push({
    code: 'historical-safety-budget', actor: 'owner', detail: 'Cumulative budget and ticket burn remain visible as history. They do not by themselves block recovery; fast and slow windows above still apply.',
  });
  if (list(decisionTrace.traces)[0]?.reasonCode === 'preflight-evidence-changed') advisories.push({
    code: 'preflight-evidence-changed', actor: 'agent', detail: 'The last retained request used evidence that changed. After current blockers clear, obtain fresh analysis and preflight evidence. Never replay an expired approval or submit a trade from this checklist.',
  });
  return { ok: true, mode: 'paper-only', version: OWNER_ACTION_WORKBENCH_VERSION, checkedAt: Math.trunc(now),
    status: actions.length ? 'action-required' : 'ready', nextAction: next, actions: actions.length ? actions : [next], checklist, advisories,
    progress: { completed, total: checklist.length, percent: Math.round(completed / checklist.length * 100), basis: 'current-snapshot' },
    counts: { ownerAction: actions.filter((e) => e.state === 'owner-action').length,
      systemAction: actions.filter((e) => e.state === 'system-action').length, waiting: actions.filter((e) => e.state === 'waiting').length },
    evidence: { openIncidents: open.length, supervisedRuntimeReady: readyRuntimes.length > 0,
      recoveryProbationRemainingMs: probationRemainingMs, walletPactAuthorized: pairs.length > 0, missionBound },
    guarantees: { readOnlyPlan: true, deterministic: true, ownerApprovalPreserved: true, ownerIsolated: true,
      noAutomaticOwnerActions: true, authorityExpanded: false, executionPermissionsChanged: false },
    execution: { attempted: false, reservationCreated: false, receiptCreated: false, tradeCreated: false },
    liveScopeUsed: false, publicChainUsed: false };
}
